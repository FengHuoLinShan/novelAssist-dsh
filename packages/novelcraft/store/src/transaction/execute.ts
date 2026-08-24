// ADR-0021 Vault 目标路径级 Git 写事务 —— 执行器(N32, 兑现 implementation pending;
// N32 最终复审 P1 加固: 纯字节计划推导先于 intent、commit 复用 git-transaction 原语、
// 共享 index 安装 TOCTOU 闭环)。
//
// 统一多目标一致提交事务(ADR-0021 §1–§8): 目标路径级隔离(writeSet 外无关
// unstaged/untracked 允许存在)、expected state 是内容 CAS 唯一基线(§1/§4)、整个
// index 任何预存 staged 一律 fail-closed(§2)、跨进程 per-vault 锁(§3, lock.ts)、
// 全量 preflight 通过后才首写 + 首写前耐久化 transaction intent(§4/§8, intent.ts)、
// 同目录 temp+rename 逐目标写 + 每目标写前复核(§5)、事务私有 index + exact tree +
// commit-tree + update-ref CAS(§6)、提交前复核点重 hash 全 writeSet + 复核
// ref/tree/plan digest(§6 ⑪)、共享 index 受控原子安装(§6)、失败/崩溃状态矩阵
// BEFORE/OUTPUT/CONFLICT 与 BASE/OUTPUT/CONFLICT(§7)、崩溃恢复入口(§8)。
// 进程内异常与进程崩溃共用 §7 矩阵(崩溃由 recoverInterruptedTransactions 收敛)。
//
// N32 最终复审 P1-1(intent 先于一切 ODB/index/worktree/ref 副作用): plan identity
// 先用 derivePlanIdentityPure(纯字节 sha/树重建, 只读 base tree, 零副作用)推导并
// 随 intent 持久化; intent READY 之后才 materialize(commitTransaction 私有 index/
// hash-object -w), 并由 commitTransaction 的 expect 计划门(PLAN_MISMATCH)钉死
// 纯推导与物化一致。
//
// N32 最终复审 P1-2(生产路径复用已加固 git-transaction 安全原语, 不旁路): 本文件
// 一切 git 访问复用其 buildEnv(最小 allowlist, 清全部 GIT_* 重定向/配置注入)与
// pinArgs(钉固 --git-dir/--work-tree/禁 replace/optional locks), 仓库发现走
// resolveRepoContext(sha1+sha256 object format), 提交/恢复的 commit 阶段统一走
// commitTransaction/commitTransactionAsync(私有 exact tree/commit-tree/update-ref
// CAS/shared index 状态门/工作树期望状态重验), 恢复验证走 findTxCommit。
//
// N32 最终复审 P1-3(共享 index 安装消除 check→lock TOCTOU): installSharedIndex
// 获取 index.lock 后复核共享 index 的 identity/bytes(dev/ino/size/sha256 快照)与
// tree CAS(只读 diff 复核仍 ∈ {BASE, OUTPUT}), 事务期间作者 `git add` 一律不覆盖;
// update-ref 前 staged 重验由 commitTransaction(assertSharedIndexClean)承担, 安装前
// staged 重验由本文件 installSharedIndex 承担。
//
// N32 最终复审 P2(state/checkpoint 删除补完): completeStateTransaction 对崩溃后仍为
// BEFORE 的**删除**目标执行受保护删除(removeWorktreeFile, 与 applyOutputs 共用同一
// temp+rename 原子摘除 helper), 否则补完复核恒 CAS_CONFLICT 且 intent 被永久保留。
// 只对 classifyWorktreeTarget 判定 BEFORE 的目标动作, CONFLICT(外部编辑)不动; 路径/
// 哈希/CAS/symlink/锁安全同正常写面(见 §8 补完 + completeStateTransaction 文档)。
//
// 零 DSH 依赖、零 LLM(铁律 1: 核心包零 DSH)。ApprovalGate 由 dsh 调用方在纯核心
// 事务外取得(铁律 3); 审批后进入事务仍重新 preflight/CAS(§4)。业务写面禁用
// `git add`/`git commit`(N32; 本文件与 git-transaction.ts 以 git plumbing 完成)。
//
// 并行组合契约(接缝):
//   - types.ts / codec.ts : 事务域类型与输入归一(路径/ref/hash 白名单, StoreError TX_*);
//   - lock.ts             : 跨进程 per-vault 写锁(acquireVaultWriteLock, async);
//   - intent.ts           : intent 持久化/读取/验证/清理(READY 就绪标记; 快照/输出
//                           字节落 snapshots/<i>.bin + outputs/<i>.bin);
//   - git-transaction.ts  : resolveRepoContext / assertSafeRepoState / commitTransaction
//                           (async 变体带 crash gate 钩子)/ findTxCommit /
//                           buildHeadIndexBytes / derivePlanIdentityPure
//                           (可达历史唯一 tx commit 严格验证 + 新 HEAD index bytes);
//   - 本文件(执行面)      : 编排以上原语 + 工作树写/状态矩阵/复核点/恢复收敛;
//   - recovery.ts         : 独立恢复调用面(thin wrapper)。
//
// commit 生成统一在 git-transaction.ts(§6): message 走 buildTxCommitMessage(subject +
// txid/kind/plan-digest trailers), author/committer 固定 novelcraft 身份 + 确定性
// 日期 NOVELCRAFT_TX_DATE, commit-tree 禁 gpgsign 并钉 i18n.commitEncoding——其
// findTxCommit 以 computeExpectedTxCommitOid 的字节级 OID 作唯一接受门, 外部同字节
// 之外的任何差异都不被误认(§6/⑧)。
//
// 进程集成驱动(runTransactionProcess / recoverTransactionProcess)遵循
// test/fixtures/transaction-worker.mjs 的 READY/gate 协议(逐行 JSON 事件; 测试在
// 各崩溃点 SIGKILL 本进程, 由全新 recover 进程收敛)。锁协议统一: 全仓仅
// lock.ts 一把 per-vault 锁(集成要求; 无第二锁协议)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { sha256Hex } from '../hash.js';
import { parsePorcelainV1Z } from '../git.js';
import { acquireVaultWriteLock, type VaultLock } from './lock.js';
import {
  persistIntent,
  readIntent,
  readIntentBlob,
  verifyIntentBlobs,
  listIntents,
  cleanupIncomplete,
  removeIntent,
  INTENT_SCHEMA_VERSION,
  type IntentRecord,
  type IntentBlobSet,
  type IntentTargetEntry,
} from './intent.js';
import {
  // N32 复审 P1-2: 生产 execute/recovery 复用 git-transaction 加固原语(同一 env
  // 清理/钉固/object format/provenance/shared index 门/CAS 分类), 不旁路。
  resolveRepoContext,
  assertSafeRepoState,
  buildEnv as buildSafeEnv,
  pinArgs,
  isOid as isGitOid,
  computePlanDigest,
  derivePlanIdentityPure,
  commitTransaction,
  commitTransactionAsync,
  findTxCommit,
  buildHeadIndexBytes,
  GitTransactionError,
  type RepoContext,
  type TxCommitIdentity,
  type TxFileMode,
  type CommitTxnParams,
  type CommitTxnResult,
} from './git-transaction.js';
import { normalizeRelPath, normalizeSha256, isTransactionKind, isTxId, requirePlainRecord, assertNoUnknownFields } from './codec.js';
import { StoreError } from '../errors.js';

// 供 recovery.ts / 调用方引用的并行模块类型透传。
export type { VaultLock } from './lock.js';
export type { IntentRecord, IntentBlobSet, IntentTargetEntry } from './intent.js';

// ============================================================================
// 错误面(执行层错误码: N32 裁定词表 STALE_BASELINE/CAS_CONFLICT/STAGED_CONFLICT +
// 集成约定 LOCK_BUSY/PENDING_INTENTS/EXTERNAL_REF_RACE/ABORTED)
// ============================================================================

export type TxErrorCode =
  | 'NOT_GIT_REPO'
  | 'LOCK_BUSY'
  | 'PENDING_INTENTS'
  | 'STAGED_CONFLICT'
  | 'UNKNOWN_GIT_LOCK'
  | 'STALE_BASELINE'
  | 'CAS_CONFLICT'
  | 'REF_CAS_CONFLICT'
  | 'SHARED_INDEX_CONFLICT'
  | 'EXTERNAL_REF_RACE'
  | 'INVALID_REQUEST'
  | 'INVALID_INTENT'
  | 'ABORTED'
  | 'GIT_ERROR'
  | 'INTERNAL_FAULT';

export class TransactionError extends Error {
  readonly code: TxErrorCode;
  readonly details?: unknown;

  constructor(code: TxErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.details = details;
  }
}

/** 模拟 SIGKILL/断电的内部故障: catch 时**不执行任何收尾**(无回滚/无锁释放/无清理)。 */
export class CrashSimulatedError extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`[crash-simulated] ${point}`);
    this.name = 'CrashSimulatedError';
    this.point = point;
  }
}

export function isCrashSimulated(err: unknown): err is CrashSimulatedError {
  return err instanceof CrashSimulatedError;
}

// ============================================================================
// 执行面类型
// ============================================================================

/** 事务 kind —— ADR-0021 §8 封闭注册表(对齐 types.ts TransactionKind)。 */
export type TxKind = 'canonical' | 'checkpoint' | 'state' | 'run_bootstrap';

export const TX_KINDS: readonly TxKind[] = ['canonical', 'checkpoint', 'state', 'run_bootstrap'];

/**
 * writeSet 目标(调用方声明完整 writeSet, 不补不猜, §1)。
 * - path: vault 相对路径(正斜杠, 归一化);
 * - expected: 生成计划时的期望状态(内容 CAS 唯一基线, §1/§4/F);
 * - output: 计划输出字节; undefined = 计划删除。空字节写拒绝(INVALID_REQUEST,
 *   请用删除语义表达, 见模块内 EMPTY_SHA 约定)。
 */
export interface TargetSpec {
  path: string;
  expected: { absent: boolean; sha256: string };
  output?: string;
}

/** state/checkpoint 的已提交 plan 来源(§8 能力重推导; 存储层窄 schema 不落盘,
 * 由执行层校验; N33 seam 由上层在请求时加载已提交 plan)。 */
export interface StatePlanSource {
  /** HEAD 中已提交的机器状态文件(如 .assistant/checkpoint.json)。 */
  path: string;
  /** sha256(HEAD:<path> 内容)。恢复重算比对, 失配 = 无效 intent。 */
  digest: string;
}

export interface TransactionRequest {
  kind: TxKind;
  /** 事务用途(人类可读诊断; 不进 commit message——subject 固定为
   *  `vault-tx vtx:<txid> plan:<tree>`, 见模块头)。 */
  purpose: string;
  writeSet: TargetSpec[];
  /** 显式 txid(缺省生成; 测试/确定性用; 须匹配 codec TXID 白名单)。 */
  txid?: string;
  /** 生成计划/审批定稿时的 HEAD(封闭生成→启动窗口, §4 背景4); 缺省不做该检查。 */
  expectedHead?: string;
  /** 目标 branch(短名); 缺省 = 当前分支。 */
  branch?: string;
  /** state/checkpoint: 已提交 plan 来源(提供则执行期强校验)。 */
  planSource?: StatePlanSource;
  /** run_bootstrap: 新唯一 run 标识(§8)。 */
  runId?: string;
  /** run_bootstrap: self-describing input/config fingerprint(§8)。 */
  inputFingerprint?: string;
  /** run_bootstrap: 新建 run 的机器状态文件路径(须 ∈ run namespace allowlist)。 */
  runFile?: string;
  /** 业务附加 preflight(N23 validateFrontmatter / ADR-0019 等; 抛错即零写入拒绝)。 */
  validate?: (spec: TargetSpec, ctx: { root: string; currentBytes: string | null; currentHead: string }) => void;
  /** 复核点钩子(测试/编排注入外部动作; 生产留空)。 */
  hooks?: {
    /** 每目标写前复核之前调用。 */
    beforeTargetWrite?: (spec: TargetSpec) => void;
    /** 提交前复核点(⑪)重 hash 之前调用。 */
    beforeRefCas?: () => void;
    /** 共享 index 原子安装之前调用。 */
    beforeSharedIndexInstall?: () => void;
    /** 共享 index 原子安装「获取 index.lock 之后、安装之前」调用(N32 复审 P1-3:
     *  check→lock TOCTOU 窗口的真实注入点; 生产留空)。 */
    afterSharedIndexLock?: () => void;
  };
}

/** 执行器崩溃/门控点(与 worker fixture CRASH_GATES 对齐; 测试/编排注入)。 */
export type GatePhase =
  | 'intent-ready'
  | 'first-rename'
  | 'private-index'
  | 'commit-object'
  | 'review-point'
  | 'ref-cas'
  | 'shared-index-install';

