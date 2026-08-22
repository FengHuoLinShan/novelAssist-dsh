// N33 / ADR-0022 — 生产持久化适配器: RunPersistencePort 的 Git-backed 实现。
//
// 本文件是 run-engine(ADR-0022 通用 run engine)的**生产持久化面**: 把 engine 的
// state transactions(RunStateTransaction)映射到 @novelcraft/store 的
// executeTransaction(kind state / run_bootstrap), 全部 run-state 写面走
// ADR-0021 durable intent + 私有 exact tree + ref CAS, 无任何“裸写 + 裸 commit”
// 旁路(ADR-0022 §2 穷尽规则)。
//
// 独立复审修复(全部 fail-closed, 每条对应对抗测试):
//  R7. applyState 的 expected 基线一律来自**持久 manifest/run plan 生成快照**
//      (HEAD 已提交字节), 绝不从事务启动时的工作树刷新; manifest 目标 expected =
//      sha256(HEAD manifest 精确字节)即调用方上一状态; 不可变文档(run plan / batch
//      plan / artifact / receipt)恒 expected absent, 存在即冲突(拒绝覆盖);
//  R8. 路径先 canonicalize 后拒绝任何 `.`/`..`/绝对/反斜杠/编码逃逸(控制字符)段,
//      写面目标必须严格位于**本 workflow** canonical run root 之内(跨 run 拒绝);
//  R9. 全部 run 文档(run plan/batch plan/artifact/receipt/manifest)工作树字节必须
//      精确等于 HEAD 已提交字节(loadRunState 全量对账); 每文档 strict no-unknown
//      字段白名单 + canonical 序列化字节回环; artifact 身份字段精确绑定已提交
//      batch plan; cursor/run-status/apply 逐条验证合法前态→后态转换;
//  R10. READY durable intent 每一 target 必须严格属于同一 canonical run root
//      (混入 watch-state/checkpoint 等非 run 机器状态目标 → 拒绝并保留现场);
//  R11. 不得在 store transaction preflight 前 mkdir(目录由 store 写面在 preflight +
//      intent 耐久化之后创建); pre-staged/preflight 失败路径零工作树目录副作用。
//
// 关键契约(逐条对应 N33 / ADR-0022 / ADR-0021 §8):
// 1. bootstrap expected-absent 由**事务**封闭 TOCTOU: hasRun 只是入口门禁, 真正
//    的“run 不得已存在 + 全目标 expected absent + 机器 namespace allowlist”在
//    executeTransaction(run_bootstrap)内部于 per-vault 锁下重验
//    (`HEAD:<runFile>` 存在即 INVALID_REQUEST, 绝不覆盖既有 run)。
// 2. resume 先调用 recoverInterruptedTransactions, 并**先于**收敛对全部 READY
//    durable intents 执行完整严格验证(kind 封闭注册表 + 机器 namespace 能力 +
//    单事务不得跨 run + 每目标严格 ∈ 同一 canonical run root + run_bootstrap
//    runId 绑定), 绝不止于 engine 的浅形状检查(assertIntentValid); 任何
//    invalid/preserved/ref_race → fail-closed, intent 保留现场供人工修复
//    (force 不能绕过, ADR-0022 §4)。
// 3. 所有路径限制到 canonical run namespace:
//    `<workflowRunRoot(kind, workflowId)>/...` 即
//    `.assistant/import-runs/<canonical-run-id>/...`(deep-import)或
//    `.assistant/atlas/runs/<canonical-run-id>/...`(map-atlas, ADR-0022 §1/§2);
//    manifest/run plan 之外任何路径(穿越/绝对/其他 run/作者内容)一律拒绝。
// 4. read/load 从文件/Git truth 重建: loadRunState 在收敛后读工作树文件并**与
//    HEAD 已提交字节对账**(外部编辑 fail-closed); artifact/receipt/cursor 的
//    精确字节/hash 由 engine 的 verifyCompletedBatch 重算对账, 适配器写前同样
//    校验(artifact 精确字节 hash == receipt observed result_hash, 无自引用)。
// 5. 每 run 的文件布局(实现期定, ADR-0022 实施期开放项 #2): run 根下
//    `run-plan.json`(bootstrap 写, 不可变)+ `manifest.json`(每次 state 事务原子
//    推进的 manifest 缓存, 与 engine tx.manifest 字节一致)+ 每批
//    `batches/<phase>/<batchId>.{plan,artifact,receipt}.json`(确定性布局,
//    run-model batchPaths 派生)。
// 6. state 事务携带 planSource = 已提交 run plan(§8 能力重推导: 请求期按 HEAD、
//    恢复期按 baseHead 重算比对, run plan 不可变故 digest 稳定); run_bootstrap
//    携带自描述 runId/inputFingerprint/runFile。
// 7. 适配器不转发 engine 的确定性 txid(engine txid 为 `tx-`+40hex, 属 run 域;
//    store 契约为 canonical `tx-`+64hex, 两域不同, 由 store 自行生成 txid);
//    engine txid 仍经 receipt.transactionId/manifest 持久化, 与 git commit 的
//    关联由 plan digest/内容对账保证。
//
// 测试注入 seam: options.transactionOptions 透传给 executeTransaction(崩溃门控/
// 锁参数); 生产缺省。
import fs from 'node:fs';
import path from 'node:path';
import {
  executeTransaction,
  readCommittedFile,
  listInterruptedIntents,
  readIntentRecord,
  recoverInterruptedTransactions,
  sha256Hex,
  type IntentRecord,
  type TargetSpec,
  type TransactionOptions,
  type TransactionRequest,
} from '@novelcraft/store';
import { assertNoSymlinkOnPath, guardPath } from '@novelcraft/vault';
import {
  ARTIFACT_SCHEMA_VERSION,
  WORKFLOW_RUN_VERSION,
  assertManifestCompatible,
  batchPaths,
  canonicalRunJson,
  makeBatchReceipt,
  workflowRunRoot,
  workflowSha256,
  type ApplyRecord,
  type ApplyState,
  type BatchArtifact,
  type BatchManifestEntry,
  type BatchPlan,
  type BatchReceipt,
  type ManifestStatus,
  type ReadonlyBytes,
  type WorkflowKind,
} from './run-model.js';
import {
  RUN_PLAN_VERSION,
  RunEngineError,
  planDigestOf,
  type DurableIntent,
  type RunBatchSpec,
  type RunPersistencePort,
  type RunStateTransaction,
  type RunWorkflowManifest,
} from './run-engine.js';

// —— run 文件布局(仅适配器内部) ——
export const RUN_MANIFEST_FILENAME = 'manifest.json';
export const RUN_PLAN_FILENAME = 'run-plan.json';

/** 机器状态 namespace 根(state/checkpoint/run_bootstrap intent 能力边界)。 */
const ASSISTANT_NS = '.assistant/';
/** 与 run-model assertWorkflowIdShape 同口径(前缀 + inputFingerprint 前 16 hex + unique 段)。 */
const WORKFLOW_ID_RE = /^([a-z][a-z0-9]*)-([0-9a-f]{16})-(.+)$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** canonical run namespace 前缀(kind 映射; ADR-0022 §1: import-runs / atlas runs)。 */
const RUN_NS_PREFIXES: ReadonlyArray<{ prefix: string; kind: WorkflowKind }> = [
  { prefix: '.assistant/import-runs/', kind: 'deep-import' },
  { prefix: '.assistant/atlas/runs/', kind: 'map-atlas' },
];

// —— 文档字段白名单(strict no unknown, 复审 R9) ——
const MANIFEST_TOP_FIELDS: ReadonlySet<string> = new Set([
  'version', 'workflowId', 'kind', 'createdAt', 'inputFingerprint',
  'profileFingerprint', 'planDigest', 'status', 'cursor', 'budgetSpent', 'batches', 'applies',
]);
const CURSOR_FIELDS: ReadonlySet<string> = new Set(['phase', 'ordinal']);
const BATCH_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  'batchId', 'phase', 'ordinal', 'state', 'planPath', 'artifactPath',
  'receiptPath', 'resultHash', 'transactionId',
]);
const APPLY_RECORD_FIELDS: ReadonlySet<string> = new Set([
  'version', 'applyId', 'workflowId', 'target', 'expectedHash', 'writeSetDigest',
  'artifactHash', 'batchId', 'checkpoint', 'planDigest', 'provenance', 'state',
  'transactionId', 'commitOid', 'updatedAt', 'failure',
]);
const RUN_PLAN_TOP_FIELDS: ReadonlySet<string> = new Set([
  'version', 'workflowId', 'kind', 'inputFingerprint', 'profileFingerprint',
  'planDigest', 'createdAt', 'batches',
]);
const RUN_BATCH_FIELDS: ReadonlySet<string> = new Set([
  'phase', 'ordinal', 'sourceIds', 'sourceHashes', 'outputSchemaVersion', 'apply',
]);
const APPLY_TARGET_FIELDS: ReadonlySet<string> = new Set([
  'target', 'expectedHash', 'onApprovalUnavailable',
]);
const BATCH_PLAN_FIELDS: ReadonlySet<string> = new Set([
  'version', 'workflowId', 'batchId', 'phase', 'ordinal', 'inputFingerprint',
  'sourceIds', 'sourceHashes',
]);
const ARTIFACT_FIELDS: ReadonlySet<string> = new Set([
  'version', 'workflowId', 'batchId', 'phase', 'ordinal', 'inputFingerprint',
  'artifactSchemaVersion', 'outputSchemaVersion', 'payload',
]);
const RECEIPT_FIELDS: ReadonlySet<string> = new Set([
  'version', 'workflowId', 'batchId', 'resultHash', 'transactionId', 'committedAt',
]);

