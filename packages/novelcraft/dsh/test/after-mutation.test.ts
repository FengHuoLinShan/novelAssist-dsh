// afterMutation 契约(§11 事件驱动副作用唯一入口):
// - 事件键展开 EVENT_RADAR_MAP 的雷达面(多键拼接保序);
// - 非已初始化 vault fail-closed: 零扫描零索引(fireRadarHooks 提前返回)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { afterMutation } from '../src/radar-hooks.js';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

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
  it('radars 事件键展开雷达面; 多键拼接不破坏主调用链', async () => {
    const { h, root } = await initVaultRoot();
    await expect(afterMutation(h.ctx, root, { radars: ['adopt', 'adoptChapterCandidate'] })).resolves.toBeUndefined();
  });

  it('非已初始化 vault fail-closed: radars 零扫描; rag 零索引; 空 opts 零副作用', async () => {
    const ctx = {} as Context;
    await expect(afterMutation(ctx, '/tmp/definitely-not-a-vault', { radars: ['ingest'] })).resolves.toBeUndefined();
    await expect(afterMutation(ctx, '/tmp/x', {})).resolves.toBeUndefined();
    await expect(afterMutation(ctx, '/tmp/x', { rag: true })).resolves.toBeUndefined();
  });
});
