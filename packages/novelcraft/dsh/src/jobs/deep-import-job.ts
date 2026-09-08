// @novelcraft/dsh · deep_import 后台 job 托管 + 混合完成通知(N55/M13-C)。
// 三入口(novelcraft_deep_import/workflow_resume/workflow_start_new)由同步 3_600_000ms
// 工具执行改为「同步前置校验 → 启动 job 立即返回句柄」; ADR-0022 durable 语义
// (checkpoint/四窗口/reauthorize/apply 状态机)与审批(allowed-once)全部不变, 仅执行
// 宿主换 job——ADR-0023 §3「显式长 job 由 Node 托管, 不因浏览器断线/watcher 取消」
// 自此与实现一致。owner=发起 agent(JobStart.owner), 浏览器断开不影响。
// 完成通知(N55 ② 用户裁定, 混合): completed/failed → owner.followup(唤醒开回合, 宿主
// bash job 同款); killed → owner.inject(非唤醒记录); 无 owner 静默。通知消息带来源标
// {kind:'plugin', plugin:'@novelcraft/dsh'} + notice form(优秀范式 3/官方 repeat-tool-reminder 纪律)。
// 防重入(N55 ④): 每 vault 同时只允许一个活 deep-import job(fail-closed 报既有 jobId);
// 重启后注册表为空, 恢复走 ADR-0022 既有四窗口(inspect/resume 驱动), 不做持久注册。
// trace(N55 ⑤): job_started/job_finished/job_notify 追加进 .assistant/import-trace.jsonl
// (ImportTraceSink 同一落点, 文件真相 + git 回滚面)。
import type { Context } from '@deepseek-ai/cordis';
import { boundContextSummary, HarnessError, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobDoneListener, JobId, JobKindMap, JobRegistry, JobStart } from '@deepseek-ai/dsh-jobs';
import type * as imports from '@novelcraft/imports';
import { gitAdd, gitCommit, hasStagedOutside } from '@novelcraft/store';
import { svc } from '../ctx.js';
import { afterMutation } from '../radar-hooks.js';
import { ImportTraceSink, importTraceFile } from '../deep-import.js';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** 每次 NovelCraft 深度导入执行一个 job(三入口共用, N55)。 */
    'novelcraft-deep-import': 'novelcraft-deep-import';
  }
}

export const DEEP_IMPORT_JOB_KIND = 'novelcraft-deep-import' as JobKindMap['novelcraft-deep-import'];

export type DeepImportJobMode = 'deep_import' | 'resume' | 'start_new';

/** 启动计划: deep_import/start_new 用章范围, resume 用既有 workflow_id。 */
export interface DeepImportJobPlan {
  mode: DeepImportJobMode;
  startChapter?: number;
  endChapter?: number;
  workflowId?: string;
}

/** 工具回执句柄(立即返回; workflow_id 在 deepImport 内派生, 新 run 启动时不可知)。 */
export interface DeepImportJobHandle {
  jobId: string;
  mode: DeepImportJobMode;
  label: string;
  /** resume 模式下请求恢复的 workflow_id(新 run 为空, 经 workflow_inspect 发现)。 */
  requested_workflow_id: string;
}

/** 防重入注册表(N55 ④): root → 活 job id。 */
const activeJobs = new Map<string, JobId>();

/** 当前 root 的活 deep-import job(无则 undefined; abandon 前置 kill 用)。 */
export function activeDeepImportJobId(root: string): string | undefined {
  const id = activeJobs.get(root);
  return id === undefined ? undefined : String(id);
}

/** job output 摘要(有界 JSON; 宿主 output read 与通知共用)。 */
function summarizeResult(result: imports.DeepImportResult, mode: DeepImportJobMode): string {
  return JSON.stringify({
    workflow_id: result.workflow_id,
    adopted: result.adopted,
    committed: result.committed.length,
    skipped: result.skipped.length,
    conflicts: result.conflicts.length,
    rejected: result.rejected,
    mode,
  });
}

