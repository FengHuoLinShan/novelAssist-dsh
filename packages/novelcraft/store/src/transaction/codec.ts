// ============================================================================
// ADR-0021(N32) store 事务 · 规范化/编解码层(zero IO, 纯确定性)。
//
// 与 types.ts 配套: 本文件实现该层全部逻辑——严格相对 POSIX 路径/ref/hash 的
// 归一与拒绝、writeSet(完整/实际)/preSnapshot 去重排序、稳定 JSON canonical
// 序列化、plan/intent digest 计算与重推导验证、intent 序列化/反序列化、
// status/result 构建。执行器(后续 git.ts/adopt.ts 工作)只消费本层产出的
// canonical 形态。
//
// fail-closed 语义(ADR-0021 §8「恢复器不盲信 intent 内容」「任一身份或权限无法
// 重推导即 fail-closed」; N32; 审计要求):
//   - 任何非法输入抛 StoreError + 细分 code(见 errors.ts 的 TX_* 族), 绝不静默
//     改写/忽略/猜测;
//   - 所有公开 parse/normalize/verify 对 top/expected/target/preSnapshot 嵌套
//     未知字段严格拒绝(TX_UNKNOWN_FIELD), 未知 target kind 不降级
//     (TX_INVALID_TARGET_KIND);
//   - 拒 accessor/Proxy/non-plain JSON(TX_NON_PLAIN_OBJECT; Node isProxy 检测
//     + 原型 + accessor 描述符三重检查);
//   - txid 统一 canonical `tx-64` 小写 hex; ref 必须完整 `refs/heads/*`
//     (git check-ref-format 等价规则, 拒 one-level/.lock/dot);
//   - plan digest 覆盖 baseHead+exactTree+fullWriteSet+actualWriteSet 全部,
//     actual 必须是 full 的有序子集(空 = no-op 可表达); preSnapshot 与 full
//     集合一致。
//
// 注: 本层 intent 只记录输出字节的 SHA-256/长度与 git blob OID 身份, 不内嵌
// 原始字节(恢复时输出字节由确定性 artifact/临时文件载体 + hash 复核补齐, 见
// ADR-0022 §2/§3; 字节内嵌属执行器形态, 不在本层承诺)。
// ============================================================================

import { isProxy } from 'node:util/types';
import { sha256Hex } from '../hash.js';
import { StoreError } from '../errors.js';
import type {
  CleanupState,
  ExpectedState,
  GitFileMode,
  GitObjectId,
  IndexEntryState,
  IndexStateEntry,
  IntentInput,
  PlanInput,
  PlanPayload,
  PreSnapshotEntry,
  PreTargetSnapshot,
  ResultInput,
  Sha256Hex,
  StatusInput,
  TransactionIntent,
  TransactionKind,
  TransactionOutcome,
  TransactionPhase,
  TransactionPlan,
  TransactionResult,
  TransactionStatus,
  WorktreeState,
  WorktreeStateEntry,
  WriteTarget,
} from './types.js';

// ----------------------------------------------------------------------------
// 基础判词与字符集
// ----------------------------------------------------------------------------

/** txid 白名单: canonical `tx-` + 64 位小写 hex(统一形态, digest 可重推导;
 *  大写/`_`/短于 66 一律拒绝, 不静默归一)。 */
const TXID_RE = /^tx-[0-9a-f]{64}$/;

