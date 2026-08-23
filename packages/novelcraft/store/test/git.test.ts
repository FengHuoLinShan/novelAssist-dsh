import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  gitInit,
  isGitRepo,
  gitStatusPorcelain,
  gitStatusEntries,
  parsePorcelainV1Z,
  hasUncommittedChanges,
  hasUncommittedOutside,
  gitAdd,
  gitCommit,
  gitHead,
  gitMove,
  gitRevert,
  gitLogSubjects,
  gitRead,
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
    expect(gitRead(r, ['show', '-s', '--format=%s', sha])).toBe('first');
    expect(() => gitRead(r, ['commit', '--allow-empty', '-m', 'forbidden'])).toThrow(/拒绝非只读参数/);
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

// 已证实解析 bug 回归: run() 整体 trim + 逐行 trim 会吃掉 unstaged 状态行(" M file")
// 的前导空格列位, 使 slice(3) 丢掉路径首字符。gitStatusEntries 走 -z 原始输出(不 trim)。
describe('gitStatusEntries(-z 结构化解析, 不 trim)', () => {
  it('unstaged 修改保留前导空格列位且路径完整(回归: 首字符不再丢失)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'has space.md'), 'a');
    gitAdd(r);
    gitCommit(r, 'init');
    fs.writeFileSync(path.join(r, 'has space.md'), 'b'); // unstaged 修改
    expect(gitStatusEntries(r)).toEqual([{ status: ' M', path: 'has space.md' }]);
    // 空格文件名在 -z 下不引号化、逐字保留。
  });

  it('staged("M ")/unstaged(" M")/双改("MM")/untracked("??") 均正确解析', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.md'), 'a');
    gitAdd(r);
    gitCommit(r, 'init');
    fs.writeFileSync(path.join(r, 'a.md'), 'b'); // 未暂存
    fs.writeFileSync(path.join(r, 'c.md'), 'c');
    gitAdd(r); // 新增并暂存
    fs.writeFileSync(path.join(r, 'a.md'), 'd'); // 现在 a.md 为 "MM"(暂存+未暂存)
    fs.writeFileSync(path.join(r, 'untracked.md'), 'x');
    const entries = gitStatusEntries(r);
    const byPath = new Map(entries.map((e) => [e.path, e.status]));
    expect(byPath.get('a.md')).toBe('MM');
    expect(byPath.get('c.md')).toBe('A ');
    expect(byPath.get('untracked.md')).toBe('??');
  });

  it('rename 解析为双路径(new 在前, fromPath 在后)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'old.md'), 'a');
    gitAdd(r);
    gitCommit(r, 'init');
    gitMove(r, 'old.md', 'new.md'); // staged rename
    expect(gitStatusEntries(r)).toEqual([{ status: 'R ', path: 'new.md', fromPath: 'old.md' }]);
  });
});

