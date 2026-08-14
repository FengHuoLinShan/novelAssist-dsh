// NovelCraftService + 工具注册端到端(全部 seam 组合)。
// 断言引 seam 契约 + ADR-0017 §4 验证方式 2: vault 初始化 → 索引(domain 缓存)
// → llm_step(DshProvider → ctx.llm 假适配器)→ 收件箱四动词 → 审批门控采用。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

function writePendingObject(env: TestEnv): void {
  const abs = path.join(env.root, 'world', 'pending', 'pend_red.md');
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, serializeFrontmatter(
    { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' },
    '红衣女子正文',
  ), 'utf8');
  gitAdd(env.root);
  gitCommit(env.root, 'fixture');
}

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
  cleanup: () => void;
}

async function setup(): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-service-'));
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
  const binding = service.vaults.ensureVault('测试书');
  await service.vaults.bindSession('s1', binding);
  const root = binding.root;
  const exec = {
    callId: 'c1',
    name: '',
    arguments: {},
    agent: fakeAgent,
    signal: new AbortController().signal,
  };
  return {
    h,
    service,
    vaultsDir,
    root,
    tools,
    exec,
    cleanup: () => {
      rmSync(vaultsDir, { recursive: true, force: true });
    },
  };
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

describe('NovelCraftService 端到端', () => {
  it('服务装配: 全部适配器暴露在 ctx.novelcraft', async () => {
    const env = await setup();
    expect(env.service.config.llm).toEqual({ provider: 'fake', model: 'fake-model' });
    expect(env.service.facades.store).toBeDefined();
    expect(env.service.facades.assistant).toBeDefined();
    expect(env.tools.map((t) => t.name).sort()).toEqual([
      'novelcraft_deep_import',
      'novelcraft_generate_next_chapter',
      'novelcraft_health_scan',
      'novelcraft_inbox_act',
      'novelcraft_inbox_view',
      'novelcraft_ingest_file',
      'novelcraft_llm_step',
      'novelcraft_propose_next_chapter',
      'novelcraft_radar_sweep',
      'novelcraft_signal_push',
      'novelcraft_store_adopt',
      'novelcraft_store_index',
    ]);
    env.cleanup();
  });

  it('runStep 经 DshProvider → ctx.llm: 内容手一步(semantic_review)', async () => {
    const env = await setup();
    env.h.adapter.enqueue({
      deltas: ['{"findings":[{"category":"设定","severity":"high","quote":"原句","suggestion":"改法"}],"verdict":"需修订"}'],
      usage: { inputTokens: 20, outputTokens: 30 },
    });
    const result = await env.service.runStep({
      specRef: 'semantic_review',
      input: '第一章正文(冻结)',
    });
    expect(result.ok).toBe(true);
    expect(result.specRef).toBe('semantic_review');
    const findings = (result.result as { findings: unknown[] }).findings;
    expect(findings).toHaveLength(1);
    expect(result.usage.outputTokens).toBe(30);
    env.cleanup();
  });

  it('工具 novelcraft_llm_step: schema 校验通过返回结构化结果', async () => {
    const env = await setup();
    env.h.adapter.enqueue({
      deltas: ['{"findings":[],"verdict":"通过"}'],
    });
    const t = tool(env, 'novelcraft_llm_step');
    const out = await t.execute(
      { spec: 'semantic_review', input: '正文' },
      { ...env.exec, name: 'novelcraft_llm_step' },
    );
    expect(out).toMatchObject({ ok: true, input_tokens: 2, error: '' });
    expect((out as { text: string }).text).toContain('"findings":[]');
    env.cleanup();
  });

  it('索引: 文件 → rebuildIndex → domain 缓存(文件唯一真相)', async () => {
    const env = await setup();
    writePendingObject(env);
    const t = tool(env, 'novelcraft_store_index');
    const out = await t.execute({ root: env.root }, { ...env.exec, name: 'novelcraft_store_index' });
    expect(out).toMatchObject({ objects: 1, aliases: 0, chapters: 0 });
    expect(env.service.cache.getIndex(env.root)).toMatchObject({ indexVersion: 1 });
    env.cleanup();
  });

  it('收件箱: push → view → act(accept → adopt 指引)', async () => {
    const env = await setup();
    const push = tool(env, 'novelcraft_signal_push');
    const pushed = (await push.execute(
      {
        root: env.root,
        radar: 'dedup',
        severity: 'risk',
        title: '「红衣女子」与「红衣女」疑似重复',
        evidence: ['第3章 与 第5章'],
        proposed_action: '合并并保留较早对象',
        reversibility: true,
      },
      { ...env.exec, name: 'novelcraft_signal_push' },
    )) as { id: string };

    const view = tool(env, 'novelcraft_inbox_view');
    const inbox = (await view.execute({ root: env.root }, { ...env.exec, name: 'novelcraft_inbox_view' })) as {
      signals: Array<{ id: string; radar: string }>;
    };
    expect(inbox.signals).toHaveLength(1);
    expect(inbox.signals[0]).toMatchObject({ id: pushed.id, radar: 'dedup' });

    const act = tool(env, 'novelcraft_inbox_act');
    const acted = (await act.execute(
      { root: env.root, signal_id: pushed.id, action: 'accept' },
      { ...env.exec, name: 'novelcraft_inbox_act' },
    )) as { ok: boolean; kind: string; message: string };
    expect(acted).toMatchObject({ ok: true, kind: 'adopt' });
    expect(acted.message).toContain('novelcraft_store_adopt');
    env.cleanup();
  });

  it('采用: 审批门控 + git commit(真实 vault 全链)', async () => {
    const env = await setup();
    writePendingObject(env);
    const t = tool(env, 'novelcraft_store_adopt');
    const out = (await t.execute(
      { root: env.root, kind: 'object', ref: 'pend_red', note: '测试采用' },
      { ...env.exec, name: 'novelcraft_store_adopt' },
    )) as { ok: boolean; commit: string; target_rel_path: string };
    expect(out.ok).toBe(true);
    expect(out.target_rel_path).toBe('world/objects/pend_red.md');
    expect(existsSync(path.join(env.root, 'world', 'objects', 'pend_red.md'))).toBe(true);
    // 审批链收到请求(审计)
    expect(env.h.approval.requests.length).toBeGreaterThan(0);
    env.cleanup();
  });

  it('审批拒绝 → 采用工具返回 ok:false(fail-closed 全链)', async () => {
    const h = await makeContext({ approval: { outcome: 'rejected' } });
    const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-service-'));
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
    const binding = service.vaults.ensureVault('测试书');
    const t = tools.find((x) => x.name === 'novelcraft_store_adopt');
    if (!t) throw new Error('missing tool');
    const out = (await t.execute(
      { root: binding.root, kind: 'object', ref: '不存在' },
      { callId: 'c1', name: 'novelcraft_store_adopt', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    )) as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain('未获批准');
    rmSync(vaultsDir, { recursive: true, force: true });
  });
});