// —— 合法状态转换表(复审 R9: cursor/run-status/apply 验证合法前态→后态) ——
const APPLY_STATES: readonly ApplyState[] = [
  'waiting_approval', 'applying', 'applied', 'rejected', 'skipped', 'failed',
];
const APPLY_STATE_TRANSITIONS: Readonly<Record<ApplyState, readonly ApplyState[]>> = {
  waiting_approval: ['applying', 'rejected', 'skipped'],
  applying: ['applied', 'waiting_approval', 'failed'],
  applied: [],
  rejected: [],
  skipped: [],
  failed: [],
};
/** engine 可达的 run-status 转换(planning→…/running→…/provider_outcome_unknown→running)。 */
const RUN_STATUS_TRANSITIONS: Readonly<Record<ManifestStatus, readonly ManifestStatus[]>> = {
  planning: ['running', 'provider_outcome_unknown', 'completed'],
  running: ['provider_outcome_unknown', 'completed'],
  provider_outcome_unknown: ['running'],
  waiting_approval: [],
  completed: [],
  failed: [],
};
/** 与 engine INITIAL_RUN_CURSOR 同口径(无已完成批次时 manifest.cursor 的合法值)。 */
const INITIAL_RUN_CURSOR: Readonly<{ phase: string; ordinal: number }> = Object.freeze({ phase: 'start', ordinal: 0 });

export interface GitRunPersistenceOptions {
  /** 透传给 store executeTransaction 的选项(测试注入崩溃门控/锁参数; 生产缺省)。 */
  readonly transactionOptions?: TransactionOptions;
}

/** 单个 state 事务的计划输出文件(写面唯一集合)。 */
interface PlannedFile {
  readonly path: string;
  readonly bytes: ReadonlyBytes;
  /** 不可变文档(run plan/batch plan/artifact/receipt): 恒 expected absent, 存在即冲突。 */
  readonly immutable: boolean;
}

/** validateTxStrict 的派生结果: store 事务 kind + 全部计划输出。 */
interface TxPlan {
  readonly txKind: 'run_bootstrap' | 'state';
  readonly root: string;
  readonly runPlanPath: string;
  readonly files: readonly PlannedFile[];
}

// —— 工具 ——

function toBuffer(bytes: ReadonlyBytes): Buffer {
  return Buffer.from(bytes as unknown as Uint8Array);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function readFileIfExists(abs: string): Uint8Array | undefined {
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RunEngineError('corruption', `读取失败: ${abs}: ${(err as Error).message}`);
  }
}

function fileExists(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** `HEAD:<path>` 原始字节，统一经 store 的 pinned read-only Git seam。 */
function gitShowBytes(vault: string, revPath: string): Buffer | undefined {
  if (!revPath.startsWith('HEAD:')) throw new RunEngineError('invalid', '仅允许读取 HEAD:path');
  const bytes = readCommittedFile(vault, revPath.slice('HEAD:'.length), 'HEAD');
  return bytes === undefined ? undefined : Buffer.from(bytes);
}

/** workflowId → kind(前缀映射; 与 run-model workflowIdPrefix 同口径)。 */
function kindFromWorkflowId(workflowId: string): WorkflowKind {
  const m = WORKFLOW_ID_RE.exec(workflowId);
  if (m === null) throw new RunEngineError('invalid', `workflowId 结构非法(拒绝): ${workflowId}`);
  const prefix = m[1];
  if (prefix === 'imp') return 'deep-import';
  if (prefix === 'atlas') return 'map-atlas';
  throw new RunEngineError('invalid', `workflowId 前缀非法(拒绝): ${workflowId}`);
}

/**
 * 严格 canonical vault 相对路径(复审 R8): 拒绝 `.`/`..` 段、绝对路径、Windows
 * 盘符、UNC、反斜杠、控制字符(编码逃逸)、空段、`.git` 保留段; `path.posix.normalize`
 * 后必须与输入一致(canonicalize 后任何改写一律拒绝)。返回原值(仅校验)。
 */
function assertCanonicalRelPath(rel: string, what: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new RunEngineError('invalid', `${what} 路径为空(拒绝)`);
  }
  if (rel.length > 1024) {
    throw new RunEngineError('invalid', `${what} 路径超长(拒绝): ${JSON.stringify(rel)}`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rel)) {
    throw new RunEngineError('invalid', `${what} 路径含控制字符/编码逃逸(拒绝): ${JSON.stringify(rel)}`);
  }
  if (rel.startsWith('/')) {
    throw new RunEngineError('invalid', `${what} 路径是绝对路径(拒绝): ${JSON.stringify(rel)}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
    throw new RunEngineError('invalid', `${what} 路径是盘符/UNC 绝对路径(拒绝): ${JSON.stringify(rel)}`);
  }
  if (rel.includes('\\')) {
    throw new RunEngineError('invalid', `${what} 路径含反斜杠(非 POSIX, 拒绝): ${JSON.stringify(rel)}`);
  }
  for (const seg of rel.split('/')) {
    if (seg.length === 0) {
      throw new RunEngineError('invalid', `${what} 路径含空段(重复斜杠/尾斜杠, 拒绝): ${JSON.stringify(rel)}`);
    }
    if (seg === '.' || seg === '..') {
      throw new RunEngineError('invalid', `${what} 路径含 ${JSON.stringify(seg)} 段(canonicalize 后穿越, 拒绝): ${JSON.stringify(rel)}`);
    }
    if (seg.toLowerCase() === '.git') {
      throw new RunEngineError('invalid', `${what} 路径含 .git 保留段(拒绝): ${JSON.stringify(rel)}`);
    }
  }
  if (path.posix.normalize(rel) !== rel) {
    throw new RunEngineError('invalid', `${what} 路径 canonicalize 后改写(非 canonical, 拒绝): ${JSON.stringify(rel)}`);
  }
  return rel;
}

/** 目标必须严格位于该 workflow canonical run root 之内(复审 R8)。 */
function assertWithinRunRoot(rel: string, root: string, what: string): string {
  assertCanonicalRelPath(rel, what);
  if (!rel.startsWith(`${root}/`)) {
    throw new RunEngineError('invalid', `${what} 目标越出该 workflow canonical run root(拒绝): ${rel}`);
  }
  return rel;
}

/** 文档字段白名单: 任何未知字段 fail-closed(复审 R9 strict no unknown)。 */
function assertNoUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RunEngineError('corruption', `${what} 含未知字段(no unknown, fail-closed): ${JSON.stringify(key)}`);
    }
  }
}

/** 文档字节必须是其解析结果的 canonical 序列化(排序键 + `\n` 结尾, 复审 R9)。 */
function assertCanonicalJsonBytes(bytes: ReadonlyBytes, parsed: unknown, what: string): void {
  let canonical: string;
  try {
    canonical = canonicalRunJson(parsed);
  } catch (err) {
    throw new RunEngineError('corruption', `${what} 非 plain canonical JSON 数据(fail-closed): ${(err as Error).message}`);
  }
  const expected = Buffer.from(`${canonical}\n`, 'utf8');
  if (!bytesEqual(toBuffer(bytes), expected)) {
    throw new RunEngineError('corruption', `${what} 文件字节非 canonical 序列化(格式/键序/空白被改写, fail-closed)`);
  }
}

function parseJsonDoc(bytes: ReadonlyBytes, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toBuffer(bytes).toString('utf8'));
  } catch {
    throw new RunEngineError('corruption', `${what} 无法解析(fail-closed)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RunEngineError('corruption', `${what} 非法(fail-closed)`);
  }
  return parsed;
}

function cursorEq(a: { phase: string; ordinal: number }, b: { phase: string; ordinal: number }): boolean {
  return a.phase === b.phase && a.ordinal === b.ordinal;
}

/** manifest 的最后一个已完成批次(ordinal 最大; 无则 undefined)——cursor 不变量锚点。 */
function lastCompletedBatchOf(manifest: RunWorkflowManifest): { phase: string; ordinal: number } | undefined {
  let best: BatchManifestEntry | undefined;
  for (const batch of Object.values(manifest.batches)) {
    if (batch.state !== 'completed') continue;
    if (best === undefined || batch.ordinal > best.ordinal) best = batch;
  }
  return best === undefined ? undefined : { phase: best.phase, ordinal: best.ordinal };
}

/**
 * 从 vault 相对路径解析其所属 canonical run namespace(kind + run id);
 * 非 run namespace(机器状态文件/作者内容/穿越)返回 undefined。路径必须落在
 * `<workflowRunRoot(kind, id)>/...` 内才被认可。调用方须先过 canonical 校验
 * (store intent 路径已规范化; readBytes 在本函数前做 assertCanonicalRelPath)。
 */
function runNamespaceOf(rel: string): { kind: WorkflowKind; workflowId: string } | undefined {
  for (const { prefix, kind } of RUN_NS_PREFIXES) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    const id = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
    if (id.length === 0 || id === '.' || id === '..') return undefined;
    if (id.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(id)) return undefined;
    let idKind: WorkflowKind;
    try {
      idKind = kindFromWorkflowId(id);
    } catch {
      return undefined;
    }
    if (idKind !== kind) return undefined;
    if (!rel.startsWith(`${workflowRunRoot(kind, id)}/`)) return undefined;
    return { kind, workflowId: id };
  }
  return undefined;
}

