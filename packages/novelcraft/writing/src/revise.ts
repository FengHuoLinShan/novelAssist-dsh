// R3 · 定向返修与候选采用(PLAN.md 步骤 3/4)。
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { adopt, gitAdd, gitCommit } from "@novelcraft/store";
import { chapterBody, latestReview, registerWritingSpecsOnce } from "./review.js";

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

/** 对选定 findings 生成修订候选 → chapters/pending/{NNN}.md(status=candidate)。 */
export async function applyRevision(
  provider: Provider,
  root: string,
  chapterIndex: number,
  findingIndexes: number[],
): Promise<ReviseResult> {
  const review = latestReview(root, chapterIndex);
  if (!review) throw new Error(`无审查记录, 先跑 reviewChapter: 第 ${chapterIndex} 章`);
  const selected = findingIndexes.map((i) => {
    if (i < 0 || i >= review.findings.length) throw new Error(`finding 序号非法: ${i}`);
    return review.findings[i];
  });
  const { body, contentHash } = chapterBody(root, chapterIndex);
  registerWritingSpecsOnce();
  const r = await runStep(provider, {
    specRef: "targeted_revision",
    input: `【冻结正文】\n${body}\n\n【待修 findings】\n${findingsText(selected)}`,
  });
  if (!r.ok) return { ok: false, error: { kind: r.error?.kind, message: r.error?.message } };

  const revised = (r.result as { text: string }).text;
  const p = paths(root);
  const candidateFile = `${p.chapters.pending}/${String(chapterIndex).padStart(3, "0")}.md`;
  const fm = [
    "---",
    `chapter_index: ${chapterIndex}`,
    "status: candidate",
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${contentHash}`,
    `finding_ids: [${findingIndexes.join(", ")}]`,
    `produced_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(candidateFile, fm + revised + "\n", "utf8");
  // §22.4 审计双链: 每次资产变更 = 一个 commit; 也为后续 adopt 保持工作区干净(R17)。
  gitAdd(root);
  gitCommit(root, `revision candidate ch${chapterIndex}`);
  return { ok: true, file: candidateFile };
}

/** 采用序号最小的候选(copy-on-adopt → draft + git commit, 脏工作区拒绝由 store 保证)。 */
export function adoptChapterCandidate(root: string): { ok: boolean; error?: string } {
  const pendingDir = paths(root).chapters.pending;
  const files = existsSync(pendingDir)
    ? readdirSync(pendingDir).filter((f) => /^\d{3}\.md$/.test(f))
    : [];
  if (files.length === 0) throw new Error("无候选可采用");
  files.sort();
  const ref = files[0].replace(/\.md$/, ""); // "003"
  adopt(root, "chapter_candidate", ref);
  return { ok: true };
}