export const GATE_PHASES: readonly GatePhase[] = [
  'intent-ready',
  'first-rename',
  'private-index',
  'commit-object',
  'review-point',
  'ref-cas',
  'shared-index-install',
];

export interface TransactionOptions {
  /** 门控回调: 到达该阶段副作用完成后调用(await); worker 集成协议用。 */
  gates?: (phase: GatePhase) => Promise<void>;
  /** 内部 fault points(`crash` = 模拟 SIGKILL, 不执行任何收尾; `throw` = 普通异常走矩阵)。 */
  faults?: Partial<Record<string, 'crash' | 'throw'>>;
  faultTrigger?: (point: string, ctx: { index?: number }) => boolean;
  /** 生产 per-vault 锁参数(waitMs 默认 0 = fail-closed 立即拒绝, §3)。 */
  lockWaitMs?: number;
  lockStaleMs?: number;
  /** 恢复收敛时锁陈旧判定 ms(pid 已死的持有者可即时回收; 默认 1)。 */
  recoveryLockStaleMs?: number;
}

export interface TransactionResult {
  txid: string;
  kind: TxKind;
  branch: string;
  ref: string;
  baseHead: string;
  newHead: string;
  commit: string;
  tree: string;
  planDigest: string;
  actualChangeSet: string[];
  outcome: 'committed' | 'completed_after_error';
}

// ============================================================================
// 常数
// ============================================================================

export const WORKTREE_TMP_PREFIX = 'novelcraft-txn';
/** sha256(''): 删除语义的 outputs blob 哈希(空字节写已在请求层拒绝)。 */
export const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// commit 身份/日期/消息字节约定(§6): 统一由 git-transaction.commitTransaction 承担
// (buildTxCommitMessage + 固定 novelcraft 身份 + NOVELCRAFT_TX_DATE), 本文件零分叉。

/**
 * 机器状态 namespace 白名单 —— state/checkpoint/run_bootstrap 三类自动补交 kind 的
 * 可写路径唯一集合(ADR-0021 §8「只有明确的机器状态 namespace 可作为 checkpoint/state
 * 自动补完」; N32 复审 Blocker: state/checkpoint 永不写 canonical/adopt 资产路径)。
 * 条目以 `/` 结尾 = 目录前缀; 否则精确匹配。任何 canonical 资产路径(如
 * world/…、novels/…、chapters/…)一律 fail-closed 拒绝。
 * `.assistant/import-runs/` = deep-import run namespace(ADR-0022 §1: 每 run 一目录
 * `<vault>/.assistant/import-runs/<workflow_id>/`; N33 持久化适配器经 run_bootstrap
 * 创建 run 目录/run plan/manifest, 后续 batch/artifact/receipt/cursor 均走 state)。
 */
const MACHINE_STATE_ALLOW: readonly string[] = [
  '.assistant/checkpoint.json',
  '.assistant/import-trace.jsonl',
  '.assistant/atlas/runs/',
  '.assistant/import-runs/',
  '.assistant/signals/',
  // 受控 machine-state bootstrap 路径(ADR-0021 §8 run_bootstrap 例外): watch 调度
  // 首次创建走 run_bootstrap(runFile 同路径、全目标 expected absent、configFingerprint
  // 作 inputFingerprint), 后续保存走 state + planSource=HEAD:<path> digest; 恢复补交
  // 前按本 allowlist + base HEAD digest 重推导, 缺失即保留不补交。
  '.assistant/watch-state.json',
];

function matchAllow(allow: string, rel: string): boolean {
  return allow.endsWith('/') ? rel.startsWith(allow) : allow === rel;
}

// ============================================================================
// git 薄封装(N32 复审 P1-2: 与 git-transaction.ts 同规格 —— 复用其 buildEnv(最小
// allowlist, 清全部 GIT_* 重定向/配置注入)与 pinArgs(钉固 --git-dir/--work-tree +
// 禁 replace/optional locks), 全部调用经 RepoContext 钉固; 绝不继承外部 GIT_*)
// ============================================================================

/** 钉固 + env 清理的 git 调用(一切 execute/recovery git 访问的唯一通道; audit
 * 允许表 seam: GIT_CP_WRITE @git)。details 携带 { args, status }(status 供
 * `diff --exit-code` 类只读探测区分 exit 1 = 有差异 与 其余错误, fail-closed)。 */
function git(
  ctx: RepoContext,
  args: string[],
  opts: { env?: Record<string, string>; input?: string | Buffer; allowFailure?: boolean } = {},
): string {
  const execOpts: ExecFileSyncOptions = {
    cwd: ctx.repoDir,
    encoding: 'utf8',
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env: buildSafeEnv(opts.env),
  };
  if (opts.input !== undefined) execOpts.input = opts.input; // 关键: execFileSync 必须显式传 input
  try {
    const out = execFileSync('git', [...pinArgs(ctx), ...args], execOpts);
    return typeof out === 'string' ? out : out.toString('utf8');
  } catch (err) {
    if (opts.allowFailure) return '';
    const e = err as { stderr?: Buffer | string; status?: number };
    const stderr = typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '';
    throw new TransactionError('GIT_ERROR', `git ${args.join(' ')} 失败: ${stderr.trim() || String(err)}`, { args, status: e.status });
  }
}

function runCtx(ctx: RepoContext, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer; allowFailure?: boolean } = {}): string {
  return git(ctx, args, opts).trim();
}

/** 只读探测封装(audit 允许表 seam: GIT_CP_WRITE @gitOk; exit 判定专用)。 */
function gitOk(ctx: RepoContext, args: string[]): boolean {
  try {
    execFileSync('git', [...pinArgs(ctx), ...args], {
      cwd: ctx.repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** 仓库上下文解析 + GitTransactionError 转执行层错误面。 */
function resolveTxCtx(vault: string): RepoContext {
  try {
    return resolveRepoContext(vault);
  } catch (err) {
    if (err instanceof GitTransactionError) {
      if (err.code === 'UNKNOWN_REF') {
        throw new TransactionError('NOT_GIT_REPO', `工作区不是可用的 git 仓库: ${err.message}`, err.details);
      }
      throw txGitError(err);
    }
    throw err;
  }
}

/** GitTransactionError → 执行层错误面(公开错误码契约不变; fail-closed 语义保持)。 */
function txGitError(err: GitTransactionError): TransactionError {
  switch (err.code) {
    case 'STAGED_CONFLICT':
      return new TransactionError('STAGED_CONFLICT', err.message, err.details);
    case 'REF_CAS_FAILED':
      return new TransactionError('REF_CAS_CONFLICT', err.message, err.details);
    case 'WORKTREE_CONFLICT':
    case 'PLAN_MISMATCH': // 纯字节计划推导与 materialize 不一致 → 按矩阵条件处置(不 update-ref)
      return new TransactionError('CAS_CONFLICT', err.message, err.details);
    case 'INDEX_LOCKED':
    case 'REPO_STATE_UNSAFE':
    case 'UNKNOWN_REF': // 事务中 ref 非当前 symbolic HEAD / 仓库不可解析 → 竞争/未知, fail-closed
      return new TransactionError('UNKNOWN_GIT_LOCK', err.message, err.details);
    case 'BAD_TARGET':
      return new TransactionError('INVALID_REQUEST', err.message, err.details);
    case 'TX_NOT_FOUND':
    case 'TX_AMBIGUOUS':
      return new TransactionError('INVALID_INTENT', err.message, err.details);
    default:
      return new TransactionError('GIT_ERROR', err.message, err.details);
  }
}

/** 复用 git-transaction 提交原语的错误映射包装(同步/异步)。 */
function runCommit(p: CommitTxnParams): CommitTxnResult {
  try {
    return commitTransaction(p);
  } catch (err) {
    if (err instanceof GitTransactionError) throw txGitError(err);
    throw err;
  }
}

function runCommitAsync(p: CommitTxnParams): Promise<CommitTxnResult> {
  return commitTransactionAsync(p).catch((err: unknown) => {
    if (err instanceof GitTransactionError) throw txGitError(err);
    throw err;
  });
}

export function currentBranch(vault: string): string {
  const ctx = resolveTxCtx(vault);
  const b = runCtx(ctx, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true });
  if (!b) throw new TransactionError('NOT_GIT_REPO', `工作区不是 git 仓库或无当前分支: ${vault}`);
  return b;
}

function fullRefOf(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

function refHead(ctx: RepoContext, fullRef: string): string {
  const out = runCtx(ctx, ['rev-parse', '--verify', `${fullRef}^{commit}`], { allowFailure: true });
  if (!out || !isGitOid(out, ctx.oidLen)) {
    throw new TransactionError('INVALID_INTENT', `ref 无 commit: ${fullRef}`);
  }
  return out;
}

function sha256Of(bytes: string | Uint8Array): string {
  if (typeof bytes === 'string') return sha256Hex(Buffer.from(bytes, 'utf8'));
  return sha256Hex(Buffer.from(bytes));
}

function fileState(abs: string): 'file' | 'absent' | 'symlink' | 'other' {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'absent';
  }
}

function readWorktreeBytes(abs: string): string | null {
  if (fileState(abs) !== 'file') return null;
  return fs.readFileSync(abs, 'utf8');
}

/** 事务私有 index 文件(与 git-transaction.ts 同布局; 崩溃残留按 txid 可归属清理)。 */
function privateIndexFile(ctx: RepoContext, txid: string): string {
  return path.join(ctx.gitDir, `${WORKTREE_TMP_PREFIX}-${txid}.index`);
}

function removePrivateIndexResidue(ctx: RepoContext, txid: string): void {
  try {
    fs.rmSync(privateIndexFile(ctx, txid), { force: true });
  } catch {
    /* 无残留。 */
  }
}

function statOrNull(p: string): { dev: number; ino: number; size: number; sha256: string } | null {
  try {
    const st = fs.statSync(p);
    return { dev: st.dev, ino: st.ino, size: st.size, sha256: sha256Hex(fs.readFileSync(p)) };
  } catch {
    return null;
  }
}

function indexIdentityChanged(
  expected: { dev: number; ino: number; size: number; sha256: string } | null,
  current: { dev: number; ino: number; size: number; sha256: string } | null,
): boolean {
  return expected !== null && current !== null &&
    (current.dev !== expected.dev || current.ino !== expected.ino ||
      current.size !== expected.size || current.sha256 !== expected.sha256);
}

function assertNoGitCriticalSections(ctx: RepoContext, fullRef: string): void {
  const gitDir = ctx.gitDir;
  const idxLock = path.join(gitDir, 'index.lock');
  if (fs.existsSync(idxLock)) {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `共享 index.lock 存在且无法证明归属, fail-closed(§6): ${idxLock}`);
  }
  const refLock = path.join(gitDir, fullRef) + '.lock'; // fullRef = refs/heads/<branch>
  if (fs.existsSync(refLock)) {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `ref lock 存在且无法证明归属, fail-closed(§6): ${refLock}`);
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      throw new TransactionError('UNKNOWN_GIT_LOCK', `未完成 Git 临界区, fail-closed(§6): ${marker}`);
    }
  }
  // 加固②(复用 git-transaction assertSafeRepoState 原语): replace refs / grafts /
  // shallow 会改变对象/历史 provenance, 一律 fail-closed(恢复验证同样会被拒)。
  try {
    assertSafeRepoState(ctx);
  } catch (err) {
    if (err instanceof GitTransactionError) throw txGitError(err);
    throw err;
  }
}

// ============================================================================
// plan identity 推导(§6: tree hash、writeSet 与输出 blob hashes 共为不可变 plan
// digest; 与 git-transaction.ts computePlanDigest 同构, 确定性可重推导)
// ============================================================================

export interface DerivedPlan {
  tree: string;
  planDigest: string;
  targetBlobs: ReadonlyArray<{ path: string; mode: TxFileMode | null; blob: string | null }>;
}

/**
 * 从 base HEAD + 实际输出字节确定性推导 exact tree / 输出 blobs / plan digest
 * (恢复/补交路径的 materialize 实现; N32 复审 P1-1/P1-2: 与 git-transaction 同规格
 * —— 复用其 buildEnv/pinArgs/resolveRepoContext/assertSafeRepoState/isOid, 支持
 * sha1+sha256 object format; 本函数会写 ODB(hash-object -w)+ 建私有 index, 因此
 * **只允许在 intent READY 之后调用**; intent 前用 derivePlanIdentityPure 纯字节推导)。
 * 私有 index 文件在函数结束后清理(finally 以 (dev,ino,size,sha256) 守卫, 不删并发者替换的文件);
 * 崩溃残留(未及清理)由恢复收敛按 txid 清理。
 */