/** manifest 完整严格校验(身份绑定 + 确定性批次布局 + 字段白名单 + applies 分节归属)。 */
function validateManifestStrict(manifest: RunWorkflowManifest, workflowId: string): void {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new RunEngineError('corruption', 'manifest 非法(fail-closed)');
  }
  if (manifest.workflowId !== workflowId) {
    throw new RunEngineError('corruption', `manifest workflowId ${manifest.workflowId} 与请求 ${workflowId} 不符`);
  }
  if (manifest.kind !== kindFromWorkflowId(workflowId)) {
    throw new RunEngineError('corruption', 'manifest kind 与 workflowId 前缀不符');
  }
  try {
    // 自我一致期望: version/identity 绑定/status/cursor/batches 确定性路径全量校验
    // (run-model assertManifestCompatible; 批次路径即 canonical run namespace 布局)。
    assertManifestCompatible(manifest, {
      workflowId: manifest.workflowId,
      kind: manifest.kind,
      inputFingerprint: manifest.inputFingerprint,
      profileFingerprint: manifest.profileFingerprint,
      planDigest: manifest.planDigest,
    });
  } catch (err) {
    throw new RunEngineError('corruption', `manifest 校验失败(fail-closed): ${(err as Error).message}`);
  }
  // strict no unknown(复审 R9): 形状已由 assertManifestCompatible 保证, 再逐层白名单。
  assertNoUnknownKeys(manifest as unknown as Record<string, unknown>, MANIFEST_TOP_FIELDS, 'manifest');
  if (manifest.budgetSpent !== undefined && (!Number.isSafeInteger(manifest.budgetSpent) || manifest.budgetSpent < 0)) {
    throw new RunEngineError('corruption', 'manifest budgetSpent 非法');
  }
  if (manifest.cursor !== null && typeof manifest.cursor === 'object' && !Array.isArray(manifest.cursor)) {
    assertNoUnknownKeys(manifest.cursor as unknown as Record<string, unknown>, CURSOR_FIELDS, 'manifest.cursor');
  }
  for (const [key, batch] of Object.entries(manifest.batches)) {
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
      throw new RunEngineError('corruption', `manifest.batches.${key} 非法`);
    }
    assertNoUnknownKeys(batch as unknown as Record<string, unknown>, BATCH_ENTRY_FIELDS, `manifest.batches.${key}`);
  }
  if (manifest.applies !== undefined && manifest.applies !== null) {
    if (typeof manifest.applies !== 'object' || Array.isArray(manifest.applies)) {
      throw new RunEngineError('corruption', 'manifest applies 分节非法');
    }
    for (const [applyId, record] of Object.entries(manifest.applies)) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new RunEngineError('corruption', `apply ${applyId} 非法`);
      }
      const r = record as { applyId?: unknown; workflowId?: unknown; state?: unknown };
      if (r.applyId !== applyId || r.workflowId !== workflowId || typeof r.state !== 'string') {
        throw new RunEngineError('corruption', `apply ${applyId} 归属/字段不符`);
      }
      assertNoUnknownKeys(record as unknown as Record<string, unknown>, APPLY_RECORD_FIELDS, `manifest.applies.${applyId}`);
    }
  }
}

/** run plan bytes 完整严格校验(version + 身份字段 + 白名单 + canonical 回环 + digest 重建)。 */
function validateRunPlanBytes(bytes: ReadonlyBytes, manifest: RunWorkflowManifest): void {
  const doc = parseJsonDoc(bytes, 'run plan');
  assertNoUnknownKeys(doc as Record<string, unknown>, RUN_PLAN_TOP_FIELDS, 'run plan');
  const plan = doc as Record<string, unknown>;
  if (!Array.isArray(plan.batches)) throw new RunEngineError('corruption', 'run plan batches 非法');
  for (const batch of plan.batches) {
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
      throw new RunEngineError('corruption', 'run plan batch 非法');
    }
    assertNoUnknownKeys(batch as Record<string, unknown>, RUN_BATCH_FIELDS, 'run plan batch');
    const apply = (batch as Record<string, unknown>).apply;
    if (apply !== undefined) {
      if (apply === null || typeof apply !== 'object' || Array.isArray(apply)) {
        throw new RunEngineError('corruption', 'run plan apply 非法');
      }
      assertNoUnknownKeys(apply as Record<string, unknown>, APPLY_TARGET_FIELDS, 'run plan apply');
    }
  }
  if (plan.version !== RUN_PLAN_VERSION) throw new RunEngineError('corruption', 'run plan version 不兼容');
  for (const field of ['workflowId', 'kind', 'inputFingerprint', 'profileFingerprint', 'planDigest', 'createdAt'] as const) {
    if (plan[field] !== manifest[field]) {
      throw new RunEngineError('corruption', `run plan ${field} 与 manifest 不符(篡改/损坏)`);
    }
  }
  const rebuilt = planDigestOf({
    kind: plan.kind as WorkflowKind,
    inputFingerprint: plan.inputFingerprint as string,
    profileFingerprint: plan.profileFingerprint as string,
    uniqueRunId: 'persistence-check',
    batches: plan.batches as unknown as readonly RunBatchSpec[],
  });
  if (rebuilt !== plan.planDigest) {
    throw new RunEngineError('corruption', 'run plan digest 重建不符(篡改/损坏)');
  }
  assertCanonicalJsonBytes(bytes, plan, 'run plan');
}

/** batch plan 文档完整严格校验(白名单 + canonical 回环 + batchPaths 身份/路径全量重验)。 */
function parseBatchPlanDocStrict(bytes: ReadonlyBytes, kind: WorkflowKind, what: string): BatchPlan {
  const doc = parseJsonDoc(bytes, what);
  assertNoUnknownKeys(doc as Record<string, unknown>, BATCH_PLAN_FIELDS, what);
  try {
    batchPaths(kind, doc as BatchPlan);
  } catch (err) {
    throw new RunEngineError('corruption', `${what} 身份校验失败: ${(err as Error).message}`);
  }
  assertCanonicalJsonBytes(bytes, doc, what);
  return doc as BatchPlan;
}

/** artifact 文档完整严格校验(信封自描述 + 白名单 + canonical 回环; 无自引用 hash)。 */
function parseArtifactDocStrict(bytes: ReadonlyBytes, workflowId: string, batchId: string): BatchArtifact {
  const doc = parseJsonDoc(bytes, 'artifact');
  assertNoUnknownKeys(doc as Record<string, unknown>, ARTIFACT_FIELDS, 'artifact');
  const o = doc as Record<string, unknown>;
  if (o.version !== 1 || o.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new RunEngineError('corruption', 'artifact schema 版本不符');
  }
  if (o.workflowId !== workflowId || o.batchId !== batchId) {
    throw new RunEngineError('corruption', 'artifact 归属与事务不符');
  }
  if (
    typeof o.phase !== 'string'
    || !Number.isSafeInteger(o.ordinal)
    || typeof o.inputFingerprint !== 'string'
    || typeof o.outputSchemaVersion !== 'string'
  ) {
    throw new RunEngineError('corruption', 'artifact 自描述字段缺失/非法');
  }
  assertCanonicalJsonBytes(bytes, doc, 'artifact');
  return doc as BatchArtifact;
}