/** 内容 SHA-256: 纯 64 位 hex(输入兼容 `sha256:` 前缀与大写, 归一为小写)。 */
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** git 对象 id(commit/blob/tree): 40(SHA-1)或 64(SHA-256 仓库)位 hex。 */
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** ISO-8601 UTC(毫秒可选)。 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** git ref 禁用字符(control/space/`~^:?*[\`/反斜杠, 见 git check-ref-format)。 */
const REF_FORBIDDEN_RE = /[\x00-\x20\x7f~^:?*[\\]/;

/** git 文件 mode 白名单(与 git-transaction 的 TxFileMode 同族)。 */
const MODE_SET: ReadonlySet<string> = new Set(['100644', '100755', '120000']);

/** vaultRoot 身份长度上限(防超限 intent, ADR-0021 §8「超限内容」拒收)。 */
const VAULT_ROOT_MAX = 4096;

// ----------------------------------------------------------------------------
// plain JSON 对象门禁(fail-closed: 拒 accessor/Proxy/non-plain)
// ----------------------------------------------------------------------------

/**
 * plain JSON 对象判词(数据描述符对象): 拒 Proxy(Node `util.types.isProxy`)、
 * 拒非 Object.prototype/null 原型(类实例等)、拒任何 accessor(getter/setter)
 * 自有属性。JSON.parse 只产生 plain 对象; 注入面(恶意 intent/API 调用方)即使
 * 用 Proxy 伪装也会在此被拒(审计要求「拒 accessor/Proxy/nonplain JSON」)。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined && (typeof desc.get === 'function' || typeof desc.set === 'function')) {
      return false;
    }
  }
  return true;
}

/** 公开门禁: 要求 plain JSON 对象, 否则 TX_NON_PLAIN_OBJECT(执行层在一切 getter 前调用)。 */
export function requirePlainRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new StoreError('TX_NON_PLAIN_OBJECT', `${what} 必须是 plain JSON 对象(拒 accessor/Proxy/non-plain)`, { what });
  }
  return value;
}

/** 公开白名单字段检查: 任何白名单外自有字段 → TX_UNKNOWN_FIELD(fail-closed)。 */
export function assertNoUnknownFields(obj: Record<string, unknown>, allowlist: ReadonlySet<string>, what: string): void {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !allowlist.has(key)) {
      throw new StoreError('TX_UNKNOWN_FIELD', `${what} 含未知字段(fail-closed): ${String(key)}`, {
        what,
        key: String(key),
      });
    }
  }
}

// ----------------------------------------------------------------------------
// 判词函数(布尔版 + 抛错版; 抛错版统一 StoreError + TX_* code)
// ----------------------------------------------------------------------------

export function isTxId(value: unknown): value is string {
  return typeof value === 'string' && TXID_RE.test(value);
}

export function isTransactionKind(value: unknown): value is TransactionKind {
  return value === 'canonical' || value === 'checkpoint' || value === 'state' || value === 'run_bootstrap';
}

export function isCleanupState(value: unknown): value is CleanupState {
  return value === 'pending' || value === 'completed';
}

export function isTransactionPhase(value: unknown): value is TransactionPhase {
  return (
    value === 'preflight' ||
    value === 'intent_persisted' ||
    value === 'applying' ||
    value === 'committed' ||
    value === 'rolled_back' ||
    value === 'aborted' ||
    value === 'recovery_required' ||
    value === 'recovered' ||
    value === 'cleaned_up'
  );
}

export function isTransactionOutcome(value: unknown): value is TransactionOutcome {
  return (
    value === 'committed' ||
    value === 'rolled_back' ||
    value === 'noop' ||
    value === 'aborted' ||
    value === 'recovered_committed' ||
    value === 'recovered_rolled_back'
  );
}

export function isWorktreeState(value: unknown): value is WorktreeState {
  return value === 'BEFORE' || value === 'OUTPUT' || value === 'CONFLICT';
}

export function isIndexEntryState(value: unknown): value is IndexEntryState {
  return value === 'BASE' || value === 'OUTPUT' || value === 'CONFLICT';
}

export function isSha256(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && SHA256_RE.test(value);
}

// ----------------------------------------------------------------------------
// 严格相对 POSIX 路径(ADR-0021 §8: 拒绝绝对路径、`..`、路径穿越;
// N32: 规范化 path allowlist; 审计: 任意大小写 `.git` 段)。拒绝而非改写。
// ----------------------------------------------------------------------------

/** 空路径。 */
function invalidEmpty(): never {
  throw new StoreError('TX_PATH_EMPTY', '事务路径不能为空');
}

function invalidPath(code: 'TX_PATH_ABSOLUTE' | 'TX_PATH_TRAVERSAL' | 'TX_PATH_SEGMENT', input: string, why: string): never {
  throw new StoreError(code, `事务路径非法(${why}): ${JSON.stringify(input)}`, { path: input });
}

/**
 * 归一严格相对 POSIX 路径并返回(合法输入即 canonical, 不改写)。
 * 拒绝(按优先级):
 *  1. 空串/非字符串                                → TX_PATH_EMPTY / TX_PATH_SEGMENT
 *  2. 绝对: 首字符 `/`、Windows 盘符 `C:/…`/`C:\…`、UNC `\\…` → TX_PATH_ABSOLUTE
 *  3. 段形状: `\`、NUL/控制字符                     → TX_PATH_SEGMENT
 *  4. 段语义: 空段(`a//b`、尾 `/`)、`.`、`..`、任意大小写 `.git` → TX_PATH_SEGMENT / TX_PATH_TRAVERSAL
 * 允许: 任意文件名段(含 CJK/空格/隐藏段如 `.assistant`、`~`)——只做结构拒绝。
 * `.`/`..`/`.git` 之外的以点开头的段(如 `.assistant/checkpoint.json`)合法。
 */
export function normalizeRelPath(input: unknown): string {
  if (typeof input !== 'string') invalidPath('TX_PATH_SEGMENT', String(input), '非字符串');
  if (input.length === 0) invalidEmpty();
  if (CONTROL_RE.test(input)) invalidPath('TX_PATH_SEGMENT', input, '含控制字符');
  if (input.startsWith('/')) invalidPath('TX_PATH_ABSOLUTE', input, '绝对路径(首字符 /)');
  if (/^[A-Za-z]:[\\/]/.test(input)) invalidPath('TX_PATH_ABSOLUTE', input, 'Windows 盘符路径');
  if (input.startsWith('\\\\')) invalidPath('TX_PATH_ABSOLUTE', input, 'UNC 路径');
  if (input.includes('\\')) invalidPath('TX_PATH_SEGMENT', input, '含反斜杠(非 POSIX)');
  const segments = input.split('/');
  for (const seg of segments) {
    if (seg.length === 0) invalidPath('TX_PATH_SEGMENT', input, '空段(重复斜杠或尾斜杠)');
    if (seg === '.' || seg === '..') invalidPath('TX_PATH_TRAVERSAL', input, `段 ${JSON.stringify(seg)} 逃逸`);
    if (seg.toLowerCase() === '.git') invalidPath('TX_PATH_SEGMENT', input, '.git 保留段(大小写不敏感)');
  }
  return input;
}

/** 布尔版路径判词(不抛错)。 */
export function isRelPath(value: unknown): value is string {
  try {
    normalizeRelPath(value);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// git ref(ADR-0021 §1/§8 + 审计: 必须完整 refs/heads/*, git check-ref-format
// 等价规则)。ref 不是文件路径; 只允许完整 `refs/heads/<branch>`, 拒 one-level、
// `.lock` 段与 dot 段。
// ----------------------------------------------------------------------------

function invalidRef(input: string, why: string): never {
  throw new StoreError('TX_INVALID_REF', `事务目标 ref 非法(${why}): ${JSON.stringify(input)}`, { ref: input });
}

export function normalizeRef(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new StoreError('TX_INVALID_REF', `事务目标 ref 非法: ${JSON.stringify(input)}`);
  }
  // check-ref-format 字符类: control/space/DEL/`~^:?*[\`/反斜杠。
  if (REF_FORBIDDEN_RE.test(input)) invalidRef(input, '含控制/空格/禁用字符 (~^:?*[\\ 或反斜杠)');
  // 必须完整 refs/heads/*(拒 one-level 与其它命名空间/绝对形态)。
  if (!input.startsWith('refs/heads/')) invalidRef(input, '必须是完整 refs/heads/* ref(拒 one-level 与其它命名空间)');
  const tail = input.slice('refs/heads/'.length);
  if (tail.length === 0) invalidRef(input, 'refs/heads/ 后缺少分支名');
  if (input.includes('..')) invalidRef(input, '含连续两点 ..');
  if (input.includes('@{') || input === '@') invalidRef(input, '@{ 序列或裸 @');
  if (input.endsWith('.')) invalidRef(input, '以 . 结尾');
  for (const seg of tail.split('/')) {
    if (seg.length === 0) invalidRef(input, '空段(双斜杠或尾斜杠)');
    if (seg.startsWith('.')) invalidRef(input, '段以 . 开头(dot 段)');
    if (seg.endsWith('.lock')) invalidRef(input, '.lock 后缀保留');
  }
  return input;
}

/** HEAD 引用: commit id(40/64 hex)或完整 refs/heads/* ref, 归一为小写 id / canonical ref。 */
export function normalizeHeadRef(input: unknown): string {
  if (typeof input !== 'string') invalidRef(String(input), '非字符串');
  if (OBJECT_ID_RE.test(input)) return normalizeGitObjectId(input);
  return normalizeRef(input);
}

// ----------------------------------------------------------------------------
// 哈希归一(内容 SHA-256 与 git 对象 id; 输入宽容、输出 canonical, 拒绝非法)。
// ----------------------------------------------------------------------------

export function normalizeSha256(input: unknown): Sha256Hex {
  if (typeof input !== 'string') {
    throw new StoreError('TX_INVALID_SHA256', `SHA-256 必须是非空字符串: ${JSON.stringify(input)}`);
  }
  // 兼容 `sha256:` 前缀与首尾空白(hash.ts normalizeContentHash 同口径), 归一小写。
  const s = input.replace(/^sha256:/i, '').trim();
  if (!SHA256_RE.test(s)) {
    throw new StoreError('TX_INVALID_SHA256', `非法 SHA-256(须 64 位 hex): ${JSON.stringify(input)}`, { input });
  }
  return s.toLowerCase();
}

export function normalizeGitObjectId(input: unknown): GitObjectId {
  if (typeof input !== 'string' || !OBJECT_ID_RE.test(input)) {
    throw new StoreError('TX_INVALID_OBJECT_ID', `非法 git 对象 id(须 40/64 位 hex): ${JSON.stringify(input)}`, {
      input,
    });
  }
  return input.toLowerCase();
}

/** git 文件 mode 身份: 缺省 100644; 白名单外 → TX_INVALID_MODE。 */
export function normalizeFileMode(mode: unknown): GitFileMode {
  if (mode === undefined) return '100644';
  if (typeof mode === 'string' && MODE_SET.has(mode)) return mode as GitFileMode;
  throw new StoreError('TX_INVALID_MODE', `非法 git 文件 mode(须 100644/100755/120000): ${JSON.stringify(mode)}`, {
    mode,
  });
}

// ----------------------------------------------------------------------------
// ExpectedState 归一(结构 + 哈希; 未知 kind/缺字段/未知字段 → fail-closed)
// ----------------------------------------------------------------------------

function invalidExpected(why: string, details?: unknown): never {
  throw new StoreError('TX_INVALID_EXPECTED_STATE', `expected state 非法(${why})`, details);
}

const EXPECTED_ABSENT_FIELDS: ReadonlySet<string> = new Set(['kind']);
const EXPECTED_PRESENT_FIELDS: ReadonlySet<string> = new Set(['kind', 'contentSha256', 'baseRef', 'baseBlob']);

export function normalizeExpectedState(state: unknown): ExpectedState {
  const s = requirePlainRecord(state, 'expected state');
  if (s.kind === 'absent') {
    assertNoUnknownFields(s, EXPECTED_ABSENT_FIELDS, 'expected state(absent)');
    return { kind: 'absent' };
  }
  if (s.kind !== 'present') invalidExpected(`未知 kind: ${JSON.stringify(s.kind)}`);
  assertNoUnknownFields(s, EXPECTED_PRESENT_FIELDS, 'expected state(present)');
  if (typeof s.contentSha256 !== 'string') invalidExpected('present 必须携带 contentSha256');
  const out: { kind: 'present'; contentSha256: Sha256Hex; baseRef?: string; baseBlob?: GitObjectId } = {
    kind: 'present',
    contentSha256: normalizeSha256(s.contentSha256),
  };
  if (s.baseRef !== undefined) out.baseRef = normalizeHeadRef(s.baseRef);
  if (s.baseBlob !== undefined) out.baseBlob = normalizeGitObjectId(s.baseBlob);
  return out;
}

// ----------------------------------------------------------------------------
// WriteTarget 归一 + full/actual writeSet 去重/排序(ADR-0021 §1/§4 + 审计)
// ----------------------------------------------------------------------------

function assertByteLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StoreError('TX_INVALID_BYTE_LENGTH', `outputByteLength 必须是非负安全整数: ${JSON.stringify(value)}`, {
      value,
    });
  }
  return value;
}

