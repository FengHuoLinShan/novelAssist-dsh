// M12-b/N44 行为契约: outline 生成 preview/apply 拆分 + world 生成中心只读模式。
// 断言依据: 后续开发计划.md M12-b + 台账 §6.18.2(preview 不写资产, apply 显式审批) +
// §6.17(页面建议只落工作稿) + 铁律 3(apply 必过 approval fail-closed) + N38(prompt 指纹可回放)。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { NovelCraftService } from '../src/index.js';
import { makeContext } from './helpers.js';
import { serializeFrontmatter } from '@novelcraft/store';

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

describe('world_bible_suggest(M12-b review E: 唯一无审批写文件工具的行为锁定)', () => {
  it('落 bible/ draft(status=draft)并精确 git 提交; 采用另走 store_adopt', async () => {
    const env = await setup();
    // world_bible_page spec 输出形态(看 specs-world.ts 4.7 的 schema —— 宽松 additionalProperties)
    env.h.adapter.enqueue({ deltas: [JSON.stringify({
      page_key: 'magic-system', title: '魔法体系', version_number: 1, page_type: 'setting',
      sections: [], summary: '体系摘要',
    })] });
    const out = await exec(env, 'novelcraft_world_bible_suggest', { root: env.root, input: '设计魔法体系' }) as { slug: string; context_hash: string };
    expect(out.slug).toBeTruthy();
    expect(out.context_hash).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(env.root, 'bible', `${out.slug}.md`);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('status: draft'); // 工作稿非 canonical(§6.17)
    expect(raw).toContain('provenance:');
    const { execFileSync } = await import('node:child_process');
    const log = execFileSync('git', ['-C', env.root, '-c', 'core.quotepath=false', 'log', '-1', '--name-only', '--pretty=%s'], { encoding: 'utf8' });
    expect(log).toContain(`bible/${out.slug}.md`); // 文件+git 提交(铁律 2)
    env.cleanup();
  });
});