/** 通知正文(确定性摘要, 作者语言)。 */
function notifyText(
  status: 'completed' | 'failed' | 'killed',
  mode: DeepImportJobMode,
  result: imports.DeepImportResult | undefined,
): string {
  const actionName = mode === 'resume' ? '恢复深度导入' : mode === 'start_new' ? '重开深度导入' : '深度导入';
  if (status === 'killed') {
    return `${actionName} job 已被停止(kill)。run 状态可用 novelcraft_workflow_inspect 查看; 未收敛的批次按 ADR-0022 恢复语义处理。`;
  }
  if (result === undefined) {
    return `${actionName} job ${status}(未产出 run 摘要)。请用 novelcraft_workflow_inspect 查看 run 状态与失败原因。`;
  }
  if (status === 'failed') {
    return `${actionName} job 失败(run ${result.workflow_id})。请用 novelcraft_workflow_inspect 查看状态, 修复后可 workflow_resume 续跑。`;
  }
  const tail = result.rejected
    ? '注意: Scene 采用未获批准, 候选保持未采用(APPROVAL_REJECTED 语义)。'
    : '';
  return (
    `${actionName} job 完成: run ${result.workflow_id}, 采用 ${result.adopted} 个 Scene` +
    `(${result.skipped.length} skip / ${result.conflicts.length} conflict)。` +
    (tail || '可用 novelcraft_workflow_inspect 复核细节。')
  );
}

