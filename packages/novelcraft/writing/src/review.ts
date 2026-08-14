// R3 · 语义审查(PLAN.md 步骤 2): 读章节正文 → llm_step(semantic_review)
// → findings 落 .assistant/reviews/(N4 落点)。失败不写文件。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep, registerSpec } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import type { StepResult } from "@novelcraft/llm-step";

export interface ReviewFinding {
  category: string;
  severity: "high" | "medium" | "low";
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
  rejected_findings?: Record<string, { at: string }>;
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

export async function reviewChapter(
  provider: Provider,
  root: string,
  chapterIndex: number,
  now: Date = new Date(),
): Promise<ReviewResult> {
  const { body, contentHash } = chapterBody(root, chapterIndex);
  const r = await runStep(provider, { specRef: "semantic_review", input: body });
  if (!r.ok) return { ok: false, error: r.error };

  const parsed = r.result as { findings?: ReviewFinding[]; verdict?: string };
  const reviewId = `r${now.getTime()}`;
  const record: ReviewRecord = {
    chapter_index: chapterIndex,
    chapter_file: paths(root).chapters.chapterFile(chapterIndex),
    content_hash: contentHash,
    reviewed_at: now.toISOString(),
    review_id: reviewId,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    verdict: parsed.verdict,
  };
  const file = paths(root).assistant.reviewFile(`semantic-review-${String(chapterIndex).padStart(3, "0")}-${reviewId}`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ok: true, review: record };
}

/** 读某章最新审查记录(按文件名时间序取最后)。 */
export function latestReview(root: string, chapterIndex: number): ReviewRecord | undefined {
  const dir = paths(root).assistant.reviews;
  if (!existsSync(dir)) return undefined;
  const prefix = `semantic-review-${String(chapterIndex).padStart(3, "0")}-`;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (files.length === 0) return undefined;
  files.sort();
  return JSON.parse(readFileSync(`${dir}/${files[files.length - 1]}`, "utf8")) as ReviewRecord;
}

/** 打回 finding(幂等标记)。 */
export function rejectFinding(root: string, chapterIndex: number, reviewId: string, findingIndex: number): void {
  const dir = paths(root).assistant.reviews;
  const prefix = `semantic-review-${String(chapterIndex).padStart(3, "0")}-${reviewId}`;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (files.length === 0) throw new Error(`审查记录不存在: ${reviewId}`);
  const file = `${dir}/${files[0]}`;
  const record = JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
  if (findingIndex < 0 || findingIndex >= record.findings.length) {
    throw new Error(`finding 序号非法: ${findingIndex}`);
  }
  record.rejected_findings = record.rejected_findings ?? {};
  record.rejected_findings[String(findingIndex)] = { at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
}

export { registerWritingSpecsOnce };