export function derivePlanIdentity(
  vault: string,
  baseHead: string,
  targets: ReadonlyArray<{ path: string; output: string | null }>,
  txid = 'derive',
): DerivedPlan {
  const ctx = resolveTxCtx(vault);
  assertSafeRepoState(ctx);
  const idx = privateIndexFile(ctx, txid);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  const env: Record<string, string> = { GIT_INDEX_FILE: idx };
  const raw: Array<{ path: string; mode: TxFileMode | null; blob: string | null }> = [];
  // 私有 index 及其 .lock 残留无法证明归属 → fail-closed(与 commitTransaction ⑪ 同门)。
  if (fs.existsSync(idx)) {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `事务私有 index 已存在(同 txid 残留?), fail-closed: ${idx}`);
  }
  if (fs.existsSync(`${idx}.lock`)) {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `事务私有 index 的 .lock 已存在(无法证明归属), fail-closed: ${idx}.lock`);
  }
  let ourIndexStat: { dev: number; ino: number; size: number; sha256: string } | null = null;
  const refreshIndexStat = (): void => {
    ourIndexStat = statOrNull(idx);
  };
  try {
    runCtx(ctx, ['read-tree', baseHead], { env });
    refreshIndexStat();
    for (const t of targets) {
      if (t.output === null) {
        runCtx(ctx, ['update-index', '--force-remove', '--', t.path], { env, allowFailure: true });
        raw.push({ path: t.path, mode: null, blob: null });
      } else {
        const bytes = Buffer.from(t.output, 'utf8');
        const blob = runCtx(ctx, ['hash-object', '-w', '--stdin'], { env, input: bytes });
        if (!isGitOid(blob, ctx.oidLen)) throw new TransactionError('GIT_ERROR', `hash-object 输出异常: ${blob}`);
        runCtx(ctx, ['update-index', '--add', '--cacheinfo', `100644,${blob},${t.path}`], { env });
        raw.push({ path: t.path, mode: '100644', blob });
      }
      refreshIndexStat(); // update-index 以 lock+rename 替换 index 文件(新 inode), 刷新记录
    }
    const tree = runCtx(ctx, ['write-tree'], { env });
    if (!isGitOid(tree, ctx.oidLen)) throw new TransactionError('GIT_ERROR', `write-tree 输出异常: ${tree}`);
    refreshIndexStat();
    const planDigest = computePlanDigest(baseHead, tree, raw);
    return { tree, planDigest, targetBlobs: raw };
  } finally {
    // 只删除本调用创建/使用的私有 index(dev/ino 匹配); 并发者替换后绝不误删(加固⑪)。
    const curStat = statOrNull(idx);
    if (indexIdentityChanged(ourIndexStat, curStat)) {
      /* 并发者替换了私有 index 文件 → 不删除(隔离)。 */
    } else {
      fs.rmSync(idx, { force: true });
    }
  }
}

/** plan digest 复用 git-transaction 同口径实现(execute 与原语零分叉, N32 复审 P1-2)。 */
export { computePlanDigest } from './git-transaction.js';

/** 共享 index 受控原子安装(§6; N32 复审 P1-3 TOCTOU 加固):
 * 1) 拿锁前预检(安装前 staged 重验): 共享 index tree ∈ {BASE, OUTPUT}, 且无未知
 *    index.lock; 预检写 tree 后快照 index 的 identity/bytes(dev/ino/size/sha256);
 * 2) 原子取 git 自己的 .git/index.lock(失败 = 外部占用, fail-closed);
 * 3) **拿锁后复核**(消除 check→lock TOCTOU): 快照 identity/bytes 必须未变 + 只读
 *    diff 复核 index tree 仍 ∈ {BASE, OUTPUT} —— 预检后、拿锁前作者 `git add` 的
 *    staged 一律不覆盖, SHARED_INDEX_CONFLICT 并释放锁(作者现场原样保留);
 * 4) buildHeadIndexBytes 构建新 HEAD index bytes, 同目录 temp + rename 原子安装;
 * 5) finally 释放锁(幂等)。持锁期间 git 自身无法写 index(锁互斥), 因此「拿锁后」
 *    的复核窗口是最终安全边界。
 * 外部 staged/lock 一律不覆盖, fail-closed(§7 G)。 */
function installSharedIndex(ctx: RepoContext, baseHead: string, commit: string, newTree: string, afterLock?: () => void): void {
  const gitDir = ctx.gitDir;
  const idxLock = path.join(gitDir, 'index.lock');
  if (fs.existsSync(idxLock)) {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `共享 index.lock 已存在, 拒绝覆盖(fail-closed, §6): ${idxLock}`);
  }
  const idxPath = path.join(gitDir, 'index');
  const baseTree = runCtx(ctx, ['rev-parse', '--verify', `${baseHead}^{tree}`], { allowFailure: true });
  // 拿锁前预检(安装前 staged 重验): 共享 index tree 必须 ∈ {BASE, OUTPUT}。
  const idxTreeBefore = runCtx(ctx, ['write-tree'], { allowFailure: true });
  if (idxTreeBefore !== '' && idxTreeBefore !== baseTree && idxTreeBefore !== newTree) {
    throw new TransactionError('SHARED_INDEX_CONFLICT', `共享 index 含外部条目(相对 base/新 HEAD 均不同), 拒绝覆盖(§6/§7)`);
  }
  // 拿锁前快照(identity/bytes): 供拿锁后复核(P1-3)。
  const snapshot = indexSnapshot(idxPath);
  let acquired = false;
  try {
    fs.writeFileSync(idxLock, `${process.pid}\n`, { flag: 'wx' });
    acquired = true;
  } catch {
    throw new TransactionError('UNKNOWN_GIT_LOCK', `安装共享 index 时 .git/index.lock 被外部占用, fail-closed`);
  }
  try {
    afterLock?.(); // 测试钩子: 拿锁后、安装前的真实 TOCTOU 窗口
    // —— 拿锁后复核(P1-3): 作者 git add 不得被覆盖 ——
    const now = indexSnapshot(idxPath);
    if (!snapshotsIdentical(snapshot, now)) {
      throw new TransactionError(
        'SHARED_INDEX_CONFLICT',
        `拿锁后共享 index 身份/字节已变化(预检→拿锁窗口的作者 staged?), 拒绝覆盖(fail-closed, P1-3)`,
      );
    }
    if (snapshot !== null) {
      // tree CAS 复核(只读 diff, 持锁期间无需 index 写锁): index 树仍 ∈ {BASE, OUTPUT}。
      // 注意: update-ref CAS 后 HEAD 已 == commit, diff 必须显式以 baseHead/commit 为
      // 参照(不能用 HEAD 判 BASE —— HEAD 已是新树)。
      const isBase = diffCachedClean(ctx, baseHead);
      const isOutput = !isBase && diffCachedClean(ctx, commit);
      if (!isBase && !isOutput) {
        throw new TransactionError(
          'SHARED_INDEX_CONFLICT',
          `拿锁后共享 index tree 复核失败(非 BASE/OUTPUT, 预检→拿锁窗口的作者 staged?), 拒绝覆盖(fail-closed, P1-3)`,
        );
      }
    }
    const bytes = buildHeadIndexBytes(ctx.repoDir, commit);
    const ns = path.join(gitDir, 'novelcraft-transactions');
    fs.mkdirSync(ns, { recursive: true });
    const tmp = path.join(ns, `.index.final.${commit.slice(0, 12)}`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(gitDir, 'index'));
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(idxLock);
      } catch {
        /* 已不存在。 */
      }
    }
  }
}

/** 共享 index 文件身份快照(dev/ino/size + 字节 sha256; 不存在 → null)。 */
function indexSnapshot(idxPath: string): { dev: number; ino: number; size: number; sha256: string } | null {
  try {
    const st = fs.statSync(idxPath);
    return { dev: st.dev, ino: st.ino, size: st.size, sha256: sha256Hex(fs.readFileSync(idxPath)) };
  } catch {
    return null;
  }
}

function snapshotsIdentical(
  a: { dev: number; ino: number; size: number; sha256: string } | null,
  b: { dev: number; ino: number; size: number; sha256: string } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha256 === b.sha256;
}

/** 只读 diff --cached 判定(钉固 --no-optional-locks, 不刷新 index, 无需 index.lock;
 * exit 0 = 无差异, exit 1 = 有差异, 其余 = 真实错误 fail-closed)。走 `git` seam
 * (audit 允许表: 一切 git 访问收敛在薄封装内; 状态码经 GIT_ERROR details.status 判定)。 */
function diffCachedClean(ctx: RepoContext, against?: string): boolean {
  const args =
    against === undefined
      ? ['diff', '--cached', '--exit-code', '--quiet']
      : ['diff', '--cached', '--exit-code', '--quiet', against];
  try {
    git(ctx, args);
    return true; // exit 0 = 无差异
  } catch (err) {
    if (err instanceof TransactionError && err.code === 'GIT_ERROR') {
      const status = (err.details as { status?: number } | undefined)?.status;
      if (status === 1) return false; // exit 1 = 有差异(探测预期)
    }
    throw err; // 其余 = 真实错误 fail-closed
  }
}

/** 共享 index 状态分类(§7): BASE / OUTPUT / CONFLICT / UNKNOWN。 */
function classifySharedIndexTree(ctx: RepoContext, baseHead: string, expectedTree: string): 'BASE' | 'OUTPUT' | 'CONFLICT' | 'UNKNOWN' {
  if (!fs.existsSync(path.join(ctx.gitDir, 'index'))) return 'UNKNOWN';
  const idxTree = runCtx(ctx, ['write-tree'], { allowFailure: true });
  if (!idxTree) return 'UNKNOWN';
  const baseTree = runCtx(ctx, ['rev-parse', '--verify', `${baseHead}^{tree}`], { allowFailure: true });
  if (idxTree === baseTree) return 'BASE';
  if (idxTree === expectedTree) return 'OUTPUT';
  return 'CONFLICT';
}

// ============================================================================
// 输入归一(先 codec, 后语义; N32/§8 白名单精神)
// ============================================================================

/** TransactionRequest 顶层字段白名单(公开注入面, 未知字段一律 fail-closed)。 */
const REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'purpose',
  'writeSet',
  'txid',
  'expectedHead',
  'branch',
  'planSource',
  'runId',
  'inputFingerprint',
  'runFile',
  'validate',
  'hooks',
]);
const REQUEST_TARGET_FIELDS: ReadonlySet<string> = new Set(['path', 'expected', 'output']);
const REQUEST_EXPECTED_FIELDS: ReadonlySet<string> = new Set(['absent', 'sha256']);
const REQUEST_PLANSOURCE_FIELDS: ReadonlySet<string> = new Set(['path', 'digest']);
const REQUEST_HOOK_FIELDS: ReadonlySet<string> = new Set(['beforeTargetWrite', 'beforeRefCas', 'beforeSharedIndexInstall', 'afterSharedIndexLock']);

/**
 * 公开 request 的 plain-data snapshot(复审 Blocker: intent 生产链在**任何 getter 前**
 * 用 codec plain-data 校验; Proxy/accessor/class 一律 fail-closed)。
 * - 顶层/nested 全部经 codec isPlainRecord(拒 Proxy、非 Object.prototype/null 原型
 *   的类实例、自有 accessor 描述符)与字段白名单(未知字段 → INVALID_REQUEST);
 * - 返回**新建**的 plain 对象; 之后的执行只消费本快照, 不再触碰调用方对象
 *   (任何 getter 都不可能在门禁后再次触发);
 * - codec StoreError(TX_NON_PLAIN_OBJECT/TX_UNKNOWN_FIELD/路径/哈希)统一转译为
 *   TransactionError INVALID_REQUEST(公开错误面一致)。
 */
