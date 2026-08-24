/**
 * git-transaction.ts — ADR-0021 §6 Git 提交协议原语(N32, 2026-08-15; 独立审查加固①②轮)。
 *
 * 范围(只做加法, 铁律 4): 事务私有 index + exact tree + `commit-tree`(固定 novelcraft
 * author/committer + 确定性日期 + `txid`/`kind`/`plan-digest` trailers)+
 * `update-ref <ref> <new> <base>` 三参 CAS + 可达历史唯一 tx commit 严格验证
 * (规范 writeSet 重算 plan digest/tree + 字节级重算预期 commit OID)+ 新 HEAD 共享
 * index bytes 构建。
 *
 * 实现约束(N32/ADR-0021 §6): 只用 execFileSync 调 git CLI; 不 import 任何 DSH(铁律 1,
 * 核心包零 DSH 依赖); 业务写面禁用 `git add`/`git commit`(本模块以 hash-object -w +
 * update-index --cacheinfo/--force-remove + write-tree + commit-tree + update-ref 完成)。
 *
 * 独立审查加固(第 1 轮):
 * ① 环境与仓库钉固: buildEnv 从最小 allowlist 构造(只继承非 GIT_* 白名单键), 因此
 *    GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/
 *    GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_NAMESPACE/GIT_REPLACE_REF_BASE/
 *    GIT_INDEX_FILE/GIT_CONFIG_*(含动态 GIT_CONFIG_KEY_<n>)等全部重定向/配置注入变量
 *    天然被清除; 每次调用再以受控 `--git-dir=<abs>`/`--work-tree=<abs>` 钉住仓库
 *    (命令行的 --git-dir 优先级高于 env, 两仓 GIT_DIR 攻击免疫), 并校验解析到的
 *    worktree/gitdir 与 repoDir 精确一致(拒绝在祖先/非预期仓库操作);
 *    LC_ALL=C/LANG=C 固定英文错误输出(错误分类依赖稳定文本)。
 * ② replace refs 禁用与 provenance 状态拒绝: 所有历史/对象命令带
 *    `--no-replace-objects` + `GIT_NO_REPLACE_OBJECTS=1`; 仓库存在 refs/replace/*、
 *    info/grafts、shallow 等改变对象/历史 provenance 的状态一律 REPO_STATE_UNSAFE
 *    fail-closed(find/commit 均先在真实历史/对象上工作前拒绝)。
 * ③ 确定性 commit identity: author/committer 固定 novelcraft 身份 + 确定性日期
 *    (规范常量 NOVELCRAFT_TX_DATE, 非墙钟), 使 commit OID 成为 tx 参数的纯函数
 *    (同 tx 重试 → 同 OID, 幂等); find 以「重算预期 commit 对象、只接受 OID 字节级相同」
 *    为最强门(防外部以相同 trailers/日期伪造), 并显式复核身份+日期+tree+parent+
 *    trailers+目标 blobs(纵深)。
 * ④ ref 收窄: 只允许目标 ref == 当前 symbolic HEAD 对应的 refs/heads/*(拒 tag/任意
 *    ref); update-ref 前再次验证 symbolic HEAD 未在事务期间切换(切换 → REF_CAS_FAILED,
 *    不写目标 ref)。
 * ⑤ sha1/sha256 object format 双支持(40/64-hex OID; 以 `rev-parse --show-object-format`
 *    探测); plan digest 仍为 sha256(与 object format 无关)。
 * ⑥ 路径拒绝: Windows drive 前缀/UNC/控制字符/大小写不敏感 `.git` 段(跨平台 vault)。
 * ⑦ CAS 分类: 紧邻 update-ref 的锁/CAS 失败(含事务 hook 拒绝)一律 REF_CAS_FAILED;
 *    提交事务参数提供 hooks.beforeRefCas 测试钩子, 覆盖「早期检查之后、update-ref 之前」
 *    的真实 CAS 窗口。
 *
 * 独立审查加固(第 2 轮):
 * ⑧ P0 对象重定向: GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES 等随
 *    allowlist 一并清除 —— hash-object -w/write-tree/commit-tree 的对象写入只落真实
 *    仓库 ODB, 任何环境注入都不可产生外部对象。
 * ⑨ shared index 状态门: 任何预存 staged(shared index != HEAD)在 commit 前一律
 *    STAGED_CONFLICT; 紧邻 update-ref 前重验 shared index.lock(INDEX_LOCKED)/
 *    staged(STAGED_CONFLICT)/目标工作树期望状态(写目标内容 sha256 == 计划输出、
 *    删除目标已缺席 → 失配 WORKTREE_CONFLICT)/symbolic HEAD 未切换(REF_CAS_FAILED)。
 * ⑩ identity 自足重算: TxCommitIdentity 携带规范 writeSet(path+mode+blob; 删除目标
 *    mode/blob 为 null), find 由 writeSet 重算 exact tree 与 plan digest(不信任 identity
 *    自报的 tree/digest), 再以重算值构造预期 commit OID; 重复 trailers 拒绝(而非 Map
 *    覆盖, interpret-trailers 解析到重复 key 即不认)。
 * ⑪ 私有 index 隔离: 事务私有 index 启动时同时检查其 `.lock`(无法证明归属 →
 *    INDEX_LOCKED); finally 以 (dev,ino,size,sha256) 守卫只删除本调用创建的私有 index, 绝不删除
 *    并发者替换后的文件。
 *
 * fail-closed(N32/ADR-0021 §6 失败关闭):
 * - 未知 ref(HEAD 非 symbolic ref = detached、非 refs/heads/*, 或 unborn 分支)→ UNKNOWN_REF;
 * - 仓库状态改变 provenance(replace refs/grafts/shallow)→ REPO_STATE_UNSAFE;
 * - 共享 `.git/index.lock` 存在且无法证明归属 / 事务私有 index 或其 .lock 同 txid 残留
 *   → INDEX_LOCKED;
 * - 共享 index 预存 staged(commit 前或 update-ref 前重验)→ STAGED_CONFLICT;
 * - 目标工作树与计划期望状态不符(update-ref 前重验)→ WORKTREE_CONFLICT;
 * - `update-ref` CAS 失败(外部 commit 抢先推进 ref / ref lock / hook 拒绝)→ REF_CAS_FAILED,
 *   绝不 force;
 * - writeSet 目标路径校验失败(空/绝对/`..` 路径穿越/空段/大小写不敏感 `.git` 段/
 *   Windows drive/UNC/控制字符/超限)→ BAD_TARGET。
 *
 * 上层职责拆分(本模块不越界): expected-state/内容 CAS preflight、工作树同目录 temp+rename、
 * 共享 index 原子安装(拿本模块的 bytes 做 temp+rename 到 `.git/index`)、transaction intent
 * 恢复编排 —— 都在事务层实现; 本模块只保证「私有 exact tree + ref CAS」与「按规范
 * writeSet 在可达历史严格验证唯一 commit(重算 tree/digest + 字节级 OID)」(ADR §6:
 * commit/ref 成功是 canonical 终点, 不因后续 receipt/index 同步失败回滚历史)。
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../hash.js';

// ============================================================================
// 错误分类(fail-closed: 先验证后动作; 一切 git 失败必须可归类)
// ============================================================================

export type GitTransactionErrorCode =
  | 'UNKNOWN_REF' // HEAD/ref 无法解析(detached/unborn)或 head 参数非法; 不猜测基线
  | 'INDEX_LOCKED' // 共享 index.lock / 事务私有 index 或其 .lock 存在且无法证明归属
  | 'REF_CAS_FAILED' // update-ref <ref> <new> <base> CAS 失败(外部推进/ref lock/hook 拒绝), 不 force
  | 'BAD_TARGET' // writeSet 路径/txid/kind/mode 校验失败(路径穿越等, N32 §8 白名单精神)
  | 'TX_NOT_FOUND' // 可达历史中不存在满足全部严格条件的唯一 tx commit
  | 'TX_AMBIGUOUS' // 可达历史中存在多个满足全部严格条件的 tx commit(fail-closed)
  | 'REPO_STATE_UNSAFE' // 仓库状态改变 provenance(replace refs/grafts/shallow/未知 object format)
  | 'STAGED_CONFLICT' // 共享 index 预存 staged(commit 前或 update-ref 前重验)
  | 'WORKTREE_CONFLICT' // 目标工作树与计划期望状态不符(update-ref 前重验)
  | 'PLAN_MISMATCH' // 执行层计划一致性门(N32 复审 P1): materialize 的 exact tree/plan digest
  //   与调用方注入的纯字节计划推导不符 → 不生成 commit(防纯推导/物化分叉污染 intent)
  | 'GIT_ERROR'; // 其他 git CLI 失败

export class GitTransactionError extends Error {
  readonly code: GitTransactionErrorCode;
  readonly details?: unknown;

  constructor(code: GitTransactionErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GitTransactionError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// 常量与正则
// ============================================================================

const NOVELCRAFT_NAME = 'novelcraft';
const NOVELCRAFT_EMAIL = 'novelcraft@example.invalid';
/** 规范 tx commit 时间(UTC epoch 秒 = 2026-01-01T00:00:00Z): 确定性日期常量,
 * 使 commit OID 成为 tx 参数的纯函数(同 tx 重试 → 同 OID)。 */
export const NOVELCRAFT_TX_DATE = 1767225600;
const NOVELCRAFT_TX_DATE_STR = '2026-01-01 00:00:00 +0000';

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type ObjectFormat = 'sha1' | 'sha256';

