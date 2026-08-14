// R3 · 定向返修与候选采用(PLAN.md 步骤 3/4)。
// N30 · writing.md:332/353: applyRevision 支持按 finding_id 绑定冻结审查回执
// (findingIds 可选参数, 找不到即 fail-closed 拒绝); 基线 content_hash 未变才允许返修。
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { adopt, gitAdd, gitCommit } from "@novelcraft/store";
import { chapterBody, latestReview, registerWritingSpecsOnce } from "./review.js";
import type { ReviewFinding } from "./review.js";
import { contentHashOf } from "./ingest.js";

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
  const p = paths(root);
  const candidateFile = `${p.chapters.pending}/${String(chapterIndex).padStart(3, "0")}.md`;
  // N23: content_hash = 候选正文自身哈希(N13), source 标记修订来源。
  const fm = [
    "---",
    `chapter_index: ${chapterIndex}`,
    "status: candidate",
    `content_hash: ${contentHashOf(revised)}`,
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${contentHash}`,
    // N30: finding_ids = 解析后的 finding_id 串(id 路径)或原序号(index 路径, 兼容)。
    `finding_ids: [${findingIdsOut.join(", ")}]`,
    "source: writing_revise",
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
