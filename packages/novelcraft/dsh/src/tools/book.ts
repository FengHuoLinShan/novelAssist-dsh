// @novelcraft/dsh · book 工具组(M11/N42, §6.13 书库生命周期公开化)。
// 3 工具: list(只读)/create/open(adoptGuarded)。
// 隔离形态: 三工具均「未绑定也可用」(发现/创建第一本书的入口, M11 的目的);
// 无 agent 一律 WORKSPACE_ISOLATION(execute 自验 requireAgentForBooks);
// 不设 bindRoot(不接受模型提供的绝对路径, 目标书一律按书名经 rootForBook 防穿越)。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { sessionIdOf } from './shared.js';
import { novelcraftToolFactory } from './define.js';
import { requireAgentForBooks } from '../book-face.js';
import type { NovelCraftService } from '../service.js';

export function buildBookTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_book_list',
      description:
        '枚举书库(vaultsDir)下的全部书: 书目录名/标题/根路径/当前会话是否绑定。' +
        '用于回答「我现在有哪些书、当前在哪本」。只读、零审批; 无会话上下文时拒绝。',
      parameters: {},
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          books: { type: 'array', required: true },
        },
      },
      timeoutMs: 15_000,
      async execute(_args, run) {
        requireAgentForBooks(run);
        const current = await run.service.vaults.resolve(sessionIdOf(run)).catch(() => undefined);
        const books = run.service.capabilities.read.bookList(current?.root);
        return {
          ok: true,
          books: books.map((b) => ({ book: b.book, title: b.title, root: b.root, current: b.current })),
        };
      },
    }),

    tool({
      name: 'novelcraft_book_create',
      description:
        '创建新书(审批后执行): 在 vaultsDir 下按书名初始化 vault(book.yml + 目录骨架 + git)。' +
        '幂等 —— 同名书已存在时返回既有(不动现有文件)。书名只用做目录段(防穿越校验), ' +
        '不接受路径。创建后当前会话仍绑定原书, 请用 book_open 切换。',
      parameters: {
        book: { type: 'string', required: true, description: '书名(将作为 vault 目录名, 单段无路径分隔)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          book: { type: 'string', required: true },
          root: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        requireAgentForBooks(run);
        const r = await run.service.capabilities.adoptGuarded.bookCreate(run.agent, args.book);
        return { ok: true, ...r };
      },
    }),

    tool({
      name: 'novelcraft_book_open',
      description:
        '切换当前会话到既有书(审批后执行): 把本会话的工作区绑定切到目标书(后续工具的 ' +
        'root 解析随之切换; 原书无其它活跃会话时其守望停止)。书不存在时拒绝并指引 ' +
        'book_list/book_create。同名目录即可, 不接受路径。',
      parameters: {
        book: { type: 'string', required: true, description: '书目录名(book_list 返回的 book 键)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          book: { type: 'string', required: true },
          root: { type: 'string', required: true },
          activated: { type: 'boolean', required: true },
          active_sessions: { type: 'integer', required: true },
        },
      },
      timeoutMs: 30_000,
      async execute(args, run) {
        requireAgentForBooks(run);
        const r = await run.service.capabilities.adoptGuarded.bookOpen(run.agent, sessionIdOf(run), args.book);
        return { ok: true, book: r.book, root: r.root, activated: r.activated, active_sessions: r.count };
      },
    }),
  ];
}
