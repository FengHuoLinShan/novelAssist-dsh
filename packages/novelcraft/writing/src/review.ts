// R3 · 语义审查(PLAN.md 步骤 2): 读章节正文 → llm_step(semantic_review)
// → findings 落 .assistant/reviews/(N4 落点)。失败不写文件。
// M7 N27: targeted_revision temp 0.4 / timeout 1800s 与 catalog §3.4 一致; catalog 无 max_tokens 行 → budgetTokens 0 保持, 无改动。
// N30: 回执 finding 必填 finding_id=finding_<sha256前20>(chapter_index+稳定内容字段派生, 确定性, 禁随机/时间源);
//      severity 存储词表 blocker/major/minor(writing.md:284), 摄入归一化 high/medium/low→blocker/major/minor,
//      未知值 fail-closed 丢弃该 finding(不落盘); 打回按 finding_id(rejectFindingById), 旧 rejectFinding 保留兼容。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import {
  assertNoInternalSymlink,
  contentHash,
  executeCanonicalWrite,
  gitAdd,
  gitCommit,
  gitHead,
  parseFrontmatter,
  readCurrentChapter,
  relOf,
  resolveAsset,
  StoreError,
} from "@novelcraft/store";
import { runStep, registerSpec } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import type { StepResult } from "@novelcraft/llm-step";

/** N30 · writing.md:284: 回执层 severity 存储词表(LLM 输出 high/medium/low 摄入时归一化)。 */
export type ReviewSeverity = "blocker" | "major" | "minor";

export interface ReviewFinding {
  /** N30 · writing.md:283: 必填, 由内容稳定 hash 派生(finding_<hash20>), 同输入恒同 id。 */
  finding_id: string;
  category: string;
  severity: ReviewSeverity;
  quote: string;
  suggestion: string;
}

export interface ReviewRecord {
  chapter_index: number;
  chapter_file: string;
  content_hash: string;
  reviewed_at: string;
  review_id: string;
  findings: ReviewFinding[];
  verdict?: string;
  target_kind?: "current" | "candidate";
  target_ref?: string;
  target_content_hash?: string;
  target_file_hash?: string;
  raw_verdict?: string;
  discarded_finding_count?: number;
  unlocated_finding_ids?: string[];
  rejected_findings?: Record<string, { at: string; reason?: string }>;
}

export interface CandidateReviewRecord extends ReviewRecord {
  target_kind: "candidate";
  target_ref: string;
  target_content_hash: string;
  target_file_hash: string;
  verdict: "pass" | "blocked";
  raw_verdict?: string;
  discarded_finding_count: number;
  unlocated_finding_ids: string[];
}

export interface ReviewResult {
  ok: boolean;
  review?: ReviewRecord;
  error?: StepResult["error"];
}

/** 从章节文件取正文(去掉 frontmatter)。 */
export function chapterBody(root: string, chapterIndex: number): { body: string; contentHash: string } {
  const file = paths(root).chapters.chapterFile(chapterIndex);
  if (!existsSync(file)) throw new Error(`章节不存在: ${chapterIndex}`);
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^content_hash:\s*([0-9a-f]{64})/m);
  if (!m) throw new Error(`章节缺少 content_hash: ${chapterIndex}`);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  return { body, contentHash: m[1] };
}

function registerWritingSpecsOnce(): void {
  try {
    registerSpec({
      specRef: "targeted_revision",
      description: "finding-bound 定向返修(catalog §3.4)",
      inputNotes: "冻结正文 + 选定 findings",
      outputSchema: { type: "object" },
      outputFormat: "text",
      budgetTokens: 0,
      temperature: 0.4,
      timeoutMs: 1_800_000,
      degradationNote: "修订只进待审阅候选; 失败不改写正文。",
      contractVersion: "v1",
    });
  } catch {
    // 已注册则忽略(幂等)
  }
}

/** N30: LLM 词表 high/medium/low → 存储词表 blocker/major/minor; 已是规范值原样通过。 */
const SEVERITY_ALIASES: Record<string, ReviewSeverity> = {
  high: "blocker",
  medium: "major",
  low: "minor",
  blocker: "blocker",
  major: "major",
  minor: "minor",
};

/**
 * N30 · writing.md:283: finding_id = `finding_<sha256前20 hex>`, 输入 = chapter_index
 * + 稳定内容字段(category/quote/suggestion)。确定性: 同输入恒同 id, 禁 Math.random/Date.now。
 */
export function findingIdOf(
  chapterIndex: number,
  f: { category: string; quote: string; suggestion: string },
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([chapterIndex, f.category, f.quote, f.suggestion]), "utf8")
    .digest("hex");
  return `finding_${digest.slice(0, 20)}`;
}

