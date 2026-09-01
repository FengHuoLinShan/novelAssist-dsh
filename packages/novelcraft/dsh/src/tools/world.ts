// @novelcraft/dsh · world 对象与生成中心工具组(M12-a/N43, M12-b/N44)。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { ENTITY_TYPES } from '@novelcraft/store';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';
import { capReceipt, llmError, requireRoot } from './shared.js';

const selectedContextParameters = {
  source_refs: { type: 'array' as const, description: '显式选择的 vault 相对来源路径；不传则只用作者任务' },
  include_working_drafts: { type: 'boolean' as const, description: '显式允许所选 draft/candidate；默认 false' },
  context_budget_tokens: { type: 'integer' as const, description: '本次 auditable context 估算预算' },
};

const contextReceiptOutput = {
  context_hash: { type: 'string' as const, required: true },
  source_manifest: { type: 'array' as const, required: true },
  omitted_source_ids: { type: 'array' as const, required: true },
  warnings: { type: 'array' as const, required: true },
} as const;

function selectionOf(args: {
  input: string;
  source_refs?: readonly unknown[];
  include_working_drafts?: boolean;
  context_budget_tokens?: number;
}) {
  const sourceRefs = args.source_refs?.map((value) => {
    if (typeof value !== 'string') throw llmError('schema_violation', 'source_refs 必须是字符串数组');
    return value;
  });
  return {
    instruction: args.input,
    ...(sourceRefs !== undefined ? { source_refs: sourceRefs } : {}),
    ...(args.include_working_drafts === true ? { include_working_drafts: true } : {}),
    ...(args.context_budget_tokens !== undefined ? { budget_tokens: args.context_budget_tokens } : {}),
  };
}

function contextProjection(receipt: import('@novelcraft/world').WorldContextReceipt) {
  return {
    context_hash: receipt.context_hash,
    source_manifest: receipt.source_manifest.map((source) => ({
      source_id: source.source_id,
      source_type: source.source_type,
      source_hash: source.source_hash,
      included_content_hash: source.included_content_hash,
      source_status: source.source_status ?? '',
      open_path: typeof source.open_target?.path === 'string' ? source.open_target.path : '',
      truncated: source.truncated,
    })),
    omitted_source_ids: receipt.omitted_source_ids,
    warnings: receipt.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      source_id: warning.source_id,
    })),
  };
}

export function buildWorldObjectTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_world_create',
      description:
        '创建世界对象(审批后执行): 写入 world/objects/(canonical 状态, 经 N32 事务精确提交)。' +
        'name 必填; entityType 缺省 object; 别名/标签/描述可选。同名对象已存在时拒绝。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        name: { type: 'string', required: true, description: '对象名(如「红衣女子」)' },
        entity_type: { type: 'string', description: "类型(缺省 'object'; 如 character/location/faction)" },
        aliases: { type: 'array', description: '别名列表(可选)' },
        tags: { type: 'array', description: '标签列表(可选)' },
        description: { type: 'string', description: '对象正文描述(可选)' },
        note: { type: 'string', description: '审批摘要补充说明(可选)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        if (args.entity_type !== undefined && !(ENTITY_TYPES as readonly string[]).includes(args.entity_type)) {
          throw llmError('schema_violation',
            `entity_type 必须是 ENTITY_TYPES 白名单之一(收到: ${args.entity_type})`);
        }
        const strList = (v: readonly unknown[] | undefined, what: string): string[] | undefined => {
          if (v === undefined) return undefined;
          return v.map((x) => {
            if (typeof x !== 'string') throw llmError('schema_violation', `${what} 必须是字符串数组`);
            return x;
          });
        };
        const aliases = strList(args.aliases, 'aliases');
        const tags = strList(args.tags, 'tags');
        const slug = await run.service.capabilities.adoptGuarded.worldCreate(
          run.agent,
          requireRoot(run),
          {
            name: args.name,
            entityType: args.entity_type ?? 'object',
            ...(aliases ? { aliases } : {}),
            ...(tags ? { tags } : {}),
            ...(args.description ? { description: args.description } : {}),
          },
          args.note,
        );
        return { ok: true, slug };
      },
    }),
    tool({
      name: 'novelcraft_world_update',
      description:
        '修改世界对象(审批后执行): 按对象 slug 定位 world/objects/ 内对象, 更新' +
        'name/tags/正文描述(经 N32 事务, 保留其余 frontmatter 与正文语义)。审批冻结' +
        '写前字节与 HEAD, 写前重验(并发修改 CAS 拒绝)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        slug: { type: 'string', required: true, description: '对象 slug(store_adopt/world 对象读面返回的 id)' },
        name: { type: 'string', description: '新名称(可选)' },
        tags: { type: 'array', description: '新标签列表(可选; 整组替换)' },
        description: { type: 'string', description: '新正文描述(可选; 整段替换)' },
        note: { type: 'string', description: '审批摘要补充说明(可选)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        const patch: { name?: string; description?: string; tags?: string[] } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.name === undefined && args.tags === undefined && args.description === undefined) {
          throw llmError('schema_violation', '至少提供 name/tags/description 之一(空 patch 拒绝, 避免无意义审批+重排提交)');
        }
        if (args.tags !== undefined) {
          patch.tags = args.tags.map((x) => {
            if (typeof x !== 'string') throw llmError('schema_violation', 'tags 必须是字符串数组');
            return x;
          });
        }
        if (args.description !== undefined) patch.description = args.description;
        await run.service.capabilities.adoptGuarded.worldUpdate(
          run.agent,
          requireRoot(run),
          args.slug,
          patch,
          args.note,
        );
        return { ok: true, slug: args.slug };
      },
    }),
  ];
}

