// N33 / ADR-0022 — deep-import 六阶段 durable driver(runWorkflow + GitRunPersistence 生产面)。
//
// 本文件是 legacy orchestrate.ts(runDeepImport)的明确 durable driver(加法, 不重写
// 六阶段阶段函数): 以 run-engine 的通用生产引擎(runWorkflow)+ 生产持久化适配器
// (GitRunPersistence)为执行面, 把六阶段映射为确定性批次, 保持既有
// DeepImportResult / trace 事件词表 / 审批语义:
// - 启动前先 recover 全 vault durable intents(ADR-0022 §4: intent 先于 manifest);
// - 同 scope + 同执行画像 → 恒同 workflowId/batchId/planDigest(确定性);
//   resume 走严格 manifest/profile/contract 兼容(输入变化不得续跑, force 才新 run);
// - artifact → receipt → cursor 顺序由 run-engine 保证(窗口〇/一/二 fail-closed);
// - provider_outcome_unknown 不自动重试: 必须经 runtime.reauthorizeRemaining
//   (DSH 挂 ApprovalGate 范围/成本授权)allowed-once 后才重试该批(ADR-0022 §5.0/§8);
// - ExecutionProfile fingerprint + contract versions 强制: profileFingerprint 缺失即
//   拒绝启动(fail-closed); contractVersions 折叠进 inputFingerprint(变化 → 新
//   workflowId, 不沿用旧 run);
// - adopt(commit_scenes / alias_relation)全部走 RunApplyPort: 独立审批
//   (decision 不落盘)+ ADR-0021 canonical 事务 + txid 探针(commit 后不重复审批/写入,
//   未 commit 退回重新审批);
// - generator 纯生成(零 canonical 写): Scene 采用写集/实体候选/结构 draft 全部在
//   内存计划(planSceneCommit / planEntityBatch / planStructureAnalysis), 落盘只经
//   canonical 事务(adopt 由 RunApplyPort, 候选/draft 由 driver 事务化 materialize);
// - 每批持久化调用 = 一个 state transaction(GitRunPersistence 内部 enforce)。
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { paths } from "@novelcraft/vault";
import {
  executeTransaction,
  parseFrontmatter,
  probeTxCommitForTargets,
  recoverInterruptedTransactions,
  sha256Hex,
  type TargetSpec,
  type TransactionOptions,
} from "@novelcraft/store";
import type { ApprovalDecision, DeepImportPolicy, TraceEventInput, TraceSink } from "@novelcraft/trace";
import { DEGRADATION_CLAUSE, TraceRecorder, loadPolicyDefaults } from "@novelcraft/trace";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import type { AliasRelationPlan, AliasRelationProposal } from "./alias-relation.js";
import { planAliasRelationChanges, proposeAliasRelations } from "./alias-relation.js";
import { planSceneCommit, type SceneCommitFile } from "./commit.js";
import { planEntityBatch, type EntityPlannedFile } from "./entities.js";
import { planStructureAnalysis, type StructurePlannedFile } from "./structure.js";
import { enrichSceneBatch, fuseSceneBatch, sliceChapterBatch, type FusionDecision, type SceneCandidate } from "./stages.js";
import type { DeepImportResult, DeepImportRuntime } from "./orchestrate.js";
import type { CheckpointState, ImportPlan } from "./plan.js";
import {
  applyIdFor,
  ApplyCanonicalError,
  RunEngineError,
  planDigestOf,
  runWorkflow,
  type ApplyApprovalRequest,
  type ApplyCanonicalRequest,
  type ApplyProbe,
  type RunApplyPort,
  type RunBatchSpec,
  type RunEnginePorts,
  type RunEngineResult,
  type RunEngineSpec,
  type RunGeneratorInput,
  type RunGeneratorOutput,
  type RunGeneratorPort,
} from "./run-engine.js";
import {
  batchPaths,
  canonicalRunJson,
  createWorkflowIdentity,
  makeBatchPlan,
  workflowSha256,
  type BatchPlan,
  type WorkflowKind,
} from "./run-model.js";
import { GitRunPersistence } from "./git-run-persistence.js";

// —— 常量 ——

/** driver 固定 batch 布局(与 legacy 六阶段一一对应; ordinal 确定)。 */
const PHASE_ORDINALS: ReadonlyArray<{ phase: string; ordinal: number; apply?: boolean }> = Object.freeze([
  { phase: "1a", ordinal: 0 },
  { phase: "1b", ordinal: 1 },
  { phase: "1c", ordinal: 2 },
  { phase: "commit", ordinal: 3, apply: true },
  { phase: "2a", ordinal: 4 },
  { phase: "2b", ordinal: 5, apply: true },
  { phase: "3", ordinal: 6 },
]);

/** 派生输入阶段用确定性占位 hash(真实来源 = 前置阶段 artifact)。 */
function phaseInputHash(phase: string): string {
  return workflowSha256(`deep-import:phase-input:${phase}`);
}

/** commit/2b apply 目标在 spec 时点的确定性 expectedHash 锚(审批时不得刷新, ADR-0022 §6)。 */
function applyExpectedHash(phase: string): string {
  return workflowSha256(`deep-import:apply-expected:${phase}`);
}

/** 引擎域 transactionId(`tx-`+40hex)→ store 域 canonical txid(`tx-`+64hex); 确定性。 */
export function applyStoreTxid(engineTransactionId: string): string {
  return `tx-${workflowSha256(`deep-import-apply:${engineTransactionId}`)}`;
}

/** commit/2b 的 canonical 目标路径(审批摘要/绑定锚; 实际写集来自 artifact plan)。 */
const COMMIT_APPLY_TARGET = "scenes";
const ALIAS_APPLY_TARGET = "world/objects";

// —— 公共类型 ——

/** 生产入口失败(provider outcome unknown 未重新授权 / apply probe unknown fail-closed)。 */
export class DeepImportWorkflowError extends Error {
  constructor(
    readonly status: "provider_outcome_unknown" | "apply_probe_unknown",
    readonly workflowId: string,
    readonly remainingBatchIds: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "DeepImportWorkflowError";
  }
}

