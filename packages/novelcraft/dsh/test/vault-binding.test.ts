// SessionVaultBinder 行为契约(seam: vault/会话绑定)。
// 断言引 seam 契约 + D17(一书一会话一 vault 根)+ §14(子代理 prompt 注入书名/路径)。
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, NovelcraftCache, SessionVaultBinder, type Config } from '../src/index.js';
import { makeContext } from './helpers.js';

function makeConfig(vaultsDir: string): Config {
  return {
    llm: { provider: 'fake', model: 'm' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  };
}

describe('SessionVaultBinder', () => {
  it('ensureVault 幂等创建(vaultsDir/<书名>)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const config: Config = {
      llm: { provider: 'fake', model: 'm' },
      vaultsDir: dir,
      watch: { enabled: false, intervalMinutes: 60 },
    };
    const binder = new SessionVaultBinder(config);
    const binding = binder.ensureVault('测试书');
    expect(binding.root).toBe(path.join(dir, '测试书'));
    expect(binding.book).toBe('测试书');
    // 幂等: 再次 ensure 不抛、不覆盖
    expect(() => binder.ensureVault('测试书')).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bindSession/resolve: 内存 + domain 双面绑定', async () => {
    const h = await makeContext();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const config: Config = {
      llm: { provider: 'fake', model: 'm' },
      vaultsDir: dir,
      watch: { enabled: false, intervalMinutes: 60 },
    };
    const cache = new NovelcraftCache(h.ctx);
    const binder = new SessionVaultBinder(config, cache);
    const binding = binder.ensureVault('测试书');
    await binder.bindSession('s-1', binding);
    await expect(binder.resolve('s-1')).resolves.toMatchObject({ book: '测试书', root: binding.root });
    // HMR/new binder cache lookup is read-through only: tools cannot manufacture a lifecycle ref.
    const reloaded = new SessionVaultBinder(config, cache);
    await expect(reloaded.resolve('s-1')).resolves.toMatchObject({ root: binding.root });
    expect(reloaded.referenceCount(binding.root)).toBe(0);
    await expect(reloaded.bindSession('s-1', binding)).resolves.toMatchObject({ activated: true, count: 1 });
    await cache.close();
    await h.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveFromPath: 任意子路径 → 最近 vault 根', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const config: Config = {
      llm: { provider: 'fake', model: 'm' },
      vaultsDir: dir,
      watch: { enabled: false, intervalMinutes: 60 },
    };
    const binder = new SessionVaultBinder(config);
    const binding = binder.ensureVault('测试书');
    const child = path.join(binding.root, 'chapters', '003.md');
    expect(binder.resolveFromPath(child)).toMatchObject({ book: '测试书' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('contextInjection 含书名/vault 根/纪律条款(§14)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const config: Config = {
      llm: { provider: 'fake', model: 'm' },
      vaultsDir: dir,
      watch: { enabled: false, intervalMinutes: 60 },
    };
    const binder = new SessionVaultBinder(config);
    const binding = binder.ensureVault('测试书');
    const text = binder.contextInjection(binding);
    expect(text).toContain('测试书');
    expect(text).toContain(binding.root);
    expect(text).toContain('world/pending/');
    expect(text).toContain('不得写入任何产出物');
    rmSync(dir, { recursive: true, force: true });
  });

  it('expandHome: ~ 展开为 HOME', () => {
    expect(expandHome('~/Novels', { HOME: '/home/u' })).toBe('/home/u/Novels');
    expect(expandHome('~', { HOME: '/home/u' })).toBe('/home/u');
    expect(expandHome('/abs/path', { HOME: '/home/u' })).toBe('/abs/path');
  });
});

describe('N34 session lifecycle 绑定', () => {
  it('bindByCwd 只绑定已有 vault，不存在 cwd/普通目录绝不自动创建', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const missing = path.join(dir, '不存在');
    await expect(binder.bindByCwd('s-missing', missing)).resolves.toMatchObject({ status: 'unbound' });
    expect(existsSync(missing)).toBe(false);
    await expect(binder.bindByCwd('s-relative', 'relative/path')).resolves.toMatchObject({ status: 'unbound' });
    await expect(binder.bindByCwd('s-plain', dir)).resolves.toMatchObject({ status: 'unbound' });
    expect(binder.listBound()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('同 vault 多 session 引用计数，只有最后 disposed 返回 lastForVault', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const binding = binder.ensureVault('测试书');
    await expect(binder.bindByCwd('s-1', path.join(binding.root, 'chapters'))).resolves.toMatchObject({ status: 'bound' });
    await expect(binder.bindByCwd('s-2', binding.root)).resolves.toMatchObject({ status: 'bound' });
    expect(binder.referenceCount(binding.root)).toBe(2);
    expect(binder.activeVaults()).toHaveLength(1);
    await expect(binder.unbindSession('s-1')).resolves.toMatchObject({ remaining: 1, lastForVault: false });
    await expect(binder.unbindSession('s-2')).resolves.toMatchObject({ remaining: 0, lastForVault: true });
    expect(binder.activeVaults()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('rootForBook/ensureVault: 书名强制单个非空目录名(工作区隔离 R9)', () => {
  it('拒绝 ../、绝对路径、路径分隔符、空名与控制字符', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const bad = [
      '..', // 直接逃到 vaultsDir 之外
      '../evil', // 带子路径逃逸
      'a/../../evil', // 折叠后逃逸
      '/abs/outside', // 绝对路径
      'a\\b', // 反斜杠分隔符(Windows 路径分隔符)
      'a/b', // 正斜杠分隔符
      '', // 空名
      '   ', // 纯空白名
      'a\u0000b', // 控制字符
    ];
    for (const book of bad) {
      expect(() => binder.rootForBook(book), `rootForBook(${JSON.stringify(book)})`).toThrow();
      expect(() => binder.ensureVault(book), `ensureVault(${JSON.stringify(book)})`).toThrow();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('逃逸/绝对路径名被拒后未在外部创建任何文件(R9)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    const parent = path.dirname(dir);

    expect(() => binder.ensureVault('../evil')).toThrow();
    expect(existsSync(path.join(parent, 'evil'))).toBe(false);
    expect(() => binder.ensureVault(path.join(parent, 'abs-evil'))).toThrow();
    expect(existsSync(path.join(parent, 'abs-evil'))).toBe(false);
    // vaultsDir 内同样零残留(全部拒绝发生在任何 fs 操作之前)。
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('保留合法中文/含空格书名行为(R9)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'));
    const binder = new SessionVaultBinder(makeConfig(dir));
    expect(binder.rootForBook('诡秘之主')).toBe(path.join(dir, '诡秘之主'));
    expect(binder.rootForBook('The Way of Kings')).toBe(
      path.join(dir, 'The Way of Kings'),
    );
    const binding = binder.ensureVault('克苏鲁 之主');
    expect(binding.root).toBe(path.join(dir, '克苏鲁 之主'));
    expect(existsSync(path.join(dir, '克苏鲁 之主', 'book.yml'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
