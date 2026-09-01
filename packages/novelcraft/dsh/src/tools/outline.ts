// @novelcraft/dsh · outline preview/apply 工具组(M12-b/N44)。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';
import { capReceipt, llmError, requireRoot } from './shared.js';

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

function contextProjection(record: { context_receipt?: import('@novelcraft/outline').OutlineContextReceipt }) {
  const receipt = record.context_receipt;
  if (!receipt) throw llmError('protocol_error', '安全 outline preview 缺 context receipt');
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

export function buildOutlineTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_outline_preview',
      description:
        '生成小说总纲 preview: 跑内容手(story_outline spec)并把结果暂存到 .assistant/proposals/' +
        '(带 prompt 指纹), **不写 structure/outline.md**。作者审阅/编辑暂存记录后, 用 ' +
        'novelcraft_outline_apply 显式采用(过审批)。返回 run_id 供 apply 引用。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '生成输入(当前设定摘要/方向要求等上下文)' },
        source_refs: { type: 'array', description: '显式选择的 vault 相对来源路径；不传则只用作者任务' },
        include_working_drafts: { type: 'boolean', description: '仅当作者本轮明确要求时允许所选 draft/candidate；默认 false' },
        context_budget_tokens: { type: 'integer', description: '本次 auditable context 估算预算' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          run_id: { type: 'string', required: true },
          result_json: { type: 'string', required: true },
          error: { type: 'string', required: true },
          context_hash: { type: 'string', required: true },
          source_manifest: { type: 'array', required: true },
          omitted_source_ids: { type: 'array', required: true },
          warnings: { type: 'array', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.outlinePreview(requireRoot(run), selectionOf(args), run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return {
          ok: true,
          run_id: r.record.run_id,
          result_json: capReceipt(run, JSON.stringify(r.record.result)),
          error: '',
          ...contextProjection(r.record),
        };
      },
    }),
    tool({
      name: 'novelcraft_outline_apply',
      description:
        '采用总纲 preview(审批后执行): 把 .assistant/proposals/ 中该 run_id 的生成结果写入 ' +
        'structure/outline.md(canonical 覆写; 旧版本走 git 历史)。run_id 来自 outline_preview。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', required: true, description: 'outline_preview 返回的 run_id' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, file: { type: 'string', required: true } },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        return { ok: true, ...(await run.service.capabilities.adoptGuarded.outlineApply(run.agent, requireRoot(run), args.run_id)) };
      },
    }),
    tool({
      name: 'novelcraft_outline_item_preview',
      description:
        '生成 P20 当前层(剧情线 plot_thread / 篇章纲 outline_arc)preview: 结果暂存 ' +
        '.assistant/proposals/(带 prompt 指纹), **不写 structure/**。用 ' +
        'novelcraft_outline_item_apply 显式采用(过审批)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        target: { type: 'string', required: true, description: "'plot_thread' | 'outline_arc'" },
        input: { type: 'string', required: true, description: '生成输入(当前层上下文/要求)' },
        source_refs: { type: 'array', description: '显式选择的 vault 相对来源路径；不传则只用作者任务' },
        include_working_drafts: { type: 'boolean', description: '仅当作者本轮明确要求时允许所选 draft/candidate；默认 false' },
        context_budget_tokens: { type: 'integer', description: '本次 auditable context 估算预算' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          run_id: { type: 'string', required: true },
          result_json: { type: 'string', required: true },
          error: { type: 'string', required: true },
          context_hash: { type: 'string', required: true },
          source_manifest: { type: 'array', required: true },
          omitted_source_ids: { type: 'array', required: true },
          warnings: { type: 'array', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        if (args.target !== 'plot_thread' && args.target !== 'outline_arc') {
          throw llmError('schema_violation', "target 必须是 'plot_thread' 或 'outline_arc'");
        }
        const r = await run.service.capabilities.propose.outlineItemPreview(
          requireRoot(run), args.target, selectionOf(args), run.signal,
        );
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return {
          ok: true,
          run_id: r.record.run_id,
          result_json: capReceipt(run, JSON.stringify(r.record.result)),
          error: '',
          ...contextProjection(r.record),
        };
      },
    }),
    tool({
      name: 'novelcraft_outline_item_apply',
      description:
        '采用 P20 当前层 preview(审批后执行): 把该 run_id 的生成结果写入 structure/(thread/arc ' +
        '资产, canonical)。返回新资产 slug。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', required: true, description: 'outline_item_preview 返回的 run_id' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, slug: { type: 'string', required: true } },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        return { ok: true, ...(await run.service.capabilities.adoptGuarded.outlineItemApply(run.agent, requireRoot(run), args.run_id)) };
      },
    }),
  ];
}
