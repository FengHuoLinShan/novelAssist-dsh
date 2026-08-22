// Track 4b 契约: 内容手预设卡注册表 + 注入链(N20, D13)。
// 断言引: N20(预设层归属)/N5(llm.yml 只存预设名与参数)/E8 修复(llm.yml 进执行路径)/
//         D13(多模型预设)/铁律 6(Key 不进任何文件——本测试全链无 Key 字段)。
// withAbortSignal 套件: 工具取消信号与 llm-step timeout 的合并/清理(工具取消贯通)。
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectPresetInLlmYml } from '@novelcraft/llm-step';
import type { Provider, ProviderRequest, ProviderResponse } from '@novelcraft/llm-step';
import { NovelCraftService, withAbortSignal, withResolvedDefaults } from '../src/index.js';
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
    expect(await env.service.presets.upsert({ name: 'my-card', provider: 'fake', model: 'fake-x', temperature: 0.33, workflow_budget: 12_345 })).toEqual([]);
    const persisted = (await env.service.presets.list()).find((p) => p.name === 'my-card');
    expect(persisted?.workflow_budget).toBe(12_345);
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

// ---------------------------------------------------------------------------
// withAbortSignal(工具取消贯通): 合并 outer + req.signal, 任一 abort 即中止,
// 调用前已 abort 立即生效, complete 结束时 finally 移除 listener。
// ---------------------------------------------------------------------------
/** 内层假 provider: 接收即挂起; req.signal abort → 拒绝(观察合并后的信号)。 */
function awaitingInner(): { inner: Provider; seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  const inner: Provider = {
    complete(req: ProviderRequest): Promise<ProviderResponse> {
      seen.push(req);
      return new Promise((_resolve, reject) => {
        const signal = req.signal;
        if (signal?.aborted) {
          reject(new Error('ABORTED')); // 调用前已 aborted → 同步立即生效。
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
      });
    },
  };
  return { inner, seen };
}

describe('withAbortSignal(outer 与 req.signal 合并)', () => {
  it('组合: 调用中 outer abort → 合并 controller abort → 内层立即收到 aborted signal 并拒绝', async () => {
    const outer = new AbortController();
    const { inner, seen } = awaitingInner();
    const wrapped = withAbortSignal(inner, outer.signal);
    const p = wrapped.complete({ messages: [] });
    outer.abort(); // 工具取消: 调用中途 abort。
    await expect(p).rejects.toThrow('ABORTED');
    expect(seen[0].signal?.aborted).toBe(true);
  });

  it('组合: req.signal(llm-step timeout 侧)abort → 同样贯通到内层', async () => {
    const stepTimeout = new AbortController();
    const { inner, seen } = awaitingInner();
    const wrapped = withAbortSignal(inner); // 无 outer, 只跟 req.signal。
    const p = wrapped.complete({ messages: [], signal: stepTimeout.signal });
    stepTimeout.abort(); // 模拟 llm-step 每步 timeout controller.abort()。
    await expect(p).rejects.toThrow('ABORTED');
    expect(seen[0].signal?.aborted).toBe(true);
  });

  it('调用前已 abort 立即生效: 内层在现场同步拿到 aborted signal(不等任何 tick)', async () => {
    const outer = new AbortController();
    outer.abort();
    const { inner, seen } = awaitingInner();
    const wrapped = withAbortSignal(inner, outer.signal);
    const p = wrapped.complete({ messages: [] });
    expect(seen[0].signal?.aborted).toBe(true); // complete 尚未 await 即已生效。
    await expect(p).rejects.toThrow('ABORTED');
  });

  it('cleanup: 正常完成后两个源 signal 的 listener 均移除(不再泄漏)', async () => {
    const outer = new AbortController();
    const reqCtl = new AbortController();
    const inner: Provider = { complete: async () => ({ text: 'ok' }) };
    const wrapped = withAbortSignal(inner, outer.signal);
    const resp = await wrapped.complete({ messages: [], signal: reqCtl.signal });
    expect(resp.text).toBe('ok');
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(reqCtl.signal, 'abort')).toHaveLength(0);
    outer.abort(); // 事后 abort 不影响下次调用(无残留 listener 复查)。
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
  });

  it('cleanup: abort 拒绝路径同样移除 listener', async () => {
    const outer = new AbortController();
    const { inner } = awaitingInner();
    const wrapped = withAbortSignal(inner, outer.signal);
    const p = wrapped.complete({ messages: [] });
    outer.abort();
    await expect(p).rejects.toThrow('ABORTED');
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
  });

  it('两源皆缺省 → 原样透传(同对象, 零开销不新建 controller)', async () => {
    const seen: ProviderRequest[] = [];
    const inner: Provider = {
      complete: async (req) => {
        seen.push(req);
        return { text: 'ok' };
      },
    };
    const req: ProviderRequest = { messages: [{ role: 'user', content: 'hi' }] };
    const wrapped = withAbortSignal(inner);
    await wrapped.complete(req);
    expect(seen[0]).toBe(req); // 无 signal 时原对象直传。
    expect(seen[0].signal).toBeUndefined();
  });
});

describe('service 取消贯通(加法 API: signal 传到 provider 层)', () => {
  it('contentProviderFor(root, signal): provider 开始前 abort → AbortError 且请求携带 aborted signal', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: ['x'] });
    const outer = new AbortController();
    const provider = await env.service.contentProviderFor(env.root, outer.signal);
    const p = provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    outer.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError', retryable: false });
    expect(env.h.adapter.requests).toHaveLength(1);
    expect(env.h.adapter.requests[0]?.signal?.aborted).toBe(true);
    env.cleanup();
  });

  it('runStep(req, root, signal): 调用前已 abort → fail-closed 且请求携带 aborted signal', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: ['{"findings":[]}'] });
    const outer = new AbortController();
    outer.abort();
    const r = await env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root, outer.signal);
    expect(r.ok).toBe(false);
    expect(env.h.adapter.requests).toHaveLength(1);
    expect(env.h.adapter.requests[0]?.signal?.aborted).toBe(true);
    env.cleanup();
  });
});
