/**
 * ADR-0021 §8 / N32 durable transaction intent 存储层(store 核心包, 零 DSH 依赖, 铁律 1)。
 *
 * 职责: 在 vault 的 `.git` 内部控制区(`.git/novelcraft-transactions/<txid>/`)持久、
 * 原子地写入/读取/验证/列举/清理「写事务恢复元数据」(transaction intent)。intent 是
 * **临时恢复元数据, 不是资产/数据库/队列**(铁律 2: 不构成第二真相源), 成功 commit 或
 * 安全回滚完成后由上层清理(ADR-0021 §8「清理」); `.git` 内 = 天然不进 index, 不会被
 * 任何 `add` 卷入 commit(ADR-0021 §8)。
 *
 * 目录布局(白名单; 与 READY 就绪标记共同构成「半写可识别」, ADR-0021 §8):
 *   .git/novelcraft-transactions/
 *   └── <txid>/
 *       ├── intent.json          # 版本化 schema(版本/字段/大小白名单)
 *       ├── READY                # 就绪标记: 最后原子 rename; 缺 READY = 半写残留
 *       ├── snapshots/<i>.bin    # 事务前字节快照(二进制, 每目标一份, 与 targets 下标对齐)
 *       └── outputs/<i>.bin      # 计划输出字节(二进制, 每目标一份)
 *
 * 耐久化协议(N32 / ADR-0021 §8「写前耐久化」):
 *   1. 逐文件: 同目录 tmp 文件写入 + 文件 fsync + 原子 rename + 父目录 fsync;
 *   2. READY **最后** rename, 是「崩溃点提交」标记 —— 缺 READY 的任何残留都是半写
 *      intent, 恢复时忽略并清理(`cleanupIncomplete`), 该事务视为未开始(ADR-0021 §8:
 *      「崩溃于 intent 写入之中 = 无就绪标记的半写残留, 恢复时忽略并清理」);
 *   3. READY 存在后, 对同一 txid 的任何再写入一律 fail-closed(INTENT_EXISTS, 不覆盖)。
 *
 * 信任边界(恢复器/读取方**不盲信内容**, ADR-0021 §8「恢复验证」):
 *   - 版本白名单: schema ∈ KNOWN_SCHEMA_VERSIONS(未知版本 → INTENT_INVALID_SCHEMA);
 *   - 字段白名单: intent.json 顶层 / target / expected 只允许本文件声明的字段,
 *     未知字段一律 INTENT_INVALID_FIELD(不忽略、不修复);
 *   - 大小白名单: intent.json ≤ INTENT_MAX_BYTES、单个快照/输出 ≤ BLOB_MAX_BYTES、
 *     targets 数 ≤ MAX_TARGETS、单个目标路径 ≤ INTENT_PATH_MAX(超限 → INTENT_TOO_LARGE);
 *   - txid 白名单: TXID_PATTERN(I/II 类非法字符与 `..`/`.`/空/绝对/含分隔符一律拒绝),
 *     目录名在**一切路径拼接之前**校验(INTENT_INVALID_TXID);
 *   - path 白名单: targets[].path 必须是 vault 相对规范化路径(拒绝绝对路径、`..` 段、
 *     空段、`.` 段、反斜杠、控制字符、越界), 并经 vault `guardPath` 双重 containment
 *     (词法 + real, R9)(INTENT_TRAVERSAL);
 *   - symlink 白名单: intent 目录链与每个**目标路径**从 vault 根起逐段 lstat, 任一已
 *     存在组件为 symlink 一律 fail-closed(INTENT_SYMLINK, ADR-0021 §8「拒绝…目标或
 *     父目录 symlink」);
 *   - 内容校验: intent.json 解析后记录级重验; 每个快照/输出字节的 SHA-256 与
 *     record 内 snapshotSha256/outputSha256 比对(`readIntentBlob` / `verifyIntentBlobs`,
 *     篡改/损坏 → INTENT_BAD_CONTENT)。
 *
 * 语义边界: kind/branch/baseHead/expected/planDigest 在此层只做**结构白名单**(格式/
 * 长度/类型); kind 的能力重推导(封闭注册表 + 已提交 plan digest + 路径 allowlist)、
 * plan digest 重算、expected-state CAS 复验、ref/index 状态判定等**语义验证属于上层
 * 恢复器**(ADR-0021 §8: kind/恢复策略只是待验证声明, 不能自报即可信)。本层只保证
 * 「存储的内容在结构上可信、可被安全消费」; 调用方持有的是本层重验后的规范化对象,
 * 不是原始 untrusted 内容。
 *
 * 与并行 transaction/types.ts 的关系: 本文件自包含地定义窄 schema(字段名对齐
 * ADR-0021 词表: schema/txid/kind/branch/baseHead/planDigest/createdAt/targets/
 * path/expected/existed + snapshotSha256/outputSha256), 不 import 彼文件; 若双方
 * schema 合并, 以本文件的持久化字段清单为准(intent.json 是唯一落盘形态)。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import { assertNoSymlinkOnPath, guardPath } from '@novelcraft/vault';
import { sha256Hex } from '../hash.js';

/** intent 命名空间目录名(位于 `<vault>/.git/` 下)。 */
export const TRANSACTION_NAMESPACE_DIR = 'novelcraft-transactions';

/** intent 元数据文件名(版本化 schema)。 */
export const INTENT_FILE = 'intent.json';

/** 就绪标记文件名: 其存在 = intent 已耐久化完成(原子提交点)。 */
export const READY_FILE = 'READY';

/** 事务前字节快照目录名。 */
export const SNAPSHOTS_DIR = 'snapshots';

/** 计划输出字节目录名。 */
export const OUTPUTS_DIR = 'outputs';

/** 当前 intent schema 版本。 */
export const INTENT_SCHEMA_VERSION = 1 as const;

/** 已知 schema 版本白名单(未知版本 → INTENT_INVALID_SCHEMA)。 */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [INTENT_SCHEMA_VERSION];

/** intent.json 大小白名单上限(1 MiB; 含 1024 目标的极端路径组合)。 */
export const INTENT_MAX_BYTES = 1024 * 1024;

/** 单个快照/输出二进制文件大小白名单上限(16 MiB)。 */
export const BLOB_MAX_BYTES = 16 * 1024 * 1024;

/** writeSet 目标数白名单上限。 */
export const MAX_TARGETS = 1024;

/** 单个目标路径长度白名单上限。 */
export const INTENT_PATH_MAX = 1024;

/**
 * txid 白名单(统一契约, 审计): canonical `tx-` + 64 位小写 hex, 与 codec.isTxId
 * 同口径。由此排除空、`.`、`..`、绝对路径与一切路径分隔符/控制字符/非 hex
 * (路径拼接前校验; 目录名即 txid, 恢复时逐条对照)。
 */
