// @novelcraft/dsh · 长任务恢复面(M10-B1/N40, §6.9/§6.6 作者闭环)。
// workflowInspect: 只读枚举 durable run(imports.listWorkflowRuns 两个 namespace)+ checkpoint 概要;
// workflowResumeGuarded: 从 checkpoint 读原 scope(与请求 workflowId 绑定校验)→ 复用 deepImport
//   续跑路径(classification=resume 时授权只请求剩余范围/成本, N33 P2 既有语义);
// workflowStartNewGuarded: force 新 workflowId(unique 时间戳段)+ 全 scope 授权 ——
//   completed run 不再被隐式重放(B2: 重放 vs 新 run 由作者显式选择);
// workflowAbandonGuarded: 审批通过后清理该 run 目录(+ 绑定的 checkpoint)并精确 git 提交;
//   不触碰 canonical 创作资产(铁律 2: git 本身是回滚面, 资产撤销走 git revert/版本面)。
// 纪律: 本文件不直接写 canonical; abandon 的 git 写只用 store 的精确 pathspec
// (gitAdd/gitCommit), 与 check-git-writers 允许表一致。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitAdd, gitCommit } from '@novelcraft/store';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import * as imports from '@novelcraft/imports';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { NovelCraftService } from './service.js';
import { deepImport, type DeepImportOptions } from './deep-import.js';

/** checkpoint 概要(只读; 指纹匹配验证属 resume 执行路径, inspect 不做)。 */
export interface WorkflowCheckpointSummary {
  workflow_id: string;
  start_chapter: number;
  end_chapter: number;
}

interface CheckpointDoc {
  plan?: {
    workflow_id?: string;
    authorization?: { scope?: { start_chapter?: unknown; end_chapter?: unknown } };
  };
}

function readCheckpointSummary(root: string): WorkflowCheckpointSummary | undefined {
  const cpPath = join(root, '.assistant', 'checkpoint.json');
  if (!existsSync(cpPath)) return undefined;
  try {
    const doc: unknown = JSON.parse(readFileSync(cpPath, 'utf8'));
    const plan = (doc as CheckpointDoc)?.plan;
    const scope = plan?.authorization?.scope;
    const start = scope?.start_chapter;
    const end = scope?.end_chapter;
    if (
      typeof plan?.workflow_id === 'string' &&
      typeof start === 'number' && typeof end === 'number' && Number.isInteger(start) && Number.isInteger(end)
    ) {
      return { workflow_id: plan.workflow_id, start_chapter: start, end_chapter: end };
    }
    return undefined;
  } catch {
    return undefined; // 坏 checkpoint: inspect 容错跳过(resume 路径会 fail-closed)
  }
}

/** 只读枚举: durable runs + checkpoint 概要(零写、零审批)。 */
export function workflowInspect(root: string): {
  runs: imports.ListedWorkflowRun[];
  checkpoint?: WorkflowCheckpointSummary;
} {
  return { runs: imports.listWorkflowRuns(root), ...(readCheckpointSummary(root) ? { checkpoint: readCheckpointSummary(root) } : {}) };
}

/** deep-import run 的 scope 恢复: checkpoint 绑定校验(workflowId 尾段含 checkpoint plan id)。 */
function requireDeepImportScope(root: string, workflowId: string): { startChapter: number; endChapter: number } {
  const cp = readCheckpointSummary(root);
  if (cp === undefined) {
    throw new HarnessError(
      `无法恢复 run ${workflowId}: checkpoint 不可读或缺 scope。` +
        '请用 workflow_start_new 重新授权导入, 或清理 .assistant/checkpoint.json 后重试',
      'WORKFLOW_RESUME_INVALID',
    );
  }
  if (!workflowId.endsWith(`-${cp.workflow_id}`)) {
    throw new HarnessError(
      `run ${workflowId} 与 checkpoint(${cp.workflow_id})不绑定, 拒绝按 checkpoint scope 续跑(fail-closed)。` +
        '如需重跑该范围请用 workflow_start_new 显式新授权',
      'WORKFLOW_RESUME_INVALID',
    );
  }
  return { startChapter: cp.start_chapter, endChapter: cp.end_chapter };
}

/** 恢复执行(fail-closed: 授权/画像不合法即抛, 零 provider 零写由 deepImport 前置保证)。 */
export async function workflowResumeGuarded(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<imports.DeepImportResult> {
  const scope = requireDeepImportScope(root, workflowId);
  // 同 scope 复用 deepImport: classification=resume → authorize_deep_import_resume 只请求
  // 剩余范围/成本(completed 批次跳过; provider_outcome_unknown 批次重试授权, N33 §5.0/§8)。
  return deepImport(service, agent, root, scope, signal);
}

/** 显式新 run(force): 不复用同 scope 旧 run, 全 scope 授权(classification 恒为 new)。 */
export async function workflowStartNewGuarded(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  opts: DeepImportOptions,
  signal?: AbortSignal,
): Promise<imports.DeepImportResult> {
  return deepImport(service, agent, root, { ...opts, force: true }, signal);
}

/** 放弃 run: 审批通过后清理 run 目录(+绑定 checkpoint), 精确 git 提交; 不动 canonical 资产。 */
export async function workflowAbandonGuarded(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  args: { kind: 'deep-import' | 'map-atlas'; workflowId: string },
): Promise<{ abandoned: string[]; commit: string }> {
  const runRoot = args.kind === 'deep-import' ? '.assistant/import-runs' : '.assistant/atlas/runs';
  const runDir = join(root, runRoot, args.workflowId);
  if (!existsSync(runDir)) {
    throw new HarnessError(`run 目录不存在: ${runRoot}/${args.workflowId}`, 'WORKFLOW_RUN_NOT_FOUND');
  }
  const decision = await service.approval.request(agent, {
    action: 'abandon_workflow_run',
    summary:
      `放弃工作流 run ${args.workflowId}(${args.kind}): 删除其 .assistant 下的 run 目录与绑定 checkpoint` +
      '(已应用的创作资产不受影响, 撤销请走 git 历史/版本面)',
    items: [`run 目录: ${runRoot}/${args.workflowId}`],
  });
  if (decision !== 'allowed-once') {
    throw new HarnessError(`放弃 run 未获批准(${decision}), 零清理(fail-closed)`, 'WORKFLOW_ABANDON_REJECTED');
  }
  const removed: string[] = [`${runRoot}/${args.workflowId}`];
  rmSync(runDir, { recursive: true, force: true });
  // 绑定的 deep-import checkpoint: 同一 plan id 才清理(不误删其它 run 的恢复状态)。
  const cp = readCheckpointSummary(root);
  const cpPath = '.assistant/checkpoint.json';
  if (args.kind === 'deep-import' && cp !== undefined && args.workflowId.endsWith(`-${cp.workflow_id}`)) {
    rmSync(join(root, cpPath), { force: true });
    removed.push(cpPath);
  }
  gitAdd(root, removed);
  gitCommit(root, `chore: abandon workflow run ${args.workflowId}(${args.kind})`);
  return { abandoned: removed, commit: 'committed' };
}