const BYTES_TARGET_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'path',
  'expected',
  'bytes',
  'mode',
  'blob',
  'outputSha256',
  'outputByteLength',
]);
const DELETE_TARGET_FIELDS: ReadonlySet<string> = new Set(['kind', 'path', 'expected']);

/**
 * 单个 target 归一(unknown 入参, fail-closed): plain 对象门禁 + 字段白名单 +
 * 路径/expected/mode/blob 校验。`bytes`(原始字节)输入计算 hash+长度; 未知 kind
 * 不得降级为 bytes 变体(TX_INVALID_TARGET_KIND)。
 */
export function normalizeWriteTarget(target: unknown): WriteTarget {
  const t = requirePlainRecord(target, 'write target');
  const path = normalizeRelPath(t.path);
  if (t.kind === 'delete') {
    assertNoUnknownFields(t, DELETE_TARGET_FIELDS, 'delete target');
    return { kind: 'delete', path, expected: normalizeExpectedState(t.expected) };
  }
  if (t.kind !== 'bytes') {
    // 未知 target kind: fail-closed, 不猜测不降级。
    throw new StoreError('TX_INVALID_TARGET_KIND', `未知 write target kind(不得降级): ${JSON.stringify(t.kind)}`, {
      kind: t.kind,
    });
  }
  assertNoUnknownFields(t, BYTES_TARGET_FIELDS, 'bytes target');
  // bytes 变体: 原始字节(Uint8Array)或已归一形态(outputSha256 + outputByteLength)。
  if ('bytes' in t) {
    const bytes = t.bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new StoreError('TX_INVALID_BYTE_LENGTH', 'bytes 目标必须携带 Uint8Array 原始字节', { path });
    }
    if (typeof t.blob !== 'string') {
      throw new StoreError('TX_INTENT_INVALID', `bytes 目标必须显式声明 blob 身份(40/64 hex): ${path}`, { path });
    }
    return {
      kind: 'bytes',
      path,
      expected: normalizeExpectedState(t.expected),
      outputSha256: sha256Hex(bytes),
      outputByteLength: bytes.byteLength,
      mode: normalizeFileMode(t.mode),
      blob: normalizeGitObjectId(t.blob),
    };
  }
  return {
    kind: 'bytes',
    path,
    expected: normalizeExpectedState(t.expected),
    outputSha256: normalizeSha256(t.outputSha256),
    outputByteLength: assertByteLength(t.outputByteLength),
    mode: normalizeFileMode(t.mode),
    blob: normalizeGitObjectId(t.blob),
  };
}

