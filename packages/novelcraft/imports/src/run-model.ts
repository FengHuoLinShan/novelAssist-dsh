// N33 / ADR-0022 — immutable workflow run/batch/receipt/apply data model.
// 独立审查修复(只做加法 + 公开函数 fail-closed):
//  1. batchPaths 对反序列化 plan 全量重验 identity/path, 拒绝 traversal/篡改;
//  2. applying 进入必分配 transactionId; applied 必须注入 commit 证据并绑定;
//  3. secret 防护覆盖 clientSecret/privateKey/token/bearer/authorization 等常见形态;
//  4. 显式 createWorkflowIdentity / createForcedWorkflowIdentity, force 由内部随机/注入唯一源
//     生成不同 ID, 同 unique 输入不得复用, expected absent 门禁;
//  5. assertManifestCompatible 完整严格校验 createdAt/status/cursor/batches/path/ID 与
//     workflowId 前缀 + input fingerprint 绑定;
//  6. canonical JSON 只接受 plain JSON data(拒 Date/accessor/Proxy/稀疏数组/undefined/function);
//  7. artifact 自描述字段 ordinal + artifactSchemaVersion/outputSchemaVersion;
//  8. identity/manifest 接口 readonly, 构造结果深冻结。
//
// run-model 复审修复(2026-08, 全部 fail-closed):
//  R1. 所有公开输入(BatchPlan/manifest/apply/identity/receipt 等)在进入函数时**一次
//      deep snapshot + plain-data 验证**, 之后只使用快照; Proxy/accessor(含数组索引
//      accessor)、symbol key、non-enumerable key、稀疏/越界/额外属性数组、类实例一律拒绝;
//      structuredClone 缺失时由自遍历 + node:util isProxy 兜底判定, 不 fail-open;
//  R2. 删除公共 allowSecretPaths 与 secret 落盘能力: artifact 任何 secret key 的任意路径
//      一律拒绝, 无白名单; 错误路径用 JSON Pointer 安全编码($ 根, ~ → ~0, / → ~1);
//  R3. assertManifestCompatible 的 expected 强制精确 workflowId 及全部 identity 字段
//      (workflowId/kind/inputFingerprint/profileFingerprint/planDigest, createdAt 提供则精确);
//  R4. apply 状态机修正: 事务已确认(intent 已建)但未 commit 的 apply 可**持久**退回
//      waiting_approval 并清空 transactionId/commitOid(tx fields); 已 commit 不得回退;
//      unknown 状态禁止; ApplyRecord 绑定 writeSetDigest/artifactHash/batchId/checkpoint/
//      planDigest/provenance; commitVerified 布尔移除, applied 必须注入 probe 证据对象
//      (ApplyCommitEvidence)且逐字段与 apply 绑定; 严格验证 current version/identity/
//      target/hash; 非对应转换不接受额外 options 字段;
//  R5. force 每次用内部 random/nonce 全新生成, 不依赖可省 existingIds, 不因 deterministic
//      ID 存在拒新 run; expected-absent(assertExpectedAbsent)是唯一权威; 测试注入 entropy
//      (uniqueSource)可确定验证, 同输入递增唯一; 旧选项 existingIds/maxAttempts 一律拒绝;
//  R6. canonical 遍历 Reflect.ownKeys 并拒 symbol/non-enumerable/accessor/class/sparse/Proxy;
//      artifact bytes 返回**不可变副本**且内部 hash 绑定(类型 ReadonlyBytes wrapper)。
import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export const WORKFLOW_RUN_VERSION = 1;
/** artifact 信封自身的 schema 版本(与 payload 的 outputSchemaVersion 区分)。 */
export const ARTIFACT_SCHEMA_VERSION = 1;
export type WorkflowKind = 'deep-import' | 'map-atlas';
export type BatchState = 'planned' | 'artifact_committed' | 'completed';
export type ApplyState = 'waiting_approval' | 'applying' | 'applied' | 'rejected' | 'skipped' | 'failed';
export type ManifestStatus = 'planning' | 'running' | 'provider_outcome_unknown' | 'waiting_approval' | 'completed' | 'failed';

export interface WorkflowIdentity {
  readonly version: 1;
  readonly workflowId: string;
  readonly kind: WorkflowKind;
  readonly createdAt: string;
  readonly inputFingerprint: string;
  readonly profileFingerprint: string;
  readonly planDigest: string;
}

export interface WorkflowCursor {
  readonly phase: string;
  readonly ordinal: number;
}

export interface BatchManifestEntry {
  readonly batchId: string;
  readonly phase: string;
  readonly ordinal: number;
  readonly state: BatchState;
  readonly planPath: string;
  readonly artifactPath: string;
  readonly receiptPath: string;
  readonly resultHash?: string;
  readonly transactionId?: string;
}

export interface WorkflowManifest extends WorkflowIdentity {
  readonly status: ManifestStatus;
  readonly cursor: WorkflowCursor;
  /** Cumulative workflow-budget consumption persisted across resume. */
  readonly budgetSpent?: number;
  readonly batches: Readonly<Record<string, BatchManifestEntry>>;
}

export interface BatchPlan {
  readonly version: 1;
  readonly workflowId: string;
  readonly batchId: string;
  readonly phase: string;
  readonly ordinal: number;
  readonly inputFingerprint: string;
  readonly sourceIds: readonly string[];
  readonly sourceHashes: Readonly<Record<string, string>>;
}

export interface BatchArtifact<T = unknown> {
  readonly version: 1;
  readonly workflowId: string;
  readonly batchId: string;
  readonly phase: string;
  readonly ordinal: number;
  readonly inputFingerprint: string;
  /** artifact 信封 schema 版本(自描述, 与 payload 无关)。 */
  readonly artifactSchemaVersion: number;
  /** payload/output schema 版本(自描述)。 */
  readonly outputSchemaVersion: string;
  readonly payload: T;
}

