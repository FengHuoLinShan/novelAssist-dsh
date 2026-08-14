import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  gitInit,
  isGitRepo,
  gitStatusPorcelain,
  hasUncommittedChanges,
  gitAdd,
  gitCommit,
  gitHead,
  gitRevert,
  gitLogSubjects,
} from '../src/index';
import { tmpVault } from './helpers';

const cleanups: Array<() => void> = [];

function repo(): string {
  const { root, cleanup } = tmpVault();
  cleanups.push(cleanup);
  gitInit(root);
  return root;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('git 薄封装(真实临时 git 仓库)', () => {
  it('init creates a repo (isGitRepo true)', () => {
    const r = repo();
    expect(isGitRepo(r)).toBe(true);
  });

  it('commit + head + log', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.md'), 'hello');
    gitAdd(r);
    const sha = gitCommit(r, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(gitHead(r)).toBe(sha);
    expect(gitLogSubjects(r)).toContain('first');
  });

  it('hasUncommittedChanges reflects working-tree state (R17 前置)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.md'), 'hello');
    gitAdd(r);
    gitCommit(r, 'first');
    expect(hasUncommittedChanges(r)).toBe(false);
    fs.writeFileSync(path.join(r, 'a.md'), 'changed');
    expect(hasUncommittedChanges(r)).toBe(true);
    expect(gitStatusPorcelain(r).length).toBeGreaterThan(0);
  });

  it('revert restores a prior commit (软删回滚语义的基础)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.md'), 'A');
    gitAdd(r);
    gitCommit(r, 'add A');
    fs.writeFileSync(path.join(r, 'b.md'), 'B');
    gitAdd(r);
    const second = gitCommit(r, 'add B');
    gitRevert(r, second);
    expect(fs.existsSync(path.join(r, 'b.md'))).toBe(false);
    expect(fs.existsSync(path.join(r, 'a.md'))).toBe(true);
  });
});