function snapshotRequest(request: TransactionRequest): TransactionRequest {
  try {
    const top = requirePlainRecord(request, 'TransactionRequest');
    assertNoUnknownFields(top, REQUEST_FIELDS, 'TransactionRequest');
    const kind = top.kind;
    if (typeof kind !== 'string' || !isTransactionKind(kind)) {
      throw new TransactionError('INVALID_REQUEST', `未知事务类型: ${JSON.stringify(kind)}`);
    }
    const purpose = top.purpose;
    if (typeof purpose !== 'string' || purpose.length === 0) {
      throw new TransactionError('INVALID_REQUEST', 'purpose 必须是非空字符串');
    }
    if (!Array.isArray(top.writeSet)) {
      throw new TransactionError('INVALID_REQUEST', 'writeSet 必须是数组');
    }
    const writeSet: TargetSpec[] = top.writeSet.map((raw, i) => {
      const t = requirePlainRecord(raw, `writeSet[${i}]`);
      assertNoUnknownFields(t, REQUEST_TARGET_FIELDS, `writeSet[${i}]`);
      const p = t.path;
      if (typeof p !== 'string' || p.length === 0) {
        throw new TransactionError('INVALID_REQUEST', `writeSet[${i}].path 必须是非空字符串`);
      }
      const exp = requirePlainRecord(t.expected, `writeSet[${i}].expected`);
      assertNoUnknownFields(exp, REQUEST_EXPECTED_FIELDS, `writeSet[${i}].expected`);
      if (typeof exp.absent !== 'boolean') {
        throw new TransactionError('INVALID_REQUEST', `writeSet[${i}].expected.absent 必须是布尔`);
      }
      if (exp.sha256 !== undefined && typeof exp.sha256 !== 'string') {
        throw new TransactionError('INVALID_REQUEST', `writeSet[${i}].expected.sha256 必须是字符串`);
      }
      const spec: TargetSpec = {
        path: p,
        expected: { absent: exp.absent, sha256: typeof exp.sha256 === 'string' ? exp.sha256 : '' },
      };
      if (t.output !== undefined) {
        if (typeof t.output !== 'string') {
          throw new TransactionError('INVALID_REQUEST', `writeSet[${i}].output 必须是字符串`);
        }
        spec.output = t.output;
      }
      return spec;
    });
    const out: TransactionRequest = { kind: kind as TxKind, purpose, writeSet };
    for (const key of ['txid', 'expectedHead', 'branch', 'runId', 'inputFingerprint'] as const) {
      const v = top[key];
      if (v !== undefined) {
        if (typeof v !== 'string') {
          throw new TransactionError('INVALID_REQUEST', `${key} 必须是字符串`);
        }
        (out as unknown as Record<string, unknown>)[key] = v;
      }
    }
    if (top.runFile !== undefined) {
      // runFile 参与 `HEAD:<path>` 解析, 路径形态先验(同 planSource.path; 拒绝对/穿越)。
      if (typeof top.runFile !== 'string') {
        throw new TransactionError('INVALID_REQUEST', 'runFile 必须是字符串');
      }
      out.runFile = normalizeRelPath(top.runFile);
    }
    if (top.planSource !== undefined) {
      const ps = requirePlainRecord(top.planSource, 'planSource');
      assertNoUnknownFields(ps, REQUEST_PLANSOURCE_FIELDS, 'planSource');
      if (typeof ps.path !== 'string' || typeof ps.digest !== 'string') {
        throw new TransactionError('INVALID_REQUEST', 'planSource.path/digest 必须是字符串');
      }
      // 路径/哈希形态先验(normalizeRelPath 拒绝对/穿越/控制字符; normalizeSha256 64-hex)。
      out.planSource = { path: normalizeRelPath(ps.path), digest: normalizeSha256(ps.digest) };
    }
    if (top.validate !== undefined) {
      if (typeof top.validate !== 'function') {
        throw new TransactionError('INVALID_REQUEST', 'validate 必须是函数');
      }
      out.validate = top.validate as TransactionRequest['validate'];
    }
    if (top.hooks !== undefined) {
      const h = requirePlainRecord(top.hooks, 'hooks');
      assertNoUnknownFields(h, REQUEST_HOOK_FIELDS, 'hooks');
      const hooks: NonNullable<TransactionRequest['hooks']> = {};
      for (const key of REQUEST_HOOK_FIELDS) {
        const fn = h[key];
        if (fn !== undefined) {
          if (typeof fn !== 'function') {
            throw new TransactionError('INVALID_REQUEST', `hooks.${key} 必须是函数`);
          }
          (hooks as Record<string, unknown>)[key] = fn;
        }
      }
      out.hooks = hooks;
    }
    return out;
  } catch (err) {
    if (err instanceof StoreError) {
      throw new TransactionError('INVALID_REQUEST', `请求非 plain/白名单外(fail-closed): ${err.message}`, err.details);
    }
    throw err;
  }
}

function normalizeRequest(ctx: RepoContext, request: TransactionRequest, ref: string): { baseHead: string; targets: Array<TargetSpec & { path: string }> } {
  const baseHead = refHead(ctx, ref);
  const seen = new Set<string>();
  const targets: Array<TargetSpec & { path: string }> = [];
  for (const spec of request.writeSet) {
    const p = normalizeRelPath(spec.path);
    if (seen.has(p)) throw new TransactionError('INVALID_REQUEST', `writeSet 重复目标: ${p}`);
    seen.add(p);
    if (p === '.git' || p.startsWith('.git/')) throw new TransactionError('INVALID_REQUEST', `writeSet 禁止进入 .git 内部: ${p}`);
    if (spec.expected === undefined || typeof spec.expected !== 'object') {
      throw new TransactionError('INVALID_REQUEST', `目标缺少 expected state(唯一 CAS 基线, §1): ${p}`);
    }
    if (typeof spec.expected.absent !== 'boolean') {
      throw new TransactionError('INVALID_REQUEST', `expected.absent 必须是布尔: ${p}`);
    }
    // absent 语义: sha256 占位为空串, 不做 64-hex 归一(码层拒绝空值)。
    const sha = spec.expected.absent ? '' : normalizeSha256(spec.expected.sha256);
    if (spec.output !== undefined && spec.output.length === 0) {
      throw new TransactionError('INVALID_REQUEST', `目标 ${p} 输出为空字节: 计划删除请省略 output(§1 语义)`);
    }
    targets.push({ ...spec, path: p, expected: { absent: spec.expected.absent, sha256: sha } });
  }
  if (targets.length === 0) throw new TransactionError('INVALID_REQUEST', 'writeSet 为空(§1: 调用方声明完整 writeSet)');
  return { baseHead, targets };
}

// ============================================================================
// preflight 与快照(§2/§4: 任一失败 → 零写入返回, intent 建立前零副作用)
// ============================================================================

function preflightTargets(
  ctx: RepoContext,
  targets: Array<TargetSpec & { path: string }>,
  request: TransactionRequest,
  branch: string,
): Array<{ spec: TargetSpec & { path: string }; currentBytes: string | null; existed: boolean }> {
  // §2: 整个 index 任何预存 staged → 拒绝(不自动清除、不自动并入, N32)。
  // N32 复审 P1-2: 走钉固 + env 清理的 git 调用(外部 GIT_* 注入不得影响 staged 判定)。
  const raw = git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  for (const e of parsePorcelainV1Z(raw)) {
    if (e.status[0] !== ' ' && e.status[0] !== '?') {
      throw new TransactionError('STAGED_CONFLICT', `预存 staged 检测到, 整个事务拒绝(N32 §2): ${e.path}`);
    }
  }
  const vault = ctx.repoDir;
  const out: Array<{ spec: TargetSpec & { path: string }; currentBytes: string | null; existed: boolean }> = [];
  for (const spec of targets) {
    const abs = path.join(vault, spec.path);
    const st = fileState(abs);
    if (st === 'symlink') {
      throw new TransactionError('INVALID_REQUEST', `目标路径是 symlink(fail-closed, §8): ${spec.path}`);
    }
    const currentBytes = st === 'file' ? fs.readFileSync(abs, 'utf8') : null;
    if (spec.expected.absent) {
      if (currentBytes !== null) {
        throw new TransactionError('STALE_BASELINE', `目标 ${spec.path} 应不存在但当前存在(§4/N32)`);
      }
    } else if (currentBytes === null || sha256Of(currentBytes) !== spec.expected.sha256) {
      throw new TransactionError(
        'STALE_BASELINE',
        `目标 ${spec.path} 内容 CAS 失败: 期望 ${spec.expected.sha256}, 实际 ${currentBytes === null ? '缺失' : sha256Of(currentBytes)} (§4/N32)`,
      );
    }
    request.validate?.(spec, { root: vault, currentBytes, currentHead: refHead(ctx, fullRefOf(branch)) });
    out.push({ spec, currentBytes, existed: currentBytes !== null });
  }
  return out;
}

/** no-op 剔除(§4): expected state == 输出且当前已复核 → 实际变化集去掉;
 * 私有 exact tree 的变化集必须恰等于剔除 no-op 后的实际变化集(§4)。 */
function computeChangeSet(targets: Array<TargetSpec & { path: string }>): string[] {
  const out: string[] = [];
  for (const spec of targets) {
    if (spec.output === undefined) {
      if (spec.expected.absent) continue; // 原不存在 → no-op
      out.push(spec.path);
    } else if (!spec.expected.absent && spec.expected.sha256 === sha256Of(spec.output)) {
      continue; // 内容不变 → no-op
    } else {
      out.push(spec.path);
    }
  }
  return out;
}

// ============================================================================
// 工作树写(§5: 同目录 temp + rename 原子替换; 每目标写前复核)
// ============================================================================

