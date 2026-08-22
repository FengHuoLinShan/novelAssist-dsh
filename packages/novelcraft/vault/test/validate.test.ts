/**
 * @novelcraft/vault · validateInitializedVault 行为契约(N34 工作区隔离 seam)。
 *
 * 只读校验: book.yml 合法、.git 为真实目录且 HEAD 可解析、必要骨架存在。
 * 供 DSH bindByCwd/工具/事件钩子在把任意目录当 vault 前 fail-closed 前置校验;
 * 绝不自动 init。断言省略号引 R9(工作区隔离)/N34(生命周期)/N32(HEAD 初始 commit)。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initVault, validateInitializedVault } from '../src/index';

const tmpDirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-validate-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** 目录 symlink 探测(Windows junction 通常可用; 仍失败则整组跳过)。 */
const symlinksSupported = (() => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-validate-probe-'));
  try {
    const target = path.join(base, 'target');
    mkdirSync(target);
    symlinkSync(target, path.join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
})();

describe('validateInitializedVault(N34: 只读验证「已初始化」vault)', () => {
  it('已 initVault 的 vault → ok:true(book.yml/.git+HEAD/骨架全过)', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });
    expect(validateInitializedVault(root)).toEqual({ ok: true });
  });

  it('空目录/无 book.yml → ok:false(拒绝任意目录当 vault, R9)', () => {
    const root = tmpRoot();
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/book\.yml/);
  });

  it('伪 book.yml 无 .git → ok:false(.git 缺失, 绝不当作已初始化 vault)', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "伪书"\n', 'utf8');
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\.git/);
  });

  it('book.yml + git init 但 HEAD unborn → ok:false(N32: HEAD 必须可解析)', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "无头"\n', 'utf8');
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HEAD|commit/i);
  });

  it('删除骨架目录(如 bible)→ ok:false(必要骨架不全, 拒绝)', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    rmSync(path.join(root, 'bible'), { recursive: true, force: true });
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/骨架|bible/);
  });

  it('book.yml 缺合法 title → ok:false(伪/损坏 book.yml 拒绝)', () => {
    const root = tmpRoot();
    // 完整骨架 + .git + HEAD 全部就位, 只把 title 换成空(非合法)。
    initVault(root, { title: 'Book' });
    writeFileSync(path.join(root, 'book.yml'), 'title: "  "\n', 'utf8');
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/title/);
  });

  it('book.yml 的 default_reveal_policy 越白名单 → ok:false(与 initVault 同规则)', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    writeFileSync(
      path.join(root, 'book.yml'),
      'title: "Book"\ndefault_reveal_policy: "everything"\n',
      'utf8',
    );
    const r = validateInitializedVault(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/default_reveal_policy/);
  });

  it.skipIf(!symlinksSupported)(
    'book.yml 或 .git 为 symlink → ok:false(fail-closed, 不跟随任意链接)',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      writeFileSync(path.join(outside, 'victim.yml'), 'title: "外部"\n');
      // .git symlink
      const a = tmpRoot();
      initVault(a, { title: 'A' });
      rmSync(path.join(a, '.git'), { recursive: true, force: true });
      const gitTarget = tmpRoot();
      mkdirSync(gitTarget, { recursive: true });
      symlinkSync(gitTarget, path.join(a, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
      const r1 = validateInitializedVault(a);
      expect(r1.ok).toBe(false);
      expect(r1.reason).toMatch(/\.git/);
      // book.yml symlink(指向外部文件)
      const b = tmpRoot();
      initVault(b, { title: 'B' });
      writeFileSync(path.join(b, 'book.yml'), 'title: "B"\n');
      rmSync(path.join(b, 'book.yml'));
      symlinkSync(path.join(outside, 'victim.yml'), path.join(b, 'book.yml'));
      const r2 = validateInitializedVault(b);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/book\.yml/);
    },
  );

  it('非法 title 之外的其他骨架(.git+HEAD)仍就位时, 非检查项不误伤', () => {
    const root = tmpRoot();
    initVault(root, { title: '合法书' });
    // 完整 vault(含全部骨架) → 通过; 证明校验只要求 title 合法, 不要求其他字段。
    expect(validateInitializedVault(root).ok).toBe(true);
    expect(existsSync(path.join(root, 'book.yml'))).toBe(true);
  });
});
