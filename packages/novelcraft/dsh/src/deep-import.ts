// @novelcraft/dsh · runDeepImport 的 DSH 挂载适配 + 文件化 trace sink。
// seam 契约(packages/novelcraft/README.md): 深度导入编排 = 确定性工作流,
// runtime.provider = DshProvider、runtime.approve = ApprovalGate(fail-closed)、
// runtime.trace = ImportTraceSink(落 .assistant/import-trace.jsonl, 文件真相 + git 回滚面)。
// 依据: 设计文档 §15(trace contract)、§9(adopt 必过 approval)、§22.2(session log)。
// 范围/恢复授权(N33 P2 修复; ADR-0022 §8): 授权只在唯一需要点弹一次 ——
//  - 新 run: planImport(confirmed 强制 true)前经 ApprovalGate 请求一次独立全 scope/成本
//    授权(action=authorize_deep_import; 授权将调用 LLM 并产出候选的章节范围);
//  - resume: 授权前**只读识别**既有 immutable run/manifest(hasRun + manifest/batch-plan
//    存在性; 零写、零 intent 收敛)并分类 completed(跳过)/remaining(续跑需 LLM)/
//    outcome-unknown(批次计划已提交、结果未知需重试); 仅对实际 remaining ∪ outcome-unknown
//    批请求一次 authorize_deep_import_resume(范围/剩余成本授权), 不请求全 scope、
//    不重复已完成批次; 该入口授权同批覆盖 provider_outcome_unknown 重试 —— 引擎内
//    reauthorizeRemaining 对入口已授权批不再弹窗(不重复弹两次), 仅对入口分类之外
//    新现的结果未知批才新弹;
//  - canonical apply(adopt commit_scenes / 2b alias_relation)仍为独立审批且
//    allowed-once 不复用(每次等待拿新 decision, 不落盘、不重放, ADR-0022 §7);
//  - 任何授权仅 allowed-once 放行, rejected/cancelled/unavailable 一律 fail-closed
//    (零 provider 调用、零 plan/checkpoint/trace 文件与 canonical 写)。
import path from 'node:path';
import { appendFileSync, lstatSync } from 'node:fs';
import { guardPath, paths } from '@novelcraft/vault';
import * as imports from '@novelcraft/imports';
import { createWorkflowBudget, fingerprintExecutionProfile } from '@novelcraft/llm-step';
import { loadPolicyDefaults } from '@novelcraft/trace';
import { requireTrustedExecutionProfile } from './llm/execution-profile.js';
import type { ApprovalDecision, DeepImportPolicy, TraceEvent, TraceEventInput, TraceSink } from '@novelcraft/trace';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GateDecision } from './approval/gate.js';
import type { ExecutionProfile } from './llm/execution-profile.js';
import type { NovelCraftService } from './service.js';

/**
 * vault 内深度导入 trace 落点(.assistant/import-trace.jsonl, 与 checkpoint/merge-log 同目录)。
 * fail-closed(R9): 先经 vault `guardPath` 做 lexical + real 双层 containment —— 目标条目或
 * 父链经 symlink 解析出 canonical root、或目标是 dangling symlink 一律拒绝; 再拒绝目标条目
 * 本身是 symlink(即使指向 vault 内其他文件)——与 paths() 构造层对 kind 边界文件/目录的
 * symlink 拒绝同一口径(import-trace.jsonl 未纳入 VaultPaths, 故在此单独校验)。否则
 * appendFileSync 会跟随预置 symlink 把 trace 事件写到 vault 外或别的资产, 绕过 guardPath。
 */
export function importTraceFile(root: string): string {
  const file = guardPath(root, path.join(paths(root).assistant.dir, 'import-trace.jsonl'));
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (entry !== undefined && entry.isSymbolicLink()) {
    throw new Error(
      `Path "${file}" is a symlink; refusing to write the import trace through it (fail-closed, R9)`,
    );
  }
  return file;
}

/**
 * 文件化 trace sink: 每个事件补 seq/ts 后追加一行 JSON。
 * 事件进 git 历史(可回滚可审计), 是 §15 trace contract 在 DSH 挂载下的持久化形态。
 * fail-closed(R9): 落点固定为 `<vault>/.assistant/import-trace.jsonl`, 不接受任意路径。
 * 保留旧构造签名 `constructor(file)`(外部既有调用把 `importTraceFile(root)` 结果传入):
 * 从 file 反向推导 root(= 父目录的父目录)再经 `importTraceFile(root)` 全量校验 ——
 * 结构不符(basename/parent)、逃逸/悬空/目标条目 symlink、或解析结果与传入 file 不一致
 * 一律在构造时抛错(首次 record 前即 fail-closed)。
 */