function atomicWrite(abs: string, txid: string, content: string | Buffer): void {
  // 父目录由事务自身在写面创建(§5): 全量 preflight(§4)通过、intent 耐久化(§8)之后
  // 才允许 mkdir —— preflight/预存 staged 失败路径零工作树目录副作用(N33 复审)。
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${WORKTREE_TMP_PREFIX}-${txid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

/**
 * 受保护删除(§5 同规格; applyOutputs 正常写面与 completeStateTransaction 恢复补完共用,
 * N32 复审 P2 最小复用): 同目录 temp + rename 原子摘除目标路径(仅 `file` 态才 rename,
 * symlink/目录等非普通文件 fail-closed 已由调用方 classify 排除), 再 unlink temp。
 * rename 是「路径消失」的原子点; unlink 失败/崩溃于两者之间时 temp 残留由
 * cleanupWorktreeTmp 幂等清理, 恢复分类下该目标为 OUTPUT(已删除)不重复动作。
 * 调用方必须先经 classifyWorktreeTarget 判定为 BEFORE(内容 == 事务前快照)才可调用,
 * 绝不删除/覆盖 CONFLICT(外部编辑)目标。
 */
function removeWorktreeFile(abs: string, txid: string): void {
  const tmp = `${abs}.${WORKTREE_TMP_PREFIX}-${txid}.tmp`;
  if (fileState(abs) === 'file') fs.renameSync(abs, tmp);
  try {
    fs.unlinkSync(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function applyOutputs(
  vault: string,
  txid: string,
  changeSet: string[],
  specByPath: Map<string, TargetSpec & { path: string }>,
  gates: ((p: GatePhase) => Promise<void>) | undefined,
  hooks: TransactionRequest['hooks'],
): Promise<void> {
  let first = true;
  for (const rel of changeSet) {
    const spec = specByPath.get(rel)!;
    const abs = path.join(vault, rel);
    hooks?.beforeTargetWrite?.(spec);
    // §5: 每目标写前再复核当前状态仍等于生成计划时的 expected state(≠自动基线, F)。
    const cur = readWorktreeBytes(abs);
    if (spec.expected.absent) {
      if (cur !== null) throw new TransactionError('CAS_CONFLICT', `目标 ${rel} 写前复核失败: 应不存在(§5)`);
    } else if (cur === null || sha256Of(cur) !== spec.expected.sha256) {
      throw new TransactionError('CAS_CONFLICT', `目标 ${rel} 写前复核失败: 期望 ${spec.expected.sha256}(§5)`);
    }
    if (spec.output === undefined) {
      removeWorktreeFile(abs, txid);
    } else {
      atomicWrite(abs, txid, spec.output);
    }
    if (first) {
      first = false;
      await gates?.('first-rename'); // 崩溃点2: 首目标已落盘, 其余 BEFORE
    }
  }
}

/** 清理本事务遗留的同目录 temp 残留(崩溃于 temp+rename 之间时, 恢复收敛调用)。 */
function cleanupWorktreeTmp(vault: string, txid: string, paths_: readonly string[]): void {
  for (const rel of paths_) {
    try {
      fs.unlinkSync(`${path.join(vault, rel)}.${WORKTREE_TMP_PREFIX}-${txid}.tmp`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// ============================================================================
// intent 构造与持久化(§4/§8: 首个工作树/index 变更之前耐久化)
// ============================================================================

/** 删除语义判定: outputs blob 为空(sha256(''))= 计划删除; 空字节写已在请求层拒绝,
 * 故该映射单射。no-op 目标(未入变化集)的 outputs blob = 快照字节(输出 == 当前),
 * 恢复矩阵下恒为 BEFORE/OUTPUT, 不产生伪 CONFLICT。 */
function deleteIsWrite(target: IntentTargetEntry): boolean {
  return target.outputSha256 !== EMPTY_SHA;
}

/**
 * no-op 目标判定(intent 记录口径, 复审 Blocker): 计划输出字节 == 事务前快照字节
 * (内容不变的写 / 原不存在的删, 与 §4 剔除后的实际变化集一致)。执行期 computeChangeSet
 * 按 expected==output 剔除; 恢复期必须按 outputSha256==snapshotSha256 还原同一划分,
 * 否则 no-op 目标(工作树与 HEAD 可能不同的未提交编辑)会被错误纳入 exact tree 重推导,
 * 造成 plan digest 伪失配 = 误判篡改(tamper)。
 */
function isNoopTarget(t: IntentTargetEntry): boolean {
  return t.outputSha256 !== undefined && t.snapshotSha256 !== undefined && t.outputSha256 === t.snapshotSha256;
}

/** 从 intent 记录重推导实际变化集(剔除 no-op 目标; fullWriteSet 与 actualWriteSet 的
 * 恢复划分, ADR-0021 §4/§6: 私有 exact tree 的变化集 = 实际变化集)。 */
function actualChangeSetFromRecord(
  vault: string,
  txid: string,
  record: IntentRecord,
): Array<{ path: string; output: string | null }> {
  const out: Array<{ path: string; output: string | null }> = [];
  for (let i = 0; i < record.targets.length; i += 1) {
    const t = record.targets[i];
    if (isNoopTarget(t)) continue; // no-op 不入变化集
    out.push({
      path: t.path,
      output: deleteIsWrite(t) ? readIntentBlob(vault, txid, 'outputs', i).toString('utf8') : null,
    });
  }
  return out;
}

// ============================================================================
// 状态矩阵(§7): BEFORE/OUTPUT/CONFLICT 分类 + 条件回滚/补完
// ============================================================================

export type WorktreeState = 'BEFORE' | 'OUTPUT' | 'CONFLICT';

export interface ClassifiedTarget {
  path: string;
  state: WorktreeState;
}

/**
 * 逐目标工作树分类(§7): BEFORE(等于事务前快照/原本不存在)、OUTPUT(等于计划输出)、
 * CONFLICT(两者都不等)。快照只供回滚判定, 不是 CAS 基线(§4/F)。symlink/目录等
 * 非普通文件一律 CONFLICT(fail-closed)。
 */
export function classifyWorktreeTarget(abs: string, output: string | null, snapshot: { existed: boolean; bytes: string }): WorktreeState {
  const st = fileState(abs);
  if (st !== 'file' && st !== 'absent') return 'CONFLICT';
  const bytes = st === 'file' ? fs.readFileSync(abs, 'utf8') : null;
  if (output !== null) {
    if (bytes !== null && sha256Of(bytes) === sha256Of(output)) return 'OUTPUT';
    if (snapshot.existed && bytes !== null && sha256Of(bytes) === sha256Of(snapshot.bytes)) return 'BEFORE';
    if (!snapshot.existed && bytes === null) return 'BEFORE';
    return 'CONFLICT';
  }
  if (bytes === null) return 'OUTPUT';
  if (snapshot.existed && sha256Of(bytes) === sha256Of(snapshot.bytes)) return 'BEFORE';
  return 'CONFLICT';
}

/** 恢复期逐目标分类(读 intent 的 snapshots/outputs 二进制; 全部 writeSet 目标,
 * no-op 目标天然落在 BEFORE/OUTPUT 一侧)。 */
export function classifyAllTargetsFromIntent(vault: string, txid: string, record: IntentRecord): ClassifiedTarget[] {
  const out: ClassifiedTarget[] = [];
  for (let i = 0; i < record.targets.length; i += 1) {
    const t = record.targets[i];
    let state: WorktreeState;
    try {
      const snap = readIntentBlob(vault, txid, 'snapshots', i);
      const outBuf = readIntentBlob(vault, txid, 'outputs', i);
      const output: string | null = deleteIsWrite(t) ? outBuf.toString('utf8') : null;
      const snapshot = { existed: t.existed, bytes: t.existed ? snap.toString('utf8') : '' };
      state = classifyWorktreeTarget(path.join(vault, t.path), output, snapshot);
    } catch {
      state = 'CONFLICT';
    }
    out.push({ path: t.path, state });
  }
  return out;
}

/** canonical 条件回滚(§7/§8): 只把 OUTPUT 恢复为 BEFORE(覆写还原快照, 新建安全
 * 删除), BEFORE 不动; 绝不 restore HEAD/无条件 reset(R17/N32)。调用方须先确认无
 * CONFLICT(否则保留现场 fail-closed)。 */
export function rollbackCanonical(vault: string, txid: string, record: IntentRecord): ClassifiedTarget[] {
  const ctx = resolveTxCtx(vault);
  const restored: ClassifiedTarget[] = [];
  for (let i = 0; i < record.targets.length; i += 1) {
    const t = record.targets[i];
    const snap = readIntentBlob(vault, txid, 'snapshots', i);
    const outBuf = readIntentBlob(vault, txid, 'outputs', i);
    const output: string | null = deleteIsWrite(t) ? outBuf.toString('utf8') : null;
    const abs = path.join(vault, t.path);
    const snapshot = { existed: t.existed, bytes: t.existed ? snap.toString('utf8') : '' };
    const state = classifyWorktreeTarget(abs, output, snapshot);
    if (state === 'OUTPUT') {
      if (t.existed) {
        atomicWrite(abs, txid, snap);
      } else {
        try {
          fs.unlinkSync(abs);
        } catch {
          /* 已不存在。 */
        }
      }
      restored.push({ path: t.path, state: 'BEFORE' });
    } else {
      restored.push({ path: t.path, state });
    }
  }
  cleanupWorktreeTmp(vault, txid, record.targets.map((t) => t.path));
  removePrivateIndexResidue(ctx, txid);
  return restored;
}

/**
 * state/checkpoint/run_bootstrap 补完(§7/§8): BEFORE → OUTPUT, 然后**复用
 * git-transaction.commitTransaction**(N32 复审 P1-2: 私有 exact tree/commit-tree/
 * update-ref CAS/共享 index 状态门全部走加固原语, 不旁路), 受控安装共享 index;
 * 不重复业务 provider, 不主动回滚(不会因缺已提交 plan 死锁)。调用方须先确认无
 * CONFLICT 且 index ∈ {BASE, OUTPUT}。commit/ref 成功后为 canonical 终点, 不因
 * receipt 失败回滚。
 *
 * N32 复审 P2 加固: 计划输出为**删除**的目标, 若崩溃后工作树仍等于事务前快照
 * (classifyWorktreeTarget 判定 BEFORE), 必须执行受保护删除(removeWorktreeFile, 与
 * 正常写面 applyOutputs 同规格)才能进入 OUTPUT 终态并复核通过 —— 否则补完复核
 * (第 2 步「应为删除」)恒 CAS_CONFLICT, intent 被永久保留。只有 BEFORE 才动作,
 * CONFLICT(外部编辑)一律不动、不覆盖、不删除。
 */
export function completeStateTransaction(
  vault: string,
  txid: string,
  record: IntentRecord,
): { commit: string; tree: string; planDigest: string } {
  const ctx = resolveTxCtx(vault);
  const outputsAt = (i: number): string | null => {
    const buf = readIntentBlob(vault, txid, 'outputs', i);
    return deleteIsWrite(record.targets[i]) ? buf.toString('utf8') : null;
  };
  // 1) BEFORE → OUTPUT(补完: 写目标原子写; 删除目标受保护删除)。
  for (let i = 0; i < record.targets.length; i += 1) {
    const t = record.targets[i];
    const snap = readIntentBlob(vault, txid, 'snapshots', i);
    const output = outputsAt(i);
    const abs = path.join(vault, t.path);
    const snapshot = { existed: t.existed, bytes: t.existed ? snap.toString('utf8') : '' };
    const state = classifyWorktreeTarget(abs, output, snapshot);
    if (state === 'BEFORE' && output !== null) {
      atomicWrite(abs, txid, output);
    } else if (state === 'BEFORE' && output === null) {
      removeWorktreeFile(abs, txid);
    }
    // CONFLICT/OUTPUT 均不动(调用方已确认无 CONFLICT; OUTPUT 即终态)。
  }
  cleanupWorktreeTmp(vault, txid, record.targets.map((t) => t.path));
  // 2) 全部复核 OUTPUT(与 intent 输出 hash 一致; CONFLICT 已由调用方先行排除)。
  for (let i = 0; i < record.targets.length; i += 1) {
    const t = record.targets[i];
    const abs = path.join(vault, t.path);
    if (deleteIsWrite(t)) {
      const bytes = readWorktreeBytes(abs);
      const want = sha256Hex(readIntentBlob(vault, txid, 'outputs', i));
      if (bytes === null || sha256Of(bytes) !== want) {
        throw new TransactionError('CAS_CONFLICT', `补完复核失败: ${t.path} 输出 hash 失配`);
      }
    } else if (fileState(abs) !== 'absent') {
      throw new TransactionError('CAS_CONFLICT', `补完复核失败: ${t.path} 应为删除`);
    }
  }
  // 3) 私有 exact tree 重推导(输出字节已等于计划输出 → tree 必然等于计划 tree, §6);
  //    plan digest 重推导必须与 intent 记录一致(§8 先验证后动作, 不盲信)。
  //    只按实际变化集推导(no-op 目标不入 tree; 否则工作树与 HEAD 不同的 no-op 目标
  //    会伪失配 plan digest = 误判 tamper, 复审 Blocker)。
  const changeSet = actualChangeSetFromRecord(vault, txid, record);
  const derived = derivePlanIdentity(vault, record.baseHead, changeSet, txid);
  if (derived.planDigest !== record.planDigest) {
    throw new TransactionError('INVALID_INTENT', `补完: plan digest 重推导失配(§8)`);
  }
  // 4) commit 复用 git-transaction.commitTransaction(私有 index/commit-tree/update-ref
  //    CAS/共享 index 状态门/工作树期望状态重验全部走加固原语; expect 计划门双保险)。
  const ref = fullRefOf(record.branch ?? currentBranch(vault));
  const committed = runCommit({
    repoDir: vault,
    ref,
    baseHead: record.baseHead,
    txid: record.txid,
    kind: record.kind,
    targets: changeSet.map((s) => ({ path: s.path, outputBytes: s.output ?? undefined })),
    expect: { tree: derived.tree, planDigest: derived.planDigest },
  });
  // 5) 受控共享 index 安装 + 清理(§8: 成功 commit 后清理 intent)。
  installSharedIndex(ctx, record.baseHead, committed.commit, committed.tree);
  removeIntent(vault, txid);
  return { commit: committed.commit, tree: committed.tree, planDigest: committed.planDigest };
}

// ============================================================================
// 可达历史唯一 tx commit 验证(§6/§8: 交给 git-transaction.findTxCommit)
// ============================================================================

/** 恢复用派生身份: git-transaction 严格验证身份 + 确定性重推导的 exact tree/plan digest。 */
interface DerivedTxIdentity {
  /** findTxCommit 严格验证用身份(不自报 tree/planDigest; 由 targetBlobs 重算, 加固⑩)。 */
  identity: TxCommitIdentity;
  /** 确定性重推导的 exact tree(供 classifySharedIndexTree 与 planTree 报告)。 */
  tree: string;
  /** 重推导 plan digest(intent 记录核对; 构造时失配即抛 INVALID_INTENT)。 */
  planDigest: string;
}

function txIdentityFromRecord(vault: string, record: IntentRecord): DerivedTxIdentity {
  // 只按实际变化集推导(no-op 目标不入 exact tree/plan digest; 复审 Blocker:
  // fullWriteSet 与 actualWriteSet 恢复划分必须与执行期 computeChangeSet 一致)。
  const changeSet = actualChangeSetFromRecord(vault, record.txid, record);
  const derived = derivePlanIdentity(vault, record.baseHead, changeSet, `${record.txid}-identity`);
  if (derived.planDigest !== record.planDigest) {
    throw new TransactionError('INVALID_INTENT', `intent plan digest 重推导失配(tampered, §8)`);
  }
  return {
    // git-transaction 严格验证用身份(加固⑩: 不自报 tree/planDigest, findTxCommit 由
    // targetBlobs(mode+blob 规范集)重算 tree 与 digest)。
    identity: {
      txid: record.txid,
      kind: record.kind,
      baseHead: record.baseHead,
      targetBlobs: derived.targetBlobs,
    },
    tree: derived.tree,
    planDigest: derived.planDigest,
  };
}

// ============================================================================
// 恢复收敛(§7/§8; 崩溃入口; 进程内异常复用同一矩阵)
// ============================================================================

export interface PerTxReport {
  txid: string;
  outcome: 'committed' | 'completed' | 'rolled_back' | 'preserved' | 'invalid' | 'ref_race';
  conflicts: string[];
  restored: string[];
  message?: string;
  commit?: string;
  planTree?: string;
  kind?: string;
  baseHead?: string;
  branch?: string;
}

export interface RecoveryReport {
  scanned: string[];
  entries: PerTxReport[];
  /** 未收敛 intent(后续入口不得开始新事务, 直到人工修复; force 不能绕过, §8)。 */
  unresolved: string[];
}

/**
 * 已提交 plan 来源重验证: `<refOrCommit>:<path>` 内容 sha256 == digest(§8 能力重推导)。
 * 请求期锚定 HEAD(== base HEAD); 恢复期锚定 intent 的 baseHead(不可变, 与请求期
 * 验证等价; 不锚当前 HEAD——事务 commit 成功后 HEAD 上的 plan 文件已是新状态,
 * 用当前 HEAD 会造成「commit 已成功」收尾前的伪失配)。
 */
export function verifyCommittedPlanSource(
  vault: string,
  src: { path: string; digest: string },
  refOrCommit = 'HEAD',
): boolean {
  const ctx = resolveTxCtx(vault);
  if (!gitOk(ctx, ['cat-file', '-e', `${refOrCommit}:${src.path}`])) return false;
  try {
    // 按「内容」原样 hash(不用 trim 的 run(): 行尾换行等空白属于内容的一部分,
    // trim 会令含尾随换行的已提交文件伪失配, N33 适配器 run plan 以 '\n' 结尾)。
    const raw = git(ctx, ['show', `${refOrCommit}:${src.path}`], { allowFailure: true });
    if (raw === '') return false;
    return sha256Of(raw) === src.digest;
  } catch {
    return false;
  }
}

/**
 * state/checkpoint/run_bootstrap 补交前的能力复核(§8 复审 Blocker: 无能力不补交)。
 * 返回错误文案或 null:
 * - state/checkpoint: 持久化 planSource 与 base HEAD 的已提交文件 digest 重推导比对;
 * - run_bootstrap: 自描述已持久化、runFile ∈ 机器 namespace allowlist(受控 bootstrap
 *   路径, 如 `.assistant/watch-state.json`), 且 runFile 不得已存在于当前 HEAD
 *   (绝不覆盖既有 run)。
 */
function verifyStateCapability(ctx: RepoContext, record: IntentRecord): string | null {
  if (record.kind === 'state' || record.kind === 'checkpoint') {
    if (record.planSource === undefined) {
      return 'state/checkpoint 缺持久化 planSource(无能力, 保留不补交)';
    }
    if (!verifyCommittedPlanSource(ctx.repoDir, record.planSource, record.baseHead)) {
      return `planSource 与 base HEAD 已提交内容失配, 能力不可重推导, 保留不补交: ${record.planSource.path}`;
    }
    return null;
  }
  if (record.kind === 'run_bootstrap') {
    if (!record.runId || !record.inputFingerprint || !record.runFile) {
      return 'run_bootstrap 缺持久化自描述(runId/inputFingerprint/runFile, 无能力, 保留不补交)';
    }
    if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, record.runFile!))) {
      return `run_bootstrap runFile 超出机器 namespace allowlist, 拒绝补交: ${record.runFile}`;
    }
    if (gitOk(ctx, ['cat-file', '-e', `HEAD:${record.runFile}`])) {
      return `run_bootstrap runFile 已存在于 HEAD, 拒绝覆盖既有 run, 保留不补交: ${record.runFile}`;
    }
    return null;
  }
  return null;
}

/**
 * 单 intent 收敛(§7/§8): 先验证(结构白名单由 intent.ts 保证; 语义: kind 注册表、
 * plan digest 重推导、run_bootstrap 机器 namespace allowlist + 全目标 expected
 * absent) → 分类 worktree/index → 按 kind/commit 状态决定补完/回滚/收尾/保留。
 * 任一 CONFLICT / 未知 lock / 验证失败 → 保留现场 fail-closed。外部 ref 竞争 →
 * 停止并重新规划, 绝不 force。
 */
export function convergeIntent(vault: string, txid: string, record: IntentRecord): PerTxReport {
  const base = { txid, conflicts: [] as string[], restored: [] as string[] };
  let ctx: RepoContext;
  try {
    ctx = resolveTxCtx(vault);
  } catch (err) {
    return { ...base, outcome: 'preserved', message: `仓库不可解析, intent 保留: ${(err as Error).message}` };
  }
  try {
    // 0) 本事务私有 index 残留(崩溃点归属可证明)清理。
    removePrivateIndexResidue(ctx, txid);
    if (!verifyIntentBlobs(vault, txid)) {
      return { ...base, outcome: 'invalid', message: 'intent 快照/输出字节与记录哈希不符(篡改/损坏)' };
    }
    if (!TX_KINDS.includes(record.kind as TxKind)) {
      return { ...base, outcome: 'invalid', message: `kind 不在封闭注册表: ${record.kind}` };
    }
    // 1) 未知 Git 临界区(非本事务产物): fail-closed 保留, 不清理。
    try {
      assertNoGitCriticalSections(ctx, fullRefOf(record.branch ?? currentBranch(vault)));
    } catch (err) {
      return { ...base, outcome: 'preserved', message: (err as Error).message };
    }
    // 2) plan digest 重推导(intent 不盲信, §8; 失配 → INVALID_INTENT)。
    const identity = txIdentityFromRecord(vault, record);
    // 3) 能力重推导(§8 复审 Blocker: 持久化 plan/capability 静态校验——intent 内容
    //    判定, 与提交状态无关; 缺失/越界一律 invalid, 无能力不补交)。
    if (record.kind === 'state' || record.kind === 'checkpoint') {
      if (record.planSource === undefined) {
        return { ...base, outcome: 'invalid', message: 'state/checkpoint 缺持久化 planSource(无能力, 不补交, §8)' };
      }
      for (const t of record.targets) {
        if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, t.path))) {
          return { ...base, outcome: 'invalid', message: `state/checkpoint 目标超出机器 namespace allowlist: ${t.path}` };
        }
      }
    }
    if (record.kind === 'run_bootstrap') {
      if (!record.runId || !record.inputFingerprint || !record.runFile) {
        return { ...base, outcome: 'invalid', message: 'run_bootstrap 缺持久化自描述(runId/inputFingerprint/runFile), 不补交(§8)' };
      }
      for (const t of record.targets) {
        if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, t.path))) {
          return { ...base, outcome: 'invalid', message: `run_bootstrap 目标超出机器 namespace allowlist: ${t.path}` };
        }
        if (t.expected.kind !== 'absent') {
          return { ...base, outcome: 'invalid', message: `run_bootstrap 要求全目标 expected absent: ${t.path}` };
        }
      }
    }
    // 4) 分类 worktree / index。
    const classified = classifyAllTargetsFromIntent(vault, txid, record);
    const conflicts = classified.filter((c) => c.state === 'CONFLICT').map((c) => c.path);
    const indexState = classifySharedIndexTree(ctx, record.baseHead, identity.tree);
    // 5) 可达历史唯一 tx commit(§6: parent/tree/身份/trailers/blobs 全验证交给
    //    findTxCommit; 外部同字节提交不误认⑧)。
    let verified: string | null = null;
    try {
      const found = findTxCommit(vault, refHead(ctx, fullRefOf(record.branch ?? currentBranch(vault))), identity.identity);
      verified = found.commit;
    } catch (err) {
      if (err instanceof GitTransactionError && err.code === 'TX_AMBIGUOUS') {
        return { ...base, conflicts, outcome: 'preserved', message: '可达历史存在多个匹配 tx commit, fail-closed(§6)' };
      }
      verified = null; // TX_NOT_FOUND / UNKNOWN_REF → 继续按 ref 判定。
    }
    if (verified !== null) {
      // “commit 已成功”只收尾(§8): 不回滚、不重做; 仅受控同步 index + 清理。
      // index 同步到**当前** ref HEAD(外部后续 commit 时以新 HEAD 为准, 复核相对
      // 新 HEAD 无本事务未提交残留)。
      let currentHead: string;
      try {
        currentHead = refHead(ctx, fullRefOf(record.branch ?? currentBranch(vault)));
      } catch {
        return { ...base, conflicts, outcome: 'preserved', commit: verified, message: '已提交但分支不可解析, 保留现场' };
      }
      const currentTree = runCtx(ctx, ['rev-parse', '--verify', `${currentHead}^{tree}`], { allowFailure: true });
      try {
        installSharedIndex(ctx, record.baseHead, currentHead, currentTree);
      } catch (err) {
        return {
          ...base,
          conflicts,
          outcome: 'preserved',
          commit: verified,
          message: `已提交(${verified.slice(0, 12)}), 但共享 index 同步失败: ${(err as Error).message}`,
        };
      }
      cleanupWorktreeTmp(vault, txid, record.targets.map((t) => t.path));
      removeIntent(vault, txid);
      return { ...base, outcome: 'committed', conflicts, commit: verified, planTree: identity.tree, kind: record.kind, baseHead: record.baseHead, branch: record.branch };
    }
    // 6) ref 状态: 仍为 base → 续/回滚; 前进且无验证 commit → 外部竞争(不 force)。
    let currentRef: string;
    try {
      currentRef = refHead(ctx, fullRefOf(record.branch ?? currentBranch(vault)));
    } catch {
      return { ...base, conflicts, outcome: 'preserved', message: '分支不可解析, 保留现场' };
    }
    if (currentRef !== record.baseHead) {
      return { ...base, conflicts, outcome: 'ref_race', message: `ref 已前进 ${record.baseHead} -> ${currentRef} 且无本事务已验证 commit, 不 force(§8)` };
    }
    // 7) CONFLICT / index 非 BASE/OUTPUT → 保留现场 fail-closed(§7: 不覆盖、不
    //    unstage、不删除)。
    if (conflicts.length > 0 || indexState === 'CONFLICT' || indexState === 'UNKNOWN') {
      return {
        ...base,
        conflicts,
        outcome: 'preserved',
        message: conflicts.length > 0 ? `工作树 CONFLICT 保留现场: ${conflicts.join(', ')}` : `共享 index 状态 ${indexState}, 保留现场(不覆盖、不 unstage)`,
      };
    }
    // 8) 按重推导 kind 完成或回滚(§8: canonical 未 commit 只条件回滚并重新审批;
    //    state/checkpoint/run_bootstrap 补完同一事务, 不主动回滚)。
    if (record.kind === 'canonical') {
      const restored = rollbackCanonical(vault, txid, record);
      removeIntent(vault, txid);
      return {
        ...base,
        outcome: 'rolled_back',
        conflicts: [],
        restored: restored.map((r) => r.path),
        message: 'canonical 未成功 commit: OUTPUT→BEFORE 条件回滚, 交还上层重新审批(§8)',
        kind: record.kind,
        baseHead: record.baseHead,
        branch: record.branch,
      };
    }
    // 补交前动态能力复核(§8 复审 Blocker: planSource 与 base HEAD 重推导比对 /
    // run_bootstrap runFile 不得已存在; 无能力 → 保留现场不补交)。
    const capErr = verifyStateCapability(ctx, record);
    if (capErr !== null) {
      return { ...base, conflicts, outcome: 'preserved', message: capErr };
    }
    const done = completeStateTransaction(vault, txid, record);
    return { ...base, outcome: 'completed', conflicts: [], commit: done.commit, planTree: done.tree, kind: record.kind, baseHead: record.baseHead, branch: record.branch };
  } catch (err) {
    if (err instanceof TransactionError && err.code === 'INVALID_INTENT') {
      return { ...base, outcome: 'invalid', message: (err as Error).message };
    }
    return { ...base, outcome: 'preserved', message: `收敛失败, intent 保留: ${(err as Error).message}` };
  }
}

