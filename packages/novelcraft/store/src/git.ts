import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { StoreError } from './errors.js';

/**
 * node:child_process 调 git CLI 的薄封装(R17/R14: adopt = 一次原子 commit;
 * git 历史天然承接版本/软删)。所有函数以 repoDir 为 cwd 执行。
 */

function run(repoDir: string, args: string[], opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (opts?.allowFailure) return '';
    const stderr = (err as { stderr?: Buffer | string })?.stderr;
    const msg = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    throw new StoreError('GIT_ERROR', `git ${args.join(' ')} 失败: ${msg.trim() || String(err)}`, args);
  }
}

export function gitInit(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  run(repoDir, ['init']);
}

export function isGitRepo(repoDir: string): boolean {
  return run(repoDir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }) === 'true';
}

/** porcelain status 每行一条(干净时返回空数组)。 */
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
  run(repoDir, ['revert', '--no-edit', commit]);
}

/** 最近 N 条 commit 的 subject(测试/审计用)。 */
export function gitLogSubjects(repoDir: string, max = 50): string[] {
  return run(repoDir, ['log', '--format=%s', `-n`, String(max)])
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}