export function buildWorldGenerationTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_world_chat',
      description:
        '世界生成中心·共创聊天(M12-b/N44): 与内容手就世界设定自由共创对话, 纯 LLM 调用零写。' +
        '产出想法供作者参考; 要落资产请走 world_bible_suggest(工作稿)或 world_create(对象)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '对话输入(设定材料+当前问题)' },
        ...selectedContextParameters,
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, reply: { type: 'string', required: true },
          error: { type: 'string', required: true }, ...contextReceiptOutput,
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenChat(requireRoot(run), selectionOf(args), run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, reply: capReceipt(run, r.reply ?? ''), error: '', ...contextProjection(r.context_receipt) };
      },
    }),
    tool({
      name: 'novelcraft_world_converge',
      description: '世界生成中心·只读收束: 对给定设定材料做收敛分析(矛盾/缺口/可合并项), 零写。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '待收束的设定材料' },
        ...selectedContextParameters,
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true },
          error: { type: 'string', required: true }, ...contextReceiptOutput,
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenConverge(requireRoot(run), selectionOf(args), run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return {
          ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '',
          ...contextProjection(r.context_receipt),
        };
      },
    }),
    tool({
      name: 'novelcraft_world_explore',
      description: '世界生成中心·一跳探索: 从既有设定出发探索相邻可能性(≤3 个方向), 不创建资产。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '探索锚点(当前设定摘要)' },
        ...selectedContextParameters,
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true },
          error: { type: 'string', required: true }, ...contextReceiptOutput,
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenExplore(requireRoot(run), selectionOf(args), run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return {
          ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '',
          ...contextProjection(r.context_receipt),
        };
      },
    }),
    tool({
      name: 'novelcraft_world_inspect',
      description: '世界生成中心·页面检修: 对给定世界书页面/设定做语义检视, 返回 findings 供作者复核, 零写。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '待检视的页面内容/设定' },
        ...selectedContextParameters,
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true },
          error: { type: 'string', required: true }, ...contextReceiptOutput,
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenInspect(requireRoot(run), selectionOf(args), run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return {
          ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '',
          ...contextProjection(r.context_receipt),
        };
      },
    }),
    tool({
      name: 'novelcraft_world_bible_suggest',
      description:
        '世界生成中心·世界书页面建议(§6.17 语义): 生成页面提案并落 bible/ 为 draft 工作稿' +
        '(不是 canonical —— 采用请走 store_adopt 的 bible_page)。is_new_page=true 时按新页建议。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '页面建议输入(主题/已有页内容)' },
        is_new_page: { type: 'boolean', description: '是否按新页建议(缺省 false)' },
        ...selectedContextParameters,
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, slug: { type: 'string', required: true },
          error: { type: 'string', required: true }, ...contextReceiptOutput,
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenBibleSuggest(
          requireRoot(run), selectionOf(args), { ...(args.is_new_page ? { isNewPage: true } : {}) }, run.signal,
        );
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, slug: r.slug ?? '', error: '', ...contextProjection(r.context_receipt) };
      },
    }),
  ];
}

export function buildWorldTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  return [...buildWorldObjectTools(ctx, service), ...buildWorldGenerationTools(ctx, service)];
}
