// M6 Track A3 契约: novelcraft_rag_search 语义检索工具 + RAG 事件钩子 + service.ragSync。
// 断言引: 设计 §11(事件驱动索引维护)、N20(精排走该书预设面)、N21(rag_rerank spec)、
//   rag 包(R5 片段资产 / R12 派生索引可重建)、M6 Track A1(vault .gitignore 补写)。
// harness 行为说明: FakeAdapter 按队列回放(llm 请求逐条 shift):
//   - 队列注入合法 JSON → runStep 校验通过 → 精排成功(ranking=llm_rerank);
//   - 队列空 → finish error(NO_FAKE_RESPONSE) → DshProvider 抛 provider_fatal →
//     rerankWithProvider throw → searchRag 降级(ranking=bm25 + degraded=rerank_failed)。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { stageTextIntake } from '@novelcraft/writing';
import { NovelCraftService } from '../src/index.js';
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
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-rag-'));
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
  const binding = service.vaults.ensureVault('RAG测试书');
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
const stage = (env: TestEnv) => stageTextIntake(env.root, 's1', '手稿.txt', Buffer.from(SAMPLE)).receiptId;

/** 两章共享「雨」: 保证 BM25 召回 >1 条, 触发内容手精排分支。 */
const SAMPLE = [
  '第一章 雨夜',
  '雨下了一夜。林晚推开窗。',
  '',
  '第二章 对峙',
  '雨停了。苏婉站在桥上。',
].join('\n');

