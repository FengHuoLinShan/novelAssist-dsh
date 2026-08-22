// N33 / ADR-0022 — map-atlas 四阶段 durable run driver(加法: 只新增本文件, 不动
// plan.ts / write.ts / review.ts 与 dsh service/tools)。
//
// 复用 @novelcraft/imports 的通用生产引擎 runWorkflow + 生产持久化适配器
// (GitRunPersistence, 原生支持 WorkflowKind='map-atlas' 与 `.assistant/atlas/runs/`),
// 把 planMapAtlas(legacy 单进程序编排)的四个阶段拆为确定性 batch:
//   context → spatial → plan → materialize(apply: canonical 待审批写面)
// - 同输入 + 同执行画像 → 恒同 workflowId/batchId/planDigest(确定性); resume 走严格
//   manifest/profile/contract 兼容, 输入变化不得续跑(得新 workflowId, 不沿用旧 run);
//   force 每次生成全新 immutable run(expected-absent 唯一权威, 绝不覆盖旧 run);
// - fingerprint 覆盖 源内容 hash(ctx.context_hash)+ run options + workflow/schema/prompt
//   契约版本(contract_versions)+ 非 secret ExecutionProfile 指纹(profileFingerprint,
//   缺省 fail-closed 拒绝启动)——不含任何 key/secret(铁律 6, 不落盘、不记录、不返回);
// - artifact → receipt → cursor 顺序由 run-engine 保证(窗口〇/一/二 fail-closed);
//   resume 跳过 completed 批并在聚合时从已提交 artifact 重建投影(不重调 provider);
// - provider_outcome_unknown 不自动重调: 必须经 runtime.reauthorizeRemaining
//   (DSH ApprovalGate 范围/成本授权)allowed-once 后才重试该批(ADR-0022 §5.0/§8);
// - canonical apply(materialize pending 候选)走注入 approval/transaction probe port:
//   审批(decision 不落盘)→ applying(transactionId durable 先写)→ canonical 事务 →
//   探针; commit 前中断 → probe=none → 持久退回 waiting_approval 并要求新审批
//   (旧 decision 不复用, R4); commit 后只补 applied 状态, 不重复审批/写入(R4);
// - 每次持久化调用 = 一个 store 事务(GitRunPersistence 内部 enforce; 启动前先
//   recover 全 vault 未收敛 durable intents, fail-closed);
// - 公开 API: runAtlasWorkflow / resumeAtlasWorkflow, 返回兼容
//   AtlasRun / PlanMapAtlasResult 的投影(AtlasWorkflowResult)。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@novelcraft/vault";
import {
  executeTransaction,
  probeTxCommitForTargets,
  recoverInterruptedTransactions,
  serializeFrontmatter,
  sha256Hex,
  type TargetSpec,
  type TransactionOptions,
} from "@novelcraft/store";
import {
  applyIdFor,
  ApplyCanonicalError,
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
  type RunWorkflowManifest,
} from "@novelcraft/imports";
import {
  batchPaths,
  canonicalRunJson,
  createWorkflowIdentity,
  makeBatchPlan,
  workflowSha256,
  type BatchPlan,
  type WorkflowKind,
} from "@novelcraft/imports";
import { GitRunPersistence } from "@novelcraft/imports";
import type { ApprovalDecision, TraceEventInput, TraceSink } from "@novelcraft/trace";
import { TraceRecorder } from "@novelcraft/trace";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import { runStep } from "@novelcraft/llm-step";
import { compileAtlasContext } from "./context.js";
import { ATLAS_SPATIAL_BATCH_SIZE, ATLAS_SPATIAL_SCHEMA_VERSION, extractSpatialFacts } from "./spatial.js";
import {
  ATLAS_PLAN_OUTPUT_SCHEMA,
  buildAtlasPlanPrompt,
  buildPriorAtlas,
  changedUpdateTargets,
  computePlanSemanticKeys,
  newSourceIdentities,
  normalizePlanSources,
  registerAtlasPlanSpecOnce,
  validateAtlasPlan,
  type AtlasPriorNode,
  type PlanMapAtlasOptions,
  type UpdateTargets,
} from "./plan.js";
import { readAtlasTree } from "./read.js";
import { computeAtlasPageContentHash } from "./write.js";
import type {
  AtlasContextResult,
  AtlasNode,
  AtlasPage,
  AtlasPlan,
  AtlasRun,
  RunKind,
  SourceRef,
  SpatialEvidence,
} from "./types.js";

// —— 常量与契约版本 ——

/** canonical apply 目标锚(审批摘要/绑定用; 实际写集来自 materialize artifact)。 */
export const ATLAS_MATERIALIZE_APPLY_TARGET = "world/atlas/pending";

/**
 * workflow/schema/prompt 契约版本缺省集(折叠进 inputFingerprint; N33「工作流 + schema +
 * prompt 版本变化 → 新 workflowId, 不沿用旧 run」)。调用方可注入覆盖(如 prompt 模板
 * 升级时 DSH 显式 bump)。
 */
export const ATLAS_CONTRACT_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  workflow: "map-atlas-workflow/v1",
  context: "map-atlas-context/v1",
  spatial_schema: String(ATLAS_SPATIAL_SCHEMA_VERSION),
  plan_schema: "map-atlas-plan/v1",
  prompt: "atlas-plan-prompt/v1",
});

/** 派生输入阶段用确定性占位 hash(真实来源 = 前置阶段 artifact)。 */
function phaseInputHash(phase: string): string {
  return workflowSha256(`map-atlas:phase-input:${phase}`);
}

/** materialize apply 的确定性 expected-state 锚(审批时不得刷新, ADR-0022 §6)。 */
function applyExpectedHash(): string {
  return workflowSha256("map-atlas:apply-expected:materialize");
}

/** 引擎域 transactionId(`tx-`+40hex)→ store 域 canonical txid(`tx-`+64hex); 确定性。 */
export function atlasApplyStoreTxid(engineTransactionId: string): string {
  return `tx-${workflowSha256(`map-atlas-apply:${engineTransactionId}`)}`;
}

// —— 公开类型 ——

/** 与 PlanMapAtlasOptions 兼容的 driver 选项(加法: force 为 durable 语义扩展)。 */
export interface AtlasWorkflowOptions extends PlanMapAtlasOptions {
  /** force = 每次生成全新 immutable run(新 workflowId); 缺省 false = 同输入续跑/复用。 */
  force?: boolean;
  /** 仅由 resumeAtlasWorkflow 设置：要求精确命中既有 identity，禁止意外新建。 */
  resumeWorkflowId?: string;
}