/** 按 object format 判 OID 形态(40/64-hex; 对外导出供执行层复用, N32 复审 P1-2)。 */
export function isOid(s: string, len: 40 | 64): boolean {
  return len === 40 ? SHA1_RE.test(s) : SHA256_RE.test(s);
}

// ============================================================================
// git CLI 薄封装(execFileSync; 显式控制 env + 钉固 --git-dir/--work-tree)
// ============================================================================

interface GitExecOpts {
  repoDir: string;
  args: string[];
  env?: Record<string, string>;
  input?: string | Buffer;
  /** 失败不抛错, 返回 ''(探测类调用自行判定)。 */
  allowFailure?: boolean;
  /** latin1 原始字节输出(树对象解析等二进制读取用; 默认 utf8)。 */
  binary?: boolean;
}

/**
 * 最小 allowlist 环境基座(加固①⑧; 对外导出供执行层复用, N32 复审 P1-2: 生产
 * execute/recovery 与 git-transaction 共用同一 env 清理原语, 不得旁路)。
 * 只继承非 GIT_* 白名单键, 因此全部 Git 重定向/配置注入变量 —— GIT_DIR、
 * GIT_WORK_TREE、GIT_COMMON_DIR、GIT_OBJECT_DIRECTORY、
 * GIT_ALTERNATE_OBJECT_DIRECTORIES(外部对象库)、GIT_NAMESPACE、GIT_REPLACE_REF_BASE、
 * GIT_INDEX_FILE、GIT_CEILING_DIRECTORIES、GIT_CONFIG_COUNT/GIT_CONFIG_KEY_<n>/
 * GIT_CONFIG_VALUE_<n>、GIT_CONFIG_SYSTEM/GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM 等 ——
 * 全部显式清除(不继承即 unset; 对象写入不可能被导向外部目录);
 * 固定 LC_ALL=C(英文错误输出, 错误分类依赖稳定文本);
 * 默认 GIT_NO_REPLACE_OBJECTS=1(加固②, env 级双保险)。
 * extra 只允许显式白名单内的受控 GIT_* 键: GIT_INDEX_FILE(逐调用私有 index, 本模块唯一
 * 受控重定向)、GIT_NO_REPLACE_OBJECTS、git 身份/日期键(作者/提交者 name/email/date);
 * 其余 GIT_* 为内部错误(防止未来代码误加重定向/配置注入攻击面)。
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];

/** extra 中允许出现的受控 GIT_* 键(其余 GIT_* 一律内部错误)。 */
const GIT_ALLOWED_EXTRA: ReadonlySet<string> = new Set([
  'GIT_INDEX_FILE', // 事务私有 index(逐调用受控; 绝不来自外部环境)
  'GIT_NO_REPLACE_OBJECTS', // 禁 replace refs 的 env 级双保险
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

export function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      if (/^GIT_/.test(k) && !GIT_ALLOWED_EXTRA.has(k)) {
        throw new GitTransactionError('GIT_ERROR', `内部错误: 不允许的 GIT_* env 注入: ${k}`);
      }
      env[k] = extra[k];
    }
  }
  return env;
}

/** 全部 git 调用的钉固全局前缀(对外导出供执行层复用, N32 复审 P1-2): 受控
 * --git-dir/--work-tree(加固①)+ 禁 replace refs(加固②)+ 禁 optional locks(防止
 * rev-parse 等家族意外取锁写盘)。 */
export function pinArgs(ctx: RepoContext): string[] {
  return [
    `--git-dir=${ctx.gitDir}`,
    `--work-tree=${ctx.workTree}`,
    '--no-optional-locks',
    '--no-replace-objects',
  ];
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: Buffer | string };
  if (typeof e.stderr === 'string') return e.stderr;
  if (Buffer.isBuffer(e.stderr)) return e.stderr.toString('utf8');
  return '';
}

/** 钉固后的 git 调用(ctx 必带; 任何未钉固调用都必须是显式的专用函数;
 * audit 允许表 seam: GIT_CP_WRITE @gitExec)。 */
function gitExec(opts: GitExecOpts & { ctx: RepoContext; binary?: boolean }): string {
  const args = [...pinArgs(opts.ctx), ...opts.args];
  try {
    return execFileSync('git', args, {
      cwd: opts.ctx.repoDir,
      encoding: opts.binary ? 'latin1' : 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input,
      env: buildEnv(opts.env),
    });
  } catch (err) {
    if (opts.allowFailure) return '';
    throw new GitTransactionError(
      'GIT_ERROR',
      `git ${opts.args.join(' ')} 失败: ${stderrOf(err).trim() || String(err)}`,
      opts.args,
    );
  }
}

/** 无钉固的裸调用 —— 只允许 resolveRepoContext 做一次性仓库发现/探测用(env 已清理,
 * 发现结果随后被钉固与 worktree==repoDir 校验约束); 任何其他使用点都是回归。 */
function gitExecUnpinned(repoDir: string, args: string[], allowFailure: boolean): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(),
    });
  } catch (err) {
    if (allowFailure) return '';
    throw new GitTransactionError(
      'GIT_ERROR',
      `git ${args.join(' ')} 失败: ${stderrOf(err).trim() || String(err)}`,
      args,
    );
  }
}

function run(ctx: RepoContext, args: string[], env?: Record<string, string>): string {
  return gitExec({ ctx, repoDir: ctx.repoDir, args, env }).trim();
}

/** git 认为某相对路径在仓库内的实际位置(钉固 --git-dir 下为绝对路径; 兼容 linked worktree)。 */
function gitPath(ctx: RepoContext, rel: string): string {
  return path.resolve(ctx.repoDir, run(ctx, ['rev-parse', '--git-path', rel]));
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
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

// ============================================================================
// 仓库上下文: 一次性发现 + 钉固值 + object format(加固①⑤)
// ============================================================================

interface RepoContext {
  /** fs 绝对路径(调用方 repoDir 的 resolve)。 */
  repoDir: string;
  /** --git-dir 钉值(rev-parse --absolute-git-dir)。 */
  gitDir: string;
  /** --work-tree 钉值(rev-parse --show-toplevel)。 */
  workTree: string;
  objectFormat: ObjectFormat;
  oidLen: 40 | 64;
}

export type { RepoContext };

/**
 * 解析并校验仓库上下文(加固①): 无钉固发现一次 `--absolute-git-dir --show-toplevel
 * --show-object-format`, 然后校验:
 * - object format 仅支持 sha1/sha256(加固⑤); 其余 → REPO_STATE_UNSAFE;
 * - realpath(worktree) == realpath(repoDir) 且 realpath(gitdir) == realpath(repoDir/.git)
 *   —— 拒绝发现到祖先/非预期仓库(两仓攻击的 fail-closed 兜底);
 * 返回的 gitDir/workTree 用于后续每次调用的 --git-dir/--work-tree 钉固。
 * (对外导出供执行层复用: 生产 execute/recovery 与 git-transaction 共用同一仓库
 * 发现/钉固/object format 原语, N32 复审 P1-2。)
 */
export function resolveRepoContext(repoDir: string): RepoContext {
  const raw = gitExecUnpinned(
    repoDir,
    ['rev-parse', '--absolute-git-dir', '--show-toplevel', '--show-object-format'],
    true,
  );
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length !== 3) {
    throw new GitTransactionError('UNKNOWN_REF', `repoDir 不是可用的 git 仓库: ${repoDir}`);
  }
  const [gitDir, workTree, fmt] = lines;
  if (fmt !== 'sha1' && fmt !== 'sha256') {
    throw new GitTransactionError(
      'REPO_STATE_UNSAFE',
      `仓库 object format 不受支持(仅 sha1/sha256): "${fmt}"`,
      { format: fmt },
    );
  }
  const repoReal = realpathOrNull(repoDir);
  const gitDirReal = realpathOrNull(gitDir);
  const dotGitReal = realpathOrNull(path.join(repoDir, '.git'));
  const workTreeReal = realpathOrNull(workTree);
  if (repoReal === null || gitDirReal === null || dotGitReal === null || workTreeReal === null) {
    throw new GitTransactionError('GIT_ERROR', `无法解析仓库路径(非 git 工作树根?): ${repoDir}`);
  }
  if (repoReal !== workTreeReal || gitDirReal !== dotGitReal) {
    throw new GitTransactionError(
      'GIT_ERROR',
      `解析到的仓库(${workTree}) 与 repoDir(${repoDir}) 不一致, 拒绝在非预期仓库操作(fail-closed)`,
      { workTree, repoDir },
    );
  }
  return {
    repoDir: path.resolve(repoDir),
    gitDir,
    workTree,
    objectFormat: fmt,
    oidLen: fmt === 'sha256' ? 64 : 40,
  };
}

/**
 * provenance 状态拒绝(加固②): replace refs(refs/replace/*)、info/grafts、shallow
 * 都会改变对象/历史 provenance; 一律 REPO_STATE_UNSAFE fail-closed。配合全局
 * --no-replace-objects/GIT_NO_REPLACE_OBJECTS=1(即使个别状态漏检, 读对象也不被替换)。
 * (对外导出供执行层复用, N32 复审 P1-2。)
 */
