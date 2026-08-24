// writing · 续写提案第二阶段(§17.5.3「选定即备好参照卡」后的正文候选生成)。
// 选定方向 → llm_step(spec=writing_generate) → 正文候选 chapters/pending/{NNN}.md
// (status=candidate, 复用 adopt 采用流; 候选只读, 失败不改写正文)。
// 覆盖保护: 目标候选文件已存在 → 抛 CONFLICT fail-closed(不改旧文件、不新增 commit)。
import { existsSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, relOf, StoreError } from "@novelcraft/store";
import { chapterBody } from "./review.js";
import { compileProposalContext } from "./propose.js";
import { contentHashOf } from "./ingest.js";
import { chapterBodyText } from "./ingest.js";

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
  // 覆盖保护: 目标候选已存在 → 先抛清楚冲突(fail-fast, 不调 LLM、不改旧文件、不新增 commit)。
  const next = chapterIndex + 1;
  const candidateFile = `${paths(root).chapters.pending}/${String(next).padStart(3, "0")}.md`;
  if (existsSync(paths(root).chapters.chapterFile(next))) {
    throw new StoreError("CONFLICT", `第 ${next} 章已存在, 不能生成“下一章”候选`);
  }
  if (existsSync(candidateFile)) {
    throw new StoreError(
      "CONFLICT",
      `候选文件已存在, 拒绝覆盖: chapters/pending/${String(next).padStart(3, "0")}.md(先采用/清理该候选后再生成)`,
    );
  }
  const { contentHash } = chapterBody(root, chapterIndex);
  const direction = `【选定方向】${opts.proposalTitle}${opts.premise ? `: ${opts.premise}` : ""}`;
  const input = `${direction}\n\n${compileProposalContext(root, chapterIndex)}`;

  const r = await runStep(provider, { specRef: "writing_generate", input });
  if (!r.ok) return { ok: false, error: { kind: r.error?.kind, message: r.error?.message } };

  const draft = (r.result as { text: string }).text;
  // N23: chapter_candidate schema 必填 status/content_hash/source;
  // content_hash = 候选正文自身哈希(N13); source 标记生成来源。
  const body = chapterBodyText(draft);
  const fm = [
    "---",
    `chapter_index: ${next}`,
    "status: candidate",
    `content_hash: ${contentHashOf(body)}`,
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${contentHash}`,
    `proposal_title: ${JSON.stringify(opts.proposalTitle)}`,
    "source: writing_generate",
    `produced_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  // 并发安全(P1 复核): 'wx' 独占创建 —— 若 LLM 等待期间另一流程已创建目标候选,
  // 这里抛 EEXIST → 转 CONFLICT fail-closed: 不覆盖旧字节、不 gitAdd/commit。
  // (内容完整单次写, 无 check/write 窗口; 写前 existsSync 只做 fail-fast 省 LLM 调用。)
  try {
    writeFileSync(candidateFile, fm + body, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new StoreError(
        "CONFLICT",
        `候选文件已存在(LLM 等待期间被并发创建), 拒绝覆盖: chapters/pending/${String(next).padStart(3, "0")}.md`,
      );
    }
    throw err;
  }
  // 精确暂存(R17 范围语义): 只 stage 本次操作新写出的候选文件 —— 完整精确的
  // 相对 POSIX pathspec(relOf 保证 '/' 分隔), 绝不使用 -A; 用户无关的
  // 暂存/未暂存/未跟踪改动原样保留, 不被动卷入本 commit。
  gitAdd(root, [relOf(root, candidateFile)]);
  gitCommit(root, `generate candidate ch${next}`);
  return { ok: true, file: candidateFile };
}