export const TXID_PATTERN = /^tx-[0-9a-f]{64}$/;

/** intent kind 声明白名单(kind 能力重推导的输入之一; 语义判定在上层)。 */
export const INTENT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** 内容哈希: sha256 纯 64 位 hex(N13 口径)。 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** git 对象 id(40-hex SHA-1 或 64-hex SHA-256 仓库; N32 复审 P1-2: 生产 execute/
 * recovery 支持 sha256 object format 仓库, intent.baseHead 必须两者都收——语义核对
 * (ref 解析/plan digest 重推导)在上层按实际仓库 object format 判定, 此处只做结构
 * 白名单, 收窄会令 sha256 仓库无法持久化 intent)。 */
const GIT_OID_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** 大小白名单可覆盖项(persist/read 校验用; 默认见 *_MAX_BYTES / MAX_TARGETS)。 */
export interface IntentLimits {
  maxIntentBytes?: number;
  maxBlobBytes?: number;
  maxTargets?: number;
}

export type IntentErrorCode =
  | 'INTENT_INVALID_SCHEMA' // 版本白名单外 / 类型非法
  | 'INTENT_INVALID_FIELD' // 未知字段 / 字段类型或取值非法 / record.txid 与目录名不一致
  | 'INTENT_INVALID_TXID' // txid 白名单外(路径拼接前)
  | 'INTENT_TOO_LARGE' // 大小白名单超限(intent.json / 二进制 / 目标数 / 路径长)
  | 'INTENT_TRAVERSAL' // 目标路径越界(vault 外 / .. / 绝对 / 反斜杠 / 控制字符)
  | 'INTENT_SYMLINK' // 目标或父目录 symlink(不跟随、不写入、不删除)
  | 'INTENT_EXISTS' // 同一 txid 已就绪/半写残留, 不覆盖
  | 'INTENT_NOT_FOUND' // 无此 txid intent
  | 'INTENT_NOT_READY' // 存在但缺 READY(半写)
  | 'INTENT_BAD_LAYOUT' // 目录布局白名单外(多余/缺失/类型不符条目)
  | 'INTENT_BAD_CONTENT' // intent.json 非 JSON / 内容哈希不符(篡改/损坏)
  | 'INTENT_NOT_REPO' // vault 根缺 .git 或 .git 非目录(R9)
  | 'INTENT_IO'; // 文件系统操作失败

export class IntentError extends Error {
  readonly code: IntentErrorCode;
  readonly details?: unknown;

  constructor(code: IntentErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'IntentError';
    this.code = code;
    this.details = details;
  }
}

/** 期望状态(ADR-0021 §4: 内容 CAS 的唯一基线; 语义核对属上层 preflight)。 */
export type IntentExpected =
  | { kind: 'absent'; sha256?: never }
  | { kind: 'content'; sha256: string };

/** writeSet 单个目标在 intent 里的记录。 */
export interface IntentTargetEntry {
  /** vault 相对路径('/' 分隔, 无前导 '/'; 存储层做规范化/白名单校验)。 */
  path: string;
  /** 期望状态(生成计划时的 expected state)。 */
  expected: IntentExpected;
  /** 事务启动时目标是否存在(§4 事务前快照的存在状态半部; 恢复矩阵 BEFORE 判定用)。 */
  existed: boolean;
  /**
   * 事务前字节快照的 SHA-256。persist 会以实际快照字节计算并写入落盘 record;
   * 调用方若自带了该值则核对, 不符 fail-closed(INTENT_BAD_CONTENT)。
   */
  snapshotSha256?: string;
  /**
   * 计划输出字节的 SHA-256。persist 会以实际输出字节计算并写入落盘 record;
   * 调用方若自带了该值则核对, 不符 fail-closed(INTENT_BAD_CONTENT)。
   */
  outputSha256?: string;
}

/** intent 记录(版本化 schema; 落盘于 intent.json)。 */
export interface IntentRecord {
  schema: typeof INTENT_SCHEMA_VERSION;
  txid: string;
  /** 事务 kind 声明(如 canonical_adopt/checkpoint/state; 能力重推导在上层)。 */
  kind: string;
  /** 目标 branch/ref(可选; git ref 形态白名单)。 */
  branch?: string;
  /** base HEAD(git 对象 id: 40-hex SHA-1 或 64-hex SHA-256 仓库, N32 复审 P1-2)。 */
  baseHead: string;
  /** plan digest(sha256 64-hex; 重推导语义在上层)。 */
  planDigest: string;
  /** 创建时间(ISO 8601 可解析, ≤40 字符)。 */
  createdAt: string;
  /** 完整/实际变化 writeSet(0..MAX_TARGETS; 0 目标 = 纯 git 内部事务)。 */
  targets: IntentTargetEntry[];
  /**
   * state/checkpoint 的已提交 plan 来源(ADR-0021 §8 能力重推导): 恢复器必须以
   * `baseHead:<path>` 的已提交内容 digest 重推导比对, 失配/缺失 → 无能力不补交。
   * 只随 state/checkpoint 事务持久化(执行层保证); 其余 kind 携带 = 未知字段拒绝。
   */
  planSource?: { path: string; digest: string };
  /** run_bootstrap 自描述(§8): 新唯一 run 标识(恢复时重推导能力的一部分)。 */
  runId?: string;
  /** run_bootstrap 自描述(§8): self-describing input/config fingerprint(sha256 64-hex)。 */
  inputFingerprint?: string;
  /** run_bootstrap 自描述(§8): 新建 run 的机器状态文件路径(须 ∈ 机器 namespace allowlist)。 */
  runFile?: string;
}

/** 与 targets 一一对应的二进制字节集合(快照 + 计划输出)。 */
export interface IntentBlobSet {
  snapshots: Buffer[];
  outputs: Buffer[];
}

/** 已读取(且已重验)的 intent 及其二进制文件索引。 */
export interface LoadedIntent {
  txid: string;
  /** intent 目录绝对路径。 */
  dir: string;
  /** 规范化后的 intent 记录(字段顺序确定, 已过白名单)。 */
  record: IntentRecord;
  snapshots: Array<{ file: string; size: number }>;
  outputs: Array<{ file: string; size: number }>;
  /** 全部快照/输出字节之和(不含 intent.json)。 */
  totalBytes: number;
}