export function assertSafeRepoState(ctx: RepoContext): void {
  const replaces = gitExec({
    ctx,
    repoDir: ctx.repoDir,
    args: ['for-each-ref', '--format=%(refname)', 'refs/replace'],
    allowFailure: true,
  }).trim();
  if (replaces.length > 0) {
    throw new GitTransactionError(
      'REPO_STATE_UNSAFE',
      `仓库存在 replace refs(改变对象 provenance), fail-closed: ${replaces.split(/\r?\n/)[0]}`,
      { replaces: replaces.split(/\r?\n/) },
    );
  }
  for (const [label, rel] of [
    ['grafts', 'info/grafts'],
    ['shallow', 'shallow'],
  ] as const) {
    const p = gitPath(ctx, rel);
    if (fs.existsSync(p)) {
      throw new GitTransactionError('REPO_STATE_UNSAFE', `仓库处于 ${label} 状态(改变历史 provenance), fail-closed: ${p}`, { rel });
    }
  }
}

/**
 * shared index 状态门(加固⑨): 共享 `.git/index.lock` 无法证明归属 → INDEX_LOCKED;
 * 共享 index 相对 HEAD 存在任何预存 staged 条目 → STAGED_CONFLICT。
 * 在 commit 前(早退)与 update-ref 前(重验竞态窗口)各调用一次。
 * diff --cached --exit-code 的 exit code: 0 = 无差异, 1 = 有差异(execFileSync 抛错但
 * stdout 携带路径列表), 其他 = 真实 git 错误 → GIT_ERROR fail-closed。
 * (对外导出供执行层复用: 生产 execute/recovery 提交前 staged 重验, N32 复审 P1-3。)
 */
