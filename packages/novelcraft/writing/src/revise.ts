// R3 · 定向返修与候选采用(PLAN.md 步骤 3/4)。
// N30 · writing.md:332/353: applyRevision 支持按 finding_id 绑定冻结审查回执
// (findingIds 可选参数, 找不到即 fail-closed 拒绝); 基线 content_hash 未变才允许返修。
// 覆盖保护: 目标候选文件已存在 → 抛 CONFLICT fail-closed(不改旧文件、不新增 commit)。
// P1(用户裁定): source=writing_revise 候选在 store.adopt 前解析 base_chapter/
// base_content_hash, 重读当前 chapters/{NNN}.md 正文并 contentHashOf 比对; 缺字段或
// 失配 fail-closed(候选/正文均不变、无 commit)。普通 writing_generate 候选不强制。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import {
  assertNoInternalSymlink,
  contentHash,
  executeCanonicalWrite,
  executePreparedAdopt,
  gitAdd,
  gitCommit,
  gitHead,
  parseFrontmatter,
  prepareCanonicalWrite,
  readCurrentChapter,
  relOf,
  resolveAsset,
  serializeFrontmatter,
  StoreError,
  validateFrontmatterForWrite,
  type AdoptOptions,
  type AdoptResult,
  type PreparedAdopt,
} from "@novelcraft/store";
import { chapterBody, latestCandidateReview, latestReview, registerWritingSpecsOnce } from "./review.js";
import type { ReviewFinding } from "./review.js";
import { assertPovKnowledgeReceiptCurrent, type PovKnowledgeReceipt } from "./pov-context.js";
import { chapterBodyText, contentHashOf } from "./ingest.js";
import {
  assertFrozenProposalCurrent,
  buildAuditableProposalContext,
  frozenProposalById,
  proposalRecordByRunId,
} from "./propose.js";

export interface ReviseResult {
  ok: boolean;
  file?: string;
  error?: { kind?: string; message?: string };
}

function findingsText(
  f: Array<{ category: string; severity: string; quote: string; suggestion: string }>,
): string {
  return f
    .map((x, i) => `#${i} [${x.severity}/${x.category}] 原文片段:「${x.quote}」建议: ${x.suggestion}`)
    .join("\n");
}

/** 对选定 findings 生成修订候选 → chapters/pending/{NNN}.md
 *  (status=candidate; N23: chapter_candidate 必填 status/content_hash/source,
 *  source=writing_revise 标记修订来源)。
 *  N30 · writing.md:332/353: 提供 findingIds 时按 finding_id 从冻结回执解析
 *  (找不到即 fail-closed 拒绝), 候选 fm 的 finding_ids 写解析后的 id 串;
 *  未提供时走旧 index 路径(保留兼容, 不删)。 */