/**
 * N30: 摄入归一化(LLM 输出 → 回执存储)。severity 未知值 fail-closed:
 * 丢弃该 finding(返回 null, 不落盘)。
 */
export function normalizeFinding(chapterIndex: number, raw: Record<string, unknown>): ReviewFinding | null {
  const severity = SEVERITY_ALIASES[String(raw.severity ?? "")];
  if (!severity) return null;
  const category = typeof raw.category === "string" ? raw.category : "";
  const quote = typeof raw.quote === "string" ? raw.quote : "";
  const suggestion = typeof raw.suggestion === "string" ? raw.suggestion : "";
  return {
    finding_id: findingIdOf(chapterIndex, { category, quote, suggestion }),
    category,
    severity,
    quote,
    suggestion,
  };
}

export async function reviewChapter(
  provider: Provider,
  root: string,
  chapterIndex: number,
  now: Date = new Date(),
): Promise<ReviewResult> {
  const chapterFile = paths(root).chapters.chapterFile(chapterIndex);
  const frozenFileHash = contentHash(readFileSync(chapterFile, "utf8"));
  const { body, contentHash: chapterContentHash } = chapterBody(root, chapterIndex);
  const r = await runStep(provider, { specRef: "semantic_review", input: body });
  if (!r.ok) return { ok: false, error: r.error };

  const parsed = r.result as { findings?: unknown[]; verdict?: string };
  // N30: 落盘前归一化 severity 词表 + 确定性派生 finding_id; 未知 severity fail-closed 丢弃。
  const findings: ReviewFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings
        .map((f) => normalizeFinding(chapterIndex, (f ?? {}) as Record<string, unknown>))
        .filter((f): f is ReviewFinding => f !== null)
    : [];
  const reviewId = `r${now.getTime()}`;
  const record: ReviewRecord = {
    chapter_index: chapterIndex,
    chapter_file: paths(root).chapters.chapterFile(chapterIndex),
    content_hash: chapterContentHash,
    reviewed_at: now.toISOString(),
    review_id: reviewId,
    findings,
    verdict: parsed.verdict,
  };
  const file = paths(root).assistant.reviewFile(`semantic-review-${String(chapterIndex).padStart(3, "0")}-${reviewId}`);
  assertNoInternalSymlink(root, file); // R9: 回执落盘路径写前逐段 symlink 复检。
  await executeCanonicalWrite(root, [{
    path: relOf(root, file),
    current: null,
    output: JSON.stringify(record, null, 2) + "\n",
  }], {
    purpose: `review chapter ${chapterIndex}: ${reviewId}`,
    validate: () => {
      if (contentHash(readFileSync(chapterFile, "utf8")) !== frozenFileHash) {
        throw new StoreError("CONFLICT", `第 ${chapterIndex} 章在审查期间发生变化, 审查结果未落盘`);
      }
    },
  });
  return { ok: true, review: record };
}

/** Public current review freezes a strict, clean chapter and rejects late results after drift. */
export async function reviewCurrentChapter(
  provider: Provider,
  root: string,
  chapterIndex: number,
  now: Date = new Date(),
): Promise<ReviewResult> {
  const frozen = readCurrentChapter(root, chapterIndex);
  const result = await runStep(provider, { specRef: "semantic_review", input: frozen.body });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = result.result as { findings?: unknown[]; verdict?: string };
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = rawFindings
    .map((finding) => normalizeFinding(chapterIndex, (finding ?? {}) as Record<string, unknown>))
    .filter((finding): finding is ReviewFinding => finding !== null);
  const unlocated = findings
    .filter((finding) => finding.quote.trim() === "" || !frozen.body.includes(finding.quote))
    .map((finding) => finding.finding_id);
  const discarded = rawFindings.length - findings.length;
  const reviewId = `r${now.getTime()}`;
  const record: ReviewRecord = {
    chapter_index: chapterIndex,
    chapter_file: frozen.file,
    content_hash: frozen.contentHash,
    reviewed_at: now.toISOString(),
    review_id: reviewId,
    findings,
    target_kind: "current",
    target_ref: String(chapterIndex).padStart(3, "0"),
    target_content_hash: frozen.contentHash,
    target_file_hash: contentHash(readFileSync(paths(root).chapters.chapterFile(chapterIndex), "utf8")),
    verdict: discarded === 0 && unlocated.length === 0 && !findings.some((f) => f.severity !== "minor")
      ? "pass"
      : "blocked",
    ...(typeof parsed.verdict === "string" ? { raw_verdict: parsed.verdict } : {}),
    discarded_finding_count: discarded,
    unlocated_finding_ids: unlocated,
  };
  const file = paths(root).assistant.reviewFile(`semantic-review-${String(chapterIndex).padStart(3, "0")}-${reviewId}`);
  assertNoInternalSymlink(root, file); // R9: 回执落盘路径写前逐段 symlink 复检。
  await executeCanonicalWrite(root, [{
    path: relOf(root, file),
    current: null,
    output: JSON.stringify(record, null, 2) + "\n",
  }], {
    purpose: `review chapter ${chapterIndex}: ${reviewId}`,
    validate: () => {
      const latest = readCurrentChapter(root, chapterIndex);
      if (latest.contentHash !== frozen.contentHash) {
        throw new StoreError("CONFLICT", `第 ${chapterIndex} 章在审查期间发生变化, 审查结果未落盘`);
      }
    },
  });
  return { ok: true, review: record };
}