export function cmpPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * writeSet 归一: 逐目标校验 → 按路径字典序排序 → 同路径去重。
 * 完全相同(含 expected/output/mode/blob)的重复目标只留第一个; 同路径但语义冲突
 * 一律抛 TX_DUPLICATE_TARGET(ADR-0021 §1「调用方必须声明完整 writeSet」——
 * 歧义即拒绝, 不猜测)。
 */
export function normalizeWriteTargets(targets: unknown): WriteTarget[] {
  if (!Array.isArray(targets)) {
    throw new StoreError('TX_INTENT_INVALID', 'writeSet 必须是数组', { targets });
  }
  const out = targets.map(normalizeWriteTarget);
  out.sort((a, b) => cmpPath(a.path, b.path));
  const deduped: WriteTarget[] = [];
  for (const t of out) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.path === t.path) {
      if (canonicalJson(last) !== canonicalJson(t)) {
        throw new StoreError('TX_DUPLICATE_TARGET', `writeSet 同路径重复且语义冲突: ${t.path}`, { path: t.path });
      }
      continue; // 完全一致的重复目标 → 去重
    }
    deduped.push(t);
  }
  return deduped;
}

/**
 * actualWriteSet 解析: 缺省 = 全部 full(调用方声明完整集时的常态);
 * 显式 actualPaths 必须是 full 路径的有序子集(从 full 提取, 保持排序),
 * 含 full 外路径/重复/非法路径一律 TX_WRITESET_MISMATCH; 空数组 = no-op 可表达。
 */
function resolveActualSet(full: readonly WriteTarget[], actualPaths: unknown): WriteTarget[] {
  if (actualPaths === undefined) return full as WriteTarget[];
  if (!Array.isArray(actualPaths)) {
    throw new StoreError('TX_WRITESET_MISMATCH', 'actualPaths 必须是数组(缺省 = 全部 full)', { actualPaths });
  }
  const byPath = new Map<string, WriteTarget>();
  for (const t of full) byPath.set(t.path, t);
  const seen = new Set<string>();
  const out: WriteTarget[] = [];
  for (const raw of actualPaths) {
    const p = normalizeRelPath(raw);
    if (seen.has(p)) {
      throw new StoreError('TX_WRITESET_MISMATCH', `actualPaths 重复: ${p}`, { path: p });
    }
    seen.add(p);
    const t = byPath.get(p);
    if (t === undefined) {
      throw new StoreError('TX_WRITESET_MISMATCH', `actual 含 full 外路径(actual 必须是 full 的有序子集): ${p}`, {
        path: p,
      });
    }
    out.push(t);
  }
  return out;
}

/** actual ⊆ full 且逐目标 canonical 一致(有序子集; 双方均已按路径排序)。 */
function assertActualSubsetOfFull(full: readonly WriteTarget[], actual: readonly WriteTarget[]): void {
  const fullByIdentity = new Map<string, string>();
  for (const t of full) fullByIdentity.set(t.path, canonicalJson(t));
  for (const t of actual) {
    const expected = fullByIdentity.get(t.path);
    if (expected === undefined || expected !== canonicalJson(t)) {
      throw new StoreError(
        'TX_WRITESET_MISMATCH',
        `actual 必须是 full 的有序子集(目标逐项一致): ${t.path}`,
        { path: t.path },
      );
    }
  }
}

