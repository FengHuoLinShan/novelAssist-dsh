// M12-a/N43 行为契约: worldCreate/worldUpdate 工具入口(N31 起能力已注册, 本批补作者可达面)。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { NovelCraftService } from '../src/index.js';
import { makeContext } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

async function setup(opts: { outcome: 'allowed-once' | 'rejected' } = { outcome: 'allowed-once' }) {
  const h = await makeContext({ approval: { outcome: { outcome: opts.outcome } as never } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-ww-'));
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
const tool = (env: { tools: ToolDefinition[] }, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};
const exec = (env: ReturnType<typeof setup> extends Promise<infer T> ? T : never, name: string, args: Record<string, unknown>) =>
  (tool(env, name) as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(args, { callId: 'c1', name, arguments: args, agent: fakeAgent, signal: new AbortController().signal });

describe('world 写工具(M12-a/N43)', () => {
  it('create: 审批后写入 world/objects/ 并精确提交; 拒绝零写', async () => {
    const rej = await setup({ outcome: 'rejected' });
    await expect(exec(rej, 'novelcraft_world_create', { root: rej.root, name: '红衣女子', entity_type: 'character' }))
      .rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    const log = execFileSync('git', ['-C', rej.root, 'log', '--oneline'], { encoding: 'utf8' });
    expect(log).not.toContain('world');
    rej.cleanup();

    const env = await setup();
    const out = await exec(env, 'novelcraft_world_create', {
      root: env.root, name: '红衣女子', entity_type: 'character', aliases: ['红衣'], tags: ['神秘'],
      description: '桥头出现的神秘女子。',
    }) as { ok: boolean; slug: string };
    expect(out.ok).toBe(true);
    const file = path.join(env.root, 'world', 'objects', `${out.slug}.md`);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('name: "红衣女子"');
    expect(raw).toContain('kind: "character"');
    expect(raw).toContain('红衣');
    // N32 事务提交: subject 是 vault-tx 哈希, 精确 pathspec 在 name-only(中文转义形态)。
    const head = execFileSync('git', ['-C', env.root, 'log', '-1', '--name-only', '--pretty=%s'], { encoding: 'utf8' });
    expect(head).toContain('world/objects/');
    env.cleanup();
  });

  it('update: 审批后改 name/tags(整组替换), 保留其余 frontmatter; 未知 slug 拒绝', async () => {
    const env = await setup();
    const created = await exec(env, 'novelcraft_world_create', { root: env.root, name: '旧名' }) as { slug: string };
    const out = await exec(env, 'novelcraft_world_update', {
      root: env.root, slug: created.slug, name: '新名', tags: ['t1'],
    }) as { ok: boolean };
    expect(out.ok).toBe(true);
    const raw = readFileSync(path.join(env.root, 'world', 'objects', `${created.slug}.md`), 'utf8');
    expect(raw).toContain('name: 新名');
    expect(raw).not.toContain('name: 旧名');
    // 未知 slug → store 读面错误(零审批内 prepare 抛)
    await expect(exec(env, 'novelcraft_world_update', { root: env.root, slug: 'obj-不存在' }))
      .rejects.toThrow();
    env.cleanup();
  });
});
