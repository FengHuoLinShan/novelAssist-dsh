// N33 / ADR-0022 — 通用生产 run engine(注入 PersistencePort/Generator/ApplyPort)。
//
// 只做加法(铁律 4): 不触碰 orchestrate.ts / dsh; 复用 run-model 的类型、确定性派生与
// fail-closed 校验(含复审 R1–R6 语义)。引擎语义逐条对应 ADR-0022:
// - 确定性 manifest/batches: 同 spec 恒同 workflowId/batchId/planDigest; force 只允许
//   新 identity(内部 nonce 全新生成)且 expected-absent(唯一权威), 绝不覆盖旧 run(§1/§4);
// - artifact bytes 与 receipt 分离, 且顺序固定: artifact → receipt(同一 state transaction
//   的计划输出, 不存在 receipt 先单独落盘的时点)→ cursor(独立 state transaction)(§2/§3);
// - provider outcome unknown(批次计划已提交、无 durable intent、无 artifact)→ 写
//   provider_outcome_unknown 状态后停止, 绝不自动 retry; 仅显式 retryOutcomeUnknown
//   重新授权后才重试该批(§5.0/§8);
// - resume: 先收敛全部 durable intents(补完同一事务, 不主动回滚; run_bootstrap intent
//   无已提交 plan 也不死锁), 再严格 manifest/profile/contract 兼容(assertManifestCompatible
//   全 identity 精确匹配 + run plan digest 重建对账), 校验已完成批次 artifact hash/receipt/
//   cursor(损坏 fail-closed, 绝不盲重写), 跳过 completed, 从首不完整继续(§4/§5);
// - apply 状态机: waiting_approval → applying(transactionId durable 先写)→ applied
//   (注入 commitEvidence, commitOid 验证且逐字段绑定); 崩溃恢复按 transaction probe:
//   completed → 补 applied(不重复审批/写入); none → 持久退回 waiting_approval(tx 字段
//   清空, 下次必须重新审批, 旧 decision 不复用); unknown → 保留 applying 现场
//   fail-closed, 绝不盲重写(§6/§7 / 复审 R4);
// - 每次持久化调用 = 一个 state transaction port 调用, 顺序记录于 stateTxLog(§3);
// - 接口不接 secret(运行时拒绝 secret 形字段, 铁律 6); 引擎自身产出对象 deep-frozen。
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '@novelcraft/trace';
import {
  WORKFLOW_RUN_VERSION,
  advanceApplyState,
  assertExpectedAbsent,
  assertManifestCompatible,
  batchPaths,
  canonicalRunJson,
  createForcedWorkflowIdentity,
  createWorkflowIdentity,
  makeBatchPlan,
  makeBatchReceipt,
  serializeBatchArtifact,
  workflowRunRoot,
  workflowSha256,
  type ApplyRecord,
  type BatchManifestEntry,
  type BatchPlan,
  type ManifestStatus,
  type ReadonlyBytes,
  type WorkflowIdentity,
  type WorkflowIdentityExpectation,
  type WorkflowKind,
  type WorkflowManifest,
} from './run-model.js';

export const RUN_PLAN_VERSION = 1;
/** apply probe=none 回退后重新审批的轮次上限, 超出 fail-closed。 */
export const MAX_APPLY_ROLLBACKS = 8;

// —— 公开类型(只做加法) ——

export interface ApplyTargetSpec {
  /** vault 相对目标路径(writeSet 目标; 拒绝绝对路径/traversal)。 */
  readonly target: string;
  /** 生成/计划时钉定的 expected state(目标内容 sha256; 审批时不得刷新, ADR-0022 §6)。 */
  readonly expectedHash: string;
  /** approval unavailable 时的落点; 默认 rejected(绝不静默 apply)。 */
  readonly onApprovalUnavailable?: 'rejected' | 'skipped';
}

export interface RunBatchSpec {
  readonly phase: string;
  readonly ordinal: number;
  readonly sourceIds: readonly string[];
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly outputSchemaVersion?: string;
  readonly apply?: ApplyTargetSpec;
}

export interface RunEngineSpec {
  readonly kind: WorkflowKind;
  /** sha256: 源内容 + policy 等(调用方计算; 不含 secret)。 */
  readonly inputFingerprint: string;
  /** sha256: 非 secret execution profile(模型名/参数/预算等)。 */
  readonly profileFingerprint: string;
  /** 调用方确定性 unique run 种子(force 时仅作 provenance 前缀, 每次仍全新生成)。 */
  readonly uniqueRunId: string;
  readonly batches: readonly RunBatchSpec[];
  readonly createdAt?: string;
}

/** 已提交 run plan 文档(bootstrap state transaction 计划输出之一)。 */
export interface RunPlanDocument {
  readonly version: 1;
  readonly workflowId: string;
  readonly kind: WorkflowKind;
  readonly inputFingerprint: string;
  readonly profileFingerprint: string;
  readonly planDigest: string;
  readonly createdAt: string;
  readonly batches: readonly RunBatchSpec[];
}

/** manifest + canonical apply 独立分节(ADR-0022 §2/§6)。 */
export type RunWorkflowManifest = WorkflowManifest & {
  readonly applies: Readonly<Record<string, ApplyRecord>>;
};

/** 每个 state transaction 的计划输出 + 随事务推进的 manifest(原子、durable)。 */
export type RunStateTransaction =
  | {
      readonly kind: 'bootstrap';
      readonly txid: string;
      readonly workflowId: string;
      readonly runPlanPath: string;
      readonly runPlan: ReadonlyBytes;
      readonly manifest: RunWorkflowManifest;
    }
  | {
      readonly kind: 'batch-plan';
      readonly txid: string;
      readonly workflowId: string;
      readonly batchId: string;
      readonly path: string;
      readonly plan: BatchPlan;
      readonly bytes: ReadonlyBytes;
      readonly manifest: RunWorkflowManifest;
    }
  | {
      readonly kind: 'artifact-receipt';
      readonly txid: string;
      readonly workflowId: string;
      readonly batchId: string;
      readonly artifactPath: string;
      readonly artifactBytes: ReadonlyBytes;
      readonly receiptPath: string;
      readonly receiptBytes: ReadonlyBytes;
      readonly manifest: RunWorkflowManifest;
    }
  | {
      readonly kind: 'cursor';
      readonly txid: string;
      readonly workflowId: string;
      readonly batchId: string;
      readonly manifest: RunWorkflowManifest;
    }
  | {
      readonly kind: 'run-status';
      readonly txid: string;
      readonly workflowId: string;
      readonly manifest: RunWorkflowManifest;
    }
  | {
      readonly kind: 'apply';
      readonly txid: string;
      readonly workflowId: string;
      readonly applyId: string;
      readonly manifest: RunWorkflowManifest;
    };

/** 未收敛 durable transaction intent(窗口一锚点; 恢复时补完同一事务)。 */
export interface DurableIntent {
  readonly txid: string;
  readonly tx: RunStateTransaction;
  readonly createdAt: string;
}

/**
 * 每次调用 = 一个 state transaction(ADR-0021 契约: intent 先于任何写入耐久化;
 * 同 txid 重放 = 补完同一事务, 冲突 fail-closed)。
 */