// ----------------------------------------------------------------------------
// preSnapshot 归一(ADR-0021 §4: 仅用于 §7 回滚, 路径集合须与计划 full 一致)
// ----------------------------------------------------------------------------

const PRESNAPSHOT_ENTRY_FIELDS: ReadonlySet<string> = new Set(['path', 'state']);
const PRE_STATE_PRESENT_FIELDS: ReadonlySet<string> = new Set(['kind', 'contentSha256']);

function normalizePreTargetSnapshot(state: unknown, path: string): PreTargetSnapshot {
  const s = requirePlainRecord(state, `preSnapshot state(${path})`);
  if (s.kind === 'absent') {
    assertNoUnknownFields(s, EXPECTED_ABSENT_FIELDS, `preSnapshot state(absent, ${path})`);
    return { kind: 'absent' };
  }
  if (s.kind !== 'present') {
    throw new StoreError('TX_INTENT_INVALID', `preSnapshot state 未知 kind: ${path}`, { path, kind: s.kind });
  }
  assertNoUnknownFields(s, PRE_STATE_PRESENT_FIELDS, `preSnapshot state(present, ${path})`);
  if (typeof s.contentSha256 !== 'string') {
    throw new StoreError('TX_INTENT_INVALID', `preSnapshot present 必须携带 contentSha256: ${path}`, { path });
  }
  return { kind: 'present', contentSha256: normalizeSha256(s.contentSha256) };
}

export function normalizePreSnapshotEntry(entry: unknown): PreSnapshotEntry {
  const e = requirePlainRecord(entry, 'preSnapshot 条目');
  assertNoUnknownFields(e, PRESNAPSHOT_ENTRY_FIELDS, 'preSnapshot 条目');
  const path = normalizeRelPath(e.path);
  return { path, state: normalizePreTargetSnapshot(e.state, path) };
}

export function normalizePreSnapshot(entries: unknown): PreSnapshotEntry[] {
  if (!Array.isArray(entries)) {
    throw new StoreError('TX_INTENT_INVALID', 'preSnapshot 必须是数组', { entries });
  }
  const out = entries.map(normalizePreSnapshotEntry);
  out.sort((a, b) => cmpPath(a.path, b.path));
  const deduped: PreSnapshotEntry[] = [];
  for (const e of out) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.path === e.path) {
      if (canonicalJson(last) !== canonicalJson(e)) {
        throw new StoreError('TX_DUPLICATE_TARGET', `preSnapshot 同路径重复且冲突: ${e.path}`, { path: e.path });
      }
      continue;
    }
    deduped.push(e);
  }
  return deduped;
}

// ----------------------------------------------------------------------------
// 稳定 JSON canonical 序列化(plan/intent/digest 的唯一序列化器)
// ----------------------------------------------------------------------------

/**
 * canonical JSON: 递归按键名字典序排列对象键、省略 undefined 值、保留数组顺序。
 * 数字/字符串/布尔/null 按 JSON.stringify 语义(整数 1.0 → "1"), 因此同一
 * 语义载荷无论键序/多余 undefined 如何, canonicalJson 恒等 → digest 可重推导
 * (ADR-0021 §6/§8)。要求输入为 JSON 安全值(不处理函数/符号/Uint8Array;
 * 字节目标在归一形态只保留 hash, 不进入序列化)。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      obj[k] = canonicalizeValue(v);
    }
    return obj;
  }
  return value;
}

// ----------------------------------------------------------------------------
// txid / kind / 通用断言
// ----------------------------------------------------------------------------

export function assertTxId(txid: unknown): string {
  if (!isTxId(txid)) {
    throw new StoreError(
      'TX_INVALID_TXID',
      `非法 txid(须 canonical tx- + 64 位小写 hex): ${JSON.stringify(txid)}`,
      { txid },
    );
  }
  return txid;
}

export function assertTransactionKind(kind: unknown): TransactionKind {
  if (!isTransactionKind(kind)) {
    throw new StoreError(
      'TX_INVALID_KIND',
      `未知 TransactionKind(须 canonical/checkpoint/state/run_bootstrap): ${JSON.stringify(kind)}`,
      { kind },
    );
  }
  return kind;
}

function assertVaultRoot(vaultRoot: unknown): string {
  if (typeof vaultRoot !== 'string' || vaultRoot.length === 0 || vaultRoot.length > VAULT_ROOT_MAX) {
    throw new StoreError('TX_INTENT_INVALID', `vaultRoot 非法(长度 1–${VAULT_ROOT_MAX} 的字符串): ${JSON.stringify(vaultRoot)}`);
  }
  if (CONTROL_RE.test(vaultRoot)) {
    throw new StoreError('TX_INTENT_INVALID', 'vaultRoot 含控制字符');
  }
  // 身份字段要求可对照: 必须是绝对路径形态(POSIX `/` 开头或 Windows 盘符)。
  if (!vaultRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(vaultRoot)) {
    throw new StoreError('TX_INTENT_INVALID', `vaultRoot 必须是绝对路径形态(身份对照用): ${JSON.stringify(vaultRoot)}`);
  }
  return vaultRoot;
}

function assertIsoUtc(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    throw new StoreError('TX_INTENT_INVALID', `${field} 必须是 ISO-8601 UTC(如 2026-08-15T00:00:00.000Z): ${JSON.stringify(value)}`);
  }
  return value;
}

// ----------------------------------------------------------------------------
// TransactionPlan: 构建 + digest 计算 + 验证(ADR-0021 §6; 审计: digest 覆盖
// base+exactTree+full+actual 全部, no-op 可表达)
// ----------------------------------------------------------------------------

/** plan digest = sha256(canonicalJson(version/txid/kind/ref/baseHead/exactTree/fullWriteSet/actualWriteSet))。 */
export function computePlanDigest(payload: PlanPayload): Sha256Hex {
  return sha256Hex(canonicalJson(payload));
}