/** listIntents 的单条目诊断(不盲信: 不 READY/非法一律 valid=false + error)。 */
export interface IntentListingEntry {
  /** 命名空间下的原始条目名(目录)。 */
  name: string;
  /** 是否通过 txid 白名单(未通过者绝不自动清理)。 */
  validTxid: boolean;
  /** READY 就绪标记是否以普通文件存在。 */
  ready: boolean;
  /** 完整存储层验证(名称 + 布局 + intent.json schema/字段/大小 + blob 清单与大小)。 */
  valid: boolean;
  /** valid=false 时的原因(诊断用)。 */
  error?: string;
}

export type IntentBlobPart = 'snapshots' | 'outputs';

function limitsOf(opts?: IntentLimits): Required<IntentLimits> {
  return {
    maxIntentBytes: opts?.maxIntentBytes ?? INTENT_MAX_BYTES,
    maxBlobBytes: opts?.maxBlobBytes ?? BLOB_MAX_BYTES,
    maxTargets: opts?.maxTargets ?? MAX_TARGETS,
  };
}

/**
 * plain JSON 对象判词(与 codec.isPlainRecord 同语义, 本文件自包含不 import 并行层;
 * 审计/复审: intent 生产链拒 Proxy/accessor/class —— persistIntent 的 draft 与
 * validateIntentRecord 的输入都可能是注入面, 任何 getter 触发前必须先过此门)。
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (isProxy(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, key);
    if (desc !== undefined && (typeof desc.get === 'function' || typeof desc.set === 'function')) {
      return false;
    }
  }
  return true;
}

/** lstat 封装: 条目不存在返回 undefined; 其余异常(如路径穿过普通文件)一律吞为
 * undefined, 由各严格检查点(assertGitDir / nsDirChecked / 目录类型断言)独立兜底。 */
function lstatQuiet(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 路径与安全基元
// ---------------------------------------------------------------------------

/** `.git/novelcraft-transactions/` 绝对路径。 */
export function intentRoot(root: string): string {
  return path.join(path.resolve(root), '.git', TRANSACTION_NAMESPACE_DIR);
}

/** txid 白名单校验(一切路径拼接前), 返回原值。 */
export function validateTxid(txid: unknown): string {
  if (typeof txid !== 'string' || !TXID_PATTERN.test(txid)) {
    throw new IntentError('INTENT_INVALID_TXID', `非法 txid(白名单外): ${JSON.stringify(txid)}`);
  }
  return txid;
}

/** 单个 intent 目录绝对路径; txid 先经白名单校验再参与拼接(防穿越)。 */
export function intentDir(root: string, txid: string): string {
  return path.join(intentRoot(root), validateTxid(txid));
}

/** R9: `.git` 必须是真实目录(vault init 已拒绝 symlink/gitfile; 此处再兜底)。 */
function assertGitDir(root: string): void {
  const git = path.join(root, '.git');
  const st = lstatQuiet(git);
  if (st === undefined) {
    throw new IntentError('INTENT_NOT_REPO', `vault 根缺少 .git(非 git 仓库): ${root}`);
  }
  if (st.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `.git 是 symlink(fail-closed, R9): ${git}`);
  }
  if (!st.isDirectory()) {
    throw new IntentError('INTENT_NOT_REPO', `.git 不是目录(gitfile/未知条目, R9 拒绝): ${git}`);
  }
}

/** 逐段 symlink 检查(复用 vault assertNoSymlinkOnPath, 从不跟随); 转译为 IntentError。 */
function assertNoSymlink(root: string, p: string): void {
  try {
    assertNoSymlinkOnPath(root, p);
  } catch (err) {
    throw new IntentError(
      'INTENT_SYMLINK',
      `intent 路径含 symlink(fail-closed, ADR-0021 §8): ${(err as Error).message}`,
    );
  }
}