export interface DeepImportWorkflowRuntime extends DeepImportRuntime {
  /**
   * provider_outcome_unknown 批重试前的重新授权(ADR-0022 §5.0/§8, 加法): 调用方
   * (DSH)经 ApprovalGate 请求剩余批次的范围/成本授权 —— 不是裸 boolean 自动重试;
   * 缺省/非 allowed-once = 写状态后停止, 绝不自动重调 provider。
   */
  reauthorizeRemaining?: (info: {
    workflowId: string;
    batches: ReadonlyArray<{ batchId: string; phase: string }>;
    estimate: string;
  }) => Promise<ApprovalDecision>;
  /** 透传给 store executeTransaction / GitRunPersistence 的选项(测试注入崩溃门控; 生产缺省)。 */
  transactionOptions?: TransactionOptions;
}

/**
 * 测试注入 seam(MockProvider/MockApproval 同精神): spy 可替换 runWorkflow /
 * GitRunPersistence, 证明生产入口消费通用引擎与 Git 持久化适配器(不 frozen,
 * 允许 vi.spyOn 替换属性)。
 */
export const deepImportEngineSeam: {
  runWorkflow: typeof runWorkflow;
  GitRunPersistence: typeof GitRunPersistence;
} = { runWorkflow, GitRunPersistence };

// —— 工具 ——

function emit(sink: TraceSink, event: TraceEventInput): void {
  sink.record(event);
}

/** Preserve the legacy llm_step trace contract around every provider attempt. */
function tracedProvider(provider: Provider, sink: TraceSink): Provider {
  return {
    ...(provider.executionDefaults !== undefined ? { executionDefaults: provider.executionDefaults } : {}),
    ...(provider.workflowBudget !== undefined ? { workflowBudget: provider.workflowBudget } : {}),
    async complete(req) {
      try {
        const response = await provider.complete(req);
        emit(sink, {
          type: "llm_step",
          ok: true,
          model: req.model,
          ...(req.promptHash !== undefined ? { promptHash: req.promptHash } : {}),
          ...(req.schemaInjection !== undefined ? { schemaInjection: req.schemaInjection } : {}),
        });
        return response;
      } catch (error) {
        emit(sink, {
          type: "llm_step",
          ok: false,
          model: req.model,
          error: String((error as Error)?.message ?? error),
          ...(req.promptHash !== undefined ? { promptHash: req.promptHash } : {}),
          ...(req.schemaInjection !== undefined ? { schemaInjection: req.schemaInjection } : {}),
        });
        throw error;
      }
    },
  };
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes as unknown as Uint8Array).toString("utf8");
}

function readFileIfExists(abs: string): Uint8Array | undefined {
  try {
    return readFileSync(abs);
  } catch {
    return undefined;
  }
}

/**
 * 递归剔除 undefined 值(artifact 持久化面拒绝 undefined, N33/R1):
 * provider 输出经阶段函数保留的显式 undefined 字段(如 boundary_basis)在序列化前
 * 必须移除 —— 与 JSON.stringify 语义一致, 不改变语义。
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

/** 生成器输出定型: payload 经 stripUndefined 后才可序列化进 artifact。 */
function payloadOf<T>(payload: T): T {
  return stripUndefined(payload) as T;
}

/** 章节输入 hash: 范围内章节正文拼接的 sha256(缺失章按空串; 内容变化 → 新 workflowId)。 */
function chapterSourceHash(root: string, plan: ImportPlan): string {
  let acc = "";
  for (const ch of range(plan.start_chapter, plan.end_chapter)) {
    const file = paths(root).chapters.chapterFile(ch);
    const bytes = readFileIfExists(file);
    const raw = bytes === undefined ? "" : bytesToUtf8(bytes).replace(/^---\n[\s\S]*?\n---\n/, "");
    acc += `${ch}:${raw}\n`;
  }
  return workflowSha256(acc);
}

/**
 * 确定性 inputFingerprint(N33: 指纹覆盖源内容/policy/非 secret 执行画像/契约版本):
 * legacy 口径 sha256({scope, steps}) 之上折叠 contractVersions(变化 → 新 workflow,
 * 不沿用旧 run —— 输入变化不得续跑)。
 */
export function deepImportInputFingerprint(
  root: string,
  plan: ImportPlan,
  policy: DeepImportPolicy,
  contractVersions?: Record<string, string>,
): string {
  const payload: Record<string, unknown> = {
    scope: plan.authorization.scope,
    steps: plan.steps,
    chapter_content_hash: chapterSourceHash(root, plan),
    policy,
  };
  if (contractVersions !== undefined && Object.keys(contractVersions).length > 0) {
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(contractVersions).sort()) sorted[k] = String(contractVersions[k]);
    payload.contract_versions = sorted;
  }
  return workflowSha256(canonicalRunJson(payload));
}

/** 确定性 batch 布局(七批, ordinal/phase 固定; 2a/2b/3 的 sourceIds 为派生占位)。 */
export function buildDeepImportWorkflowSpec(
  root: string,
  plan: ImportPlan,
  options: { inputFingerprint: string; profileFingerprint: string },
): RunEngineSpec {
  const batches: RunBatchSpec[] = PHASE_ORDINALS.map(({ phase, ordinal, apply }) => {
    const sourceIds: string[] = [];
    const sourceHashes: Record<string, string> = {};
    if (phase === "1a") {
      sourceIds.push("chapters");
      sourceHashes.chapters = chapterSourceHash(root, plan);
    } else if (phase === "1b") {
      sourceIds.push("1a");
      sourceHashes["1a"] = phaseInputHash("1b");
    } else if (phase === "1c") {
      sourceIds.push("1b");
      sourceHashes["1b"] = phaseInputHash("1c");
    } else {
      sourceIds.push("commit");
      sourceHashes.commit = phaseInputHash(phase);
    }
    const base: RunBatchSpec = { phase, ordinal, sourceIds, sourceHashes };
    if (apply) {
      return {
        ...base,
        apply: {
          target: phase === "commit" ? COMMIT_APPLY_TARGET : ALIAS_APPLY_TARGET,
          expectedHash: applyExpectedHash(phase),
          ...(phase === "2b" ? { onApprovalUnavailable: "skipped" as const } : {}),
        },
      };
    }
    return base;
  });
  return {
    kind: "deep-import",
    inputFingerprint: options.inputFingerprint,
    profileFingerprint: options.profileFingerprint,
    uniqueRunId: plan.workflow_id,
    batches,
  };
}