/** 驱动运行期端口(与 DeepImportWorkflowRuntime 同精神; key/secret 一律不接)。 */
export interface AtlasWorkflowRuntime {
  provider: Provider;
  /**
   * canonical apply 审批(decision/token 不落盘; allowed-once 放行, rejected/cancelled/
   * unavailable 一律不 apply —— fail-closed, 铁律 3)。
   */
  approve: (action: string, summary: string, items: string[]) => Promise<ApprovalDecision>;
  /** 非 secret ExecutionProfile 指纹(ADR-0023; N33 强制, 缺省拒绝启动)。 */
  profileFingerprint: string;
  /** workflow/schema/prompt 契约版本(折叠进 inputFingerprint; 覆盖 ATLAS_CONTRACT_DEFAULTS)。 */
  contractVersions?: Record<string, string>;
  /** 预算(预留; map-atlas 阶段函数不要求 budget 时省略)。 */
  budget?: WorkflowBudget;
  /** 外部 trace sink(可选)。 */
  trace?: TraceSink;
  /**
   * provider_outcome_unknown 批重试前的重新授权(ADR-0022 §5.0/§8): 调用方(DSH)经
   * ApprovalGate 请求剩余批次的范围/成本授权 —— 不是裸 boolean 自动重试; 缺省/非
   * allowed-once = 写状态后停止, 绝不自动重调 provider。
   */
  reauthorizeRemaining?: (info: {
    workflowId: string;
    batches: ReadonlyArray<{ batchId: string; phase: string }>;
    estimate: string;
  }) => Promise<ApprovalDecision>;
  /** 透传给 store executeTransaction / GitRunPersistence 的选项(测试注入崩溃门控; 生产缺省)。 */
  transactionOptions?: TransactionOptions;
}

/** runAtlasWorkflow 的结果(PlanMapAtlasResult 兼容投影 + durable 现场)。 */
export interface AtlasWorkflowResult {
  /** durable run id(= workflowId; 确定性或 force 全新)。 */
  workflowId: string;
  kind: "map-atlas";
  inputFingerprint: string;
  profileFingerprint: string;
  /** 终局结果; provider_outcome_unknown / apply_probe_unknown 表示停止、可续跑。 */
  outcome: "completed" | "provider_outcome_unknown" | "apply_probe_unknown";
  /** 兼容 AtlasRun 的投影(完成时为终局; 中断时为 best-effort)。 */
  run: AtlasRun;
  ctx: AtlasContextResult;
  spatial: SpatialEvidence | null;
  plan: AtlasPlan | null;
  issues: string[];
  /** provider_outcome_unknown 的剩余批次(重新授权后 resume 重试)。 */
  remainingBatchIds: readonly string[];
  providerOutcomeUnknown: readonly string[];
  /** probe=unknown 保留现场 fail-closed 的 apply(绝不盲重写)。 */
  applyProbeUnknown: readonly string[];
  /** probe=none 持久退回 waiting_approval 的 apply(下次必须重新审批)。 */
  reappliedApplyIds: readonly string[];
  manifest: RunWorkflowManifest;
}

/** 测试注入 seam(spy 可替换 runWorkflow / GitRunPersistence 以注入崩溃门控)。 */
export const atlasWorkflowEngineSeam: {
  runWorkflow: typeof runWorkflow;
  GitRunPersistence: typeof GitRunPersistence;
} = { runWorkflow, GitRunPersistence };

// —— 工具 ——

function emit(sink: TraceSink, event: TraceEventInput): void {
  sink.record(event);
}

/** 递归剔除 undefined(artifact 持久化面拒绝 undefined, N33/R1); 与 JSON.stringify 语义一致。 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

function payloadOf<T>(payload: T): T {
  return stripUndefined(payload) as T;
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

function sortedMerge(base: Record<string, string>, overrides?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  if (overrides !== undefined) {
    for (const k of Object.keys(overrides)) merged[k] = String(overrides[k]);
  }
  const out: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) out[k] = merged[k];
  return out;
}

/** 读已提交 artifact 的 payload(恢复时从 run 目录精确字节重建, 不依赖内存状态)。 */
async function readArtifactPayload<T>(ctx: AtlasDriverContext, batchId: string): Promise<T | undefined> {
  const bytes = await ctx.persistence.readBytes(ctx.paths[batchId].artifactPath);
  if (bytes === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(bytesToUtf8(bytes));
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || !("payload" in doc)) return undefined;
  return (doc as { payload: T }).payload;
}

// —— fingerprint 与 spec ——

/**
 * 确定性 inputFingerprint(N33): 覆盖 源内容 hash(ctx.context_hash; 其自身已覆盖
 * options + manifest ids/hashes, compileAtlasContext 确定性)+ run options + 契约版本;
 * 不含任何 secret。变化 → 新 workflowId(输入变化不得续跑)。
 */
export function atlasInputFingerprint(
  ctx: AtlasContextResult,
  options: AtlasWorkflowOptions,
  contractVersions?: Record<string, string>,
  profileFingerprint = "",
  priorAtlasFingerprint = "",
): string {
  return workflowSha256(
    canonicalRunJson({
      context_hash: ctx.context_hash,
      profile_fingerprint: profileFingerprint,
      prior_atlas_fingerprint: priorAtlasFingerprint,
      run_kind: options.run_kind,
      options: {
        style_note: options.style_note ?? "",
        include_working_drafts: options.include_working_drafts === true,
        include_interiors: options.include_interiors === true,
        full_rebuild: options.full_rebuild === true,
      },
      contract_versions: sortedMerge(ATLAS_CONTRACT_DEFAULTS, contractVersions),
    }),
  );
}