/** receipt 文档完整严格校验(makeBatchReceipt 全字段 + 白名单 + canonical 回环)。 */
function parseReceiptDocStrict(bytes: ReadonlyBytes): BatchReceipt {
  const doc = parseJsonDoc(bytes, 'receipt');
  assertNoUnknownKeys(doc as Record<string, unknown>, RECEIPT_FIELDS, 'receipt');
  const r = doc as Record<string, unknown>;
  try {
    makeBatchReceipt({
      workflowId: r.workflowId as string,
      batchId: r.batchId as string,
      resultHash: r.resultHash as string,
      transactionId: r.transactionId as string,
      committedAt: r.committedAt as string,
    });
  } catch (err) {
    throw new RunEngineError('corruption', `receipt 无法验证: ${(err as Error).message}`);
  }
  assertCanonicalJsonBytes(bytes, doc, 'receipt');
  return doc as BatchReceipt;
}

/**
 * 生产持久化适配器 —— RunPersistencePort 的 Git-backed 实现。
 *
 * 用法: `new GitRunPersistence(vaultRoot)` 作为 RunEnginePorts.persistence。
 * 所有 state 写经 @novelcraft/store executeTransaction(kind state/run_bootstrap);
 * 读取一律从工作树文件/Git truth 重建, 不维护进程内缓存。
 */
export class GitRunPersistence implements RunPersistencePort {
  readonly vault: string;
  private readonly transactionOptions: TransactionOptions;

  constructor(vault: string, options: GitRunPersistenceOptions = {}) {
    this.vault = path.resolve(vault);
    this.transactionOptions = options.transactionOptions ?? {};
  }

  /** 该 workflowId 是否已有 run(expected-absent 门禁之一; 权威门禁在 run_bootstrap 事务内)。 */
  async hasRun(workflowId: string): Promise<boolean> {
    const kind = kindFromWorkflowId(workflowId);
    const root = workflowRunRoot(kind, workflowId);
    const planMarker = `${root}/${RUN_PLAN_FILENAME}`;
    if (readCommittedFile(this.vault, planMarker, 'HEAD') !== undefined) return true;
    if (fileExists(path.join(this.vault, planMarker))) return true;
    // 未提交的 READY intent 同样视为「已存在」(崩溃窗口一: bootstrap intent 已耐久)
    for (const txid of listInterruptedIntents(this.vault)) {
      let record: IntentRecord;
      try {
        record = readIntentRecord(this.vault, txid).record;
      } catch {
        continue; // 半写/损坏 intent 由恢复收敛 fail-closed; 存在性判定不依赖它
      }
      if (record.targets.some((t) => t.path.startsWith(`${root}/`))) return true;
    }
    return false;
  }

  /** Capability source for adjacent machine-state writes owned by this committed run. */
  committedPlanSource(workflowId: string): { path: string; digest: string } {
    const kind = kindFromWorkflowId(workflowId);
    const planPath = `${workflowRunRoot(kind, workflowId)}/${RUN_PLAN_FILENAME}`;
    return { path: planPath, digest: this.committedRunPlanDigest(planPath) };
  }

  /**
   * 读取 run 状态(manifest + run plan + intents):
   * 1) 先完整严格验证全部 READY durable intents(kind 注册表 + 机器 namespace 能力
   *    + 每目标严格 ∈ 同一 canonical run root + run_bootstrap runId 绑定);
   * 2) 再收敛全部中断事务(recoverInterruptedTransactions; invalid/preserved/
   *    ref_race 未收敛 → fail-closed, force 不能绕过);
   * 3) 从工作树文件读全部 run 文档, 与 Git(HEAD)已提交字节逐文档对账
   *    (run plan/batch plan/artifact/receipt/manifest 工作树精确 == HEAD bytes),
   *    每文档 strict no-unknown + canonical 字节, 严格校验后返回。
   */
  async loadRunState(workflowId: string): Promise<{
    manifest?: RunWorkflowManifest;
    runPlan?: ReadonlyBytes;
    intents: readonly DurableIntent[];
  }> {
    const kind = kindFromWorkflowId(workflowId);
    const root = workflowRunRoot(kind, workflowId);
    this.assertRunIntentsStrict();
    const recovery = await recoverInterruptedTransactions(this.vault, { lockStaleMs: 1 });
    if (recovery.unresolved.length > 0) {
      throw new RunEngineError(
        'corruption',
        `存在未收敛 durable intent(fail-closed, 需人工修复; force 不能绕过): ${recovery.unresolved.join(', ')}`,
      );
    }
    const manifestBytes = readFileIfExists(path.join(this.vault, root, RUN_MANIFEST_FILENAME));
    const runPlanBytes = readFileIfExists(path.join(this.vault, root, RUN_PLAN_FILENAME));
    if (manifestBytes === undefined && runPlanBytes === undefined) return { intents: [] };
    if (manifestBytes === undefined || runPlanBytes === undefined) {
      throw new RunEngineError('corruption', 'manifest 与 run plan 必须同批存在(bootstrap 单事务), 缺失即损坏');
    }
    const manifest = this.parseManifestStrict(manifestBytes, workflowId);
    validateRunPlanBytes(runPlanBytes, manifest);
    // Git truth 对账(复审 R9): 工作树字节必须精确等于 HEAD 已提交字节(未提交外部编辑 fail-closed)
    const headManifest = gitShowBytes(this.vault, `HEAD:${root}/${RUN_MANIFEST_FILENAME}`);
    const headRunPlan = gitShowBytes(this.vault, `HEAD:${root}/${RUN_PLAN_FILENAME}`);
    if (headManifest === undefined || !bytesEqual(headManifest, manifestBytes)) {
      throw new RunEngineError('corruption', 'manifest 与 Git 已提交字节不符(损坏/篡改, fail-closed)');
    }
    if (headRunPlan === undefined || !bytesEqual(headRunPlan, runPlanBytes)) {
      throw new RunEngineError('corruption', 'run plan 与 Git 已提交字节不符(损坏/篡改, fail-closed)');
    }
    // 逐批文档对账: plan 恒须工作树 == HEAD(或同缺); artifact/receipt 在已提交批必须存在且相等。
    for (const [batchId, entry] of Object.entries(manifest.batches)) {
      const planBytes = readFileIfExists(path.join(this.vault, entry.planPath));
      const headPlan = gitShowBytes(this.vault, `HEAD:${entry.planPath}`);
      const planAbsent = planBytes === undefined;
      const headAbsent = headPlan === undefined;
      if (planAbsent !== headAbsent || (!planAbsent && !bytesEqual(planBytes!, headPlan!))) {
        throw new RunEngineError('corruption', `batch ${batchId} plan 工作树与 Git 已提交字节不符(损坏/篡改, fail-closed)`);
      }
      if (planBytes === undefined) continue; // 尚未提交该批计划(正常推进中)
      const plan = parseBatchPlanDocStrict(planBytes, kind, `batch ${batchId} plan`);
      if (plan.workflowId !== workflowId || plan.batchId !== batchId) {
        throw new RunEngineError('corruption', `batch ${batchId} plan 归属与 manifest 不符`);
      }
      if (plan.phase !== entry.phase || plan.ordinal !== entry.ordinal) {
        throw new RunEngineError('corruption', `batch ${batchId} plan 与 manifest 条目不符`);
      }
      if (entry.state === 'artifact_committed' || entry.state === 'completed') {
        const artifactBytes = readFileIfExists(path.join(this.vault, entry.artifactPath));
        const headArtifact = gitShowBytes(this.vault, `HEAD:${entry.artifactPath}`);
        if (artifactBytes === undefined || headArtifact === undefined || !bytesEqual(artifactBytes, headArtifact)) {
          throw new RunEngineError('corruption', `batch ${batchId} artifact 工作树与 Git 已提交字节不符(损坏/篡改, fail-closed)`);
        }
        const receiptBytes = readFileIfExists(path.join(this.vault, entry.receiptPath));
        const headReceipt = gitShowBytes(this.vault, `HEAD:${entry.receiptPath}`);
        if (receiptBytes === undefined || headReceipt === undefined || !bytesEqual(receiptBytes, headReceipt)) {
          throw new RunEngineError('corruption', `batch ${batchId} receipt 工作树与 Git 已提交字节不符(损坏/篡改, fail-closed)`);
        }
        // 文档 strict(白名单 + canonical 回环)+ 身份绑定已提交批次计划
        const artifact = parseArtifactDocStrict(artifactBytes, workflowId, batchId);
        if (artifact.phase !== plan.phase || artifact.ordinal !== plan.ordinal || artifact.inputFingerprint !== plan.inputFingerprint) {
          throw new RunEngineError('corruption', `batch ${batchId} artifact 身份字段与已提交批次计划不符`);
        }
        const receipt = parseReceiptDocStrict(receiptBytes);
        if (receipt.workflowId !== workflowId || receipt.batchId !== batchId) {
          throw new RunEngineError('corruption', `batch ${batchId} receipt 归属与 manifest 不符`);
        }
        if (workflowSha256(artifactBytes) !== receipt.resultHash) {
          throw new RunEngineError('corruption', `batch ${batchId} artifact 字节 hash 与 receipt 不符(损坏), 保留现场`);
        }
        if (entry.resultHash !== undefined && entry.resultHash !== receipt.resultHash) {
          throw new RunEngineError('corruption', `batch ${batchId} manifest 与 receipt resultHash 不符`);
        }
        if (entry.transactionId !== undefined && entry.transactionId !== receipt.transactionId) {
          throw new RunEngineError('corruption', `batch ${batchId} manifest 与 receipt transactionId 不符`);
        }
      }
    }
    return { manifest, runPlan: runPlanBytes, intents: [] };
  }

