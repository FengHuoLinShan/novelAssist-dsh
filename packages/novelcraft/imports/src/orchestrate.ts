// imports · 确定性编排 seam runDeepImport(设计文档 §15「Trace contract」+ PLAN.md §形态决策)。
// 纯 TS 顺序串起六阶段: begin_import → slice(1a) → enrich(1b) → fuse(1c) →
// commit(adopt 经审批门)→ entities(2a) → alias_relation(2b, 独立审批门)→ structure(3) → complete_import。
// - adopt(Scene commit)必过 runtime.approve, 拒绝/不可用 = fail-closed(§9 / ApprovalGate), 不 commit;
// - Phase 2b 首次改写 canonical 对象(aliases/candidate relations)前单独 runtime.approve,
//   不复用 Scene 授权(铁律 3 采用类写入); 拒绝/不可用 = 跳过 2b 不写 canonical,
//   Scene 已采用不判整体 rejected;
// - 每阶段后写 checkpoint 并 emit checkpoint(R42/R43 幂等续跑按 input_fingerprint);
// - 正常完成(rejected 早退与 complete 闭环)在最后 checkpoint/complete trace 写完后,
//   精确 stage 本流程工件(checkpoint/trace)做恰一次 audit/state commit(前置 R17 门禁:
//   范围外任何改动含预存 staged 一律 fail-closed, 不 -A、不捕获其他文件、均无变化不 commit)
//   —— checkpoint/trace 进 git 历史, 深导后工作区不残留脏;
// - 异常路径不自动 state commit(中断流程保持可见状态, checkpoint 供 resume, fail-closed);
// - 分片按 policy 批量(policy-defaults.md §4: 1a 50 / 2a 12 / 2b 4);
// - provider 失败触发对应降级事件(R52–R55);
// - runtime.trace 为可注入 sink(测试注入 TraceRecorder; 缺省也落 TraceRecorder 供检查)。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoSymlinkOnPath, guardPath } from "@novelcraft/vault";
import { DEGRADATION_CLAUSE, TraceRecorder, loadPolicyDefaults } from "@novelcraft/trace";
import type { ApprovalDecision, DeepImportPolicy, TraceEventInput, TraceSink } from "@novelcraft/trace";
import type { Provider, ProviderRequest, WorkflowBudget } from "@novelcraft/llm-step";
import type { CheckpointState, ImportPlan } from "./plan.js";
import { readCheckpoint, writeCheckpoint } from "./plan.js";
import type { SceneCandidate } from "./stages.js";
import { enrichSceneBatch, fuseSceneBatch, sliceChapterBatch } from "./stages.js";
import { commitScenesTx } from "./commit.js";
import { extractEntityBatch } from "./entities.js";
import { applyAliasRelationChangesTx, planAliasRelationChanges, proposeAliasRelations } from "./alias-relation.js";
import type { AliasRelationProposal } from "./alias-relation.js";
import { analyzeStructureWithSources, StructureContextError, type StructureContextReceipt, type StructureSourceFile } from "./structure.js";
import { commitImportState } from "./workspace.js";

/** runDeepImport 的可注入运行时(provider/审批/trace sink/策略)。 */
export interface DeepImportRuntime {
  provider: Provider;
  /** 审批决策(DSH 挂载接 ApprovalGate; 测试用 MockApproval)。 */
  approve: (action: string, summary: string, items: string[]) => Promise<ApprovalDecision>;
  /** 可选 trace sink(测试注入 TraceRecorder)。 */
  trace?: TraceSink;
  /** 分片/批量策略(缺省 loadPolicyDefaults())。 */
  policy?: DeepImportPolicy;
  /**
   * 执行画像指纹(N34/ADR-0023 §6 + 独立审查 P5, 加法): 编排启动解析一次的
   * ExecutionProfile 的 sha256 指纹。begin_import/checkpoint 携带;
   * 与既有 checkpoint 指纹不一致 → 拒绝旧 run(fail-closed, 不沿用旧 checkpoint 续跑)。
   */
  profileFingerprint?: string;
  /** 契约版本集(P5/R6, 加法): 从 spec registry 构造, 随 begin_import/checkpoint 记录。 */
  contractVersions?: Record<string, string>;
  /**
   * 工作流累计预算 tracker(审查项 3, 加法): 编排启动时按 ExecutionProfile.workflowBudget
   * 创建一次(createWorkflowBudget), 全链阶段函数共享同一 tracker —— 逐 runStep 按
   * 「估算输入 + 输出上限」消费, 超支在 provider 前 fail-closed(现有 RunStep budget API);
   * 缺省 = 无工作流级预算(行为不变)。
   */
  budget?: WorkflowBudget;
}