export function assertSharedIndexClean(ctx: RepoContext, at: string): void {
  const lock = gitPath(ctx, 'index.lock');
  if (fs.existsSync(lock)) {
    throw new GitTransactionError('INDEX_LOCKED', `共享 index.lock 已存在且无法证明归属(${at}): ${lock}`);
  }
  const args = [...pinArgs(ctx), 'diff', '--cached', '--exit-code', '--name-only', '-z'];
  try {
    execFileSync('git', args, {
      cwd: ctx.repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(),
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    if (e.status === 1) {
      const out = typeof e.stdout === 'string' ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : '';
      const staged = out.split('\0').filter(Boolean);
      throw new GitTransactionError(
        'STAGED_CONFLICT',
        `共享 index 预存 staged(${at}), 整个事务拒绝(N32 §2): ${staged.slice(0, 5).join(', ')}${staged.length > 5 ? '…' : ''}`,
        { staged },
      );
    }
    throw new GitTransactionError('GIT_ERROR', `git diff --cached 失败(${at}): ${stderrOf(err).trim() || String(err)}`);
  }
}

/** 目标工作树期望状态重验(加固⑨): 写目标工作树内容 sha256 == 计划输出字节、
 * 删除目标已缺席; 失配 → WORKTREE_CONFLICT(并发编辑竞态 fail-closed)。 */
function assertTargetWorktreeState(ctx: RepoContext, targets: readonly NormalizedTarget[]): void {
  for (const t of targets) {
    const abs = path.join(ctx.repoDir, t.path);
    let actual: Buffer | null = null;
    try {
      actual = fs.readFileSync(abs);
    } catch {
      actual = null;
    }
    if (t.bytes === null) {
      if (actual !== null) {
        throw new GitTransactionError(
          'WORKTREE_CONFLICT',
          `目标 ${t.path} 工作树仍存在(计划删除), update-ref 前重验失败; 不 force`,
          { path: t.path },
        );
      }
    } else if (actual === null || sha256Hex(actual) !== sha256Hex(t.bytes)) {
      throw new GitTransactionError(
        'WORKTREE_CONFLICT',
        `目标 ${t.path} 工作树内容 != 计划输出(并发编辑?), update-ref 前重验失败; 不 force`,
        { path: t.path },
      );
    }
  }
}

// ============================================================================
// 当前 ref / base HEAD 解析(未知 ref fail-closed; 仅允许 refs/heads/*)
// ============================================================================

export interface ResolvedRef {
  /** symbolic ref 全名(refs/heads/*; update-ref 按全名 CAS, 不 deref symref)。 */
  ref: string;
  /** 当前 ref 指向的 commit(base HEAD)。 */
  head: string;
}

/** HEAD 的 symbolic ref 只允许 refs/heads/*(加固④: 拒 tag/任意 ref 的 HEAD)。 */
const HEAD_REF_RE = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

function resolveCurrentRefFor(ctx: RepoContext): ResolvedRef {
  const ref = gitExec({ ctx, repoDir: ctx.repoDir, args: ['symbolic-ref', '-q', 'HEAD'], allowFailure: true }).trim();
  if (!HEAD_REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.includes('@{')) {
    throw new GitTransactionError(
      'UNKNOWN_REF',
      `HEAD 无法解析为合法 symbolic ref(仅允许 refs/heads/*): "${ref || '(空)'}"`,
      { ref },
    );
  }
  const head = gitExec({ ctx, repoDir: ctx.repoDir, args: ['rev-parse', '--verify', `${ref}^{commit}`], allowFailure: true }).trim();
  if (!isOid(head, ctx.oidLen)) {
    throw new GitTransactionError('UNKNOWN_REF', `ref "${ref}" 无 base commit(仓库未初始化?): "${head}"`, { ref, head });
  }
  return { ref, head };
}

/**
 * 解析当前 HEAD 的 symbolic ref 与 base HEAD(N32 §6「未知 ref fail-closed」)。
 * - HEAD 非 symbolic ref(detached)→ UNKNOWN_REF;
 * - HEAD 不是 refs/heads/* → UNKNOWN_REF(加固④);
 * - unborn 分支(无 base commit)→ UNKNOWN_REF(本原语要求已存在的 base commit)。
 */
export function resolveCurrentRef(repoDir: string): ResolvedRef {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  return resolveCurrentRefFor(ctx);
}

// ============================================================================
// writeSet 目标校验(N32 §8 + 加固⑥: 拒绝绝对/`..`/穿越/`.git`(大小写不敏感)/超限/
// Windows drive/UNC/控制字符)
// ============================================================================

export type TxFileMode = '100644' | '100755' | '120000';

export interface TxTargetWrite {
  /** 仓库相对路径(正斜杠; 空/绝对/`..`/空段/大小写不敏感 `.git` 段/Windows drive/UNC/
   * 控制字符一律 BAD_TARGET)。 */
  readonly path: string;
  /** 计划输出字节(生成/审批完成时定型, ADR-0021 §4); 缺省 = 从 base tree 删除(force-remove)。 */
  readonly outputBytes?: string | Uint8Array;
  /** git 文件 mode; 仅写目标有效, 缺省 100644。 */
  readonly mode?: TxFileMode;
}

interface NormalizedTarget {
  path: string;
  mode: TxFileMode | null; // null = 删除目标
  bytes: Buffer | null; // 计划输出字节(Buffer 才能直接喂 execFileSync input); null = 删除
  blob: string | null; // hash-object 后填充
}

// 统一 txid 契约(codec.ts isTxId 同口径, 审计): canonical `tx-` + 64 位小写 hex。
const TXID_RE = /^tx-[0-9a-f]{64}$/;
const KIND_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MODE_SET: ReadonlySet<string> = new Set(['100644', '100755', '120000']);
/** Windows drive 前缀(C:\ 或 C:foo)。 */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
/** C0 控制字符 + DEL(加固⑥)。 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** 路径归一化 + 安全校验(N32/ADR-0021 §8 路径白名单精神 + 加固⑥; 失败一律 BAD_TARGET)。 */
function normalizeTargetPath(p: string): string {
  if (p === '') throw new GitTransactionError('BAD_TARGET', 'writeSet 目标路径不能为空');
  if (p.length > 512) throw new GitTransactionError('BAD_TARGET', `writeSet 路径超限(>512): ${p.slice(0, 80)}…`);
  if (p.includes('\\')) throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止反斜杠(含 Windows UNC): ${p}`);
  if (WINDOWS_DRIVE_RE.test(p)) throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止 Windows drive 前缀: ${p}`);
  if (p.startsWith('//')) throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止 UNC 前缀: ${p}`);
  if (CONTROL_CHAR_RE.test(p)) throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止控制字符: ${JSON.stringify(p)}`);
  if (p.startsWith('/')) throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止绝对路径: ${p}`);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new GitTransactionError('BAD_TARGET', `writeSet 路径含空段/./..(路径穿越): ${p}`);
    }
    if (seg.toLowerCase() === '.git') {
      throw new GitTransactionError('BAD_TARGET', `writeSet 路径禁止进入 .git 内部(大小写不敏感): ${p}`);
    }
  }
  return p; // 已是归一化正斜杠相对路径
}

function normalizeTargets(targets: readonly TxTargetWrite[]): NormalizedTarget[] {
  const seen = new Set<string>();
  const out: NormalizedTarget[] = [];
  for (const t of targets) {
    const p = normalizeTargetPath(t.path);
    if (seen.has(p)) throw new GitTransactionError('BAD_TARGET', `writeSet 重复目标路径: ${p}`);
    seen.add(p);
    if (t.mode !== undefined && !MODE_SET.has(t.mode)) {
      throw new GitTransactionError('BAD_TARGET', `writeSet 目标非法 mode: ${String(t.mode)} (${p})`);
    }
    const bytes =
      t.outputBytes === undefined
        ? null
        : typeof t.outputBytes === 'string'
          ? Buffer.from(t.outputBytes, 'utf8')
          : Buffer.from(t.outputBytes);
    out.push({ path: p, mode: bytes === null ? null : (t.mode ?? '100644'), bytes, blob: null });
  }
  return out;
}

// ============================================================================
// 事务提交: 私有 index + exact tree + commit-tree(确定性 identity/date)+ update-ref CAS
// ============================================================================

export interface CommitTxnParams {
  readonly repoDir: string;
  /** resolveCurrentRef().ref(refs/heads/...); 必须 == 当前 symbolic HEAD(加固④, 拒 tag/任意 ref)。 */
  readonly ref: string;
  /** 计划基线 HEAD; update-ref CAS 的旧值; 必须 == ref 当前值(否则 REF_CAS_FAILED)。 */
  readonly baseHead: string;
  readonly txid: string;
  readonly kind: string;
  /** 实际变化 writeSet(已剔除 no-op, ADR-0021 §4); 输出在生成/审批时定型后不可变。
   *  目标工作树期望状态 = 计划输出字节(写)/缺席(删), update-ref 前逐目标重验。 */
  readonly targets: readonly TxTargetWrite[];
  /**
   * 复核点钩子(N32 复审 P1: 执行层 crash gate / CAS 窗口注入; 生产留空)。
   * - afterWriteTree: write-tree 冻结 exact tree 后(私有 index 已建);
   * - afterCommitObject: commit-tree 生成 commit object 后(悬空, ref 未动);
   * - beforeRefCas: 「早期检查之后、update-ref 之前」的真实 CAS 窗口。
   * 钩子可返回 Promise(异步变体 commitTransactionAsync 会 await; 同步变体按旧语义
   * 直接调用不 await——调用方若传异步钩子给同步变体, 语义与旧版一致)。
   */
  readonly hooks?: {
    readonly afterWriteTree?: () => void | Promise<void>;
    readonly afterCommitObject?: () => void | Promise<void>;
    readonly beforeRefCas?: () => void | Promise<void>;
  };
  /**
   * 计划一致性门(N32 复审 P1-1): 执行层先用纯字节推导(零 ODB/index 副作用)算出计划
   * tree/plan digest 并持久化 intent, 再在本原语 materialize; write-tree 后与 commit 前
   * 若与计划不符 → PLAN_MISMATCH fail-closed(不生成 commit), 防纯推导/物化分叉污染。
   */
  readonly expect?: { readonly tree?: string; readonly planDigest?: string };
}

export interface CommitTxnResult {
  readonly ref: string;
  readonly baseHead: string;
  readonly txid: string;
  readonly kind: string;
  /** 新 commit(branch 已被 CAS 推进到它; canonical 终点, ADR-0021 §6; 确定性 OID)。 */
  readonly commit: string;
  /** 冻结的 exact tree = base HEAD tree + 实际变化集。 */
  readonly tree: string;
  /** 不可变 plan digest = sha256(base+tree+writeSet 输出 blobs); 记入 trailer 供恢复验证。 */
  readonly planDigest: string;
  /** writeSet 输出 blob 归属(path → blob; 删除目标 blob=null), 按 path 排序。 */
  readonly targetBlobs: ReadonlyArray<{ path: string; mode: TxFileMode | null; blob: string | null }>;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** plan digest(ADR-0021 §6: tree hash、writeSet 与输出 blob hashes 共同形成不可变 plan digest;
 * 始终 sha256, 与仓库 object format 无关)。对外导出供执行层复用(execute/recovery 与
 * git-transaction 同口径, N32 复审 P1-2)。 */
export function computePlanDigest(
  baseHead: string,
  tree: string,
  targetBlobs: ReadonlyArray<{ path: string; mode: TxFileMode | null; blob: string | null }>,
): string {
  const lines = [`base=${baseHead}`, `tree=${tree}`];
  for (const t of [...targetBlobs].sort(byPath)) {
    lines.push(t.blob === null ? `delete\t${t.path}` : `${t.mode}\t${t.path}\t${t.blob}`);
  }
  return createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
}

// ============================================================================
// 纯字节 plan identity 推导(N32 复审 P1-1: intent READY 之前零 ODB/index/worktree/
// ref 副作用 —— 只读 base tree + 纯内存重建 tree/blob OID, 不调 hash-object -w、
// 不建私有 index)
// ============================================================================

/** 纯字节推导结果(与 derivePlanIdentity 物化结果同构; 一致性由 commitTransaction
 * 的 expect 计划门校验)。 */
export interface PureDerivedPlan {
  readonly tree: string;
  readonly planDigest: string;
  readonly targetBlobs: ReadonlyArray<{ path: string; mode: TxFileMode | null; blob: string | null }>;
}

/** 扁平树条目(路径 → git mode + 原始 oid 字节)。 */
interface FlatTreeEntry {
  mode: string;
  oid: Buffer;
}

/** 解析原始 tree 对象字节(条目 = `<mode> <name>\0<oid 原始字节>`; oidLen 为 hex
 * 长度 40/64, 原始字节数 = oidLen/2, 即 20/32)。 */
function parseTreeRaw(raw: Buffer, oidLen: 40 | 64): Array<{ mode: string; name: string; oid: Buffer }> {
  const oidByteLen = oidLen === 64 ? 32 : 20;
  const out: Array<{ mode: string; name: string; oid: Buffer }> = [];
  let i = 0;
  while (i < raw.length) {
    const sp = raw.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = raw.slice(i, sp).toString('utf8');
    const nul = raw.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = raw.slice(sp + 1, nul).toString('utf8');
    const oid = raw.slice(nul + 1, nul + 1 + oidByteLen);
    if (oid.length !== oidByteLen) break;
    out.push({ mode, name, oid });
    i = nul + 1 + oidByteLen;
  }
  return out;
}

/** 按 object format 哈希对象(blob/tree/commit 同构: `<type> <len>\0<body>`)。 */
function hashObjectRaw(format: ObjectFormat, type: 'blob' | 'tree', body: Buffer): Buffer {
  const h = createHash(format === 'sha256' ? 'sha256' : 'sha1');
  h.update(`${type} ${body.length}\0`);
  h.update(body);
  return Buffer.from(h.digest());
}

/** git tree 条目排序: 目录名视为带尾 `/` 后按字节序比较(与 git 的 base_name_compare 一致)。 */
function gitTreeCompare(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/**
 * 由扁平条目集重建树对象(自底向上, 纯内存; 空目录不产生条目)。
 * 文件与目录同名冲突(如 base 有文件 `a` 而 writeSet 写 `a/b.md`)→ 抛 GIT_ERROR
 * (materialize 侧 git 同样拒绝, 两侧一致 fail-closed)。
 */
function buildTreeFromFlat(
  flat: Map<string, FlatTreeEntry>,
  format: ObjectFormat,
): { raw: Buffer; hex: string } | null {
  if (flat.size === 0) return null; // 空树: 上层不产生条目(空目录不存在)
  const files: Array<{ name: string; mode: string; oid: Buffer }> = [];
  const dirs = new Map<string, Map<string, FlatTreeEntry>>();
  for (const [p, e] of flat) {
    const idx = p.indexOf('/');
    if (idx < 0) {
      files.push({ name: p, mode: e.mode, oid: e.oid });
    } else {
      const d = p.slice(0, idx);
      let sub = dirs.get(d);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(d, sub);
      }
      sub.set(p.slice(idx + 1), e);
    }
  }
  const entries: Array<{ name: string; mode: string; oid: Buffer }> = [...files];
  for (const [d, sub] of dirs) {
    if (sub.size === 0) continue; // 删除后空目录不产生条目
    const subTree = buildTreeFromFlat(sub, format);
    if (subTree === null) continue;
    entries.push({ name: d, mode: '40000', oid: subTree.raw });
  }
  for (const f of files) {
    if (dirs.has(f.name)) {
      throw new GitTransactionError('GIT_ERROR', `路径冲突: ${f.name} 同时是文件与目录(与 base 树/writeSet 冲突)`);
    }
  }
  entries.sort(gitTreeCompare);
  const body = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), e.oid])));
  const raw = hashObjectRaw(format, 'tree', body);
  return { raw, hex: raw.toString('hex') };
}

/** 纯 blob OID(与 `git hash-object` 字节精确一致; 不写 ODB)。 */
function blobOidHex(format: ObjectFormat, bytes: Buffer): string {
  return hashObjectRaw(format, 'blob', bytes).toString('hex');
}

/**
 * 纯字节 plan identity 推导(N32 复审 P1-1): 由 base HEAD + 实际输出字节**纯内存**
 * 重算 exact tree / 输出 blobs / plan digest —— 只读 base tree(`cat-file`, 钉固 env,
 * 禁 replace), 不触碰 ODB(`hash-object -w` 的零副作用替代)、不建私有 index、不写
 * worktree/ref。执行层用它先推导计划并持久化 intent(READY 前零副作用), intent
 * READY 后再 materialize(commitTransaction 的 expect 计划门做一致验证)。
 *
 * 输出 blobs/树与 materialize 字节精确一致: blob = `<len>\0<内容>` 按仓库 object
 * format(sha1/sha256)哈希; tree 自底向上重建(git 条目排序/`40000` 目录 mode)。
 */
export function derivePlanIdentityPure(
  repoDir: string,
  baseHead: string,
  targets: readonly TxTargetWrite[],
): PureDerivedPlan {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  if (!isOid(baseHead, ctx.oidLen)) {
    throw new GitTransactionError('UNKNOWN_REF', `baseHead 非法(非 ${ctx.oidLen}-hex commit): ${baseHead}`);
  }
  const normalized = normalizeTargets(targets); // 路径/mode/重复目标白名单(与 materialize 同门)

  // 1) 只读展开 base tree(递归 cat-file; 零写入)。
  const baseTreeSha = gitExec({ ctx, repoDir, args: ['rev-parse', '--verify', `${baseHead}^{tree}`] }).trim();
  if (!isOid(baseTreeSha, ctx.oidLen)) {
    throw new GitTransactionError('GIT_ERROR', `base HEAD tree 解析异常: ${baseTreeSha}`);
  }
  const flat = new Map<string, FlatTreeEntry>();
  const stack: Array<{ prefix: string; sha: string }> = [{ prefix: '', sha: baseTreeSha }];
  while (stack.length > 0) {
    const { prefix, sha } = stack.pop()!;
    let rawBuf: Buffer;
    try {
      const latin = gitExec({ ctx, repoDir, args: ['cat-file', 'tree', sha], binary: true });
      rawBuf = Buffer.from(latin, 'latin1'); // latin1 往返 = 原始字节
    } catch (err) {
      throw new GitTransactionError('GIT_ERROR', `cat-file tree ${sha} 失败: ${stderrOf(err).trim() || String(err)}`);
    }
    for (const e of parseTreeRaw(rawBuf, ctx.oidLen)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        stack.push({ prefix: p, sha: e.oid.toString('hex') });
      } else {
        flat.set(p, { mode: e.mode, oid: e.oid });
      }
    }
  }

  // 2) 应用实际变化集(写 = 替换/新增 blob; 删 = 移除)。
  const targetBlobs: Array<{ path: string; mode: TxFileMode | null; blob: string | null }> = [];
  for (const t of normalized) {
    if (t.bytes === null) {
      // 删除目标: 若 base 中该路径是目录(flat 含 `p/...` 前缀) → 与 materialize
      // (update-index --force-remove 目录路径) 一致 fail-closed。
      for (const k of flat.keys()) {
        if (k.startsWith(`${t.path}/`)) {
          throw new GitTransactionError('BAD_TARGET', `删除目标 ${t.path} 在 base 树中是目录(与 materialize 一致拒绝)`);
        }
      }
      flat.delete(t.path);
      targetBlobs.push({ path: t.path, mode: null, blob: null });
    } else {
      const mode: TxFileMode = t.mode ?? '100644';
      // 写目标: base 中该路径是目录 → 与 materialize(git update-index cacheinfo 路径冲突)一致拒绝。
      for (const k of flat.keys()) {
        if (k.startsWith(`${t.path}/`)) {
          throw new GitTransactionError('BAD_TARGET', `写目标 ${t.path} 在 base 树中是目录(与 materialize 一致拒绝)`);
        }
      }
      const oidHex = blobOidHex(ctx.objectFormat, t.bytes);
      flat.set(t.path, { mode, oid: Buffer.from(oidHex, 'hex') });
      targetBlobs.push({ path: t.path, mode, blob: oidHex });
    }
  }

  // 3) 重建 exact tree + plan digest(纯内存)。
  const root = buildTreeFromFlat(flat, ctx.objectFormat);
  const tree = root === null ? (ctx.objectFormat === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1) : root.hex;
  if (!isOid(tree, ctx.oidLen)) throw new GitTransactionError('GIT_ERROR', `纯树重建异常: ${tree}`);
  const planDigest = computePlanDigest(baseHead, tree, targetBlobs);
  return { tree, planDigest, targetBlobs };
}

/** 空树对象 OID(sha1/sha256; 全删 writeSet 或空 base 时使用)。 */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/**
 * commit message 模板: subject 携带 `vault-tx vtx:<txid>`(集成 harness 经
 * `git log --format=%s --grep vtx:<txid>` 判定事务 commit)+ `txid`/`kind`/
 * `plan-digest` 结尾 trailer 块(git trailer 语义, 恢复验证用)。subject 与
 * trailers 同时参与确定性 commit OID(computeExpectedTxCommitOid), 创建与验证
 * 共用本函数, 保证自洽。
 */
export function buildTxCommitMessage(txid: string, kind: string, planDigest: string): string {
  return `vault-tx vtx:${txid} (${kind})\n\ntxid: ${txid}\nkind: ${kind}\nplan-digest: ${planDigest}\n`;
}

/** 固定 novelcraft 身份 + 确定性 author/committer date(加固③; commit OID 全确定性)。 */
const NOVELCRAFT_IDENT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: NOVELCRAFT_NAME,
  GIT_AUTHOR_EMAIL: NOVELCRAFT_EMAIL,
  GIT_COMMITTER_NAME: NOVELCRAFT_NAME,
  GIT_COMMITTER_EMAIL: NOVELCRAFT_EMAIL,
  GIT_AUTHOR_DATE: NOVELCRAFT_TX_DATE_STR,
  GIT_COMMITTER_DATE: NOVELCRAFT_TX_DATE_STR,
};

/** update-ref 运行时禁用 hooks(不存在且不可预创建的路径; 防 repo/global hooks 干扰 CAS)。 */
function noHooksPath(): string {
  return path.join(os.tmpdir(), `novelcraft-nohooks-${randomBytes(8).toString('hex')}`);
}

// 紧邻 update-ref 的锁/CAS/hook 拒绝失败文案(git 输出经 LC_ALL=C 固定为英文)。
const REF_CAS_FAILURE_RE = /cannot lock ref|but expected|aborted by hook|declined/i;

/**
 * update-ref <ref> <new> <old> 三参 CAS(加固⑦): 紧邻的锁/CAS/hook 拒绝失败一律
 * REF_CAS_FAILED(外部推进/ref lock/hook 拒绝同视为 ref 竞争, 不 force); 其余失败 GIT_ERROR。
 * (对外导出供执行层复用, N32 复审 P1-2。)
 */
export function updateRefCas(ctx: RepoContext, ref: string, newValue: string, baseHead: string, txid: string, kind: string): void {
  try {
    gitExec({
      ctx,
      repoDir: ctx.repoDir,
      args: [
        '-c',
        `core.hooksPath=${noHooksPath()}`,
        'update-ref',
        '-m',
        `novelcraft tx ${txid} (${kind})`,
        ref,
        newValue,
        baseHead,
      ],
    });
  } catch (err) {
    if (err instanceof GitTransactionError && REF_CAS_FAILURE_RE.test(err.message)) {
      throw new GitTransactionError(
        'REF_CAS_FAILED',
        `update-ref CAS 失败(外部推进/ref lock/hook 拒绝; 不 force): ${err.message}`,
        { ref, newValue, baseHead },
      );
    }
    throw err;
  }
}

/** 提交钩子(可同步可异步; 异步变体 commitTransactionAsync 会 await)。 */
type CommitHook = () => void | Promise<void>;

/**
 * 提交一个事务(ADR-0021 §6 全流程; commit/ref 成功为 canonical 终点):
 *   0) fail-closed 前置: 仓库上下文钉固 + provenance 状态拒绝(加固①②⑧);
 *      ref 必须 == 当前 symbolic HEAD 的 refs/heads/*(加固④);
 *      ref 当前值 != baseHead → REF_CAS_FAILED(写任何对象前先看 ref);
 *      shared index 状态门(加固⑨): 预存 staged → STAGED_CONFLICT; index.lock → INDEX_LOCKED;
 *   1) 事务私有 index(GIT_INDEX_FILE)从 base HEAD `read-tree` 初始化(私有 index 及其
 *      .lock 残留且无法证明归属 → INDEX_LOCKED, 加固⑪);
 *   2) `hash-object -w` 计划输出 + `update-index --add --cacheinfo`/`--force-remove`
 *      精确 stage 实际变化集(禁止 `git add`, N32 §6);
 *   3) `write-tree` 冻结 exact tree; 若 p.expect.tree 提供且不符 → PLAN_MISMATCH(不生成 commit);
 *   4) plan digest = tree + writeSet + 输出 blobs(sha256); 若 p.expect.planDigest 提供且
 *      不符 → PLAN_MISMATCH(N32 复审 P1-1: 纯字节计划推导与 materialize 一致性门);
 *   5) `commit-tree`(固定 novelcraft author/committer + 确定性日期 NOVELCRAFT_TX_DATE +
 *      trailers txid/kind/plan-digest; 禁 gpgsign 与 encoding header 保证字节确定性);
 *   6) 钩子 afterWriteTree(私有 index 已建/exact tree 已冻结)/afterCommitObject(悬空
 *      commit 已生成)/beforeRefCas(真实 CAS 窗口)→ update-ref 前重验(加固⑨): shared
 *      index staged/lock、目标工作树期望状态(计划输出字节/删除缺席)、symbolic HEAD 未切换;
 *   7) `update-ref <ref> <commit> <baseHead>` 三参 CAS(外部先推进 → REF_CAS_FAILED, 不 force;
 *      紧邻锁/CAS/hook 拒绝 → REF_CAS_FAILED, 加固⑦)。
 * 返回后私有 index 已清理(finally 以 (dev,ino,size,sha256) 守卫, 不删并发者替换的文件, 加固⑪);
 * 共享 index 不受本函数触碰(由上层用 buildHeadIndexBytes 安装)。
 *
 * 实现(生成器 + 双 runner, N32 复审 P1): 同步变体 commitTransaction 保持旧语义(钩子
 * 同步调用不 await); 异步变体 commitTransactionAsync 逐个 await 钩子——执行层 crash
 * gate 需要阻塞在钩子上(worker 协议), 同一核心不重复实现、不旁路。
 */
function* commitTransactionSteps(p: CommitTxnParams): Generator<CommitHook | undefined, CommitTxnResult, void> {
  const ctx = resolveRepoContext(p.repoDir);
  assertSafeRepoState(ctx);

  if (!TXID_RE.test(p.txid)) {
    throw new GitTransactionError('BAD_TARGET', `txid 非法(允许 [A-Za-z0-9._-]{1,64}): ${p.txid}`);
  }
  if (!KIND_RE.test(p.kind)) {
    throw new GitTransactionError('BAD_TARGET', `kind 非法(允许 [A-Za-z0-9._-]{1,64}): ${p.kind}`);
  }
  if (!isOid(p.baseHead, ctx.oidLen)) {
    throw new GitTransactionError('UNKNOWN_REF', `baseHead 非法(非 ${ctx.oidLen}-hex commit): ${p.baseHead}`);
  }

  // 加固④: ref 只允许 == 当前 symbolic HEAD 的 refs/heads/*(head 参数与当前分支解耦的
  // tag/任意 ref 一律 UNKNOWN_REF); 早退: ref 当前值必须 == baseHead。
  const cur = resolveCurrentRefFor(ctx);
  if (p.ref !== cur.ref) {
    throw new GitTransactionError(
      'UNKNOWN_REF',
      `ref "${p.ref}" 不是当前 symbolic HEAD "${cur.ref}"(只允许当前分支 refs/heads/*, 拒 tag/任意 ref)`,
      { given: p.ref, current: cur.ref },
    );
  }
  if (p.baseHead !== cur.head) {
    throw new GitTransactionError(
      'REF_CAS_FAILED',
      `ref ${p.ref} 当前 ${cur.head} != 计划基线 ${p.baseHead}; 不写对象、不 force`,
      { ref: p.ref, current: cur.head, baseHead: p.baseHead },
    );
  }

  // 加固⑨: 任何预存 staged / 未知共享 index.lock → 早退(零对象写入)。
  assertSharedIndexClean(ctx, 'commit 前');

  const normalized = normalizeTargets(p.targets);

  // 事务私有 index(N32 §6: 私有 index 是提交隔离实现; 同 txid 残留或其 .lock 残留
  // 无法证明归属 → fail-closed, 加固⑪)。
  const privateIndex = gitPath(ctx, `novelcraft-txn-${p.txid}.index`);
  if (fs.existsSync(privateIndex)) {
    throw new GitTransactionError('INDEX_LOCKED', `事务私有 index 已存在(同 txid 残留?), fail-closed: ${privateIndex}`);
  }
  if (fs.existsSync(`${privateIndex}.lock`)) {
    throw new GitTransactionError('INDEX_LOCKED', `事务私有 index 的 .lock 已存在(无法证明归属), fail-closed: ${privateIndex}.lock`);
  }
  const envIdx: Record<string, string> = { GIT_INDEX_FILE: privateIndex };
  // 本调用创建/使用的私有 index 的 (dev,ino,size,sha256): finally 只删除属于本调用的文件(加固⑪)。
  // git 每次写 index 都经 <file>.lock + rename 替换(新 inode), 因此每次本进程的 index
  // 变更后都刷新记录; finally 比对时若 inode 不同(且非本进程最近一次变更所产生), 说明
  // 文件已被并发者替换 → 不删除(隔离)。
  let ourIndexStat: { dev: number; ino: number; size: number; sha256: string } | null = null;
  const refreshIndexStat = (): void => {
    ourIndexStat = statOrNull(privateIndex);
  };

  try {
    // 1) 私有 index 从 base HEAD 初始化(ADR-0021 §6)。
    gitExec({ ctx, repoDir: ctx.repoDir, args: ['read-tree', p.baseHead], env: envIdx });
    refreshIndexStat();

    // 2) 精确 stage 实际变化集(禁用 git add; N32 §6)。
    for (const t of normalized) {
      if (t.bytes !== null) {
        const blob = gitExec({ ctx, repoDir: ctx.repoDir, args: ['hash-object', '-w', '--stdin'], input: t.bytes, env: envIdx }).trim();
        if (!isOid(blob, ctx.oidLen)) throw new GitTransactionError('GIT_ERROR', `hash-object 输出异常: ${blob}`);
        t.blob = blob;
        gitExec({
          ctx,
          repoDir: ctx.repoDir,
          args: ['update-index', '--add', '--cacheinfo', `${t.mode},${blob},${t.path}`],
          env: envIdx,
        });
      } else {
        t.blob = null;
        gitExec({ ctx, repoDir: ctx.repoDir, args: ['update-index', '--force-remove', '--', t.path], env: envIdx });
      }
      refreshIndexStat(); // update-index 以 lock+rename 替换 index 文件(新 inode), 刷新记录
    }

    // 3) write-tree 冻结 exact tree = base HEAD tree + 实际变化集。
    //    write-tree 会刷新 index stat 缓存并重写 index 文件(新 inode), 同样刷新记录。
    const tree = gitExec({ ctx, repoDir: ctx.repoDir, args: ['write-tree'], env: envIdx }).trim();
    if (!isOid(tree, ctx.oidLen)) throw new GitTransactionError('GIT_ERROR', `write-tree 输出异常: ${tree}`);
    refreshIndexStat();
    // 计划一致性门(P1-1): materialize 的 exact tree 必须 == 纯字节计划推导值。
    if (p.expect?.tree !== undefined && p.expect.tree !== tree) {
      throw new GitTransactionError(
        'PLAN_MISMATCH',
        `materialize 的 exact tree != 计划 tree(fail-closed, 不生成 commit): ${tree} vs ${p.expect.tree}`,
        { materialized: tree, plan: p.expect.tree },
      );
    }
    yield p.hooks?.afterWriteTree; // 门控: 私有 index 已建、exact tree 已冻结

    // 4) 不可变 plan digest。
    const targetBlobs = normalized
      .map((t) => ({ path: t.path, mode: t.mode, blob: t.blob }))
      .sort(byPath);
    const planDigest = computePlanDigest(p.baseHead, tree, targetBlobs);
    if (p.expect?.planDigest !== undefined && p.expect.planDigest !== planDigest) {
      throw new GitTransactionError(
        'PLAN_MISMATCH',
        `materialize 的 plan digest != 计划 digest(fail-closed, 不生成 commit): ${planDigest} vs ${p.expect.planDigest}`,
        { materialized: planDigest, plan: p.expect.planDigest },
      );
    }

    // 5) commit-tree: 固定 novelcraft 身份 + 确定性日期 + trailers(加固③)。
    const message = buildTxCommitMessage(p.txid, p.kind, planDigest);
    const commit = gitExec({
      ctx,
      repoDir: ctx.repoDir,
      args: ['-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=utf-8', 'commit-tree', tree, '-p', p.baseHead],
      input: message,
      env: NOVELCRAFT_IDENT_ENV,
    }).trim();
    if (!isOid(commit, ctx.oidLen)) throw new GitTransactionError('GIT_ERROR', `commit-tree 输出异常: ${commit}`);
    yield p.hooks?.afterCommitObject; // 门控: commit object 已生成但 ref 未动(悬空)

    // 6) 钩子(可注入外部 staged/编辑/ref 推进/锁到真实竞态窗口)→ update-ref 前重验
    //    (加固⑨): shared index staged/lock、目标工作树期望状态、symbolic HEAD 未切换。
    yield p.hooks?.beforeRefCas;
    assertSharedIndexClean(ctx, 'update-ref 前');
    assertTargetWorktreeState(ctx, normalized);
    const headNow = gitExec({ ctx, repoDir: ctx.repoDir, args: ['symbolic-ref', '-q', 'HEAD'], allowFailure: true }).trim();
    if (headNow !== p.ref) {
      throw new GitTransactionError(
        'REF_CAS_FAILED',
        `symbolic HEAD 在事务期间切换(${headNow || '(detached)'}), 拒绝更新目标 ref ${p.ref}; 不 force`,
        { ref: p.ref, headNow },
      );
    }

    // 7) update-ref <ref> <new> <base> CAS; 外部 commit 先推进 ref/ref lock/hook 拒绝 →
    //    REF_CAS_FAILED, 不 force(N32 §6/影响③; 加固⑦)。
    //    必须不带 GIT_INDEX_FILE 环境(buildEnv 已剔除)。
    updateRefCas(ctx, p.ref, commit, p.baseHead, p.txid, p.kind);

    return { ref: p.ref, baseHead: p.baseHead, txid: p.txid, kind: p.kind, commit, tree, planDigest, targetBlobs };
  } finally {
    // 加固⑪: 只删除本调用创建/使用的私有 index(dev/ino 匹配); 并发者替换后绝不误删。
    const curStat = statOrNull(privateIndex);
    if (indexIdentityChanged(ourIndexStat, curStat)) {
      /* 并发者替换了私有 index 文件 → 不删除(隔离)。 */
    } else {
      fs.rmSync(privateIndex, { force: true });
    }
  }
}