// —— artifact payload 形态(与各批 generator/apply 对应) ——

interface Phase1aPayload {
  candidates: SceneCandidate[];
}
interface Phase1bPayload {
  items: SceneCandidate[];
}
interface Phase1cPayload {
  decisions: FusionDecision[];
}
interface CommitPayload {
  candidateIds: string[];
  files: readonly SceneCommitFile[];
  created: string[];
  skipped: string[];
  conflicts: string[];
  fallbacks: number;
}
interface Phase2aPayload {
  files: readonly EntityPlannedFile[];
  created: string[];
  reused: Array<{ name: string; target: string }>;
  uncertain: number;
}
interface Phase2bPayload {
  proposals: AliasRelationProposal[];
  plan: Pick<
    AliasRelationPlan,
    "files" | "aliases_attached" | "relations_written" | "touched" | "targets" | "empty" | "summary" | "items"
  >;
  skipped_aliases: number;
  uncertain: number;
  /** 无已提交 Scene → 2b 写面未运行(legacy status=skipped, 非 no_changes)。 */
  skipped_no_scenes: boolean;
}
interface Phase3Payload {
  files: readonly StructurePlannedFile[];
  result: {
    threads: string[];
    arcs: string[];
    foreshadowing: string[];
    reveals: string[];
    low_confidence: number;
    skipped?: string[];
  };
}

// —— driver 上下文 ——

interface DriverContext {
  root: string;
  plan: ImportPlan;
  policy: DeepImportPolicy;
  provider: Provider;
  budget?: WorkflowBudget;
  sink: TraceSink;
  traceRecorder: TraceRecorder;
  /** 调用方传入的外部 trace sink(无则 undefined); DeepImportResult.trace 按 legacy
   *  契约「runtime.trace ?? 新建 TraceRecorder」原样返回它, 而不是 fanout wrapper。 */
  runtimeTrace?: TraceSink;
  checkpointBaseline?: Uint8Array;
  traceBaseline?: Uint8Array;
  persistence: GitRunPersistence;
  transactionOptions: TransactionOptions;
  inputFingerprint: string;
  workflowId: string;
  kind: WorkflowKind;
  /** batchId → 确定性批次计划(与 run-engine buildRunPlan 同源)。 */
  batchPlans: Readonly<Record<string, BatchPlan>>;
  /** batchId → 确定性路径(plan/artifact/receipt)。 */
  paths: Readonly<Record<string, { planPath: string; artifactPath: string; receiptPath: string }>>;
  /** batchId → phase。 */
  phaseByBatch: Readonly<Record<string, string>>;
  /** phase → batchId。 */
  batchByPhase: Readonly<Record<string, string>>;
  approve: DeepImportRuntime["approve"];
}

function buildDriverContext(
  root: string,
  plan: ImportPlan,
  runtime: DeepImportWorkflowRuntime,
  spec: RunEngineSpec,
  inputFingerprint: string,
  workflowId: string,
): DriverContext {
  const policy = loadPolicyDefaults(runtime.policy);
  const traceRecorder = new TraceRecorder();
  // fanout sink: 事件同时进内部 traceRecorder(持久化: checkpoint 事务写
  // .assistant/import-trace.jsonl 用 ctx.traceRecorder.all())与外部 runtime.trace;
  // 但 DeepImportResult.trace 必须按 legacy 契约返回 runtime.trace 本身(见 aggregateRun)。
  const sink: TraceSink = runtime.trace === undefined
    ? traceRecorder
    : {
        record(event) {
          const recorded = traceRecorder.record(event);
          runtime.trace!.record(event);
          return recorded;
        },
      };
  const persistence = new deepImportEngineSeam.GitRunPersistence(root, {
    ...(runtime.transactionOptions !== undefined ? { transactionOptions: runtime.transactionOptions } : {}),
  });
  const batchPlans: Record<string, BatchPlan> = {};
  const pathsById: Record<string, { planPath: string; artifactPath: string; receiptPath: string }> = {};
  const phaseByBatch: Record<string, string> = {};
  const batchByPhase: Record<string, string> = {};
  for (const batch of spec.batches) {
    const bp = makeBatchPlan({
      workflowId,
      phase: batch.phase,
      ordinal: batch.ordinal,
      inputFingerprint: spec.inputFingerprint,
      sourceIds: batch.sourceIds,
      sourceHashes: batch.sourceHashes,
    });
    batchPlans[bp.batchId] = bp;
    pathsById[bp.batchId] = batchPaths(spec.kind, bp);
    phaseByBatch[bp.batchId] = batch.phase;
    batchByPhase[batch.phase] = bp.batchId;
  }
  return {
    root,
    plan,
    policy,
    provider: tracedProvider(runtime.provider, sink),
    budget: runtime.budget,
    sink,
    traceRecorder,
    runtimeTrace: runtime.trace,
    checkpointBaseline: readFileIfExists(paths(root).assistant.checkpoint),
    traceBaseline: readFileIfExists(path.join(paths(root).assistant.dir, 'import-trace.jsonl')),
    persistence,
    transactionOptions: runtime.transactionOptions ?? {},
    inputFingerprint,
    workflowId,
    kind: spec.kind,
    batchPlans,
    paths: pathsById,
    phaseByBatch,
    batchByPhase,
    approve: runtime.approve,
  };
}