function notifyMessage(text: string, jobId: string): UserMessage {
  return {
    id: MessageId(`novelcraft-deep-import-${jobId}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: '@novelcraft/dsh',
      form: 'notice',
      summary: boundContextSummary(text.split('。')[0] + '。'), // 宿主导出的 120 字界(评审 P2-7), 上游改界不漂移
    },
  };
}

/**
 * 启动一个 deep-import job(立即返回句柄, 不等待完成)。
 * 前置校验(范围/枚举/checkpoint 绑定)由调用方在工具层同步完成(fail-fast 错误直达模型,
 * 不进 job 延迟失败); 本函数只做防重入与 jobs 可用性校验。
 */
export function startDeepImportJob(
  ctx: Context,
  agent: Agent | undefined,
  root: string,
  plan: DeepImportJobPlan,
  work: (signal: AbortSignal) => Promise<imports.DeepImportResult>,
): DeepImportJobHandle {
  const running = activeJobs.get(root);
  if (running !== undefined) {
    throw new HarnessError(
      `本书已有进行中的深度导入 job(${String(running)}), 拒绝并发启动(fail-closed)。请用 novelcraft_workflow_inspect 查看进度, 终态后再启动新 run`,
      'DEEP_IMPORT_JOB_CONFLICT',
    );
  }
  const jobs = svc<JobRegistry>(ctx, 'jobs');
  if (!jobs) {
    throw new HarnessError('ctx.jobs 服务不可用(后台深度导入需要 jobs 插件)', 'DEEP_IMPORT_JOB_UNAVAILABLE');
  }

  const label =
    plan.mode === 'resume'
      ? `恢复深度导入: ${plan.workflowId ?? ''}`
      : plan.mode === 'start_new'
        ? `重开深度导入: 第 ${plan.startChapter}-${plan.endChapter} 章`
        : `深度导入: 第 ${plan.startChapter}-${plan.endChapter} 章`;

  let aborter: AbortController | undefined;
  let cancelled = false;
  let captured: imports.DeepImportResult | undefined;
  const specStart: JobStart = {
    kind: DEEP_IMPORT_JOB_KIND,
    label,
    outputLimitBytes: 65_536,
    ...(agent ? { owner: agent } : {}),
    run: () => {
      aborter = new AbortController();
      const outcome = (async () => {
        try {
          const result = await work(aborter!.signal);
          captured = result;
          // 与旧同步工具同款收尾(仅 deep_import 模式; resume/start_new 保持既有不对称面):
          // rejected 不跑 afterMutation(零资产变化, APPROVAL_REJECTED 语义)。
          if (plan.mode === 'deep_import' && !result.rejected) {
            await afterMutation(ctx, root, { radars: ['deepImport'], rag: true });
          }
          return { status: cancelled ? ('killed' as const) : ('completed' as const), output: summarizeResult(result, plan.mode) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { status: cancelled ? ('killed' as const) : ('failed' as const), detail: message.slice(0, 400) };
        } finally {
          if (activeJobs.get(root) === jobId) activeJobs.delete(root);
        }
      })();
      return {
        cancel: (reason?: string) => {
          cancelled = true;
          aborter?.abort(reason);
        },
        done: outcome,
      };
    },
  };
  const jobId = jobs.start(specStart);
  activeJobs.set(root, jobId);

  const trace = new ImportTraceSink(importTraceFile(root));
  trace.record({ type: 'job_started', job_id: String(jobId), mode: plan.mode, label });

  // 混合通知(N55 ②): 每个 job 挂一个 onJobDone 监听(kind+id 过滤, 触发后自卸载);
  // 无 owner → 静默(仍记 job_notify: silent)。
  const offDone = jobs.onJobDone(((snapshot, owner) => {
    if (String(snapshot.id) !== String(jobId)) return;
    offDone();
    const status = snapshot.status === 'killed' || snapshot.status === 'stopping' ? 'killed'
      : snapshot.status === 'completed' ? 'completed'
        : 'failed';
    const workflowId = captured?.workflow_id ?? '';
    trace.record({
      type: 'job_finished',
      job_id: String(jobId),
      workflow_id: workflowId,
      status,
      ...(snapshot.detail !== undefined ? { detail: String(snapshot.detail).slice(0, 400) } : {}),
    });
    const channel: 'followup' | 'inject' | 'silent' =
      owner === undefined ? 'silent' : status === 'killed' ? 'inject' : 'followup';
    if (channel !== 'silent' && owner !== undefined) {
      const text = notifyText(status, plan.mode, captured);
      try {
        if (channel === 'followup') owner.followup(notifyMessage(text, String(jobId)));
        else owner.inject(notifyMessage(text, String(jobId)));
      } catch (err) {
        // 通知尽力而为: 失败不回滚 job 结果, 记 console 供运维排查(同 fireRadar 纪律)。
        console.error(`[novelcraft] deep-import job notify(${channel}) failed:`, err);
      }
    }
    // job_notify 记录的是「通道选择」而非「送达确认」: followup/inject 抛错时仍记意图通道
    // (失败痕迹在 console), 评审 P2-2 注记。
    trace.record({ type: 'job_notify', job_id: String(jobId), workflow_id: workflowId, channel });
    // job 生命周期事件发生在 deepImport 末次 state commit 之后, 追加会让 trace 文件滞留
    // 工作区未提交 —— 经 store 精确 pathspec 补一笔(N55: 保「深导后工作区洁净」不变量;
    // 范围外预存 staged 时放弃提交, 留待下一次 state commit 收敛, 不冒险卷入)。
    try {
      if (!hasStagedOutside(root, ['.assistant/import-trace.jsonl'])) {
        gitAdd(root, ['.assistant/import-trace.jsonl']);
        gitCommit(root, `chore: record deep-import job lifecycle (${String(jobId)})`);
      }
    } catch (err) {
      console.error('[novelcraft] deep-import job trace commit failed:', err);
    }
  }) as JobDoneListener);

  return { jobId: String(jobId), mode: plan.mode, label, requested_workflow_id: plan.workflowId ?? '' };
}

/**
 * abandon 前置停止(N55 ③): 有活 job → kill + 有界 wait 至终态。
 * 返回 'none'(无活 job)/'killed'(已终态, 可继续 abandon 清理)/'kill-pending'
 * (有界等待后仍在运行 —— 如实返回, 清理留待终态, 不冒充完成)。
 */
export async function killActiveDeepImportJob(
  ctx: Context,
  agent: Agent | undefined,
  root: string,
  waitMs = 10_000,
): Promise<'none' | 'killed' | 'kill-pending'> {
  const jobId = activeJobs.get(root);
  if (jobId === undefined) return 'none';
  const jobs = svc<JobRegistry>(ctx, 'jobs');
  if (!jobs) return 'none';
  // caller 必须= 发起 agent(评审 P0-1): 真实宿主 LocalJobRegistry.assertAccess 对
  // 「owned job + caller=undefined」抛 belongs to another session —— 不传 agent 会让
  // abandon-kill 主线在真实宿主上整体断裂(FakeJobs 曾无 fencing 掩盖此缺陷)。
  const status = jobs.kill(jobId, agent, 'workflow_abandon 请求停止运行中的 deep-import job');
  if (status === 'already-finished') return 'killed';
  try {
    const snapshot = await jobs.wait(jobId, waitMs, agent);
    return snapshot.status === 'running' || snapshot.status === 'stopping' ? 'kill-pending' : 'killed';
  } catch {
    return 'kill-pending';
  }
}
