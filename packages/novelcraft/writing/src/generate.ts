// writing · 续写提案第二阶段(§17.5.3「选定即备好参照卡」后的正文候选生成)。
// 选定方向 → llm_step(spec=writing_generate) → 正文候选 chapters/pending/{NNN}.md
// (status=candidate, 复用 adopt 采用流; 候选只读, 失败不改写正文)。
// 覆盖保护: 目标候选文件已存在 → 抛 CONFLICT fail-closed(不改旧文件、不新增 commit)。
import { existsSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, hasStagedOutside, relOf, StoreError } from "@novelcraft/store";
import { chapterBody } from "./review.js";
import {
  assertFrozenProposalCurrent,
  buildAuditableProposalContext,
  compileProposalContextBudgeted,
  frozenProposalById,
  proposalRecordByRunId,
} from "./propose.js";
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
  chapter_index?: number;
  run_id?: string;
  proposal_id?: string;
  context_hash?: string;
  error?: { kind?: string; message?: string };
}

export interface GenerateFromProposalOptions {
  runId: string;
  proposalId: string;
}

interface PreparedGeneration {
  input: string;
  baseContentHash: string;
  proposalTitle: string;
  extraFrontmatter?: string[];
  verifyAfterProvider?: () => void;
  result?: Pick<GenerateResult, "run_id" | "proposal_id" | "context_hash">;
}

async function generateCandidate(
  provider: Provider,
  root: string,
  chapterIndex: number,
  prepare: () => PreparedGeneration,
): Promise<GenerateResult> {
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
  if (hasStagedOutside(root, [relOf(root, candidateFile)])) {
    throw new StoreError(
      "DIRTY_WORKSPACE",
      "工作区存在范围外预存 staged, 拒绝生成候选(先提交或清理暂存区后重试; R17/M10-C1)",
    );
  }
  const prepared = prepare();
  const r = await runStep(provider, { specRef: "writing_generate", input: prepared.input });
  if (!r.ok) return { ok: false, error: { kind: r.error?.kind, message: r.error?.message } };
  prepared.verifyAfterProvider?.();

  const body = chapterBodyText((r.result as { text: string }).text);
  const fm = [
    "---",
    `chapter_index: ${next}`,
    "status: candidate",
    `content_hash: ${contentHashOf(body)}`,
    `base_chapter: ${chapterIndex}`,
    `base_content_hash: ${prepared.baseContentHash}`,
    `proposal_title: ${JSON.stringify(prepared.proposalTitle)}`,
    ...(prepared.extraFrontmatter ?? []),
    "source: writing_generate",
    `produced_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
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
  if (hasStagedOutside(root, [relOf(root, candidateFile)])) {
    throw new StoreError(
      "DIRTY_WORKSPACE",
      "工作区存在范围外未提交改动(含预存 staged), 拒绝生成候选提交以免卷入外部内容(R17/M10-C1)",
    );
  }
  gitAdd(root, [relOf(root, candidateFile)]);
  gitCommit(root, `generate candidate ch${next}`);
  return { ok: true, file: candidateFile, chapter_index: next, ...prepared.result };
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
  return generateCandidate(provider, root, chapterIndex, () => {
    const { contentHash } = chapterBody(root, chapterIndex);
    const direction = `【选定方向】${opts.proposalTitle}${opts.premise ? `: ${opts.premise}` : ""}`;
    return {
      input: `${direction}\n\n${compileProposalContextBudgeted(root, chapterIndex)}`,
      baseContentHash: contentHash,
      proposalTitle: opts.proposalTitle,
    };
  });
}

/** DSH 公开安全入口：只接受冻结 run/proposal 身份，不接收调用方自带标题或 premise。 */
export async function generateNextChapterFromProposal(
  provider: Provider,
  root: string,
  opts: GenerateFromProposalOptions,
): Promise<GenerateResult> {
  const record = proposalRecordByRunId(root, opts.runId);
  const selected = frozenProposalById(record, opts.proposalId);
  return generateCandidate(provider, root, record.chapter_index, () => {
    assertFrozenProposalCurrent(root, record);
    const context = buildAuditableProposalContext(root, record.chapter_index, { selected });
    return {
      input: context.rendered_text,
      baseContentHash: context.base_content_hash,
      proposalTitle: selected.title,
      extraFrontmatter: [
        `proposal_run_id: ${JSON.stringify(record.run_id)}`,
        `proposal_id: ${JSON.stringify(selected.proposal_id)}`,
        `context_hash: ${context.context_hash}`,
      ],
      verifyAfterProvider: () => {
        const currentRecord = proposalRecordByRunId(root, record.run_id);
        const currentProposal = frozenProposalById(currentRecord, selected.proposal_id);
        assertFrozenProposalCurrent(root, currentRecord);
        const current = buildAuditableProposalContext(root, currentRecord.chapter_index, { selected: currentProposal });
        if (current.context_hash !== context.context_hash || current.base_content_hash !== context.base_content_hash) {
          throw new StoreError("CONFLICT", `提案 ${selected.proposal_id} 的生成上下文在 provider 调用期间变化，候选未落盘`);
        }
      },
      result: { run_id: record.run_id, proposal_id: selected.proposal_id, context_hash: context.context_hash },
    };
  });
}