/** 读已提交 artifact 的 payload(恢复时从 run 目录精确字节重建, 不依赖内存状态)。 */
async function readArtifactPayload<T>(ctx: DriverContext, batchId: string): Promise<T> {
  const bytes = await ctx.persistence.readBytes(ctx.paths[batchId].artifactPath);
  if (bytes === undefined) {
    throw new RunEngineError("missing", `批次 ${batchId} artifact 缺失, 无法消费前置阶段产物`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new RunEngineError("corruption", `批次 ${batchId} artifact 无法解析`);
  }
  if (doc === null || typeof doc !== "object" || !("payload" in doc)) {
    throw new RunEngineError("corruption", `批次 ${batchId} artifact 信封非法`);
  }
  return (doc as { payload: T }).payload;
}

/** commit 批次 apply 是否已落 rejected/skipped 终态(legacy 早退语义: 后续阶段空跑)。 */
async function commitApplyRejected(ctx: DriverContext): Promise<boolean> {
  const state = await ctx.persistence.loadRunState(ctx.workflowId);
  const record = state.manifest?.applies?.[applyIdFor(ctx.workflowId, ctx.batchByPhase.commit)];
  return record !== undefined && (record.state === "rejected" || record.state === "skipped");
}

/** 各批 generator: 纯生成(零 canonical 写); 前置阶段产物一律从已提交 artifact 读取。 */
function makeGenerator(ctx: DriverContext): RunGeneratorPort {
  return {
    budgetSpent: () => ctx.budget?.spent,
    async generate(input: RunGeneratorInput): Promise<RunGeneratorOutput> {
      const generated = await (async (): Promise<RunGeneratorOutput> => {
        const phase = input.phase;
        switch (phase) {
        case "1a": {
          const chapters = range(ctx.plan.start_chapter, ctx.plan.end_chapter);
          const candidates: SceneCandidate[] = [];
          for (const batch of chunk(chapters, ctx.policy.slicingBatchSize)) {
            const r = await sliceChapterBatch(ctx.provider, ctx.root, batch, { budget: ctx.budget });
            candidates.push(...r.items);
            emit(ctx.sink, {
              type: "stage_candidates",
              phase: "1a",
              batch_size: batch.length,
              count: r.items.length,
              candidate_ids: r.items.map((c) => c.candidate_id),
            });
            for (const ch of r.failed_chapters) {
              // R54: 1a 整章 fallback, 不部分采用
              emit(ctx.sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase1aFallback, phase: "1a", detail: `第 ${ch} 章整章 fallback` });
            }
          }
          return { payload: payloadOf({ candidates }) };
        }
        case "1b": {
          const { candidates } = await readArtifactPayload<Phase1aPayload>(ctx, ctx.batchByPhase["1a"]);
          const needsReviewBefore = new Map(candidates.map((s) => [s.candidate_id, s.needs_review]));
          const items = await enrichSceneBatch(ctx.provider, candidates, { budget: ctx.budget });
          emit(ctx.sink, {
            type: "stage_candidates",
            phase: "1b",
            batch_size: items.length,
            count: items.length,
            candidate_ids: items.map((c) => c.candidate_id),
          });
          for (const sc of items) {
            if (sc.needs_review && needsReviewBefore.get(sc.candidate_id) === false) {
              // R52: 1b 空语义进复核
              emit(ctx.sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase1bEmptySemantics, phase: "1b", detail: sc.review_reason });
            }
          }
          return { payload: payloadOf({ items }) };
        }
        case "1c": {
          const { items } = await readArtifactPayload<Phase1bPayload>(ctx, ctx.batchByPhase["1b"]);
          const pairs: Array<{ left: SceneCandidate; right: SceneCandidate }> = [];
          for (let i = 0; i + 1 < items.length; i++) pairs.push({ left: items[i], right: items[i + 1] });
          const decisions = await fuseSceneBatch(ctx.provider, pairs, { budget: ctx.budget });
          return { payload: payloadOf({ decisions }) };
        }
        case "commit": {
          const { items } = await readArtifactPayload<Phase1bPayload>(ctx, ctx.batchByPhase["1b"]);
          const plan = planSceneCommit(ctx.root, items, { workflowId: input.workflowId });
          return {
            payload: payloadOf({
              candidateIds: items.map((c) => c.candidate_id),
              files: plan.files,
              created: plan.created,
              skipped: plan.skipped,
              conflicts: plan.conflicts,
              fallbacks: plan.fallbacks,
            } satisfies CommitPayload),
          };
        }
        case "2a": {
          if (await commitApplyRejected(ctx)) {
            // legacy 早退语义: commit 被拒 → 2a/2b/3 不运行(零 provider 调用)
            return { payload: payloadOf({ files: [], created: [], reused: [], uncertain: 0 } satisfies Phase2aPayload) };
          }
          const { created } = await readArtifactPayload<CommitPayload>(ctx, ctx.batchByPhase.commit);
          const files: EntityPlannedFile[] = [];
          const createdOut: string[] = [];
          const reused: Array<{ name: string; target: string }> = [];
          let uncertain = 0;
          for (const batch of chunk(created, ctx.policy.phase2BatchSize)) {
            const r = await planEntityBatch(ctx.provider, ctx.root, batch, { workflowId: input.workflowId, budget: ctx.budget });
            files.push(...r.files);
            createdOut.push(...r.created);
            reused.push(...r.reused);
            uncertain += r.uncertain;
            emit(ctx.sink, {
              type: "stage_candidates",
              phase: "2a",
              batch_size: batch.length,
              count: r.created.length,
              candidate_ids: r.created,
            });
          }
          return { payload: payloadOf({ files, created: createdOut, reused, uncertain } satisfies Phase2aPayload) };
        }
        case "2b": {
          if (await commitApplyRejected(ctx)) {
            return {
              payload: payloadOf({
                proposals: [],
                plan: { files: [], aliases_attached: 0, relations_written: 0, touched: [], targets: [], empty: true, summary: "", items: [] },
                skipped_aliases: 0,
                uncertain: 0,
                skipped_no_scenes: false,
              } satisfies Phase2bPayload),
            };
          }
          const { created } = await readArtifactPayload<CommitPayload>(ctx, ctx.batchByPhase.commit);
          if (created.length === 0) {
            return {
              payload: payloadOf({
                proposals: [],
                plan: { files: [], aliases_attached: 0, relations_written: 0, touched: [], targets: [], empty: true, summary: "", items: [] },
                skipped_aliases: 0,
                uncertain: 0,
                skipped_no_scenes: true,
              } satisfies Phase2bPayload),
            };
          }
          const proposals: AliasRelationProposal[] = [];
          let skipped2b = 0;
          let uncertain2b = 0;
          for (const batch of chunk(created, ctx.policy.aliasConcurrency)) {
            const proposal = await proposeAliasRelations(ctx.provider, ctx.root, batch, { workflowId: input.workflowId, budget: ctx.budget });
            proposals.push(proposal);
            skipped2b += proposal.skipped_aliases;
            uncertain2b += proposal.uncertain;
            emit(ctx.sink, {
              type: "stage_candidates",
              phase: "2b",
              batch_size: batch.length,
              count: proposal.aliases.length + proposal.relations.length,
              candidate_ids: [],
            });
            if (proposal.uncertain > 0) {
              // R53: 2b 只降级不丢对象
              emit(ctx.sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase2bNoDrop, phase: "2b", detail: `${proposal.uncertain} 项进待复核` });
            }
          }
          // 只读 propose → 内存 plan(planAliasRelationChanges 零写; plan 快照进 artifact,
          // apply 时按快照 CAS, 不再重读)。
          const plan = planAliasRelationChanges(ctx.root, proposals);
          return {
            payload: payloadOf({
              proposals,
              plan: {
                files: plan.files,
                aliases_attached: plan.aliases_attached,
                relations_written: plan.relations_written,
                touched: plan.touched,
                targets: plan.targets,
                empty: plan.empty,
                summary: plan.summary,
                items: plan.items,
              },
              skipped_aliases: skipped2b,
              uncertain: uncertain2b,
              skipped_no_scenes: false,
            } satisfies Phase2bPayload),
          };
        }
        case "3": {
          if (await commitApplyRejected(ctx)) {
            return { payload: payloadOf({ files: [], result: { threads: [], arcs: [], foreshadowing: [], reveals: [], low_confidence: 0 } } satisfies Phase3Payload) };
          }
          const { files, result } = await planStructureAnalysis(ctx.provider, ctx.root, { workflowId: input.workflowId, budget: ctx.budget });
          return { payload: payloadOf({ files, result } satisfies Phase3Payload) };
        }
          default:
            throw new RunEngineError("invalid", `未知 phase: ${phase}`);
        }
      })();
      return {
        ...generated,
        ...(ctx.budget !== undefined ? { budgetSpent: ctx.budget.spent } : {}),
      };
    },
  };
}