/**
 * 恢复入口(§8): 半写残留清理 → 逐一收敛 READY intent。只认 intent 登记的
 * txid/仓库, 不把外部 staged 冒充成自有事务, 不自动清除任何 staged(N32 不变式)。
 * 收敛(清理 intent)完成前, 新事务入口(executeTransaction)不得开始新事务。
 * opts.lock 提供时复用调用方已持有的生产 per-vault 锁(不重复取/不释放)。
 */
export async function recoverInterruptedTransactions(
  vault: string,
  opts: { lock?: VaultLock; lockStaleMs?: number } = {},
): Promise<RecoveryReport> {
  const lock = opts.lock ?? (await acquireVaultWriteLock(vault, { waitMs: 0, staleMs: opts.lockStaleMs ?? 1 }));
  const ownLock = opts.lock === undefined;
  try {
    cleanupIncomplete(vault); // §8: 无 READY 的半写残留视为未开始, 忽略并清理。
    const scanned: string[] = [];
    const entries: PerTxReport[] = [];
    const unresolved: string[] = [];
    for (const e of listIntents(vault)) {
      if (!e.validTxid) continue; // 白名单外条目: 不识别、不自动清理(§8 不盲信)。
      if (!e.ready) continue; // 半写残留已由 cleanupIncomplete 清理。
      scanned.push(e.name);
      let entry: PerTxReport;
      if (!e.valid) {
        // READY 但结构验证失败(schema/字段/大小/穿越/symlink/布局): fail-closed 保留,
        // 需人工修复; 不得被后续新事务绕过(§8: force 不能绕过未收敛 intent)。
        entry = { txid: e.name, outcome: 'invalid', conflicts: [], restored: [], message: e.error ?? 'intent 验证失败' };
      } else {
        try {
          const loaded = readIntent(vault, e.name);
          entry = convergeIntent(vault, e.name, loaded.record);
        } catch (err) {
          entry = { txid: e.name, outcome: 'invalid', conflicts: [], restored: [], message: `读取/验证失败: ${(err as Error).message}` };
        }
      }
      entries.push(entry);
      if (entry.outcome === 'invalid' || entry.outcome === 'preserved' || entry.outcome === 'ref_race') {
        unresolved.push(e.name);
      }
    }
    return { scanned, entries, unresolved };
  } finally {
    if (ownLock) lock.release();
  }
}