/** 同步 runner(旧语义): 钩子同步调用不 await; 钩子抛错时关闭生成器使 finally 清理执行。 */
export function commitTransaction(p: CommitTxnParams): CommitTxnResult {
  const steps = commitTransactionSteps(p);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value as CommitTxnResult;
    const hook = r.value;
    if (hook === undefined) continue;
    try {
      hook();
    } catch (err) {
      // 钩子抛错: 生成器尚悬挂在 yield 点, 其 finally(私有 index 清理)不会自动执行;
      // 显式 return() 关闭生成器以触发 finally, 再重抛原错误(清理失败不遮蔽主错误)。
      // return() 的值在此被丢弃(仅用于关闭生成器), 类型上与生成器返回类型对齐。
      try {
        steps.return(undefined as unknown as CommitTxnResult);
      } catch {
        /* finally 已尽力执行 */
      }
      throw err;
    }
  }
}

/**
 * 异步 runner(N32 复审 P1, 执行层生产路径): 与同步变体同一生成器核心, 逐个 await
 * 钩子 —— executeTransaction 的 crash gate(review-point 等)必须阻塞在钩子上, 才能
 * 把 worker 协议(emit phase + 等待 proceed)嵌进「早期检查之后、update-ref 之前」的
 * 真实窗口。复用本原语 = 生产 execute/recovery 不旁路 git-transaction 安全原语。
 */