/** 确定性 batch 布局(四批, ordinal/phase 固定; plan/materialize 的 sourceIds 为派生占位)。 */
export function buildAtlasWorkflowSpec(options: {
  ctx: AtlasContextResult;
  inputFingerprint: string;
  profileFingerprint: string;
  uniqueRunId: string;
}): RunEngineSpec {
  const batches: RunBatchSpec[] = [{
    phase: "context",
    ordinal: 0,
    sourceIds: ["map-sources"],
    sourceHashes: { "map-sources": options.ctx.context_hash },
    outputSchemaVersion: "map-atlas-context-v1",
  }];
  const spatialCount = Math.max(1, Math.ceil(options.ctx.packets.length / ATLAS_SPATIAL_BATCH_SIZE));
  for (let index = 0; index < spatialCount; index++) {
    const packets = options.ctx.packets.slice(index * ATLAS_SPATIAL_BATCH_SIZE, (index + 1) * ATLAS_SPATIAL_BATCH_SIZE);
    const phase = `spatial-${String(index).padStart(3, "0")}`;
    const sourceIds = packets.length > 0 ? packets.map((packet) => packet.location_key) : ["context-empty"];
    const sourceHashes = Object.fromEntries(sourceIds.map((id) => [id, workflowSha256(canonicalRunJson(
      packets.find((packet) => packet.location_key === id) ?? { context_hash: options.ctx.context_hash },
    ))]));
    batches.push({
      phase,
      ordinal: batches.length,
      sourceIds,
      sourceHashes,
      outputSchemaVersion: String(ATLAS_SPATIAL_SCHEMA_VERSION),
    });
  }
  const spatialPhases = batches.filter((batch) => batch.phase.startsWith("spatial-")).map((batch) => batch.phase);
  batches.push({
    phase: "plan",
    ordinal: batches.length,
    sourceIds: ["context", ...spatialPhases],
    sourceHashes: Object.fromEntries([
      ["context", options.ctx.context_hash],
      ...spatialPhases.map((phase) => [phase, phaseInputHash(phase)] as const),
    ]),
    outputSchemaVersion: "map-atlas-plan-v1",
  });
  batches.push({
    phase: "materialize",
    ordinal: batches.length,
    sourceIds: ["plan"],
    sourceHashes: { plan: phaseInputHash("plan") },
    outputSchemaVersion: "map-atlas-materialize-v1",
    apply: {
      target: ATLAS_MATERIALIZE_APPLY_TARGET,
      expectedHash: applyExpectedHash(),
      onApprovalUnavailable: "skipped",
    },
  });
  return {
    kind: "map-atlas",
    inputFingerprint: options.inputFingerprint,
    profileFingerprint: options.profileFingerprint,
    uniqueRunId: options.uniqueRunId,
    batches,
  };
}

// —— artifact payload 形态 ——

interface AtlasContextPayload {
  ctx: AtlasContextResult;
  /** 非 secret resolved execution metadata，便于审计/兼容判定。 */
  profileFingerprint: string;
  contractVersions: Record<string, string>;
  resolvedOptions: Record<string, string | boolean>;
}
interface AtlasSpatialPayload {
  spatial: SpatialEvidence;
}
type AtlasPlanShortCircuit = "insufficient_sources" | "all_batches_failed" | "no_changes" | "plan_validation_failed";
interface AtlasPlanPayload {
  /** 空 = 正常路径(plan + semanticKeys 有效)。 */
  shortCircuit?: AtlasPlanShortCircuit;
  plan?: AtlasPlan;
  semanticKeys: Record<string, string>;
  issues: string[];
  /** map_atlas_plan 的 llm_step journal(L1; 聚合进 run.journal)。 */
  journal: unknown[];
}
interface AtlasMaterializePayload {
  nodes: AtlasNode[];
  pages: AtlasPage[];
  /** 审批前 artifact 固定的完整 canonical CAS 计划；execute/probe 禁止重读刷新。 */
  writeSet: TargetSpec[];
  empty: boolean;
  shortCircuit?: AtlasPlanShortCircuit;
  plannedPageCount: number;
}

// —— driver 上下文 ——

interface AtlasDriverContext {
  root: string;
  options: AtlasWorkflowOptions;
  /** 指纹时预编译的确定性 ctx(存入 context artifact, 避免运行中漂移)。 */
  ctxSnapshot: AtlasContextResult;
  /** 启动时冻结并进入 fingerprint 的 prior atlas/update baseline，resume 禁止重读漂移。 */
  priorAtlasSnapshot: AtlasPriorNode[];
  previousSourceManifest: SourceRef[];
  provider: Provider;
  sink: TraceSink;
  traceRecorder: TraceRecorder;
  runtimeTrace?: TraceSink;
  persistence: GitRunPersistence;
  transactionOptions: TransactionOptions;
  inputFingerprint: string;
  profileFingerprint: string;
  contractVersions: Record<string, string>;
  workflowId: string;
  kind: WorkflowKind;
  batchPlans: Readonly<Record<string, BatchPlan>>;
  paths: Readonly<Record<string, { planPath: string; artifactPath: string; receiptPath: string }>>;
  phaseByBatch: Readonly<Record<string, string>>;
  batchByPhase: Readonly<Record<string, string>>;
  approve: AtlasWorkflowRuntime["approve"];
}

/** Preserve the llm_step trace contract around every provider attempt。 */
function tracedProvider(provider: Provider, sink: TraceSink): Provider {
  return {
    ...(provider.executionDefaults !== undefined ? { executionDefaults: provider.executionDefaults } : {}),
    ...(provider.workflowBudget !== undefined ? { workflowBudget: provider.workflowBudget } : {}),
    async complete(req) {
      try {
        const response = await provider.complete(req);
        emit(sink, { type: "llm_step", ok: true, model: req.model });
        return response;
      } catch (error) {
        emit(sink, { type: "llm_step", ok: false, model: req.model, error: String((error as Error)?.message ?? error) });
        throw error;
      }
    },
  };
}

