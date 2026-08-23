// NovelCraftService + 工具注册端到端(全部 seam 组合)。
// 断言引 seam 契约 + ADR-0017 §4 验证方式 2: vault 初始化 → 索引(domain 缓存)
// → llm_step(DshProvider → ctx.llm 假适配器)→ 收件箱四动词 → 审批门控采用。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { pushSignal } from '@novelcraft/assistant';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { NovelCraftService } from '../src/index.js';
import { registerNovelcraftTools } from '../src/tools.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

function writePendingObject(env: { root: string }): void {
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
  it('真实 rc.8 ToolRuntime: scope/provider/approval 失败均 isError=true 且带稳定 code', async () => {
    const h = await makeContext({ approval: { outcome: 'rejected' } });
    h.ctx.provide('systemPrompt', {
      tools: () => () => {},
      section: () => () => {},
    } as never);
    new ToolRuntime(h.ctx, { mode: 'native' });
    const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-real-tools-'));
    await h.ctx.plugin(NovelCraftService, {
      llm: { provider: 'fake', model: 'fake-model' },
      vaultsDir,
      watch: { enabled: false, intervalMinutes: 60 },
    });
    const binding = h.ctx.novelcraft.vaults.ensureVault('真实运行时');

    const isolated = await h.ctx.tools.execute({
      callId: 'scope-1' as never,
      name: 'novelcraft_store_index',
      arguments: { root: binding.root },
      signal: new AbortController().signal,
    });
    expect(isolated).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'WORKSPACE_ISOLATION' } },
    });

    await h.ctx.novelcraft.vaults.bindSession('s1', binding);
    h.adapter.enqueue({ finishKind: 'error', failure: { code: 'RATE_LIMIT', message: '稍后重试' } });
    const provider = await h.ctx.tools.execute({
      callId: 'provider-1' as never,
      name: 'novelcraft_llm_step',
      arguments: { spec: 'semantic_review', input: '正文' },
      agent: fakeAgent,
      signal: new AbortController().signal,
    });
    expect(provider).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: expect.stringMatching(/^LLM_/) } },
    });

    writePendingObject({ root: binding.root });
    const approval = await h.ctx.tools.execute({
      callId: 'approval-1' as never,
      name: 'novelcraft_store_adopt',
      arguments: { root: binding.root, kind: 'object', ref: 'pend_red' },
      agent: fakeAgent,
      signal: new AbortController().signal,
    });
    expect(approval).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'APPROVAL_REJECTED' } },
    });
    expect(existsSync(path.join(binding.root, 'world', 'objects', 'pend_red.md'))).toBe(false);
    rmSync(vaultsDir, { recursive: true, force: true });
  });

  it('服务装配: 全部适配器暴露在 ctx.novelcraft', async () => {
    const env = await setup();
    expect(env.service.config.llm).toEqual({ provider: 'fake', model: 'fake-model' });
    expect(Object.keys(env.service.capabilities).sort()).toEqual(['adoptGuarded', 'propose', 'read']);
    expect('facades' in env.service).toBe(false);
    expect(env.tools.map((t) => t.name).sort()).toEqual([
      'novelcraft_deep_import',
      'novelcraft_generate_next_chapter',
      'novelcraft_health_scan',
      'novelcraft_inbox_act',
      'novelcraft_inbox_view',
      'novelcraft_ingest_file',
      'novelcraft_llm_step',
      'novelcraft_map_atlas_annotation',
      'novelcraft_map_atlas_plan',
      'novelcraft_map_atlas_review',
      'novelcraft_map_atlas_update_prompt',
      'novelcraft_map_atlas_upload',
      'novelcraft_map_atlas_view',
      'novelcraft_propose_next_chapter',
      'novelcraft_radar_sweep',
      'novelcraft_rag_embed',
      'novelcraft_rag_search',
      'novelcraft_store_adopt',
      'novelcraft_store_index',
    ]);
    for (const definition of env.tools) {
      const schema = definition.output.schema as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.additionalProperties, definition.name).toBe(false);
      expect([...schema.required ?? []].sort(), definition.name).toEqual(Object.keys(schema.properties ?? {}).sort());
    }
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

  it('工具 novelcraft_llm_step: exec.signal 捕获并贯通(已 abort → 宿主失败通道)', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const controller = new AbortController();
    controller.abort();
    const t = tool(env, 'novelcraft_llm_step');
    await expect(t.execute(
      { spec: 'semantic_review', input: '正文' },
      { ...env.exec, name: 'novelcraft_llm_step', signal: controller.signal },
    )).rejects.toMatchObject({ code: expect.stringMatching(/^LLM_/) });
    // exec.signal 已 abort → runStep 层 withAbortSignal 合并 controller 同步 abort
    // → DshProvider 请求(adapter.requests[0])携带的 signal 变 aborted(工具取消贯通)。
    expect(env.h.adapter.requests[0]?.signal?.aborted).toBe(true);
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
    const pushed = pushSignal(env.root, {
      radar: 'dedup',
      severity: 'risk',
      title: '「红衣女子」与「红衣女」疑似重复',
      evidence: ['第3章 与 第5章'],
      proposed_action: '合并并保留较早对象',
      reversibility: true,
    });

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

  it('审批拒绝 → 采用工具抛稳定 HarnessError(fail-closed 全链)', async () => {
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
    await service.vaults.bindSession('s1', binding);
    const pending = path.join(binding.root, 'world', 'pending', 'pend_red.md');
    writeFileSync(pending, serializeFrontmatter(
      { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' },
      '候选正文',
    ), 'utf8');
    gitAdd(binding.root, [pending]);
    gitCommit(binding.root, 'fixture: rejected adopt candidate');
    const t = tools.find((x) => x.name === 'novelcraft_store_adopt');
    if (!t) throw new Error('missing tool');
    await expect(t.execute(
      { root: binding.root, kind: 'object', ref: 'pend_red' },
      { callId: 'c1', name: 'novelcraft_store_adopt', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(existsSync(path.join(binding.root, 'world', 'pending', 'pend_red.md'))).toBe(true);
    expect(existsSync(path.join(binding.root, 'world', 'objects', 'pend_red.md'))).toBe(false);
    rmSync(vaultsDir, { recursive: true, force: true });
  });

  it('工具注册中途失败会回滚此前注册项，不遗留 HMR duplicate', async () => {
    const h = await makeContext();
    const disposed: string[] = [];
    let calls = 0;
    h.ctx.provide('tools', {
      register(def: ToolDefinition) {
        calls += 1;
        if (calls === 2) throw new Error('duplicate tool');
        return () => { disposed.push(def.name); };
      },
    });
    expect(() => registerNovelcraftTools(h.ctx, {} as NovelCraftService)).toThrow(/duplicate tool/);
    expect(disposed).toHaveLength(1);
    await h.dispose();
  });
});
