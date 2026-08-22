// writing · 续写提案(写作前计划台, §17.4/§17.5.3)。
// 确定性编排: 编译上下文(总纲 + 剧情线/篇章纲/伏笔 + 上一章结尾) →
// llm_step(spec=next_chapter_proposal) → 2–3 条方向(各带依据/成本/风险)
// → 落 .assistant/proposals/next-{chapter}-{runId}.json(临时预览, 不写正文)。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, StepResult } from "@novelcraft/llm-step";
import { storyMap } from "@novelcraft/store";
import { readOutline } from "@novelcraft/outline";
import { chapterBody } from "./review.js";

export interface ChapterProposal {
  title: string;
  premise: string;
  /** 依据: 推进哪些剧情线/伏笔(作者语言) */
  basis?: string[];
  /** 成本: 篇幅/需补设定等 */
  cost?: string;
  /** 风险: 连续性/伏笔冲突等 */
  risk?: string;
}

export interface ProposalRecord {
  run_id: string;
  /** 提案依据的「上一章」 */
  chapter_index: number;
  /** 建议的下一章 */
  next_chapter: number;
  generated_at: string;
  proposals: ChapterProposal[];
}

export interface ProposeResult {
  ok: boolean;
  proposal?: ProposalRecord;
  error?: StepResult["error"];
}

function assetLines(
  xs: Array<{ name: string; summary?: string }>,
): string {
  return xs.map((x) => `- ${x.name}${x.summary ? `: ${x.summary}` : ""}`).join("\n");
}

/** 确定性上下文编译(总纲 + 结构资产 + 上一章结尾; 上限截断避免超预算)。 */
export function compileProposalContext(root: string, chapterIndex: number): string {
  const parts: string[] = [];
  const outline = readOutline(root);
  if (outline && typeof outline.outline_markdown === "string" && outline.outline_markdown.trim()) {
    parts.push(`【总纲】\n${outline.outline_markdown.trim().slice(0, 4000)}`);
  }
  const map = storyMap(root);
  if (map.threads.length) parts.push(`【剧情线】\n${assetLines(map.threads)}`);
  if (map.arcs.length) parts.push(`【篇章纲】\n${assetLines(map.arcs)}`);
  if (map.foreshadowing.length) parts.push(`【已种伏笔】\n${assetLines(map.foreshadowing)}`);
  try {
    const { body } = chapterBody(root, chapterIndex);
    const tail = body.trim().slice(-1500);
    if (tail) parts.push(`【第 ${chapterIndex} 章结尾】\n${tail}`);
  } catch {
    // 该章不存在则跳过(仍可基于总纲/结构提案)
  }
  return parts.join("\n\n");
}

/**
 * 生成下一章 2–3 条续写方向。provider 失败/无输出 → ok:false, 不落盘。
 * 微工作流「续写提案」阶段函数(D7): chapterIndex = 当前最后一章。
 */
export async function proposeNextChapter(
  provider: Provider,
  root: string,
  chapterIndex: number,
  now: Date = new Date(),
): Promise<ProposeResult> {
  const input = compileProposalContext(root, chapterIndex);
  const r = await runStep(provider, { specRef: "next_chapter_proposal", input });
  if (!r.ok) return { ok: false, error: r.error };

  const parsed = r.result as { proposals?: ChapterProposal[] };
  const proposals = (Array.isArray(parsed.proposals) ? parsed.proposals : []).slice(0, 3);
  if (proposals.length === 0) {
    return { ok: false, error: { kind: "schema_violation", message: "提案为空(无 proposals)" } };
  }

  const runId = `p${now.getTime()}`;
  const record: ProposalRecord = {
    run_id: runId,
    chapter_index: chapterIndex,
    next_chapter: chapterIndex + 1,
    generated_at: now.toISOString(),
    proposals,
  };
  const dir = paths(root).assistant.proposals;
  mkdirSync(dir, { recursive: true });
  const file = paths(root).assistant.proposalFile(
    `next-${String(chapterIndex).padStart(3, "0")}-${runId}`,
  );
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ok: true, proposal: record };
}

/** 读最新一条续写提案(按文件名序取最后; 无则 undefined)。 */
export function latestProposal(root: string): ProposalRecord | undefined {
  const dir = paths(root).assistant.proposals;
  if (!existsSync(dir)) return undefined;
  // R9(目录枚举扫描): 只接收 .json 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
  if (files.length === 0) return undefined;
  files.sort();
  return JSON.parse(readFileSync(`${dir}/${files[files.length - 1]}`, "utf8")) as ProposalRecord;
}