// ============================================================================
// 主执行器(§1–§6 全流程; 门控与 fault points 供崩溃/测试注入)
// ============================================================================

async function callGate(options: TransactionOptions | undefined, phase: GatePhase): Promise<void> {
  await options?.gates?.(phase);
}

function fire(options: TransactionOptions | undefined, point: string, ctx: { index?: number } = {}): void {
  const action = options?.faults?.[point];
  if (!action) return;
  const trig = options?.faultTrigger ? options.faultTrigger(point, ctx) : true;
  if (!trig) return;
  if (action === 'crash') throw new CrashSimulatedError(point);
  throw new TransactionError('INTERNAL_FAULT', `内部 fault point 触发: ${point}`);
}

export function makeTxid(vault: string, kind: string): string {
  // canonical tx-64(审计): 完整 64 位小写 hex, 与 codec.isTxId 同口径。
  return `tx-${sha256Hex(`${vault}|${kind}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`)}`;
}

/**
 * 目标路径级 Git 写事务(N32 / ADR-0021 §1–§6):
 * 锁(§3) → 先 recover 既有 intent(§8) → staged/未知锁零副作用拒绝(§2/§6) →
 * expected state 全量 preflight(§4) → 快照 → plan identity 推导 → intent 耐久化
 * (首个副作用前, §8) → 逐目标 temp+rename 写(每目标写前复核, §5) → 私有 exact
 * tree + commit-tree(§6) → 提交前复核点重 hash 全 writeSet + 复核 ref/tree/digest
 * (⑪) → update-ref CAS(§6 ③) → 共享 index 受控原子安装(§6) → 清理(§8)。
 * 进程内异常与崩溃共用 §7 状态矩阵(崩溃由 recoverInterruptedTransactions 收敛)。
 * ApprovalGate 在纯核心事务之外由 dsh 调用方取得; 本 helper 不 import DSH(铁律 1/3)。
 */
export async function executeTransaction(
  vault: string,
  request: TransactionRequest,
  options: TransactionOptions = {},
): Promise<TransactionResult> {
  // 公开注入面门禁(复审 Blocker): 一切 getter 之前完成 codec plain-data snapshot +
  // 字段白名单; Proxy/accessor/class 在此 fail-closed, 后续只消费本快照。
  request = snapshotRequest(request);
  const ctx = resolveTxCtx(vault); // NOT_GIT_REPO fail-closed(钉固 + env 清理, P1-2)
  const kind = request.kind;
  if (!isTransactionKind(kind)) throw new TransactionError('INVALID_REQUEST', `未知事务类型: ${kind}`);
  const branch = request.branch ?? currentBranch(vault);
  const ref = fullRefOf(branch);

  let txid: string | null = null;
  let intentRecord: IntentRecord | null = null;
  let lock: VaultLock | null = null;
  try {
    lock = await acquireVaultWriteLock(vault, { waitMs: options.lockWaitMs ?? 0, staleMs: options.lockStaleMs ?? 30_000 });
  } catch (err) {
    throw new TransactionError('LOCK_BUSY', `无法获取 per-vault 锁(fail-closed, §3): ${(err as Error).message}`);
  }
  try {
    // §8: 先收敛既有中断事务; 收敛完成前不开始任何新事务。
    const recovery = await recoverInterruptedTransactions(vault, { lock, lockStaleMs: options.recoveryLockStaleMs ?? 1 });
    if (recovery.unresolved.length > 0) {
      throw new TransactionError('INVALID_INTENT', `存在未收敛的中断事务, 拒绝开始新事务(fail-closed): ${recovery.unresolved.join(', ')}`);
    }
    fire(options, 'after_recover');

    // ===== preflight(§2/§4: 任一失败 → 零写入, intent 建立前零副作用) =====
    if (request.expectedHead !== undefined) {
      const head = runCtx(ctx, ['rev-parse', 'HEAD'], { allowFailure: true });
      if (head !== request.expectedHead) {
        throw new TransactionError('STALE_BASELINE', `期望 HEAD(生成/审批时)${request.expectedHead} != 当前 ${head}(生成→启动窗口, F)`);
      }
    }
    assertNoGitCriticalSections(ctx, ref);
    const { baseHead, targets } = normalizeRequest(ctx, request, ref);
    // kind 专属能力校验(§8 能力重推导: planSource / run_bootstrap allowlist+run 唯一)
    // 先于内容 CAS——既有 run/越界路径属能力违规, 与内容新旧无关, 先行 fail-closed。
    if (request.planSource !== undefined && kind !== 'state' && kind !== 'checkpoint') {
      throw new TransactionError('INVALID_REQUEST', `planSource 仅允许 state/checkpoint`);
    }
    if (kind === 'state' || kind === 'checkpoint') {
      // 复审 Blocker: state/checkpoint 无能力拒绝——必须携带已提交 planSource(§8 能力
      // 重推导), 且 writeSet 路径严格固定机器 namespace allowlist, 永不 canonical 资产。
      if (request.planSource === undefined) {
        throw new TransactionError('INVALID_REQUEST', 'state/checkpoint 必须带已提交 planSource(§8 能力重推导, 无能力拒绝)');
      }
      if (!verifyCommittedPlanSource(vault, request.planSource)) {
        throw new TransactionError('INVALID_REQUEST', `已提交 plan 来源缺失/失配: ${request.planSource.path}`);
      }
      for (const t of targets) {
        if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, t.path))) {
          throw new TransactionError('INVALID_REQUEST', `state/checkpoint 目标须 ∈ 机器 namespace allowlist(永不 canonical 资产): ${t.path}`);
        }
      }
    }
    if (kind === 'run_bootstrap') {
      if (!request.runId || !request.inputFingerprint || !request.runFile) {
        throw new TransactionError('INVALID_REQUEST', 'run_bootstrap 必须带 runId/inputFingerprint/runFile(§8)');
      }
      if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, request.runFile!))) {
        throw new TransactionError('INVALID_REQUEST', `run_bootstrap runFile 须 ∈ 机器 namespace allowlist: ${request.runFile}`);
      }
      for (const t of targets) {
        if (!MACHINE_STATE_ALLOW.some((a) => matchAllow(a, t.path)) || !t.expected.absent) {
          throw new TransactionError('INVALID_REQUEST', `run_bootstrap 目标须 ∈ 机器 namespace 且 expected absent: ${t.path}`);
        }
      }
      if (gitOk(ctx, ['cat-file', '-e', `HEAD:${request.runFile}`])) {
        throw new TransactionError('INVALID_REQUEST', `run_bootstrap run 目录已存在, 拒绝覆盖既有 run(§8): ${request.runFile}`);
      }
    }
    const pre = preflightTargets(ctx, targets, request, branch);
    fire(options, 'after_preflight');
    const changeSet = computeChangeSet(targets);
    if (changeSet.length === 0) {
      throw new TransactionError('INVALID_REQUEST', 'writeSet 剔除 no-op 后无实际变化, 拒绝空事务(§4)');
    }
    // no-op 已剔除 → 私有 exact tree 的变化集即实际变化集(§4)。
    txid = request.txid ?? makeTxid(vault, kind);
    // 统一 txid 契约(审计): canonical tx-64, 直接消费 codec.isTxId。
    if (!isTxId(txid)) throw new TransactionError('INVALID_REQUEST', `非法 txid(须 canonical tx-64 小写 hex): ${txid}`);

    // ===== plan identity 纯字节推导(N32 复审 P1-1: intent READY 之前零 ODB/index/
    // worktree/ref 副作用 —— 不调 hash-object -w、不建私有 index, 只读 base tree +
    // 纯内存重建; intent 与 commit 共用, materialize 后由 commitTransaction 的
    // expect 计划门做一致验证) =====
    const changeSetSpecs = changeSet.map((rel) => ({ path: rel, output: targets.find((t) => t.path === rel)!.output ?? null }));
    const pure = derivePlanIdentityPure(
      vault,
      baseHead,
      changeSetSpecs.map((s) => ({ path: s.path, outputBytes: s.output ?? undefined })),
    );

    // ===== intent 耐久化(§8: 首个工作树/index 变更之前; 原子写 + fsync + READY) =====
    const meta = targets.map((t) => {
      const idx = changeSet.indexOf(t.path);
      const snapshot = pre.find((p) => p.spec.path === t.path)!;
      return {
        path: t.path,
        expected: { present: !t.expected.absent, sha256: t.expected.absent ? '' : t.expected.sha256 },
        existed: snapshot.existed,
        snapshotSha256: snapshot.currentBytes === null ? EMPTY_SHA : sha256Of(snapshot.currentBytes),
        // no-op 目标(未入变化集): outputs blob = 快照字节(输出 == 当前), 恢复矩阵恒为
        // BEFORE/OUTPUT; 变化集写目标: 输出字节 hash; 变化集删除目标: EMPTY_SHA。
        outputSha256: idx >= 0 ? sha256Of(t.output ?? '') : snapshot.currentBytes === null ? EMPTY_SHA : sha256Of(snapshot.currentBytes),
      };
    });
    intentRecord = {
      schema: INTENT_SCHEMA_VERSION,
      txid,
      kind,
      branch,
      baseHead,
      planDigest: pure.planDigest,
      createdAt: new Date().toISOString(),
      targets: meta.map((m) => ({
        path: m.path,
        expected: m.expected.present ? { kind: 'content', sha256: m.expected.sha256 } : { kind: 'absent' },
        existed: m.existed,
        snapshotSha256: m.snapshotSha256,
        outputSha256: m.outputSha256,
      })),
      // §8 能力持久化(复审 Blocker: plan/capability 必须落盘, 恢复时重推导验证):
      // state/checkpoint 携带 planSource(已提交 plan 来源), run_bootstrap 携带自描述。
      ...(kind === 'state' || kind === 'checkpoint'
        ? { planSource: request.planSource! }
        : {}),
      ...(kind === 'run_bootstrap'
        ? { runId: request.runId!, inputFingerprint: request.inputFingerprint!, runFile: request.runFile! }
        : {}),
    };
    const blobs: IntentBlobSet = {
      snapshots: targets.map((t) => {
        const cur = pre.find((p) => p.spec.path === t.path)!.currentBytes;
        return cur === null ? Buffer.alloc(0) : Buffer.from(cur, 'utf8');
      }),
      outputs: targets.map((t) => {
        const idx = changeSet.indexOf(t.path);
        if (idx >= 0) return Buffer.from(t.output ?? '', 'utf8');
        const cur = pre.find((p) => p.spec.path === t.path)!.currentBytes;
        return cur === null ? Buffer.alloc(0) : Buffer.from(cur, 'utf8');
      }),
    };
    persistIntent(vault, intentRecord, blobs);
    await callGate(options, 'intent-ready'); // 崩溃点1: intent 已耐久, ODB/index/工作树零副作用

    // ===== 逐目标写(§5; 首写前已全量复核, 每目标写前再复核; 崩溃点2 在其中) =====
    const specByPath = new Map(targets.map((t) => [t.path, t]));
    await applyOutputs(vault, txid, changeSet, specByPath, options.gates, request.hooks);
    cleanupWorktreeTmp(vault, txid, changeSet);

    // ===== commit 阶段: 复用 git-transaction.commitTransactionAsync(N32 复审 P1-2:
    // 私有 exact tree / commit-tree / update-ref CAS / shared index 状态门 / 工作树
    // 期望状态重验全部走加固原语, 不旁路; expect 计划门把 materialize 与纯字节计划
    // 推导钉死一致; 异步钩子承载 crash gate: private-index/commit-object/review-point) =====
    const committed = await runCommitAsync({
      repoDir: vault,
      ref,
      baseHead,
      txid,
      kind,
      targets: changeSetSpecs.map((s) => ({ path: s.path, outputBytes: s.output ?? undefined })),
      expect: { tree: pure.tree, planDigest: pure.planDigest },
      hooks: {
        // 崩溃点3: 私有 index 已建、exact tree 已冻结(write-tree 之后)。
        afterWriteTree: () => callGate(options, 'private-index'),
        // 崩溃点4: commit object 已生成但 ref 未动(悬空)。
        afterCommitObject: () => callGate(options, 'commit-object'),
        // 提交前复核点(⑪): update-ref CAS 前重验全 writeSet 工作树/共享 index staged/
        // ref 仍 base —— 由 commitTransaction 内部 assertSharedIndexClean +
        // assertTargetWorktreeState + symbolic HEAD 检查承担; 本钩子承载编排注入点。
        beforeRefCas: async () => {
          request.hooks?.beforeRefCas?.();
          await callGate(options, 'review-point'); // 测试专用门: 不协作编辑器在此插入后 proceed
          fire(options, 'before_ref_cas');
        },
      },
    });
    if (!isGitOid(committed.commit, ctx.oidLen)) {
      throw new TransactionError('GIT_ERROR', `commit-tree 输出异常: ${committed.commit}`);
    }
    // 计划一致性(commitTransaction expect 门已保证; 显式复核防回归)。
    if (committed.tree !== pure.tree || committed.planDigest !== pure.planDigest) {
      throw new TransactionError('CAS_CONFLICT', `私有 exact tree 与计划不符(§6)`);
    }
    await callGate(options, 'ref-cas'); // 崩溃点5: commit 已可达(§6 canonical 终点)

    // ===== 共享 index 受控原子安装(§6; P1-3 TOCTOU 加固: 拿锁后 identity/bytes/tree
    // CAS 复核, 事务期间作者 git add 不得被覆盖) =====
    request.hooks?.beforeSharedIndexInstall?.();
    fire(options, 'before_shared_index');
    installSharedIndex(ctx, baseHead, committed.commit, committed.tree, request.hooks?.afterSharedIndexLock);
    await callGate(options, 'shared-index-install'); // 崩溃点6

    // ===== 清理(§8: 成功 commit 后删除 intent, 不残留) =====
    fire(options, 'before_cleanup');
    removeIntent(vault, txid);
    return {
      txid,
      kind,
      branch,
      ref,
      baseHead,
      newHead: committed.commit,
      commit: committed.commit,
      tree: committed.tree,
      planDigest: committed.planDigest,
      actualChangeSet: changeSet,
      outcome: 'committed',
    };
  } catch (err) {
    if (isCrashSimulated(err)) {
      // 模拟 SIGKILL/断电: 不执行任何收尾(回滚/清理都不运行)。进程内模拟无法真正
      // 死亡, 因此锁在此显式释放(等价于「持有者消失」——真实 SIGKILL 下锁由恢复
      // 入口按 pid 死亡 + 心跳过期回收, 语义一致)。
      throw err;
    }
    if (intentRecord !== null) {
      const recovered = inProcessMatrix(vault, txid!, intentRecord, err);
      if (recovered !== null) return recovered;
    }
    throw err;
  } finally {
    lock?.release();
  }
}

