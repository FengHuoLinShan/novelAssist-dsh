// M6 Track B 契约: novelcraft_rag_embed 工具 + service.embeddingBackendFor / ragEmbed。
// 断言引: L2 嵌入后端可选(全链可降级)、@novelcraft/rag-bge 为 optionalDependencies(动态 import,
//   不进 dependencies 保持可选包语义)、N5(llm.yml 只存键名)。
// 零网络(AGENTS.md): 用例只断言「创建不触发 embed」, 绝不调 backend.embed;
//   带 bge-local-v1 配置时只测 embeddingBackendFor 创建, 不跑完整嵌入链。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NovelCraftService } from '../src/index.js';
import { optionalBgeLoader } from '../src/optional-bge.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
}

const envs: TestEnv[] = [];
async function setup(): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-ragembed-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', {
    register(def: ToolDefinition) {
      tools.push(def);
      return () => {};
    },
  });
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const binding = service.vaults.ensureVault('RAG嵌入测试书');
  await service.vaults.bindSession('s1', binding);
  const env: TestEnv = {
    h,
    service,
    vaultsDir,
    root: binding.root,
    tools,
    exec: { callId: 'c1', name: '', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
  };
  envs.push(env);
  return env;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const e of envs.splice(0)) {
    rmSync(e.vaultsDir, { recursive: true, force: true });
  }
});

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};
const call = async (env: TestEnv, name: string, args: Record<string, unknown>) =>
  (await tool(env, name).execute(args as never, env.exec as never)) as Record<string, unknown>;

describe('novelcraft_rag_embed(M6 Track B, L2 批量嵌入)', () => {
  it('注册: 共 20 个工具且 novelcraft_rag_embed 存在(输出 schema 开放)', async () => {
    const env = await setup();
    expect(env.tools.length).toBe(20); // 14 → 20: M7 map-atlas Phase 5 新增 6 工具
    const t = tool(env, 'novelcraft_rag_embed');
    const schema = t.output?.schema as { type: string; additionalProperties?: boolean };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(true);
    expect(t.parameters).toMatchObject({ type: 'object', required: ['root'] });
  });

  it('embedding 未配置 → rag_embed 返回提示且不嵌(ok:false + 全 0 + 作者语言提示)', async () => {
    const env = await setup(); // 全新 vault, 无 llm.yml → embedding 未启用
    const r = await call(env, 'novelcraft_rag_embed', { root: env.root });
    expect(r.ok).toBe(false);
    expect(r.embedded).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(String(r.message)).toContain('嵌入未启用或后端不可用');
    expect(String(r.message)).toContain('embedding: bge-local-v1');
  });

  it('llm.yml 写 embedding: bge-local-v1 → 通过可注入 optional loader 创建 backend(零真实安装依赖)', async () => {
    const env = await setup();
    expect(await env.service.embeddingBackendFor(undefined)).toBeUndefined(); // 无 root → undefined
    expect(await env.service.embeddingBackendFor(env.root)).toBeUndefined(); // 未配置 → undefined
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    vi.spyOn(optionalBgeLoader, 'load').mockResolvedValue({
      createBgeEmbeddingBackend: () => ({ name: 'fake-bge', embed }),
    });
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'embedding: bge-local-v1\n', 'utf8');
    const backend = await env.service.embeddingBackendFor(env.root);
    expect(backend?.name).toBe('fake-bge');
    expect(embed).not.toHaveBeenCalled();
    expect(env.h.adapter.requests.length).toBe(0);
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'embedding: off\n', 'utf8');
    expect(await env.service.embeddingBackendFor(env.root)).toBeUndefined();
  });

  it('默认 profile optional adapter 缺失 → embeddingBackendFor fail-soft undefined, ragEmbed 安全降级(N36)', async () => {
    const env = await setup();
    vi.spyOn(optionalBgeLoader, 'load').mockRejectedValue(Object.assign(new Error('missing optional adapter'), { code: 'ERR_MODULE_NOT_FOUND' }));
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'embedding: bge-local-v1\n', 'utf8');
    expect(await env.service.embeddingBackendFor(env.root)).toBeUndefined();
    await expect(env.service.ragEmbed(env.root)).resolves.toMatchObject({ embedded: 0, failed: 0, skipped: 0 });
  });

  it('rag_search 在 embedding 未配置时行为与之前一致(L0/L1)', async () => {
    const env = await setup();
    writeFileSync(
      path.join(env.root, 'chapters', '001.md'),
      '---\nchapter_index: 1\nstatus: draft\ncontent_hash: h1\n---\n雨下了一夜。林晚推开窗。',
      'utf8',
    );
    writeFileSync(
      path.join(env.root, 'chapters', '002.md'),
      '---\nchapter_index: 2\nstatus: draft\ncontent_hash: h2\n---\n雨停了。苏婉站在桥上。',
      'utf8',
    );
    env.service.ragSync(env.root);
    // L0: rerank=false → 纯 BM25, 不触发 LLM 调用。
    const before = env.h.adapter.requests.length;
    const l0 = await call(env, 'novelcraft_rag_search', { root: env.root, query: '雨', rerank: false });
    expect(l0.ok).toBe(true);
    expect(l0.ranking).toBe('bm25');
    expect((l0.hits as unknown[]).length).toBeGreaterThan(0);
    expect(env.h.adapter.requests.length).toBe(before); // 未配置 embedding 也不调 LLM
    // L1: rerank 默认开 + fake 队列 → llm_rerank(与 M6 Track A3 一致)。
    env.h.adapter.enqueue({ deltas: ['{"ranked_ids":["ch2-0","ch1-0"]}'] });
    const l1 = await call(env, 'novelcraft_rag_search', { root: env.root, query: '雨' });
    expect(l1.ok).toBe(true);
    expect(l1.ranking).toBe('llm_rerank');
    expect((l1.hits as Array<{ chunk_id: string }>)[0].chunk_id).toBe('ch2-0');
  });
});
