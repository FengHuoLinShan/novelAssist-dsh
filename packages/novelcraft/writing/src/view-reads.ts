// writing · UI 读面聚合(加法导出; ADR-0024 后续 UI seam 下沉)。
// 把宿主/客户端两侧各自手写的三段 .assistant 扫描收敛为本包单一实现:
//   reviewSummaries(.assistant/reviews 摘要卡) / latestProposalForChapter(按章提案) /
//   pendingChapterRefs(chapters/pending 有效候选索引)。
// 全部只读; R9(目录枚举扫描)纪律: 只接收 .json/.md 普通文件, symlink 忽略不跟随;
// 单文件损坏容错跳过(§17.5.1), 不让坏数据炸整个读面。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { readChapterCandidate } from "./review.js";
import type { ProposalRecord } from "./propose.js";

/** 各章最新语义审查的摘要卡(.assistant/reviews/*.json 的容错投影)。 */
export interface ReviewSummaryCard {
  review_id: string;
  chapter_index: number;
  verdict: string;
  finding_count: number;
  reviewed_at: string;
}

/**
 * 读各章审查摘要卡(评审台数据源): 逐文件容错(字段缺失回退文件名/空值),
 * 按 chapter_index 升序、reviewed_at 字典序稳定排序。坏 JSON 跳过。
 */
export function reviewSummaries(root: string): ReviewSummaryCard[] {
  const dir = paths(root).assistant.reviews;
  if (!existsSync(dir)) return [];
  const out: ReviewSummaryCard[] = [];
  // R9(目录枚举扫描): 只接收 .json 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(`${dir}/${entry.name}`, "utf8")) as {
        review_id?: unknown;
        chapter_index?: unknown;
        verdict?: unknown;
        findings?: unknown;
        reviewed_at?: unknown;
      };
      out.push({
        review_id: typeof rec.review_id === "string" ? rec.review_id : entry.name.replace(/\.json$/, ""),
        chapter_index: typeof rec.chapter_index === "number" ? rec.chapter_index : 0,
        verdict: typeof rec.verdict === "string" ? rec.verdict : "",
        finding_count: Array.isArray(rec.findings) ? rec.findings.length : 0,
        reviewed_at: typeof rec.reviewed_at === "string" ? rec.reviewed_at : "",
      });
    } catch {
      // 非法 JSON 跳过(坏文件不炸读面)。
    }
  }
  return out.sort((a, b) => a.chapter_index - b.chapter_index || a.reviewed_at.localeCompare(b.reviewed_at));
}

/**
 * 指定 next_chapter 的最新一条续写提案(文件名序取最后, 与 latestProposal 同口径)。
 * 无匹配/目录缺失 → undefined; 单文件坏 JSON 跳过。
 */
export function latestProposalForChapter(root: string, nextChapter: number): ProposalRecord | undefined {
  const dir = paths(root).assistant.proposals;
  if (!existsSync(dir)) return undefined;
  // R9(目录枚举扫描): 只接收 .json 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(readFileSync(`${dir}/${files[i]}`, "utf8")) as ProposalRecord;
      if (rec.next_chapter === nextChapter) return rec;
    } catch {
      // 非法 JSON 跳过(§17.5.1 容错)。
    }
  }
  return undefined;
}

/**
 * chapters/pending 下「格式合法且能通过候选读取校验」的章节索引列表(升序)。
 * 只认 /^\d{3}\.md$/ 普通文件; 名称合法但内容坏的候选被 readChapterCandidate
 * 拒绝后排除(不是有效工作区章)。与当前索引章的合并去重由调用方决定。
 */
export function pendingChapterRefs(root: string): number[] {
  const dir = paths(root).chapters.pending;
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const file of readdirSync(dir).sort()) {
    const match = /^(\d{3})\.md$/.exec(file);
    if (!match) continue;
    const index = Number(match[1]);
    if (index < 1) continue;
    try {
      readChapterCandidate(root, index, match[1]);
      out.push(index);
    } catch {
      // Malformed pending files are not valid workspace chapters.
    }
  }
  return out;
}