  /** 读 run namespace 内文件的精确字节(工作树; 缺失返回 undefined)。 */
  async readBytes(relPath: string): Promise<Uint8Array | undefined> {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new RunEngineError('invalid', 'readBytes 路径非法');
    }
    if (runNamespaceOf(relPath) === undefined) {
      throw new RunEngineError('invalid', `readBytes 路径不在 canonical run namespace(拒绝): ${relPath}`);
    }
    // canonicalize 后拒绝 `.`/`..`/绝对/反斜杠/编码逃逸(复审 R8)
    assertCanonicalRelPath(relPath, 'readBytes 路径');
    let abs: string;
    try {
      abs = guardPath(this.vault, relPath);
      assertNoSymlinkOnPath(this.vault, abs);
    } catch (err) {
      throw new RunEngineError('corruption', `readBytes 路径不安全(symlink/越界, fail-closed): ${relPath}: ${(err as Error).message}`);
    }
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RunEngineError('corruption', `readBytes 读取失败: ${relPath}: ${(err as Error).message}`);
    }
    if (!st.isFile()) {
      throw new RunEngineError('corruption', `run 路径不是普通文件(fail-closed): ${relPath}`);
    }
    return fs.readFileSync(abs);
  }

  /**
   * 执行一个 state transaction(每次调用 = 一个 store 事务):
   * 严格校验 tx(路径限制到本 workflow canonical run root + 确定性布局 + exact
   * bytes/hash 绑定 + 文档白名单)→ 先收敛全部中断事务 → 以**持久 HEAD manifest
   * 快照**为 expected 基线(绝不从工作树刷新)→ 验证合法前态→后态转换 →
   * executeTransaction(kind state / run_bootstrap; 目录由 store 写面在 preflight
   * 之后创建, 本适配器不 mkdir)→ 从已提交 truth 重建 manifest 返回。
   */
  async applyState(tx: RunStateTransaction): Promise<RunWorkflowManifest> {
    const planned = this.validateTxStrict(tx);
    const recovery = await recoverInterruptedTransactions(this.vault, { lockStaleMs: 1 });
    if (recovery.unresolved.length > 0) {
      throw new RunEngineError(
        'conflict',
        `存在未收敛 durable intent, 拒绝新状态事务(fail-closed): ${recovery.unresolved.join(', ')}`,
      );
    }
    // 先前持久状态(调用方上一状态 = HEAD 已提交 manifest 快照; 复审 R7:
    // expected 基线来自持久快照, 绝不读工作树刷新)。
    const prev = this.loadPrevManifestStrict(planned.root, tx.workflowId);
    this.assertTxTransition(tx, prev.manifest);
    const writeSet: TargetSpec[] = planned.files.map((f) => {
      if (f.immutable) {
        // 不可变文档: 恒 expected absent; 存在即冲突(拒绝覆盖)。bootstrap 的 run plan
        // 由 run_bootstrap 事务在锁内封闭检查(HEAD:<runFile> 缺席), 此处不做预检。
        if (tx.kind !== 'bootstrap') {
          if (fileExists(path.join(this.vault, f.path)) || gitShowBytes(this.vault, `HEAD:${f.path}`) !== undefined) {
            throw new RunEngineError('conflict', `不可变 run 文档已存在, 拒绝覆盖(fail-closed): ${f.path}`);
          }
        }
        return {
          path: f.path,
          expected: { absent: true, sha256: '' },
          output: toBuffer(f.bytes).toString('utf8'),
        };
      }
      // manifest: expected = 先前持久 manifest 的精确字节 hash(内容 CAS 唯一基线,
      // 调用方上一状态); bootstrap 恒全目标 expected absent(run_bootstrap 契约)。
      const expected = tx.kind === 'bootstrap' || prev.bytes === undefined
        ? { absent: true, sha256: '' }
        : { absent: false, sha256: sha256Hex(prev.bytes) };
      return {
        path: f.path,
        expected,
        output: toBuffer(f.bytes).toString('utf8'),
      };
    });
    const request: TransactionRequest = {
      kind: planned.txKind,
      purpose: `run state ${tx.kind} ${tx.workflowId}`,
      writeSet,
    };
    if (planned.txKind === 'run_bootstrap') {
      // 受限创建: 自描述 runId/inputFingerprint/runFile; 全目标 expected absent +
      // HEAD:<runFile> 缺席在事务内封闭 TOCTOU(绝不覆盖既有 run)。
      request.runId = tx.workflowId;
      request.inputFingerprint = tx.manifest.inputFingerprint;
      request.runFile = planned.runPlanPath;
    } else {
      // state: 已提交 plan 来源(§8 能力重推导; run plan 不可变 → HEAD digest 稳定)
      request.planSource = { path: planned.runPlanPath, digest: this.committedRunPlanDigest(planned.runPlanPath) };
    }
    await executeTransaction(this.vault, request, this.transactionOptions);
    return this.readCommittedManifest(tx.workflowId);
  }

  // —— 内部 ——

  /** 先前持久 manifest 快照(HEAD 已提交字节 + 严格解析; 缺失返回 undefined)。 */
  private loadPrevManifestStrict(root: string, workflowId: string): { bytes: Uint8Array | undefined; manifest: RunWorkflowManifest | undefined } {
    const bytes = gitShowBytes(this.vault, `HEAD:${root}/${RUN_MANIFEST_FILENAME}`);
    if (bytes === undefined) return { bytes: undefined, manifest: undefined };
    return { bytes, manifest: this.parseManifestStrict(bytes, workflowId) };
  }

  /**
   * 合法前态→后态转换验证(复审 R9): 以先前持久 manifest(调用方上一状态)为前态,
   * tx.manifest 为后态, 逐 kind 验证身份字段不变 + 状态机转换合法 + 无关字段不变。
   */
  private assertTxTransition(tx: RunStateTransaction, prev: RunWorkflowManifest | undefined): void {
    if (tx.kind === 'bootstrap') {
      // 既有 run 由 run_bootstrap 事务封闭拒绝(INVALID_REQUEST, 绝不覆盖); 此处不预检。
      return;
    }
    if (prev === undefined) {
      throw new RunEngineError('corruption', 'state 事务缺少先前持久 manifest(快照缺失, fail-closed)');
    }
    const next = tx.manifest;
    for (const field of ['version', 'workflowId', 'kind', 'createdAt', 'inputFingerprint', 'profileFingerprint', 'planDigest'] as const) {
      if (prev[field] !== next[field]) {
        throw new RunEngineError('corruption', `manifest identity 字段 ${field} 在事务间改变(fail-closed)`);
      }
    }
    switch (tx.kind) {
      case 'batch-plan': {
        if (canonicalRunJson(prev) !== canonicalRunJson(next)) {
          throw new RunEngineError('corruption', 'batch-plan 事务不得改变 manifest(fail-closed)');
        }
        const prevB = prev.batches[tx.batchId];
        if (prevB === undefined || prevB.state !== 'planned') {
          throw new RunEngineError('corruption', `batch-plan ${tx.batchId} 前态非法(须 planned, 实际 ${prevB === undefined ? '缺失' : prevB.state})`);
        }
        return;
      }
      case 'artifact-receipt': {
        const prevB = prev.batches[tx.batchId];
        const nextB = next.batches[tx.batchId];
        if (prevB === undefined || nextB === undefined) {
          throw new RunEngineError('corruption', `artifact-receipt ${tx.batchId} 批次缺失`);
        }
        if (prevB.state !== 'planned' || nextB.state !== 'artifact_committed') {
          throw new RunEngineError('corruption', `artifact-receipt ${tx.batchId} 前态/后态非法(${prevB.state} → ${nextB.state}, 须 planned → artifact_committed)`);
        }
        if (prevB.resultHash !== undefined || prevB.transactionId !== undefined) {
          throw new RunEngineError('corruption', `artifact ${tx.batchId} 重复提交(fail-closed)`);
        }
        if (nextB.resultHash !== workflowSha256(tx.artifactBytes) || nextB.transactionId !== tx.txid) {
          throw new RunEngineError('corruption', `artifact ${tx.batchId} manifest 结果绑定与事务不符`);
        }
        if (next.status !== 'running' || (prev.status !== 'planning' && prev.status !== 'provider_outcome_unknown' && prev.status !== 'running')) {
          throw new RunEngineError('corruption', `artifact-receipt status 转换非法(${prev.status} → ${next.status})`);
        }
        const previousSpent = prev.budgetSpent ?? 0;
        const nextSpent = next.budgetSpent ?? previousSpent;
        if (!Number.isSafeInteger(nextSpent) || nextSpent < previousSpent) {
          throw new RunEngineError('corruption', 'artifact-receipt budgetSpent 必须单调非减');
        }
        this.assertRestUnchanged(prev, next, { batchId: tx.batchId, status: true, budget: true });
        return;
      }
      case 'cursor': {
        const prevB = prev.batches[tx.batchId];
        const nextB = next.batches[tx.batchId];
        if (prevB === undefined || nextB === undefined) {
          throw new RunEngineError('corruption', `cursor ${tx.batchId} 批次缺失`);
        }
        if (prevB.state !== 'artifact_committed' || nextB.state !== 'completed') {
          throw new RunEngineError('corruption', `cursor ${tx.batchId} 前态/后态非法(${prevB.state} → ${nextB.state}, 须 artifact_committed → completed)`);
        }
        if (prev.status !== 'running' || next.status !== 'running') {
          throw new RunEngineError('corruption', `cursor status 转换非法(${prev.status} → ${next.status}, 须 running → running)`);
        }
        // cursor 不变量: 前态 cursor == 前态最后已完成批次(无则 INITIAL); 后态 cursor
        // 必须精确绑定本批 phase/ordinal; 且严格前向推进(ordinal)。
        const lastPrev = lastCompletedBatchOf(prev);
        if (!cursorEq(prev.cursor, lastPrev ?? INITIAL_RUN_CURSOR)) {
          throw new RunEngineError('corruption', 'cursor 前态不变量破坏(先前 cursor 与已完成批次前缀不符)');
        }
        if (!cursorEq(next.cursor, { phase: nextB.phase, ordinal: nextB.ordinal })) {
          throw new RunEngineError('corruption', `cursor 后态必须精确绑定本批(${nextB.phase}/${nextB.ordinal})`);
        }
        if (lastPrev !== undefined && lastPrev.ordinal >= nextB.ordinal) {
          throw new RunEngineError('corruption', `cursor 未前向推进(${lastPrev.ordinal} → ${nextB.ordinal}, fail-closed)`);
        }
        this.assertRestUnchanged(prev, next, { batchId: tx.batchId, cursor: true });
        return;
      }
      case 'run-status': {
        if (prev.status === next.status) {
          throw new RunEngineError('corruption', `run-status 状态未变化(${prev.status}, fail-closed)`);
        }
        if (!RUN_STATUS_TRANSITIONS[prev.status]?.includes(next.status)) {
          throw new RunEngineError('corruption', `run-status 非法状态转换 ${prev.status} → ${next.status}(fail-closed)`);
        }
        if (next.status === 'completed') {
          // completed 是终态: 全部批次必须已完成(engine 终局不变量, 零批 runs 自然满足)。
          const pending = Object.values(next.batches).filter((b) => b.state !== 'completed');
          if (pending.length > 0) {
            throw new RunEngineError('corruption', `run-status completed 时仍有未完成批次(全部须 completed, fail-closed): ${pending.map((b) => b.batchId).join(', ')}`);
          }
        }
        const previousSpent = prev.budgetSpent ?? 0;
        const nextSpent = next.budgetSpent ?? previousSpent;
        if (!Number.isSafeInteger(nextSpent) || nextSpent < previousSpent) {
          throw new RunEngineError('corruption', 'run-status budgetSpent 必须单调非减');
        }
        this.assertRestUnchanged(prev, next, { status: true, budget: true });
        return;
      }
      case 'apply': {
        const prevRec = prev.applies?.[tx.applyId];
        const nextRec = next.applies?.[tx.applyId];
        if (nextRec === undefined) {
          throw new RunEngineError('corruption', `apply ${tx.applyId} 后态缺失(fail-closed)`);
        }
        this.assertApplyRecordStrict(nextRec, tx.applyId, tx.workflowId);
        if (prevRec === undefined) {
          if (nextRec.state !== 'waiting_approval') {
            throw new RunEngineError('corruption', `新 apply 记录必须以 waiting_approval 起始(实际 ${nextRec.state}, fail-closed)`);
          }
        } else {
          this.assertApplyRecordStrict(prevRec, tx.applyId, tx.workflowId);
          for (const field of ['version', 'workflowId', 'target', 'expectedHash', 'writeSetDigest', 'artifactHash', 'batchId', 'checkpoint', 'planDigest', 'provenance'] as const) {
            if (prevRec[field] !== nextRec[field]) {
              throw new RunEngineError('corruption', `apply ${tx.applyId} 身份字段 ${field} 在转换中改变(fail-closed)`);
            }
          }
          if (!APPLY_STATE_TRANSITIONS[prevRec.state].includes(nextRec.state)) {
            throw new RunEngineError('corruption', `apply 非法状态转换 ${prevRec.state} → ${nextRec.state}(fail-closed)`);
          }
          if (nextRec.state === 'applying') {
            if (prevRec.transactionId !== undefined || prevRec.commitOid !== undefined) {
              throw new RunEngineError('corruption', `apply ${tx.applyId} 已有事务身份, 禁止重复进入 applying`);
            }
            if (nextRec.transactionId === undefined) {
              throw new RunEngineError('corruption', '进入 applying 必须分配 transactionId');
            }
          }
          if (nextRec.state === 'applied') {
            if (prevRec.transactionId === undefined || nextRec.transactionId !== prevRec.transactionId) {
              throw new RunEngineError('corruption', 'applied 必须来自已分配 transactionId 的 applying');
            }
            if (nextRec.commitOid === undefined) {
              throw new RunEngineError('corruption', 'applied 必须注入 commitOid');
            }
          }
        }
        this.assertRestUnchanged(prev, next, { applyId: tx.applyId });
        const bid = nextRec.batchId;
        if (next.batches[bid] === undefined || next.batches[bid].state !== 'completed') {
          throw new RunEngineError('corruption', `apply ${tx.applyId} 目标批次未完成(fail-closed)`);
        }
        return;
      }
      default: {
        throw new RunEngineError('corruption', `未知 state transaction kind(fail-closed): ${(tx as { kind?: string }).kind}`);
      }
    }
  }

  /** 除豁免项外, 前态/后态 manifest 的 status/cursor/batches/applies 必须逐项一致。 */
  private assertRestUnchanged(
    prev: RunWorkflowManifest,
    next: RunWorkflowManifest,
    opts: { batchId?: string; applyId?: string; cursor?: boolean; status?: boolean; budget?: boolean },
  ): void {
    if (opts.budget !== true && prev.budgetSpent !== next.budgetSpent) {
      throw new RunEngineError('corruption', 'manifest budgetSpent 在无关事务中改变(fail-closed)');
    }
    if (opts.status !== true && prev.status !== next.status) {
      throw new RunEngineError('corruption', 'manifest status 在无关事务中改变(fail-closed)');
    }
    if (opts.cursor !== true && !cursorEq(prev.cursor, next.cursor)) {
      throw new RunEngineError('corruption', 'manifest cursor 在无关事务中改变(fail-closed)');
    }
    const prevBatchKeys = Object.keys(prev.batches).sort();
    const nextBatchKeys = Object.keys(next.batches).sort();
    if (prevBatchKeys.length !== nextBatchKeys.length || prevBatchKeys.some((k, i) => k !== nextBatchKeys[i])) {
      throw new RunEngineError('corruption', 'manifest 批次集合在事务间改变(fail-closed)');
    }
    for (const key of prevBatchKeys) {
      if (key === opts.batchId) continue;
      if (canonicalRunJson(prev.batches[key]) !== canonicalRunJson(next.batches[key])) {
        throw new RunEngineError('corruption', `manifest 批次 ${key} 在无关事务中改变(fail-closed)`);
      }
    }
    for (const key of Object.keys(next.applies)) {
      if (key === opts.applyId) continue;
      const prevRec = prev.applies[key];
      if (prevRec === undefined || canonicalRunJson(prevRec) !== canonicalRunJson(next.applies[key])) {
        throw new RunEngineError('corruption', `manifest apply ${key} 在无关事务中改变(fail-closed)`);
      }
    }
    for (const key of Object.keys(prev.applies)) {
      if (key === opts.applyId) continue;
      if (next.applies[key] === undefined) {
        throw new RunEngineError('corruption', `manifest apply ${key} 在无关事务中消失(fail-closed)`);
      }
    }
  }

  /** apply 记录 strict 校验(白名单 + 归属 + 状态-字段一致性, 复审 R4/R9)。 */
  private assertApplyRecordStrict(rec: ApplyRecord, applyId: string, workflowId: string): void {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new RunEngineError('corruption', `apply ${applyId} 记录非法`);
    }
    assertNoUnknownKeys(rec as unknown as Record<string, unknown>, APPLY_RECORD_FIELDS, `apply ${applyId}`);
    if (rec.applyId !== applyId || rec.workflowId !== workflowId) {
      throw new RunEngineError('corruption', `apply ${applyId} 归属与事务不符`);
    }
    if (rec.version !== WORKFLOW_RUN_VERSION) {
      throw new RunEngineError('corruption', 'apply record version 不兼容');
    }
    if (!APPLY_STATES.includes(rec.state)) {
      throw new RunEngineError('corruption', `apply state 未知: ${String(rec.state)}`);
    }
    for (const field of ['expectedHash', 'writeSetDigest', 'artifactHash', 'checkpoint', 'planDigest'] as const) {
      if (typeof rec[field] !== 'string' || !SHA256_RE.test(rec[field])) {
        throw new RunEngineError('corruption', `apply ${applyId} ${field} 必须是 sha256`);
      }
    }
    for (const field of ['batchId', 'provenance'] as const) {
      if (typeof rec[field] !== 'string' || !ID_RE.test(rec[field])) {
        throw new RunEngineError('corruption', `apply ${applyId} ${field} 非法`);
      }
    }
    if (typeof rec.target !== 'string' || rec.target.length === 0 || rec.target.length > 2048
      || rec.target.startsWith('/') || rec.target.includes('\\') || rec.target.includes('..')
      || /[\u0000-\u001f\u007f]/.test(rec.target)) {
      throw new RunEngineError('corruption', `apply ${applyId} target 非法`);
    }
    if (rec.transactionId !== undefined && (typeof rec.transactionId !== 'string' || !/^tx-[0-9a-f]{40,64}$/.test(rec.transactionId))) {
      throw new RunEngineError('corruption', `apply ${applyId} transactionId 非法`);
    }
    if (rec.commitOid !== undefined && (typeof rec.commitOid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rec.commitOid))) {
      throw new RunEngineError('corruption', `apply ${applyId} commitOid 非法`);
    }
    if (rec.failure !== undefined && (typeof rec.failure !== 'string' || rec.failure.length === 0 || rec.failure.length > 512)) {
      throw new RunEngineError('corruption', `apply ${applyId} failure 非法`);
    }
    if (typeof rec.updatedAt !== 'string' || !Number.isFinite(Date.parse(rec.updatedAt))) {
      throw new RunEngineError('corruption', `apply ${applyId} updatedAt 非法`);
    }
    // 状态-字段一致性(复审 R4): commitOid 只允许 applied; transactionId 只允许 applying/applied/failed。
    if (rec.commitOid !== undefined && rec.state !== 'applied') {
      throw new RunEngineError('corruption', `apply ${applyId} commitOid 只允许出现在 applied 状态`);
    }
    if (rec.transactionId !== undefined && rec.state !== 'applying' && rec.state !== 'applied' && rec.state !== 'failed') {
      throw new RunEngineError('corruption', `apply ${applyId} transactionId 只允许出现在 applying/applied/failed`);
    }
    if (rec.state === 'applied' && (rec.transactionId === undefined || rec.commitOid === undefined)) {
      throw new RunEngineError('corruption', `apply ${applyId} applied 必须携带 transactionId+commitOid`);
    }
  }

  /** 严格校验单个 state transaction(路径/布局/bytes/hash/白名单绑定; 任何不符 fail-closed)。 */
  private validateTxStrict(tx: RunStateTransaction): TxPlan {
    if (tx === null || typeof tx !== 'object') throw new RunEngineError('invalid', 'state transaction 非法');
    const manifest = tx.manifest;
    validateManifestStrict(manifest, tx.workflowId);
    const kind = manifest.kind;
    const root = workflowRunRoot(kind, tx.workflowId);
    const runPlanPath = `${root}/${RUN_PLAN_FILENAME}`;
    const manifestFile: PlannedFile = {
      path: `${root}/${RUN_MANIFEST_FILENAME}`,
      bytes: Buffer.from(`${canonicalRunJson(manifest)}\n`, 'utf8'),
      immutable: false,
    };
    switch (tx.kind) {
      case 'bootstrap': {
        assertWithinRunRoot(tx.runPlanPath, root, 'bootstrap run plan 路径');
        if (tx.runPlanPath !== runPlanPath) {
          throw new RunEngineError('corruption', `bootstrap run plan 路径越出 canonical run namespace: ${tx.runPlanPath}`);
        }
        validateRunPlanBytes(tx.runPlan, manifest);
        return {
          txKind: 'run_bootstrap',
          root,
          runPlanPath,
          files: [{ path: tx.runPlanPath, bytes: tx.runPlan, immutable: true }, manifestFile],
        };
      }
      case 'batch-plan': {
        const batch = manifest.batches[tx.batchId];
        if (batch === undefined || batch.state !== 'planned') {
          throw new RunEngineError('corruption', `batch-plan ${tx.batchId} 与 manifest 批次状态不符`);
        }
        assertNoUnknownKeys(tx.plan as unknown as Record<string, unknown>, BATCH_PLAN_FIELDS, 'batch plan');
        // 身份绑定: plan ↔ state transaction ↔ manifest 条目(跨 run 拒绝)
        if (tx.plan.workflowId !== tx.workflowId || tx.plan.batchId !== tx.batchId) {
          throw new RunEngineError('corruption', 'batch plan 归属与 state transaction 不符(跨 run 拒绝)');
        }
        if (tx.plan.phase !== batch.phase || tx.plan.ordinal !== batch.ordinal) {
          throw new RunEngineError('corruption', 'batch plan 与 manifest 批次条目不符');
        }
        let expectedPlanPath: string;
        try {
          expectedPlanPath = batchPaths(kind, tx.plan).planPath;
        } catch (err) {
          throw new RunEngineError('corruption', `batch plan 身份校验失败: ${(err as Error).message}`);
        }
        assertWithinRunRoot(tx.path, root, 'batch plan 路径');
        if (tx.path !== expectedPlanPath) {
          throw new RunEngineError('corruption', 'batch plan 路径与确定性布局不符');
        }
        const canonical = Buffer.from(`${canonicalRunJson(tx.plan)}\n`, 'utf8');
        if (!bytesEqual(canonical, toBuffer(tx.bytes))) {
          throw new RunEngineError('corruption', 'batch plan bytes 与 canonical 序列化不符(exact bytes)');
        }
        return {
          txKind: 'state',
          root,
          runPlanPath,
          files: [{ path: tx.path, bytes: tx.bytes, immutable: true }, manifestFile],
        };
      }
      case 'artifact-receipt': {
        const batch = manifest.batches[tx.batchId];
        if (batch === undefined || batch.state !== 'artifact_committed') {
          throw new RunEngineError('corruption', `artifact-receipt ${tx.batchId} 与 manifest 批次状态不符`);
        }
        this.assertArtifactLayout(root, kind, tx);
        // receipt 完整严格验证(makeBatchReceipt 全字段 + 白名单 + canonical 回环)
        // + 归属 + 事务身份绑定
        let receipt: BatchReceipt;
        try {
          receipt = parseReceiptDocStrict(tx.receiptBytes);
        } catch (err) {
          if (err instanceof RunEngineError) throw err;
          throw new RunEngineError('corruption', `receipt 无法验证: ${(err as Error).message}`);
        }
        if (receipt.workflowId !== tx.workflowId || receipt.batchId !== tx.batchId || receipt.transactionId !== tx.txid) {
          throw new RunEngineError('corruption', 'receipt 归属/事务身份与 state transaction 不符');
        }
        // artifact 精确字节 hash 必须等于 receipt observed result_hash(无自引用)
        if (workflowSha256(tx.artifactBytes) !== receipt.resultHash) {
          throw new RunEngineError('corruption', 'artifact 精确字节 hash 与 receipt observed result_hash 不符');
        }
        if (batch.resultHash !== receipt.resultHash || batch.transactionId !== tx.txid) {
          throw new RunEngineError('corruption', 'manifest 批次结果绑定与 receipt/事务不符');
        }
        return {
          txKind: 'state',
          root,
          runPlanPath,
          files: [
            { path: tx.artifactPath, bytes: tx.artifactBytes, immutable: true }, // artifact 先于 receipt
            { path: tx.receiptPath, bytes: tx.receiptBytes, immutable: true },
            manifestFile,
          ],
        };
      }
      case 'cursor': {
        const batch = manifest.batches[tx.batchId];
        if (batch === undefined || batch.state !== 'completed') {
          throw new RunEngineError('corruption', `cursor ${tx.batchId} 与 manifest 批次状态不符`);
        }
        return { txKind: 'state', root, runPlanPath, files: [manifestFile] };
      }
      case 'run-status': {
        return { txKind: 'state', root, runPlanPath, files: [manifestFile] };
      }
      case 'apply': {
        if (typeof tx.applyId !== 'string' || !tx.applyId.startsWith('apply-')) {
          throw new RunEngineError('corruption', 'apply state transaction applyId 非法');
        }
        if (manifest.applies === undefined || manifest.applies[tx.applyId] === undefined) {
          throw new RunEngineError('corruption', `apply ${tx.applyId} 不在 manifest applies 分节`);
        }
        return { txKind: 'state', root, runPlanPath, files: [manifestFile] };
      }
      default: {
        throw new RunEngineError('corruption', `未知 state transaction kind(fail-closed): ${(tx as { kind?: string }).kind}`);
      }
    }
  }

  /** artifact/receipt 确定性布局对账 + artifact 身份字段精确绑定已提交批次计划。 */
  private assertArtifactLayout(root: string, kind: WorkflowKind, tx: Extract<RunStateTransaction, { kind: 'artifact-receipt' }>): void {
    assertWithinRunRoot(tx.artifactPath, root, 'artifact 路径');
    assertWithinRunRoot(tx.receiptPath, root, 'receipt 路径');
    const m = new RegExp(`^${root}/batches/([^/]+)/([^/]+)\\.artifact\\.json$`).exec(tx.artifactPath);
    if (m === null || m[2] !== tx.batchId) {
      throw new RunEngineError('corruption', 'artifact 路径与确定性布局不符');
    }
    const phase = m[1];
    if (!PATH_SEGMENT_RE.test(phase)) throw new RunEngineError('corruption', 'artifact 路径 phase 段非法');
    if (tx.receiptPath !== `${root}/batches/${phase}/${tx.batchId}.receipt.json`) {
      throw new RunEngineError('corruption', 'receipt 路径与确定性布局不符');
    }
    const planPath = `${root}/batches/${phase}/${tx.batchId}.plan.json`;
    const planBytes = readFileIfExists(path.join(this.vault, planPath));
    if (planBytes === undefined) {
      throw new RunEngineError('corruption', `已提交批次计划缺失, 无法对账(fail-closed): ${planPath}`);
    }
    // 不可变批次计划: 工作树字节必须精确等于 HEAD(外部篡改 fail-closed)
    const headPlan = gitShowBytes(this.vault, `HEAD:${planPath}`);
    if (headPlan === undefined || !bytesEqual(headPlan, planBytes)) {
      throw new RunEngineError('corruption', `已提交批次计划与 Git 已提交字节不符(损坏/篡改, fail-closed): ${planPath}`);
    }
    const plan = parseBatchPlanDocStrict(planBytes, kind, '已提交批次计划');
    if (plan.workflowId !== tx.workflowId || plan.batchId !== tx.batchId) {
      throw new RunEngineError('corruption', '批次计划归属与 state transaction 不符');
    }
    const derived = batchPaths(kind, plan);
    const entry = tx.manifest.batches[tx.batchId];
    if (derived.artifactPath !== tx.artifactPath || derived.receiptPath !== tx.receiptPath
      || derived.planPath !== planPath
      || entry === undefined
      || entry.planPath !== planPath || entry.artifactPath !== tx.artifactPath || entry.receiptPath !== tx.receiptPath
      || entry.phase !== plan.phase || entry.ordinal !== plan.ordinal) {
      throw new RunEngineError('corruption', 'artifact/receipt 路径与已提交计划/确定性布局不符');
    }
    // artifact 身份字段(workflowId/batchId/phase/ordinal/inputFingerprint)精确绑定
    // committed batch plan(复审 R9)
    const artifact = parseArtifactDocStrict(tx.artifactBytes, tx.workflowId, tx.batchId);
    if (artifact.phase !== plan.phase || artifact.ordinal !== plan.ordinal || artifact.inputFingerprint !== plan.inputFingerprint) {
      throw new RunEngineError('corruption', 'artifact 身份字段与已提交批次计划不符(fail-closed)');
    }
  }

  /**
   * 完整严格验证全部 READY durable intents(先于收敛; 任何不符 → fail-closed, 不动现场):
   * kind 封闭注册表 + 机器 namespace 能力 + **每一 target 严格属于同一 canonical run
   * root**(混入 watch-state/checkpoint 等非 run 机器状态目标一律拒绝保留, 复审 R10)
   * + run_bootstrap runId 绑定。
   */
  private assertRunIntentsStrict(): void {
    for (const txid of listInterruptedIntents(this.vault)) {
      let record: IntentRecord;
      try {
        record = readIntentRecord(this.vault, txid).record;
      } catch (err) {
        throw new RunEngineError('corruption', `durable intent ${txid} 读取/验证失败(fail-closed, 保留现场): ${(err as Error).message}`);
      }
      if (record.kind !== 'canonical' && record.kind !== 'checkpoint' && record.kind !== 'state' && record.kind !== 'run_bootstrap') {
        throw new RunEngineError('corruption', `durable intent ${txid} kind 不在封闭注册表: ${record.kind}`);
      }
      // canonical(adopt 类)由 store 恢复条件回滚/重新审批, 与 run namespace 无关;
      // state/checkpoint/run_bootstrap 目标必须限定机器 namespace(永不作者内容)。
      if (record.kind === 'canonical') continue;
      const runIds = new Set<string>();
      for (const t of record.targets) {
        if (!t.path.startsWith(ASSISTANT_NS)) {
          throw new RunEngineError('corruption', `durable intent ${txid} 目标越出机器 namespace(不得写作者内容): ${t.path}`);
        }
        // 每一 target 必须严格属于某个 canonical run root(混入 watch-state/checkpoint
        // 等非 run 机器状态目标 → fail-closed, intent 保留现场供人工修复)。
        const ns = runNamespaceOf(t.path);
        if (ns === undefined) {
          throw new RunEngineError(
            'corruption',
            `durable intent ${txid} 目标不在 canonical run namespace(混入非 run 机器状态, 拒绝保留): ${t.path}`,
          );
        }
        runIds.add(ns.workflowId);
      }
      // 单事务所有 target 必须严格属于**同一** canonical run root(路径级隔离)。
      if (runIds.size !== 1) {
        throw new RunEngineError('corruption', `durable intent ${txid} 目标跨多个 canonical run root, 路径级隔离破坏(拒绝保留)`);
      }
      if (record.kind === 'run_bootstrap' && record.runId !== undefined) {
        const [rid] = [...runIds];
        if (record.runId !== rid) {
          throw new RunEngineError('corruption', `durable intent ${txid} run_bootstrap runId 与目标 run 不符`);
        }
      }
    }
  }

  private parseManifestStrict(bytes: Uint8Array, workflowId: string): RunWorkflowManifest {
    const parsed = parseJsonDoc(bytes, 'manifest');
    validateManifestStrict(parsed as RunWorkflowManifest, workflowId);
    assertCanonicalJsonBytes(bytes, parsed, 'manifest');
    return parsed as RunWorkflowManifest;
  }

  private readCommittedManifest(workflowId: string): RunWorkflowManifest {
    const root = workflowRunRoot(kindFromWorkflowId(workflowId), workflowId);
    const bytes = readFileIfExists(path.join(this.vault, root, RUN_MANIFEST_FILENAME));
    if (bytes === undefined) {
      throw new RunEngineError('corruption', 'manifest 缺失(事务已提交但文件不可读)');
    }
    return this.parseManifestStrict(bytes, workflowId);
  }

  private committedRunPlanDigest(runPlanPath: string): string {
    const bytes = gitShowBytes(this.vault, `HEAD:${runPlanPath}`);
    if (bytes === undefined) {
      throw new RunEngineError('corruption', `已提交 run plan 缺失, state 事务无能力来源: ${runPlanPath}`);
    }
    return sha256Hex(bytes);
  }
}
