// Track 4b 契约: 内容手预设卡注册表 + 注入链(N20, D13)。
// 断言引: N20(预设层归属)/N5(llm.yml 只存预设名与参数)/E8 修复(llm.yml 进执行路径)/
//         D13(多模型预设)/铁律 6(Key 不进任何文件——本测试全链无 Key 字段)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectPresetInLlmYml } from '@novelcraft/llm-step';
import type { ProviderRequest, ProviderResponse } from '@novelcraft/llm-step';
import { NovelCraftService, withResolvedDefaults } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  cleanup: () => void;
}

async function setup(): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-preset-'));
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-default' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const binding = service.vaults.ensureVault('预设书');
  await service.vaults.bindSession('s1', binding);
  return {
    h,
    service,
    vaultsDir,
    root: binding.root,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

describe('ContentPresetRegistry(N20 插件自建预设层)', () => {
  it('种子四张兜底 + upsert/list/remove + 同名存储覆盖种子', async () => {
    const env = await setup();
    const names = (await env.service.presets.list()).map((p) => p.name);
    expect(names).toContain('default');
    expect(names).toContain('writing-day');
    // upsert 合法卡
    expect(await env.service.presets.upsert({ name: 'my-card', provider: 'fake', model: 'fake-x', temperature: 0.33 })).toEqual([]);
    expect((await env.service.presets.list()).some((p) => p.name === 'my-card')).toBe(true);
    // 非法卡被拒绝(校验问题非空)
    expect((await env.service.presets.upsert({ name: '坏 名字' })).length).toBeGreaterThan(0);
    // 同名覆盖种子
    await env.service.presets.upsert({ name: 'import-day', provider: 'fake', model: 'fake-import' });
    const found = (await env.service.presets.list()).find((p) => p.name === 'import-day');
    expect(found?.model).toBe('fake-import');
    // remove 存储层卡
    expect(await env.service.presets.remove('my-card')).toBe(true);
    expect((await env.service.presets.list()).some((p) => p.name === 'my-card')).toBe(false);
    env.cleanup();
  });

  it('resolveDefaults: llm.yml preset 名 → 预设参数; llm.yml 直键覆盖预设; 未知名 fail-soft 空', async () => {
    const env = await setup();
    await env.service.presets.upsert({ name: 'my-card', provider: 'fake', model: 'fake-x', temperature: 0.33, max_tokens: 1234 });
    selectPresetInLlmYml(env.root, 'my-card');
    const d1 = await env.service.presets.resolveDefaults(env.root);
    expect(d1.provider).toBe('fake');
    expect(d1.model).toBe('fake-x');
    expect(d1.temperature).toBe(0.33);
    expect(d1.maxTokens).toBe(1234);
    // 未知预设名 → 空默认(fail-soft, 不炸)
    selectPresetInLlmYml(env.root, 'ghost');
    expect(await env.service.presets.resolveDefaults(env.root)).toEqual({});
    // 无 root → 空默认
    expect(await env.service.presets.resolveDefaults(undefined)).toEqual({});
    env.cleanup();
  });
});

describe('withResolvedDefaults(请求级优先)', () => {
  it('请求带 model/provider 时不被默认覆盖; 缺省才注入', async () => {
    const seen: ProviderRequest[] = [];
    const inner = {
      complete: async (req: ProviderRequest): Promise<ProviderResponse> => {
        seen.push(req);
        return { text: '{}' };
      },
    };
    const wrapped = withResolvedDefaults(inner, { provider: 'fake', model: 'fake-x', temperature: 0.2, maxTokens: 999 });
    await wrapped.complete({ messages: [] });
    expect(seen[0].provider).toBe('fake');
    expect(seen[0].model).toBe('fake-x');
    expect(seen[0].maxTokens).toBe(999);
    await wrapped.complete({ messages: [], model: 'req-model', provider: 'req-provider' });
    expect(seen[1].model).toBe('req-model');
    expect(seen[1].provider).toBe('req-provider');
  });
});

describe('执行链注入(E8 修复: llm.yml 进 runStep 路径)', () => {
  it('service.runStep(root) 经预设路由到 fake provider 的 fake-x 模型(DshProvider req.provider 直通)', async () => {
    const env = await setup();
    await env.service.presets.upsert({ name: 'my-card', provider: 'fake', model: 'fake-x', temperature: 0.33 });
    selectPresetInLlmYml(env.root, 'my-card');
    env.h.adapter.enqueue({ deltas: ['{"findings":[]}'] });
    const r = await env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root);
    expect(r.ok).toBe(true);
    const req = env.h.adapter.requests[0];
    expect(req.provider).toBe('fake');
    expect(req.model).toBe('fake-x');
    expect(req.temperature).toBe(0.33);
    env.cleanup();
  });

  it('无预设时维持 Config.llm 默认(fake/fake-default), 回归不破', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: ['{"findings":[]}'] });
    const r = await env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root);
    expect(r.ok).toBe(true);
    expect(env.h.adapter.requests[0].provider).toBe('fake');
    expect(env.h.adapter.requests[0].model).toBe('fake-default');
    env.cleanup();
  });
});