// —— RunApplyPort: 独立审批 + ADR-0021 canonical 事务 + txid 探针 ——

async function applyWriteSet(ctx: DriverContext, batchId: string, validateTargets: boolean): Promise<TargetSpec[]> {
  const phase = ctx.phaseByBatch[batchId];
  if (phase === "commit") {
    const payload = await readArtifactPayload<CommitPayload>(ctx, batchId);
    return payload.files.map((f) => ({
      path: f.relativePath,
      expected: f.expected.absent ? { absent: true, sha256: "" } : { absent: false, sha256: f.expected.sha256 },
      output: f.bytes,
    }));
  }
  if (phase === "2b") {
    const payload = await readArtifactPayload<Phase2bPayload>(ctx, batchId);
    if (validateTargets) {
      for (const t of payload.plan.targets) {
        const file = paths(ctx.root).world.objectFile(t.slug);
        if (!existsSync(file) || !lstatSync(file).isFile()) {
          throw new ApplyCanonicalError(`2b 关系目标 ${t.slug} 在批准期间消失`, `2b 关系目标 ${t.slug} 在批准期间消失, 拒绝写入(fail-closed)`);
        }
        const { data: fm } = parseFrontmatter(readFileSync(file, "utf8"));
        if (String(fm.status ?? "") !== "canonical") {
          throw new ApplyCanonicalError(`2b 关系目标 ${t.slug} 移出 canonical`, `2b 关系目标 ${t.slug} 在批准期间移出 canonical, 拒绝写入(fail-closed)`);
        }
      }
    }
    return payload.plan.files.map((f) => ({
      path: f.relativePath,
      expected: { absent: false, sha256: sha256Hex(f.original) },
      output: f.next,
    }));
  }
  throw new RunEngineError("invalid", `canonical apply 落到未知批次 phase: ${phase}`);
}

function makeApplyPort(ctx: DriverContext): RunApplyPort {
  return {
    async requestApproval(input: ApplyApprovalRequest): Promise<ApprovalDecision> {
      const phase = ctx.phaseByBatch[input.batchId];
      if (phase === "commit") {
        const payload = await readArtifactPayload<CommitPayload>(ctx, input.batchId);
        const decision = await ctx.approve(
          "采用章节候选",
          `导入第 ${ctx.plan.start_chapter}-${ctx.plan.end_chapter} 章的 ${payload.candidateIds.length} 个 Scene`,
          payload.candidateIds,
        );
        emit(ctx.sink, { type: "approval", action: "commit_scenes", decision });
        return decision;
      }
      if (phase === "2b") {
        const payload = await readArtifactPayload<Phase2bPayload>(ctx, input.batchId);
        if (payload.plan.empty) {
          // No write set means no approval request. The batch policy maps unavailable to
          // a neutral skipped terminal; aggregation reports no_changes and emits no reject.
          return "unavailable";
        }
        const decision = await ctx.approve("别名/关系写入(2b)", payload.plan.summary, payload.plan.items);
        emit(ctx.sink, { type: "approval", action: "alias_relation", decision });
        return decision;
      }
      throw new RunEngineError("invalid", `apply 审批请求落到未知批次 phase: ${phase}`);
    },

    async execute(input: ApplyCanonicalRequest): Promise<{ commitOid: string }> {
      const phase = ctx.phaseByBatch[input.batchId];
      const writeSet = await applyWriteSet(ctx, input.batchId, true);
      const result = await executeTransaction(
        ctx.root,
        {
          kind: "canonical",
          txid: applyStoreTxid(input.transactionId),
          purpose: `deep-import apply ${input.batchId} (${phase})`,
          writeSet,
        },
        ctx.transactionOptions,
      );
      return { commitOid: result.commit };
    },

    async probe(transactionId: string): Promise<ApplyProbe> {
      const state = await ctx.persistence.loadRunState(ctx.workflowId);
      const record = Object.values(state.manifest?.applies ?? {}).find((item) => item.transactionId === transactionId);
      if (record === undefined) return { state: "unknown" };
      const writeSet = await applyWriteSet(ctx, record.batchId, false);
      const found = probeTxCommitForTargets(
        ctx.root,
        'HEAD',
        applyStoreTxid(transactionId),
        'canonical',
        writeSet.map((target) => ({ path: target.path, ...(target.output !== undefined ? { outputBytes: target.output } : {}) })),
      );
      if (found === "ambiguous") return { state: "unknown" };
      if (found !== undefined) return { state: "completed", commitOid: found.commit };
      // 无严格匹配 commit: canonical 未启动/已条件回滚 → none(重新审批)
      return { state: "none" };
    },
  };
}

