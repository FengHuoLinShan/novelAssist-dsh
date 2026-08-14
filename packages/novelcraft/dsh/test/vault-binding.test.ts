// SessionVaultBinder 行为契约(seam: vault/会话绑定)。
// 断言引 seam 契约 + D17(一书一会话一 vault 根)+ §14(子代理 prompt 注入书名/路径)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, NovelcraftCache, SessionVaultBinder, type Config } from '../src/index.js';
import { makeContext } from './helpers.js';

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
    const binder = new SessionVaultBinder(config, new NovelcraftCache(h.ctx));
    const binding = binder.ensureVault('测试书');
    await binder.bindSession('s-1', binding);
    await expect(binder.resolve('s-1')).resolves.toMatchObject({ book: '测试书', root: binding.root });
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