export interface BatchReceipt {
  readonly version: 1;
  readonly workflowId: string;
  readonly batchId: string;
  readonly resultHash: string;
  readonly transactionId: string;
  readonly committedAt: string;
}

/**
 * apply 单元(ADR-0022 §6): 从 artifact commit 后的 apply plan 起即绑定全部身份字段——
 * writeSet digest、artifact 观测 hash、batch、checkpoint commit、plan digest 与
 * provenance/idempotency key; 状态机转换只在该绑定之上推进(复审 R4)。
 */
export interface ApplyRecord {
  readonly version: 1;
  readonly applyId: string;
  readonly workflowId: string;
  /** canonical 目标路径(vault 相对)。 */
  readonly target: string;
  /** 目标 generation-time expected state hash(CAS 期望, 审批时不刷新)。 */
  readonly expectedHash: string;
  readonly writeSetDigest: string;
  readonly artifactHash: string;
  readonly batchId: string;
  /** artifact checkpoint commit(apply plan 所基于的已提交 checkpoint)。 */
  readonly checkpoint: string;
  readonly planDigest: string;
  /** provenance/idempotency key。 */
  readonly provenance: string;
  readonly state: ApplyState;
  readonly transactionId?: string;
  readonly commitOid?: string;
  readonly updatedAt: string;
  readonly failure?: string;
}

/**
 * 注入的 probe 证据对象(复审 R4): commitVerified 布尔已移除; applied 必须由调用方
 * (恢复器/运行引擎)在 git 历史中验证 commit 后注入该对象, 且逐字段与 ApplyRecord 绑定。
 */
export interface ApplyCommitEvidence {
  readonly commitOid: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly planDigest: string;
  readonly writeSetDigest: string;
  readonly artifactHash: string;
  readonly verifiedAt: string;
}

/** artifact bytes 的 readonly wrapper(复审 R6): 只读索引/长度, 剔除可变方法。 */
export type ReadonlyBytes = Readonly<Omit<Uint8Array, 'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort'>>;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BATCH_ID_RE = /^batch-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MANIFEST_STATUSES: readonly string[] = ['planning', 'running', 'provider_outcome_unknown', 'waiting_approval', 'completed', 'failed'];
const BATCH_STATES: readonly string[] = ['planned', 'artifact_committed', 'completed'];
/** 嵌套上限: 循环引用/病态深层结构一律 fail-closed。 */
const MAX_PLAIN_DEPTH = 64;

// —— secret 防护(审查发现 3 / 复审 R2) ——
// 归一化(去非字母数字 + camelCase 拆段 + 小写)后精确命中的禁止持久化 key。
const SECRET_EXACT = new Set<string>([
  'apikey', 'apisecret', 'password', 'passwd', 'secret', 'clientsecret', 'privatekey',
  'token', 'accesstoken', 'refreshtoken', 'bearer', 'authorization', 'auth', 'cookie',
  'cookies', 'jwt', 'credential', 'credentials', 'secretkey', 'appsecret', 'consumerkey',
  'consumersecret', 'signingkey', 'signingsecret', 'presharedkey', 'authkey', 'accesskey',
]);
// 归一化 key 的敏感拆段命中即拒绝。`key` 本身不能一概拒绝：领域模型合法使用
// location_key/source_key/plan_key；只有裸 key 或与 api/private/access 等敏感限定词组合时拒绝。
const SECRET_SEGMENTS = new Set<string>([
  'token', 'bearer', 'authorization', 'password', 'passwd', 'secret',
  'credential', 'auth', 'cookie', 'jwt', 'signing', 'preshared',
]);
const SECRET_KEY_QUALIFIERS = new Set<string>([
  'api', 'private', 'access', 'refresh', 'client', 'consumer', 'auth', 'secret', 'signing', 'preshared',
]);

function normalizeSecretKey(key: string): { exact: string; segments: string[] } {
  const spaced = key
    .replace(/[^A-Za-z0-9]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .toLowerCase();
  const segments = spaced.split(/\s+/).filter((s) => s.length > 0);
  return { exact: segments.join(''), segments };
}

function isDeniedSecretKey(key: string): boolean {
  const { exact, segments } = normalizeSecretKey(key);
  if (SECRET_EXACT.has(exact) || (segments.length === 1 && segments[0] === 'key')) return true;
  for (const segment of segments) if (SECRET_SEGMENTS.has(segment)) return true;
  if (segments.includes('key') && segments.some((segment) => SECRET_KEY_QUALIFIERS.has(segment))) return true;
  return false;
}

// —— JSON Pointer 安全编码(复审 R2) ——
// 根用 `$` 表示, 子段以 `/` 分隔; key 中的 `~` → `~0`, `/` → `~1`(RFC 6901 转义),
// 避免 key 含 `.`/`[`/`]`/`/` 时点路径产生歧义。
function jsonPointerChild(parent: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${parent}/${escaped}`;
}

// —— plain JSON data 判定与 deep snapshot(复审 R1/R6) ——
/** plain object: 原型为 Object.prototype/null 且无 own accessor 属性。 */
function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const names = Object.getOwnPropertyNames(value);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) return false;
  }
  return true;
}

/**
 * 兜底克隆探测: structuredClone 能拒绝任意嵌套 Proxy 与不可克隆对象。
 * 缺失时不 fail-open —— 自遍历 + node:util isProxy 已是完整判据(见 probePlainNode)。
 */
function probeStructuredClone(value: unknown): void {
  const fn = (globalThis as { structuredClone?: (value: unknown) => unknown }).structuredClone;
  if (typeof fn !== 'function') return;
  try {
    fn(value);
  } catch {
    throw new Error('workflow JSON 拒绝 Proxy/不可克隆对象');
  }
}

function isCanonicalIndexKey(key: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const n = Number(key);
  return Number.isSafeInteger(n) && n >= 0 && n < 4294967295;
}

/** 数组合法性: 稠密、无索引 accessor、无 symbol/额外属性、无越界索引。 */
function probeArray(value: unknown[], path: string): void {
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) throw new Error(`${jsonPointerChild(path, i)} 不允许稀疏数组`);
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      throw new Error(`${jsonPointerChild(path, i)} 不允许 accessor`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error(`${path} 不允许 symbol 属性`);
    if (key === 'length') continue; // 数组固有 non-enumerable 数据属性, 允许
    if (!isCanonicalIndexKey(key)) throw new Error(`${path} 不允许数组额外属性 ${JSON.stringify(key)}`);
    if (Number(key) >= value.length) throw new Error(`${path} 不允许越界索引属性`);
  }
}

/** 对象 own keys 合法性: 仅 enumerable 字符串数据属性(拒 symbol/non-enumerable/accessor)。 */
function plainObjectKeys(value: Record<string, unknown>, path: string): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error(`${path} 不允许 symbol 属性`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue; // 不可达
    if (!descriptor.enumerable) throw new Error(`${path} 不允许 non-enumerable 属性 ${JSON.stringify(key)}`);
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${jsonPointerChild(path, key)} 不允许 accessor`);
    }
    keys.push(key);
  }
  return keys.sort();
}

