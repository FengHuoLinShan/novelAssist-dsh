import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { StoreError } from './errors.js';

/**
 * node:child_process 调 git CLI 的薄封装(R17/R14: adopt = 一次原子 commit;
 * git 历史天然承接版本/软删)。所有函数以 repoDir 为 cwd 执行。
 */

function execFile(repoDir: string, args: string[], opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (opts?.allowFailure) return '';
    const stderr = (err as { stderr?: Buffer | string })?.stderr;
    const msg = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    throw new StoreError('GIT_ERROR', `git ${args.join(' ')} 失败: ${msg.trim() || String(err)}`, args);
  }
}

function run(repoDir: string, args: string[], opts?: { allowFailure?: boolean }): string {
  return execFile(repoDir, args, opts).trim();
}

/** 保留原始输出的调用(-z 解析专用; 不能 trim: porcelain 状态行前导空格是 index 列位,
 * 整体 trim 会把首行前导空格吃掉导致 slice(3) 路径错位)。 */
function runRaw(repoDir: string, args: string[]): string {
  return execFile(repoDir, args);
}

const READ_ONLY_COMMANDS = new Set(['rev-parse', 'show', 'log', 'diff']);

/** Store 内部历史读面；拒绝写子命令，保留 Git CLI 的单一封层。 */
export function gitRead(
  repoDir: string,
  args: string[],
  opts?: { allowFailure?: boolean; raw?: boolean },
): string {
  if (!READ_ONLY_COMMANDS.has(args[0] ?? '') || args.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
    throw new StoreError('VALIDATION_FAILED', `gitRead 拒绝非只读参数: ${args.join(' ')}`);
  }
  const output = execFile(repoDir, ['--no-optional-locks', '--no-replace-objects', ...args], {
    allowFailure: opts?.allowFailure,
  });
  return opts?.raw ? output : output.trim();
}

export function gitInit(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  run(repoDir, ['init', '--initial-branch=main']);
}

export function isGitRepo(repoDir: string): boolean {
  return run(repoDir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }) === 'true';
}

/** porcelain status 每行一条(干净时返回空数组)。兼容旧调用方: 实现会逐行 trim,
 * 会去掉 unstaged 状态行(" M file")的前导空格列位, 因此本函数只适合「是否有改动」
 * 类判断(hasUncommittedChanges); 精确路径解析请用 gitStatusEntries(-z 结构化, 不 trim)。 */
export function gitStatusPorcelain(repoDir: string): string[] {
  return run(repoDir, ['status', '--porcelain'])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 工作区是否存在未提交/未暂存改动(R17 CAS)。 */
export function hasUncommittedChanges(repoDir: string): boolean {
  return gitStatusPorcelain(repoDir).length > 0;
}

/** porcelain=v1 -z 结构化条目(不 trim、路径不引号化; rename/copy 携带双路径)。 */
export interface PorcelainEntry {
  /** 两位状态码(如 " M"/"MM"/"??"/"R "/"RD"/" R"), 前导空格即 index 列位, 原样保留。 */
  status: string;
  /** 工作区相对路径(rename/copy 条目为「新路径」, -z 下新路径在前)。 */
  path: string;
  /** rename/copy 的源路径(仅 R/C 条目; 两端都落在允许范围才视为干净)。 */
  fromPath?: string;
}

/**
 * porcelain v1 -z 纯解析器(原始输出 → 条目; 不做任何 trim):
 * - 状态码 XY 两列: X=index 列、Y=worktree 列; rename/copy 可出现在任一列
 *   ('R '/'RD'/' R'/' C' 等, git-status XY 矩阵 Y 列含 R/C)——任一列是 R/C 都消费
 *   双路径 "XY <new>\0<old>\0"(新路径在前; 实测 git mv b.md c.md → "R  c.md\0b.md\0",
 *   未暂存 rename 同为 " R <new>\0<old>\0");
 * - 空格/非 ASCII 文件名逐字保留(-z 不引号/八进制转义)。
 */
export function parsePorcelainV1Z(raw: string): PorcelainEntry[] {
  const parts = raw.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg.length === 0) continue;
    const status = seg.slice(0, 2);
    const path = seg.slice(3);
    const isRename = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
    if (isRename && i + 1 < parts.length) {
      entries.push({ status, path, fromPath: parts[++i] });
    } else {
      entries.push({ status, path });
    }
  }
  return entries;
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` 的结构化解析:
 * - 走 runRaw 保留原始输出(不 trim): 状态行前导空格是 index 列位, trim 会使
 *   slice(3) 丢掉路径首字符(已证实解析 bug 的根因);
 * - -uall 使未跟踪文件逐条列出(不折叠目录); 其余格式语义见 parsePorcelainV1Z。
 */
export function gitStatusEntries(repoDir: string): PorcelainEntry[] {
  return parsePorcelainV1Z(runRaw(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
}

/** 路径是否落在允许范围: 允许项以 `/` 结尾 = 目录前缀; 否则 = 精确文件匹配。 */
function isAllowedPath(p: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
}

/**
 * 工作区是否存在「不属于允许前缀范围」的未提交/未暂存改动(R17 范围语义:
 * store-rules.md "有未暂存/未提交变更(且不属于本次操作范围)→ 拒绝")。
 * 基于 gitStatusEntries(-z 结构化解析): staged/unstaged/untracked/rename 双路径
 * 逐一判定, 任一路径在允许范围外 → true。
 */
export function hasUncommittedOutside(repoDir: string, allowed: readonly string[]): boolean {
  return gitStatusEntries(repoDir).some((e) => {
    if (!isAllowedPath(e.path, allowed)) return true;
    if (e.fromPath !== undefined && !isAllowedPath(e.fromPath, allowed)) return true;
    return false;
  });
}

export function gitAdd(repoDir: string, paths: string[] = ['-A']): void {
  run(repoDir, ['add', ...paths]);
}

export function gitCommit(repoDir: string, message: string): string {
  run(repoDir, [
    '-c',
    'user.name=novelcraft',
    '-c',
    'user.email=novelcraft@example.invalid',
    'commit',
    '-m',
    message,
  ]);
  return gitHead(repoDir);
}

export function gitHead(repoDir: string): string {
  return run(repoDir, ['rev-parse', 'HEAD']);
}

export function gitMove(repoDir: string, from: string, to: string): void {
  run(repoDir, ['mv', from, to]);
}

export function gitRevert(repoDir: string, commit: string): void {
  run(repoDir, [
    '-c',
    'user.name=novelcraft',
    '-c',
    'user.email=novelcraft@example.invalid',
    'revert',
    '--no-edit',
    commit,
  ]);
}

/** 最近 N 条 commit 的 subject(测试/审计用)。 */
export function gitLogSubjects(repoDir: string, max = 50): string[] {
  return run(repoDir, ['log', '--format=%s', `-n`, String(max)])
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}