export interface ChapterCandidateSnapshot {
  ref: string;
  file: string;
  body: string;
  contentHash: string;
  fileHash: string;
  source: string;
  baseContentHash?: string;
}

export function readChapterCandidate(root: string, chapterIndex: number, ref: string): ChapterCandidateSnapshot {
  const asset = resolveAsset(root, "chapter_candidate", ref);
  const raw = readFileSync(asset.abs, "utf8");
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data as Record<string, unknown>;
  if (fm.status !== "candidate" || Number(fm.chapter_index) !== chapterIndex) {
    throw new StoreError("BAD_CANDIDATE", `候选 ${ref} 不是第 ${chapterIndex} 章的 current candidate`);
  }
  const actual = contentHash(parsed.body);
  if (fm.content_hash !== actual) {
    throw new StoreError("BAD_CANDIDATE", `候选 ${ref} content_hash 与实际正文不一致`);
  }
  return {
    ref: asset.slug,
    file: asset.rel,
    body: parsed.body,
    contentHash: actual,
    fileHash: contentHash(raw),
    source: typeof fm.source === "string" ? fm.source : "",
    ...(typeof fm.base_content_hash === "string" ? { baseContentHash: fm.base_content_hash } : {}),
  };
}

/** Independent candidate review: body/hash/file bytes are rechecked after the LLM returns. */
export async function reviewChapterCandidate(
  provider: Provider,
  root: string,
  chapterIndex: number,
  ref: string,
  now: Date = new Date(),
): Promise<ReviewResult> {
  const frozen = readChapterCandidate(root, chapterIndex, ref);
  const result = await runStep(provider, { specRef: "semantic_review", input: frozen.body });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = result.result as { findings?: unknown[]; verdict?: string };
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = rawFindings
    .map((finding) => normalizeFinding(chapterIndex, (finding ?? {}) as Record<string, unknown>))
    .filter((finding): finding is ReviewFinding => finding !== null);
  const unlocated = findings
    .filter((finding) => finding.quote.trim() === "" || !frozen.body.includes(finding.quote))
    .map((finding) => finding.finding_id);
  const discarded = rawFindings.length - findings.length;
  const reviewId = `r${now.getTime()}`;
  const record: CandidateReviewRecord = {
    chapter_index: chapterIndex,
    chapter_file: frozen.file,
    content_hash: frozen.contentHash,
    reviewed_at: now.toISOString(),
    review_id: reviewId,
    findings,
    target_kind: "candidate",
    target_ref: frozen.ref,
    target_content_hash: frozen.contentHash,
    target_file_hash: frozen.fileHash,
    verdict: discarded === 0 && unlocated.length === 0 && !findings.some((f) => f.severity !== "minor")
      ? "pass"
      : "blocked",
    ...(typeof parsed.verdict === "string" ? { raw_verdict: parsed.verdict } : {}),
    discarded_finding_count: discarded,
    unlocated_finding_ids: unlocated,
  };
  const file = paths(root).assistant.reviewFile(
    `candidate-review-${String(chapterIndex).padStart(3, "0")}-${frozen.ref}-${reviewId}`,
  );
  assertNoInternalSymlink(root, file); // R9: 回执落盘路径写前逐段 symlink 复检。
  await executeCanonicalWrite(root, [{
    path: relOf(root, file),
    current: null,
    output: JSON.stringify(record, null, 2) + "\n",
  }], {
    purpose: `review chapter candidate ${chapterIndex}:${frozen.ref}`,
    validate: () => {
      if (readChapterCandidate(root, chapterIndex, ref).fileHash !== frozen.fileHash) {
        throw new StoreError("CONFLICT", `候选 ${ref} 在审查期间发生变化, 审查结果未落盘`);
      }
    },
  });
  return { ok: true, review: record };
}