/** 节点级探测: 拒绝 Proxy/不可克隆类型/非有限数字/深度越界; 返回节点类别。 */
function probePlainNode(value: unknown, path: string, depth: number): 'scalar' | 'array' | 'object' | 'function' {
  if (depth > MAX_PLAIN_DEPTH) throw new Error(`${path} 嵌套过深(疑似循环引用)`);
  if (value === null) return 'scalar';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return 'scalar';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 不允许非有限数字`);
    return 'scalar';
  }
  if (type === 'undefined') throw new Error(`${path} 不允许 undefined`);
  if (type === 'symbol' || type === 'bigint') throw new Error(`${path} 不允许 ${type}`);
  if (nodeTypes.isProxy(value)) throw new Error(`${path} 不允许 Proxy`);
  if (type === 'function') return 'function';
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} 不允许数组子类实例`);
    probeArray(value, path);
    return 'array';
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path} 只接受 plain JSON object(拒绝 Date/accessor/Proxy/类实例)`);
  }
  plainObjectKeys(value as Record<string, unknown>, path);
  return 'object';
}

/**
 * 一次 deep snapshot + plain-data 验证(复审 R1): 返回与原值同构的纯 plain 深拷贝,
 * 之后调用方只使用快照。options:
 * - rejectSecret: 对象 key 命中 secret 词表即拒绝(artifact 持久化面, 复审 R2);
 * - functionKeys: 允许按引用拷贝的 seam 函数 key(如 force uniqueSource);
 * - omitUndefined: **记录形 API 输入**(identity/apply/manifest/expected 等)中显式
 *   `undefined` 的可选字段按「缺省」处理(丢弃该 key)——undefined 不是 JSON 数据、
 *   无歧义, 不构成走私向量; 而 payload/canonical 数据面仍一律拒绝 undefined。
 *   必需字段为 undefined 时丢弃后仍会被字段校验 fail-closed。
 */
function snapshotPlainData(
  value: unknown,
  path: string,
  depth: number,
  options: { rejectSecret?: boolean; functionKeys?: ReadonlySet<string>; omitUndefined?: boolean } = {},
): unknown {
  const kind = probePlainNode(value, path, depth);
  if (kind === 'scalar') return value;
  if (kind === 'function') {
    throw new Error(`${path} 不允许 function`);
  }
  if (kind === 'array') {
    const source = value as unknown[];
    const out = new Array<unknown>(source.length);
    for (let i = 0; i < source.length; i++) {
      out[i] = snapshotPlainData(source[i], jsonPointerChild(path, i), depth + 1, options);
    }
    return out;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of plainObjectKeys(source, path)) {
    const childPath = jsonPointerChild(path, key);
    const child = source[key];
    if (options.omitUndefined === true && child === undefined) continue; // 可选字段显式 undefined = 缺省
    if (options.functionKeys !== undefined && options.functionKeys.has(key)) {
      if (typeof child !== 'function') throw new Error(`${childPath} 必须是函数`);
      if (nodeTypes.isProxy(child)) throw new Error(`${childPath} 不允许 Proxy`);
      out[key] = child; // seam 函数按引用拷贝(仅调用, 绝不序列化)
      continue;
    }
    if (options.rejectSecret === true && isDeniedSecretKey(key)) {
      throw new Error(`${childPath} 禁止持久化 secret`);
    }
    out[key] = snapshotPlainData(child, childPath, depth + 1, options);
  }
  return out;
}

/**
 * 持久化面: 深快照 + secret 拒绝 + 兜底克隆探测(复审 R1/R2)。
 * omitUndefined 模式用于记录形 API 输入(可选字段显式 undefined 合法), 此时不探测原始
 * 输入 —— structuredClone 无法克隆 undefined 可选字段, 而自遍历 + isProxy 已是完整判据。
 */
function snapshotPersistable(value: unknown, options: { omitUndefined?: boolean } = {}): unknown {
  const snap = snapshotPlainData(value, '$', 0, { rejectSecret: true, omitUndefined: options.omitUndefined === true });
  if (options.omitUndefined !== true) probeStructuredClone(value);
  return snap;
}

/** 持久化面校验(结果对象已由快照构造时仅需校验)。 */
function validatePersistable(value: unknown): void {
  snapshotPersistable(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function assertSha(value: string, field: string): void {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`${field} 必须是 sha256 hex`);
}

/** git 对象 id(commit/blob/tree): 40(SHA-1)或 64(SHA-256 仓库)位小写 hex(store 同口径)。 */
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function assertGitOid(value: string, field: string): void {
  if (typeof value !== 'string' || !GIT_OID_RE.test(value)) throw new Error(`${field} 必须是 git 对象 id(40/64 hex)`);
}

function assertId(value: string, field: string): void {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${field} 非法`);
}