export async function commitTransactionAsync(p: CommitTxnParams): Promise<CommitTxnResult> {
  const steps = commitTransactionSteps(p);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value as CommitTxnResult;
    const hook = r.value;
    if (hook === undefined) continue;
    try {
      await hook();
    } catch (err) {
      // return() 的值被丢弃(仅用于关闭生成器以触发 finally 清理)。
      try {
        steps.return(undefined as unknown as CommitTxnResult);
      } catch {
        /* finally 已尽力执行 */
      }
      throw err;
    }
  }
}

// ============================================================================
// 可达历史唯一 tx commit 严格验证(恢复判定; 不盲信 intent 自报, N32 §6/§8)
// ============================================================================

export interface TxCommitIdentity {
  readonly txid: string;
  readonly kind: string;
  readonly baseHead: string;
  /** 规范 writeSet(path + mode + blob; 删除目标 mode/blob 为 null) —— 唯一权威来源:
   *  plan digest 与 exact tree 均由它重算(加固⑩), 不信任调用方自报的 tree/digest。 */
  readonly targetBlobs: ReadonlyArray<{ path: string; mode: TxFileMode | null; blob: string | null }>;
}

export interface FoundTxCommit {
  readonly commit: string;
}

interface RawIdent {
  name: string;
  email: string;
  /** author/committer 时间戳(epoch 秒; 加固③: 确定性日期必须精确匹配)。 */
  date: number;
  tz: string;
}