describe('novelcraft_rag_search(M6 Track A3 语义检索)', () => {
  it('注册: novelcraft_rag_search 使用 closed success schema', async () => {
    const env = await setup();
    const t = tool(env, 'novelcraft_rag_search');
    expect(t.name).toBe('novelcraft_rag_search');
    const schema = t.output?.schema as { type: string; additionalProperties?: boolean };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    // dsh-tools 把参数根的 required:true 注解编译为顶层 required 数组(JSON Schema 投影)
    expect(t.parameters).toMatchObject({ type: 'object', required: ['root', 'query'] });
  });

  it('全链: 文本入库 → 事件钩子自动建索引 → 检索命中正文片段(精排 llm_rerank)', async () => {
    const env = await setup();
    const ingest = await call(env, 'novelcraft_ingest_file', { root: env.root, receipt_id: stage(env) });
    expect(ingest.ok).toBe(true);
    // 事件钩子(§11): ingest 后 RAG 索引已自动增量同步落盘
    expect(existsSync(path.join(env.root, '.assistant', 'rag-index.json'))).toBe(true);
    // harness 的 fake llm 按队列回放: 注入合法 JSON 精排结果 → ranking=llm_rerank(不走降级)
    env.h.adapter.enqueue({ deltas: ['{"ranked_ids":["ch2-0","ch1-0"]}'] });
    const r = await call(env, 'novelcraft_rag_search', { root: env.root, query: '雨' });
    expect(r.ok).toBe(true);
    const hits = r.hits as Array<{
      chunk_id: string;
      source_type: string;
      chapter_index?: number;
      char_count: number;
      text: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.includes('雨'))).toBe(true); // 命中 chunk 正文含查询词
    expect(r.ranking).toBe('llm_rerank');
    expect(hits[0].chunk_id).toBe('ch2-0'); // ranked_ids 首位 = 精排第一
    expect(hits.some((h) => h.chapter_index === 1)).toBe(true);
    expect(String(r.message)).toContain('命中');
  });

  it('精排失败自动降级: fake 队列空 → provider_fatal → bm25 + degraded=rerank_failed', async () => {
    const env = await setup();
    // 直接写章文件 + service.ragSync 建索引(不经 ingest, 聚焦检索降级路径)
    writeFileSync(
      path.join(env.root, 'chapters', '001.md'),
      serializeFrontmatter({ chapter_index: 1, status: 'draft', content_hash: 'h1' }, '雨下了一夜。林晚推开窗。'),
      'utf8',
    );
    writeFileSync(
      path.join(env.root, 'chapters', '002.md'),
      serializeFrontmatter({ chapter_index: 2, status: 'draft', content_hash: 'h2' }, '雨停了。苏婉站在桥上。'),
      'utf8',
    );
    const stats = env.service.ragSync(env.root);
    expect(stats.added).toBe(2);
    // 不 enqueue → FakeAdapter finish error(NO_FAKE_RESPONSE) → rerank 抛 provider_fatal → 降级
    const r = await call(env, 'novelcraft_rag_search', { root: env.root, query: '雨' });
    expect(r.ok).toBe(true);
    expect(r.ranking).toBe('bm25');
    expect(r.degraded).toBe('rerank_failed');
    expect((r.hits as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.message)).toContain('精排失败已降级');
  });

  it('rerank=false: 纯 L0 检索, 不触发任何 LLM 调用(adapter.requests 不变)', async () => {
    const env = await setup();
    await call(env, 'novelcraft_ingest_file', { root: env.root, receipt_id: stage(env) });
    const before = env.h.adapter.requests.length;
    const r = await call(env, 'novelcraft_rag_search', { root: env.root, query: '雨', rerank: false });
    expect(r.ok).toBe(true);
    expect(env.h.adapter.requests.length).toBe(before); // N20: rerank=false 不注入 provider
    expect(r.ranking).toBe('bm25');
    expect((r.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it('空 vault(无索引): ok=true, hits=[], message 含提示', async () => {
    const env = await setup();
    const r = await call(env, 'novelcraft_rag_search', { root: env.root, query: '林晚' });
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
    expect(String(r.message)).toContain('无命中');
  });

  it('adopt 事件钩子: 采用 pending 资产后 RAG 索引自动落盘(世界对象入索引)', async () => {
    const env = await setup();
    writeFileSync(
      path.join(env.root, 'world', 'pending', 'pend_sword.md'),
      serializeFrontmatter({ id: 'pend_sword', kind: 'item', name: '青锋剑', status: 'candidate' }, '青锋剑正文'),
      'utf8',
    );
    // adopt 的 CAS 前提: 工作区须干净(store-rules: 脏时拒绝), fixture 落盘后提交。
    gitAdd(env.root);
    gitCommit(env.root, 'fixture');
    expect(existsSync(path.join(env.root, '.assistant', 'rag-index.json'))).toBe(false);
    const r = await call(env, 'novelcraft_store_adopt', { root: env.root, kind: 'object', ref: 'pend_sword' });
    expect(r.ok).toBe(true);
    // 事件钩子(§11): adopt 后索引已增量同步(与雷达钩子同款尽力而为纪律)
    expect(existsSync(path.join(env.root, '.assistant', 'rag-index.json'))).toBe(true);
    const index = JSON.parse(readFileSync(path.join(env.root, '.assistant', 'rag-index.json'), 'utf8')) as {
      chunks: Array<{ source_type: string; text: string }>;
    };
    expect(index.chunks.some((c) => c.source_type === 'world_entity' && c.text.includes('青锋剑'))).toBe(true);
  });

  it('ragSync 兼容旧 vault: .gitignore 删除后重建且含 rag-index.json 行', async () => {
    const env = await setup();
    writeFileSync(
      path.join(env.root, 'chapters', '001.md'),
      serializeFrontmatter({ chapter_index: 1, status: 'draft', content_hash: 'h1' }, '雨下了一夜。林晚推开窗。'),
      'utf8',
    );
    rmSync(path.join(env.root, '.gitignore'), { force: true }); // 模拟旧 vault(无派生索引忽略行)
    expect(existsSync(path.join(env.root, '.gitignore'))).toBe(false);
    const stats = env.service.ragSync(env.root);
    expect(stats.added).toBe(1);
    const gi = readFileSync(path.join(env.root, '.gitignore'), 'utf8');
    expect(gi).toContain('.assistant/rag-index.json');
  });
});
