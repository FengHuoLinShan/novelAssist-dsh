// SessionVaultBinder.bindByCwd 的「已初始化」前置校验(N34 工作区隔离)。
// bindByCwd(HMR/session/created 使用)只绑定通过 validateInitializedVault 的 vault;
// 伪 book.yml(无 .git)/半初始化一律不绑定、不激活 watch、绝不自动 init、零 fs 副作用。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionVaultBinder, type Config } from '../src/index.js';

function makeConfig(vaultsDir: string): Config {
  return {
    llm: { provider: 'fake', model: 'm' },
    vaultsDir,
    watch: { enabled: true, intervalMinutes: 60 },
  };
}

describe('N34 bindByCwd 只绑定已初始化 vault(validateInitializedVault 前置)', () => {
  it('伪 book.yml 无 git → unbound, 零绑定、不自动 init、零 fs 副作用', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-bindvalidate-'));
    const fake = path.join(dir, '伪书');
    // 目录 + 伪 book.yml, 但没有任何 .git: 过去会绑定, 现在必须拒绝。
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, 'book.yml'), 'title: "伪书"\n', 'utf8');

    const binder = new SessionVaultBinder(makeConfig(dir));
    const r = await binder.bindByCwd('s-pseudo', fake);
    expect(r.status).toBe('unbound');
    if (r.status === 'unbound') expect(r.reason).toMatch(/\.git/);
    // 绝不自动 init: .git 仍不存在
    expect(existsSync(path.join(fake, '.git'))).toBe(false);
    // 未绑定、未激活 watch(引用计数 0)
    expect(binder.listBound()).toEqual([]);
    expect(binder.referenceCount(path.resolve(fake))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('半初始化(git init 但 HEAD unborn)→ unbound(HEAD 必须可解析, N32)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-bindvalidate-'));
    const fake = path.join(dir, '无头书');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, 'book.yml'), 'title: "无头书"\n', 'utf8');
    execFileSync('git', ['init'], { cwd: fake, stdio: 'pipe' });

    const binder = new SessionVaultBinder(makeConfig(dir));
    const r = await binder.bindByCwd('s-unborn', fake);
    expect(r.status).toBe('unbound');
    if (r.status === 'unbound') expect(r.reason).toMatch(/HEAD|commit/i);
    expect(binder.listBound()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('骨架缺失(好 vault 少目录)→ unbound(必要骨架存在), 绑定为零', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-bindvalidate-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const binding = binder.ensureVault('好书'); // 标准初始化
    const { rmSync: rm } = await import('node:fs');
    rm(path.join(binding.root, 'bible'), { recursive: true, force: true });

    const r = await binder.bindByCwd('s-broken', binding.root);
    expect(r.status).toBe('unbound');
    if (r.status === 'unbound') expect(r.reason).toMatch(/骨架|bible/);
    expect(binder.listBound()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('标准已初始化 vault 仍正常绑定(ensureVault 幂等初始化不被绑定路径使用)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-bindvalidate-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const binding = binder.ensureVault('真实书');
    // 经子目录 cwd 绑定: 解析到根后仍须过 validateInitializedVault
    const r = await binder.bindByCwd('s-ok', path.join(binding.root, 'chapters'));
    expect(r.status).toBe('bound');
    expect(binder.listBound()).toHaveLength(1);
    expect(binder.activeVaults()).toHaveLength(1);
    await binder.unbindSession('s-ok');
    rmSync(dir, { recursive: true, force: true });
  });
});