export interface RunPersistencePort {
  /** 该 workflowId 是否已有 run(expected-absent 门禁)。 */
  hasRun(workflowId: string): Promise<boolean>;
  /** 读取 run 状态: manifest + run plan + 全部未收敛 durable intents。 */
  loadRunState(workflowId: string): Promise<{
    manifest?: RunWorkflowManifest;
    runPlan?: ReadonlyBytes;
    intents: readonly DurableIntent[];
  }>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  applyState(tx: RunStateTransaction): Promise<RunWorkflowManifest>;
}

export interface RunGeneratorInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly phase: string;
  readonly ordinal: number;
  readonly inputFingerprint: string;
  readonly sourceIds: readonly string[];
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly outputSchemaVersion: string;
}

export interface RunGeneratorOutput<T = unknown> {
  readonly payload: T;
  /** Cumulative budget consumed after producing this artifact (monotonic, durable). */
  readonly budgetSpent?: number;
}

/** provider 生成端口(engine 不持凭据; 输入输出均无 secret 通道)。 */
export class RunGeneratorTerminalError extends Error {
  constructor(readonly code: 'budget_exceeded', message: string) {
    super(message);
    this.name = 'RunGeneratorTerminalError';
  }
}

export interface RunGeneratorPort {
  generate(input: RunGeneratorInput): Promise<RunGeneratorOutput>;
  /** Current cumulative spend, including a provider attempt whose outcome became unknown. */
  budgetSpent?(): number | undefined;
}

export interface ApplyApprovalRequest {
  readonly applyId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly target: string;
  readonly summary: string;
  readonly items: readonly string[];
}

export interface ApplyCanonicalRequest {
  readonly applyId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly transactionId: string;
  readonly target: string;
  readonly expectedHash: string;
  readonly artifactHash: string;
  readonly writeSetDigest: string;
  readonly checkpoint: string;
  readonly planDigest: string;
  readonly provenance: string;
}

/** canonical 事务探针结果(只读判定, 不产生副作用)。 */
export type ApplyProbe =
  | { readonly state: 'completed'; readonly commitOid: string }
  | { readonly state: 'none' }
  | { readonly state: 'unknown' };

/** canonical apply 端口: 审批(decision/token 不落盘)+ ADR-0021 canonical 事务 + 探针。 */
export interface RunApplyPort {
  requestApproval(input: ApplyApprovalRequest): Promise<ApprovalDecision>;
  execute(input: ApplyCanonicalRequest): Promise<{ readonly commitOid: string }>;
  probe(transactionId: string): Promise<ApplyProbe>;
}

export interface RunEnginePorts {
  readonly persistence: RunPersistencePort;
  readonly generator: RunGeneratorPort;
  /** 任一批次含 apply 目标时必须注入。 */
  readonly apply?: RunApplyPort;
}

export interface StartRunOptions {
  readonly mode: 'start';
  readonly spec: RunEngineSpec;
  /** force = 每次生成全新 identity(nonce)且 expected-absent, 绝不覆盖旧 run(ADR-0022 §4)。 */
  readonly force?: boolean;
  /** 调用方已知的既有 workflowId 集合(expected-absent 门禁之一)。 */
  readonly existingIds?: ReadonlySet<string> | readonly string[];
}

export interface ResumeRunOptions {
  readonly mode: 'resume';
  readonly workflowId: string;
  /** 完整身份期望(workflowId + 全部 identity 字段; 逐字段精确匹配, 复审 R3)。 */
  readonly expected: WorkflowIdentityExpectation;
  /** 显式重新授权后才允许重跑 provider_outcome_unknown 批次; 缺省 false = 写状态后停止。 */
  readonly retryOutcomeUnknown?: boolean;
}

export type RunWorkflowOptions = StartRunOptions | ResumeRunOptions;

export interface RunEngineResult {
  readonly workflowId: string;
  readonly status: 'completed' | 'provider_outcome_unknown' | 'apply_probe_unknown';
  readonly completedBatchIds: readonly string[];
  readonly providerOutcomeUnknown: readonly string[];
  readonly remainingBatchIds: readonly string[];
  /** probe=unknown 保留现场 fail-closed 的 apply(绝不盲重写)。 */
  readonly applyProbeUnknown: readonly string[];
  /** probe=none 持久退回 waiting_approval 的 apply(下次必须重新审批)。 */
  readonly reappliedApplyIds: readonly string[];
  /** 每次持久化调用 = 一个 state transaction port 调用, 按顺序记录。 */
  readonly stateTxLog: readonly string[];
  readonly manifest: RunWorkflowManifest;
}

export class RunEngineError extends Error {
  constructor(
    readonly code: 'corruption' | 'incompatible' | 'conflict' | 'invalid' | 'missing' | 'apply',
    message: string,
  ) {
    super(message);
    this.name = 'RunEngineError';
  }
}

/** canonical apply 的确定性写面失败(CAS 冲突等): 终态 failed, 不重写、不重审批。 */
export class ApplyCanonicalError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'ApplyCanonicalError';
  }
}

// —— 工具 ——

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value; // typed array/buffer 不冻结
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function sortedObject(input: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key];
  return out;
}

// —— secret 防护(铁律 6; 权威持久化防护在 run-model, 这里拒绝接口入参) ——
const DENIED_SECRET_SEGMENTS = new Set<string>([
  'key', 'token', 'bearer', 'authorization', 'password', 'passwd', 'secret',
  'credential', 'auth', 'jwt', 'cookie', 'signing', 'apikey', 'preshared',
]);

function assertNoSecretKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretKeys(item, `${path}[${i}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new RunEngineError('invalid', `${path} 只接受 plain object`);
  }
  for (const [key, child] of Object.entries(value)) {
    const segments = key
      .replace(/[^A-Za-z0-9]/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/)
      .filter((s) => s.length > 0);
    if (segments.some((s) => DENIED_SECRET_SEGMENTS.has(s))) {
      throw new RunEngineError('invalid', `${path}.${key} 禁止 secret 形字段(接口不接 secret)`);
    }
    assertNoSecretKeys(child, `${path}.${key}`);
  }
}

function assertSafeTargetPath(target: string): void {
  if (typeof target !== 'string' || target.length === 0 || target.length > 512) {
    throw new RunEngineError('invalid', 'apply 目标路径非法');
  }
  if (target.startsWith('/') || target.includes('\\') || target.includes('..') || target.includes(':')) {
    throw new RunEngineError('invalid', 'apply 目标路径非法(拒绝绝对路径/traversal)');
  }
  for (const segment of target.split('/')) {
    if (!TARGET_SEGMENT_RE.test(segment)) throw new RunEngineError('invalid', `apply 目标路径段非法: ${segment}`);
  }
}

function assertValidBatchSpecs(batches: readonly RunBatchSpec[]): void {
  if (!Array.isArray(batches)) throw new RunEngineError('invalid', 'batches 必须是数组');
  const seen = new Set<number>();
  for (const batch of batches) {
    if (batch === null || typeof batch !== 'object') throw new RunEngineError('invalid', 'batch spec 非法');
    if (typeof batch.phase !== 'string' || !PHASE_RE.test(batch.phase)) throw new RunEngineError('invalid', 'phase 非法');
    if (!Number.isSafeInteger(batch.ordinal) || batch.ordinal < 0) throw new RunEngineError('invalid', 'ordinal 非法');
    if (seen.has(batch.ordinal)) throw new RunEngineError('invalid', `ordinal ${batch.ordinal} 重复`);
    seen.add(batch.ordinal);
    if (!Array.isArray(batch.sourceIds) || new Set(batch.sourceIds).size !== batch.sourceIds.length) {
      throw new RunEngineError('invalid', 'sourceIds 非法/重复');
    }
    for (const id of batch.sourceIds) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new RunEngineError('invalid', 'sourceId 非法');
    }
    if (batch.sourceHashes === null || typeof batch.sourceHashes !== 'object' || Array.isArray(batch.sourceHashes)) {
      throw new RunEngineError('invalid', 'sourceHashes 非法');
    }
    for (const id of Object.keys(batch.sourceHashes)) {
      if (!batch.sourceIds.includes(id)) throw new RunEngineError('invalid', `sourceHashes 含计划外 source: ${id}`);
      const hash = batch.sourceHashes[id];
      if (typeof hash !== 'string' || !SHA256_RE.test(hash)) throw new RunEngineError('invalid', `sourceHashes.${id} 必须 sha256`);
    }
    if (Object.keys(batch.sourceHashes).length !== batch.sourceIds.length) {
      throw new RunEngineError('invalid', '每个 sourceId 必须有 hash');
    }
    if (batch.outputSchemaVersion !== undefined && !SCHEMA_VERSION_RE.test(batch.outputSchemaVersion)) {
      throw new RunEngineError('invalid', 'outputSchemaVersion 非法');
    }
    if (batch.apply !== undefined) {
      assertSafeTargetPath(batch.apply.target);
      if (typeof batch.apply.expectedHash !== 'string' || !SHA256_RE.test(batch.apply.expectedHash)) {
        throw new RunEngineError('invalid', 'apply.expectedHash 必须 sha256');
      }
      if (
        batch.apply.onApprovalUnavailable !== undefined
        && batch.apply.onApprovalUnavailable !== 'rejected'
        && batch.apply.onApprovalUnavailable !== 'skipped'
      ) {
        throw new RunEngineError('invalid', 'apply.onApprovalUnavailable 非法');
      }
    }
  }
}

/** 规范化批次(sort ordinal / sort source 集合 / 默认 outputSchemaVersion 与 apply 落点)。 */
function normalizeBatchSpecs(batches: readonly RunBatchSpec[]): readonly RunBatchSpec[] {
  assertValidBatchSpecs(batches);
  return [...batches]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((batch) =>
      deepFreeze({
        phase: batch.phase,
        ordinal: batch.ordinal,
        sourceIds: [...batch.sourceIds].sort(),
        sourceHashes: sortedObject(batch.sourceHashes),
        outputSchemaVersion: batch.outputSchemaVersion ?? '1',
        ...(batch.apply !== undefined
          ? {
              apply: deepFreeze({
                target: batch.apply.target,
                expectedHash: batch.apply.expectedHash,
                onApprovalUnavailable: batch.apply.onApprovalUnavailable ?? 'rejected',
              }),
            }
          : {}),
      }),
    );
}

/**
 * 确定性 plan digest(ADR-0022 §1 自描述 plan digest): 同 spec 恒同;
 * 输入指纹变化 / 批次结构变化 / schema 版本变化都改变 digest。
 */
export function planDigestOf(spec: RunEngineSpec): string {
  assertNoSecretKeys(spec, '$');
  const batches = normalizeBatchSpecs(spec.batches);
  return workflowSha256(
    canonicalRunJson({
      version: RUN_PLAN_VERSION,
      kind: spec.kind,
      inputFingerprint: spec.inputFingerprint,
      batches,
    }),
  );
}

/** 确定性 applyId(workflowId + batchId)。 */
export function applyIdFor(workflowId: string, batchId: string): string {
  return `apply-${workflowSha256(canonicalRunJson({ workflowId, batchId })).slice(0, 32)}`;
}

/** applying 事务的确定性 transactionId(probe/execute 绑定; 恢复时按此寻址)。 */
export function applyTransactionId(workflowId: string, applyId: string): string {
  return txidFor('apply', workflowId, applyId, 'applying');
}

function txidFor(kind: string, workflowId: string, id: string, state?: string): string {
  const seed = state === undefined ? { kind, workflowId, id } : { kind, workflowId, id, state };
  return `tx-${workflowSha256(canonicalRunJson(seed)).slice(0, 40)}`;
}

// —— 确定性 run plan / manifest 构建 ——

interface BuiltRunPlan {
  readonly manifest: RunWorkflowManifest;
  readonly runPlanPath: string;
  readonly runPlanBytes: ReadonlyBytes;
  readonly runPlan: RunPlanDocument;
  readonly batchPlans: Readonly<Record<string, BatchPlan>>;
  readonly paths: Readonly<Record<string, { planPath: string; artifactPath: string; receiptPath: string }>>;
  readonly specsByBatch: Readonly<Record<string, RunBatchSpec>>;
  readonly orderedBatchIds: readonly string[];
}

const INITIAL_RUN_CURSOR = deepFreeze({ phase: 'start', ordinal: 0 });

function buildRunPlan(identity: WorkflowIdentity, spec: RunEngineSpec): BuiltRunPlan {
  const normalized = normalizeBatchSpecs(spec.batches);
  const batchPlans: Record<string, BatchPlan> = {};
  const paths: Record<string, { planPath: string; artifactPath: string; receiptPath: string }> = {};
  const specsByBatch: Record<string, RunBatchSpec> = {};
  for (const batch of normalized) {
    const plan = makeBatchPlan({
      workflowId: identity.workflowId,
      phase: batch.phase,
      ordinal: batch.ordinal,
      inputFingerprint: spec.inputFingerprint,
      sourceIds: batch.sourceIds,
      sourceHashes: batch.sourceHashes,
    });
    batchPlans[plan.batchId] = plan;
    specsByBatch[plan.batchId] = batch;
    paths[plan.batchId] = batchPaths(identity.kind, plan);
  }
  const batches: Record<string, BatchManifestEntry> = {};
  for (const [batchId, plan] of Object.entries(batchPlans)) {
    batches[batchId] = deepFreeze({
      batchId,
      phase: plan.phase,
      ordinal: plan.ordinal,
      state: 'planned',
      ...paths[batchId],
    });
  }
  const manifest: RunWorkflowManifest = deepFreeze({
    version: WORKFLOW_RUN_VERSION,
    workflowId: identity.workflowId,
    kind: identity.kind,
    createdAt: identity.createdAt,
    inputFingerprint: identity.inputFingerprint,
    profileFingerprint: identity.profileFingerprint,
    planDigest: identity.planDigest,
    status: 'planning',
    cursor: INITIAL_RUN_CURSOR,
    budgetSpent: 0,
    batches,
    applies: {},
  });
  const runPlan: RunPlanDocument = deepFreeze({
    version: RUN_PLAN_VERSION,
    workflowId: identity.workflowId,
    kind: identity.kind,
    inputFingerprint: identity.inputFingerprint,
    profileFingerprint: identity.profileFingerprint,
    planDigest: identity.planDigest,
    createdAt: identity.createdAt,
    batches: normalized,
  });
  const runPlanPath = `${workflowRunRoot(identity.kind, identity.workflowId)}/run-plan.json`;
  const runPlanBytes = Buffer.from(`${canonicalRunJson(runPlan)}\n`, 'utf8');
  return deepFreeze({
    manifest,
    runPlanPath,
    runPlanBytes,
    runPlan,
    batchPlans: deepFreeze(batchPlans),
    paths: deepFreeze(paths),
    specsByBatch: deepFreeze(specsByBatch),
    orderedBatchIds: deepFreeze(Object.keys(batchPlans)),
  });
}

// —— engine 上下文 ——

class RunContext {
  readonly ports: RunEnginePorts;
  readonly identity: WorkflowIdentity;
  readonly runPlan: RunPlanDocument;
  readonly runPlanPath: string;
  readonly batchPlans: Readonly<Record<string, BatchPlan>>;
  readonly paths: Readonly<Record<string, { planPath: string; artifactPath: string; receiptPath: string }>>;
  readonly specsByBatch: Readonly<Record<string, RunBatchSpec>>;
  readonly orderedBatchIds: readonly string[];
  manifest: RunWorkflowManifest;
  readonly stateTxLog: string[] = [];
  private txCounter = 0;

  constructor(ports: RunEnginePorts, built: BuiltRunPlan, identity: WorkflowIdentity) {
    this.ports = ports;
    this.identity = identity;
    this.manifest = built.manifest;
    this.runPlan = built.runPlan;
    this.runPlanPath = built.runPlanPath;
    this.batchPlans = built.batchPlans;
    this.paths = built.paths;
    this.specsByBatch = built.specsByBatch;
    this.orderedBatchIds = built.orderedBatchIds;
  }

  get workflowId(): string {
    return this.manifest.workflowId;
  }

  /** resume: 以已提交 manifest 为推进基线(built 只提供确定性派生, 不替代持久状态)。 */
  withPersistedManifest(manifest: RunWorkflowManifest): this {
    this.manifest = manifest;
    return this;
  }

  /** 有稳定 id 的 state transaction 用确定性 txid; 其余用单调计数(恢复复用 intent txid)。 */
  txidFor(kind: string, id: string, state?: string): string {
    return txidFor(kind, this.workflowId, id, state);
  }

  /** 无稳定身份的事务(apply 状态/run-status 等): 每次全新 txid(nonce 防跨调用撞车)。 */
  nextAnonymousTxid(kind: string): string {
    const seed = { kind, workflowId: this.workflowId, n: ++this.txCounter, nonce: randomUUID() };
    return `tx-${workflowSha256(canonicalRunJson(seed)).slice(0, 40)}`;
  }

  /** 每次持久化调用 = 一个 state transaction port 调用, 按顺序记录。 */
  async state(tx: RunStateTransaction, label: string): Promise<void> {
    this.stateTxLog.push(label);
    this.manifest = await this.ports.persistence.applyState(deepFreeze(tx));
  }
}

function makeResumeContext(ports: RunEnginePorts, manifest: RunWorkflowManifest, runPlanBytes: ReadonlyBytes): RunContext {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(runPlanBytes).toString('utf8'));
  } catch {
    throw new RunEngineError('corruption', 'run plan 无法解析, 拒绝恢复');
  }
  if (doc === null || typeof doc !== 'object' || !('version' in doc) || !('workflowId' in doc) || !('kind' in doc)
    || !('inputFingerprint' in doc) || !('profileFingerprint' in doc) || !('planDigest' in doc)
    || !('createdAt' in doc) || !('batches' in doc)) {
    throw new RunEngineError('corruption', 'run plan 字段缺失, 拒绝恢复');
  }
  const plan = doc as unknown as RunPlanDocument;
  if (plan.version !== RUN_PLAN_VERSION) throw new RunEngineError('corruption', 'run plan version 不兼容');
  if (plan.workflowId !== manifest.workflowId || plan.kind !== manifest.kind
    || plan.inputFingerprint !== manifest.inputFingerprint || plan.profileFingerprint !== manifest.profileFingerprint
    || plan.planDigest !== manifest.planDigest || plan.createdAt !== manifest.createdAt) {
    throw new RunEngineError('corruption', 'run plan 与 manifest identity 不符, 拒绝恢复');
  }
  // plan digest 重建对账(严格 contract 兼容)
  const rebuilt = planDigestOf({
    kind: plan.kind,
    inputFingerprint: plan.inputFingerprint,
    profileFingerprint: plan.profileFingerprint,
    uniqueRunId: 'resume-check',
    batches: plan.batches,
  });
  if (rebuilt !== plan.planDigest) throw new RunEngineError('corruption', 'run plan digest 重建不符, 拒绝恢复');
  const identity: WorkflowIdentity = deepFreeze({
    version: 1,
    workflowId: manifest.workflowId,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    inputFingerprint: manifest.inputFingerprint,
    profileFingerprint: manifest.profileFingerprint,
    planDigest: manifest.planDigest,
  });
  const built = buildRunPlan(identity, {
    kind: plan.kind,
    inputFingerprint: plan.inputFingerprint,
    profileFingerprint: plan.profileFingerprint,
    uniqueRunId: 'resume-check',
    batches: plan.batches,
  });
  // manifest 与确定性重建对账(篡改 fail-closed)
  const derivedIds = Object.keys(built.batchPlans).sort();
  const manifestIds = Object.keys(manifest.batches).sort();
  if (derivedIds.length !== manifestIds.length || derivedIds.some((id, i) => id !== manifestIds[i])) {
    throw new RunEngineError('corruption', 'manifest 批次与已提交 run plan 不符, 拒绝恢复');
  }
  for (const id of derivedIds) {
    const entry = manifest.batches[id];
    const planEntry = built.batchPlans[id];
    if (entry.batchId !== id || entry.phase !== planEntry.phase || entry.ordinal !== planEntry.ordinal) {
      throw new RunEngineError('corruption', `批次 ${id} 与已提交 run plan 不符, 拒绝恢复`);
    }
  }
  return new RunContext(ports, built, identity).withPersistedManifest(manifest);
}

function assertIntentValid(intent: DurableIntent, workflowId: string): void {
  if (intent === null || typeof intent !== 'object') throw new RunEngineError('corruption', 'durable intent 非法');
  const tx = intent.tx;
  if (tx === null || typeof tx !== 'object' || intent.txid !== tx.txid || tx.workflowId !== workflowId) {
    throw new RunEngineError('corruption', 'durable intent identity 无法验证, 保留现场 fail-closed');
  }
  switch (tx.kind) {
    case 'bootstrap':
      if (!(tx.runPlan instanceof Uint8Array) || tx.manifest === null || typeof tx.manifest !== 'object') {
        throw new RunEngineError('corruption', 'bootstrap intent 计划输出无法验证, fail-closed');
      }
      return;
    case 'batch-plan':
      if (typeof tx.batchId !== 'string' || typeof tx.path !== 'string' || !(tx.bytes instanceof Uint8Array)
        || tx.plan === null || typeof tx.plan !== 'object') {
        throw new RunEngineError('corruption', 'batch-plan intent 计划输出无法验证, fail-closed');
      }
      return;
    case 'artifact-receipt':
      if (typeof tx.batchId !== 'string' || typeof tx.artifactPath !== 'string' || !(tx.artifactBytes instanceof Uint8Array)
        || typeof tx.receiptPath !== 'string' || !(tx.receiptBytes instanceof Uint8Array)) {
        throw new RunEngineError('corruption', 'artifact-receipt intent 计划输出无法验证, fail-closed');
      }
      return;
    case 'cursor':
      if (typeof tx.batchId !== 'string') throw new RunEngineError('corruption', 'cursor intent batchId 缺失, fail-closed');
      return;
    case 'run-status':
      return;
    case 'apply':
      if (typeof tx.applyId !== 'string') throw new RunEngineError('corruption', 'apply intent applyId 缺失, fail-closed');
      return;
    default:
      throw new RunEngineError('corruption', `未知 intent kind, 保留现场 fail-closed: ${(tx as { kind?: string }).kind}`);
  }
}

function withApply(manifest: RunWorkflowManifest, record: ApplyRecord): RunWorkflowManifest {
  return { ...manifest, applies: { ...manifest.applies, [record.applyId]: record } };
}

/** apply plan 确定性绑定字段(复审 R4: ApplyRecord 要求全部身份字段)。 */
function applyPlanBindings(
  workflowId: string,
  batchId: string,
  target: string,
  expectedHash: string,
  artifactHash: string,
  planDigest: string,
): { writeSetDigest: string; checkpoint: string; provenance: string } {
  const writeSetDigest = workflowSha256(canonicalRunJson({ target, expectedHash, artifactHash }));
  const checkpoint = workflowSha256(canonicalRunJson({ workflowId, batchId, artifactHash }));
  const provenance = `prov-${workflowSha256(canonicalRunJson({ workflowId, batchId })).slice(0, 32)}`;
  return { writeSetDigest, checkpoint, provenance };
}

// —— 引擎主流程 ——

/**
 * 通用生产 run engine 入口。
 * - mode 'start': 确定性 bootstrap(全目标 expected absent)+ 逐批执行;
 * - mode 'resume': 收敛 intents → 严格兼容校验 → 校验已完成批次 → 从首不完整继续。
 */
export async function runWorkflow(ports: RunEnginePorts, options: RunWorkflowOptions): Promise<RunEngineResult> {
  if (options.mode === 'start') return runStart(ports, options);
  return runResume(ports, options);
}

async function runStart(ports: RunEnginePorts, options: StartRunOptions): Promise<RunEngineResult> {
  const spec = options.spec;
  assertNoSecretKeys(spec, '$');
  const planDigest = planDigestOf(spec);
  // force: 每次由内部 nonce 全新生成 identity(复审 R5: 不依赖 existingIds); expected-absent
  // (assertExpectedAbsent + port.hasRun)是唯一权威。
  const identityOptions = {
    kind: spec.kind,
    inputFingerprint: spec.inputFingerprint,
    profileFingerprint: spec.profileFingerprint,
    planDigest,
    uniqueRunId: spec.uniqueRunId,
    ...(spec.createdAt !== undefined ? { createdAt: spec.createdAt } : {}),
  };
  const identity = options.force === true
    ? createForcedWorkflowIdentity(identityOptions)
    : createWorkflowIdentity(identityOptions);
  assertExpectedAbsent(identity.workflowId, options.existingIds ?? []);
  if (await ports.persistence.hasRun(identity.workflowId)) {
    throw new RunEngineError('conflict', `workflowId ${identity.workflowId} 已存在, expected-absent 违反(请 resume 或 force)`);
  }
  const built = buildRunPlan(identity, spec);
  const ctx = new RunContext(ports, built, identity);
  // 首次创建(run 目录/manifest/run plan)走受限 run_bootstrap state transaction(全目标 expected absent)
  await ctx.state(
    {
      kind: 'bootstrap',
      txid: ctx.txidFor('bootstrap', identity.workflowId),
      workflowId: identity.workflowId,
      runPlanPath: built.runPlanPath,
      runPlan: built.runPlanBytes,
      manifest: built.manifest,
    },
    'bootstrap',
  );
  return progressRun(ctx, { retryOutcomeUnknown: false });
}

async function runResume(ports: RunEnginePorts, options: ResumeRunOptions): Promise<RunEngineResult> {
  const recoverLog: string[] = [];
  let loaded = await ports.persistence.loadRunState(options.workflowId);

  // 1) 先收敛全部 durable intents(先于 manifest 信任; run_bootstrap intent 无已提交
  //    plan 也不死锁 —— 补完同一事务, 不得回滚, ADR-0022 §4/§5.1/⑫)
  if (loaded.manifest === undefined) {
    const bootstrap = loaded.intents.find((i) => i.tx.kind === 'bootstrap' && i.tx.workflowId === options.workflowId);
    if (bootstrap === undefined) {
      throw new RunEngineError('missing', `${options.workflowId} manifest 缺失且无 bootstrap intent, 拒绝恢复`);
    }
    assertIntentValid(bootstrap, options.workflowId);
    recoverLog.push('recover:bootstrap');
    await ports.persistence.applyState(bootstrap.tx);
    loaded = await ports.persistence.loadRunState(options.workflowId);
  }
  for (const intent of loaded.intents) {
    assertIntentValid(intent, options.workflowId);
    const target = intent.tx.kind === 'artifact-receipt' || intent.tx.kind === 'batch-plan' || intent.tx.kind === 'cursor'
      ? intent.tx.batchId
      : intent.tx.kind === 'apply'
        ? intent.tx.applyId
        : '';
    recoverLog.push(`recover:${intent.tx.kind}:${target}`);
    await ports.persistence.applyState(intent.tx); // 补完同一事务
  }
  loaded = await ports.persistence.loadRunState(options.workflowId);
  if (loaded.manifest === undefined) throw new RunEngineError('missing', 'intent 收敛后 manifest 仍缺失, fail-closed');
  if (loaded.intents.length !== 0) {
    throw new RunEngineError('conflict', `${loaded.intents.length} 个 intent 未收敛, 禁止继续(fail-closed)`);
  }
  if (loaded.manifest.workflowId !== options.workflowId) {
    throw new RunEngineError('corruption', 'manifest workflowId 与请求不符, 拒绝恢复');
  }
  if (loaded.runPlan === undefined) throw new RunEngineError('missing', 'run plan 缺失, 拒绝恢复');

  // 2) 严格 manifest/profile/contract 兼容(workflowId + 全部 identity 字段精确匹配;
  //    输入/执行 profile/plan 任一变化 → 拒绝续跑)
  assertManifestCompatible(loaded.manifest, options.expected);
  const ctx = makeResumeContext(ports, loaded.manifest, loaded.runPlan);
  ctx.stateTxLog.unshift(...recoverLog); // 收敛事务记录在最前

  // 3) 普通 resume(校验已完成 → 跳过 → 从首不完整继续)
  return progressRun(ctx, { retryOutcomeUnknown: options.retryOutcomeUnknown === true });
}

/** 校验已完成批次: plan 已提交 + artifact 精确字节 hash 与 receipt/manifest 对账 + cursor。 */
async function verifyCompletedBatch(ctx: RunContext, batchId: string, entry: BatchManifestEntry): Promise<void> {
  const paths = ctx.paths[batchId];
  const planBytes = await ctx.ports.persistence.readBytes(paths.planPath);
  if (planBytes === undefined) throw new RunEngineError('corruption', `batch ${batchId} 缺少已提交 plan, 无法对账`);
  let persistedPlan: unknown;
  try {
    persistedPlan = JSON.parse(Buffer.from(planBytes).toString('utf8'));
  } catch {
    throw new RunEngineError('corruption', `batch ${batchId} plan 无法解析`);
  }
  // batchPaths 全量重验 plan identity 并返回确定性路径(篡改/traversal fail-closed)
  const canonical = batchPaths(ctx.identity.kind, persistedPlan as BatchPlan);
  if (canonical.planPath !== paths.planPath || canonical.artifactPath !== paths.artifactPath
    || canonical.receiptPath !== paths.receiptPath) {
    throw new RunEngineError('corruption', `batch ${batchId} plan 与确定性布局不符`);
  }
  const plan = persistedPlan as BatchPlan;
  if (plan.workflowId !== ctx.workflowId || plan.batchId !== batchId) {
    throw new RunEngineError('corruption', `batch ${batchId} plan 归属不符`);
  }
  const artifactBytes = await ctx.ports.persistence.readBytes(paths.artifactPath);
  if (artifactBytes === undefined) throw new RunEngineError('corruption', `batch ${batchId} artifact 缺失`);
  const receiptBytes = await ctx.ports.persistence.readBytes(paths.receiptPath);
  if (receiptBytes === undefined) throw new RunEngineError('corruption', `batch ${batchId} receipt 缺失`);
  let receipt: { workflowId: string; batchId: string; resultHash: string; transactionId: string; committedAt: string };
  try {
    const parsed = JSON.parse(Buffer.from(receiptBytes).toString('utf8')) as {
      workflowId: string; batchId: string; resultHash: string; transactionId: string; committedAt: string;
    };
    // makeBatchReceipt 全量重验字段(sha/transactionId/committedAt/plain JSON)
    makeBatchReceipt({
      workflowId: parsed.workflowId,
      batchId: parsed.batchId,
      resultHash: parsed.resultHash,
      transactionId: parsed.transactionId,
      committedAt: parsed.committedAt,
    });
    receipt = parsed;
  } catch {
    throw new RunEngineError('corruption', `batch ${batchId} receipt 无法验证`);
  }
  if (receipt.workflowId !== ctx.workflowId || receipt.batchId !== batchId) {
    throw new RunEngineError('corruption', `batch ${batchId} receipt 归属不符`);
  }
  // 对 artifact 精确字节重算 hash, 与 receipt observed result_hash 对比(§2/§3)
  const rehash = workflowSha256(artifactBytes);
  if (rehash !== receipt.resultHash) {
    throw new RunEngineError('corruption', `batch ${batchId} artifact 字节 hash 与 receipt 不符(损坏), 保留现场`);
  }
  if (entry.resultHash !== undefined && entry.resultHash !== receipt.resultHash) {
    throw new RunEngineError('corruption', `batch ${batchId} manifest 与 receipt resultHash 不符`);
  }
  if (entry.transactionId !== undefined && entry.transactionId !== receipt.transactionId) {
    throw new RunEngineError('corruption', `batch ${batchId} manifest 与 receipt transactionId 不符`);
  }
  if ((entry.state === 'artifact_committed' || entry.state === 'completed')
    && (entry.resultHash === undefined || entry.transactionId === undefined)) {
    throw new RunEngineError('corruption', `batch ${batchId} 已提交但 manifest 缺 resultHash/transactionId`);
  }
}

async function cursorTx(ctx: RunContext, batchId: string, committedEntry: BatchManifestEntry): Promise<void> {
  const doneEntry: BatchManifestEntry = { ...committedEntry, state: 'completed' };
  const next: RunWorkflowManifest = {
    ...ctx.manifest,
    status: 'running',
    cursor: { phase: doneEntry.phase, ordinal: doneEntry.ordinal },
    batches: { ...ctx.manifest.batches, [batchId]: doneEntry },
  };
  await ctx.state(
    { kind: 'cursor', txid: ctx.txidFor('cursor', batchId), workflowId: ctx.workflowId, batchId, manifest: next },
    `cursor:${batchId}`,
  );
}

async function statusTx(ctx: RunContext, status: ManifestStatus, budgetSpent?: number): Promise<void> {
  await ctx.state(
    { kind: 'run-status', txid: ctx.nextAnonymousTxid('run-status'), workflowId: ctx.workflowId, manifest: {
      ...ctx.manifest,
      status,
      ...(budgetSpent !== undefined ? { budgetSpent } : {}),
    } },
    `run-status:${status}`,
  );
}

/**
 * 执行一批: 批次计划先行提交(任何 provider 调用前)→ generator → artifact+receipt
 * (同一 state transaction, artifact 先于 receipt)→ cursor(独立 state transaction)。
 * generator 抛错 = provider_outcome_unknown: 写状态后停止, 绝不自动 retry。
 */
async function runBatch(ctx: RunContext, batchId: string): Promise<boolean> {
  const plan = ctx.batchPlans[batchId];
  const paths = ctx.paths[batchId];
  const spec = ctx.specsByBatch[batchId];
  const planExists = (await ctx.ports.persistence.readBytes(paths.planPath)) !== undefined;
  if (!planExists) {
    const planBytes = Buffer.from(`${canonicalRunJson(plan)}\n`, 'utf8');
    await ctx.state(
      {
        kind: 'batch-plan',
        txid: ctx.txidFor('batch-plan', batchId),
        workflowId: ctx.workflowId,
        batchId,
        path: paths.planPath,
        plan,
        bytes: planBytes,
        manifest: ctx.manifest,
      },
      `plan:${batchId}`,
    );
  }
  let output: RunGeneratorOutput;
  try {
    output = await ctx.ports.generator.generate(deepFreeze({
      workflowId: ctx.workflowId,
      batchId,
      phase: plan.phase,
      ordinal: plan.ordinal,
      inputFingerprint: plan.inputFingerprint,
      sourceIds: plan.sourceIds,
      sourceHashes: plan.sourceHashes,
      outputSchemaVersion: spec.outputSchemaVersion ?? '1',
    }));
  } catch (error) {
    if (error instanceof RunGeneratorTerminalError) {
      await statusTx(ctx, 'failed', ctx.ports.generator.budgetSpent?.());
      throw error;
    }
    await statusTx(ctx, 'provider_outcome_unknown', ctx.ports.generator.budgetSpent?.()); // 写状态后停止
    return true;
  }
  // 输出定型(内存/事务临时区): 规范化序列化 → 对精确字节算 observed result_hash → receipt
  const { bytes: artifactBytes, resultHash } = serializeBatchArtifact(plan, output.payload,
    spec.outputSchemaVersion !== undefined ? { outputSchemaVersion: spec.outputSchemaVersion } : {});
  const txid = ctx.txidFor('artifact-receipt', batchId);
  const receipt = makeBatchReceipt({
    workflowId: ctx.workflowId,
    batchId,
    resultHash,
    transactionId: txid,
    committedAt: nowIso(),
  });
  const receiptBytes = Buffer.from(`${canonicalRunJson(receipt)}\n`, 'utf8');
  const entry = ctx.manifest.batches[batchId];
  const committedEntry: BatchManifestEntry = {
    ...entry,
    state: 'artifact_committed',
    resultHash,
    transactionId: txid,
  };
  const next: RunWorkflowManifest = {
    ...ctx.manifest,
    status: 'running',
    budgetSpent: output.budgetSpent ?? ctx.manifest.budgetSpent,
    batches: { ...ctx.manifest.batches, [batchId]: committedEntry },
  };
  // artifact bytes 与 receipt 同一 state transaction 的计划输出(artifact 先于 receipt)
  await ctx.state(
    {
      kind: 'artifact-receipt',
      txid,
      workflowId: ctx.workflowId,
      batchId,
      artifactPath: paths.artifactPath,
      artifactBytes,
      receiptPath: paths.receiptPath,
      receiptBytes,
      manifest: next,
    },
    `artifact:${batchId}`,
  );
  await cursorTx(ctx, batchId, committedEntry);
  return false;
}

/** apply 链: waiting_approval → applying(transactionId durable 先写)→ applied(commitEvidence)。 */
async function applyChain(
  ctx: RunContext,
  batchId: string,
  reappliedApplyIds: string[],
  applyProbeUnknown: string[],
): Promise<boolean> {
  const applySpec = ctx.specsByBatch[batchId].apply;
  if (applySpec === undefined) return false;
  const applyPort = ctx.ports.apply;
  if (applyPort === undefined) throw new RunEngineError('invalid', `批次 ${batchId} 含 apply 目标但未注入 ApplyPort`);
  const applyId = applyIdFor(ctx.workflowId, batchId);
  const artifactHash = ctx.manifest.batches[batchId].resultHash;
  if (artifactHash === undefined) throw new RunEngineError('invalid', `批次 ${batchId} 无 artifact hash, 无法 apply`);

  for (let rounds = 0; rounds <= MAX_APPLY_ROLLBACKS; rounds++) {
    const record = ctx.manifest.applies[applyId];
    if (record === undefined) {
      // apply plan + waiting_approval 独立 state transaction(ADR-0022 §6; 复审 R4 全绑定)
      const bindings = applyPlanBindings(ctx.workflowId, batchId, applySpec.target, applySpec.expectedHash, artifactHash, ctx.manifest.planDigest);
      const fresh: ApplyRecord = deepFreeze({
        version: 1,
        applyId,
        workflowId: ctx.workflowId,
        target: applySpec.target,
        expectedHash: applySpec.expectedHash,
        writeSetDigest: bindings.writeSetDigest,
        artifactHash,
        batchId,
        checkpoint: bindings.checkpoint,
        planDigest: ctx.manifest.planDigest,
        provenance: bindings.provenance,
        state: 'waiting_approval',
        updatedAt: nowIso(),
      });
      await ctx.state(
        { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, fresh) },
        `apply:waiting:${applyId}`,
      );
      continue;
    }
    if (record.target !== applySpec.target || record.expectedHash !== applySpec.expectedHash
      || record.batchId !== batchId || record.planDigest !== ctx.manifest.planDigest) {
      throw new RunEngineError('corruption', `apply ${applyId} 与已提交 run plan 不符, 拒绝`);
    }
    if (record.state === 'applied' || record.state === 'rejected' || record.state === 'skipped' || record.state === 'failed') {
      return false;
    }
    if (record.state === 'waiting_approval') {
      // 发起一次新审批; decision/token 不落盘, 不序列化、不重放(§7)
      const decision = await applyPort.requestApproval({
        applyId,
        workflowId: ctx.workflowId,
        batchId,
        target: record.target,
        summary: `采用批次 ${batchId} 到 ${record.target}`,
        items: [batchId],
      });
      if (decision !== 'allowed-once') {
        // rejected / cancelled / unavailable 一律不 apply(绝不静默 apply)
        const terminal: 'rejected' | 'skipped' = decision === 'unavailable'
          ? (applySpec.onApprovalUnavailable ?? 'rejected')
          : 'rejected';
        const rec = terminal === 'rejected'
          ? advanceApplyState(record, terminal, { now: nowIso(), failure: `审批 ${decision}` })
          : advanceApplyState(record, terminal, { now: nowIso() });
        await ctx.state(
          { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, rec) },
          `apply:${terminal}:${applyId}`,
        );
        continue;
      }
      // allowed-once: 先提交 applying + transactionId(durable 先写), 再启动 canonical 事务。
      // canonical 事务 id 确定性(probe/execute 绑定); apply 状态事务每次全新 txid
      // (revert 后重新 applying 不得与旧状态事务撞 txid)。
      const txid = applyTransactionId(ctx.workflowId, applyId);
      const applying = advanceApplyState(record, 'applying', { now: nowIso(), transactionId: txid });
      await ctx.state(
        { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, applying) },
        `apply:applying:${applyId}`,
      );
      const outcome = await runCanonicalApply(ctx, applyPort, applyId, applying, txid, reappliedApplyIds);
      if (outcome === 'unknown') {
        applyProbeUnknown.push(applyId);
        return true;
      }
      continue;
    }
    // applying(崩溃恢复): 只按 transaction probe 判定归属, 绝不盲重写
    if (record.transactionId === undefined) {
      throw new RunEngineError('invalid', `apply ${applyId} 处于 applying 但无 transactionId, fail-closed`);
    }
    let probe: ApplyProbe;
    try {
      probe = await applyPort.probe(record.transactionId);
    } catch {
      probe = { state: 'unknown' };
    }
    const outcome = await settleApplyProbe(ctx, applyPort, applyId, record, record.transactionId, probe, reappliedApplyIds);
    if (outcome === 'unknown') {
      applyProbeUnknown.push(applyId);
      return true;
    }
  }
  throw new RunEngineError('apply', `apply ${applyId} 回退重审轮次超限(${MAX_APPLY_ROLLBACKS}), fail-closed`);
}

/** 执行 canonical 事务并探针; 抛错按 probe 判定(完成/未启动/未知)。 */
async function runCanonicalApply(
  ctx: RunContext,
  applyPort: RunApplyPort,
  applyId: string,
  applying: ApplyRecord,
  txid: string,
  reappliedApplyIds: string[],
): Promise<'completed' | 'none' | 'unknown'> {
  let probe: ApplyProbe;
  try {
    const { commitOid } = await applyPort.execute({
      applyId,
      workflowId: ctx.workflowId,
      batchId: applying.batchId,
      transactionId: txid,
      target: applying.target,
      expectedHash: applying.expectedHash,
      artifactHash: applying.artifactHash,
      writeSetDigest: applying.writeSetDigest,
      checkpoint: applying.checkpoint,
      planDigest: applying.planDigest,
      provenance: applying.provenance,
    });
    probe = await applyPort.probe(txid);
    if (probe.state === 'completed' && probe.commitOid !== commitOid) {
      throw new RunEngineError('apply', `apply ${applyId} execute 与 probe commitOid 不一致, fail-closed`);
    }
  } catch (err) {
    if (err instanceof RunEngineError) throw err;
    if (err instanceof ApplyCanonicalError) {
      // 确定性写面失败(CAS 冲突等): 终态 failed 人工处置, 不重写、不重审批
      const rec = advanceApplyState(applying, 'failed', { now: nowIso(), failure: err.message });
      await ctx.state(
        { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, rec) },
        `apply:failed:${applyId}`,
      );
      return 'none';
    }
    // 崩溃/异常: canonical 事务归属只能由探针判定
    try {
      probe = await applyPort.probe(txid);
    } catch {
      probe = { state: 'unknown' };
    }
  }
  return settleApplyProbe(ctx, applyPort, applyId, applying, txid, probe, reappliedApplyIds);
}

/**
 * 按探针结果收尾: completed → 补 applied(注入 commitEvidence, 不重复审批/写入);
 * none → 持久退回 waiting_approval(tx 字段清空, 下次必须重新审批, 旧 decision 不复用);
 * unknown → 保留现场 fail-closed(绝不盲重写)。
 */
async function settleApplyProbe(
  ctx: RunContext,
  applyPort: RunApplyPort,
  applyId: string,
  record: ApplyRecord,
  txid: string,
  probe: ApplyProbe,
  reappliedApplyIds: string[],
): Promise<'completed' | 'none' | 'unknown'> {
  if (probe.state === 'completed') {
    if (record.state !== 'applying' || record.transactionId !== txid) {
      throw new RunEngineError('corruption', `apply ${applyId} probe 完成但记录与事务不符, fail-closed`);
    }
    // applied 必须注入与 apply 逐字段绑定的 commitEvidence(commitOid 验证, 复审 R4)
    const rec = advanceApplyState(record, 'applied', {
      now: nowIso(),
      commitEvidence: {
        commitOid: probe.commitOid,
        workflowId: record.workflowId,
        batchId: record.batchId,
        planDigest: record.planDigest,
        writeSetDigest: record.writeSetDigest,
        artifactHash: record.artifactHash,
        verifiedAt: nowIso(),
      },
    });
    await ctx.state(
      { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, rec) },
      `apply:applied:${applyId}`,
    );
    return 'completed';
  }
  if (probe.state === 'none') {
    // canonical 未启动: 持久退回 waiting_approval(事务未 commit 可回退, tx 字段清空)
    const rec = advanceApplyState(record, 'waiting_approval', { now: nowIso() });
    await ctx.state(
      { kind: 'apply', txid: ctx.nextAnonymousTxid('apply'), workflowId: ctx.workflowId, applyId, manifest: withApply(ctx.manifest, rec) },
      `apply:revert:${applyId}`,
    );
    reappliedApplyIds.push(applyId);
    return 'none';
  }
  return 'unknown';
}

/**
 * 让出一个 Node macrotask。真实 Git persistence 的单批由多次同步 plumbing 组成；若连续
 * 批次只在已解决 Promise 的 microtask 链间切换，会让宿主取消/进度 RPC 与 timer 饥饿。
 * 批次边界 yield 不改变事务内部顺序、artifact 字节或崩溃窗口，只恢复宿主公平调度。
 */
async function yieldAtBatchBoundary(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 主推进循环: 校验已完成 → 跳过 → 窗口恢复 → 从首不完整继续。 */
async function progressRun(
  ctx: RunContext,
  opts: { retryOutcomeUnknown: boolean },
): Promise<RunEngineResult> {
  const providerOutcomeUnknown: string[] = [];
  const applyProbeUnknown: string[] = [];
  const reappliedApplyIds: string[] = [];
  let stop: 'provider_outcome_unknown' | 'apply_probe_unknown' | undefined;

  for (const batchId of ctx.orderedBatchIds) {
    await yieldAtBatchBoundary();
    const entry = ctx.manifest.batches[batchId];
    if (entry.state === 'completed') {
      await verifyCompletedBatch(ctx, batchId, entry); // 校验已完成 artifact hash/receipt/cursor
      if (await applyChain(ctx, batchId, reappliedApplyIds, applyProbeUnknown)) {
        stop = 'apply_probe_unknown';
        break;
      }
      continue;
    }
    if (entry.state === 'artifact_committed') {
      // 窗口二: artifact+receipt 已提交、cursor 未推进 → 校验后幂等推进 cursor, 不重跑 provider
      await verifyCompletedBatch(ctx, batchId, entry);
      await cursorTx(ctx, batchId, entry);
      if (await applyChain(ctx, batchId, reappliedApplyIds, applyProbeUnknown)) {
        stop = 'apply_probe_unknown';
        break;
      }
      continue;
    }
    // planned: 无有效 intent 覆盖的残留 artifact/receipt 一律 fail-closed(§5.3)
    const artifactExists = (await ctx.ports.persistence.readBytes(ctx.paths[batchId].artifactPath)) !== undefined;
    const receiptExists = (await ctx.ports.persistence.readBytes(ctx.paths[batchId].receiptPath)) !== undefined;
    if (artifactExists || receiptExists) {
      throw new RunEngineError('corruption', `batch ${batchId} 存在无有效 intent 覆盖的 artifact/receipt 残留, fail-closed`);
    }
    const planCommitted = (await ctx.ports.persistence.readBytes(ctx.paths[batchId].planPath)) !== undefined;
    if (planCommitted && !opts.retryOutcomeUnknown) {
      // 窗口〇: 批次计划已提交、durable intent 未建立 = provider_outcome_unknown
      // —— 写状态后停止, 绝不自动 retry(重新授权后才可重试)
      if (ctx.manifest.status !== 'provider_outcome_unknown') {
        await statusTx(ctx, 'provider_outcome_unknown');
      }
      providerOutcomeUnknown.push(batchId);
      stop = 'provider_outcome_unknown';
      break;
    }
    // 全新批次或已重新授权: 执行该批
    if (await runBatch(ctx, batchId)) {
      providerOutcomeUnknown.push(batchId);
      stop = 'provider_outcome_unknown';
      break;
    }
    if (await applyChain(ctx, batchId, reappliedApplyIds, applyProbeUnknown)) {
      stop = 'apply_probe_unknown';
      break;
    }
  }

  if (stop === undefined && ctx.manifest.status !== 'completed') {
    await statusTx(ctx, 'completed');
  }

  // cursor 一致性: 已完成批次 = plan 前缀, manifest.cursor = 最后一个已完成批次
  const completedBatchIds = ctx.orderedBatchIds.filter((id) => ctx.manifest.batches[id].state === 'completed');
  const lastCompletedId = completedBatchIds.length > 0 ? completedBatchIds[completedBatchIds.length - 1] : undefined;
  const expectedCursor = lastCompletedId === undefined
    ? INITIAL_RUN_CURSOR
    : { phase: ctx.manifest.batches[lastCompletedId].phase, ordinal: ctx.manifest.batches[lastCompletedId].ordinal };
  if (ctx.manifest.cursor.phase !== expectedCursor.phase || ctx.manifest.cursor.ordinal !== expectedCursor.ordinal) {
    throw new RunEngineError('corruption', 'manifest cursor 与已完成批次前缀不符, fail-closed');
  }

  const result: RunEngineResult = {
    workflowId: ctx.workflowId,
    status: stop ?? 'completed',
    completedBatchIds,
    providerOutcomeUnknown,
    remainingBatchIds: ctx.orderedBatchIds.filter((id) => ctx.manifest.batches[id].state !== 'completed'),
    applyProbeUnknown,
    reappliedApplyIds,
    stateTxLog: ctx.stateTxLog,
    manifest: ctx.manifest,
  };
  return deepFreeze(result);
}