// —— 事务化 materialize(候选/draft 写面; 非 adopt, 不经审批) ——

/** 计划文件 → writeSet(expected = 当前工作树状态, 幂等: 已存在且字节相同则剔除)。 */
function plannedFilesToWriteSet(ctx: DriverContext, files: ReadonlyArray<{ relativePath: string; bytes: string }>): TargetSpec[] {
  const writeSet: TargetSpec[] = [];
  for (const f of files) {
    const current = readFileIfExists(path.join(ctx.root, f.relativePath));
    if (current !== undefined && bytesToUtf8(current) === f.bytes) continue; // 幂等命中
    writeSet.push({
      path: f.relativePath,
      expected: current === undefined ? { absent: true, sha256: "" } : { absent: false, sha256: sha256Hex(current) },
      output: f.bytes,
    });
  }
  return writeSet;
}

/** 2a 实体候选 + 3 结构 draft: 每阶段一个 canonical 事务(非 adopt 写面, CAS + durable intent)。 */
async function materializePhaseWrites(ctx: DriverContext, phase: "2a" | "3"): Promise<void> {
  const payload = await readArtifactPayload<Phase2aPayload | Phase3Payload>(ctx, ctx.batchByPhase[phase]);
  const files = (payload as Phase2aPayload).files ?? (payload as Phase3Payload).files;
  const writeSet = plannedFilesToWriteSet(ctx, files);
  if (writeSet.length === 0) return; // 全部幂等命中/空写集 → 不发起事务(store 拒绝空事务)
  await executeTransaction(
    ctx.root,
    {
      kind: "canonical",
      purpose: `deep-import materialize phase ${phase}`,
      writeSet,
    },
    ctx.transactionOptions,
  );
}

// —— 聚合(结果 + trace 事件 + phase_results) ——

function decisionOfRejectedRecord(record: { failure?: string }): "rejected" | "unavailable" {
  const f = record.failure ?? "";
  return f.includes("unavailable") ? "unavailable" : "rejected";
}

interface AggregatedRun {
  result: DeepImportResult;
  phaseResults: Record<string, unknown>;
}