const PLAN_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'txid',
  'kind',
  'ref',
  'baseHead',
  'exactTree',
  'fullWriteSet',
  'actualPaths',
]);

export function buildPlan(input: PlanInput): TransactionPlan {
  const i = requirePlainRecord(input, 'plan input');
  assertNoUnknownFields(i, PLAN_INPUT_FIELDS, 'plan input');
  const txid = assertTxId(input.txid);
  const kind = assertTransactionKind(input.kind);
  const ref = normalizeRef(input.ref);
  const baseHead = normalizeGitObjectId(input.baseHead);
  const exactTree = normalizeGitObjectId(input.exactTree);
  const fullWriteSet = normalizeWriteTargets(input.fullWriteSet);
  const actualWriteSet = resolveActualSet(fullWriteSet, input.actualPaths);
  const payload: PlanPayload = { version: 1, txid, kind, ref, baseHead, exactTree, fullWriteSet, actualWriteSet };
  return { ...payload, digest: computePlanDigest(payload) };
}

/** 便捷布尔版: plan.digest 与重推导是否一致。 */
export function verifyPlanDigest(plan: unknown): boolean {
  try {
    verifyPlan(plan);
    return true;
  } catch {
    return false;
  }
}

const PLAN_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'txid',
  'kind',
  'ref',
  'baseHead',
  'exactTree',
  'fullWriteSet',
  'actualWriteSet',
  'digest',
]);

function canonicalEqualsWriteSet(plan: Record<string, unknown>, field: 'fullWriteSet' | 'actualWriteSet'): WriteTarget[] {
  // 已归一的 writeSet 再归一必须保持 canonical 形态恒等(重推导, ADR-0021 §8)。
  const stored = plan[field];
  const normalized = normalizeWriteTargets(stored);
  if (canonicalJson(normalized) !== canonicalJson(stored)) {
    throw new StoreError('TX_INTENT_INVALID', `plan.${field} 非 canonical 形态(未排序/未归一/重复)`);
  }
  return normalized;
}

/**
 * 验证 plan 并恢复其约束(in-place 返回断言): plain 门禁 + 字段白名单 → 版本 →
 * 白名单字段 → 未归一输入拒绝 → full/actual canonical → actual ⊆ full →
 * plan digest 重推导比对(不符 = TX_PLAN_DIGEST_MISMATCH)。
 */
export function verifyPlan(plan: unknown): asserts plan is TransactionPlan {
  const p = requirePlainRecord(plan, 'plan');
  assertNoUnknownFields(p, PLAN_FIELDS, 'plan');
  if (p.version !== 1) {
    throw new StoreError('TX_INTENT_INVALID', `未知 plan schema 版本: ${JSON.stringify(p.version)}`, { version: p.version });
  }
  const txid = assertTxId(p.txid);
  const kind = assertTransactionKind(p.kind);
  const ref = normalizeRef(p.ref);
  const baseHead = normalizeGitObjectId(p.baseHead);
  const exactTree = normalizeGitObjectId(p.exactTree);
  if (ref !== p.ref || baseHead !== p.baseHead || exactTree !== p.exactTree) {
    throw new StoreError('TX_INTENT_INVALID', 'plan.ref/baseHead/exactTree 非 canonical 形态(须已归一小写)');
  }
  const fullWriteSet = canonicalEqualsWriteSet(p, 'fullWriteSet');
  const actualWriteSet = canonicalEqualsWriteSet(p, 'actualWriteSet');
  assertActualSubsetOfFull(fullWriteSet, actualWriteSet);
  if (typeof p.digest !== 'string') {
    throw new StoreError('TX_PLAN_DIGEST_MISMATCH', 'plan.digest 缺失');
  }
  const expected = computePlanDigest({ version: 1, txid, kind, ref, baseHead, exactTree, fullWriteSet, actualWriteSet });
  if (p.digest.toLowerCase() !== expected) {
    throw new StoreError('TX_PLAN_DIGEST_MISMATCH', 'plan digest 与重推导不符(plan 被篡改或非法)', {
      expected,
      actual: p.digest,
    });
  }
  if (p.digest !== expected) {
    throw new StoreError('TX_INTENT_INVALID', 'plan.digest 非 canonical 形态(未归一小写)');
  }
}

// ----------------------------------------------------------------------------
// TransactionIntent: 构建 + 验证 + 序列化(ADR-0021 §8 durable intent)
// ----------------------------------------------------------------------------

const INTENT_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'txid',
  'vaultRoot',
  'kind',
  'ref',
  'baseHead',
  'exactTree',
  'fullWriteSet',
  'actualPaths',
  'preSnapshot',
  'createdAt',
  'cleanup',
]);