function buildAtlasDriverContext(
  root: string,
  options: AtlasWorkflowOptions,
  runtime: AtlasWorkflowRuntime,
  spec: RunEngineSpec,
  inputFingerprint: string,
  workflowId: string,
  ctxSnapshot: AtlasContextResult,
  priorAtlasSnapshot: AtlasPriorNode[],
  previousSourceManifest: SourceRef[],
): AtlasDriverContext {
  const traceRecorder = new TraceRecorder();
  const sink: TraceSink =
    runtime.trace === undefined
      ? traceRecorder
      : {
          record(event) {
            const recorded = traceRecorder.record(event);
            runtime.trace!.record(event);
            return recorded;
          },
        };
  const persistence = new atlasWorkflowEngineSeam.GitRunPersistence(root, {
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
    options,
    ctxSnapshot,
    priorAtlasSnapshot,
    previousSourceManifest,
    provider: tracedProvider(
      runtime.budget === undefined
        ? runtime.provider
        : { ...runtime.provider, complete: runtime.provider.complete.bind(runtime.provider), workflowBudget: runtime.budget },
      sink,
    ),
    sink,
    traceRecorder,
    runtimeTrace: runtime.trace,
    persistence,
    transactionOptions: runtime.transactionOptions ?? {},
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    contractVersions: sortedMerge(ATLAS_CONTRACT_DEFAULTS, runtime.contractVersions),
    workflowId,
    kind: spec.kind,
    batchPlans,
    paths: pathsById,
    phaseByBatch,
    batchByPhase,
    approve: runtime.approve,
  };
}

// —— 各批 generator ——

function spatialBatchIds(ctx: AtlasDriverContext): string[] {
  return Object.keys(ctx.batchPlans)
    .filter((batchId) => ctx.phaseByBatch[batchId]?.startsWith("spatial-"))
    .sort((a, b) => ctx.batchPlans[a].ordinal - ctx.batchPlans[b].ordinal);
}

async function combinedSpatialPayload(ctx: AtlasDriverContext): Promise<AtlasSpatialPayload | undefined> {
  const parts = (await Promise.all(spatialBatchIds(ctx).map((batchId) => readArtifactPayload<AtlasSpatialPayload>(ctx, batchId))))
    .filter((part): part is AtlasSpatialPayload => part !== undefined);
  if (parts.length === 0) return undefined;
  const spatial: SpatialEvidence = {
    schema_version: ATLAS_SPATIAL_SCHEMA_VERSION,
    facts: parts.flatMap((part) => part.spatial.facts),
    supported: parts.flatMap((part) => part.spatial.supported),
    visual_fill: parts.flatMap((part) => part.spatial.visual_fill),
    conflicts: parts.flatMap((part) => part.spatial.conflicts),
    source_fingerprint: workflowSha256(canonicalRunJson(parts.map((part) => part.spatial.source_fingerprint))),
    locations_checked: parts.reduce((sum, part) => sum + part.spatial.locations_checked, 0),
    locations_with_facts: new Set(parts.flatMap((part) => part.spatial.facts.map((fact) => fact.location_key))).size,
    degraded: parts.some((part) => part.spatial.degraded),
    all_batches_failed: parts.every((part) => part.spatial.all_batches_failed),
    invalid_count: parts.reduce((sum, part) => sum + part.spatial.invalid_count, 0),
    journal: parts.flatMap((part) => part.spatial.journal ?? []),
  };
  return { spatial };
}

async function generateContextBatch(ctx: AtlasDriverContext, _input: RunGeneratorInput): Promise<RunGeneratorOutput> {
  // 确定性快照: 指纹阶段已编译(ctxSnapshot), 原样持久化, 后置批从 artifact 消费。
  return {
    payload: payloadOf({
      ctx: ctx.ctxSnapshot,
      profileFingerprint: ctx.profileFingerprint,
      contractVersions: ctx.contractVersions,
      resolvedOptions: {
        run_kind: ctx.options.run_kind,
        style_note: ctx.options.style_note ?? "",
        include_working_drafts: ctx.options.include_working_drafts === true,
        include_interiors: ctx.options.include_interiors === true,
        full_rebuild: ctx.options.full_rebuild === true,
      },
    } satisfies AtlasContextPayload),
  };
}

async function generateSpatialBatch(ctx: AtlasDriverContext, input: RunGeneratorInput): Promise<RunGeneratorOutput> {
  const contextPayload = (await readArtifactPayload<AtlasContextPayload>(ctx, ctx.batchByPhase.context))!;
  if (contextPayload.ctx.insufficient_sources) {
    // 无可核对地点: 零 provider, 空证据 + insufficient_sources(镜像 extractSpatialFacts)。
    return {
      payload: payloadOf({
        spatial: {
          schema_version: ATLAS_SPATIAL_SCHEMA_VERSION,
          facts: [],
          supported: [],
          visual_fill: [],
          conflicts: [],
          source_fingerprint: workflowSha256(canonicalRunJson({ schema_version: ATLAS_SPATIAL_SCHEMA_VERSION, locations: [] })),
          locations_checked: 0,
          locations_with_facts: 0,
          degraded: false,
          all_batches_failed: false,
          invalid_count: 0,
          insufficient_sources: true,
          message: contextPayload.ctx.message ?? "没有可核对的已采用地点。",
        } satisfies SpatialEvidence,
      }),
    };
  }
  const index = Number(input.phase.slice("spatial-".length));
  if (!Number.isInteger(index) || index < 0) throw new Error(`spatial phase 非法: ${input.phase}`);
  const packets = contextPayload.ctx.packets.slice(index * ATLAS_SPATIAL_BATCH_SIZE, (index + 1) * ATLAS_SPATIAL_BATCH_SIZE);
  const chunkContext: AtlasContextResult = { ...contextPayload.ctx, packets };
  const spatial = await extractSpatialFacts(ctx.root, ctx.provider, chunkContext, {
    disableReuse: true,
    failClosed: true,
  });
  return { payload: payloadOf({ spatial } satisfies AtlasSpatialPayload) };
}

async function generatePlanBatch(ctx: AtlasDriverContext, input: RunGeneratorInput): Promise<RunGeneratorOutput> {
  registerAtlasPlanSpecOnce();
  const contextPayload = (await readArtifactPayload<AtlasContextPayload>(ctx, ctx.batchByPhase.context))!;
  const spatialPayload = (await combinedSpatialPayload(ctx))!;
  const { ctx: sourceCtx } = contextPayload;
  const spatial = spatialPayload.spatial;

  if (sourceCtx.insufficient_sources) {
    return {
      payload: payloadOf({ shortCircuit: "insufficient_sources", semanticKeys: {}, issues: [sourceCtx.message ?? "insufficient_sources"], journal: [] } satisfies AtlasPlanPayload),
    };
  }
  if (spatial.all_batches_failed) {
    return {
      payload: payloadOf({ shortCircuit: "all_batches_failed", semanticKeys: {}, issues: [spatial.message ?? "all_batches_failed"], journal: [] } satisfies AtlasPlanPayload),
    };
  }

  const priorAtlas = ctx.priorAtlasSnapshot;
  const isUpdate = ctx.options.run_kind === "update" && !(ctx.options.full_rebuild === true);
  let updateTargets: UpdateTargets | undefined;
  if (isUpdate) {
    const missing = new Set(
      sourceCtx.packets.map((p) => p.location_key).filter((slug: string) => !priorAtlas.some((n) => n.location_ref === slug)),
    );
    const { changedSemanticKeys } = changedUpdateTargets(priorAtlas, sourceCtx.source_manifest);
    // previousSourceManifest 已在 identity 前从 adopted atlas 冻结；resume 不读取可变 latest projection。
    const newSources = newSourceIdentities(ctx.previousSourceManifest, sourceCtx.source_manifest);
    updateTargets = { changedSemanticKeys, missingLocationSlugs: missing, newSources };
    if (missing.size === 0 && changedSemanticKeys.size === 0 && newSources.size === 0) {
      return { payload: payloadOf({ shortCircuit: "no_changes", semanticKeys: {}, issues: [], journal: [] } satisfies AtlasPlanPayload) };
    }
  }

  const spec = ATLAS_PLAN_OUTPUT_SCHEMA;
  const contextJson = JSON.stringify({
    packets: sourceCtx.packets,
    spatial_facts: { supported: spatial.supported, visual_fill: spatial.visual_fill, conflicts: spatial.conflicts },
  });
  const prompt = buildAtlasPlanPrompt({
    context: contextJson,
    schema: spec,
    styleNote: ctx.options.style_note,
    includeInteriors: ctx.options.include_interiors === true,
    priorAtlas,
    sourceManifest: sourceCtx.source_manifest,
    runKind: ctx.options.run_kind,
    allowedUpdateTargets: updateTargets
      ? {
          missing_locations: [...updateTargets.missingLocationSlugs].sort(),
          changed_semantic_keys: [...updateTargets.changedSemanticKeys].sort(),
        }
      : undefined,
  });
  // provider 失败让 generator 抛出 → run-engine 写 provider_outcome_unknown 后停止,
  // 绝不自动重调(重新授权后才重试该批)。
  const step = await runStep(ctx.provider, { specRef: "map_atlas_plan", input: prompt });
  if (!step || !step.ok || typeof step.result !== "object" || step.result === null) {
    throw new Error(step?.error?.message ?? "map_atlas_plan 生成失败(result 非法/失败)");
  }
  const plan = step.result as unknown as AtlasPlan;
  const journal: unknown[] = [{ specRef: "map_atlas_plan", journal: step.journal, usage: step.usage, ok: step.ok }];

  const validation = validateAtlasPlan(plan, sourceCtx.source_manifest, {
    priorAtlas,
    ...(isUpdate && updateTargets ? { updateTargets } : {}),
  });
  if (!validation.ok) {
    return { payload: payloadOf({ shortCircuit: "plan_validation_failed", plan, semanticKeys: {}, issues: validation.issues, journal } satisfies AtlasPlanPayload) };
  }
  normalizePlanSources(plan, sourceCtx.source_manifest);
  const { keys: semanticKeys, issues: keyIssues } = computePlanSemanticKeys(plan, priorAtlas);
  if (keyIssues.length > 0) {
    return { payload: payloadOf({ shortCircuit: "plan_validation_failed", plan, semanticKeys: {}, issues: keyIssues, journal } satisfies AtlasPlanPayload) };
  }
  return { payload: payloadOf({ plan, semanticKeys, issues: [], journal } satisfies AtlasPlanPayload) };
}

/** 候选页/候选节点(镜像 planMapAtlas 步骤 6; 纯内存, 零 canonical 写)。 */
function planMaterializePayload(ctx: AtlasDriverContext, planPayload: AtlasPlanPayload): AtlasMaterializePayload {
  const shortCircuit = planPayload.shortCircuit;
  if (shortCircuit !== undefined) {
    return {
      nodes: [],
      pages: [],
      writeSet: [],
      empty: true,
      shortCircuit,
      plannedPageCount: shortCircuit === "no_changes" ? 0 : 0,
    };
  }
  const plan = planPayload.plan!;
  const semanticKeys = planPayload.semanticKeys;
  const nodes: AtlasNode[] = plan.nodes.flatMap((n, i) => {
    const semanticKey = semanticKeys[n.plan_key];
    if (!semanticKey) return [];
    return [
      {
        id: n.plan_key,
        parent_ref: n.existing_parent_node_id ?? (n.parent_plan_key ? n.parent_plan_key : null),
        location_ref: n.location_ref ?? null,
        semantic_key: semanticKey,
        level: n.level,
        title: n.title,
        summary: n.summary,
        status: "provisional" as const,
        sort_order: i,
      },
    ];
  });
  const pages: AtlasPage[] = plan.nodes.map((n) => {
    const base: Omit<AtlasPage, "content_hash"> = {
      id: `pg-${n.plan_key}`,
      run_ref: "", // apply 时回填 run_ref(workflowId); 见 materializeApplyWriteSet。
      node_ref: n.plan_key,
      generation_status: "prompt_only",
      review_status: "candidate",
      title: n.title,
      visual_brief: n.visual_brief,
      prompt: n.prompt,
      evidence: {
        supported: n.evidence?.supported ?? [],
        visual_fill: n.evidence?.visual_fill ?? [],
        conflicts: n.evidence?.conflicts ?? [],
      },
      source_manifest: n.sources ?? [],
      annotations: (n.annotations ?? []).map((a, ai) => ({
        id: `ann-${n.plan_key}-${ai}`,
        label: a.label,
        position_x: a.position_x,
        position_y: a.position_y,
        ...(a.target_plan_key ? { target_node_ref: a.target_plan_key } : {}),
        sort_order: ai,
      })),
      review_note: null,
      adopted_at: null,
      rejected_at: null,
      deprecated_at: null,
    };
    return { ...base, content_hash: computeAtlasPageContentHash(base) };
  });
  return {
    nodes,
    pages,
    writeSet: materializeWriteSet(ctx, nodes, pages, ctx.workflowId),
    empty: nodes.length === 0 && pages.length === 0,
    plannedPageCount: plan.nodes.length,
  };
}

async function generateMaterializeBatch(ctx: AtlasDriverContext, _input: RunGeneratorInput): Promise<RunGeneratorOutput> {
  const planPayload = (await readArtifactPayload<AtlasPlanPayload>(ctx, ctx.batchByPhase.plan))!;
  return { payload: payloadOf(planMaterializePayload(ctx, planPayload)) };
}

function makeGenerator(ctx: AtlasDriverContext): RunGeneratorPort {
  return {
    async generate(input: RunGeneratorInput): Promise<RunGeneratorOutput> {
      if (input.phase.startsWith("spatial-")) return generateSpatialBatch(ctx, input);
      switch (input.phase) {
        case "context":
          return generateContextBatch(ctx, input);
        case "plan":
          return generatePlanBatch(ctx, input);
        case "materialize":
          return generateMaterializeBatch(ctx, input);
        default:
          throw new Error(`未知 phase: ${input.phase}`);
      }
    },
  };
}

// —— 候选写面序列化(镜像 write.ts 私有前台的确定性字节; 只做加法, 不改 write.ts) ——

function atlasNodeFrontmatter(node: AtlasNode): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: node.id,
    parent_ref: node.parent_ref,
    location_ref: node.location_ref,
    semantic_key: node.semantic_key,
    level: node.level,
    title: node.title,
  };
  if (node.summary !== undefined) fm.summary = node.summary;
  fm.status = node.status;
  fm.sort_order = node.sort_order;
  return fm;
}

