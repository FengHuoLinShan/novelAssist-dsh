// @novelcraft/dsh · workflow 工具组(M10-B1/N40, §6.9/§6.6 长任务作者恢复面)。
// 4 工具: inspect(只读)/resume/start_new/abandon(adoptGuarded)。
// 恢复动作经 capabilities.adoptGuarded.workflow*; inspect 经 capabilities.read.workflowInspect;
// N34 隔离由 novelcraftToolFactory 统一(root 参数 + session 绑定三情形矩阵)。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';

export function buildWorkflowTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_workflow_inspect',
      description:
        '枚举本书的全部 durable manifest 工作流 run(深度导入 + 地图册目录形态)与恢复选项: 每个返回 kind/' +
        'workflow_id/status(含 completed/running/provider_outcome_unknown)/批次进度(cursor/' +
        'completed/other)/指纹与 checkpoint 概要。用于回答「有哪些进行中或已完成的导入/地图册 ' +
        'run、各自到什么程度、能否恢复」。只读, 零审批。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          runs: { type: 'array', required: true },
          checkpoint_workflow_id: { type: 'string', required: true },
          checkpoint_scope: { type: 'string', required: true },
        },
      },
      timeoutMs: 30_000,
      async execute(args, run) {
        const view = run.service.capabilities.read.workflowInspect(args.root);
        const cp = view.checkpoint;
        return {
          ok: true,
          // 逐字段投影为纯 JSON 对象(接口类型无 index signature, 与 llm_step journal 投影同口径)。
          runs: view.runs.map((r) => ({
            kind: r.kind,
            run_dir: r.run_dir,
            workflow_id: r.workflow_id,
            status: r.status,
            ...(r.created_at !== undefined ? { created_at: r.created_at } : {}),
            ...(r.cursor !== undefined ? { cursor: { phase: r.cursor.phase, ordinal: r.cursor.ordinal } } : {}),
            batches: { total: r.batches.total, completed: r.batches.completed, other: r.batches.other },
            ...(r.input_fingerprint !== undefined ? { input_fingerprint: r.input_fingerprint } : {}),
            ...(r.profile_fingerprint !== undefined ? { profile_fingerprint: r.profile_fingerprint } : {}),
            ...(r.corrupt !== undefined ? { corrupt: r.corrupt } : {}),
          })),
          checkpoint_workflow_id: cp?.workflow_id ?? '',
          checkpoint_scope: cp ? `${cp.start_chapter}-${cp.end_chapter}` : '',
        };
      },
    }),

    tool({
      name: 'novelcraft_workflow_resume',
      description:
        '恢复中断的深度导入 run: 前置校验(枚举存在/非 start_new 强制 run/checkpoint 绑定)后' +
        '从 checkpoint 读原范围续跑(与 workflow_id 绑定校验, 不匹配拒绝; 执行后对账 identity)' +
        '并续跑 —— 已完成批次跳过, 只对剩余批次请求范围/成本授权(authorize_deep_import_resume)。' +
        '注意: 同步执行, 大范围导入可能耗时较长; 中断后可再次 resume(幂等)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        workflow_id: { type: 'string', required: true, description: 'workflow_inspect 返回的 workflow_id' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          workflow_id: { type: 'string', required: true },
          adopted: { type: 'integer', required: true },
          committed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          conflicts: { type: 'integer', required: true },
        },
      },
      timeoutMs: 3_600_000,
      async execute(args, run) {
        const result = await run.service.capabilities.adoptGuarded.workflowResume(
          run.agent, args.root, args.workflow_id, run.signal,
        );
        return {
          ok: true,
          workflow_id: result.workflow_id,
          adopted: result.adopted,
          committed: result.committed.length,
          skipped: result.skipped.length,
          conflicts: result.conflicts.length,
        };
      },
    }),

    tool({
      name: 'novelcraft_workflow_start_new',
      description:
        '显式新开深度导入 run(force): 不复用同范围的旧 run, 请求全范围/成本授权。' +
        '用于: 旧 run 已 completed 但作者想重新导入(旧结果重放需显式选择, 不再隐式发生)、' +
        '或 checkpoint 指纹失配无法续跑时的重来入口。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        start_chapter: { type: 'integer', required: true, description: '起始章号(≥1)' },
        end_chapter: { type: 'integer', required: true, description: '结束章号(≥start)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          workflow_id: { type: 'string', required: true },
          adopted: { type: 'integer', required: true },
          committed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          conflicts: { type: 'integer', required: true },
        },
      },
      timeoutMs: 3_600_000,
      async execute(args, run) {
        const result = await run.service.capabilities.adoptGuarded.workflowStartNew(
          run.agent,
          args.root,
          { startChapter: args.start_chapter, endChapter: args.end_chapter },
          run.signal,
        );
        return {
          ok: true,
          workflow_id: result.workflow_id,
          adopted: result.adopted,
          committed: result.committed.length,
          skipped: result.skipped.length,
          conflicts: result.conflicts.length,
        };
      },
    }),

    tool({
      name: 'novelcraft_workflow_abandon',
      description:
        '放弃一个已终止(completed/failed/provider_outcome_unknown/损坏)的 durable run(审批后执行): ' +
        '删除其 .assistant 下的 run 目录与绑定的 ' +
        'checkpoint 并精确 git 提交。已应用的创作资产(Scene/实体/别名/结构)不受影响 —— ' +
        '撤销资产请走 git 历史或章节版本面。适合清理失败/过时的 run 恢复状态。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        kind: { type: 'string', required: true, description: "run 域: 'deep-import' | 'map-atlas'" },
        workflow_id: { type: 'string', required: true, description: 'workflow_inspect 返回的 workflow_id' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          abandoned: { type: 'array', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        if (args.kind !== 'deep-import' && args.kind !== 'map-atlas') {
          throw new Error(`kind 必须是 'deep-import' 或 'map-atlas'(收到: ${args.kind})`);
        }
        const result = await run.service.capabilities.adoptGuarded.workflowAbandon(
          run.agent, args.root, { kind: args.kind, workflowId: args.workflow_id },
        );
        return { ok: true, abandoned: result.abandoned };
      },
    }),
  ];
}