function assertKind(kind: WorkflowKind): void {
  if (kind !== 'deep-import' && kind !== 'map-atlas') throw new Error('kind 非法');
}

function workflowIdPrefix(kind: WorkflowKind): string {
  return kind === 'deep-import' ? 'imp' : 'atlas';
}

/** workflowId 结构与前缀校验(不含 fingerprint 绑定, 用于 apply 记录身份)。 */
function assertWorkflowIdShape(workflowId: string): void {
  const match = /^([a-z][a-z0-9]*)-([0-9a-f]{16})-(.+)$/.exec(workflowId);
  if (!match) throw new Error('workflowId 前缀/结构非法');
  if (match[1] !== 'imp' && match[1] !== 'atlas') throw new Error('workflowId 前缀非法');
  if (!ID_RE.test(match[3])) throw new Error('workflowId unique run 段非法');
}

/**
 * workflowId 结构 + kind 前缀 + inputFingerprint 前 16 hex 绑定校验。
 * 形态: <prefix>-<inputFingerprint.slice(0,16)>-<uniqueRunId(ID_RE)>。
 */
function assertWorkflowIdBinding(workflowId: string, inputFingerprint: string, kind?: WorkflowKind): string {
  const match = /^([a-z][a-z0-9]*)-([0-9a-f]{16})-(.+)$/.exec(workflowId);
  if (!match) throw new Error('workflowId 前缀/结构非法');
  const prefix = match[1];
  if (prefix !== 'imp' && prefix !== 'atlas') throw new Error('workflowId 前缀非法');
  if (kind !== undefined && prefix !== workflowIdPrefix(kind)) throw new Error('workflowId 前缀与 kind 不符');
  if (match[2] !== inputFingerprint.slice(0, 16)) throw new Error('workflowId 与 inputFingerprint 绑定不符');
  if (!ID_RE.test(match[3])) throw new Error('workflowId unique run 段非法');
  return prefix;
}

/**
 * 反序列化 plan 全量 identity/path 重验(审查发现 1):
 * 校验版本/全部 identity 字段, 并由字段重新派生 batchId 对账——任何篡改(含 traversal
 * 注入)都 fail-closed。plan 必须已由调用方 deep snapshot(复审 R1)。
 */
function assertBatchPlanIdentity(plan: BatchPlan, kind?: WorkflowKind): void {
  if (plan === null || typeof plan !== 'object') throw new Error('batch plan 非法');
  if (plan.version !== WORKFLOW_RUN_VERSION) throw new Error('batch plan version 不兼容');
  assertId(plan.workflowId, 'workflowId');
  assertWorkflowIdBinding(plan.workflowId, plan.inputFingerprint, kind);
  assertSha(plan.inputFingerprint, 'inputFingerprint');
  if (!PATH_SEGMENT_RE.test(plan.phase)) throw new Error('phase 非法');
  if (!Number.isSafeInteger(plan.ordinal) || plan.ordinal < 0) throw new Error('ordinal 非法');
  if (!BATCH_ID_RE.test(plan.batchId)) throw new Error('batchId 非法');
  if (!Array.isArray(plan.sourceIds)) throw new Error('sourceIds 非法');
  if (!isPlainObjectRecord(plan.sourceHashes)) throw new Error('sourceHashes 非法');
  const sourceIds = [...plan.sourceIds];
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('sourceIds 不得重复');
  for (const id of sourceIds) assertId(id, 'sourceId');
  sourceIds.sort();
  const sourceHashes: Record<string, string> = {};
  for (const id of Object.keys(plan.sourceHashes).sort()) {
    if (!sourceIds.includes(id)) throw new Error(`sourceHashes 含计划外 source: ${id}`);
    assertSha(plan.sourceHashes[id], `sourceHashes.${id}`);
    sourceHashes[id] = plan.sourceHashes[id];
  }
  if (Object.keys(sourceHashes).length !== sourceIds.length) throw new Error('每个 sourceId 必须有 hash');
  const seed = {
    workflowId: plan.workflowId, phase: plan.phase, ordinal: plan.ordinal,
    inputFingerprint: plan.inputFingerprint, sourceIds, sourceHashes,
  };
  const derived = `batch-${workflowSha256(canonicalRunJson(seed)).slice(0, 24)}`;
  if (derived !== plan.batchId) throw new Error('batchId 与 plan identity 不匹配，拒绝');
}