export function buildIntent(input: IntentInput): TransactionIntent {
  const i = requirePlainRecord(input, 'intent input');
  assertNoUnknownFields(i, INTENT_INPUT_FIELDS, 'intent input');
  const plan = buildPlan({
    txid: input.txid,
    kind: input.kind,
    ref: input.ref,
    baseHead: input.baseHead,
    exactTree: input.exactTree,
    fullWriteSet: input.fullWriteSet,
    actualPaths: input.actualPaths,
  });
  const vaultRoot = assertVaultRoot(input.vaultRoot);
  const preSnapshot = normalizePreSnapshot(input.preSnapshot);
  assertSamePathSet(plan.fullWriteSet, preSnapshot, 'preSnapshot');
  const createdAt = assertIsoUtc(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const cleanup = input.cleanup ?? 'pending';
  if (!isCleanupState(cleanup)) {
    throw new StoreError('TX_INTENT_INVALID', `未知 cleanup 状态: ${JSON.stringify(cleanup)}`, { cleanup });
  }
  const payload: Omit<TransactionIntent, 'digest'> = {
    version: 1,
    txid: plan.txid,
    vaultRoot,
    kind: plan.kind,
    ref: plan.ref,
    baseHead: plan.baseHead,
    plan,
    preSnapshot,
    cleanup,
    createdAt,
  };
  return { ...payload, digest: sha256Hex(canonicalJson(payload)) };
}

function assertSamePathSet(
  planFullWriteSet: readonly WriteTarget[],
  snapshots: readonly PreSnapshotEntry[],
  what: string,
): void {
  // 两数组均已排序; 集合相等 = 逐元素相等。
  if (planFullWriteSet.length !== snapshots.length) {
    throw new StoreError(
      'TX_INTENT_INVALID',
      `${what} 路径集合必须与计划 fullWriteSet 完全一致(ADR-0021 §4: 每个目标都记录事务前快照)`,
      {
        planPaths: planFullWriteSet.map((t) => t.path),
        snapshotPaths: snapshots.map((e) => e.path),
      },
    );
  }
  for (let i = 0; i < planFullWriteSet.length; i++) {
    if (planFullWriteSet[i].path !== snapshots[i].path) {
      throw new StoreError(
        'TX_INTENT_INVALID',
        `${what} 路径集合必须与计划 fullWriteSet 完全一致(ADR-0021 §4)`,
        {
          planPaths: planFullWriteSet.map((t) => t.path),
          snapshotPaths: snapshots.map((e) => e.path),
        },
      );
    }
  }
}

const INTENT_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'txid',
  'vaultRoot',
  'kind',
  'ref',
  'baseHead',
  'plan',
  'preSnapshot',
  'cleanup',
  'createdAt',
  'digest',
]);

/**
 * 验证 intent 并恢复其约束(ADR-0021 §8「先验证, 后动作」): plain 门禁 + 字段
 * 白名单、版本/身份字段、已归一形态、plan 深度验证与身份一致、plan digest +
 * intent digest 重推导。任一不符抛 TX_*(不吞错、不自动修复)。
 */
export function verifyIntent(intent: unknown): asserts intent is TransactionIntent {
  const it = requirePlainRecord(intent, 'intent');
  assertNoUnknownFields(it, INTENT_FIELDS, 'intent');
  if (it.version !== 1) {
    throw new StoreError('TX_INTENT_INVALID', `未知 intent schema 版本: ${JSON.stringify(it.version)}`, {
      version: it.version,
    });
  }
  const txid = assertTxId(it.txid);
  const kind = assertTransactionKind(it.kind);
  const vaultRoot = assertVaultRoot(it.vaultRoot);
  const ref = normalizeRef(it.ref);
  const baseHead = normalizeGitObjectId(it.baseHead);
  if (ref !== it.ref || baseHead !== it.baseHead) {
    throw new StoreError('TX_INTENT_INVALID', 'intent.ref/baseHead 非 canonical 形态(须已归一小写)');
  }
  // plan 深度验证(含 plain 门禁/字段白名单/plan digest 重推导)。
  verifyPlan(it.plan);
  const plan = it.plan as TransactionPlan;
  // 身份一致性: intent 头部字段必须与内嵌 plan 一致(双源分叉 = 非法, §8 身份验证)。
  if (plan.txid !== txid || plan.kind !== kind || plan.ref !== ref || plan.baseHead !== baseHead) {
    throw new StoreError('TX_INTENT_INVALID', 'intent 头部与 plan 身份字段不一致(不允许双源分叉)', {
      intent: { txid, kind, ref, baseHead },
      plan: { txid: plan.txid, kind: plan.kind, ref: plan.ref, baseHead: plan.baseHead },
    });
  }
  const preSnapshot = normalizePreSnapshot(it.preSnapshot);
  if (canonicalJson(preSnapshot) !== canonicalJson(it.preSnapshot)) {
    throw new StoreError('TX_INTENT_INVALID', 'intent.preSnapshot 非 canonical 形态(未排序/未归一/重复)');
  }
  assertSamePathSet(plan.fullWriteSet, preSnapshot, 'intent.preSnapshot');
  if (!isCleanupState(it.cleanup)) {
    throw new StoreError('TX_INTENT_INVALID', `未知 cleanup 状态: ${JSON.stringify(it.cleanup)}`, { cleanup: it.cleanup });
  }
  const cleanup = it.cleanup as CleanupState;
  const createdAt = assertIsoUtc(it.createdAt, 'intent.createdAt');
  if (typeof it.digest !== 'string') {
    throw new StoreError('TX_INTENT_DIGEST_MISMATCH', 'intent.digest 缺失');
  }
  const payload: Omit<TransactionIntent, 'digest'> = {
    version: 1,
    txid,
    vaultRoot,
    kind,
    ref,
    baseHead,
    plan,
    preSnapshot,
    cleanup,
    createdAt,
  };
  const expected = sha256Hex(canonicalJson(payload));
  if (it.digest.toLowerCase() !== expected) {
    throw new StoreError('TX_INTENT_DIGEST_MISMATCH', 'intent digest 与重推导不符(intent 被篡改)', {
      expected,
      actual: it.digest,
    });
  }
  if (it.digest !== expected) {
    throw new StoreError('TX_INTENT_INVALID', 'intent.digest 非 canonical 形态(未归一小写)');
  }
}

/** intent → canonical JSON(持久化到 .git 内部控制区, ADR-0021 §8)。 */
export function serializeIntent(intent: TransactionIntent): string {
  return canonicalJson(intent);
}