/**
 * 进程内异常的状态矩阵(§7): 与崩溃恢复同语义; 差别仅在 commit/ref 已成功(canonical
 * 终点)或 state 补完成功时返回 TransactionResult。CONFLICT/未知 index/外部 lock →
 * 保留现场并附加 intentKept/preserved 供上层(worker fatal)报告(§7: 不覆盖、
 * 不 unstage、不删除)。
 */
function inProcessMatrix(vault: string, txid: string, record: IntentRecord, err: unknown): TransactionResult | null {
  let ctx: RepoContext;
  try {
    ctx = resolveTxCtx(vault);
  } catch {
    markError(err, { intentKept: true });
    return null;
  }
  const ref = fullRefOf(record.branch ?? currentBranch(vault));
  // commit/ref 成功是 canonical 终点(§6): 不因后续状态 receipt 失败而回滚历史。
  let commitReached = false;
  try {
    if (refHead(ctx, ref) !== record.baseHead) {
      const identity = txIdentityFromRecord(vault, record);
      commitReached = findTxCommit(vault, refHead(ctx, ref), identity.identity) !== undefined;
    }
  } catch {
    commitReached = false;
  }
  if (commitReached) {
    markError(err, { intentKept: false });
    return null;
  }
  const classified = classifyAllTargetsFromIntent(vault, txid, record);
  const conflicts = classified.filter((c) => c.state === 'CONFLICT').map((c) => c.path);
  let indexConflict = false;
  try {
    const identity = txIdentityFromRecord(vault, record);
    const st = classifySharedIndexTree(ctx, record.baseHead, identity.tree);
    indexConflict = st === 'CONFLICT' || st === 'UNKNOWN';
  } catch {
    indexConflict = true;
  }
  if (conflicts.length > 0 || indexConflict) {
    // REF_CAS 竞争: 整体保留(不条件回滚, 避免抹掉外部推进后的判定依据, §7/§8)。
    if ((err as { code?: string }).code === 'REF_CAS_CONFLICT') {
      markError(err, { intentKept: true, preserved: classified.map((c) => c.path) });
      return null;
    }
    // 其余矩阵错误: 非冲突 OUTPUT 目标条件回滚, CONFLICT 目标与 intent 保留(人工恢复)。
    const preserved = conflicts;
    try {
      rollbackCanonical(vault, txid, record);
    } catch {
      /* 回滚失败不掩盖原错误; intent 保留。 */
    }
    markError(err, { intentKept: true, preserved });
    return null;
  }
  if (record.kind === 'canonical') {
    rollbackCanonical(vault, txid, record);
    removeIntent(vault, txid);
    markError(err, { intentKept: false });
    return null;
  }
  // state/checkpoint/run_bootstrap: 按 §7 补完(与 recovery 同路径); 补交前动态能力
  // 复核(§8 复审 Blocker: 无能力不补交), 失败则保留 intent。
  try {
    const capErr = verifyStateCapability(ctx, record);
    if (capErr !== null) {
      markError(err, { intentKept: true });
      return null;
    }
    const done = completeStateTransaction(vault, txid, record);
    return {
      txid,
      kind: record.kind as TxKind,
      branch: record.branch ?? currentBranch(vault),
      ref,
      baseHead: record.baseHead,
      newHead: done.commit,
      commit: done.commit,
      tree: done.tree,
      planDigest: done.planDigest,
      actualChangeSet: actualChangeSetFromRecord(vault, txid, record).map((c) => c.path),
      outcome: 'completed_after_error',
    };
  } catch (completionErr) {
    markError(err, { intentKept: true });
    return null;
  }
}

function markError(err: unknown, info: { intentKept: boolean; preserved?: string[] }): void {
  const e = err as Error & { intentKept?: boolean; preserved?: string[] };
  e.intentKept = info.intentKept;
  if (info.preserved) e.preserved = info.preserved;
}

// ============================================================================
// 进程集成驱动(worker fixture 协议; 参考锁 .git/novelcraft-lock 与生产锁并存)
// ============================================================================

interface WorkerPlan {
  txid?: string;
  kind: TxKind;
  branch?: string;
  base: string;
  targets: Array<{ rel: string; expected: { absent: boolean; sha256: string }; output: string }>;
  /** state/checkpoint: 已提交 plan 来源(§8 能力重推导; 由夹具随计划下发)。 */
  planSource?: { path: string; digest: string };
}

interface WorkerOpts {
  gate?: string;
}

type WorkerEmit = (o: Record<string, unknown>) => void;
type WorkerWaitCmd = (pred: (o: Record<string, unknown>) => boolean, what: string) => Promise<Record<string, unknown>>;

let emitWorker: WorkerEmit | null = null;
let waitCmdWorker: WorkerWaitCmd | null = null;
let workerIoAttached = false;

/**
 * 自挂载 worker 协议 IO(stdout 逐行 JSON 事件 + stdin 逐行命令队列/等待器)。
 * 仅在驱动函数被调用时挂载(worker 子进程场景); 测试进程 import 本模块零副作用。
 */
function ensureWorkerIo(): void {
  if (workerIoAttached) return;
  workerIoAttached = true;
  emitWorker = (o: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(o)}\n`);
  };
  const queue: Record<string, unknown>[] = [];
  let waiter: { pred: (o: Record<string, unknown>) => boolean; resolve: (o: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        w.resolve(o);
      } else {
        queue.push(o);
      }
    }
  });
  waitCmdWorker = (pred, what) => {
    const find = (): Record<string, unknown> | undefined => {
      for (let i = 0; i < queue.length; i += 1) {
        if (pred(queue[i])) return queue.splice(i, 1)[0];
      }
      return undefined;
    };
    const hit = find();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WAIT_CMD_TIMEOUT:${what}`)), 120_000);
      waiter = {
        pred,
        resolve: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      };
    });
  };
}

/** 挂载 worker 协议 IO(程序化注入; 缺省自挂载见 ensureWorkerIo)。 */
export function attachWorkerIo(emit: WorkerEmit, waitCmd: WorkerWaitCmd): void {
  emitWorker = emit;
  waitCmdWorker = waitCmd;
  workerIoAttached = true;
}

async function workerGate(phase: GatePhase): Promise<void> {
  if (!emitWorker || !waitCmdWorker) return;
  emitWorker({ t: 'phase', phase });
  const o = await waitCmdWorker((c: Record<string, unknown>) => c?.cmd === 'proceed' || c?.cmd === 'abort', phase);
  if (o?.cmd === 'abort') {
    throw new TransactionError('ABORTED', 'ABORTED');
  }
}

function planToRequest(plan: WorkerPlan, vault: string): TransactionRequest {
  return {
    kind: plan.kind,
    purpose: `worker tx ${plan.txid ?? ''}`,
    txid: plan.txid,
    branch: plan.branch ?? currentBranch(vault),
    expectedHead: plan.base,
    writeSet: plan.targets.map((t) => ({
      path: t.rel,
      expected: { absent: t.expected.absent, sha256: t.expected.sha256 },
      output: t.output,
    })),
    ...(plan.planSource !== undefined ? { planSource: plan.planSource } : {}),
  };
}

/**
 * 事务进程驱动(worker `--mode tx`): PENDING_INTENTS 前置 → executeTransaction
 * (per-vault 锁由 lock.ts 提供, LOCK_BUSY fail-closed; 门控: CRASH_GATES 逐点
 * emit + 等待 proceed/abort) → done(committed) / error(intentKept/preserved)。
 * 崩溃点由测试 SIGKILL 本进程表达(任何内存回滚都不可能运行), 恢复收敛交给全新
 * recover 进程。协议统一: 全仓仅一把 lock.ts 锁(集成要求, 无第二锁协议)。
 */
export async function runTransactionProcess(vault: string, plan: WorkerPlan, opts: WorkerOpts = {}): Promise<void> {
  ensureWorkerIo();
  const pending = listIntents(vault).filter((e) => e.ready || !e.validTxid).map((e) => e.name);
  if (pending.length > 0) {
    throw new TransactionError('PENDING_INTENTS', `存在未收敛 intent: ${pending.join(',')}; 先经 recover 收敛(§8)`);
  }
  const watchPoints = new Set<string>(GATE_PHASES);
  if (opts.gate !== 'review-point') watchPoints.delete('review-point'); // 仅 review 场景开启该门
  const request = planToRequest(plan, vault);
  const result = await executeTransaction(vault, request, {
    gates: async (phase) => {
      if (watchPoints.has(phase)) await workerGate(phase);
    },
  });
  emitWorker?.({ t: 'done', state: 'committed', commit: result.commit, summary: { txid: result.txid, kind: result.kind, branch: result.branch, base: result.baseHead, planTree: result.tree } });
}

/**
 * 恢复进程驱动(worker `--mode recover`): 半写残留清理 → 无 READY intent →
 * no-intent; 单一 READY intent → recoverInterruptedTransactions 收敛(生产 per-vault
 * 锁由 lock.ts 提供; 持锁者已死(SIGKILL)时 staleMs=1 即时回收, 存活持锁 →
 * LOCK_BUSY fail-closed) → done(completed / rolled-back / conflict-preserved) /
 * error(EXTERNAL_REF_RACE / INVALID_INTENT …)。
 */
export async function recoverTransactionProcess(vault: string): Promise<void> {
  ensureWorkerIo();
  const ready = listIntents(vault).filter((e) => e.ready && e.valid && e.validTxid);
  if (ready.length === 0) {
    emitWorker?.({ t: 'done', state: 'no-intent', commit: null, summary: { v: 'none' } });
    return;
  }
  if (ready.length > 1) {
    throw new TransactionError('INVALID_INTENT', `多 intent 并存, 需人工: ${ready.map((e) => e.name).join(',')}`);
  }
  const txid = ready[0].name;
  const report = await recoverInterruptedTransactions(vault, { lockStaleMs: 1 });
  const entry = report.entries.find((e) => e.txid === txid);
  if (!entry) {
    throw new TransactionError('INVALID_INTENT', `intent 读取失败: ${txid}`);
  }
  switch (entry.outcome) {
    case 'committed':
    case 'completed':
      emitWorker?.({
        t: 'done',
        state: 'completed',
        commit: entry.commit ?? null,
        summary: { txid: entry.txid, kind: entry.kind ?? '', branch: entry.branch ?? '', base: entry.baseHead ?? '', planTree: entry.planTree ?? null },
      });
      return;
    case 'rolled_back':
      emitWorker?.({ t: 'done', state: 'rolled-back', commit: null, summary: { txid: entry.txid, restored: entry.restored } });
      return;
    case 'preserved':
      emitWorker?.({
        t: 'done',
        state: 'conflict-preserved',
        commit: null,
        summary: { txid: entry.txid, preserved: entry.conflicts, restored: entry.restored },
      });
      return;
    case 'ref_race':
      throw new TransactionError('EXTERNAL_REF_RACE', entry.message ?? 'HEAD 前移且无验证 tx commit, 保留现场');
    default:
      throw new TransactionError('INVALID_INTENT', entry.message ?? `intent 无效: ${txid}`);
  }
}