async function aggregateRun(ctx: DriverContext, run: RunEngineResult): Promise<AggregatedRun> {
  const slicePayload = await readArtifactPayload<Phase1aPayload>(ctx, ctx.batchByPhase["1a"]);
  const enrichPayload = await readArtifactPayload<Phase1bPayload>(ctx, ctx.batchByPhase["1b"]);
  const fusePayload = await readArtifactPayload<Phase1cPayload>(ctx, ctx.batchByPhase["1c"]);
  const commitPayload = await readArtifactPayload<CommitPayload>(ctx, ctx.batchByPhase.commit);
  const entityPayload = await readArtifactPayload<Phase2aPayload>(ctx, ctx.batchByPhase["2a"]);
  const aliasPayload = await readArtifactPayload<Phase2bPayload>(ctx, ctx.batchByPhase["2b"]);
  const structPayload = await readArtifactPayload<Phase3Payload>(ctx, ctx.batchByPhase["3"]);
  const manifest = run.manifest;
  const commitApply = manifest.applies[applyIdFor(ctx.workflowId, ctx.batchByPhase.commit)];
  const aliasApply = manifest.applies[applyIdFor(ctx.workflowId, ctx.batchByPhase["2b"])];
  if (commitApply !== undefined && commitApply.state === "failed") {
    throw new DeepImportWorkflowError("apply_probe_unknown", ctx.workflowId, [], "commit apply 进入 failed 终态, 需人工处置");
  }
  if (aliasApply !== undefined && aliasApply.state === "failed") {
    throw new DeepImportWorkflowError("apply_probe_unknown", ctx.workflowId, [], "2b apply 进入 failed 终态, 需人工处置");
  }

  const aliases: DeepImportResult["aliases"] = {
    attached: aliasPayload.plan.aliases_attached,
    skipped: aliasPayload.skipped_aliases,
    relations: aliasPayload.plan.relations_written,
    uncertain: aliasPayload.uncertain,
    approved: false,
  };

  const result: DeepImportResult = {
    workflow_id: ctx.workflowId,
    input_fingerprint: ctx.inputFingerprint,
    committed: [...commitPayload.created],
    skipped: [...commitPayload.skipped],
    conflicts: [...commitPayload.conflicts],
    adopted: commitPayload.created.length,
    rejected: false,
    entities: {
      created: [...entityPayload.created],
      reused: [...entityPayload.reused],
      uncertain: entityPayload.uncertain,
    },
    aliases,
    structure: {
      threads: structPayload.result.threads.length,
      arcs: structPayload.result.arcs.length,
      foreshadowing: structPayload.result.foreshadowing.length,
      reveals: structPayload.result.reveals.length,
      low_confidence: structPayload.result.low_confidence,
    },
    // legacy 契约(DeepImportResult.trace = runtime.trace ?? 新建 TraceRecorder):
    // 返回调用方传入的 sink 本身(供检查), 而不是 fanout wrapper;
    // 内部 traceRecorder 仍然独立收齐全部事件供持久化进入 git 历史。
    trace: ctx.runtimeTrace ?? ctx.traceRecorder,
  };

  // === trace 事件: adopt/reject 从终局 apply 记录发出(崩溃中断的 run 在聚合时补齐;
  //     已完成批不重放 provider/审批 —— 事件只是记录) ===
  for (const record of Object.values(manifest.applies)) {
    const phase = ctx.phaseByBatch[record.batchId];
    const action = phase === "commit" ? "commit_scenes" : "alias_relation";
    if (record.state === "applied") {
      const items = phase === "commit" ? commitPayload.created : aliasPayload.plan.touched;
      emit(ctx.sink, { type: "adopt", action, items });
    } else if (record.state === "rejected") {
      // 2b empty-plan 的 rejected 终态不 emit reject(复核纪律: 未请求审批);
      // 由下方按 artifact plan.empty 判 no_changes。
      if (phase === "2b" && aliasPayload.plan.empty) continue;
      emit(ctx.sink, { type: "reject", action, decision: decisionOfRejectedRecord(record) });
    } else if (record.state === "skipped") {
      if (phase === "2b" && aliasPayload.plan.empty) continue;
      emit(ctx.sink, { type: "reject", action, decision: "unavailable" });
    }
  }

  // === commit apply 终态 → rejected 早退(legacy 语义) ===
  const phaseResults: Record<string, unknown> = {};
  const sliceFallback = slicePayload.candidates.filter((c) => c.fallback_required).length;
  if (commitApply !== undefined && commitApply.state === "rejected") {
    result.rejected = true;
    result.rejection_decision = decisionOfRejectedRecord(commitApply);
    // Planned scene ids are not committed outputs when approval is denied.
    result.committed = [];
    result.adopted = 0;
    phaseResults["1a"] = { candidates: slicePayload.candidates.length, fallback: sliceFallback };
    phaseResults["1b"] = { scenes: enrichPayload.items.length };
    phaseResults["1c"] = { decisions: fusePayload.decisions.length };
    phaseResults["commit"] = { created: 0, skipped: 0 };
    // legacy 早退: 2a/2b/3 不出现
  } else {
    phaseResults["1a"] = { candidates: slicePayload.candidates.length, fallback: sliceFallback };
    phaseResults["1b"] = { scenes: enrichPayload.items.length };
    phaseResults["1c"] = { decisions: fusePayload.decisions.length };
    phaseResults["commit"] = { created: commitPayload.created.length, skipped: commitPayload.skipped.length };
    phaseResults["2a"] = result.entities;
    if (aliasPayload.skipped_no_scenes) {
      phaseResults["2b"] = { ...result.aliases, status: "skipped", skipped_all: true };
    } else if (aliasPayload.plan.empty) {
      phaseResults["2b"] = { ...result.aliases, status: "no_changes", skipped_all: true };
    } else if (aliasApply !== undefined && aliasApply.state === "applied") {
      result.aliases.approved = true;
      result.aliases.decision = "allowed-once";
      phaseResults["2b"] = { ...result.aliases, status: "done" };
    } else if (aliasApply !== undefined && aliasApply.state === "rejected") {
      result.aliases.decision = decisionOfRejectedRecord(aliasApply);
      phaseResults["2b"] = { ...result.aliases, status: result.aliases.decision, skipped_all: true };
    } else if (aliasApply !== undefined && aliasApply.state === "skipped") {
      result.aliases.decision = "unavailable";
      phaseResults["2b"] = { ...result.aliases, status: "unavailable", skipped_all: true };
    } else {
      phaseResults["2b"] = { ...result.aliases, status: "no_changes", skipped_all: true };
    }
    phaseResults["3"] = structPayload.result;
  }
  phaseResults.input_fingerprint = ctx.inputFingerprint;

  // === checkpoint 事件(按已执行阶段顺序; 聚合时统一 emit, resume 幂等) ===
  const completedPhases = PHASE_ORDINALS
    .map(({ phase }) => phase)
    .filter((phase) => manifest.batches[ctx.batchByPhase[phase]]?.state === "completed")
    .filter((phase) => !result.rejected || phase === "1a" || phase === "1b" || phase === "1c" || phase === "commit");
  for (const phase of completedPhases) {
    emit(ctx.sink, { type: "checkpoint", phase, input_fingerprint: ctx.inputFingerprint, done: true });
  }
  emit(ctx.sink, { type: "complete_import", workflow_id: ctx.workflowId, adopted: result.adopted });

  return { result, phaseResults };
}

// —— 生产入口 ——

/**
 * 深度导入六阶段 durable driver(生产入口; runDeepImport 的明确 durable 替换面)。
 * 启动前 recover 全 vault intents; 同输入+画像确定性 workflowId; resume 严格兼容;
 * provider_outcome_unknown 经 reauthorizeRemaining(ApprovalGate)重新授权后才重试;
 * adopt 走 RunApplyPort(canonical 事务 + 探针)。
 */