export function latestCandidateReview(
  root: string,
  chapterIndex: number,
  ref: string,
): CandidateReviewRecord | undefined {
  const asset = resolveAsset(root, "chapter_candidate", ref);
  const dir = paths(root).assistant.reviews;
  if (!existsSync(dir)) return undefined;
  const prefix = `candidate-review-${String(chapterIndex).padStart(3, "0")}-${asset.slug}-`;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return undefined;
  return JSON.parse(readFileSync(`${dir}/${files[files.length - 1]}`, "utf8")) as CandidateReviewRecord;
}

/** 读某章最新审查记录(按文件名时间序取最后)。 */
export function latestReview(root: string, chapterIndex: number): ReviewRecord | undefined {
  const dir = paths(root).assistant.reviews;
  if (!existsSync(dir)) return undefined;
  const prefix = `semantic-review-${String(chapterIndex).padStart(3, "0")}-`;
  // R9(目录枚举扫描): 只接收 .json 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith(".json"))
    .map((e) => e.name);
  if (files.length === 0) return undefined;
  files.sort();
  return JSON.parse(readFileSync(`${dir}/${files[files.length - 1]}`, "utf8")) as ReviewRecord;
}

function reviewRecordFile(root: string, chapterIndex: number, reviewId: string): string {
  const dir = paths(root).assistant.reviews;
  const target = `semantic-review-${String(chapterIndex).padStart(3, "0")}-${reviewId}.json`;
  const found = readdirSync(dir, { withFileTypes: true })
    .some((entry) => entry.isFile() && entry.name === target);
  if (!found) throw new Error(`审查记录不存在: ${reviewId}`);
  return `${dir}/${target}`;
}

/** 打回 finding(幂等标记; 旧接口, 按数组序号定位, N30 保留兼容)。 */
export function rejectFinding(root: string, chapterIndex: number, reviewId: string, findingIndex: number): void {
  const file = reviewRecordFile(root, chapterIndex, reviewId);
  const record = JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
  if (findingIndex < 0 || findingIndex >= record.findings.length) {
    throw new Error(`finding 序号非法: ${findingIndex}`);
  }
  record.rejected_findings = record.rejected_findings ?? {};
  record.rejected_findings[String(findingIndex)] = { at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  gitAdd(root, [relOf(root, file)]);
  gitCommit(root, `reject finding ${reviewId}:${findingIndex}`);
}

/**
 * N30 · writing.md:283: 按 finding_id 打回 finding(幂等标记; rejected_findings 键 = finding_id)。
 * 与 rejectFinding(旧, 序号定位)同语义; 加法保留两者, 未知 id fail-closed 拒绝。
 */
export function rejectFindingById(
  root: string,
  chapterIndex: number,
  reviewId: string,
  findingId: string,
  reason?: string,
): void {
  const file = reviewRecordFile(root, chapterIndex, reviewId);
  const record = JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
  if (!record.findings.some((f) => f.finding_id === findingId)) {
    throw new Error(`finding_id 不存在: ${findingId}`);
  }
  record.rejected_findings = record.rejected_findings ?? {};
  record.rejected_findings[findingId] = {
    at: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
  };
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  gitAdd(root, [relOf(root, file)]);
  gitCommit(root, `reject finding ${reviewId}:${findingId}`);
}

/** Public finding dismissal uses the canonical transaction so unrelated staged bytes can never join its commit. */
export async function rejectFindingByIdTransactional(
  root: string,
  chapterIndex: number,
  reviewId: string,
  findingId: string,
  reason: string,
): Promise<void> {
  const why = reason.trim();
  if (why === "" || why.length > 1000) {
    throw new StoreError("VALIDATION_FAILED", "打回 finding 必须提供 1-1000 字理由");
  }
  const file = reviewRecordFile(root, chapterIndex, reviewId);
  assertNoInternalSymlink(root, file); // R9: 回执改写路径写前逐段 symlink 复检。
  const current = readFileSync(file, "utf8");
  const record = JSON.parse(current) as ReviewRecord;
  if (!record.findings.some((finding) => finding.finding_id === findingId)) {
    throw new Error(`finding_id 不存在: ${findingId}`);
  }
  record.rejected_findings = record.rejected_findings ?? {};
  record.rejected_findings[findingId] = { at: new Date().toISOString(), reason: why };
  await executeCanonicalWrite(root, [{
    path: relOf(root, file),
    current,
    output: JSON.stringify(record, null, 2) + "\n",
  }], {
    purpose: `reject finding ${reviewId}:${findingId}`,
    expectedHead: gitHead(root),
    validate: () => {
      const latest = readCurrentChapter(root, chapterIndex);
      if (record.target_kind !== "current" || record.target_content_hash !== latest.contentHash) {
        throw new StoreError("CONFLICT", `审查 ${reviewId} 已过期, finding 打回未执行`);
      }
    },
  });
}

export { registerWritingSpecsOnce };