export class ImportTraceSink implements TraceSink {
  private seq = 0;
  readonly file: string;

  constructor(file: string) {
    const resolved = path.resolve(file);
    if (path.basename(resolved) !== 'import-trace.jsonl') {
      throw new Error(
        `ImportTraceSink: 落点必须是 .assistant/import-trace.jsonl, got "${file}"`,
      );
    }
    const parent = path.dirname(resolved);
    if (path.basename(parent) !== '.assistant') {
      throw new Error(
        `ImportTraceSink: 落点必须在 .assistant 目录内, got "${file}"`,
      );
    }
    // 推导 vault root 并全量校验(guardPath real containment + 目标条目 symlink 拒绝)。
    const canonical = importTraceFile(path.dirname(parent));
    if (path.resolve(canonical) !== resolved) {
      throw new Error(
        `ImportTraceSink: 落点 "${file}" 未通过 importTraceFile 校验(resolved "${resolved}")`,
      );
    }
    this.file = canonical;
  }

  record(event: TraceEventInput): TraceEvent {
    const full = { ...event, seq: this.seq++, ts: new Date().toISOString() } as TraceEvent;
    appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }
}

export interface DeepImportOptions {
  startChapter: number;
  endChapter: number;
  /** 分片/批量策略覆盖(缺省 @novelcraft/trace loadPolicyDefaults)。 */
  policy?: DeepImportPolicy;
  /**
   * 强制新 run(M10-B1/B2/N40): 不复用同 scope 旧 run —— uniqueRunId 附加时间戳段,
   * classification 恒为 new(全 scope 授权)。completed run 的结果重放从此成为
   * 作者显式选择(workflow_start_new), 不再隐式发生。
   */
  force?: boolean;
}

/**
 * 深度导入范围授权未获批准(铁律 3 fail-closed; R40 修复)。
 * 与 GateDeniedError 的区别: 本错误特指 planImport 前的 authorize_deep_import
 * 独立范围授权被拒/取消/不可用 —— 此时未发起任何 provider 调用或文件写入。
 */
export class DeepImportDeniedError extends Error {
  readonly decision: GateDecision;
  constructor(decision: GateDecision, message: string) {
    super(message);
    this.name = 'DeepImportDeniedError';
    this.decision = decision;
  }
}

/** 范围授权 items: ≤50 章逐章一条(作者语言: 「第 N 章」), 更大范围给单条范围(避免超长清单)。 */
function scopeAuthorizationItems(startChapter: number, endChapter: number): string[] {
  const count = endChapter - startChapter + 1;
  if (count <= 50) {
    const items: string[] = [];
    for (let ch = startChapter; ch <= endChapter; ch++) items.push(`第 ${ch} 章`);
    return items;
  }
  return [`第 ${startChapter}-${endChapter} 章(共 ${count} 章)`];
}

/**
 * 范围预校验: 整数且 1 ≤ start ≤ end。非法范围(倒序/非整数/<1)直接抛错、不弹范围授权
 * —— 避免 scopeAuthorizationItems/摘要对倒序或非整数生成误导性审批内容(R40 语义: 授权范围
 * 必须是合法章节区间); 与 planImport 的「章节范围非法」校验同一口径, 但前置到审批之前。
 */
function assertImportRange(startChapter: number, endChapter: number): void {
  if (
    !Number.isInteger(startChapter) ||
    !Number.isInteger(endChapter) ||
    startChapter < 1 ||
    endChapter < startChapter
  ) {
    throw new Error(
      `章节范围非法: 1 ≤ start ≤ end 且须为整数(实际 start=${startChapter}, end=${endChapter})`,
    );
  }
}

/** GateDecision → ApprovalDecision 映射: cancelled 视同拒绝(fail-closed)。 */
function toApprovalDecision(decision: string): ApprovalDecision {
  if (decision === 'allowed-once') return 'allowed-once';
  if (decision === 'unavailable') return 'unavailable';
  return 'rejected'; // rejected / cancelled 一律拒绝
}

// —— N33 P2: 只读识别既有 immutable run/manifest 与 remaining/outcome-unknown 分类 ——

interface RemainingBatchRef {
  readonly batchId: string;
  readonly phase: string;
}

