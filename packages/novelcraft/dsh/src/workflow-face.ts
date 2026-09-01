// @novelcraft/dsh · 长任务恢复面(M10-B1/N40, §6.9/§6.6 作者闭环; Track B review 修复)。
// workflowInspect: 只读枚举 durable manifest run(imports.listWorkflowRuns 两个 namespace)
//   + checkpoint 概要;
// workflowResumeGuarded: 前置三重校验(枚举存在性 / 非 force run / checkpoint 绑定)→
//   复用 deepImport 续跑路径(classification=resume 时授权只请求剩余范围/成本, N33 P2)
//   → 执行后对账(实际续跑 workflow_id 必须等于请求 id, 漂移即 fail-closed);
// workflowStartNewGuarded: force 新 workflowId(时间戳+随机熵段)+ 全 scope 授权 ——
//   completed run 的重放有了显式选择路径;
// workflowAbandonGuarded: id 单段校验 + 枚举存在性(防路径穿越, Track B review P0)
//   + 终态限制 + 审批(摘要明示 durable intent 孤儿风险)→ 清理 run 目录(+绑定
//   checkpoint)→ R17 门禁(hasStagedOutside, 只挡预存 staged)→ 精确 git 提交(返回 HEAD sha);
//   不触碰 canonical 创作资产(铁律 2: git 本身是回滚面, 资产撤销走 git revert/版本面)。
// 纪律: 本文件不直接写 canonical; abandon 的 git 写只用 store 的精确 pathspec
// (gitAdd/gitCommit), 与 check-git-writers 允许表一致。
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitAdd, gitCommit, hasStagedOutside } from '@novelcraft/store';
import { assertSafePathSegment, guardPath } from '@novelcraft/vault';
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
  let cpPath: string;
  try {
    cpPath = guardPath(root, join(root, '.assistant', 'checkpoint.json'));
    const stat = lstatSync(cpPath, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
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

/** 只读枚举: durable manifest runs + checkpoint 概要(零写、零审批)。 */
export function workflowInspect(root: string): {
  runs: imports.ListedWorkflowRun[];
  checkpoint?: WorkflowCheckpointSummary;
} {
  const runs = imports.listWorkflowRuns(root);
  const checkpoint = readCheckpointSummary(root);
  return { runs, ...(checkpoint !== undefined ? { checkpoint } : {}) };
}

/** 枚举存在性校验: 请求的 run 必须在 listWorkflowRuns 结果中(fail-closed, 同时是
 *  最强防穿越 —— 任意 id 先过枚举关, 穿越串/不存在 id 一律零审批拒绝)。 */
function requireListedRun(root: string, kind: 'deep-import' | 'map-atlas', workflowId: string): imports.ListedWorkflowRun {
  // 单段校验先行(与 vault 动态 runId 同口径): 拒绝 /、\、.、..、空串等;
  // vault 抛普通 Error, 统一转稳定 code(工具层透传)。
  try {
    assertSafePathSegment(workflowId, 'workflow_id');
  } catch (err) {
    throw new HarnessError(
      `workflow_id 非法(必须是单一路径段): ${(err as Error).message}`,
      'WORKFLOW_RUN_NOT_FOUND',
    );
  }
  const listed = imports.listWorkflowRuns(root).find((r) => r.kind === kind && r.workflow_id === workflowId);
  if (listed === undefined) {
    throw new HarnessError(
      `run 不在枚举结果中: ${kind}/${workflowId}(不存在或路径非法, fail-closed)。请先 workflow_inspect 确认`,
      'WORKFLOW_RUN_NOT_FOUND',
    );
  }
  return listed;
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
  // 前置三重校验(Track B review P1-3): 枚举存在性 → force run 不可 resume(identity
  // 含随机熵, 重跑恒新 run, 与"中断后可再次 resume"矛盾)→ checkpoint 绑定。
  const listed = requireListedRun(root, 'deep-import', workflowId);
  if (/-f[0-9a-z]{6,}$/.test(workflowId)) {
    throw new HarnessError(
      `run ${workflowId} 是 workflow_start_new 创建的强制新 run(identity 含随机段, 无法按 checkpoint 绑定续跑)。` +
        '如需重跑该范围请再次 workflow_start_new',
      'WORKFLOW_RESUME_INVALID',
    );
  }
  void listed;
  const scope = requireDeepImportScope(root, workflowId);
  // 同 scope 复用 deepImport: classification=resume → authorize_deep_import_resume 只请求
  // 剩余范围/成本(completed 批次跳过; provider_outcome_unknown 批次重试授权, N33 §5.0/§8)。
  const result = await deepImport(service, agent, root, scope, signal);
  // 执行后对账(P1-3): 实际续跑的 workflow_id 必须等于请求 id —— 输入/执行画像/policy
  // 变化会派生出不同 identity(静默变新 run), 对账失败即显式报错并指引, 不冒充续跑成功。
  if (result.workflow_id !== workflowId) {
    throw new HarnessError(
      `resume 对账失败: 请求恢复 ${workflowId}, 实际执行 ${result.workflow_id}(输入/执行画像/策略已变化, identity 漂移)。` +
        '请用 workflow_start_new 在当前配置下显式重新授权导入',
      'WORKFLOW_RESUME_DRIFTED',
    );
  }
  return result;
}

/** 显式新 run(force): 不复用同 scope 旧 run, 全 scope 授权(identity 恒新)。 */
export async function workflowStartNewGuarded(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  opts: DeepImportOptions,
  signal?: AbortSignal,
): Promise<imports.DeepImportResult> {
  return deepImport(service, agent, root, { ...opts, force: true }, signal);
}

/** abandon 允许的终态(corrupt/unreadable 一并允许 —— 清理损坏状态也是合法场景)。 */
const ABANDONABLE_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'failed', 'provider_outcome_unknown', 'unreadable', 'unknown',
]);