// —— canonical JSON(审查发现 6 / 复审 R6) ——
function canonicalRunJsonUnprobed(value: unknown, path = '$', depth = 0): string {
  const kind = probePlainNode(value, path, depth);
  if (kind === 'scalar') {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    return JSON.stringify(value); // number: 已由 probePlainNode 保证有限
  }
  if (kind === 'array') {
    const source = value as unknown[];
    const parts: string[] = [];
    for (let i = 0; i < source.length; i++) {
      parts.push(canonicalRunJsonUnprobed(source[i], jsonPointerChild(path, i), depth + 1));
    }
    return `[${parts.join(',')}]`;
  }
  if (kind === 'function') {
    throw new Error(`${path} 不允许 function`);
  }
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of plainObjectKeys(source, path)) {
    parts.push(`${JSON.stringify(key)}:${canonicalRunJsonUnprobed(source[key], jsonPointerChild(path, key), depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

export function canonicalRunJson(value: unknown): string {
  const out = canonicalRunJsonUnprobed(value);
  probeStructuredClone(value);
  return out;
}

export function workflowSha256(value: string | ReadonlyBytes): string {
  const input: string | Uint8Array = typeof value === 'string' ? value : (value as unknown as Uint8Array);
  return createHash('sha256').update(input).digest('hex');
}

export function makeWorkflowId(kind: WorkflowKind, inputFingerprint: string, uniqueRunId: string): string {
  assertKind(kind);
  assertSha(inputFingerprint, 'inputFingerprint');
  assertId(uniqueRunId, 'uniqueRunId');
  const prefix = workflowIdPrefix(kind);
  return `${prefix}-${inputFingerprint.slice(0, 16)}-${uniqueRunId}`;
}

export function workflowRunRoot(kind: WorkflowKind, workflowId: string): string {
  assertKind(kind);
  assertId(workflowId, 'workflowId');
  return kind === 'deep-import'
    ? `.assistant/import-runs/${workflowId}`
    : `.assistant/atlas/runs/${workflowId}`;
}

export function makeBatchPlan(input: Omit<BatchPlan, 'version' | 'batchId'>): BatchPlan {
  const snap = snapshotPersistable(input, { omitUndefined: true }) as Omit<BatchPlan, 'version' | 'batchId'>;
  assertId(snap.workflowId, 'workflowId');
  if (!PATH_SEGMENT_RE.test(snap.phase)) throw new Error('phase 非法');
  if (!Number.isSafeInteger(snap.ordinal) || snap.ordinal < 0) throw new Error('ordinal 非法');
  assertSha(snap.inputFingerprint, 'inputFingerprint');
  const sourceIds = [...snap.sourceIds];
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('sourceIds 不得重复');
  for (const id of sourceIds) assertId(id, 'sourceId');
  sourceIds.sort();
  const sourceHashes: Record<string, string> = {};
  for (const id of Object.keys(snap.sourceHashes).sort()) {
    if (!sourceIds.includes(id)) throw new Error(`sourceHashes 含计划外 source: ${id}`);
    assertSha(snap.sourceHashes[id], `sourceHashes.${id}`);
    sourceHashes[id] = snap.sourceHashes[id];
  }
  if (Object.keys(sourceHashes).length !== sourceIds.length) throw new Error('每个 sourceId 必须有 hash');
  const seed = { workflowId: snap.workflowId, phase: snap.phase, ordinal: snap.ordinal, inputFingerprint: snap.inputFingerprint, sourceIds, sourceHashes };
  const batchId = `batch-${workflowSha256(canonicalRunJson(seed)).slice(0, 24)}`;
  return deepFreeze({ version: 1, batchId, ...seed });
}

export function batchPaths(kind: WorkflowKind, plan: BatchPlan): Pick<BatchManifestEntry, 'planPath' | 'artifactPath' | 'receiptPath'> {
  assertKind(kind);
  const snap = snapshotPersistable(plan, { omitUndefined: true }) as BatchPlan;
  assertBatchPlanIdentity(snap, kind);
  const root = workflowRunRoot(kind, snap.workflowId);
  const prefix = `${root}/batches/${snap.phase}/${snap.batchId}`;
  return Object.freeze({
    planPath: `${prefix}.plan.json`,
    artifactPath: `${prefix}.artifact.json`,
    receiptPath: `${prefix}.receipt.json`,
  });
}

export interface SerializeArtifactOptions {
  readonly outputSchemaVersion?: string;
  // 复审 R2: allowSecretPaths 已删除——artifact 任何 secret key/value 路径一律拒绝。
}

/** Artifact bytes are final before hashing; resultHash is intentionally not self-embedded. */
export function serializeBatchArtifact<T>(
  plan: BatchPlan,
  payload: T,
  options: SerializeArtifactOptions = {},
): { artifact: BatchArtifact<T>; bytes: ReadonlyBytes; resultHash: string } {
  const legacyOpts = options as SerializeArtifactOptions & { allowSecretPaths?: unknown };
  if (legacyOpts.allowSecretPaths !== undefined) {
    throw new Error('allowSecretPaths 已移除：artifact 任何 secret key/value 一律拒绝，无白名单');
  }
  const opts = snapshotPlainData(options, '$', 0, { omitUndefined: true }) as SerializeArtifactOptions;
  const planSnap = snapshotPersistable(plan, { omitUndefined: true }) as BatchPlan;
  assertBatchPlanIdentity(planSnap);
  const payloadSnap = snapshotPersistable(payload);
  const outputSchemaVersion = opts.outputSchemaVersion ?? '1';
  if (!SCHEMA_VERSION_RE.test(outputSchemaVersion)) throw new Error('outputSchemaVersion 非法');
  const artifact: BatchArtifact<T> = {
    version: 1,
    workflowId: planSnap.workflowId,
    batchId: planSnap.batchId,
    phase: planSnap.phase,
    ordinal: planSnap.ordinal,
    inputFingerprint: planSnap.inputFingerprint,
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    outputSchemaVersion,
    payload: payloadSnap as T,
  };
  // 内部 canonical bytes 是 hash 绑定锚; 返回**副本**(typed array 不可 Object.freeze,
  // 以副本 + ReadonlyBytes 类型 wrapper 防外部突变破坏绑定, 复审 R6)。
  const internalBytes = new TextEncoder().encode(`${canonicalRunJson(artifact)}\n`);
  const resultHash = workflowSha256(internalBytes);
  const bytes: ReadonlyBytes = internalBytes.slice();
  return { artifact: deepFreeze(artifact), bytes, resultHash };
}

export function makeBatchReceipt(input: Omit<BatchReceipt, 'version'>): BatchReceipt {
  const snap = snapshotPersistable(input, { omitUndefined: true }) as Omit<BatchReceipt, 'version'>;
  assertId(snap.workflowId, 'workflowId');
  assertId(snap.batchId, 'batchId');
  assertSha(snap.resultHash, 'resultHash');
  assertId(snap.transactionId, 'transactionId');
  if (!Number.isFinite(Date.parse(snap.committedAt))) throw new Error('committedAt 非法');
  return deepFreeze({ version: 1, ...snap });
}

// —— 显式 identity 构造(审查发现 4) ——
export interface WorkflowIdentityInput {
  readonly kind: WorkflowKind;
  readonly inputFingerprint: string;
  readonly profileFingerprint: string;
  readonly planDigest: string;
  /** 调用方 unique run 种子: 确定性 API 下决定 workflowId; force API 下不得被复用。 */
  readonly uniqueRunId: string;
  readonly createdAt?: string;
}

/** 确定性 identity: 同输入恒同 workflowId(与 legacy makeWorkflowId 一致)。 */
export function createWorkflowIdentity(input: WorkflowIdentityInput): WorkflowIdentity {
  const snap = snapshotPersistable(input, { omitUndefined: true }) as WorkflowIdentityInput;
  assertKind(snap.kind);
  assertSha(snap.inputFingerprint, 'inputFingerprint');
  assertSha(snap.profileFingerprint, 'profileFingerprint');
  assertSha(snap.planDigest, 'planDigest');
  assertId(snap.uniqueRunId, 'uniqueRunId');
  const createdAt = snap.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt 非法');
  const workflowId = makeWorkflowId(snap.kind, snap.inputFingerprint, snap.uniqueRunId);
  return deepFreeze({
    version: 1, workflowId, kind: snap.kind, createdAt,
    inputFingerprint: snap.inputFingerprint,
    profileFingerprint: snap.profileFingerprint,
    planDigest: snap.planDigest,
  });
}

export interface ForcedWorkflowIdentityOptions {
  readonly kind: WorkflowKind;
  readonly inputFingerprint: string;
  readonly profileFingerprint: string;
  readonly planDigest: string;
  /** 可选调用方 unique 种子(仅作 provenance 前缀, 不参与门禁)。 */
  readonly uniqueRunId?: string;
  readonly createdAt?: string;
  /** 测试注入 entropy: 每次调用必须返回全新合法 nonce(ID_RE); 默认 crypto.randomUUID。 */
  readonly uniqueSource?: () => string;
}

/**
 * force 路径(复审 R5): 每次调用由内部随机/注入唯一源生成**全新** workflowId——
 * 不依赖可省 existingIds、不因 deterministic ID 存在拒新 run; expected-absent
 * (assertExpectedAbsent)是唯一权威, 由调用方在目标命名空间断言。
 */
export function createForcedWorkflowIdentity(input: ForcedWorkflowIdentityOptions): WorkflowIdentity {
  const raw = input as ForcedWorkflowIdentityOptions & { existingIds?: unknown; maxAttempts?: unknown; uniqueSource?: unknown };
  if (raw.existingIds !== undefined) throw new Error('force 不再依赖 existingIds：expected-absent 由调用方断言');
  if (raw.maxAttempts !== undefined) throw new Error('force 不再需要 maxAttempts');
  if (raw.uniqueSource !== undefined && typeof raw.uniqueSource !== 'function') throw new Error('uniqueSource 必须是函数');
  const snap = snapshotPlainData(input, '$', 0, { functionKeys: new Set(['uniqueSource']), omitUndefined: true }) as ForcedWorkflowIdentityOptions;
  assertKind(snap.kind);
  assertSha(snap.inputFingerprint, 'inputFingerprint');
  assertSha(snap.profileFingerprint, 'profileFingerprint');
  assertSha(snap.planDigest, 'planDigest');
  if (snap.uniqueRunId !== undefined) assertId(snap.uniqueRunId, 'uniqueRunId');
  const createdAt = snap.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt 非法');
  const uniqueSource = snap.uniqueSource ?? (() => randomUUID());
  // 每次调用取一次全新 nonce(契约: uniqueSource 每次返回新值)。
  const nonce = uniqueSource();
  if (typeof nonce !== 'string' || !ID_RE.test(nonce)) throw new Error('force unique source 必须产生合法 nonce');
  const runId = snap.uniqueRunId === undefined ? `force-${nonce}` : `${snap.uniqueRunId}-force-${nonce}`;
  assertId(runId, 'forced uniqueRunId');
  const workflowId = makeWorkflowId(snap.kind, snap.inputFingerprint, runId);
  return deepFreeze({
    version: 1, workflowId, kind: snap.kind, createdAt,
    inputFingerprint: snap.inputFingerprint,
    profileFingerprint: snap.profileFingerprint,
    planDigest: snap.planDigest,
  });
}

function toIdSet(ids: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  if (ids === undefined) return new Set();
  if (nodeTypes.isProxy(ids)) throw new Error('existingIds 不允许 Proxy');
  if (ids instanceof Set) {
    const out = new Set<string>();
    for (const id of ids) {
      assertId(id, 'existingIds element');
      out.add(id);
    }
    return out;
  }
  if (Array.isArray(ids)) {
    const out = new Set<string>();
    for (const id of ids) {
      assertId(id, 'existingIds element');
      out.add(id);
    }
    return out;
  }
  throw new Error('existingIds 必须是 Set 或数组');
}

/** 显式 expected absent 门禁(ADR-0022 §1 / 复审 R5: 全新 workflowId 的唯一权威)。 */
export function assertExpectedAbsent(workflowId: string, existingIds: ReadonlySet<string> | readonly string[]): void {
  assertId(workflowId, 'workflowId');
  if (toIdSet(existingIds).has(workflowId)) throw new Error(`workflowId ${workflowId} 已存在，违反 expected-absent`);
}

// —— manifest 严格兼容校验(审查发现 5 / 复审 R3) ——
/** 调用方对目标 run 的完整身份期望: workflowId + 全部 identity 字段, 逐字段精确匹配。 */
export interface WorkflowIdentityExpectation {
  readonly workflowId: string;
  readonly kind: WorkflowKind;
  readonly inputFingerprint: string;
  readonly profileFingerprint: string;
  readonly planDigest: string;
  /** createdAt 属于 identity 元数据: 提供则要求精确匹配。 */
  readonly createdAt?: string;
}

export function assertManifestCompatible(
  manifest: WorkflowManifest,
  expected: WorkflowIdentityExpectation,
): void {
  const m = snapshotPersistable(manifest, { omitUndefined: true }) as WorkflowManifest;
  const e = snapshotPersistable(expected, { omitUndefined: true }) as WorkflowIdentityExpectation;
  if (m.version !== WORKFLOW_RUN_VERSION) throw new Error('workflow manifest version 不兼容');
  assertId(m.workflowId, 'workflowId');
  assertId(e.workflowId, 'expected.workflowId');
  assertWorkflowIdBinding(m.workflowId, m.inputFingerprint, e.kind);
  if (m.workflowId !== e.workflowId) throw new Error('workflowId 不匹配，禁止续跑');
  if (m.kind !== e.kind) throw new Error('workflow kind 不匹配，禁止续跑');
  for (const field of ['inputFingerprint', 'profileFingerprint', 'planDigest'] as const) {
    assertSha(m[field], field);
    assertSha(e[field], `expected.${field}`);
    if (m[field] !== e[field]) {
      if (field === 'profileFingerprint') throw new Error('执行画像指纹变化(profileFingerprint 不匹配)，禁止续跑');
      throw new Error(`${field} 不匹配，禁止续跑`);
    }
  }
  if (e.createdAt !== undefined && m.createdAt !== e.createdAt) throw new Error('createdAt 不匹配，禁止续跑');
  if (!Number.isFinite(Date.parse(m.createdAt))) throw new Error('manifest createdAt 非法');
  if (!MANIFEST_STATUSES.includes(m.status)) throw new Error('manifest status 非法');
  if (m.budgetSpent !== undefined && (!Number.isSafeInteger(m.budgetSpent) || m.budgetSpent < 0)) {
    throw new Error('manifest budgetSpent 必须是非负安全整数');
  }
  if (!isPlainObjectRecord(m.cursor)) throw new Error('manifest cursor 非法');
  if (!PATH_SEGMENT_RE.test(m.cursor.phase)) throw new Error('manifest cursor phase 非法');
  if (!Number.isSafeInteger(m.cursor.ordinal) || m.cursor.ordinal < 0) throw new Error('manifest cursor ordinal 非法');
  if (!isPlainObjectRecord(m.batches)) throw new Error('manifest batches 非法');
  const root = workflowRunRoot(m.kind, m.workflowId);
  for (const [key, batch] of Object.entries(m.batches)) {
    if (!isPlainObjectRecord(batch)) throw new Error(`batch ${key} 非法`);
    if (batch.batchId !== key) throw new Error('batchId 与 manifest key 不符');
    assertId(batch.batchId, 'batchId');
    if (!PATH_SEGMENT_RE.test(batch.phase)) throw new Error(`batch ${batch.batchId} phase 非法`);
    if (!Number.isSafeInteger(batch.ordinal) || batch.ordinal < 0) throw new Error(`batch ${batch.batchId} ordinal 非法`);
    if (!BATCH_STATES.includes(batch.state)) throw new Error(`batch ${batch.batchId} state 非法`);
    const dir = `${root}/batches/${batch.phase}/${batch.batchId}`;
    if (batch.planPath !== `${dir}.plan.json` || batch.artifactPath !== `${dir}.artifact.json` || batch.receiptPath !== `${dir}.receipt.json`) {
      throw new Error(`batch ${batch.batchId} 路径与确定性布局不符`);
    }
    if (batch.resultHash !== undefined) assertSha(batch.resultHash, `batch ${batch.batchId} resultHash`);
    if (batch.transactionId !== undefined) assertId(batch.transactionId, `batch ${batch.batchId} transactionId`);
  }
}

// —— apply 状态机(审查发现 2 / 复审 R4) ——
const APPLY_STATES: readonly string[] = ['waiting_approval', 'applying', 'applied', 'rejected', 'skipped', 'failed'];
const APPLY_TRANSITIONS: Record<ApplyState, readonly ApplyState[]> = {
  waiting_approval: ['applying', 'rejected', 'skipped'],
  applying: ['applied', 'waiting_approval', 'failed'],
  applied: [], rejected: [], skipped: [], failed: [],
};
/** 每个转换只接受与其对应的 options 字段; 其余一律 fail-closed(复审 R4)。 */
const APPLY_OPTION_FIELDS: Record<ApplyState, readonly (keyof AdvanceApplyOptions)[]> = {
  waiting_approval: ['now'],
  applying: ['now', 'transactionId'],
  applied: ['now', 'commitEvidence'],
  rejected: ['now', 'failure'],
  skipped: ['now'],
  failed: ['now', 'failure'],
};

export interface AdvanceApplyOptions {
  readonly now: string;
  readonly transactionId?: string;
  /** applied 唯一凭证: 注入的 probe 证据对象(commitVerified 布尔已移除)。 */
  readonly commitEvidence?: ApplyCommitEvidence;
  readonly failure?: string;
}

/** apply 目标路径: vault 相对 canonical 路径, 拒绝绝对路径/控制字符/.. 段。 */
function assertApplyTarget(target: string): void {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048) throw new Error('apply target 非法');
  if (/[\u0000-\u001f\u007f]/.test(target)) throw new Error('apply target 不允许控制字符');
  if (target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(target)) {
    throw new Error('apply target 必须是相对路径');
  }
  for (const segment of target.split(/[\\/]/)) {
    if (segment === '..') throw new Error('apply target 不允许 .. 段');
  }
}

function assertFailure(failure: string): void {
  if (typeof failure !== 'string' || failure.length === 0 || failure.length > 512) throw new Error('failure 非法');
}

/** 严格验证 current 的 version/identity/target/hash 与全部绑定字段(复审 R4)。 */
function assertApplyRecord(current: ApplyRecord): void {
  if (current === null || typeof current !== 'object') throw new Error('apply record 非法');
  if (current.version !== WORKFLOW_RUN_VERSION) throw new Error('apply record version 不兼容');
  assertId(current.applyId, 'applyId');
  assertId(current.workflowId, 'workflowId');
  assertWorkflowIdShape(current.workflowId);
  assertApplyTarget(current.target);
  assertSha(current.expectedHash, 'expectedHash');
  assertSha(current.writeSetDigest, 'writeSetDigest');
  assertSha(current.artifactHash, 'artifactHash');
  assertId(current.batchId, 'batchId');
  assertSha(current.checkpoint, 'checkpoint');
  assertSha(current.planDigest, 'planDigest');
  assertId(current.provenance, 'provenance');
  if (!APPLY_STATES.includes(current.state)) throw new Error(`apply state 未知: ${String(current.state)}`);
  if (current.transactionId !== undefined) assertId(current.transactionId, 'transactionId');
  if (current.commitOid !== undefined) assertGitOid(current.commitOid, 'commitOid');
  if (current.failure !== undefined) assertFailure(current.failure);
  // 状态-字段一致性: 损坏记录 fail-closed。
  if (current.commitOid !== undefined && current.state !== 'applied') {
    throw new Error('commitOid 只允许出现在 applied 状态');
  }
  if (current.transactionId !== undefined && current.state !== 'applying' && current.state !== 'applied' && current.state !== 'failed') {
    throw new Error('transactionId 只允许出现在 applying/applied/failed 状态');
  }
}

/** commitEvidence 必须与 ApplyRecord 绑定字段逐字段一致(复审 R4)。 */
function assertCommitEvidenceBinding(evidence: ApplyCommitEvidence, current: ApplyRecord): void {
  if (evidence === null || typeof evidence !== 'object') throw new Error('commitEvidence 必须是证据对象');
  assertGitOid(evidence.commitOid, 'commitEvidence.commitOid');
  if (evidence.workflowId !== current.workflowId) throw new Error('commitEvidence.workflowId 与 apply 不符');
  if (evidence.batchId !== current.batchId) throw new Error('commitEvidence.batchId 与 apply 不符');
  if (evidence.planDigest !== current.planDigest) throw new Error('commitEvidence.planDigest 与 apply 不符');
  if (evidence.writeSetDigest !== current.writeSetDigest) throw new Error('commitEvidence.writeSetDigest 与 apply 不符');
  if (evidence.artifactHash !== current.artifactHash) throw new Error('commitEvidence.artifactHash 与 apply 不符');
  if (!Number.isFinite(Date.parse(evidence.verifiedAt))) throw new Error('commitEvidence.verifiedAt 非法');
}

export function advanceApplyState(
  current: ApplyRecord,
  next: ApplyState,
  options: AdvanceApplyOptions,
): ApplyRecord {
  if (!APPLY_STATES.includes(next)) throw new Error(`apply 目标状态未知: ${String(next)}`);
  const cur = snapshotPersistable(current, { omitUndefined: true }) as ApplyRecord;
  const opts = snapshotPersistable(options, { omitUndefined: true }) as AdvanceApplyOptions;
  const legacyOpts = opts as AdvanceApplyOptions & { commitVerified?: unknown };
  if (legacyOpts.commitVerified !== undefined) {
    throw new Error('commitVerified 已移除：applied 必须注入 commitEvidence 证据对象');
  }
  assertApplyRecord(cur);
  // 非对应转换不接受额外 fields(复审 R4)。
  const allowed = APPLY_OPTION_FIELDS[next];
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key as keyof AdvanceApplyOptions)) {
      throw new Error(`apply 转换 ${cur.state} → ${next} 不接受额外字段 ${key}`);
    }
  }
  if (!Number.isFinite(Date.parse(opts.now))) throw new Error('apply updatedAt 非法');
  if (!APPLY_TRANSITIONS[cur.state].includes(next)) throw new Error(`非法 apply 转换: ${cur.state} → ${next}`);

  // 进入 applying: 必须新分配 transactionId; 已有事务身份禁止重复进入。
  if (next === 'applying') {
    if (cur.transactionId !== undefined || cur.commitOid !== undefined) {
      throw new Error('apply 已有 transaction identity，禁止重复进入 applying');
    }
    if (opts.transactionId === undefined) throw new Error('进入 applying 必须分配 transactionId');
    assertId(opts.transactionId, 'transactionId');
  }

  // applied: 必须注入 probe 证据对象, 且与 apply 绑定逐字段一致。
  if (next === 'applied') {
    if (opts.commitEvidence === undefined) throw new Error('applied 必须有注入的 commitEvidence 证据对象');
    if (cur.transactionId === undefined) throw new Error('applied 必须来自已分配 transactionId 的 applying 阶段');
    assertCommitEvidenceBinding(opts.commitEvidence, cur);
  }

  // 退回 waiting_approval: 仅事务未 commit 时可持久回退; 结果清空 tx fields(复审 R4)。
  if (next === 'waiting_approval') {
    if (cur.commitOid !== undefined) throw new Error('已 commit 的 apply 不得退回 waiting_approval');
  }

  // rejected/failed 可带 failure 详情。
  if (opts.failure !== undefined && (next === 'rejected' || next === 'failed')) {
    assertFailure(opts.failure);
  }

  const base: Omit<ApplyRecord, 'state' | 'updatedAt' | 'transactionId' | 'commitOid' | 'failure'> = {
    version: 1,
    applyId: cur.applyId,
    workflowId: cur.workflowId,
    target: cur.target,
    expectedHash: cur.expectedHash,
    writeSetDigest: cur.writeSetDigest,
    artifactHash: cur.artifactHash,
    batchId: cur.batchId,
    checkpoint: cur.checkpoint,
    planDigest: cur.planDigest,
    provenance: cur.provenance,
  };
  const txFields: { transactionId?: string; commitOid?: string } = next === 'applying'
    ? { transactionId: opts.transactionId as string }
    : next === 'applied'
      ? { transactionId: cur.transactionId as string, commitOid: opts.commitEvidence!.commitOid }
      : next === 'failed' && cur.transactionId !== undefined
        ? { transactionId: cur.transactionId }
        : {};
  const failureField: { failure?: string } = (next === 'rejected' || next === 'failed') && opts.failure !== undefined
    ? { failure: opts.failure }
    : {};
  const result: ApplyRecord = { ...base, ...txFields, ...failureField, state: next, updatedAt: opts.now };
  validatePersistable(result);
  return deepFreeze(result);
}