describe('hasUncommittedOutside(允许精确/目录前缀; 各状态码)', () => {
  it('untracked: 允许精确文件不脏; 范围外文件脏', () => {
    const r = repo();
    fs.mkdirSync(path.join(r, '.assistant'), { recursive: true });
    fs.writeFileSync(path.join(r, '.assistant', 'checkpoint.json'), '{}');
    expect(hasUncommittedOutside(r, ['.assistant/checkpoint.json'])).toBe(false);
    fs.writeFileSync(path.join(r, 'notes.md'), 'x');
    expect(hasUncommittedOutside(r, ['.assistant/checkpoint.json'])).toBe(true);
  });

  it('untracked 目录前缀: 允许 "dir/" 放行其下文件; 范围外文件脏', () => {
    const r = repo();
    fs.mkdirSync(path.join(r, 'imports'), { recursive: true });
    fs.writeFileSync(path.join(r, 'imports', 'raw.txt'), 'x');
    expect(hasUncommittedOutside(r, ['imports/'])).toBe(false);
    fs.writeFileSync(path.join(r, 'outside.txt'), 'x');
    expect(hasUncommittedOutside(r, ['imports/'])).toBe(true);
    // 允许 'imports'(无斜杠)= 精确文件匹配, 不放行 imports/raw.txt。
    expect(hasUncommittedOutside(r, ['imports'])).toBe(true);
  });

  it('unstaged/staged/双改 tracked 文件: 允许精确路径时不脏(回归: trim 丢首字符 bug)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'has space.md'), 'a');
    gitAdd(r);
    gitCommit(r, 'init');
    // unstaged 修改: 旧实现 trim 后 slice(3) 得 "as space.md"(丢 'h')→ 误判脏。
    fs.writeFileSync(path.join(r, 'has space.md'), 'b');
    expect(hasUncommittedOutside(r, ['has space.md'])).toBe(false);
    // staged 修改。
    fs.writeFileSync(path.join(r, 'has space.md'), 'c');
    gitAdd(r);
    expect(hasUncommittedOutside(r, ['has space.md'])).toBe(false);
    // 双改(暂存后又改)。
    fs.writeFileSync(path.join(r, 'has space.md'), 'd');
    expect(hasUncommittedOutside(r, ['has space.md'])).toBe(false);
    // 范围外 untracked 文件 → 脏。
    fs.writeFileSync(path.join(r, 'x.md'), 'x');
    expect(hasUncommittedOutside(r, ['has space.md'])).toBe(true);
  });

  it('rename: 新/源双路径任一在允许范围外 → 脏; 两端都允许 → 干净', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'old.md'), 'a');
    gitAdd(r);
    gitCommit(r, 'init');
    gitMove(r, 'old.md', 'new.md');
    expect(hasUncommittedOutside(r, ['new.md', 'old.md'])).toBe(false); // 双路径都允许
    expect(hasUncommittedOutside(r, ['new.md'])).toBe(true); // 源路径 old.md 在范围外(删除侧)
    expect(hasUncommittedOutside(r, ['old.md'])).toBe(true); // 新路径 new.md 在范围外(新增侧)
  });

  it('真实 git "RD"(暂存 rename + worktree 删除): 双路径消费 + 范围判定', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.md'), 'aaa');
    gitAdd(r);
    gitCommit(r, 'init');
    gitMove(r, 'a.md', 'b.md'); // 暂存 rename
    fs.unlinkSync(path.join(r, 'b.md')); // worktree 删除 rename 目标 → "RD"
    expect(gitStatusEntries(r)).toContainEqual({ status: 'RD', path: 'b.md', fromPath: 'a.md' });
    expect(hasUncommittedOutside(r, ['a.md', 'b.md'])).toBe(false); // 双路径都允许
    expect(hasUncommittedOutside(r, ['b.md'])).toBe(true); // 源 a.md(删除侧)在范围外
  });
});

describe('parsePorcelainV1Z(Y 列 R/C 未暂存 rename/copy 双路径)', () => {
  it('Y 列 R/C 同样消费 fromPath; 普通条目不受影响', () => {
    // 合成 porcelain v1 -z 原始输出(git-status XY 矩阵 Y 列含 R/C;
    // 真实 git 普通工作流常把 worktree rename 呈现为 D+??, 故用纯解析器确定性覆盖)。
    const raw = ' R c.md\0b.md\0 C e.md\0d.md\0 M f.md\0MM g.md\0?? h.md\0';
    expect(parsePorcelainV1Z(raw)).toEqual([
      { status: ' R', path: 'c.md', fromPath: 'b.md' },
      { status: ' C', path: 'e.md', fromPath: 'd.md' },
      { status: ' M', path: 'f.md' },
      { status: 'MM', path: 'g.md' },
      { status: '??', path: 'h.md' },
    ]);
  });

  it('X 列 R/C 与双字符状态(RD/RM)仍正确消费双路径', () => {
    const raw = 'R  c.md\0b.md\0RD e.md\0d.md\0C  g.md\0f.md\0';
    expect(parsePorcelainV1Z(raw)).toEqual([
      { status: 'R ', path: 'c.md', fromPath: 'b.md' },
      { status: 'RD', path: 'e.md', fromPath: 'd.md' },
      { status: 'C ', path: 'g.md', fromPath: 'f.md' },
    ]);
  });
});