function atlasPageFrontmatter(page: AtlasPage): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: page.id,
    run_ref: page.run_ref,
    node_ref: page.node_ref,
  };
  if (page.generation_choice === "upload") fm.generation_choice = page.generation_choice;
  fm.generation_status = page.generation_status;
  fm.review_status = page.review_status;
  fm.title = page.title;
  fm.visual_brief = page.visual_brief;
  fm.prompt = page.prompt;
  if (page.image) fm.image = page.image;
  fm.evidence = page.evidence;
  fm.source_manifest = page.source_manifest;
  fm.annotations = page.annotations;
  fm.review_note = page.review_note;
  fm.adopted_at = page.adopted_at;
  fm.rejected_at = page.rejected_at;
  fm.deprecated_at = page.deprecated_at;
  fm.content_hash = page.content_hash;
  return fm;
}

function serializeAtlasNode(node: AtlasNode): string {
  return serializeFrontmatter(atlasNodeFrontmatter(node), `# ${node.title}\n`);
}

function serializeAtlasPage(page: AtlasPage): string {
  return serializeFrontmatter(atlasPageFrontmatter(page), `# ${page.title}\n`);
}

/** vault 相对路径(write.ts 同布局); node/page id 已由 plan_key 白名单保证安全。 */
function pendingNodeRelPath(nodeId: string): string {
  return `world/atlas/pending/nodes/${nodeId}.md`;
}