/** canonical JSON → intent: 解析 + 版本白名单 + 全量验证(fail-closed)。 */
export function deserializeIntent(json: string): TransactionIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new StoreError('TX_INTENT_INVALID', `intent JSON 无法解析: ${(err as Error).message}`, { json });
  }
  verifyIntent(parsed);
  return parsed;
}

// ----------------------------------------------------------------------------
// TransactionStatus / TransactionResult: 构建(digest 自动计算)
// ----------------------------------------------------------------------------

const WORKTREE_ENTRY_FIELDS: ReadonlySet<string> = new Set(['path', 'state']);
const INDEX_ENTRY_FIELDS: ReadonlySet<string> = new Set(['path', 'state']);

/** 逐目标 worktree 分类归一(plain 门禁 + 字段白名单 + 路径校验 + 枚举白名单, 排序; ADR-0021 §7)。 */
export function normalizeWorktreeEntries(entries: unknown): WorktreeStateEntry[] {
  if (!Array.isArray(entries)) {
    throw new StoreError('TX_INTENT_INVALID', 'worktree 必须是数组', { entries });
  }
  const out: WorktreeStateEntry[] = [];
  for (const e of entries) {
    const rec = requirePlainRecord(e, 'worktree 条目');
    assertNoUnknownFields(rec, WORKTREE_ENTRY_FIELDS, 'worktree 条目');
    if (!isWorktreeState(rec.state)) {
      throw new StoreError('VALIDATION_FAILED', `worktree 条目非法: ${JSON.stringify(rec.state)}`, { entry: rec });
    }
    out.push({ path: normalizeRelPath(rec.path), state: rec.state });
  }
  out.sort((a, b) => cmpPath(a.path, b.path));
  return out;
}

/** 共享 index 条目归一(ADR-0021 §7 BASE/OUTPUT/CONFLICT)。 */
export function normalizeIndexEntries(entries: unknown): IndexStateEntry[] {
  if (!Array.isArray(entries)) {
    throw new StoreError('TX_INTENT_INVALID', 'index 必须是数组', { entries });
  }
  const out: IndexStateEntry[] = [];
  for (const e of entries) {
    const rec = requirePlainRecord(e, 'index 条目');
    assertNoUnknownFields(rec, INDEX_ENTRY_FIELDS, 'index 条目');
    if (!isIndexEntryState(rec.state)) {
      throw new StoreError('VALIDATION_FAILED', `index 条目非法: ${JSON.stringify(rec.state)}`, { entry: rec });
    }
    out.push({ path: normalizeRelPath(rec.path), state: rec.state });
  }
  out.sort((a, b) => cmpPath(a.path, b.path));
  return out;
}

function digestOf(payload: Record<string, unknown>): Sha256Hex {
  return sha256Hex(canonicalJson(payload));
}

const STATUS_INPUT_FIELDS: ReadonlySet<string> = new Set(['txid', 'kind', 'phase', 'worktree', 'index', 'planDigest', 'updatedAt']);

export function buildStatus(input: StatusInput): TransactionStatus {
  const i = requirePlainRecord(input, 'status input');
  assertNoUnknownFields(i, STATUS_INPUT_FIELDS, 'status input');
  const txid = assertTxId(input.txid);
  const kind = assertTransactionKind(input.kind);
  if (!isTransactionPhase(input.phase)) {
    throw new StoreError('VALIDATION_FAILED', `未知 TransactionPhase: ${JSON.stringify(input.phase)}`, { phase: input.phase });
  }
  const worktree = normalizeWorktreeEntries(input.worktree ?? []);
  const index = normalizeIndexEntries(input.index ?? []);
  const planDigest = normalizeSha256(input.planDigest);
  const updatedAt = assertIsoUtc(input.updatedAt ?? new Date().toISOString(), 'updatedAt');
  const payload: Omit<TransactionStatus, 'digest'> = {
    version: 1,
    txid,
    kind,
    phase: input.phase,
    worktree,
    index,
    planDigest,
    updatedAt,
  };
  return { ...payload, digest: digestOf(payload) };
}

const RESULT_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'txid',
  'kind',
  'outcome',
  'ref',
  'baseHead',
  'newHead',
  'planDigest',
  'worktree',
  'index',
  'createdAt',
]);

export function buildResult(input: ResultInput): TransactionResult {
  const i = requirePlainRecord(input, 'result input');
  assertNoUnknownFields(i, RESULT_INPUT_FIELDS, 'result input');
  const txid = assertTxId(input.txid);
  const kind = assertTransactionKind(input.kind);
  if (!isTransactionOutcome(input.outcome)) {
    throw new StoreError('VALIDATION_FAILED', `未知 TransactionOutcome: ${JSON.stringify(input.outcome)}`, {
      outcome: input.outcome,
    });
  }
  const ref = normalizeRef(input.ref);
  const baseHead = normalizeGitObjectId(input.baseHead);
  const newHead = input.newHead === undefined ? undefined : normalizeGitObjectId(input.newHead);
  const planDigest = normalizeSha256(input.planDigest);
  const worktree = normalizeWorktreeEntries(input.worktree ?? []);
  const index = normalizeIndexEntries(input.index ?? []);
  const createdAt = assertIsoUtc(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const payload: Omit<TransactionResult, 'digest'> = {
    version: 1,
    txid,
    kind,
    outcome: input.outcome,
    ref,
    baseHead,
    planDigest,
    worktree,
    index,
    createdAt,
  };
  if (newHead !== undefined) (payload as { newHead?: GitObjectId }).newHead = newHead;
  return { ...payload, digest: digestOf(payload) };
}