/** guardPath 双重 containment(R9), 转译非法/越界路径为 INTENT_TRAVERSAL。 */
function assertContained(root: string, relPath: string): string {
  try {
    return guardPath(root, relPath);
  } catch (err) {
    throw new IntentError(
      'INTENT_TRAVERSAL',
      `目标路径逃逸出 vault 或非法(绝对/../symlink 逃逸): ${JSON.stringify(relPath)}: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 耐久化基元(逐文件 fsync + 原子 rename + 父目录 fsync, ADR-0021 §8)
// ---------------------------------------------------------------------------

/** 目录 fsync(macOS/Linux 以只读打开目录即可使 rename/mkdir 元数据持久化);
 * 平台不支持目录 fsync(EINVAL/EBADF/EISDIR)时尽力而为, 其余失败 fail-closed。 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!(code === 'EINVAL' || code === 'EBADF' || code === 'EISDIR')) {
      throw new IntentError('INTENT_IO', `fsync 目录失败: ${dir}: ${(err as Error).message}`);
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 目录 fd close 失败无碍已完成的 fsync */
      }
    }
  }
}

/** 同目录 tmp 文件写入 + 文件 fsync + 原子 rename + 父目录 fsync(单文件耐久化)。 */
function writeFileDurable(file: string, data: Uint8Array): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'w');
  } catch (err) {
    throw new IntentError('INTENT_IO', `打开临时文件失败: ${file}: ${(err as Error).message}`);
  }
  try {
    let off = 0;
    while (off < data.length) {
      off += fs.writeSync(fd, data, off, data.length - off);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    throw new IntentError('INTENT_IO', `写入/fsync 临时文件失败: ${file}: ${(err as Error).message}`);
  } finally {
    fs.closeSync(fd);
  }
}

/** 原子 rename + 父目录 fsync。 */
function renameDurable(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
    fsyncDir(path.dirname(to));
  } catch (err) {
    throw new IntentError('INTENT_IO', `原子 rename 失败: ${from} → ${to}: ${(err as Error).message}`);
  }
}

/** 同目录 tmp 名(.tmp-<hex> 后缀, 崩溃残留可见可清理)。 */
function tmpNameFor(final: string): string {
  return `${final}.tmp-${crypto.randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// intent.json 记录级白名单校验(版本/字段/大小/path/txid; 不盲信原始内容)
// ---------------------------------------------------------------------------

const RECORD_FIELDS = new Set([
  'schema',
  'txid',
  'kind',
  'branch',
  'baseHead',
  'planDigest',
  'createdAt',
  'targets',
  'planSource',
  'runId',
  'inputFingerprint',
  'runFile',
]);
const TARGET_FIELDS = new Set([
  'path',
  'expected',
  'existed',
  'snapshotSha256',
  'outputSha256',
]);
const EXPECTED_FIELDS = new Set(['kind', 'sha256']);
const PLANSOURCE_FIELDS = new Set(['path', 'digest']);

/** runId 形态白名单: 非空 ≤128、无控制字符、无路径分隔符(仅标识, 不参与路径拼接)。 */
function isValidRunId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(v) &&
    !/[\\/]/.test(v)
  );
}

/** git ref 形态白名单(结构校验; ref 自身存在性/归属由上层事务层判定)。 */
function isValidBranch(b: unknown): boolean {
  return (
    typeof b === 'string' &&
    b.length > 0 &&
    b.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(b) &&
    !/\s/.test(b) &&
    !b.startsWith('-') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock') &&
    !b.includes('..') &&
    !b.includes('//') &&
    !b.includes('@{') &&
    !/[[~^:?*\\]/.test(b)
  );
}

function validatePathShape(rawPath: unknown): string {
  if (typeof rawPath !== 'string') {
    throw new IntentError('INTENT_INVALID_FIELD', 'target.path 必须是字符串');
  }
  if (rawPath.length === 0) {
    throw new IntentError('INTENT_TRAVERSAL', 'target.path 为空');
  }
  if (rawPath.length > INTENT_PATH_MAX) {
    throw new IntentError('INTENT_TOO_LARGE', `target.path 超长(> ${INTENT_PATH_MAX})`);
  }
  if (rawPath.includes('\\')) {
    throw new IntentError('INTENT_TRAVERSAL', `target.path 含反斜杠(非法 vault 相对路径): ${JSON.stringify(rawPath)}`);
  }
  if (rawPath.startsWith('/')) {
    throw new IntentError('INTENT_TRAVERSAL', `target.path 是绝对路径(fail-closed): ${JSON.stringify(rawPath)}`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rawPath)) {
    throw new IntentError('INTENT_TRAVERSAL', `target.path 含控制字符: ${JSON.stringify(rawPath)}`);
  }
  // 规范化白名单: 每段非空且非 '.'/'..'(拒绝 `..` 段、空段、`.` 段、尾斜杠)。
  for (const seg of rawPath.split('/')) {
    if (seg.length === 0 || seg === '.' || seg === '..') {
      throw new IntentError(
        'INTENT_TRAVERSAL',
        `target.path 含非法段(空段/./..): ${JSON.stringify(rawPath)}`,
      );
    }
  }
  return rawPath;
}

function validateTarget(t: unknown, index: number, vaultRoot?: string): IntentTargetEntry {
  if (!isPlainObject(t)) {
    throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}] 必须是对象`);
  }
  for (const key of Object.keys(t)) {
    if (!TARGET_FIELDS.has(key)) {
      throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}] 含未知字段: ${JSON.stringify(key)}`);
    }
  }
  const rawPath = validatePathShape(t.path);
  const normalizedPath = rawPath.replace(/\/+/g, '/'); // 无空段时等价于自身; 仅防御性归一
  if (vaultRoot !== undefined) {
    const abs = assertContained(vaultRoot, normalizedPath);
    assertNoSymlink(vaultRoot, abs); // 目标或父目录 symlink → fail-closed(ADR-0021 §8)
  }
  const expectedRaw = t.expected;
  if (!isPlainObject(expectedRaw)) {
    throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].expected 必须是对象`);
  }
  for (const key of Object.keys(expectedRaw)) {
    if (!EXPECTED_FIELDS.has(key)) {
      throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].expected 含未知字段: ${JSON.stringify(key)}`);
    }
  }
  let expected: IntentExpected;
  if (expectedRaw.kind === 'absent') {
    if (expectedRaw.sha256 !== undefined) {
      throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].expected absent 不得携带 sha256`);
    }
    expected = { kind: 'absent' };
  } else if (expectedRaw.kind === 'content') {
    if (typeof expectedRaw.sha256 !== 'string' || !SHA256_HEX.test(expectedRaw.sha256)) {
      throw new IntentError(
        'INTENT_INVALID_FIELD',
        `targets[${index}].expected.sha256 必须是 64 位 hex`,
      );
    }
    expected = { kind: 'content', sha256: expectedRaw.sha256 };
  } else {
    throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].expected.kind 未知: ${JSON.stringify(expectedRaw.kind)}`);
  }
  if (typeof t.existed !== 'boolean') {
    throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].existed 必须是布尔`);
  }
  const entry: IntentTargetEntry = { path: normalizedPath, expected, existed: t.existed };
  for (const hashKey of ['snapshotSha256', 'outputSha256'] as const) {
    const v = t[hashKey];
    if (v !== undefined) {
      if (typeof v !== 'string' || !SHA256_HEX.test(v)) {
        throw new IntentError('INTENT_INVALID_FIELD', `targets[${index}].${hashKey} 必须是 64 位 hex`);
      }
      entry[hashKey] = v;
    }
  }
  return entry;
}

/**
 * intent 记录白名单重验(N32 / ADR-0021 §8「先验证, 后动作」): 版本/字段/大小/txid/
 * path/symlink 全量校验, 返回**重建**的规范化记录(字段顺序固定、类型确定)。
 * - opts.vaultRoot 提供时, 对每个目标路径做 vault 内 containment(R9)与 symlink 检查;
 * - opts.expectedTxid 提供时, 校验 record.txid 与意图目录名一致(读路径)。
 */
export function validateIntentRecord(
  record: unknown,
  opts?: { vaultRoot?: string; expectedTxid?: string },
): IntentRecord {
  if (!isPlainObject(record)) {
    throw new IntentError('INTENT_INVALID_FIELD', 'intent 顶层必须是对象');
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.has(key)) {
      throw new IntentError('INTENT_INVALID_FIELD', `intent.json 含未知顶层字段: ${JSON.stringify(key)}`);
    }
  }
  if (typeof record.schema !== 'number' || !KNOWN_SCHEMA_VERSIONS.includes(record.schema)) {
    throw new IntentError('INTENT_INVALID_SCHEMA', `未知 schema 版本: ${JSON.stringify(record.schema)}`);
  }
  const txid = validateTxid(record.txid);
  if (opts?.expectedTxid !== undefined && txid !== opts.expectedTxid) {
    throw new IntentError(
      'INTENT_INVALID_FIELD',
      `record.txid 与 intent 目录名不一致: record=${txid}, 目录=${opts.expectedTxid}`,
    );
  }
  if (typeof record.kind !== 'string' || !INTENT_KIND_PATTERN.test(record.kind)) {
    throw new IntentError(
      'INTENT_INVALID_FIELD',
      `intent.kind 非法(白名单 ${INTENT_KIND_PATTERN.source}): ${JSON.stringify(record.kind)}`,
    );
  }
  if (record.branch !== undefined && !isValidBranch(record.branch)) {
    throw new IntentError('INTENT_INVALID_FIELD', `intent.branch 非法(git ref 形态): ${JSON.stringify(record.branch)}`);
  }
  if (typeof record.baseHead !== 'string' || !GIT_OID_HEX.test(record.baseHead)) {
    throw new IntentError('INTENT_INVALID_FIELD', `intent.baseHead 必须是 40/64 位 hex(sha1/sha256 仓库): ${JSON.stringify(record.baseHead)}`);
  }
  if (typeof record.planDigest !== 'string' || !SHA256_HEX.test(record.planDigest)) {
    throw new IntentError('INTENT_INVALID_FIELD', `intent.planDigest 必须是 64 位 hex: ${JSON.stringify(record.planDigest)}`);
  }
  const createdAt = record.createdAt;
  if (
    typeof createdAt !== 'string' ||
    createdAt.length === 0 ||
    createdAt.length > 40 ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new IntentError('INTENT_INVALID_FIELD', `intent.createdAt 必须是可解析的 ISO 时间(≤40): ${JSON.stringify(createdAt)}`);
  }
  if (!Array.isArray(record.targets)) {
    throw new IntentError('INTENT_INVALID_FIELD', 'intent.targets 必须是数组');
  }
  if (record.targets.length > MAX_TARGETS) {
    throw new IntentError('INTENT_TOO_LARGE', `writeSet 目标数超限(> ${MAX_TARGETS})`);
  }
  const targets = record.targets.map((t, i) => validateTarget(t, i, opts?.vaultRoot));
  const out: IntentRecord = {
    schema: INTENT_SCHEMA_VERSION,
    txid,
    kind: record.kind,
    baseHead: record.baseHead,
    planDigest: record.planDigest,
    createdAt,
    targets,
  };
  if (record.branch !== undefined) out.branch = String(record.branch);
  // state/checkpoint 的已提交 plan 来源(§8 能力重推导): 结构白名单 + 相对路径形状
  // + vault containment/symlink; digest 必须 64-hex。缺失 = 旧形态/无能力, 语义判定
  // (不补交)在上层恢复器。
  if (record.planSource !== undefined) {
    if (!isPlainObject(record.planSource)) {
      throw new IntentError('INTENT_INVALID_FIELD', 'intent.planSource 必须是对象');
    }
    for (const key of Object.keys(record.planSource)) {
      if (!PLANSOURCE_FIELDS.has(key)) {
        throw new IntentError('INTENT_INVALID_FIELD', `intent.planSource 含未知字段: ${JSON.stringify(key)}`);
      }
    }
    if (typeof record.planSource.path !== 'string' || typeof record.planSource.digest !== 'string') {
      throw new IntentError('INTENT_INVALID_FIELD', 'intent.planSource.path/digest 必须是字符串');
    }
    const planPath = validatePathShape(record.planSource.path);
    if (opts?.vaultRoot !== undefined) {
      const planAbs = assertContained(opts.vaultRoot, planPath);
      assertNoSymlink(opts.vaultRoot, planAbs); // 目标或父目录 symlink → fail-closed(ADR-0021 §8)
    }
    if (!SHA256_HEX.test(record.planSource.digest)) {
      throw new IntentError('INTENT_INVALID_FIELD', `intent.planSource.digest 必须是 64 位 hex: ${JSON.stringify(record.planSource.digest)}`);
    }
    out.planSource = { path: planPath, digest: record.planSource.digest };
  }
  // run_bootstrap 自描述(§8): runId 标识白名单; inputFingerprint 64-hex; runFile 相对
  // 路径形状 + vault containment/symlink。
  if (record.runId !== undefined) {
    if (!isValidRunId(record.runId)) {
      throw new IntentError('INTENT_INVALID_FIELD', `intent.runId 非法(非空 ≤128 无控制字符/分隔符): ${JSON.stringify(record.runId)}`);
    }
    out.runId = record.runId;
  }
  if (record.inputFingerprint !== undefined) {
    if (typeof record.inputFingerprint !== 'string' || !SHA256_HEX.test(record.inputFingerprint)) {
      throw new IntentError('INTENT_INVALID_FIELD', `intent.inputFingerprint 必须是 64 位 hex: ${JSON.stringify(record.inputFingerprint)}`);
    }
    out.inputFingerprint = record.inputFingerprint;
  }
  if (record.runFile !== undefined) {
    if (typeof record.runFile !== 'string') {
      throw new IntentError('INTENT_INVALID_FIELD', 'intent.runFile 必须是字符串');
    }
    const runPath = validatePathShape(record.runFile);
    if (opts?.vaultRoot !== undefined) {
      const runAbs = assertContained(opts.vaultRoot, runPath);
      assertNoSymlink(opts.vaultRoot, runAbs);
    }
    out.runFile = runPath;
  }
  return out;
}

// ---------------------------------------------------------------------------
// persist: 写前耐久化(ADR-0021 §8)——首个工作树/index 变更之前必须完成的落盘
// ---------------------------------------------------------------------------

function assertBlobSet(blobs: unknown): blobs is IntentBlobSet {
  return (
    isPlainObject(blobs) &&
    Array.isArray(blobs.snapshots) &&
    Array.isArray(blobs.outputs) &&
    blobs.snapshots.every((b) => b instanceof Uint8Array) &&
    blobs.outputs.every((b) => b instanceof Uint8Array)
  );
}

/**
 * 持久、原子地写入 transaction intent(ADR-0021 §8「写前耐久化」)。
 *
 * - 目录不存在才写; 同一 txid 已存在(READY 或半写残留)一律 INTENT_EXISTS(不覆盖、
 *   不隐式删除——半写残留由 `cleanupIncomplete`/恢复路径先收敛);
 * - 逐文件 tmp + fsync + 原子 rename + 父目录 fsync; READY 最后 rename 为提交点;
 * - 全部校验(版本/字段/大小/path/symlink/txid)通过后才触碰文件系统(任一失败 =
 *   零 intent 副作用: 本函数自建的临时目录会被清理后重抛);
 * - snapshotSha256/outputSha256 以实际字节计算写入落盘 record; 调用方自带值不符则
 *   fail-closed(INTENT_BAD_CONTENT)。
 *
 * @returns 已持久化的 txid。
 */
export function persistIntent(
  vaultRoot: string,
  draft: IntentRecord,
  blobs: IntentBlobSet,
  opts?: IntentLimits,
): string {
  const limits = limitsOf(opts);
  const root = path.resolve(vaultRoot);
  assertGitDir(root);
  // 记录白名单(N32: 先验证, 后动作)。
  const record = validateIntentRecord(draft, { vaultRoot: root });
  if (record.targets.length > limits.maxTargets) {
    throw new IntentError('INTENT_TOO_LARGE', `writeSet 目标数超限(上限 ${limits.maxTargets})`);
  }
  if (!assertBlobSet(blobs)) {
    throw new IntentError('INTENT_INVALID_FIELD', 'blobs 必须是 { snapshots: Buffer[], outputs: Buffer[] }');
  }
  if (blobs.snapshots.length !== record.targets.length || blobs.outputs.length !== record.targets.length) {
    throw new IntentError(
      'INTENT_INVALID_FIELD',
      `blobs 数量必须与 targets 对齐: targets=${record.targets.length}, snapshots=${blobs.snapshots.length}, outputs=${blobs.outputs.length}`,
    );
  }
  for (let i = 0; i < record.targets.length; i += 1) {
    if (blobs.snapshots[i].length > limits.maxBlobBytes || blobs.outputs[i].length > limits.maxBlobBytes) {
      throw new IntentError('INTENT_TOO_LARGE', `快照/输出字节超限(上限 ${limits.maxBlobBytes})`);
    }
  }
  // 内容哈希: 以实际字节计算(篡改/损坏可被 read 侧逐字节核对); 自带值核对。
  const targets = record.targets.map((t, i) => {
    const snapshotSha256 = sha256Hex(blobs.snapshots[i]);
    const outputSha256 = sha256Hex(blobs.outputs[i]);
    if (t.snapshotSha256 !== undefined && t.snapshotSha256 !== snapshotSha256) {
      throw new IntentError('INTENT_BAD_CONTENT', `targets[${i}] 自带 snapshotSha256 与实际字节不符`);
    }
    if (t.outputSha256 !== undefined && t.outputSha256 !== outputSha256) {
      throw new IntentError('INTENT_BAD_CONTENT', `targets[${i}] 自带 outputSha256 与实际字节不符`);
    }
    return { ...t, snapshotSha256, outputSha256 };
  });
  const stored: IntentRecord = { ...record, targets };
  const json = JSON.stringify(stored);
  if (Buffer.byteLength(json, 'utf8') > limits.maxIntentBytes) {
    throw new IntentError('INTENT_TOO_LARGE', `intent.json 超限(上限 ${limits.maxIntentBytes} 字节)`);
  }

  const txDir = intentDir(root, stored.txid);
  const ns = intentRoot(root);
  const txDirSt = lstatQuiet(txDir);
  if (txDirSt !== undefined) {
    if (txDirSt.isSymbolicLink()) {
      throw new IntentError('INTENT_SYMLINK', `intent 目录是 symlink(拒绝写入): ${txDir}`);
    }
    if (!txDirSt.isDirectory()) {
      throw new IntentError('INTENT_BAD_LAYOUT', `intent 路径存在但不是目录: ${txDir}`);
    }
    throw new IntentError(
      'INTENT_EXISTS',
      `事务 intent 已存在(READY 或半写残留, fail-closed 不覆盖): ${stored.txid}`,
    );
  }
  assertNoSymlink(root, txDir); // 父目录链 symlink 先验(.git / novelcraft-transactions)

  try {
    fs.mkdirSync(ns, { recursive: true });
    fsyncDir(path.join(root, '.git'));
    fsyncDir(ns);
    fs.mkdirSync(txDir);
    fsyncDir(ns);
    const snapsDir = path.join(txDir, SNAPSHOTS_DIR);
    const outsDir = path.join(txDir, OUTPUTS_DIR);
    fs.mkdirSync(snapsDir);
    fs.mkdirSync(outsDir);
    fsyncDir(txDir);
    assertNoSymlink(root, txDir); // 建目录后复验(防御性)

    for (let i = 0; i < targets.length; i += 1) {
      const snapFinal = path.join(snapsDir, `${i}.bin`);
      const snapTmp = tmpNameFor(snapFinal);
      writeFileDurable(snapTmp, blobs.snapshots[i]);
      renameDurable(snapTmp, snapFinal);

      const outFinal = path.join(outsDir, `${i}.bin`);
      const outTmp = tmpNameFor(outFinal);
      writeFileDurable(outTmp, blobs.outputs[i]);
      renameDurable(outTmp, outFinal);
    }

    const intentFinal = path.join(txDir, INTENT_FILE);
    const intentTmp = tmpNameFor(intentFinal);
    writeFileDurable(intentTmp, Buffer.from(json, 'utf8'));
    renameDurable(intentTmp, intentFinal);

    // READY 最后 rename = 崩溃点提交标记(N32: 缺 READY = 半写残留, 恢复时忽略并清理)。
    const readyFinal = path.join(txDir, READY_FILE);
    const readyTmp = tmpNameFor(readyFinal);
    writeFileDurable(readyTmp, Buffer.alloc(0));
    renameDurable(readyTmp, readyFinal);
  } catch (err) {
    // 本函数自建的目录(首字节前已挡掉既有 intent)且尚无 READY: 尽力清理临时残留,
    // 保持命名空间干净; 清理失败也不掩盖原错误(cleanupIncomplete 可兜底)。
    try {
      fs.rmSync(txDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    throw err;
  }
  return stored.txid;
}

// ---------------------------------------------------------------------------
// read / list / remove / cleanup(不盲信内容: 全部先重验后动作)
// ---------------------------------------------------------------------------

/** 命名空间目录存在性 + 类型 + symlink 校验; 未建立返回 undefined。 */
function nsDirChecked(root: string): string | undefined {
  const ns = intentRoot(root);
  const st = lstatQuiet(ns);
  if (st === undefined) return undefined;
  if (st.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `intent 根是 symlink(fail-closed): ${ns}`);
  }
  if (!st.isDirectory()) {
    throw new IntentError('INTENT_BAD_LAYOUT', `intent 根不是目录(fail-closed): ${ns}`);
  }
  assertNoSymlink(root, ns);
  return ns;
}

/** 校验单个 blob 目录(snapshots/outputs): 目录类型 + symlink + 名称全集 + 大小。 */
function scanBlobDir(
  txDir: string,
  subdir: 'snapshots' | 'outputs',
  count: number,
  maxBlobBytes: number,
): Array<{ file: string; size: number }> {
  const dir = path.join(txDir, subdir);
  const st = lstatQuiet(dir);
  if (st === undefined) {
    throw new IntentError('INTENT_BAD_LAYOUT', `intent 缺 ${subdir}/ 目录: ${dir}`);
  }
  if (st.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `${subdir}/ 是 symlink(fail-closed): ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new IntentError('INTENT_BAD_LAYOUT', `${subdir}/ 不是目录: ${dir}`);
  }
  const names = fs.readdirSync(dir);
  if (names.length !== count) {
    throw new IntentError(
      'INTENT_BAD_LAYOUT',
      `${subdir}/ 文件数与 targets 不一致: 期望 ${count}, 实际 ${names.length}`,
    );
  }
  const out: Array<{ file: string; size: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${i}.bin`;
    if (!names.includes(name)) {
      throw new IntentError('INTENT_BAD_LAYOUT', `${subdir}/ 缺 ${name}(或含白名单外文件)`);
    }
    const f = path.join(dir, name);
    const fst = lstatQuiet(f);
    if (fst === undefined) {
      throw new IntentError('INTENT_BAD_LAYOUT', `${subdir}/${name} 不存在`);
    }
    if (fst.isSymbolicLink()) {
      throw new IntentError('INTENT_SYMLINK', `${subdir}/${name} 是 symlink(fail-closed): ${f}`);
    }
    if (!fst.isFile()) {
      throw new IntentError('INTENT_BAD_LAYOUT', `${subdir}/${name} 不是普通文件`);
    }
    if (fst.size > maxBlobBytes) {
      throw new IntentError('INTENT_TOO_LARGE', `${subdir}/${name} 超限(上限 ${maxBlobBytes} 字节)`);
    }
    out.push({ file: f, size: fst.size });
  }
  return out;
}

/**
 * 读取并重验 intent(ADR-0021 §8「恢复验证」)。返回**规范化后**的 record 与二进制
 * 文件索引(不读取 blob 内容; 内容逐字节核验见 `readIntentBlob`/`verifyIntentBlobs`)。
 * 任何一步不符(缺 READY / 布局 / schema / 字段 / 大小 / 穿越 / symlink / txid 不一致)
 * 一律 fail-closed 抛 IntentError, 绝不返回半验数据。
 */
export function readIntent(vaultRoot: string, txid: string, opts?: IntentLimits): LoadedIntent {
  const limits = limitsOf(opts);
  const root = path.resolve(vaultRoot);
  assertGitDir(root);
  const txDir = intentDir(root, txid); // txid 白名单先验
  assertNoSymlink(root, txDir);
  nsDirChecked(root);

  const txDirSt = lstatQuiet(txDir);
  if (txDirSt === undefined) {
    throw new IntentError('INTENT_NOT_FOUND', `未见事务 intent: ${txid}`);
  }
  if (txDirSt.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `intent 目录是 symlink(fail-closed): ${txDir}`);
  }
  if (!txDirSt.isDirectory()) {
    throw new IntentError('INTENT_BAD_LAYOUT', `intent 路径不是目录: ${txDir}`);
  }

  // 布局白名单: 只允许 intent.json / READY / snapshots / outputs(其余一律不盲信)。
  const entries = fs.readdirSync(txDir);
  const allowed = new Set([INTENT_FILE, READY_FILE, SNAPSHOTS_DIR, OUTPUTS_DIR]);
  for (const name of entries) {
    if (!allowed.has(name)) {
      throw new IntentError('INTENT_BAD_LAYOUT', `intent 目录含白名单外条目: ${JSON.stringify(name)}`);
    }
  }

  const readySt = lstatQuiet(path.join(txDir, READY_FILE));
  if (readySt === undefined) {
    throw new IntentError('INTENT_NOT_READY', `intent 无 READY(半写/中断, 先 cleanupIncomplete): ${txid}`);
  }
  if (readySt.isSymbolicLink() || !readySt.isFile()) {
    throw new IntentError('INTENT_SYMLINK', `READY 不是普通文件(fail-closed): ${path.join(txDir, READY_FILE)}`);
  }

  const intentSt = lstatQuiet(path.join(txDir, INTENT_FILE));
  if (intentSt === undefined) {
    throw new IntentError('INTENT_BAD_LAYOUT', `intent 缺 ${INTENT_FILE}`);
  }
  if (intentSt.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `intent.json 是 symlink(fail-closed)`);
  }
  if (!intentSt.isFile()) {
    throw new IntentError('INTENT_BAD_LAYOUT', 'intent.json 不是普通文件');
  }
  if (intentSt.size > limits.maxIntentBytes) {
    throw new IntentError('INTENT_TOO_LARGE', `intent.json 超限(上限 ${limits.maxIntentBytes} 字节)`);
  }

  let jsonBytes: Buffer;
  try {
    jsonBytes = fs.readFileSync(path.join(txDir, INTENT_FILE));
  } catch (err) {
    throw new IntentError('INTENT_IO', `读取 intent.json 失败: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBytes.toString('utf8'));
  } catch {
    throw new IntentError('INTENT_BAD_CONTENT', 'intent.json 不是合法 JSON');
  }
  const record = validateIntentRecord(parsed, { vaultRoot: root, expectedTxid: txid });

  const snapshots = scanBlobDir(txDir, 'snapshots', record.targets.length, limits.maxBlobBytes);
  const outputs = scanBlobDir(txDir, 'outputs', record.targets.length, limits.maxBlobBytes);
  const totalBytes =
    snapshots.reduce((s, e) => s + e.size, 0) + outputs.reduce((s, e) => s + e.size, 0);
  return { txid, dir: txDir, record, snapshots, outputs, totalBytes };
}

