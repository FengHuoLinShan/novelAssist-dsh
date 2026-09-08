// @novelcraft/dsh · workflow 工具组(M10-B1/N40, §6.9/§6.6 长任务作者恢复面)。
// 4 工具: inspect(只读)/resume/start_new/abandon(adoptGuarded)。
// 恢复动作经 capabilities.adoptGuarded.workflow*; inspect 经 capabilities.read.workflowInspect;
// N34 隔离由 novelcraftToolFactory 统一(root 参数 + session 绑定三情形矩阵)。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';
import { assertImportRange } from '../deep-import.js';
import { killActiveDeepImportJob, startDeepImportJob } from '../jobs/deep-import-job.js';

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
        '恢复中断的深度导入 run: 同步完成前置校验(枚举存在/非 start_new 强制 run/checkpoint 绑定, ' +
        '不合法直接报错)后启动后台 job 立即返回句柄(N55/M13-C, 不再阻塞会话)。job 内从 checkpoint ' +
        '读原范围续跑(workflow_id 绑定校验 + 执行后对账 identity)—— 已完成批次跳过, 只对剩余批次' +
        '请求范围/成本授权(authorize_deep_import_resume)。完成后助手会收到通知; 进度用 workflow_inspect ' +
        '查看; 中断后可再次 resume(幂等)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        workflow_id: { type: 'string', required: true, description: 'workflow_inspect 返回的 workflow_id' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          job_id: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          label: { type: 'string', required: true },
          requested_workflow_id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        // 同步 fail-fast: 三重前置校验(枚举存在/非 force run/checkpoint 绑定)直达模型, 不进 job 延迟失败。
        run.service.capabilities.read.workflowResumePreflight(args.root, args.workflow_id);
        const handle = startDeepImportJob(ctx, run.agent, args.root, {
          mode: 'resume',
          workflowId: args.workflow_id,
        }, (signal) => run.service.capabilities.adoptGuarded.workflowResume(
          run.agent, args.root, args.workflow_id, signal,
        ));
        return {
          ok: true,
          job_id: handle.jobId,
          mode: handle.mode,
          label: handle.label,
          requested_workflow_id: handle.requested_workflow_id,
          message: '恢复续跑已转后台 job(' + handle.jobId + '), 本工具立即返回。完成后会收到结果通知; 进度用 novelcraft_workflow_inspect 查看',
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
          job_id: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          label: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        // 同步 fail-fast: 非法范围不启动 job(N55)。
        assertImportRange(args.start_chapter, args.end_chapter);
        const handle = startDeepImportJob(ctx, run.agent, args.root, {
          mode: 'start_new',
          startChapter: args.start_chapter,
          endChapter: args.end_chapter,
        }, (signal) => run.service.capabilities.adoptGuarded.workflowStartNew(
          run.agent,
          args.root,
          { startChapter: args.start_chapter, endChapter: args.end_chapter },
          signal,
        ));
        return {
          ok: true,
          job_id: handle.jobId,
          mode: handle.mode,
          label: handle.label,
          message: '重开导入已转后台 job(' + handle.jobId + '), 本工具立即返回。完成后会收到结果通知; 进度用 novelcraft_workflow_inspect 查看',
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
          message: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        if (args.kind !== 'deep-import' && args.kind !== 'map-atlas') {
          throw new Error(`kind 必须是 'deep-import' 或 'map-atlas'(收到: ${args.kind})`);
        }
        // N55/M13-C: 放弃 deep-import run 时先停本书运行中的 deep-import job(kill +
        // 有界等待至终态; 仅 kind=deep-import —— 放弃 map-atlas run 不得连带击杀深导,
        // 评审 P1-1); kill-pending 如实返回(清理留待终态), 不冒充完成。caller=发起
        // agent(真实宿主 owned-job fencing, 评审 P0-1)。
        const killState = args.kind === 'deep-import'
          ? await killActiveDeepImportJob(ctx, run.agent, args.root)
          : 'none';
        if (killState === 'kill-pending') {
          return {
            ok: false,
            abandoned: [],
            message: '停止请求已发出但 job 尚未到达终态, 本次未清理(不冒充完成)。请稍后重试 workflow_abandon',
          };
        }
        const result = await run.service.capabilities.adoptGuarded.workflowAbandon(
          run.agent, args.root, { kind: args.kind, workflowId: args.workflow_id },
        );
        return { ok: true, abandoned: result.abandoned, message: '已放弃并清理 run 目录(精确 git 提交)' };
      },
    }),
  ];
}