export interface DeepImportResult {
  workflow_id: string;
  input_fingerprint: string;
  committed: string[];
  skipped: string[];
  conflicts: string[];
  adopted: number;
  rejected: boolean;
  rejection_decision?: "rejected" | "unavailable";
  entities: { created: string[]; reused: Array<{ name: string; target: string }>; uncertain: number };
  aliases: {
    attached: number;
    skipped: number;
    relations: number;
    uncertain: number;
    /** Phase 2b 写面是否经独立审批放行(allowed-once); false = 跳过/拒绝, 未写 canonical。
     *  optional 仅保外部构造/Mock 兼容(核心接口只做加法); runDeepImport 返回时总是赋值。 */
    approved?: boolean;
    /** Phase 2b 独立审批决策(请求过才出现): allowed-once/rejected/unavailable。 */
    decision?: ApprovalDecision;
  };
  structure: {
    threads: number;
    arcs: number;
    foreshadowing: number;
    reveals: number;
    low_confidence: number;
    /** 新安全入口才出现；旧消费者字段保持不变。 */
    context?: StructureContextReceipt;
  };
  /** 本次运行的 trace sink(runtime.trace ?? 新建 TraceRecorder)。 */
  trace: TraceSink;
}

function emit(sink: TraceSink, event: TraceEventInput): void {
  sink.record(event);
}

function emitCheckpoint(sink: TraceSink, phase: string, fingerprint: string): void {
  emit(sink, { type: "checkpoint", phase, input_fingerprint: fingerprint, done: true });
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function readExplicitFiles(root: string, prefix: string, slugs: readonly string[]): StructureSourceFile[] {
  return slugs.map((slug) => {
    const relativePath = `${prefix}/${slug}.md`;
    const file = guardPath(root, path.join(root, relativePath));
    assertNoSymlinkOnPath(root, file);
    if (!existsSync(file)) throw new StructureContextError("SOURCE_MISSING", `结构来源缺失: ${relativePath}`);
    if (!lstatSync(file).isFile()) throw new StructureContextError("INVALID_SOURCE", `结构来源不是普通文件: ${relativePath}`);
    return { relativePath, bytes: readFileSync(file, "utf8") };
  });
}

/** R42: input_fingerprint = sha256(授权 scope + 阶段步骤), 同 scope 幂等续跑基准。 */
function inputFingerprint(plan: ImportPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ scope: plan.authorization.scope, steps: plan.steps }))
    .digest("hex");
}

/** 包一层 provider: 每次 complete 调用 emit llm_step 事件(记录 provider 调用与失败)。
 *  P2 修复: 转发 executionDefaults(llm-step 加法) —— 裸 runStep 经 provider 继承
 *  执行画像默认(timeout/maxTokens/temperature/model), trace 包装不得剥掉该 seam。 */
function tracedProvider(provider: Provider, sink: TraceSink): Provider {
  const wrapped: Provider = {
    ...(provider.executionDefaults !== undefined
      ? { executionDefaults: provider.executionDefaults }
      : {}),
    async complete(req: ProviderRequest) {
      try {
        const resp = await provider.complete(req);
        emit(sink, {
          type: "llm_step",
          ok: true,
          model: req.model,
          ...(req.promptHash !== undefined ? { promptHash: req.promptHash } : {}),
          ...(req.schemaInjection !== undefined ? { schemaInjection: req.schemaInjection } : {}),
        });
        return resp;
      } catch (err) {
        emit(sink, { type: "llm_step", ok: false, error: String((err as Error)?.message ?? err), model: req.model, ...(req.promptHash !== undefined ? { promptHash: req.promptHash } : {}), ...(req.schemaInjection !== undefined ? { schemaInjection: req.schemaInjection } : {}) });
        throw err;
      }
    },
  };
  return wrapped;
}