/** 读取并逐字节核验单个快照/输出 blob(哈希不符 = INTENT_BAD_CONTENT)。 */
export function readIntentBlob(
  vaultRoot: string,
  txid: string,
  part: IntentBlobPart,
  index: number,
  opts?: IntentLimits,
): Buffer {
  const limits = limitsOf(opts);
  if (!Number.isInteger(index) || index < 0) {
    throw new IntentError('INTENT_BAD_LAYOUT', `blob 下标非法: ${part}[${index}]`);
  }
  const loaded = readIntent(vaultRoot, txid, opts);
  const list = part === 'snapshots' ? loaded.snapshots : loaded.outputs;
  if (index >= list.length) {
    throw new IntentError('INTENT_BAD_LAYOUT', `blob 下标越界: ${part}[${index}]`);
  }
  const entry = list[index];
  const expected =
    part === 'snapshots'
      ? loaded.record.targets[index].snapshotSha256
      : loaded.record.targets[index].outputSha256;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(entry.file);
  } catch (err) {
    throw new IntentError('INTENT_IO', `读取 ${part}/${index}.bin 失败: ${(err as Error).message}`);
  }
  if (buf.length > limits.maxBlobBytes) {
    throw new IntentError('INTENT_TOO_LARGE', `${part}/${index}.bin 超限(上限 ${limits.maxBlobBytes} 字节)`);
  }
  if (sha256Hex(buf) !== expected) {
    throw new IntentError(
      'INTENT_BAD_CONTENT',
      `${part}/${index}.bin 内容哈希不符(篡改/损坏, 不盲信): ${entry.file}`,
    );
  }
  return buf;
}

