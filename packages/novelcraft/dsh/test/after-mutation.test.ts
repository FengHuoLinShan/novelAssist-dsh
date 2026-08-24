// afterMutation 契约(§11 事件驱动副作用唯一入口):
// - 事件键展开 EVENT_RADAR_MAP 的雷达面(多键拼接保序);
// - push: true 无雷达纯推送(通道异常吞掉);
// - 非已初始化 vault fail-closed: 零扫描零推送零索引(fireRadarHooks 提前返回)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { afterMutation } from '../src/radar-hooks.js';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

function fakeCtx(onEmit?: (channel: string, payload: unknown) => void): Context {
  return { emit: onEmit ?? vi.fn() } as unknown as Context;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initVaultRoot(): Promise<{ h: HarnessServices; root: string }> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-aftermut-'));
  dirs.push(vaultsDir);
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const binding = service.vaults.ensureVault('副作用测试书');
  await service.vaults.bindSession('s1', binding);
  return { h, root: binding.root };
}

describe('afterMutation(§11 副作用唯一入口)', () => {
  it('radars 事件键展开雷达面并推送信号变化; 多键拼接(章候选采用 = dedup+risk+writing)', async () => {
    const { h, root } = await initVaultRoot();
    const pushEvents: Array<{ channel: string; payload: unknown }> = [];
    const emitSpy = vi.spyOn(h.ctx, 'emit').mockImplementation(((_event: string, channel: string, ...rest: unknown[]) => {
      pushEvents.push({ channel, payload: rest[0] });
    }) as never);
    try {
      await afterMutation(h.ctx, root, { radars: ['adopt', 'adoptChapterCandidate'] });
    } finally {
      emitSpy.mockRestore();
    }
    const signalsPush = pushEvents.find((e) => e.channel === 'novelcraft/signals-changed');
    expect(signalsPush).toBeDefined();
    const payload = signalsPush!.payload as { root: string; radars: string[] };
    expect(payload.root).toBe(root);
    // adopt + adoptChapterCandidate = ['dedup','risk'] + ['writing'], 顺序保持。
    expect(payload.radars).toEqual(['dedup', 'risk', 'writing']);
  });

  it('push: true 无雷达时纯推送; 推送异常吞掉不外抛', async () => {
    const emit = vi.fn(() => { throw new Error('channel down'); });
    const ctx = { emit } as unknown as Context;
    await expect(afterMutation(ctx, '/tmp/x', { push: true })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('非已初始化 vault fail-closed: radars 零扫描零推送; rag 零索引; 空 opts 零副作用', async () => {
    const emit = vi.fn();
    const ctx = fakeCtx(emit);
    await expect(afterMutation(ctx, '/tmp/definitely-not-a-vault', { radars: ['ingest'] })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    await expect(afterMutation(ctx, '/tmp/x', {})).resolves.toBeUndefined();
    await expect(afterMutation(ctx, '/tmp/x', { rag: true })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});
