// writing · 续写提案(写作前计划台, §17.4/§17.5.3)。
// 确定性编排: 编译上下文(总纲 + 剧情线/篇章纲/伏笔 + 上一章结尾) →
// llm_step(spec=next_chapter_proposal) → 2–3 条方向(各带依据/成本/风险)
// → 落 .assistant/proposals/next-{chapter}-{runId}.json(临时预览, 不写正文)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertNoSymlinkOnPath, guardPath, paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, StepResult } from "@novelcraft/llm-step";
import { StoreError, storyMap } from "@novelcraft/store";
import {
  compileAuditableContext,
  compileContext,
  contextSummary,
  type AuditableContextWarning,
  type AuditableSourceRef,
} from "@novelcraft/context";
import { readOutline } from "@novelcraft/outline";
import { rankChunksBm25, readRagIndex, type RagChunk } from "@novelcraft/rag";
import { chapterBody } from "./review.js";
import { contentHashOf } from "./ingest.js";
import { resolvePovKnowledgeContext, type PovContextWarning } from "./pov-context.js";

export interface ChapterProposal {
  /** 新冻结提案路径必有；旧回执可缺。 */
  proposal_id?: string;
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
  /** 以下字段仅新安全入口必有；旧提案文件仍可读。 */
  base_content_hash?: string;
  context_hash?: string;
  context_budget_tokens?: number;
  context_total_tokens?: number;
  source_manifest?: AuditableSourceRef[];
  omitted_source_ids?: string[];
  warnings?: WritingContextWarning[];
  /** 作者本次明确填写的章目标；冻结进 P0，不自动成为正史。 */
  author_intent?: string;
}

export interface FrozenChapterProposal extends ChapterProposal {
  proposal_id: string;
}

export interface FrozenProposalRecord extends ProposalRecord {
  proposals: FrozenChapterProposal[];
  base_content_hash: string;
  context_hash: string;
  context_budget_tokens: number;
  context_total_tokens: number;
  source_manifest: AuditableSourceRef[];
  omitted_source_ids: string[];
  warnings: WritingContextWarning[];
}

export type WritingContextWarning =
  | AuditableContextWarning
  | PovContextWarning
  | { code: "rag_index_missing" | "rag_no_match" | "future_chapter_excluded"; message: string }
  | { code: "rag_source_missing" | "rag_source_stale" | "rag_chunk_mismatch"; source_id: string; message: string };

export type AuditableProposalContext = Omit<ReturnType<typeof compileAuditableContext>, "warnings"> & {
  readonly base_content_hash: string;
  readonly warnings: WritingContextWarning[];
  readonly p4_ranking: "bm25";
};

