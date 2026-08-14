// writing · 续写提案第二阶段(§17.5.3「选定即备好参照卡」后的正文候选生成)。
// 选定方向 → llm_step(spec=writing_generate) → 正文候选 chapters/pending/{NNN}.md
// (status=candidate, 复用 adopt 采用流; 候选只读, 失败不改写正文)。
import { writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { chapterBody } from "./review.js";
import { compileProposalContext } from "./propose.js";
import { contentHashOf } from "./ingest.js";

export interface GenerateNextChapterOptions {
  /** 选定提案标题(作者语言方向) */
  proposalTitle: string;
  /** 选定提案前提(可空) */
  premise?: string;
}

export interface GenerateResult {
  ok: boolean;
  file?: string;
  error?: { kind?: string; message?: string };
}

/**
 * 按选定方向生成下一章正文候选(续写模式)。chapterIndex = 当前最后一章;
 * 候选写 chapters/pending/{chapterIndex+1}.md, 经 adoptChapterCandidate 采用。
 */
export async function generateNextChapter(
  provider: Provider,
  root: string,
  chapterIndex: number,
  opts: GenerateNextChapterOptions,
): Promise<GenerateResult> {
  const { contentHash } = chapterBody(root, chapterIndex);
  const direction = `【选定方向】${opts.proposalTitle}${opts.premise ? `: ${opts.premise}` : ""}`;
  const input = `${direction}\n\n${compileProposalContext(root, chapterIndex)}`;

  const r = await runStep(provider, { specRef: "writing_generate", input });
  if (!r.ok) return { ok: false, error: { kind: r.error?.kind, message: r.error?.message } };

  const draft = (r.result as { text: string }).text;
  const next = chapterIndex + 1;
  const candidateFile = `${paths(root).chapters.pending}/${String(next).padStart(3, "0")}.md`;
  // N23: chapter_candidate schema 必填 status/content_hash/source;
  // content_hash = 候选正文自身哈希(N13); source 标记生成来源。
  const fm = [
    "---",
    `chapter_index: ${next}`,
    "status: candidate",
    `content_hash: ${contentHashOf(draft)}`,
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${contentHash}`,
    `proposal_title: ${JSON.stringify(opts.proposalTitle)}`,
    "source: writing_generate",
    `produced_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(candidateFile, fm + draft + "\n", "utf8");
  gitAdd(root);
  gitCommit(root, `generate candidate ch${next}`);
  return { ok: true, file: candidateFile };
}
