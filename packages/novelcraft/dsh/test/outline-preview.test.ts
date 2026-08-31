// M12-b/N44 行为契约: outline 生成 preview/apply 拆分 + world 生成中心只读模式。
// 断言依据: 后续开发计划.md M12-b + 台账 §6.18.2(preview 不写资产, apply 显式审批) +
// §6.17(页面建议只落工作稿) + 铁律 3(apply 必过 approval fail-closed) + N38(prompt 指纹可回放)。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { NovelCraftService } from '../src/index.js';
import { makeContext } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

async function setup(opts: { outcome: 'allowed-once' | 'rejected' } = { outcome: 'allowed-once' }) {
  const h = await makeContext({ approval: { outcome: { outcome: opts.outcome } as never } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-op-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', { register(def: ToolDefinition) { tools.push(def); return () => {}; } });
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' }, vaultsDir, watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const binding = service.vaults.ensureVault('测试书');
  await service.vaults.bindSession('s1', binding);
  const recorded = h.approval.requests;
  const outcome = opts.outcome;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.approval as any).request = async (req: unknown) => { recorded.push(req as never); return outcome; };
  return {
    h, service, root: binding.root, tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;
const tool = (env: Env, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};
const exec = (env: Env, name: string, args: Record<string, unknown>) =>
  (tool(env, name) as { execute: (a: unknown, e: unknown) => Promise<unknown> })
    .execute(args, { callId: 'c1', name, arguments: args, agent: fakeAgent, signal: new AbortController().signal });

const OUTLINE_RESULT = JSON.stringify({
  title: '诡秘新约', outline_markdown: '# 总纲\n三幕结构。',
  creative_core: { premise: '核心冲突' },
  major_storylines: [{ name: '主线A' }], macro_movements: [{ name: '第一幕' }], open_decisions: [{ question: '未定城市名' }],
});

describe('outline preview/apply(M12-b/N44)', () => {
  it('preview: 暂存 .assistant/proposals/ 且不写 structure 资产; 记录带 prompt 指纹', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const out = await exec(env, 'novelcraft_outline_preview', { root: env.root, input: '设定摘要' }) as { run_id: string };
    expect(out.run_id).toMatch(/^p[0-9a-z]+$/);
    // 暂存记录存在且含指纹
    const dir = path.join(env.root, '.assistant', 'proposals');
    const files = (await import('node:fs')).readdirSync(dir).filter((n) => n.startsWith('outline-'));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(record.kind).toBe('story_outline');
    expect(record.prompt_fingerprint?.system_prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    // structure/outline.md 不存在(preview 不写资产)
    expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false);
    env.cleanup();
  });

  it('apply: 审批拒绝零写; 放行写 canonical outline.md; 未知 run_id 拒绝', async () => {
    const rej = await setup({ outcome: 'rejected' });
    rej.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const prev = await exec(rej, 'novelcraft_outline_preview', { root: rej.root, input: '设定' }) as { run_id: string };
    await expect(exec(rej, 'novelcraft_outline_apply', { root: rej.root, run_id: prev.run_id }))
      .rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(existsSync(path.join(rej.root, 'structure', 'outline.md'))).toBe(false);
    rej.cleanup();

    const env = await setup();
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const p = await exec(env, 'novelcraft_outline_preview', { root: env.root, input: '设定' }) as { run_id: string };
    const applied = await exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: p.run_id }) as { file: string };
    expect(applied.file).toBe('structure/outline.md');
    const md = readFileSync(path.join(env.root, 'structure', 'outline.md'), 'utf8');
    expect(md).toContain('诡秘新约');
    expect(md).toContain('三幕结构');
    // 未知 run_id
    await expect(exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: 'p不存在' })).rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    env.cleanup();
  });

  it('item preview/apply: thread 资产经审批写入; item 记录复用 outlineItemFrontmatter 映射', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [JSON.stringify({
      target: 'plot_thread',
      content: { title: '暗线', name: '暗线', summary: '贯穿全篇', thread_type: 'mystery', relations: [] },
    })] });
    const p = await exec(env, 'novelcraft_outline_item_preview', { root: env.root, target: 'plot_thread', input: '上下文' }) as { run_id: string };
    const threadsDir = path.join(env.root, 'structure', 'threads');
    expect(existsSync(threadsDir) ? (await import('node:fs')).readdirSync(threadsDir).length : 0).toBe(0);
    const applied = await exec(env, 'novelcraft_outline_item_apply', { root: env.root, run_id: p.run_id }) as { slug: string };
    expect(applied.slug).toContain('thread-');
    const fm = readFileSync(path.join(env.root, 'structure', 'threads', `${applied.slug}.md`), 'utf8');
    expect(fm).toContain('暗线');
    env.cleanup();
  });

  it('world 生成中心只读四模式: 纯 LLM 调用零文件写(fake 往返)', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [JSON.stringify({ reply: '共创回答' })] });
    const chat = await exec(env, 'novelcraft_world_chat', { root: env.root, input: '魔法体系怎么设计' }) as { reply: string };
    expect(chat.reply).toBe('共创回答');
    // converge/explore/inspect 返回结构化结果
    for (const [name, payload] of [
      ['novelcraft_world_converge', { retained_source_keys: [] }],
      ['novelcraft_world_explore', { directions: [] }],
      ['novelcraft_world_inspect', { findings: [] }],
    ] as const) {
      env.h.adapter.enqueue({ deltas: [JSON.stringify(payload)] });
      const out = await exec(env, name, { root: env.root, input: '材料' }) as { result_json: string };
      expect(JSON.parse(out.result_json)).toMatchObject(payload as Record<string, unknown>);
    }
    env.cleanup();
  });
});
