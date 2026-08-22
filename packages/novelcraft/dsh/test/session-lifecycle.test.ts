// N34 / ADR-0023: server session lifecycle drives vault refs; browser state is absent.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NovelcraftNodeRuntime, NovelcraftSessionLifecycle, SessionVaultBinder, type Config } from '../src/index.js';
import { makeContext } from './helpers.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(vaultsDir: string): Config {
  return { llm: { provider: 'fake', model: 'm' }, vaultsDir, watch: { enabled: true, intervalMinutes: 60 } };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}

function publish(store: SessionStore, id: string, cwd: string): { session: ReturnType<SessionStore['prepare']>; detach: () => void } {
  const session = store.prepare(id as never, { meta: { cwd } });
  const detach = store.enter(session);
  store.announce(session);
  return { session, detach };
}

describe('NovelcraftSessionLifecycle', () => {
  it('start/HMR 扫描 live sessions；同 vault 引用计数只触发一次 activate/最后一次 deactivate', async () => {
    const h = await makeContext();
    const sessions = new SessionStore(h.ctx);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-session-life-'));
    cleanup.push(dir);
    const binder = new SessionVaultBinder(config(dir));
    const binding = binder.ensureVault('书');
    const events: string[] = [];

    const first = publish(sessions, 's-1', binding.root); // lifecycle 加载前已存在(HMR seam)
    const lifecycle = new NovelcraftSessionLifecycle(h.ctx, binder, {
      onVaultActivated: (vault) => events.push(`on:${vault.root}`),
      onVaultDeactivated: (vault) => events.push(`off:${vault.root}`),
    });
    lifecycle.start();
    await until(() => binder.referenceCount(binding.root) === 1 && events.length === 1);
    expect(events).toEqual([`on:${binding.root}`]);

    const second = publish(sessions, 's-2', path.join(binding.root, 'chapters'));
    await until(() => binder.referenceCount(binding.root) === 2);
    expect(events).toHaveLength(1);
    first.detach();
    await until(() => binder.referenceCount(binding.root) === 1);
    expect(events).toEqual([`on:${binding.root}`]);
    second.detach();
    await until(() => binder.referenceCount(binding.root) === 0 && events.length === 2);
    expect(events).toEqual([`on:${binding.root}`, `off:${binding.root}`]);
    await h.dispose();
  });

  it('Node runtime 只由服务端 session 引用驱动 scheduler activate/deactivate', async () => {
    const h = await makeContext();
    const sessions = new SessionStore(h.ctx);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-node-runtime-'));
    cleanup.push(dir);
    const binder = new SessionVaultBinder(config(dir));
    const binding = binder.ensureVault('书');
    const events: string[] = [];
    const runtime = new NovelcraftNodeRuntime(h.ctx, binder, {
      activate: (vault) => { events.push(`on:${vault.root}`); },
      deactivate: (root) => { events.push(`off:${root}`); },
    });
    runtime.start();
    const session = publish(sessions, 'node-1', binding.root);
    await until(() => events.length === 1);
    session.detach();
    await until(() => events.length === 2);
    expect(events).toEqual([`on:${binding.root}`, `off:${binding.root}`]);
    await h.dispose();
  });

  it('HMR stop 在 created/cache await 中发生时，迟到任务不会复活 watcher', async () => {
    const h = await makeContext();
    const sessions = new SessionStore(h.ctx);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-session-stop-race-'));
    cleanup.push(dir);
    const binder = new SessionVaultBinder(config(dir));
    const binding = binder.ensureVault('书');
    const originalBind = binder.bindByCwd.bind(binder);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(binder, 'bindByCwd').mockImplementation(async (...args) => {
      const result = await originalBind(...args);
      await gate; // model the production NovelcraftCache await after reference insertion
      return result;
    });
    const events: string[] = [];
    const stopAll = vi.fn();
    const runtime = new NovelcraftNodeRuntime(h.ctx, binder, {
      activate: (vault) => { events.push(`on:${vault.root}`); },
      deactivate: (root) => { events.push(`off:${root}`); },
      stopAll,
    });
    runtime.start();
    const created = publish(sessions, 'race-1', binding.root);
    await until(() => binder.referenceCount(binding.root) === 1);
    const stopped = runtime.stop();
    release();
    await stopped;
    await until(() => binder.referenceCount(binding.root) === 0);
    expect(events).toEqual([]);
    expect(stopAll).toHaveBeenCalledOnce();
    created.detach();
    await h.dispose();
  });

  it('session/created 对不存在 cwd fail-closed 且不自动建书', async () => {
    const h = await makeContext();
    const sessions = new SessionStore(h.ctx);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-session-life-'));
    cleanup.push(dir);
    const binder = new SessionVaultBinder(config(dir));
    const missing = path.join(dir, '绝不创建');
    const reasons: string[] = [];
    const lifecycle = new NovelcraftSessionLifecycle(h.ctx, binder, {
      onUnboundSession: (_id, reason) => reasons.push(reason),
    });
    lifecycle.start();
    const created = publish(sessions, 's-missing', missing);
    await until(() => reasons.length === 1);
    expect(existsSync(missing)).toBe(false);
    expect(binder.listBound()).toEqual([]);
    created.detach();
    await h.dispose();
  });
});