interface ParsedRawCommit {
  tree: string;
  parents: string[];
  author: RawIdent | null;
  committer: RawIdent | null;
  message: string;
}

/** 解析 `git cat-file commit` 原始对象(header 到首个空行; 其余为 message)。 */
function parseRawCommit(raw: string): ParsedRawCommit {
  const sep = raw.indexOf('\n\n');
  const header = sep >= 0 ? raw.slice(0, sep) : raw;
  const out: ParsedRawCommit = { tree: '', parents: [], author: null, committer: null, message: sep >= 0 ? raw.slice(sep + 2) : '' };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = parseRawIdent(line.slice(7));
    else if (line.startsWith('committer ')) out.committer = parseRawIdent(line.slice(10));
  }
  return out;
}

function parseRawIdent(s: string): RawIdent | null {
  const m = /^([^<]*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(s);
  if (!m) return null;
  return { name: m[1].trim(), email: m[2].trim(), date: Number(m[3]), tz: m[4] };
}

function isNovelcraftIdent(i: RawIdent | null): boolean {
  return i !== null && i.name === NOVELCRAFT_NAME && i.email === NOVELCRAFT_EMAIL;
}

/**
 * git trailer 语义解析(只取结尾连续块; 防正文伪 trailer)。重复 key 拒绝(加固⑩:
 * 返回 null 而非 Map 覆盖, 调用方按不匹配处理)。
 */
function parseTrailers(ctx: RepoContext, message: string): Map<string, string> | null {
  const out = gitExec({ ctx, repoDir: ctx.repoDir, args: ['interpret-trailers', '--parse'], input: message }).trimEnd();
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf(': ');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      if (map.has(key)) return null; // 重复 trailer → 拒绝(勿 Map 覆盖)
      map.set(key, line.slice(idx + 2).trim());
    }
  }
  return map;
}

/**
 * 由规范 writeSet 重算 exact tree 与 plan digest(加固⑩): 临时私有 index 上
 * `read-tree <baseHead>` → 逐目标 `update-index --cacheinfo <mode>,<blob>,<path>`/
 * `--force-remove` → `write-tree` 得 exact tree, 再以 computePlanDigest 重算 digest。
 * 不信任 identity 自报的 tree/digest; 重算写出的 tree 对象为内容寻址确定性写入(幂等)。
 */