function pendingPageRelPath(pageId: string): string {
  return `world/atlas/pending/pages/${pageId}.md`;
}

/** materialize 写集: CAS on 当前工作树, 幂等(已一致则剔除; 全一致 → 空写集)。 */
function materializeWriteSet(ctx: AtlasDriverContext, nodes: AtlasNode[], pages: AtlasPage[], runRef: string): TargetSpec[] {
  const files: Array<{ path: string; content: string }> = [
    ...nodes.map((n) => ({ path: pendingNodeRelPath(n.id), content: serializeAtlasNode(n) })),
    ...pages.map((p) => ({ path: pendingPageRelPath(p.id), content: serializeAtlasPage({ ...p, run_ref: runRef }) })),
  ];
  const writeSet: TargetSpec[] = [];
  for (const f of files) {
    const current = readFileIfExists(join(ctx.root, f.path));
    if (current !== undefined && bytesToUtf8(current) === f.content) continue; // 幂等命中
    writeSet.push({
      path: f.path,
      expected: current === undefined ? { absent: true, sha256: "" } : { absent: false, sha256: sha256Hex(current) },
      output: f.content,
    });
  }
  return writeSet;
}

// —— RunApplyPort: 独立审批 + ADR-0021 canonical 事务 + txid 探针 ——