/** 授权前的只读分类(零写、零 intent 收敛): 决定新 run 请求全 scope 还是 resume 只请求剩余范围/成本。 */
type ExistingRunClassification =
  | { readonly kind: 'new' }
  | {
      readonly kind: 'resume';
      readonly workflowId: string;
      readonly completed: number;
      /** 续跑批次(计划未提交): 需 LLM, 属实际剩余。 */
      readonly pending: readonly RemainingBatchRef[];
      /** provider_outcome_unknown 批次(计划已提交、无 artifact): 需 LLM 重试授权。 */
      readonly outcomeUnknown: readonly RemainingBatchRef[];
    };

/**
 * 授权前对既有 run/manifest 做**只读**识别与分类(N33 P2 / ADR-0022 §2/§8):
 * - `GitRunPersistence.hasRun` 判定是否存在不可变 run(读 HEAD/工作树/intent 存在性, 零写);
 * - 存在则以 manifest(工作树)+ 每批 batch-plan 存在性区分 completed(跳过)/
 *   remaining(计划未提交, 续跑需 LLM)/outcome-unknown(计划已提交、无 artifact, 重试需授权);
 * - run 存在但 manifest 不可读(bootstrap intent 未提交, 尚无任何完成批)→ 全部视作剩余
 *   需 LLM(安全上界; 若实为损坏, run 引擎仍 fail-closed, 不会调用 provider);
 * - 不收敛 durable intent、不写任何文件 —— 与 runDeepImportWorkflow 入口的 intent 收敛
 *   严格解耦。
 */
