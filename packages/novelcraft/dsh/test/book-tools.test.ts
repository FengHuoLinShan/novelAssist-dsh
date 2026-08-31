// M11/N42 行为契约: 书库生命周期工具组。
// 断言依据: 后续开发计划.md M11 + §6.13(去 developer-only 挂载) + 铁律 3(create/open
// 审批 fail-closed) + N34 精神(无 agent 拒; 不接受模型路径, 目标书按名经 rootForBook)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { NovelCraftService } from '../src/index.js';
import { registerNovelcraftTools, isBookTool } from '../src/tools.js';
import { makeContext } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h: any;
  service: NovelCraftService;
  root: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

async function setup(opts: { outcome: 'allowed-once' | 'rejected' } = { outcome: 'allowed-once' }): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: { outcome: opts.outcome } as never } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-book-'));
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
  // 与 workflow-tools 同口径: 实例级 request 覆写固定 outcome(FakeApproval config 经
  // 基类构造链归一化会丢 outcome)。
  const recorded = h.approval.requests;
  const outcome = opts.outcome;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.approval as any).request = async (req: unknown) => {
    recorded.push(req as never);
    return outcome;
  };
  const binding = service.vaults.ensureVault('第一本书');
  await service.vaults.bindSession('s1', binding);
  return {
    h, service, root: binding.root, tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

const exec = (env: TestEnv, name: string, args: Record<string, unknown>, agent: unknown = fakeAgent) =>
  tool(env, name).execute(args, { callId: 'c1', name, arguments: args, agent, signal: new AbortController().signal });

describe('book 工具组(M11/N42)', () => {
  it('注册面: 39 工具含 book 3 个(list/create/open)', async () => {
    const env = await setup();
    expect(env.tools).toHaveLength(39);
    expect(env.tools.filter((t) => isBookTool(t.name)).map((t) => t.name)).toEqual([
      'novelcraft_book_list', 'novelcraft_book_create', 'novelcraft_book_open',
    ]);
    env.cleanup();
  });

  it('list: 枚举书库 + current 标记; 无 agent 拒绝', async () => {
    const env = await setup();
    const out = await exec(env, 'novelcraft_book_list', {}) as { books: Array<Record<string, unknown>> };
    expect(out.books).toHaveLength(1);
    expect(out.books[0]).toMatchObject({ book: '第一本书', title: '第一本书', current: true });
    // 无 agent → WORKSPACE_ISOLATION(工具 execute 自验)
    // 显式 undefined 会触发 helper 默认参数 fakeAgent, 用 null 表达「无 agent」。
    await expect(exec(env, 'novelcraft_book_list', {}, null))
      .rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    env.cleanup();
  });

  it('未绑定会话可用(review P0-1 修复): list/create/open 不被工厂拦截(首绑入口不死锁)', async () => {
    const env = await setup();
    // 未绑定的 agent(有 session id, 无 vault 绑定)
    const unbound = { id: 'u1', session: { id: 'fresh-unbound' } } as never;
    const listed = await exec(env, 'novelcraft_book_list', {}, unbound) as { books: Array<Record<string, unknown>> };
    expect(listed.books.length).toBeGreaterThanOrEqual(1);
    expect(listed.books.every((b) => b.current === false)).toBe(true); // 无绑定 → 无 current
    const created = await exec(env, 'novelcraft_book_create', { book: '未绑定的第一本' }, unbound) as { created: boolean };
    expect(created.created).toBe(true);
    // open 把未绑定会话首绑到既有书
    const opened = await exec(env, 'novelcraft_book_open', { book: '未绑定的第一本' }, unbound) as { activated: boolean };
    expect(opened.activated).toBe(true);
    const after = await exec(env, 'novelcraft_book_list', {}, unbound) as { books: Array<Record<string, unknown>> };
    expect(after.books.find((b) => b.book === '未绑定的第一本')?.current).toBe(true);
    env.cleanup();
  });

  it('书名穿越/非法名 → 零审批拒绝(review P2)', async () => {
    const env = await setup();
    for (const evil of ['../escape', 'a/b', '..', '.']) {
      let err: unknown;
      try {
        await exec(env, 'novelcraft_book_create', { book: evil });
      } catch (e) { err = e; }
      expect((err as { code?: string }).code).toBeTruthy();
    }
    expect(env.h.approval.requests).toHaveLength(0); // 校验先于审批
    env.cleanup();
  });

  it('create: 审批通过后初始化新书(幂等); 拒绝时零初始化', async () => {
    const rej = await setup({ outcome: 'rejected' });
    let err: unknown;
    try {
      await exec(rej, 'novelcraft_book_create', { book: '新书' });
    } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe('BOOK_CREATE_REJECTED');
    expect(rej.service.vaults.readVault(rej.service.vaults.rootForBook('新书'))).toBeUndefined();
    rej.cleanup();

    const env = await setup();
    const out = await exec(env, 'novelcraft_book_create', { book: '新书' }) as { created: boolean; root: string };
    expect(out.created).toBe(true);
    // 幂等: 再建同名返回既有
    const again = await exec(env, 'novelcraft_book_create', { book: '新书' }) as { created: boolean };
    expect(again.created).toBe(false);
    env.cleanup();
  });

  it('open: 切换会话绑定到既有书; 不存在拒绝指引; 拒绝时绑定不变', async () => {
    const env = await setup();
    await exec(env, 'novelcraft_book_create', { book: '第二本书' });
    const out = await exec(env, 'novelcraft_book_open', { book: '第二本书' }) as { book: string; active_sessions: number };
    expect(out.book).toBe('第二本书');
    // list 现在标记第二本为 current
    const list = await exec(env, 'novelcraft_book_list', {}) as { books: Array<Record<string, unknown>> };
    expect(list.books.find((b) => b.book === '第二本书')?.current).toBe(true);
    expect(list.books.find((b) => b.book === '第一本书')?.current).toBe(false);
    // 不存在的书
    let err: unknown;
    try {
      await exec(env, 'novelcraft_book_open', { book: '没有这本书' });
    } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe('BOOK_NOT_FOUND');
    env.cleanup();

    const rej = await setup({ outcome: 'rejected' });
    await exec(rej, 'novelcraft_book_create', { book: '第二本书' }).catch(() => undefined);
    let err2: unknown;
    try {
      await exec(rej, 'novelcraft_book_open', { book: '第一本书' });
    } catch (e) { err2 = e; }
    expect((err2 as { code?: string }).code).toBe('BOOK_OPEN_REJECTED');
    const still = await rej.service.vaults.resolve('s1');
    expect(still?.book).toBe('第一本书'); // 绑定未变
    rej.cleanup();
  });
});