function makeApplyPort(ctx: AtlasDriverContext): RunApplyPort {
  return {
    async requestApproval(input: ApplyApprovalRequest): Promise<ApprovalDecision> {
      const payload = (await readArtifactPayload<AtlasMaterializePayload>(ctx, ctx.batchByPhase.materialize))!;
      // 空候选 / 全部幂等一致: 无写集 → 中性 skipped 终态, 不请求审批(复核纪律)。
      if (payload.empty || payload.writeSet.length === 0) return "unavailable";
      const decision = await ctx.approve(
        "地图册候选物化(materialize)",
        `将 ${payload.nodes.length} 个候选节点与 ${payload.pages.length} 个候选页写入 ${input.target}`,
        [...payload.nodes.map((n) => n.id), ...payload.pages.map((p) => p.id)],
      );
      emit(ctx.sink, { type: "approval", action: "atlas_materialize", decision });
      return decision;
    },

    async execute(input: ApplyCanonicalRequest): Promise<{ commitOid: string }> {
      const payload = (await readArtifactPayload<AtlasMaterializePayload>(ctx, ctx.batchByPhase.materialize))!;
      const writeSet = payload.writeSet;
      if (writeSet.length === 0) {
        // 审批后写集变空(候选已被一致写入): 确定性终态 failed, 不发起空事务(fail-closed)。
        throw new ApplyCanonicalError("materialize", "materialize 写集为空(候选已一致), 拒绝空事务");
      }
      const result = await executeTransaction(
        ctx.root,
        {
          kind: "canonical",
          txid: atlasApplyStoreTxid(input.transactionId),
          purpose: `map-atlas materialize ${input.batchId}`,
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
      const payload = (await readArtifactPayload<AtlasMaterializePayload>(ctx, record.batchId))!;
      const writeSet = payload.writeSet;
      if (writeSet.length === 0) return { state: "none" }; // 无可供寻址的写集 → 未启动归属
      const found = probeTxCommitForTargets(
        ctx.root,
        "HEAD",
        atlasApplyStoreTxid(transactionId),
        "canonical",
        writeSet.map((t) => ({ path: t.path, ...(t.output !== undefined ? { outputBytes: Buffer.from(t.output, "utf8") } : {}) })),
      );
      if (found === "ambiguous") return { state: "unknown" };
      if (found !== undefined) return { state: "completed", commitOid: found.commit };
      // 无严格匹配 commit: canonical 未启动/已条件回滚 → none(重新审批)
      return { state: "none" };
    },
  };
}

// —— 聚合: Artifact → AtlasRun/PlanMapAtlasResult 投影 ——

interface AtlasAggregation {
  run: AtlasRun;
  ctx: AtlasContextResult;
  spatial: SpatialEvidence | null;
  plan: AtlasPlan | null;
  issues: string[];
  materializeApplyState?: "applied" | "skipped" | "rejected" | "failed";
}

function failRunProjection(run: AtlasRun, code: string, message: string, checkpoint: string): void {
  run.status = "failed";
  run.error_code = code;
  run.error_message = message;
  run.checkpoint = checkpoint;
}

function baseRunProjection(ctx: AtlasDriverContext, createdAt: string): AtlasRun {
  return {
    schema_version: 1,
    id: ctx.workflowId,
    run_kind: ctx.options.run_kind,
    status: "planning",
    options: {
      style_note: ctx.options.style_note ?? "",
      include_working_drafts: ctx.options.include_working_drafts === true,
      include_interiors: ctx.options.include_interiors === true,
      full_rebuild: ctx.options.full_rebuild === true,
    },
    context_hash: "",
    source_manifest: [],
    spatial_evidence: {},
    atlas_plan: { style_brief: "", nodes: [] },
    planned_page_count: 0,
    checkpoint: "planning",
    error_code: null,
    error_message: null,
    journal: [],
    created_at: createdAt,
  };
}

async function aggregateRun(ctx: AtlasDriverContext, run: RunEngineResult): Promise<AtlasAggregation> {
  const runRef = ctx.workflowId;
  const contextPayload = await readArtifactPayload<AtlasContextPayload>(ctx, ctx.batchByPhase.context);
  const spatialPayload = await combinedSpatialPayload(ctx);
  const planPayload = await readArtifactPayload<AtlasPlanPayload>(ctx, ctx.batchByPhase.plan);
  const materializePayload = await readArtifactPayload<AtlasMaterializePayload>(ctx, ctx.batchByPhase.materialize);

  const manifest = run.manifest;
  const applyId = applyIdFor(ctx.workflowId, ctx.batchByPhase.materialize);
  const apply = manifest.applies[applyId];

  const projection = baseRunProjection(ctx, manifest.createdAt);
  const resolvedContext = contextPayload?.ctx ?? ctx.ctxSnapshot;
  projection.context_hash = resolvedContext.context_hash;
  projection.source_manifest = resolvedContext.source_manifest;
  const issues: string[] = [...(planPayload?.issues ?? [])];
  if (contextPayload) {
    projection.context_hash = contextPayload.ctx.context_hash;
    projection.source_manifest = contextPayload.ctx.source_manifest;
  }
  if (spatialPayload) {
    projection.spatial_evidence = spatialPayload.spatial as unknown as Record<string, unknown>;
  }
  const journal: unknown[] = [...(spatialPayload?.spatial.journal ?? []), ...(planPayload?.journal ?? [])];
  projection.journal = journal;

  if (run.status !== "completed") {
    if (planPayload?.plan) projection.atlas_plan = planPayload.plan;
    projection.planned_page_count = materializePayload?.plannedPageCount ?? 0;
    projection.status = "planning";
    projection.checkpoint = run.status;
    return {
      run: projection,
      ctx: resolvedContext,
      spatial: spatialPayload?.spatial ?? null,
      plan: planPayload?.plan ?? null,
      issues,
    };
  }

  const shortCircuit = planPayload?.shortCircuit;
  if (shortCircuit === "insufficient_sources") {
    failRunProjection(projection, "insufficient_sources", contextPayload?.ctx.message ?? "没有可核对的已采用地点。", "context");
    return { run: projection, ctx: resolvedContext, spatial: spatialPayload?.spatial ?? null, plan: planPayload?.plan ?? null, issues };
  }
  if (shortCircuit === "all_batches_failed") {
    failRunProjection(projection, "all_batches_failed", spatialPayload?.spatial.message ?? "空间事实提取全部批次失败。", "spatial");
    return { run: projection, ctx: resolvedContext, spatial: spatialPayload?.spatial ?? null, plan: planPayload?.plan ?? null, issues };
  }
  if (shortCircuit === "plan_validation_failed") {
    failRunProjection(projection, "plan_validation_failed", issues.join("; ") || "规划校验失败", "validate");
    return { run: projection, ctx: resolvedContext, spatial: spatialPayload?.spatial ?? null, plan: planPayload?.plan ?? null, issues };
  }

  if (apply !== undefined && apply.state === "rejected") {
    failRunProjection(projection, "materialize_rejected", apply.failure ?? "物化审批被拒", "materialize");
    return { run: projection, ctx: resolvedContext, spatial: spatialPayload?.spatial ?? null, plan: planPayload?.plan ?? null, issues, materializeApplyState: "rejected" };
  }
  if (apply !== undefined && apply.state === "failed") {
    failRunProjection(projection, "materialize_failed", apply.failure ?? "物化写面失败", "materialize");
    return { run: projection, ctx: resolvedContext, spatial: spatialPayload?.spatial ?? null, plan: planPayload?.plan ?? null, issues, materializeApplyState: "failed" };
  }

  // 正常 / no_changes / skipped(空候选): review_ready。
  if (planPayload) {
    projection.atlas_plan = planPayload.plan ?? { style_brief: "无变化", nodes: [] };
    const materialize = materializePayload ?? planMaterializePayload(ctx, planPayload);
    projection.planned_page_count = materialize.plannedPageCount;
  }
  projection.status = "review_ready";
  projection.checkpoint = "review_ready";
  return {
    run: projection,
    ctx: resolvedContext,
    spatial: spatialPayload?.spatial ?? null,
    plan: planPayload?.plan ?? null,
    issues,
    ...(apply !== undefined && (apply.state === "applied" || apply.state === "skipped") ? { materializeApplyState: apply.state } : {}),
  };
}

// —— 主入口 ——

/**
 * map-atlas 四阶段 durable driver(生产入口; planMapAtlas 的明确 durable 替换面)。
 * 启动前 recover 全 vault intents; 同输入+画像确定性 workflowId; resume 严格兼容;
 * provider_outcome_unknown 经 reauthorizeRemaining 重新授权后才重试; canonical apply
 * 走 RunApplyPort(独立审批 + canonical 事务 + 探针); 完成时写 `.assistant/atlas/runs/
 * <workflowId>.json` 投影(listAtlasHistory/latestAtlasRun 同读面)。
 *
 * 调用约定(N33):
 * - 同输入重复调用 = resume(零 provider 调用, 聚合已有 artifact); 输入/画像/契约版本
 *   任一变化 → 新 workflowId(不沿用旧 run); force → 每次全新 immutable run;
 * - 返回 outcome='completed' | 'provider_outcome_unknown' | 'apply_probe_unknown';
 *   provider_outcome_unknown 时重新授权后再 resume 即可重试该批。
 */
function previousManifestFromPrior(prior: readonly AtlasPriorNode[]): SourceRef[] {
  const byIdentity = new Map<string, SourceRef>();
  for (const node of prior) {
    for (const source of node.sources) {
      const key = canonicalRunJson({
        source_type: source.source_type,
        source_id: source.source_id,
        open_target: source.open_target,
      });
      if (!byIdentity.has(key)) byIdentity.set(key, source);
    }
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => structuredClone(source));
}

export async function runAtlasWorkflow(
  root: string,
  options: AtlasWorkflowOptions,
  runtime: AtlasWorkflowRuntime,
): Promise<AtlasWorkflowResult> {
  // N33/ADR-0023: 非 secret 执行画像指纹强制(fail-closed, 无指纹不启动)。
  if (runtime.profileFingerprint === undefined || !/^[0-9a-f]{64}$/.test(runtime.profileFingerprint)) {
    throw new Error("runAtlasWorkflow 必须携带 ExecutionProfile 指纹(profileFingerprint, N33 强制)");
  }
  if (!(["initial", "update", "rebuild", "upload"] as RunKind[]).includes(options.run_kind)) {
    throw new Error(`run_kind 非法: ${options.run_kind}`);
  }

  // 1) 启动前 recover 全 vault durable intents(ADR-0022 §4: intent 先于 manifest;
  //    未收敛 → fail-closed)。
  const recovery = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
  if (recovery.unresolved.length > 0) {
    throw new Error(`存在未收敛 durable intent, 拒绝启动(fail-closed): ${recovery.unresolved.join(", ")}`);
  }

  // 2) 确定性 ctx 预编译(compileAtlasContext 确定性, 指纹输入; 不含 secret)。
  const ctxSnapshot = await compileAtlasContext(root, {
    include_working_drafts: options.include_working_drafts,
    include_interiors: options.include_interiors,
    style_note: options.style_note,
  });

  // 3) 启动时冻结 prior atlas/update baseline，并与画像/源/options/契约一起进入指纹。
  const priorTree = readAtlasTree(root);
  const priorAtlasSnapshot = buildPriorAtlas({
    ...priorTree,
    nodes: priorTree.nodes.filter((node) => node.status === "adopted"),
  });
  // update 基线只来自已采用 canonical atlas；latest projection 是可变派生状态，绝不参与 resume。
  const previousSourceManifest = previousManifestFromPrior(priorAtlasSnapshot);
  const priorAtlasFingerprint = workflowSha256(canonicalRunJson({ priorAtlasSnapshot, previousSourceManifest }));
  const contractVersions = sortedMerge(ATLAS_CONTRACT_DEFAULTS, runtime.contractVersions);
  const inputFingerprint = atlasInputFingerprint(
    ctxSnapshot,
    options,
    contractVersions,
    runtime.profileFingerprint,
    priorAtlasFingerprint,
  );
  const uniqueRunId = options.force === true
    ? `${options.runId ?? "atlas-force"}-${randomUUID()}`
    : options.runId ?? "atlas-standard";
  const spec = buildAtlasWorkflowSpec({
    ctx: ctxSnapshot,
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    uniqueRunId,
  });
  const identityInput = {
    kind: "map-atlas" as const,
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    planDigest: planDigestOf(spec),
    uniqueRunId,
    /// createdAt 缺省由 identity 生成(确定性 run 投影键)。
  };
  const identity = createWorkflowIdentity(identityInput);
  const workflowId = identity.workflowId;
  if (options.resumeWorkflowId !== undefined && options.resumeWorkflowId !== workflowId) {
    throw new Error(`resume identity 不兼容: expected ${options.resumeWorkflowId}, derived ${workflowId}`);
  }
  const expected = {
    workflowId,
    kind: "map-atlas" as const,
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    planDigest: identity.planDigest,
  };

  const ctx = buildAtlasDriverContext(
    root,
    options,
    runtime,
    spec,
    inputFingerprint,
    workflowId,
    ctxSnapshot,
    priorAtlasSnapshot,
    previousSourceManifest,
  );
  const hasExistingRun = await ctx.persistence.hasRun(workflowId);
  if (options.resumeWorkflowId !== undefined && !hasExistingRun) {
    throw new Error(`resume run 不存在: ${workflowId}`);
  }
  const ports: RunEnginePorts = { persistence: ctx.persistence, generator: makeGenerator(ctx), apply: makeApplyPort(ctx) };

  // 4) start 或 resume(同 workflowId 已存在 → resume, 绝不覆盖旧 run)。
  let run = hasExistingRun
    ? await atlasWorkflowEngineSeam.runWorkflow(ports, { mode: "resume", workflowId, expected })
    : await atlasWorkflowEngineSeam.runWorkflow(ports, { mode: "start", spec });

  // 5) provider_outcome_unknown: 不自动重调; 经重新授权(allowed-once)后才 resume 重试。
  if (run.status === "provider_outcome_unknown" && runtime.reauthorizeRemaining !== undefined) {
    const batches = run.remainingBatchIds
      .map((batchId) => ({ batchId, phase: ctx.phaseByBatch[batchId] ?? "?" }))
      .filter((batch) => batch.phase.startsWith("spatial-") || batch.phase === "plan");
    const unknownCount = run.providerOutcomeUnknown.length;
    const estimate = `预计 ${batches.length} 个剩余 LLM 批(其中 ${unknownCount} 批结果未知; ${batches.map((b) => b.phase).join("/")}); 已完成批次不会重复执行`;
    const decision = await runtime.reauthorizeRemaining({ workflowId, batches, estimate });
    if (decision === "allowed-once") {
      run = await atlasWorkflowEngineSeam.runWorkflow(ports, { mode: "resume", workflowId, expected, retryOutcomeUnknown: true });
    }
  }

  // 6) 聚合(已提交 artifact → 投影; 中断时 best-effort)。
  const aggregate = await aggregateRun(ctx, run);

  // 7) 终局完成的 run 投影落盘(run JSON; idempotent, 字节一致则跳过)。
  if (run.status === "completed") {
    await writeRunProjection(root, workflowId, aggregate.run, ctx.persistence, ctx.transactionOptions);
  }

  return {
    workflowId,
    kind: "map-atlas",
    inputFingerprint,
    profileFingerprint: runtime.profileFingerprint,
    outcome: run.status === "completed" ? "completed" : run.status === "apply_probe_unknown" ? "apply_probe_unknown" : "provider_outcome_unknown",
    run: aggregate.run,
    ctx: aggregate.ctx,
    spatial: aggregate.spatial,
    plan: aggregate.plan,
    issues: aggregate.issues,
    remainingBatchIds: run.remainingBatchIds,
    providerOutcomeUnknown: run.providerOutcomeUnknown,
    applyProbeUnknown: run.applyProbeUnknown,
    reappliedApplyIds: run.reappliedApplyIds,
    manifest: run.manifest,
  };
}

/** 显式 resume：精确 workflowId + 完整派生 identity，不兼容/不存在时 fail-closed 且绝不新建。 */
export async function resumeAtlasWorkflow(
  root: string,
  workflowId: string,
  options: Omit<AtlasWorkflowOptions, "force" | "resumeWorkflowId">,
  runtime: AtlasWorkflowRuntime,
): Promise<AtlasWorkflowResult> {
  return runAtlasWorkflow(root, { ...options, force: false, resumeWorkflowId: workflowId }, runtime);
}

/** 完成态兼容投影也走 state 事务 + committed run-plan capability，禁止共享 index 裸写。 */
async function writeRunProjection(
  root: string,
  runId: string,
  run: AtlasRun,
  persistence: GitRunPersistence,
  transactionOptions: TransactionOptions,
): Promise<void> {
  const file = paths(root).assistant.atlas.runFile(runId);
  const current = readFileIfExists(file);
  const next = `${JSON.stringify(run, null, 2)}\n`;
  if (current !== undefined && bytesToUtf8(current) === next) return;
  const rel = `.assistant/atlas/runs/${runId}.json`;
  await executeTransaction(root, {
    kind: "state",
    purpose: `map-atlas completed projection ${runId}`,
    planSource: persistence.committedPlanSource(runId),
    writeSet: [{
      path: rel,
      expected: current === undefined
        ? { absent: true, sha256: "" }
        : { absent: false, sha256: sha256Hex(current) },
      output: next,
    }],
  }, transactionOptions);
}