describe('outline preview/apply(M12-b/N44)', () => {
  it('preview: 暂存 .assistant/proposals/ 且不写 structure 资产; 记录带 prompt 指纹', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const out = await exec(env, 'novelcraft_outline_preview', { root: env.root, input: '设定摘要' }) as { run_id: string; context_hash: string };
    expect(out.run_id).toMatch(/^p[0-9a-z]+$/);
    expect(out.context_hash).toMatch(/^[0-9a-f]{64}$/);
    // 暂存记录存在且含指纹
    const dir = path.join(env.root, '.assistant', 'proposals');
    const files = (await import('node:fs')).readdirSync(dir).filter((n) => n.startsWith('outline-'));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(record.kind).toBe('story_outline');
    expect(record.prompt_fingerprint?.system_prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.context_receipt?.source_manifest[0]?.source_id).toBe('author-instruction');
    // structure/outline.md 不存在(preview 不写资产)
    expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false);
    env.cleanup();
  });

  it('显式 canonical 来源进入模型与 receipt；来源漂移后 apply 零 canonical 写', async () => {
    const env = await setup();
    const sourceRel = 'world/objects/harbor.md';
    const sourceFile = path.join(env.root, sourceRel);
    const sourceRaw = serializeFrontmatter(
      { id: 'harbor', kind: 'location', name: '盐港', status: 'canonical' },
      '盐港只在冬季开放北闸。',
    );
    writeFileSync(sourceFile, sourceRaw, 'utf8');
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const out = await exec(env, 'novelcraft_outline_preview', {
      root: env.root,
      input: '围绕盐港生成总纲',
      source_refs: [sourceRel],
    }) as { run_id: string; source_manifest: Array<{ source_id: string }> };
    expect(out.source_manifest.map((source) => source.source_id)).toContain(`vault:${sourceRel}`);
    const sent = env.h.adapter.requests[0].messages[0].content[0];
    expect(sent).toMatchObject({ type: 'text', text: expect.stringContaining('冬季开放北闸') });
    writeFileSync(sourceFile, `${sourceRaw}\n外部变化`, 'utf8');
    await expect(exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: out.run_id }))
      .rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false);
    env.cleanup();
  });

  it('draft 来源默认拒绝且 provider=0；显式 include_working_drafts 才允许', async () => {
    const env = await setup();
    const sourceRel = 'world/objects/draft-city.md';
    writeFileSync(
      path.join(env.root, sourceRel),
      serializeFrontmatter({ id: 'draft-city', kind: 'location', name: '草稿城', status: 'draft' }, '待定设定'),
      'utf8',
    );
    const before = env.h.adapter.requests.length;
    await expect(exec(env, 'novelcraft_outline_preview', {
      root: env.root, input: '生成总纲', source_refs: [sourceRel],
    })).rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    expect(env.h.adapter.requests).toHaveLength(before);
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const allowed = await exec(env, 'novelcraft_outline_preview', {
      root: env.root,
      input: '生成总纲',
      source_refs: [sourceRel],
      include_working_drafts: true,
    }) as { source_manifest: Array<{ source_status: string }> };
    expect(allowed.source_manifest.some((source) => source.source_status === 'draft')).toBe(true);
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

  it('暂存被外部编辑破坏形态 → apply fail-closed(锁定 readPreview 三重校验)', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const p = await exec(env, 'novelcraft_outline_preview', { root: env.root, input: '设定' }) as { run_id: string };
    // 破坏暂存记录: run_id 改写 → 形态校验拒绝
    const dir = path.join(env.root, '.assistant', 'proposals');
    const { readdirSync, writeFileSync: wf } = await import('node:fs');
    const f = readdirSync(dir).find((n) => n.startsWith('outline-'))!;
    const rec = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    rec.run_id = 'p被篡改';
    wf(path.join(dir, f), JSON.stringify(rec), 'utf8');
    await expect(exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: p.run_id }))
      .rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false); // 零写
    env.cleanup();
  });

  it('proposal 文件 symlink 指向 Vault 外时，审批后仍零 canonical 写且不读取外部记录', async () => {
    const env = await setup();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-outline-outside-'));
    try {
      const external = path.join(outside, 'proposal.json');
      writeFileSync(external, JSON.stringify({
        kind: 'story_outline', run_id: 'pexternal', generated_at: '2026-09-01T00:00:00Z',
        input_hash: 'x', result: { title: 'EXTERNAL-OUTLINE-MARKER', outline_markdown: '不得采用' },
        context_receipt: {
          context_hash: '0'.repeat(64), budget_tokens: 1, total_tokens: 0,
          source_manifest: [], omitted_source_ids: [], warnings: [], source_snapshot: [],
        },
      }));
      const dir = path.join(env.root, '.assistant', 'proposals');
      mkdirSync(dir, { recursive: true });
      symlinkSync(external, path.join(dir, 'outline-pexternal.json'));
      const approvals = env.h.approval.requests.length;
      await expect(exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: 'pexternal' }))
        .rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
      expect(env.h.approval.requests).toHaveLength(approvals + 1);
      expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false);
      expect(readFileSync(external, 'utf8')).toContain('EXTERNAL-OUTLINE-MARKER');
    } finally {
      env.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('公开 apply 必须携带冻结 context receipt', async () => {
    const env = await setup();
    env.h.adapter.enqueue({ deltas: [OUTLINE_RESULT] });
    const p = await exec(env, 'novelcraft_outline_preview', { root: env.root, input: '设定' }) as { run_id: string };
    const dir = path.join(env.root, '.assistant', 'proposals');
    const file = (await import('node:fs')).readdirSync(dir).find((name) => name.startsWith('outline-'))!;
    const record = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    delete record.context_receipt;
    writeFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`, 'utf8');
    await expect(exec(env, 'novelcraft_outline_apply', { root: env.root, run_id: p.run_id }))
      .rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    expect(existsSync(path.join(env.root, 'structure', 'outline.md'))).toBe(false);
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