/** 放弃 run: 审批通过后清理 run 目录(+绑定 checkpoint), 精确 git 提交; 不动 canonical 资产。 */
export async function workflowAbandonGuarded(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  args: { kind: 'deep-import' | 'map-atlas'; workflowId: string },
  signal?: AbortSignal,
): Promise<{ abandoned: string[]; commit: string }> {
  // P0(review): 枚举存在性 + 单段校验 —— 路径穿越串与不存在 id 一律零审批拒绝,
  // rmSync 的目标永远限于枚举确认过的 run 目录。
  const listed = requireListedRun(root, args.kind, args.workflowId);
  if (!ABANDONABLE_STATUSES.has(listed.status)) {
    throw new HarnessError(
      `run ${args.workflowId} 状态为 ${listed.status}(进行中), 不允许直接放弃。` +
        '请先 workflow_resume 完成/失败后再清理, 避免制造不可对账现场',
      'WORKFLOW_ABANDON_NOT_TERMINAL',
    );
  }
  const runRoot = args.kind === 'deep-import' ? '.assistant/import-runs' : '.assistant/atlas/runs';
  const runDir = join(root, runRoot, args.workflowId);
  // 绑定的 deep-import checkpoint 预判(同一 plan id 才清理, 不误删其它 run 的恢复状态)。
  const cp = readCheckpointSummary(root);
  const cpBound = args.kind === 'deep-import' && cp !== undefined && args.workflowId.endsWith(`-${cp.workflow_id}`);
  const removed: string[] = [`${runRoot}/${args.workflowId}`];
  if (cpBound) removed.push('.assistant/checkpoint.json');
  // R17 门禁(review P1-2/N41): 预存 staged 外部内容会被裸 git commit 卷入 ——
  // 只挡 index 预存 staged(untracked/unstaged 不被精确 pathspec 卷入, 不拒绝)。
  // 豁免集用目录前缀(尾 /): run 目录内部文件的 staged 残留(事务崩溃窗口)不挡
  // 自己的清理目标(Track C review P2-1); gitAdd 仍用原精确集合。
  const gateExempt = removed.map((r) => (r.endsWith('.json') ? r : `${r}/`));
  if (hasStagedOutside(root, gateExempt)) {
    throw new HarnessError(
      '工作区存在范围外未提交改动(含预存 staged), 拒绝 abandon 提交以免卷入外部内容(DIRTY_WORKSPACE, R17)',
      'WORKFLOW_DIRTY_WORKSPACE',
    );
  }
  const decision = await service.approval.request(agent, {
    action: 'abandon_workflow_run',
    summary:
      `放弃工作流 run ${args.workflowId}(${args.kind}, 状态 ${listed.status}): 删除其 .assistant 下的 run 目录` +
      (cpBound ? '与绑定 checkpoint' : '') +
      '(已应用的创作资产不受影响, 撤销请走 git 历史/版本面)。注意: 若该 run 存在未收敛的 durable ' +
      'intent(崩溃残留), abandon 后需人工修复才能再对同范围操作',
    items: [`run 目录: ${runRoot}/${args.workflowId}`],
    ...(signal ? { signal } : {}),
  });
  if (decision !== 'allowed-once') {
    throw new HarnessError(`放弃 run 未获批准(${decision}), 零清理(fail-closed)`, 'WORKFLOW_ABANDON_REJECTED');
  }
  rmSync(runDir, { recursive: true, force: true });
  if (cpBound) rmSync(join(root, '.assistant', 'checkpoint.json'), { force: true });
  gitAdd(root, removed);
  const commit = gitCommit(root, `chore: abandon workflow run ${args.workflowId}(${args.kind})`);
  return { abandoned: removed, commit };
}