/**
 * 深度导入六阶段确定性编排(设计 §15 trace contract 主战场)。
 * 顺序串起阶段函数; 不并行 fan-out(留 DSH 挂载阶段), 但分片尺寸已按 policy 切好。
 */
/** checkpoint 状态组装: phase_results + 执行画像指纹/契约版本(P5; 与 begin_import 同源)。 */
function checkpointState(
  plan: ImportPlan,
  phaseResults: Record<string, unknown>,
  runtime: DeepImportRuntime,
  fingerprint: string,
): CheckpointState {
  return {
    plan,
    phase_results: { ...phaseResults, input_fingerprint: fingerprint },
    ...(runtime.profileFingerprint !== undefined ? { profile_fingerprint: runtime.profileFingerprint } : {}),
    ...(runtime.contractVersions !== undefined ? { contract_versions: runtime.contractVersions } : {}),
  };
}

export async function runDeepImport(
  root: string,
  plan: ImportPlan,
  runtime: DeepImportRuntime,
): Promise<DeepImportResult> {
  // R40: authorization_confirmed 强制 true(授权快照 fail-closed)
  if (plan.authorization.authorization_confirmed !== true) {
    throw new Error("authorization_confirmed 必须为 true(授权快照强制, R40)");
  }
  if (plan.end_chapter < plan.start_chapter || plan.start_chapter < 1) {
    throw new Error("章节范围非法: 1 ≤ start ≤ end");
  }

  const policy = loadPolicyDefaults(runtime.policy);
  const sink: TraceSink = runtime.trace ?? new TraceRecorder();
  const provider = tracedProvider(runtime.provider, sink);
  const workflowId = plan.workflow_id;
  const fingerprint = inputFingerprint(plan);
  const phaseResults: Record<string, unknown> = {};

  // P5: 执行画像指纹 mismatch 拒绝旧 run —— 既有 checkpoint 记录过不同指纹(执行画像
  // 已变化)时, 在此 fail-closed(任何 provider 调用/审批/文件写之前)。
  // 旧 checkpoint 无指纹(升级前)不拦(尽力而为); 本次运行时未携带指纹则跳过比对。
  if (runtime.profileFingerprint !== undefined) {
    const cp = readCheckpoint(root);
    if (cp?.profile_fingerprint !== undefined && cp.profile_fingerprint !== runtime.profileFingerprint) {
      throw new Error(
        `执行画像指纹变化, 拒绝沿用旧 checkpoint 续跑` +
          `(旧 ${cp.profile_fingerprint.slice(0, 12)}… ≠ 新 ${runtime.profileFingerprint.slice(0, 12)}…; N34/P5)。` +
          `请确认执行配置(Config.llm/preset/llm.yml)后重新授权导入, 或清理 .assistant/checkpoint.json`,
      );
    }
  }

  emit(sink, {
    type: "begin_import",
    workflow_id: workflowId,
    start_chapter: plan.start_chapter,
    end_chapter: plan.end_chapter,
    authorization_confirmed: true,
    input_fingerprint: fingerprint,
    ...(runtime.profileFingerprint !== undefined ? { profile_fingerprint: runtime.profileFingerprint } : {}),
    ...(runtime.contractVersions !== undefined && Object.keys(runtime.contractVersions).length > 0
      ? { contract_versions: runtime.contractVersions }
      : {}),
  });

  // N32 异常路径 state commit(交接 §7 条目 11): 任何阶段异常时把最新
  // phase_results 落 checkpoint 并精确 state commit 后重抛(调用方见原始失败);
  // 收口尽力而为, 绝不掩盖原异常。各写面已事务化(commitScenesTx/
  // applyAliasRelationChangesTx), 异常时 canonical 零残留, R17 门可过。
  try {
    // P5: 尽早把执行画像指纹/契约版本写入 checkpoint(覆盖中途崩溃的续跑面:
    // 指纹出现在 planImport 写入的 checkpoint 之上, 后续 run 才能拒绝旧 run)。
    // 保留既有 phase_results(同指纹续跑不丢进度)。
    if (runtime.profileFingerprint !== undefined) {
      const existing = readCheckpoint(root) ?? {};
      writeCheckpoint(root, {
        ...existing,
        plan: existing.plan ?? plan,
        profile_fingerprint: runtime.profileFingerprint,
        ...(runtime.contractVersions !== undefined
          ? { contract_versions: runtime.contractVersions }
          : {}),
      });
    }

    const result: DeepImportResult = {
      workflow_id: workflowId,
      input_fingerprint: fingerprint,
      committed: [],
      skipped: [],
      conflicts: [],
      adopted: 0,
      rejected: false,
      entities: { created: [], reused: [], uncertain: 0 },
      aliases: { attached: 0, skipped: 0, relations: 0, uncertain: 0, approved: false },
      structure: { threads: 0, arcs: 0, foreshadowing: 0, reveals: 0, low_confidence: 0 },
      trace: sink,
    };

    const chapters = range(plan.start_chapter, plan.end_chapter);

    // --- Phase 1a: slice(逐章切分; 按 1a 并发 50 分片) ---
    const sliced: SceneCandidate[] = [];
    for (const batch of chunk(chapters, policy.slicingBatchSize)) {
      // 审查项 3: 全链共享同一工作流累计预算 tracker(runtime.budget), 超支在 provider 前 fail-closed。
      const r = await sliceChapterBatch(provider, root, batch, { budget: runtime.budget });
      sliced.push(...r.items);
      emit(sink, {
        type: "stage_candidates",
        phase: "1a",
        batch_size: batch.length,
        count: r.items.length,
        candidate_ids: r.items.map((c) => c.candidate_id),
      });
      for (const ch of r.failed_chapters) {
        // R54: 1a 整章 fallback, 不部分采用
        emit(sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase1aFallback, phase: "1a", detail: `第 ${ch} 章整章 fallback` });
      }
    }
    phaseResults["1a"] = { candidates: sliced.length, fallback: sliced.filter((c) => c.fallback_required).length };
    emitCheckpoint(sink, "1a", fingerprint);

    // --- Phase 1b: enrich(补全; provider 失败空语义进复核) ---
    const needsReviewBefore = new Map(sliced.map((s) => [s.candidate_id, s.needs_review]));
    const enriched = await enrichSceneBatch(provider, sliced, { budget: runtime.budget });
    emit(sink, {
      type: "stage_candidates",
      phase: "1b",
      batch_size: enriched.length,
      count: enriched.length,
      candidate_ids: enriched.map((c) => c.candidate_id),
    });
    for (const sc of enriched) {
      if (sc.needs_review && needsReviewBefore.get(sc.candidate_id) === false) {
        // R52: 1b 空语义进复核
        emit(sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase1bEmptySemantics, phase: "1b", detail: sc.review_reason });
      }
    }
    phaseResults["1b"] = { scenes: enriched.length };
    emitCheckpoint(sink, "1b", fingerprint);

    // --- Phase 1c: fuse(成对边界复核; 决策只记录, 不自动应用) ---
    const pairs: Array<{ left: SceneCandidate; right: SceneCandidate }> = [];
    for (let i = 0; i + 1 < enriched.length; i++) pairs.push({ left: enriched[i], right: enriched[i + 1] });
    const fusion = await fuseSceneBatch(provider, pairs, { budget: runtime.budget });
    phaseResults["1c"] = { decisions: fusion.length };
    emitCheckpoint(sink, "1c", fingerprint);

    // --- commit(adopt 经审批门, §9/§15) ---
    const adoptItems = enriched.map((c) => c.candidate_id);
    const decision = await runtime.approve(
      "采用章节候选",
      `导入第 ${plan.start_chapter}-${plan.end_chapter} 章的 ${adoptItems.length} 个 Scene`,
      adoptItems,
    );
    emit(sink, { type: "approval", action: "commit_scenes", decision });

    if (decision !== "allowed-once") {
      // fail-closed: 拒绝/不可用 = 不 commit, 后续阶段无已提交 Scene 可消费
      emit(sink, { type: "reject", action: "commit_scenes", decision });
      result.rejected = true;
      result.rejection_decision = decision;
      emitCheckpoint(sink, "commit", fingerprint);
      emit(sink, { type: "complete_import", workflow_id: workflowId, adopted: 0 });
      writeCheckpoint(root, checkpointState(plan, phaseResults, runtime, fingerprint));
      // rejected 闭环: checkpoint/complete trace 都写完后再精确 stage 工件并恰一次
      // state commit(前置 R17 门禁: 范围外任何改动含预存 staged 一律 fail-closed,
      // 不捕获其他文件; 均无变化不 commit), 防止深导后工作区永久脏。
      commitImportState(root);
      return result;
    }

    // 复核纪律(同 2b): adopt(commit_scenes) 只在 commitScenes 成功且实际创建
    // created.length>0 后 emit, items=实际创建 Scene(而非全部候选)——全 skip/冲突
    // 零创建 → 无 adopt; commitScenes 抛错(校验/R17 失败)→ 异常向上抛, 不留假 adopt。
    const committed = await commitScenesTx(root, enriched, { workflowId });
    result.committed = committed.created;
    result.skipped = committed.skipped;
    result.conflicts = committed.conflicts;
    result.adopted = committed.created.length;
    if (committed.created.length > 0) {
      emit(sink, { type: "adopt", action: "commit_scenes", items: committed.created });
    }
    phaseResults["commit"] = { created: committed.created.length, skipped: committed.skipped.length };
    emitCheckpoint(sink, "commit", fingerprint);

    // --- Phase 2a: entities(按 phase2 batch 12 分片) ---
    for (const batch of chunk(result.committed, policy.phase2BatchSize)) {
      const r = await extractEntityBatch(provider, root, batch, {
        workflowId,
        budget: runtime.budget,
        serialStart: result.entities.created.length,
      });
      result.entities.created.push(...r.created);
      result.entities.reused.push(...r.reused);
      result.entities.uncertain += r.uncertain;
      emit(sink, {
        type: "stage_candidates",
        phase: "2a",
        batch_size: batch.length,
        count: r.created.length,
        candidate_ids: r.created,
      });
    }
    phaseResults["2a"] = result.entities;
    emitCheckpoint(sink, "2a", fingerprint);

    // --- Phase 2b: alias/relation(只读 propose → 汇总实际变更 → 独立审批 → apply) ---
    // 复核纪律(「read-only propose → 汇总实际变更 → approval → apply」):
    // - 审批 request 之前只调 provider 收集规范化建议(proposeAliasRelations 不写文件), 按 policy
    //   aliasConcurrency 分片, 跨批聚合为 plan(planAliasRelationChanges: 内存算最终内容 + 全部校验
    //   在首个 write 前 fail-closed); 摘要/条目列出目标 canonical 对象与增量 aliases/relations;
    // - 最终实际 attached+relations=0(空建议/全 skip/全不确定)→ 不请求 2b 审批、不 emit adopt、
    //   不 commit, 2b status=no_changes;
    // - 有实际变更才请求独立审批(不复用 Scene 授权, 铁律 3); 拒绝/不可用 = 不 apply,
    //   canonical 字节/commit 不变(provider 已运行的范围 LLM 成本已由 DSH authorize_deep_import 单独授权);
    // - allowed-once 才 apply(写 + 恰一次 commit); adopt(alias_relation)在 apply 成功后 emit,
    //   而非写前; 写/commit 异常不 emit adopt(异常向上抛, 调用方见 fail-closed)。
    if (result.committed.length > 0) {
      let uncertain2b = 0;
      let skipped2b = 0;
      const proposals: AliasRelationProposal[] = [];
      for (const batch of chunk(result.committed, policy.aliasConcurrency)) {
        const proposal = await proposeAliasRelations(provider, root, batch, { workflowId, budget: runtime.budget });
        proposals.push(proposal);
        uncertain2b += proposal.uncertain;
        skipped2b += proposal.skipped_aliases;
        emit(sink, {
          type: "stage_candidates",
          phase: "2b",
          batch_size: batch.length,
          count: proposal.aliases.length + proposal.relations.length,
          candidate_ids: [],
        });
        if (proposal.uncertain > 0) {
          // R53: 2b 只降级不丢对象
          emit(sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase2bNoDrop, phase: "2b", detail: `${proposal.uncertain} 项进待复核` });
        }
      }
      result.aliases.uncertain = uncertain2b;
      result.aliases.skipped = skipped2b;
      const plan = planAliasRelationChanges(root, proposals);

      if (plan.empty) {
        // 无实际变更: 不请求审批、不 emit adopt、不 commit(2b status=no_changes)。
        result.aliases.approved = false;
        phaseResults["2b"] = { ...result.aliases, status: "no_changes", skipped_all: true };
        emitCheckpoint(sink, "2b", fingerprint);
      } else {
        const aliasDecision = await runtime.approve("别名/关系写入(2b)", plan.summary, plan.items);
        emit(sink, { type: "approval", action: "alias_relation", decision: aliasDecision });

        if (aliasDecision !== "allowed-once") {
          // fail-closed: 拒绝/不可用 → 跳过 2b 写面, 不写 canonical, 不 commit;
          // provider 已运行但 canonical 字节/commit 不变; Scene 已采用, 整体不判 rejected。
          const aliasReject: "rejected" | "unavailable" = aliasDecision;
          emit(sink, { type: "reject", action: "alias_relation", decision: aliasReject });
          result.aliases.approved = false;
          result.aliases.decision = aliasReject;
          phaseResults["2b"] = { ...result.aliases, status: aliasReject, skipped_all: true };
          emitCheckpoint(sink, "2b", fingerprint);
        } else {
          // allowed-once: apply(写 + 恰一次 commit)成功后才 emit adopt; 写/commit 异常不 emit。
          const applied = await applyAliasRelationChangesTx(root, plan);
          result.aliases.approved = true;
          result.aliases.decision = aliasDecision;
          result.aliases.attached = applied.aliases_attached;
          result.aliases.relations = applied.relations_written;
          emit(sink, { type: "adopt", action: "alias_relation", items: plan.touched });
          phaseResults["2b"] = { ...result.aliases, status: "done" };
          emitCheckpoint(sink, "2b", fingerprint);
        }
      }
    } else {
      // 无本批提交 Scene → 无 2b 写面, 无需审批; 阶段明确标 skipped
      result.aliases.approved = false;
      phaseResults["2b"] = { ...result.aliases, status: "skipped", skipped_all: true };
      emitCheckpoint(sink, "2b", fingerprint);
    }

    // --- Phase 3: structure(≥0.96 自动落 draft 待采用(N31), 低置信只计数; canonical 升格走 novelcraft_store_adopt 审批门) ---
    const struct = await analyzeStructureWithSources(
      provider,
      root,
      {
        workflowId,
        scenes: readExplicitFiles(root, "scenes", result.committed),
        pendingEntities: readExplicitFiles(root, "world/pending", result.entities.created),
        reusedEntitySlugs: result.entities.reused.map((item) => item.target),
      },
      { budget: runtime.budget },
    );
    result.structure.threads = struct.result.threads.length;
    result.structure.arcs = struct.result.arcs.length;
    result.structure.foreshadowing = struct.result.foreshadowing.length;
    result.structure.reveals = struct.result.reveals.length;
    result.structure.low_confidence = struct.result.low_confidence;
    result.structure.context = struct.context;
    phaseResults["3"] = { ...struct.result, context: struct.context };
    emitCheckpoint(sink, "3", fingerprint);

    // 阶段结果 + 授权快照落 checkpoint(续跑幂等, R42/R43; 含执行画像指纹, P5)
    writeCheckpoint(root, checkpointState(plan, phaseResults, runtime, fingerprint));

    emit(sink, { type: "complete_import", workflow_id: workflowId, adopted: result.adopted });
    // complete 闭环: checkpoint/complete trace 都写完后再精确 stage 工件并恰一次
    // state commit(前置 R17 门禁: 范围外任何改动含预存 staged 一律 fail-closed,
    // 不捕获其他文件; 均无变化不 commit), 防止深导后工作区永久脏
    // (否则后续 store adopt 等全局洁净检查被 .assistant/checkpoint.json + trace 卡死)。
    commitImportState(root);
    return result;
  } catch (err) {
    try {
      writeCheckpoint(root, checkpointState(plan, phaseResults, runtime, fingerprint));
      commitImportState(root);
    } catch {
      // 状态收口尽力而为; 原异常优先。
    }
    throw err;
  }
}