export async function runDeepImportWorkflow(
  root: string,
  plan: ImportPlan,
  runtime: DeepImportWorkflowRuntime,
): Promise<DeepImportResult> {
  // R40: authorization_confirmed 强制 true(授权快照 fail-closed)
  if (plan.authorization.authorization_confirmed !== true) {
    throw new Error("authorization_confirmed 必须为 true(授权快照强制, R40)");
  }
  if (plan.end_chapter < plan.start_chapter || plan.start_chapter < 1) {
    throw new Error("章节范围非法: 1 ≤ start ≤ end");
  }
  // N33/ADR-0023: 执行画像指纹 + 契约版本强制(fail-closed, 无指纹/无契约版本不启动)。
  if (runtime.profileFingerprint === undefined || runtime.profileFingerprint.length !== 64) {
    throw new Error("runDeepImportWorkflow 必须携带 ExecutionProfile 指纹(profileFingerprint, N33 强制)");
  }
  if (runtime.contractVersions === undefined || Object.keys(runtime.contractVersions).length === 0) {
    throw new Error("runDeepImportWorkflow 必须携带契约版本集(contractVersions, N33 强制)");
  }

  // 1) 启动前 recover 全 vault durable intents(ADR-0022 §4: intent 先于 manifest;
  //    未收敛 → fail-closed, 绝不带未收敛 intent 启动/续跑)。
  const recovery = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
  if (recovery.unresolved.length > 0) {
    throw new RunEngineError("corruption", `存在未收敛 durable intent, 拒绝启动(fail-closed): ${recovery.unresolved.join(", ")}`);
  }

  // 2) 确定性 spec + identity: fingerprint 覆盖源章节字节、授权范围、阶段、
  // effective policy 与契约版本；任一生成语义变化都产生不同 run identity。
  const effectivePolicy = loadPolicyDefaults(runtime.policy);
  const inputFingerprint = deepImportInputFingerprint(root, plan, effectivePolicy, runtime.contractVersions);
  const spec = buildDeepImportWorkflowSpec(root, plan, { inputFingerprint, profileFingerprint: runtime.profileFingerprint });
  const identity = createWorkflowIdentity({
    kind: "deep-import",
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    planDigest: planDigestOf(spec),
    uniqueRunId: plan.workflow_id,
  });
  const workflowId = identity.workflowId;
  const expected = {
    workflowId,
    kind: "deep-import" as const,
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    planDigest: identity.planDigest,
  };
  const ctx = buildDriverContext(root, plan, runtime, spec, inputFingerprint, workflowId);
  const sink = ctx.sink;

  // 3) begin_import(与 legacy 同字段; 指纹/契约版本携带)
  emit(sink, {
    type: "begin_import",
    workflow_id: workflowId,
    start_chapter: plan.start_chapter,
    end_chapter: plan.end_chapter,
    authorization_confirmed: true,
    input_fingerprint: inputFingerprint,
    profile_fingerprint: runtime.profileFingerprint,
    ...(Object.keys(runtime.contractVersions).length > 0 ? { contract_versions: runtime.contractVersions } : {}),
  });

  const ports: RunEnginePorts = { persistence: ctx.persistence, generator: makeGenerator(ctx), apply: makeApplyPort(ctx) };
  let run: RunEngineResult;

  // 4) start 或 resume(同 workflowId 已存在 → resume, 绝不覆盖旧 run)。
  // Budget consumption is restored from the durable manifest before any resumed provider call.
  const hasExistingRun = await ctx.persistence.hasRun(workflowId);
  if (hasExistingRun && ctx.budget !== undefined) {
    const state = await ctx.persistence.loadRunState(workflowId);
    const spent = state.manifest?.budgetSpent;
    if (spent === undefined) {
      throw new RunEngineError('corruption', '旧 run 缺 budgetSpent，预算恢复无法证明，拒绝续跑');
    }
    if (!ctx.budget.trySpend(spent)) {
      throw new RunEngineError('invalid', `恢复预算不足: 已消费 ${spent}, 当前总预算 ${ctx.budget.total}`);
    }
  }
  if (hasExistingRun) {
    run = await deepImportEngineSeam.runWorkflow(ports, { mode: "resume", workflowId, expected });
    // provider_outcome_unknown: 不自动重试; 重新授权(ApprovalGate 范围/成本)后才重试
    if (run.status === "provider_outcome_unknown" && runtime.reauthorizeRemaining !== undefined) {
      const batches = run.providerOutcomeUnknown.map((batchId) => ({ batchId, phase: ctx.phaseByBatch[batchId] ?? "?" }));
      const estimate = `预计 ${batches.length} 批(${batches.map((b) => b.phase).join("/")})结果未知, 重试将重新调用 LLM; 已完成批次不会重复执行`;
      const decision = await runtime.reauthorizeRemaining({ workflowId, batches, estimate });
      if (decision === "allowed-once") {
        run = await deepImportEngineSeam.runWorkflow(ports, { mode: "resume", workflowId, expected, retryOutcomeUnknown: true });
      }
    }
  } else {
    run = await deepImportEngineSeam.runWorkflow(ports, { mode: "start", spec });
  }

  // 5) 未完成终态 fail-closed(调用方可重新调用 → resume)
  if (run.status === "provider_outcome_unknown") {
    throw new DeepImportWorkflowError(
      "provider_outcome_unknown",
      workflowId,
      run.providerOutcomeUnknown,
      `深度导入 ${workflowId} 存在结果未知批次(${run.providerOutcomeUnknown.length} 批), 未获重新授权, 不自动重试; 重新调用将经 ApprovalGate 重新授权`,
    );
  }
  if (run.status === "apply_probe_unknown") {
    throw new DeepImportWorkflowError(
      "apply_probe_unknown",
      workflowId,
      run.applyProbeUnknown,
      `深度导入 ${workflowId} apply 探针未知, 保留现场 fail-closed(需人工处置)`,
    );
  }

  // 6) 候选/draft 事务化 materialize(2a 实体候选 + 3 结构 draft; 非 adopt 不经审批)
  await materializePhaseWrites(ctx, "2a");
  await materializePhaseWrites(ctx, "3");

  // 7) 聚合(trace adopt/reject/checkpoint/complete + 结果 + phase_results)
  const { result, phaseResults } = await aggregateRun(ctx, run);

  // 8) Checkpoint + trace are one ADR-0021 checkpoint transaction, authorized by
  // the committed immutable run plan. No bytes are written before the durable intent.
  const checkpointState: CheckpointState = {
    plan,
    phase_results: phaseResults,
    profile_fingerprint: runtime.profileFingerprint,
    contract_versions: runtime.contractVersions,
  };
  const checkpointOutput = Buffer.from(JSON.stringify(checkpointState, null, 2) + "\n", "utf8");
  const traceDelta = Buffer.from(
    ctx.traceRecorder.all().map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  const traceOutput = Buffer.concat([
    Buffer.from(ctx.traceBaseline ?? new Uint8Array()),
    traceDelta,
  ]);
  const target = (rel: string, baseline: Uint8Array | undefined, output: Uint8Array): TargetSpec => ({
    path: rel,
    expected: baseline === undefined
      ? { absent: true, sha256: '' }
      : { absent: false, sha256: sha256Hex(baseline) },
    output: Buffer.from(output).toString('utf8'),
  });
  await executeTransaction(root, {
    kind: "checkpoint",
    purpose: `deep-import ${workflowId} checkpoint+trace`,
    planSource: ctx.persistence.committedPlanSource(workflowId),
    writeSet: [
      target('.assistant/checkpoint.json', ctx.checkpointBaseline, checkpointOutput),
      target('.assistant/import-trace.jsonl', ctx.traceBaseline, traceOutput),
    ],
  }, ctx.transactionOptions);

  return result;
}