/**
 * 全量核验一个 READY intent 的快照/输出字节(与 record 内哈希比对)。
 * @returns true = 全部一致; false = 至少一个 blob 哈希不符(篡改/损坏);
 *          仍会以 IntentError 报告布局/schema/未就绪等结构性问题(不吞错)。
 */
export function verifyIntentBlobs(vaultRoot: string, txid: string, opts?: IntentLimits): boolean {
  const loaded = readIntent(vaultRoot, txid, opts);
  for (let i = 0; i < loaded.record.targets.length; i += 1) {
    try {
      readIntentBlob(vaultRoot, txid, 'snapshots', i, opts);
      readIntentBlob(vaultRoot, txid, 'outputs', i, opts);
    } catch (err) {
      if (err instanceof IntentError && err.code === 'INTENT_BAD_CONTENT') return false;
      throw err;
    }
  }
  return true;
}

/**
 * 列举 intent 命名空间下的全部条目(仅目录名目录), **逐个独立验证**, 不因单个坏条目
 * 抛错: valid=false + error 给出原因(诊断/恢复入口判定用)。命名空间本身
 * symlink/非目录或 `.git` 非法时 fail-closed 抛错(不盲信容器)。
 */
export function listIntents(vaultRoot: string): IntentListingEntry[] {
  const root = path.resolve(vaultRoot);
  // `.git` 缺失 = 非仓库, 无 intent 命名空间(返回空); `.git` 非法(symlink/gitfile)
  // 一律 fail-closed, 不盲信容器。
  const gitSt = lstatQuiet(path.join(root, '.git'));
  if (gitSt === undefined) return [];
  if (gitSt.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `.git 是 symlink(fail-closed): ${path.join(root, '.git')}`);
  }
  if (!gitSt.isDirectory()) {
    throw new IntentError('INTENT_NOT_REPO', `.git 不是目录(gitfile/未知条目, R9 拒绝): ${path.join(root, '.git')}`);
  }
  const ns = nsDirChecked(root);
  if (ns === undefined) return [];

  const names = fs.readdirSync(ns).sort();
  const out: IntentListingEntry[] = [];
  for (const name of names) {
    const base = { name };
    if (!TXID_PATTERN.test(name)) {
      out.push({
        ...base,
        validTxid: false,
        ready: false,
        valid: false,
        error: '非法 txid 名(白名单外; 不识别、不自动清理)',
      });
      continue;
    }
    const dir = path.join(ns, name);
    const st = lstatQuiet(dir);
    if (st === undefined) {
      out.push({
        ...base,
        validTxid: true,
        ready: false,
        valid: false,
        error: '条目不存在',
      });
      continue;
    }
    // symlink 必须先于目录判型(lstat: symlink 不是目录, 顺序颠倒会使该分支不可达)。
    if (st.isSymbolicLink()) {
      out.push({
        ...base,
        validTxid: true,
        ready: false,
        valid: false,
        error: 'intent 目录是 symlink(fail-closed, 不跟随)',
      });
      continue;
    }
    if (!st.isDirectory()) {
      out.push({
        ...base,
        validTxid: true,
        ready: false,
        valid: false,
        error: 'intent 条目不是目录',
      });
      continue;
    }
    const readySt = lstatQuiet(path.join(dir, READY_FILE));
    let ready = false;
    if (readySt !== undefined) {
      if (readySt.isSymbolicLink() || !readySt.isFile()) {
        out.push({
          ...base,
          validTxid: true,
          ready: false,
          valid: false,
          error: 'READY 不是普通文件(不盲信)',
        });
        continue;
      }
      ready = true;
    }
    if (!ready) {
      out.push({
        ...base,
        validTxid: true,
        ready: false,
        valid: false,
        error: '无 READY(半写/中断 intent, 可 cleanupIncomplete)',
      });
      continue;
    }
    try {
      readIntent(root, name);
      out.push({ ...base, validTxid: true, ready: true, valid: true });
    } catch (err) {
      out.push({
        ...base,
        validTxid: true,
        ready: true,
        valid: false,
        error: err instanceof IntentError ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * 清理半写残留(ADR-0021 §8: 无就绪标记 = 崩溃于 intent 写入之中, 恢复时忽略并清理,
 * 该事务视为未开始)。只删「txid 白名单内 + 非 READY」的目录; 白名单外条目、symlink、
 * 已 READY intent 一律不碰(不盲信、不隐式删除他人条目)。返回被清理的 txid。
 */
export function cleanupIncomplete(vaultRoot: string): string[] {
  const root = path.resolve(vaultRoot);
  const ns = nsDirChecked(root);
  if (ns === undefined) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(ns).sort()) {
    if (!TXID_PATTERN.test(name)) continue;
    const dir = path.join(ns, name);
    const st = lstatQuiet(dir);
    if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) continue; // 不盲信
    const readySt = lstatQuiet(path.join(dir, READY_FILE));
    const ready = readySt !== undefined && !readySt.isSymbolicLink() && readySt.isFile();
    if (ready) continue; // 已就绪 intent: 不清理
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length > 0) fsyncDir(ns);
  return removed;
}

/**
 * 删除一个 intent 目录(幂等: 不存在返回 false)。txid 白名单先验, 路径链 symlink/
 * 非目录 fail-closed —— 绝不跟随/删除链接指向的内容(不盲信)。
 */
export function removeIntent(vaultRoot: string, txid: string): boolean {
  const root = path.resolve(vaultRoot);
  const dir = intentDir(root, txid); // txid 白名单先验
  assertNoSymlink(root, dir);
  nsDirChecked(root);
  const st = lstatQuiet(dir);
  if (st === undefined) return false;
  if (st.isSymbolicLink()) {
    throw new IntentError('INTENT_SYMLINK', `拒绝删除 symlink intent(fail-closed): ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new IntentError('INTENT_BAD_LAYOUT', `intent 条目不是目录: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fsyncDir(intentRoot(root));
  return true;
}

/** intent 目录是否存在(仅存在性; READY 状态见 isIntentReady)。 */
export function hasIntent(vaultRoot: string, txid: string): boolean {
  return lstatQuiet(intentDir(vaultRoot, txid)) !== undefined;
}

/** READY 就绪标记是否以普通文件存在(读/恢复前判定, 不触发完整重验)。 */
export function isIntentReady(vaultRoot: string, txid: string): boolean {
  const st = lstatQuiet(path.join(intentDir(vaultRoot, txid), READY_FILE));
  return st !== undefined && !st.isSymbolicLink() && st.isFile();
}