export interface FrozenProposeResult extends ProposeResult {
  proposal?: FrozenProposalRecord;
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
 * M12-c/N45: 上下文编译器接线 —— propose/generate 的输入经 @novelcraft/context
 * 的 Tier P0-P4 预算淘汰(超预算先截 P4 再逐层驱逐), 消费「context compiler 仍是
 * core-only 无消费者」的缺口(台账 §6.12)。各段按语义归层: 任务指令 P0、焦点章结尾
 * P1、总纲/剧情线/篇章纲 P2、伏笔 P3。budget 缺省 CONTEXT_BUDGET_DEFAULT(4000)。
 */
export function compileProposalContextBudgeted(
  root: string,
  chapterIndex: number,
  opts?: { budget_tokens?: number },
): string {
  const outline = readOutline(root);
  const map = storyMap(root);
  const sections: Array<{ tier: "P0" | "P1" | "P2" | "P3" | "P4"; name: string; content: string }> = [
    { tier: "P0", name: "任务", content: `为第 ${chapterIndex + 1} 章生成 2-3 个续写方向提案。` },
  ];
  if (outline && typeof outline.outline_markdown === "string" && outline.outline_markdown.trim()) {
    sections.push({ tier: "P2", name: "总纲", content: outline.outline_markdown.trim().slice(0, 4000) });
  }
  if (map.threads.length) sections.push({ tier: "P2", name: "剧情线", content: assetLines(map.threads) });
  if (map.arcs.length) sections.push({ tier: "P2", name: "篇章纲", content: assetLines(map.arcs) });
  if (map.foreshadowing.length) sections.push({ tier: "P3", name: "已种伏笔", content: assetLines(map.foreshadowing) });
  try {
    const { body } = chapterBody(root, chapterIndex);
    const tail = body.trim().slice(-1500);
    if (tail) sections.push({ tier: "P1", name: `第 ${chapterIndex} 章结尾`, content: tail });
  } catch {
    // 该章不存在则跳过(仍可基于总纲/结构提案)
  }
  const compiled = compileContext(
    { task: `第 ${chapterIndex + 1} 章续写提案`, scope: "chapter", ...(opts?.budget_tokens !== undefined ? { budget_tokens: opts.budget_tokens } : {}) },
    { sections },
  );
  // M12-c review P0 修复: 正文 = 渲染存活 sections(预算淘汰后的实际内容),
  // contextSummary 只是尾部预算附注(作者语言成本预告, 不能充当 LLM 输入)。
  const body = compiled.sections.map((sec) => `【${sec.name}】\n${sec.content}`).join("\n\n");
  return `${body}\n\n[${contextSummary(compiled)}]`;
}

function proposalTask(
  chapterIndex: number,
  selected?: Pick<ChapterProposal, "title" | "premise">,
  authorIntent?: string,
): string {
  const intent = authorIntent?.trim();
  if (intent && intent.length > 1_000) throw new StoreError("VALIDATION_FAILED", "本章写作意图不得超过 1000 字");
  return selected === undefined
    ? `为第 ${chapterIndex + 1} 章生成 2-3 个续写方向提案。${intent ? `\n作者本章意图：${intent}` : ""}`
    : `按冻结方向“${selected.title}”：${selected.premise}，生成第 ${chapterIndex + 1} 章正文候选。`;
}

function storySource(
  tier: "P2" | "P3",
  kind: "thread" | "arc" | "foreshadowing",
  item: { slug: string; name: string; status: string; summary?: string },
): Parameters<typeof compileAuditableContext>[1]["sources"][number] {
  const dir = kind === "thread" ? "threads" : kind === "arc" ? "arcs" : "foreshadowing";
  return {
    tier,
    name: item.name,
    content: `${item.name}${item.summary ? `\n${item.summary}` : ""}`,
    source_id: `${kind}:${item.slug}`,
    source_type: kind,
    source_status: item.status,
    open_target: { kind: "file", path: `structure/${dir}/${item.slug}.md` },
  };
}

function p4ChapterSources(
  root: string,
  chapterIndex: number,
  query: string,
  warnings: WritingContextWarning[],
): Parameters<typeof compileAuditableContext>[1]["sources"] {
  let chunks: RagChunk[] | undefined;
  try {
    chunks = readRagIndex(root)?.chunks;
  } catch {
    chunks = undefined;
  }
  if (!Array.isArray(chunks)) {
    warnings.push({ code: "rag_index_missing", message: "RAG 索引缺失或不可读，P4 按空集确定性降级" });
    return [];
  }
  const futureCount = chunks.filter((chunk) =>
    chunk?.source_type === "chapter_text" && typeof chunk.chapter_index === "number" && chunk.chapter_index > chapterIndex
  ).length;
  if (futureCount > 0) {
    warnings.push({ code: "future_chapter_excluded", message: `已排除 ${futureCount} 条未来章节索引片段` });
  }
  const eligible = chunks.filter((chunk) =>
    chunk?.source_type === "chapter_text" &&
    typeof chunk.chunk_id === "string" &&
    typeof chunk.text === "string" &&
    Number.isSafeInteger(chunk.chapter_index) &&
    chunk.chapter_index! >= 1 &&
    chunk.chapter_index! <= chapterIndex
  );
  const ranked = rankChunksBm25(eligible, query, 8);
  if (ranked.length === 0) {
    warnings.push({ code: "rag_no_match", message: "BM25 未命中可用历史章节片段，P4 按空集继续" });
    return [];
  }
  const chapterCache = new Map<number, { body: string; hash: string } | undefined>();
  const seen = new Set<string>();
  const sources: Parameters<typeof compileAuditableContext>[1]["sources"] = [];
  for (const chunk of ranked) {
    const sourceId = `rag:${chunk.chunk_id}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const chapter = chunk.chapter_index!;
    if (!chapterCache.has(chapter)) {
      try {
        const { body } = chapterBody(root, chapter);
        chapterCache.set(chapter, { body, hash: contentHashOf(body) });
      } catch {
        chapterCache.set(chapter, undefined);
      }
    }
    const current = chapterCache.get(chapter);
    if (current === undefined || typeof chunk.source_content_hash !== "string") {
      warnings.push({ code: "rag_source_missing", source_id: sourceId, message: `P4 来源无法按第 ${chapter} 章复核，已排除` });
      continue;
    }
    if (current.hash !== chunk.source_content_hash) {
      warnings.push({ code: "rag_source_stale", source_id: sourceId, message: `P4 来源第 ${chapter} 章 hash 已过期，已排除` });
      continue;
    }
    if (!current.body.includes(chunk.text)) {
      warnings.push({ code: "rag_chunk_mismatch", source_id: sourceId, message: `P4 片段不属于当前第 ${chapter} 章正文，已排除` });
      continue;
    }
    sources.push({
      tier: "P4",
      name: `历史章节片段 ${chunk.chunk_id}`,
      content: chunk.text,
      source_id: sourceId,
      source_type: "chapter_text",
      source_status: "verified",
      open_target: {
        kind: "file",
        path: `chapters/${String(chapter).padStart(3, "0")}.md`,
        chapter_index: chapter,
        chunk_id: chunk.chunk_id,
        source_content_hash: chunk.source_content_hash,
      },
    });
  }
  return sources;
}

/** 同步纯构建供采用前复核；公开调用使用下方 async 包装。 */
export function buildAuditableProposalContext(
  root: string,
  chapterIndex: number,
  opts: { selected?: Pick<ChapterProposal, "title" | "premise">; budget_tokens?: number; author_intent?: string } = {},
): AuditableProposalContext {
  const { body } = chapterBody(root, chapterIndex);
  const baseHash = contentHashOf(body);
  const task = proposalTask(chapterIndex, opts.selected, opts.author_intent);
  const tail = body.trim().slice(-1500);
  const warnings: WritingContextWarning[] = [];
  const pov = resolvePovKnowledgeContext(root, chapterIndex + 1);
  warnings.push(...pov.warnings);
  const sources: Parameters<typeof compileAuditableContext>[1]["sources"] = [{
    tier: "P0",
    name: opts.selected === undefined ? "续写提案任务" : "冻结续写方向",
    content: task,
    source_id: opts.selected === undefined ? `writing-task:${chapterIndex}:propose` : `writing-task:${chapterIndex}:generate`,
    source_type: "writing_task",
    source_status: "instruction",
    open_target: { kind: "chapter", chapter_index: chapterIndex + 1 },
  }];
  if (tail) {
    sources.push({
      tier: "P1",
      name: `第 ${chapterIndex} 章结尾`,
      content: tail,
      source_id: `chapter-tail:${chapterIndex}`,
      source_type: "chapter_tail",
      source_status: "current",
      open_target: { kind: "file", path: `chapters/${String(chapterIndex).padStart(3, "0")}.md`, chapter_index: chapterIndex, source_content_hash: baseHash },
    });
  }
  const outline = readOutline(root);
  if (outline && typeof outline.outline_markdown === "string" && outline.outline_markdown.trim()) {
    sources.push({
      tier: "P2",
      name: "总纲",
      content: outline.outline_markdown.trim(),
      source_id: "outline:main",
      source_type: "outline",
      source_status: String(outline.status ?? "unknown"),
      open_target: { kind: "file", path: "structure/outline.md" },
    });
  }
  const map = storyMap(root);
  sources.push(...map.threads.map((item) => storySource("P2", "thread", item)));
  sources.push(...map.arcs.map((item) => storySource("P2", "arc", item)));
  sources.push(...map.foreshadowing.map((item) => storySource("P3", "foreshadowing", item)));
  if (pov.source) sources.push(pov.source);
  sources.push(...p4ChapterSources(root, chapterIndex, `${task}\n${tail}`, warnings));
  const compiled = compileAuditableContext(
    {
      task,
      scope: "chapter",
      ...(opts.budget_tokens !== undefined ? { budget_tokens: opts.budget_tokens } : {}),
    },
    { sources },
  );
  if (pov.source) {
    const retained = compiled.source_manifest.find((source) => source.source_id === pov.source!.source_id);
    if (!retained || retained.truncated) {
      throw new StoreError("VALIDATION_FAILED", `第 ${chapterIndex + 1} 章 POV/知识边界无法完整进入生成上下文`);
    }
  }
  return {
    ...compiled,
    base_content_hash: baseHash,
    warnings: [...warnings, ...compiled.warnings],
    p4_ranking: "bm25",
  };
}

/** DSH 安全入口使用 async 形态；首版内部只执行同步 BM25，不启用向量。 */
export async function compileProposalContextAuditable(
  root: string,
  chapterIndex: number,
  opts: { selected?: Pick<ChapterProposal, "title" | "premise">; budget_tokens?: number; author_intent?: string } = {},
): Promise<AuditableProposalContext> {
  return buildAuditableProposalContext(root, chapterIndex, opts);
}

export function proposalIdOf(
  runId: string,
  chapterIndex: number,
  baseContentHash: string,
  contextHash: string,
  index: number,
  proposal: ChapterProposal,
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    run_id: runId,
    chapter_index: chapterIndex,
    base_content_hash: baseContentHash,
    context_hash: contextHash,
    index,
    title: proposal.title,
    premise: proposal.premise,
    basis: proposal.basis ?? [],
    cost: proposal.cost ?? null,
    risk: proposal.risk ?? null,
  })).digest("hex");
  return `proposal_${digest.slice(0, 20)}`;
}

function proposalFile(root: string, chapterIndex: number, runId: string): string {
  return guardPath(root, paths(root).assistant.proposalFile(`next-${String(chapterIndex).padStart(3, "0")}-${runId}`));
}

function proposalRunId(now: Date, chapterIndex: number): string {
  const time = now.getTime();
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(chapterIndex) || chapterIndex < 1) {
    throw new StoreError("VALIDATION_FAILED", "提案时间/章节序号非法");
  }
  return `p${time}${String(chapterIndex).padStart(6, "0")}`;
}

function assertProposalSlotAvailable(root: string, chapterIndex: number, runId: string): string {
  const dir = guardPath(root, paths(root).assistant.proposals);
  assertNoSymlinkOnPath(root, dir);
  const file = proposalFile(root, chapterIndex, runId);
  assertNoSymlinkOnPath(root, file);
  if (existsSync(file)) throw new StoreError("CONFLICT", `提案 run_id 已存在，拒绝覆盖: ${runId}`);
  return file;
}

function writeProposalRecord(root: string, file: string, record: ProposalRecord): void {
  const dir = guardPath(root, paths(root).assistant.proposals);
  assertNoSymlinkOnPath(root, dir);
  mkdirSync(dir, { recursive: true });
  assertNoSymlinkOnPath(root, file);
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StoreError("CONFLICT", `提案 run_id 在 provider 调用期间被占用，旧回执保持不变: ${record.run_id}`);
    }
    throw err;
  }
}

function assertFrozenRecord(record: ProposalRecord): asserts record is FrozenProposalRecord {
  if (!/^p\d+$/.test(record.run_id) || !Number.isSafeInteger(record.chapter_index) || record.chapter_index < 1 ||
      record.next_chapter !== record.chapter_index + 1 || !Number.isFinite(Date.parse(record.generated_at)) ||
      !Array.isArray(record.proposals) || record.proposals.length === 0 || !/^[0-9a-f]{64}$/.test(record.base_content_hash ?? "") || !/^[0-9a-f]{64}$/.test(record.context_hash ?? "") ||
      (record.author_intent !== undefined && (typeof record.author_intent !== "string" || record.author_intent.length > 1_000)) ||
      !Array.isArray(record.source_manifest) || !Array.isArray(record.omitted_source_ids) || !Array.isArray(record.warnings) ||
      !Number.isSafeInteger(record.context_budget_tokens) || record.context_budget_tokens! <= 0 ||
      !Number.isSafeInteger(record.context_total_tokens) || record.context_total_tokens! < 0 ||
      record.context_total_tokens! > record.context_budget_tokens!) {
    throw new StoreError("BAD_CANDIDATE", `提案回执 ${record.run_id} 缺少冻结上下文；请重新生成提案`);
  }
  record.proposals.forEach((proposal, index) => {
    if (typeof proposal.title !== "string" || typeof proposal.premise !== "string" ||
        (proposal.basis !== undefined && (!Array.isArray(proposal.basis) || proposal.basis.some((item) => typeof item !== "string"))) ||
        (proposal.cost !== undefined && typeof proposal.cost !== "string") ||
        (proposal.risk !== undefined && typeof proposal.risk !== "string")) {
      throw new StoreError("BAD_CANDIDATE", `提案回执 ${record.run_id} 的方向字段非法`);
    }
    const expected = proposalIdOf(record.run_id, record.chapter_index, record.base_content_hash!, record.context_hash!, index, proposal);
    if (proposal.proposal_id !== expected) {
      throw new StoreError("BAD_CANDIDATE", `提案回执 ${record.run_id} 的 proposal_id 校验失败`);
    }
  });
}

export function proposalRecordByRunId(root: string, runId: string): FrozenProposalRecord {
  if (!/^p\d+$/.test(runId)) throw new StoreError("NOT_FOUND", `提案 run_id 非法: ${runId}`);
  const dir = guardPath(root, paths(root).assistant.proposals);
  if (!existsSync(dir)) throw new StoreError("NOT_FOUND", `提案 run_id 不存在: ${runId}`);
  assertNoSymlinkOnPath(root, dir);
  const matches: ProposalRecord[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(`${dir}/${entry.name}`, "utf8")) as ProposalRecord;
      if (record.run_id === runId) matches.push(record);
    } catch {
      // 坏的无关提案文件不参与本 run 查找。
    }
  }
  if (matches.length !== 1) throw new StoreError(matches.length === 0 ? "NOT_FOUND" : "CONFLICT", `提案 run_id ${runId} 命中 ${matches.length} 条回执`);
  assertFrozenRecord(matches[0]);
  return matches[0];
}

export function frozenProposalById(record: FrozenProposalRecord, proposalId: string): FrozenChapterProposal {
  const proposal = record.proposals.find((item) => item.proposal_id === proposalId);
  if (proposal === undefined) throw new StoreError("NOT_FOUND", `proposal_id 不属于 run ${record.run_id}: ${proposalId}`);
  return proposal;
}

export function assertFrozenProposalCurrent(root: string, record: FrozenProposalRecord): AuditableProposalContext {
  const current = buildAuditableProposalContext(root, record.chapter_index, { author_intent: record.author_intent });
  if (!sameProposalContext(current, record)) {
    throw new StoreError("CONFLICT", `提案 ${record.run_id} 的正文或上下文来源已变化；请重新生成提案`);
  }
  return current;
}

function sameProposalContext(
  current: AuditableProposalContext,
  frozen: Pick<FrozenProposalRecord,
    "base_content_hash" | "context_hash" | "context_budget_tokens" | "context_total_tokens" |
    "source_manifest" | "omitted_source_ids" | "warnings">,
): boolean {
  return current.base_content_hash === frozen.base_content_hash && current.context_hash === frozen.context_hash &&
    current.budget_tokens === frozen.context_budget_tokens && current.total_tokens === frozen.context_total_tokens &&
    JSON.stringify(current.source_manifest) === JSON.stringify(frozen.source_manifest) &&
    JSON.stringify(current.omitted_source_ids) === JSON.stringify(frozen.omitted_source_ids) &&
    JSON.stringify(current.warnings) === JSON.stringify(frozen.warnings);
}

function proposalSetError(proposals: readonly ChapterProposal[]): string | null {
  if (proposals.length < 2) return "提案不足 2 条";
  if (proposals.some((proposal) => !proposal.title.trim() || !proposal.premise.trim())) return "提案标题与前提不能为空";
  const identities = proposals.map((proposal) => `${proposal.title.trim()}\u0000${proposal.premise.trim()}`);
  return new Set(identities).size === identities.length ? null : "提案方向重复";
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
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new StoreError("VALIDATION_FAILED", "提案时间非法");
  const runId = `p${timestamp}`; // legacy 字节/身份格式保持不变；安全入口另带 chapter 防跨章碰撞。
  const file = assertProposalSlotAvailable(root, chapterIndex, runId);
  // M12-c/N45: 输入经 Tier 预算编译(超预算逐层淘汰), 旧拼接版保留为导出兼容。
  const input = compileProposalContextBudgeted(root, chapterIndex);
  const r = await runStep(provider, { specRef: "next_chapter_proposal", input });
  if (!r.ok) return { ok: false, error: r.error };

  const parsed = r.result as { proposals?: ChapterProposal[] };
  const proposals = (Array.isArray(parsed.proposals) ? parsed.proposals : []).slice(0, 3);
  const proposalError = proposalSetError(proposals);
  if (proposalError) return { ok: false, error: { kind: "schema_violation", message: proposalError } };

  const record: ProposalRecord = {
    run_id: runId,
    chapter_index: chapterIndex,
    next_chapter: chapterIndex + 1,
    generated_at: now.toISOString(),
    proposals,
  };
  writeProposalRecord(root, file, record);
  return { ok: true, proposal: record };
}

/**
 * DSH 生产入口：BM25 P4 + actual-input manifest + 冻结基线。provider 返回后再次
 * 构建同一上下文，漂移时不写提案回执。
 */
export async function proposeNextChapterAuditable(
  provider: Provider,
  root: string,
  chapterIndex: number,
  now: Date = new Date(),
  authorIntent?: string,
): Promise<FrozenProposeResult> {
  const runId = proposalRunId(now, chapterIndex);
  const file = assertProposalSlotAvailable(root, chapterIndex, runId);
  const normalizedIntent = authorIntent?.trim() || undefined;
  const context = await compileProposalContextAuditable(root, chapterIndex, { author_intent: normalizedIntent });
  const r = await runStep(provider, { specRef: "next_chapter_proposal", input: context.rendered_text });
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = r.result as { proposals?: ChapterProposal[] };
  const rawProposals = (Array.isArray(parsed.proposals) ? parsed.proposals : []).slice(0, 3);
  const proposalError = proposalSetError(rawProposals);
  if (proposalError) return { ok: false, error: { kind: "schema_violation", message: proposalError } };
  const current = buildAuditableProposalContext(root, chapterIndex, { author_intent: normalizedIntent });
  if (!sameProposalContext(current, {
    base_content_hash: context.base_content_hash,
    context_hash: context.context_hash,
    context_budget_tokens: context.budget_tokens,
    context_total_tokens: context.total_tokens,
    source_manifest: context.source_manifest,
    omitted_source_ids: context.omitted_source_ids,
    warnings: context.warnings,
  })) {
    throw new StoreError("CONFLICT", `第 ${chapterIndex} 章或提案上下文在生成期间变化，结果未落盘`);
  }
  const proposals: FrozenChapterProposal[] = rawProposals.map((proposal, index) => ({
    ...proposal,
    proposal_id: proposalIdOf(runId, chapterIndex, context.base_content_hash, context.context_hash, index, proposal),
  }));
  const record: FrozenProposalRecord = {
    run_id: runId,
    chapter_index: chapterIndex,
    next_chapter: chapterIndex + 1,
    generated_at: now.toISOString(),
    proposals,
    base_content_hash: context.base_content_hash,
    context_hash: context.context_hash,
    context_budget_tokens: context.budget_tokens,
    context_total_tokens: context.total_tokens,
    source_manifest: context.source_manifest,
    omitted_source_ids: context.omitted_source_ids,
    warnings: context.warnings,
    ...(normalizedIntent ? { author_intent: normalizedIntent } : {}),
  };
  writeProposalRecord(root, file, record);
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