async function classifyExistingRun(
  root: string,
  workflowId: string,
  spec: imports.RunEngineSpec,
  inputFingerprint: string,
): Promise<ExistingRunClassification> {
  const persistence = new imports.GitRunPersistence(root);
  if (!(await persistence.hasRun(workflowId))) return { kind: 'new' };
  // 确定性批次布局(与 driver buildDriverContext 同源: makeBatchPlan + batchPaths, 零写)。
  const infoByBatch: Record<string, RemainingBatchRef & { planPath: string }> = {};
  for (const batch of spec.batches) {
    const plan = imports.makeBatchPlan({
      workflowId,
      phase: batch.phase,
      ordinal: batch.ordinal,
      inputFingerprint,
      sourceIds: batch.sourceIds,
      sourceHashes: batch.sourceHashes,
    });
    infoByBatch[plan.batchId] = {
      batchId: plan.batchId,
      phase: batch.phase,
      planPath: imports.batchPaths('deep-import', plan).planPath,
    };
  }
  const manifestPath = `${imports.workflowRunRoot('deep-import', workflowId)}/manifest.json`;
  const manifestBytes = await persistence.readBytes(manifestPath);
  if (manifestBytes === undefined) {
    return {
      kind: 'resume',
      workflowId,
      completed: 0,
      pending: Object.values(infoByBatch).map(({ batchId, phase }) => ({ batchId, phase })),
      outcomeUnknown: [],
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    throw new Error(`N33 P2: 既有 run ${workflowId} manifest 无法解析, 拒绝授权续跑(fail-closed)`);
  }
  const manifestDoc = manifest as { status?: string; batches?: Record<string, { state?: string }> };
  const batches = manifestDoc.batches ?? {};
  const pending: RemainingBatchRef[] = [];
  const outcomeUnknown: RemainingBatchRef[] = [];
  let completed = 0;
  let statusUnknownAssigned = false;
  for (const info of Object.values(infoByBatch)) {
    const state = batches[info.batchId]?.state;
    if (state === 'completed' || state === 'artifact_committed') {
      completed += 1; // artifact_committed 仅需确定性补 cursor，不需 LLM 授权
      continue;
    }
    const planCommitted = (await persistence.readBytes(info.planPath)) !== undefined;
    // provider_outcome_unknown 是引擎对「首个未完成批计划已提交、结果未知」的持久
    // 状态；即使只读 plan 探测因旧现场/缓存不可见，也必须把首个未完成批归入重试授权。
    const statusMarksUnknown = manifestDoc.status === 'provider_outcome_unknown' && !statusUnknownAssigned;
    if (planCommitted || statusMarksUnknown) {
      outcomeUnknown.push({ batchId: info.batchId, phase: info.phase });
      statusUnknownAssigned = true;
    } else {
      pending.push({ batchId: info.batchId, phase: info.phase });
    }
  }
  return { kind: 'resume', workflowId, completed, pending, outcomeUnknown };
}

/**
 * 深度导入 DSH 挂载(N33/ADR-0022 durable driver): 组装 runDeepImportWorkflow 的
 * 运行时并执行六阶段 —— 生产执行面 = runWorkflow + GitRunPersistence。
 * - 范围预校验(整数 1 ≤ start ≤ end)先于任何审批: 非法范围直接抛, 不弹审批;
 * - N33 P2: 授权前先**只读识别**既有 immutable run/manifest(hasRun + manifest/batch-plan
 *   存在性, 零写、零 intent 收敛)并分类 completed(跳过)/remaining(续跑需 LLM)/
 *   outcome-unknown(结果未知需重试):
 *   - 新 run → authorize_deep_import 全 scope/成本授权(R40 授权快照, confirmed 强制);
 *   - resume → authorize_deep_import_resume 仅对实际 remaining ∪ outcome-unknown 批
 *     请求范围/剩余成本授权(ADR-0022 §8), 不请求全 scope、不重复已完成批次;
 *   - resume 且无剩余需要 LLM(全部 completed)→ 不请求任何范围/成本授权;
 * - provider_outcome_unknown 批(§5.0/§8)不自动重试: 入口 resume 授权同批覆盖其重试 ——
 *   引擎内 reauthorizeRemaining 对已授权批不再弹窗(不重复弹两次), 仅对入口分类之外
 *   新现的结果未知批才新弹 authorize_deep_import_resume; 已完成批不重跑;
 * - canonical apply(commit_scenes / alias_relation)仍为独立审批, allowed-once 不复用
 *   (ADR-0022 §7; 每次等待拿新 decision, 不落盘不重放, 已写 apply 不重复审批);
 * - trace 事件落 .assistant/import-trace.jsonl(§15 trace contract)。
 * - signal(工具取消)贯通: 范围/恢复授权请求 + runtime.approve(Scene commit/2b 别名关系)
 *   + reauthorizeRemaining(恢复重新授权)与 contentProviderFor(provider 与每步
 *   timeout 合并)各处均携工具取消信号。
 * - ExecutionProfile(N34/ADR-0023 §6): 编排启动解析一次不可变执行画像(fail-closed:
 *   非法 preset/timeout/budget 在此抛, 先于范围授权/provider 调用/任何文件写 ——
 *   零副作用, 不带半解析配置跑); 内部统一继承, 请求级 override 优先。
 *   审查项 3: workflowBudget 按 profile 建一次共享累计 tracker 传入
 *   runDeepImportWorkflow(全链阶段共享消费, 超支在 provider 前 fail-closed;
 *   现有 RunStep budget API)。
 * - 审查项 1: profile 参数 brand 校验(requireTrustedExecutionProfile, opaque provenance
 *   仅 resolver 产出; 普通对象即使字段合法也 INVALID_PROFILE fail-closed, 不得绕过
 *   root 解析);
 *   P5/N33: profile 指纹 + contract versions 强制传入 durable driver —— 指纹进
 *   workflow identity(执行画像变化拒绝续跑); 契约版本折叠进 inputFingerprint
 *   (契约变化 → 新 workflow, 不沿用旧 run)。manifest/fingerprint 不含任何 secret
 *   (铁律 6 / run-model R2: secret 形字段一律 fail-closed)。
 */
export async function deepImport(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  opts: DeepImportOptions,
  signal?: AbortSignal,
  profile?: ExecutionProfile,
): Promise<imports.DeepImportResult> {
  // 范围预校验: 非法范围(倒序/非整数/<1)直接抛错, 不弹范围授权(零审批零副作用)。
  assertImportRange(opts.startChapter, opts.endChapter);
  // P5/R6: 先注册 deep import 内容步 spec(幂等, 模块级注册表), 再以固定 ref 集解析
  // ExecutionProfile —— contractVersions 从 spec registry 按 DEEP_IMPORT_SPEC_REFS
  // 构造(确定性, 不随进程内其他包级 spec 注册状态漂移), 指纹因此可复现。
  imports.registerImportSpecs();
  // N34 §6: 编排启动解析一次不可变 ExecutionProfile; 解析失败(非法 preset/timeout/
  // budget)→ 编排启动失败(fail-closed), 先于范围授权请求与任何 provider/文件写。
  // profile 已传入(入口解析一次、内部透传)则经 opaque brand 验证(审查项 1: 普通对象
  // 不得伪造/跳过 root 解析, INVALID_PROFILE fail-closed)。
  const resolved =
    profile !== undefined
      ? requireTrustedExecutionProfile(profile, root, { specRefs: imports.DEEP_IMPORT_SPEC_REFS })
      : await service.resolveProfile(root, { specRefs: imports.DEEP_IMPORT_SPEC_REFS });

  // N33 P2: 授权前先只读构造确定性 plan/spec/identity 并识别既有 immutable run ——
  // 全部纯函数(createImportPlan / deepImportInputFingerprint / buildDeepImportWorkflowSpec /
  // createWorkflowIdentity / planDigestOf)与只读判定(hasRun + manifest/batch-plan 存在性),
  // 零写、零 intent 收敛, 与 runDeepImportWorkflow 内部推导严格同源(同一输入恒同 workflowId)。
  const plan = imports.createImportPlan({
    startChapter: opts.startChapter,
    endChapter: opts.endChapter,
    confirmed: true, // R40 授权快照: 范围/恢复授权放行后 confirmed 强制 true
  }, new Date(), opts.force
    // force: unique 段附加时间戳 → 不同 workflowId → hasRun=false → 全 scope 新授权。
    ? `imp-${opts.startChapter}-${opts.endChapter}-f${Date.now().toString(36)}`
    : `imp-${opts.startChapter}-${opts.endChapter}`);
  const profileFingerprint = fingerprintExecutionProfile(resolved);
  const contractVersions = resolved.contractVersions ?? {};
  const inputFingerprint = imports.deepImportInputFingerprint(root, plan, loadPolicyDefaults(opts.policy), contractVersions);
  const spec = imports.buildDeepImportWorkflowSpec(root, plan, { inputFingerprint, profileFingerprint });
  const workflowId = imports.createWorkflowIdentity({
    kind: 'deep-import',
    inputFingerprint,
    profileFingerprint,
    planDigest: imports.planDigestOf(spec),
    uniqueRunId: plan.workflow_id,
  }).workflowId;
  const classification = await classifyExistingRun(root, workflowId, spec, inputFingerprint);

  // 授权(每次进入只弹需要的那一次; N33 P2):
  //  - 新 run → authorize_deep_import 全 scope/成本授权;
  //  - resume → authorize_deep_import_resume(范围/剩余成本)仅覆盖实际 needsLLM 批;
  //  - resume 且全部已完成 → 不请求任何范围/成本授权(ADR-0022 §8)。
  let resumeAuthorized: ReadonlySet<string> | undefined;
  if (classification.kind === 'new') {
    const decision = await service.approval.request(agent, {
      action: 'authorize_deep_import',
      summary:
        `深度导入第 ${opts.startChapter}-${opts.endChapter} 章: ` +
        '将调用 LLM 切分/补全/融合章节并产出 Scene/实体/别名/结构候选(Scene 采用与 2b 别名写入将另行审批)',
      items: scopeAuthorizationItems(opts.startChapter, opts.endChapter),
      ...(signal ? { signal } : {}),
    });
    if (decision !== 'allowed-once') {
      // fail-closed: rejected/cancelled/unavailable 一律拒绝 —— 零 provider 调用、
      // 零 plan/checkpoint/trace 文件与 canonical 写(工具层映射宿主 HarnessError 通道)。
      throw new DeepImportDeniedError(
        decision,
        `深度导入第 ${opts.startChapter}-${opts.endChapter} 章未获范围授权(决策: ${decision}); 未发起任何 LLM 调用或文件写入`,
      );
    }
  } else {
    const needsLlm = [...classification.pending, ...classification.outcomeUnknown];
    if (needsLlm.length > 0) {
      const items = [
        ...classification.pending.map((b) => `阶段 ${b.phase}(${b.batchId})`),
        ...classification.outcomeUnknown.map((b) => `阶段 ${b.phase}(${b.batchId}) · 结果未知, 重试将重新调用 LLM`),
      ];
      const decision = await service.approval.request(agent, {
        action: 'authorize_deep_import_resume',
        summary:
          `恢复深度导入 ${classification.workflowId}: 已完成 ${classification.completed} 批; ` +
          `剩余 ${classification.pending.length} 批续跑 + ${classification.outcomeUnknown.length} 批结果未知需重试 ` +
          `(${needsLlm.map((b) => b.phase).join('/')}); ` +
          '将继续调用 LLM 并产生剩余成本; 已完成批次不会重复执行。',
        items,
        ...(signal ? { signal } : {}),
      });
      if (decision !== 'allowed-once') {
        // fail-closed: 与全 scope 拒绝同一口径 —— 零 provider 调用、零文件写。
        throw new DeepImportDeniedError(
          decision,
          `恢复深度导入 ${classification.workflowId} 未获剩余范围/成本授权(决策: ${decision}); 未发起任何 LLM 调用或文件写入`,
        );
      }
      resumeAuthorized = new Set(needsLlm.map((b) => b.batchId));
    }
    // 全部已完成(或仅剩无需 LLM 的收尾批): 不请求范围/成本授权 —— canonical apply
    // 终态收尾如需要仍走下方独立 apply 审批(允许新审批, 旧 decision 不复用)。
  }

  // R9: 范围/恢复授权放行后、任何文件写前先构造 trace sink —— importTraceFile
  // fail-closed 校验落点(预置 symlink 逃逸/悬空/目标条目 symlink 在此即抛错), 保证
  // 拒绝发生时零 plan/checkpoint/trace 文件与 canonical 写(外部哨兵不被追加/创建)。
  // Validate the durable trace target now, but do not append: the imports driver buffers
  // events and commits trace+checkpoint atomically through ADR-0021.
  importTraceFile(root);
  // 审查项 3: workflowBudget 真实由 DSH 工作流继承 —— 按 ExecutionProfile.workflowBudget
  // 创建一次共享累计 tracker(runDeepImportWorkflow 全链阶段共享, 现有 RunStep budget
  // API), 超支在 provider 前 fail-closed; profile 未设 workflowBudget → 不传, 行为不变。
  const workflowBudget =
    resolved.workflowBudget !== undefined
      ? createWorkflowBudget(resolved.workflowBudget)
      : undefined;
  return imports.runDeepImportWorkflow(root, plan, {
    // 内容手经该书执行画像面(N20 + N34): llm.yml preset/直键注入 provider/model/参数默认;
    // profile 已在入口解析一次并透传(contentProviderFor 不再重解析);
    // signal(工具取消)经 contentProviderFor 贯通(与每步 timeout 合并, withAbortSignal)。
    provider: await service.contentProviderFor(root, signal, resolved),
    // P5/N33: 执行画像指纹 + 契约版本强制接入 workflow identity —— begin_import 事件
    // 携带; 指纹进 manifest(执行画像变化拒绝续跑), 契约版本折叠进 inputFingerprint
    // (契约变化 → 新 workflow, 不沿用旧 run); 均不含 secret(fail-closed)。
    profileFingerprint,
    contractVersions,
    ...(workflowBudget !== undefined ? { budget: workflowBudget } : {}),
    approve: async (action, summary, items) => {
      // 工具取消贯通: Scene/2b 等后续审批等待也可经 signal 取消(fail-closed 语义不变)。
      const decision = await service.approval.request(agent, {
        action,
        summary,
        items,
        ...(signal ? { signal } : {}),
      });
      return toApprovalDecision(decision);
    },
    // N33 §5.0/§8: provider_outcome_unknown 批重试前必须经范围/成本授权(ApprovalGate),
    // 绝不裸 boolean 自动重试。N33 P2: 本次入口的 resume 授权已同批覆盖这些批次 ——
    // 对已授权批直接放行、不重复弹窗(不重复弹两次); 仅对入口分类之外新现的结果未知
    // 批(authorize_deep_import_resume)才新弹。
    reauthorizeRemaining: async ({ workflowId, batches, estimate }) => {
      let toAuthorize = batches;
      if (resumeAuthorized !== undefined) {
        const uncovered = batches.filter((b) => !resumeAuthorized.has(b.batchId));
        if (uncovered.length === 0) {
          return 'allowed-once'; // 入口 resume 授权已覆盖, 同批不重复弹窗
        }
        toAuthorize = uncovered;
      }
      const decision = await service.approval.request(agent, {
        action: 'authorize_deep_import_resume',
        summary: `恢复深度导入 ${workflowId}: ${estimate}。这些批次的结果未知(可能已消耗一次 LLM 调用), 重新授权后才能重试; 已完成批次不会重复执行。`,
        items: toAuthorize.map((b) => `阶段 ${b.phase}(${b.batchId})`),
        ...(signal ? { signal } : {}),
      });
      return toApprovalDecision(decision);
    },
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}