function recomputeTxPlan(ctx: RepoContext, identity: TxCommitIdentity): { tree: string; planDigest: string } {
  const tmp = gitPath(ctx, `novelcraft-find-${randomBytes(8).toString('hex')}.index`);
  try {
    const env: Record<string, string> = { GIT_INDEX_FILE: tmp };
    gitExec({ ctx, repoDir: ctx.repoDir, args: ['read-tree', identity.baseHead], env });
    for (const t of identity.targetBlobs) {
      if (t.blob === null) {
        gitExec({ ctx, repoDir: ctx.repoDir, args: ['update-index', '--force-remove', '--', t.path], env, allowFailure: true });
      } else {
        gitExec({ ctx, repoDir: ctx.repoDir, args: ['update-index', '--add', '--cacheinfo', `${t.mode},${t.blob},${t.path}`], env });
      }
    }
    const tree = gitExec({ ctx, repoDir: ctx.repoDir, args: ['write-tree'], env }).trim();
    if (!isOid(tree, ctx.oidLen)) throw new GitTransactionError('GIT_ERROR', `write-tree(重算) 输出异常: ${tree}`);
    const planDigest = computePlanDigest(identity.baseHead, tree, identity.targetBlobs);
    return { tree, planDigest };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 按 object format 重算预期 commit 对象的字节级 OID(加固③⑩; commit-tree 字节精确)。 */
function txCommitObjectOid(objectFormat: ObjectFormat, identity: TxCommitIdentity, tree: string, planDigest: string): string {
  const message = buildTxCommitMessage(identity.txid, identity.kind, planDigest);
  const content = [
    `tree ${tree}`,
    `parent ${identity.baseHead}`,
    `author ${NOVELCRAFT_NAME} <${NOVELCRAFT_EMAIL}> ${NOVELCRAFT_TX_DATE} +0000`,
    `committer ${NOVELCRAFT_NAME} <${NOVELCRAFT_EMAIL}> ${NOVELCRAFT_TX_DATE} +0000`,
    '',
    message,
  ].join('\n');
  const buf = Buffer.from(content, 'utf8');
  const header = Buffer.from(`commit ${buf.length}\0`, 'utf8');
  const h = createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1');
  h.update(header);
  h.update(buf);
  return h.digest('hex');
}

/** 重算 + 构造预期 commit OID(ctx 已解析)。 */
function expectedTxCommitOid(ctx: RepoContext, identity: TxCommitIdentity): string {
  const { tree, planDigest } = recomputeTxPlan(ctx, identity);
  return txCommitObjectOid(ctx.objectFormat, identity, tree, planDigest);
}

/**
 * 对外重算接口(测试/诊断用): 由规范 writeSet 重算 tree/plan digest 并构造预期 commit OID。
 * 与 `git commit-tree`(禁 gpgsign、i18n.commitEncoding=utf-8、stdin message 原样写入)输出
 * 一致 —— find 以此 OID 作为唯一接受门, 外部任何字节差异(含日期/身份/trailers/树)都会
 * 得到不同 OID 而被拒。
 */
export function computeExpectedTxCommitOid(repoDir: string, identity: TxCommitIdentity): string {
  const ctx = resolveRepoContext(repoDir);
  validateIdentity(identity, ctx.oidLen);
  return expectedTxCommitOid(ctx, identity);
}

function validateIdentity(identity: TxCommitIdentity, oidLen: 40 | 64): void {
  if (!TXID_RE.test(identity.txid)) throw new GitTransactionError('BAD_TARGET', `identity.txid 非法: ${identity.txid}`);
  if (!KIND_RE.test(identity.kind)) throw new GitTransactionError('BAD_TARGET', `identity.kind 非法: ${identity.kind}`);
  if (!isOid(identity.baseHead, oidLen)) throw new GitTransactionError('BAD_TARGET', `identity.baseHead 非法: ${identity.baseHead}`);
  if (identity.targetBlobs.length === 0) {
    throw new GitTransactionError('BAD_TARGET', `identity.targetBlobs 为空(规范 writeSet 至少 1 目标)`);
  }
  const seen = new Set<string>();
  for (const t of identity.targetBlobs) {
    normalizeTargetPath(t.path);
    if (seen.has(t.path)) throw new GitTransactionError('BAD_TARGET', `identity.targetBlobs 重复目标路径: ${t.path}`);
    seen.add(t.path);
    if (t.blob === null) {
      if (t.mode !== null) throw new GitTransactionError('BAD_TARGET', `identity.targetBlobs[${t.path}] 删除目标 mode 必须为 null`);
    } else {
      if (t.mode === null || !MODE_SET.has(t.mode)) {
        throw new GitTransactionError('BAD_TARGET', `identity.targetBlobs[${t.path}] 写目标 mode 非法/缺失: ${String(t.mode)}`);
      }
      if (!isOid(t.blob, oidLen)) {
        throw new GitTransactionError('BAD_TARGET', `identity.targetBlobs[${t.path}] blob 非法: ${String(t.blob)}`);
      }
    }
  }
}

function verifyCandidate(ctx: RepoContext, sha: string, expected: string, identity: TxCommitIdentity): boolean {
  // 最强门(加固③⑩): 只接受与「规范 writeSet 重算 + 确定性身份/日期」构造的预期 commit
  // OID 字节级相同的候选 —— 防外部以相同 trailers/身份/日期之外的任何字节差异伪造。
  if (sha !== expected) return false;
  const raw = gitExec({ ctx, repoDir: ctx.repoDir, args: ['cat-file', 'commit', sha] });
  const parsed = parseRawCommit(raw);
  // 1) 单父且 == base HEAD(ADR-0021 §6: commit-tree <tree> -p <base HEAD>)。
  if (parsed.parents.length !== 1 || parsed.parents[0] !== identity.baseHead) return false;
  // 2) exact tree 必等(冻结时 write-tree; 由规范 writeSet 重算, 与 trailer plan-digest 共同防伪)。
  const { tree: recomputedTree } = recomputeTxPlan(ctx, identity);
  if (parsed.tree !== recomputedTree) return false;
  // 3) author/committer 固定 novelcraft 身份 + 确定性日期 + 固定 +0000 时区(加固③)。
  if (!isNovelcraftIdent(parsed.author) || !isNovelcraftIdent(parsed.committer)) return false;
  if (parsed.author === null || parsed.author.date !== NOVELCRAFT_TX_DATE || parsed.author.tz !== '+0000') return false;
  if (parsed.committer === null || parsed.committer.date !== NOVELCRAFT_TX_DATE || parsed.committer.tz !== '+0000') return false;
  // 4) trailers txid/kind/plan-digest 全匹配; 重复 trailer → 不认(加固⑩)。
  const trailers = parseTrailers(ctx, parsed.message);
  if (trailers === null) return false;
  if (trailers.get('txid') !== identity.txid) return false;
  if (trailers.get('kind') !== identity.kind) return false;
  if (trailers.get('plan-digest') !== computePlanDigest(identity.baseHead, parsed.tree, identity.targetBlobs)) return false;
  // 5) 逐 writeSet 目标验证输出 blob(删除目标必须在树中缺席)。tree 等已隐含, 显式复核更严。
  const listing = gitExec({ ctx, repoDir: ctx.repoDir, args: ['ls-tree', '-r', '-z', sha] });
  const entries = new Map<string, string>();
  for (const seg of listing.split('\0')) {
    if (seg === '') continue;
    const tab = seg.indexOf('\t');
    const meta = tab >= 0 ? seg.slice(0, tab).split(' ') : [];
    const p = tab >= 0 ? seg.slice(tab + 1) : '';
    if (p !== '' && meta.length === 3) entries.set(p, meta[2]);
  }
  for (const t of identity.targetBlobs) {
    const actual = entries.get(t.path);
    if (t.blob === null) {
      if (actual !== undefined) return false;
    } else if (actual !== t.blob) {
      return false;
    }
  }
  return true;
}

/**
 * 在 head 的可达历史中定位唯一满足全部严格条件的 tx commit(N32/ADR-0021 §6: 「当前可达
 * 历史中定位带 txid/plan digest 的唯一 commit, 并验证 parent、exact tree、writeSet 与输出
 * blobs」): 0 命中 → TX_NOT_FOUND; >1 命中 → TX_AMBIGUOUS(fail-closed)。
 * 唯一接受门 = 由规范 writeSet 重算 plan digest/tree 后构造的预期 commit 字节级 OID
 * (加固⑩: 不信任 identity 自报的 tree/digest; 加固③: 防同 trailers/日期外部伪造),
 * 命中后显式复核完整身份+日期+trailers+tree+blobs。rev-list 走 --no-replace-objects
 * (加固②: 即使 replace refs 存在, 遍历与 OID 匹配也不受替换欺骗)。
 */
export function readCommittedFile(
  repoDir: string,
  relativePath: string,
  ref: 'HEAD' | string = 'HEAD',
): Uint8Array | undefined {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  const rel = normalizeTargetPath(relativePath);
  if (ref !== 'HEAD' && !isOid(ref, ctx.oidLen)) {
    throw new GitTransactionError('UNKNOWN_REF', `ref 非法: ${ref}`);
  }
  const revPath = `${ref}:${rel}`;
  try {
    gitExec({ ctx, repoDir: ctx.repoDir, args: ['cat-file', '-e', revPath] });
    const binary = gitExec({ ctx, repoDir: ctx.repoDir, args: ['cat-file', 'blob', revPath], binary: true });
    return Buffer.from(binary, 'latin1');
  } catch {
    return undefined;
  }
}

export function probeTxCommitForTargets(
  repoDir: string,
  head: string,
  txid: string,
  kind: string,
  targets: readonly TxTargetWrite[],
): FoundTxCommit | 'ambiguous' | undefined {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  const resolvedHead = head === 'HEAD'
    ? gitExec({ ctx, repoDir: ctx.repoDir, args: ['rev-parse', '--verify', 'HEAD'] }).trim()
    : head;
  if (!isOid(resolvedHead, ctx.oidLen)) throw new GitTransactionError('UNKNOWN_REF', `head 非法: ${head}`);
  const commits = gitExec({ ctx, repoDir: ctx.repoDir, args: ['rev-list', '--topo-order', resolvedHead] })
    .split(/\r?\n/)
    .filter((oid) => isOid(oid, ctx.oidLen));
  const hits: string[] = [];
  for (const commit of commits) {
    const parsed = parseRawCommit(gitExec({ ctx, repoDir: ctx.repoDir, args: ['cat-file', 'commit', commit] }));
    if (parsed.parents.length !== 1) continue;
    const trailers = parseTrailers(ctx, parsed.message);
    if (trailers === null || trailers.get('txid') !== txid || trailers.get('kind') !== kind) continue;
    try {
      const derived = derivePlanIdentityPure(repoDir, parsed.parents[0], targets);
      const identity: TxCommitIdentity = {
        txid,
        kind,
        baseHead: parsed.parents[0],
        targetBlobs: derived.targetBlobs,
      };
      const expected = expectedTxCommitOid(ctx, identity);
      if (verifyCandidate(ctx, commit, expected, identity)) hits.push(commit);
    } catch {
      // Candidate parent cannot produce the planned write set; it is not this transaction.
    }
  }
  if (hits.length > 1) return 'ambiguous';
  return hits.length === 1 ? { commit: hits[0] } : undefined;
}

export function findTxCommit(repoDir: string, head: string, identity: TxCommitIdentity): FoundTxCommit {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  if (!isOid(head, ctx.oidLen)) throw new GitTransactionError('UNKNOWN_REF', `head 非法: ${head}`);
  validateIdentity(identity, ctx.oidLen);

  const expected = expectedTxCommitOid(ctx, identity);
  const all = gitExec({ ctx, repoDir: ctx.repoDir, args: ['rev-list', '--topo-order', head] })
    .split(/\r?\n/)
    .filter((l) => isOid(l, ctx.oidLen));

  const matches = all.filter((sha) => sha === expected);
  if (matches.length === 0) {
    throw new GitTransactionError('TX_NOT_FOUND', `可达历史无匹配 tx commit(txid=${identity.txid})`);
  }
  // rev-list 输出无重复 OID, >1 实际不可达; 保留 fail-closed 分支(防未来遍历语义回归)。
  if (matches.length > 1) {
    throw new GitTransactionError('TX_AMBIGUOUS', `可达历史存在多个匹配 tx commit(txid=${identity.txid})`, matches);
  }
  const sha = matches[0];
  // OID 完全相等但显式复核失败(理论上不可达)也视为不认 —— 保守 fail-closed。
  if (!verifyCandidate(ctx, sha, expected, identity)) {
    throw new GitTransactionError('TX_NOT_FOUND', `可达历史候选 OID 匹配但显式验证失败(txid=${identity.txid})`);
  }
  return { commit: sha };
}

// ============================================================================
// 新 HEAD 共享 index bytes(供上层同目录 temp+rename 原子安装到 .git/index)
// ============================================================================

/**
 * 构建与 commit 完全一致的共享 index bytes(新 HEAD 状态; N32/ADR-0021 §6「构建与新 HEAD
 * 一致的最终 index 并原子安装」)。用临时私有 index `read-tree <commit>` 冻结后读出原始字节,
 * 不触碰共享 index/lock; 安装(同目录 temp + rename)是上层职责。失败于 read-tree → GIT_ERROR,
 * 不产生任何 index 副作用。
 */
export function buildHeadIndexBytes(repoDir: string, commit: string): Uint8Array {
  const ctx = resolveRepoContext(repoDir);
  assertSafeRepoState(ctx);
  if (!isOid(commit, ctx.oidLen)) throw new GitTransactionError('UNKNOWN_REF', `commit 非法: ${commit}`);
  const tmp = gitPath(ctx, `novelcraft-head-${randomBytes(8).toString('hex')}.index`);
  try {
    gitExec({ ctx, repoDir: ctx.repoDir, args: ['read-tree', commit], env: { GIT_INDEX_FILE: tmp } });
    return new Uint8Array(fs.readFileSync(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
