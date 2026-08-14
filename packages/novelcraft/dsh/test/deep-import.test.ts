// NovelCraftService.deepImport + novelcraft_deep_import 工具: runDeepImport 的 DSH 挂载。
// 断言: provider=DshProvider(经 ctx.llm 假适配器)、approve=ApprovalGate(fail-closed)、
// trace=ImportTraceSink(.assistant/import-trace.jsonl, 事件按序)。
// 依据: 设计文档 §15(trace contract)、§9(adopt 必过 approval)、seam 契约。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestChapter } from '@novelcraft/writing';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { NovelCraftService, importTraceFile } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}

/** 2 章(每章 1 Scene)全链 happy 响应(严格按调用顺序: slice2 enrich2 fuse1 entity2 alias2 structure1)。 */
function happyResponses(): object[] {
  return [
    { scenes: [sceneJson(1, 'S1', 'A1')] },
    { scenes: [sceneJson(2, 'S2', 'A2')] },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { boundaries: [{ left_candidate_id: 'ch1-s0', right_candidate_id: 'ch2-s0', relation: 'separate', confidence: 0.9 }] },
    { entities: [] },
    { entities: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { threads: [], arcs: [], foreshadowing: [], reveals: [] },
  ];
}

interface Env {
  h: HarnessServices;
  service: NovelCraftService;
  root: string;
  vaultsDir: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

async function setup(approvalOutcome: 'allowed-once' | 'rejected' = 'allowed-once'): Promise<Env> {
  const h = await makeContext({ approval: { outcome: approvalOutcome } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-deep-'));
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
  ingestChapter(root, { chapterIndex: 1, text: '第一章正文。', source: 'paste' });
  ingestChapter(root, { chapterIndex: 2, text: '第二章正文。', source: 'paste' });
  return {
    h,
    service,
    root,
    vaultsDir,
    tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

function readTraceEvents(root: string): Array<{ type: string; phase?: string; decision?: string }> {
  const file = importTraceFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('deepImport(DSH 挂载)', () => {
  it('全链: DshProvider + ApprovalGate + ImportTraceSink(adopt 过审批, trace 落盘)', async () => {
    const env = await setup('allowed-once');
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result.adopted).toBe(2);
    expect(result.committed).toHaveLength(2);
    expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(true);

    // 审批链收到请求(§9 adopt 必过 approval)
    expect(env.h.approval.requests.length).toBeGreaterThan(0);

    // trace 事件按序落盘(§15)
    const events = readTraceEvents(env.root);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('begin_import');
    expect(types).toContain('approval');
    expect(types).toContain('adopt');
    expect(types[types.length - 1]).toBe('complete_import');
    env.cleanup();
  });

  it('审批拒绝 → 无 adopt 无 commit(fail-closed)', async () => {
    const env = await setup('rejected');
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result.rejected).toBe(true);
    expect(result.committed).toHaveLength(0);
    expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(false);

    const events = readTraceEvents(env.root);
    expect(events.map((e) => e.type)).toContain('reject');
    expect(events.map((e) => e.type)).not.toContain('adopt');
    env.cleanup();
  });

  it('工具 novelcraft_deep_import: 同步执行并返回摘要', async () => {
    const env = await setup('allowed-once');
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const t = env.tools.find((x) => x.name === 'novelcraft_deep_import');
    expect(t).toBeDefined();

    const out = (await t!.execute(
      { root: env.root, start_chapter: 1, end_chapter: 2 },
      { callId: 'c1', name: 'novelcraft_deep_import', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    )) as { ok: boolean; adopted: number; committed: number; rejected: boolean; trace_file: string };
    expect(out.ok).toBe(true);
    expect(out.adopted).toBe(2);
    expect(out.committed).toBe(2);
    expect(out.rejected).toBe(false);
    expect(out.trace_file).toBe(importTraceFile(env.root));
    env.cleanup();
  });
});