export async function applyRevision(
  provider: Provider,
  root: string,
  chapterIndex: number,
  findingIndexes: number[],
  findingIds?: string[],
): Promise<ReviseResult> {
  // 覆盖保护: 目标候选已存在 → 先抛清楚冲突(fail-fast, 不调 LLM、不改旧文件、不新增 commit)。
  const candidateFile = `${paths(root).chapters.pending}/${String(chapterIndex).padStart(3, "0")}.md`;
  if (existsSync(candidateFile)) {
    throw new StoreError(
      "CONFLICT",
      `候选文件已存在, 拒绝覆盖: chapters/pending/${String(chapterIndex).padStart(3, "0")}.md(先采用/清理该候选后再返修)`,
    );
  }
  const review = latestReview(root, chapterIndex);
  if (!review) throw new Error(`无审查记录, 先跑 reviewChapter: 第 ${chapterIndex} 章`);
  const { body, contentHash } = chapterBody(root, chapterIndex);
  // N30 · writing.md:353: 返修必须绑定冻结审查回执 — 基线 content_hash 未变, 否则拒绝。
  if (review.content_hash !== contentHash) {
    throw new Error(
      `基线 content_hash 失配, 拒绝返修: 审查 ${review.review_id} 冻结 ${review.content_hash}, 当前 ${contentHash}`,
    );
  }
  let selected: ReviewFinding[];
  let findingIdsOut: string[];
  if (findingIds !== undefined) {
    // N30: 按 finding_id 从冻结回执解析; 找不到即 fail-closed 拒绝(writing.md:353)。
    if (findingIds.length === 0) throw new Error("findingIds 为空");
    selected = [];
    findingIdsOut = [];
    for (const id of findingIds) {
      const f = review.findings.find((x) => x.finding_id === id);
      if (!f) throw new Error(`finding_id 不存在于冻结回执: ${id}`);
      selected.push(f);
      findingIdsOut.push(f.finding_id);
    }
  } else {
    // 旧 index 路径(N30: 保留兼容, 不删)。
    selected = findingIndexes.map((i) => {
      if (i < 0 || i >= review.findings.length) throw new Error(`finding 序号非法: ${i}`);
      return review.findings[i];
    });
    findingIdsOut = findingIndexes.map(String);
  }
  registerWritingSpecsOnce();
  const r = await runStep(provider, {
    specRef: "targeted_revision",
    input: `【冻结正文】\n${body}\n\n【待修 findings】\n${findingsText(selected)}`,
  });
  if (!r.ok) return { ok: false, error: { kind: r.error?.kind, message: r.error?.message } };

  const revised = (r.result as { text: string }).text;
  // N23: content_hash = 候选正文自身哈希(N13), source 标记修订来源。
  // P1: base_content_hash 冻结 = contentHashOf(正文) 而非章节存储字段 —— ingest 存的
  // content_hash 是归一文本哈希(正文文件多一个结尾换行), adoptChapterCandidate 的 P1
  // 采用前重算用的就是 contentHashOf(正文), 冻结值与之同约定(见 assertRevisionBaseline)。
  const revisedBody = chapterBodyText(revised);
  const fm = [
    "---",
    `chapter_index: ${chapterIndex}`,
    "status: candidate",
    `content_hash: ${contentHashOf(revisedBody)}`,
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${contentHashOf(body)}`,
    // N30: finding_ids = 解析后的 finding_id 串(id 路径)或原序号(index 路径, 兼容)。
    `finding_ids: [${findingIdsOut.join(", ")}]`,
    "source: writing_revise",
    `produced_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  // 并发安全(P1 复核): 'wx' 独占创建 —— 若 LLM 等待期间另一流程已创建目标候选,
  // 这里抛 EEXIST → 转 CONFLICT fail-closed: 不覆盖旧字节、不 gitAdd/commit。
  // (内容完整单次写, 无 check/write 窗口; 写前 existsSync 只做 fail-fast 省 LLM 调用。)
  try {
    writeFileSync(candidateFile, fm + revisedBody, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new StoreError(
        "CONFLICT",
        `候选文件已存在(LLM 等待期间被并发创建), 拒绝覆盖: chapters/pending/${String(chapterIndex).padStart(3, "0")}.md`,
      );
    }
    throw err;
  }
  // §22.4 审计双链: 每次资产变更 = 一个 commit; 也为后续 adopt 保持工作区干净(R17)。
  // 精确暂存(R17 范围语义): 只 stage 本次修订操作新写出的候选文件 —— 完整精确的
  // 相对 POSIX pathspec(relOf 保证 '/' 分隔), 绝不使用 -A; 用户无关的
  // 暂存/未暂存/未跟踪改动原样保留, 不被动卷入本 commit。
  gitAdd(root, [relOf(root, candidateFile)]);
  gitCommit(root, `revision candidate ch${chapterIndex}`);
  return { ok: true, file: candidateFile };
}

/** Public revision only accepts a fresh strict-current review produced by reviewCurrentChapter. */
export async function applyReviewedRevision(
  provider: Provider,
  root: string,
  chapterIndex: number,
  findingIds: string[],
): Promise<ReviseResult> {
  const current = readCurrentChapter(root, chapterIndex);
  const review = latestReview(root, chapterIndex);
  if (
    review?.target_kind !== "current" || review.target_content_hash !== current.contentHash ||
    review.discarded_finding_count !== 0 || (review.unlocated_finding_ids?.length ?? 0) !== 0
  ) {
    throw new StoreError("VALIDATION_FAILED", `第 ${chapterIndex} 章缺少 fresh 可定位的 current review`);
  }
  if (new Set(findingIds).size !== findingIds.length) {
    throw new StoreError("VALIDATION_FAILED", "finding_ids 不得重复");
  }
  for (const id of findingIds) {
    if (review.rejected_findings?.[id] !== undefined) {
      throw new StoreError("VALIDATION_FAILED", `finding ${id} 已被作者打回, 不得返修`);
    }
  }
  return applyRevision(provider, root, chapterIndex, [], findingIds);
}

/**
 * P1(用户裁定): source=writing_revise 候选在 store.adopt 前做修订基线校验。
 * 解析 base_chapter/base_content_hash, 重读当前 chapters/{NNN}.md 正文并 contentHashOf
 * 比对; 缺字段/基线章节不可读或失配 fail-closed(候选/正文均不变、无 commit —— 抛错先于
 * adopt 的任何写)。普通 writing_generate 候选不强制。
 *
 * base_content_hash 两种冻结约定(见 oldConventionBodyHash):
 * - 新约定(本仓库现生成): contentHashOf(正文) —— 正文字节精确哈希, 含文件序列化换行;
 * - 旧约定(旧候选): 章节存储 content_hash 字段 = contentHashOf(normalizeChapterText(原文)),
 *   即归一文本哈希、不含文件序列化换行。兼容判定 = 从当前正文剥掉恰好一个文件序列化换行
 *   后重哈希比对; 正文多尾换行(归一文本以 \n 或 \n\n 结尾)时同样精确还原, 且只剥一个换行
 *   保证不误放行「尾空行被删/新增」的已变更正文(盲剥全部尾换行会破坏旧规范语义, fail-closed)。
 * 真正的内容改动两种约定都失配 → 拒绝。
 */
function assertRevisionBaseline(root: string, fm: Record<string, unknown>, ref: string): void {
  if (fm.source !== "writing_revise") return; // 普通 writing_generate 候选不强制 base hash。
  const baseChapter = Number(fm.base_chapter);
  const baseHash = typeof fm.base_content_hash === "string" ? fm.base_content_hash : "";
  if (!Number.isInteger(baseChapter) || baseChapter < 1) {
    throw new StoreError("BAD_CANDIDATE", `修订候选 ${ref} 缺少合法 base_chapter, 拒绝采用(fail-closed, P1)`);
  }
  if (!/^[0-9a-f]{64}$/.test(baseHash)) {
    throw new StoreError("BAD_CANDIDATE", `修订候选 ${ref} 缺少合法 base_content_hash, 拒绝采用(fail-closed, P1)`);
  }
  // 重读当前章节正文并重算(不信任存储字段; P1)。
  // 基线章节文件不存在/不可读: chapterBody 抛裸 Error → 转 BAD_CANDIDATE 明确基线拒绝
  // (fail-closed: 抛错先于 adopt 的任何写与 commit, 候选/正文均不变、无新 commit)。
  let body: string;
  try {
    ({ body } = chapterBody(root, baseChapter));
  } catch (err) {
    throw new StoreError(
      "BAD_CANDIDATE",
      `修订基线章节不可复核, 拒绝采用: 候选 ${ref} 引用的第 ${baseChapter} 章不存在或不可读(${err instanceof Error ? err.message : String(err)}), fail-closed(P1)`,
    );
  }
  const current = contentHashOf(body);
  // 新约定: 正文字节精确哈希(严格); 旧约定: 剥一个文件序列化换行后的哈希(兼容旧候选)。
  if (current !== baseHash && oldConventionBodyHash(body) !== baseHash) {
    throw new StoreError(
      "CONFLICT",
      `修订基线失配, 拒绝采用: 候选 ${ref} 冻结 ${baseHash}, 第 ${baseChapter} 章当前正文 ${current}(正文在返修后被修改, P1)`,
    );
  }
}

/**
 * 旧约定冻结值还原: 章节存储 content_hash = 归一文本哈希(无文件序列化换行), 而正文文件
 * 字节 = 归一文本 + 恰好一个序列化换行(ingestChapter: chapterFrontmatter + normalized + "\n")。
 * 故剥掉这一个换行后重哈希, 即与旧约定完全一致 —— 正文多尾换行(归一文本以 \n 或 \n\n 结尾,
 * 文件正文 2~3 个尾换行)同样精确还原(normalizeChapterText 最多保留一个尾空行, 见 ingest.ts)。
 * 注意只剥一个换行、非剥全部尾换行: 尾空行是归一文本的合法内容, 盲剥会把「尾空行被删/新增」
 * 的已变更正文误判为未变(fail-closed; 旧引擎 content_hash 同为精确字节哈希, 见
 * source_hashing.hash_text)。
 */
function oldConventionBodyHash(body: string): string {
  return contentHashOf(body.replace(/\n$/, ""));
}

/** 新安全续写候选采用前重建 proposal + generate 两层冻结上下文；旧候选兼容放行。 */
function assertGeneratedProposalBaseline(root: string, fm: Record<string, unknown>, ref: string): void {
  const fields = [fm.proposal_run_id, fm.proposal_id, fm.context_hash];
  if (fields.every((value) => value === undefined)) return;
  if (fields.some((value) => typeof value !== "string") || !/^[0-9a-f]{64}$/.test(String(fm.context_hash ?? ""))) {
    throw new StoreError("BAD_CANDIDATE", `续写候选 ${ref} 的冻结提案字段不完整`);
  }
  const record = proposalRecordByRunId(root, String(fm.proposal_run_id));
  const proposal = frozenProposalById(record, String(fm.proposal_id));
  const baseChapter = Number(fm.base_chapter);
  const baseHash = String(fm.base_content_hash ?? "");
  if (baseChapter !== record.chapter_index || baseHash !== record.base_content_hash || fm.proposal_title !== proposal.title) {
    throw new StoreError("CONFLICT", `续写候选 ${ref} 与冻结提案身份不一致，拒绝采用`);
  }
  assertFrozenProposalCurrent(root, record);
  const current = buildAuditableProposalContext(root, record.chapter_index, { selected: proposal });
  if (current.context_hash !== fm.context_hash || current.base_content_hash !== baseHash) {
    throw new StoreError("CONFLICT", `续写候选 ${ref} 的来源已变化，保持 pending；请重新生成`);
  }
}

/** Public adoption must freeze both the reviewed candidate bytes and its current/base facts. */
export function prepareReviewedChapterCandidateAdopt(
  root: string,
  ref: string,
  opts: AdoptOptions = {},
): PreparedAdopt {
  return prepareChapterCandidateAdopt(root, ref, opts, true);
}

function prepareChapterCandidateAdopt(
  root: string,
  ref: string,
  opts: AdoptOptions,
  requireReview: boolean,
): PreparedAdopt {
  const asset = resolveAsset(root, "chapter_candidate", ref);
  const raw = readFileSync(asset.abs, "utf8");
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data as Record<string, unknown>;
  if (fm.status !== "candidate") {
    throw new StoreError("ILLEGAL_TRANSITION", `章节候选 ${ref} 当前状态不是 candidate`);
  }
  const chapterIndex = Number(fm.chapter_index);
  if (!Number.isInteger(chapterIndex) || chapterIndex < 1) {
    throw new StoreError("BAD_CANDIDATE", `章节候选 ${ref} 缺少合法 chapter_index`);
  }
  const actualHash = contentHash(parsed.body);
  if (fm.content_hash !== actualHash) {
    throw new StoreError("BAD_CANDIDATE", `章节候选 ${ref} content_hash 与实际正文不一致`);
  }
  if (opts.expectedContentHash !== undefined && opts.expectedContentHash !== actualHash) {
    throw new StoreError("CONFLICT", `章节候选 ${ref} content_hash CAS 失败`);
  }
  let targetCurrent: string | null;
  const targetRel = `chapters/${String(chapterIndex).padStart(3, "0")}.md`;
  if (fm.source === "writing_revise") {
    assertRevisionBaseline(root, fm, asset.slug);
    const current = readCurrentChapter(root, chapterIndex);
    targetCurrent = readFileSync(paths(root).chapters.chapterFile(chapterIndex), "utf8");
    if (current.file !== targetRel) throw new StoreError("BAD_CANDIDATE", `章节候选 ${ref} 目标章不一致`);
  } else if (fm.source === "writing_generate") {
    assertGeneratedProposalBaseline(root, fm, asset.slug);
    if (existsSync(paths(root).chapters.chapterFile(chapterIndex))) {
      throw new StoreError("CONFLICT", `第 ${chapterIndex} 章已存在, 拒绝采用旧续写候选`);
    }
    targetCurrent = null;
  } else {
    throw new StoreError("BAD_CANDIDATE", `章节候选 ${ref} source 不受支持`);
  }
  // R9: 写前对落盘目标与源候选逐段 symlink 复检(resolve 后不得被换成 symlink,
  // 与 store.prepareAdopt 同款防线; 执行器只兜底最终组件)。
  assertNoInternalSymlink(root, paths(root).chapters.chapterFile(chapterIndex));
  assertNoInternalSymlink(root, asset.abs);
  let reviewReceipt: PovKnowledgeReceipt | undefined;
  if (requireReview) {
    const review = latestCandidateReview(root, chapterIndex, asset.slug);
    if (
      review === undefined || review.verdict !== "pass" ||
      review.target_content_hash !== actualHash || review.target_file_hash !== contentHash(raw)
    ) {
      throw new StoreError("VALIDATION_FAILED", `章节候选 ${ref} 缺少 fresh 独立审查 pass`);
    }
    if (review.pov_context_receipt === undefined) {
      if (fm.source === "writing_generate" && fm.proposal_run_id !== undefined) {
        throw new StoreError("VALIDATION_FAILED", `章节候选 ${ref} 缺少 POV/知识独立审查回执，请重新审查`);
      }
    } else {
      assertPovKnowledgeReceiptCurrent(root, review.pov_context_receipt);
      reviewReceipt = review.pov_context_receipt;
    }
  }
  const now = new Date().toISOString();
  const draftFm: Record<string, unknown> = {
    ...fm,
    status: "draft",
    content_hash: actualHash,
    provenance: {
      ...(fm.provenance && typeof fm.provenance === "object" && !Array.isArray(fm.provenance)
        ? fm.provenance as Record<string, unknown>
        : {}),
      adopted_from_candidate_id: asset.slug,
      adopted_at: now,
      adopted_by: opts.adoptedBy ?? "author",
    },
  };
  // 与 store.prepareAdopt 同款: 顶层历史字段不带入 draft(归 provenance, 防混淆)。
  delete draftFm.adopted_from_candidate_id;
  const draft = validateFrontmatterForWrite("chapter", draftFm, String(chapterIndex).padStart(3, "0"));
  return Object.freeze({
    write: prepareCanonicalWrite(root, [
      { path: targetRel, current: targetCurrent, output: serializeFrontmatter(draft, parsed.body) },
      { path: asset.rel, current: raw, output: undefined },
    ], {
      purpose: `adopt(chapter): ${asset.slug} -> ${targetRel}`,
      expectedHead: gitHead(root),
      ...(fm.source === "writing_generate" || reviewReceipt !== undefined
        ? { validate: (target: string) => {
            if (target !== targetRel) return;
            if (fm.source === "writing_generate") assertGeneratedProposalBaseline(root, fm, asset.slug);
            if (reviewReceipt !== undefined) assertPovKnowledgeReceiptCurrent(root, reviewReceipt);
          } }
        : {}),
      ...(opts.tx ? { tx: opts.tx } : {}),
    }),
    result: Object.freeze({
      kind: "chapter_candidate" as const,
      ref: asset.slug,
      fromStatus: "candidate",
      toStatus: "draft",
      targetRelPath: targetRel,
    }),
  });
}

export function executeReviewedChapterCandidateAdopt(prepared: PreparedAdopt): Promise<AdoptResult> {
  return executePreparedAdopt(prepared);
}

export interface ChapterCandidateRejectResult {
  chapterIndex: number;
  ref: string;
  decision: "rejected";
  reason: string;
  commit: string;
}

/** Candidate rejection is one exact transaction: durable decision receipt + active pending deletion. */
export async function rejectChapterCandidate(
  root: string,
  chapterIndex: number,
  ref: string,
  expectedContentHash: string,
  reason: string,
  now: Date = new Date(),
): Promise<ChapterCandidateRejectResult> {
  const why = reason.trim();
  if (why === "" || why.length > 1000) {
    throw new StoreError("VALIDATION_FAILED", "拒绝候选必须提供 1-1000 字理由");
  }
  const asset = resolveAsset(root, "chapter_candidate", ref);
  const raw = readFileSync(asset.abs, "utf8");
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data as Record<string, unknown>;
  if (fm.status !== "candidate" || Number(fm.chapter_index) !== chapterIndex) {
    throw new StoreError("BAD_CANDIDATE", `候选 ${ref} 不是第 ${chapterIndex} 章 active candidate`);
  }
  const actualHash = contentHash(parsed.body);
  if (fm.content_hash !== actualHash) {
    throw new StoreError("BAD_CANDIDATE", `候选 ${ref} content_hash 与实际正文不一致`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedContentHash) || expectedContentHash !== actualHash) {
    throw new StoreError("CONFLICT", `候选 ${ref} 已变化, 拒绝决定未执行`);
  }
  const receipt = {
    decision: "rejected" as const,
    chapter_index: chapterIndex,
    candidate_ref: asset.slug,
    candidate_content_hash: actualHash,
    reason: why,
    decided_at: now.toISOString(),
  };
  const receiptFile = paths(root).assistant.reviewFile(
    `candidate-decision-${String(chapterIndex).padStart(3, "0")}-${asset.slug}-${now.getTime()}`,
  );
  // R9: 删除目标与回执落盘路径写前逐段 symlink 复检(执行器只兜底最终组件)。
  assertNoInternalSymlink(root, asset.abs);
  assertNoInternalSymlink(root, receiptFile);
  const result = await executeCanonicalWrite(root, [
    { path: asset.rel, current: raw, output: undefined },
    { path: relOf(root, receiptFile), current: null, output: JSON.stringify(receipt, null, 2) + "\n" },
  ], { purpose: `reject chapter candidate ${chapterIndex}:${asset.slug}`, expectedHead: gitHead(root) });
  return { chapterIndex, ref: asset.slug, decision: "rejected", reason: why, commit: result.commit };
}

/** 采用序号最小的候选(copy-on-adopt → draft + git commit, 脏工作区拒绝由 store 保证)。 */
export async function adoptChapterCandidate(root: string): Promise<{ ok: boolean; error?: string }> {
  const pendingDir = paths(root).chapters.pending;
  const files = existsSync(pendingDir)
    ? readdirSync(pendingDir).filter((f) => /^\d{3}\.md$/.test(f))
    : [];
  if (files.length === 0) throw new Error("无候选可采用");
  files.sort();
  const ref = files[0].replace(/\.md$/, ""); // "003"
  // P1 基线校验由 prepareChapterCandidateAdopt 内部完成(revise 候选 fail-closed, 零写入零 commit)。
  await executePreparedAdopt(prepareChapterCandidateAdopt(root, ref, {}, false));
  return { ok: true };
}
