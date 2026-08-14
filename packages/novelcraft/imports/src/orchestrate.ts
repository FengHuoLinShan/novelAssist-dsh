// imports · 确定性编排 seam runDeepImport(设计文档 §15「Trace contract」+ PLAN.md §形态决策)。
// 纯 TS 顺序串起六阶段: begin_import → slice(1a) → enrich(1b) → fuse(1c) →
// commit(adopt 经审批门)→ entities(2a) → alias_relation(2b) → structure(3) → complete_import。
// - adopt(Scene commit)必过 runtime.approve, 拒绝/不可用 = fail-closed(§9 / ApprovalGate), 不 commit;
// - 每阶段后写 checkpoint 并 emit checkpoint(R42/R43 幂等续跑按 input_fingerprint);
// - 分片按 policy 批量(policy-defaults.md §4: 1a 50 / 2a 12 / 2b 4);
// - provider 失败触发对应降级事件(R52–R55);
// - runtime.trace 为可注入 sink(测试注入 TraceRecorder; 缺省也落 TraceRecorder 供检查)。
import { createHash } from "node:crypto";
import { DEGRADATION_CLAUSE, TraceRecorder, loadPolicyDefaults } from "@novelcraft/trace";
import type { ApprovalDecision, DeepImportPolicy, TraceEventInput, TraceSink } from "@novelcraft/trace";
import type { Provider, ProviderRequest } from "@novelcraft/llm-step";
import type { ImportPlan } from "./plan.js";
import { writeCheckpoint } from "./plan.js";
import type { SceneCandidate } from "./stages.js";
import { enrichSceneBatch, fuseSceneBatch, sliceChapterBatch } from "./stages.js";
import { commitScenes } from "./commit.js";
import { extractEntityBatch } from "./entities.js";
import { aliasRelationBatch } from "./alias-relation.js";
import { analyzeStructure } from "./structure.js";

/** runDeepImport 的可注入运行时(provider/审批/trace sink/策略)。 */
export interface DeepImportRuntime {
  provider: Provider;
  /** 审批决策(DSH 挂载接 ApprovalGate; 测试用 MockApproval)。 */
  approve: (action: string, summary: string, items: string[]) => Promise<ApprovalDecision>;
  /** 可选 trace sink(测试注入 TraceRecorder)。 */
  trace?: TraceSink;
  /** 分片/批量策略(缺省 loadPolicyDefaults())。 */
  policy?: DeepImportPolicy;
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
  aliases: { attached: number; skipped: number; relations: number; uncertain: number };
  structure: { threads: number; arcs: number; foreshadowing: number; reveals: number; low_confidence: number };
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

/** R42: input_fingerprint = sha256(授权 scope + 阶段步骤), 同 scope 幂等续跑基准。 */
function inputFingerprint(plan: ImportPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ scope: plan.authorization.scope, steps: plan.steps }))
    .digest("hex");
}

/** 包一层 provider: 每次 complete 调用 emit llm_step 事件(记录 provider 调用与失败)。 */
function tracedProvider(provider: Provider, sink: TraceSink): Provider {
  return {
    async complete(req: ProviderRequest) {
      try {
        const resp = await provider.complete(req);
        emit(sink, { type: "llm_step", ok: true, model: req.model });
        return resp;
      } catch (err) {
        emit(sink, { type: "llm_step", ok: false, error: String((err as Error)?.message ?? err), model: req.model });
        throw err;
      }
    },
  };
}

/**
 * 深度导入六阶段确定性编排(设计 §15 trace contract 主战场)。
 * 顺序串起阶段函数; 不并行 fan-out(留 DSH 挂载阶段), 但分片尺寸已按 policy 切好。
 */
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

  emit(sink, {
    type: "begin_import",
    workflow_id: workflowId,
    start_chapter: plan.start_chapter,
    end_chapter: plan.end_chapter,
    authorization_confirmed: true,
    input_fingerprint: fingerprint,
  });

  const result: DeepImportResult = {
    workflow_id: workflowId,
    input_fingerprint: fingerprint,
    committed: [],
    skipped: [],
    conflicts: [],
    adopted: 0,
    rejected: false,
    entities: { created: [], reused: [], uncertain: 0 },
    aliases: { attached: 0, skipped: 0, relations: 0, uncertain: 0 },
    structure: { threads: 0, arcs: 0, foreshadowing: 0, reveals: 0, low_confidence: 0 },
    trace: sink,
  };

  const chapters = range(plan.start_chapter, plan.end_chapter);

  // --- Phase 1a: slice(逐章切分; 按 1a 并发 50 分片) ---
  const sliced: SceneCandidate[] = [];
  for (const batch of chunk(chapters, policy.slicingBatchSize)) {
    const r = await sliceChapterBatch(provider, root, batch);
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
  const enriched = await enrichSceneBatch(provider, sliced);
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
  const fusion = await fuseSceneBatch(provider, pairs);
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
    writeCheckpoint(root, { plan, phase_results: { ...phaseResults, input_fingerprint: fingerprint } });
    return result;
  }

  emit(sink, { type: "adopt", action: "commit_scenes", items: adoptItems });
  const committed = commitScenes(root, enriched, { workflowId });
  result.committed = committed.created;
  result.skipped = committed.skipped;
  result.conflicts = committed.conflicts;
  result.adopted = committed.created.length;
  phaseResults["commit"] = { created: committed.created.length, skipped: committed.skipped.length };
  emitCheckpoint(sink, "commit", fingerprint);

  // --- Phase 2a: entities(按 phase2 batch 12 分片) ---
  for (const batch of chunk(result.committed, policy.phase2BatchSize)) {
    const r = await extractEntityBatch(provider, root, batch, { workflowId });
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

  // --- Phase 2b: alias/relation(按 alias 并发 4 分片; 失败只降级不丢对象) ---
  for (const batch of chunk(result.committed, policy.aliasConcurrency)) {
    const r = await aliasRelationBatch(provider, root, batch, { workflowId });
    result.aliases.attached += r.aliases_attached;
    result.aliases.skipped += r.aliases_skipped;
    result.aliases.relations += r.relations_written;
    result.aliases.uncertain += r.uncertain;
    emit(sink, {
      type: "stage_candidates",
      phase: "2b",
      batch_size: batch.length,
      count: r.aliases_attached + r.relations_written,
      candidate_ids: [],
    });
    if (r.uncertain > 0) {
      // R53: 2b 只降级不丢对象
      emit(sink, { type: "degradation", clause: DEGRADATION_CLAUSE.phase2bNoDrop, phase: "2b", detail: `${r.uncertain} 项进待复核` });
    }
  }
  phaseResults["2b"] = result.aliases;
  emitCheckpoint(sink, "2b", fingerprint);

  // --- Phase 3: structure(≥0.96 自动落 draft 待采用(N31), 低置信只计数; canonical 升格走 novelcraft_store_adopt 审批门) ---
  const struct = await analyzeStructure(provider, root, { workflowId });
  result.structure.threads = struct.threads.length;
  result.structure.arcs = struct.arcs.length;
  result.structure.foreshadowing = struct.foreshadowing.length;
  result.structure.reveals = struct.reveals.length;
  result.structure.low_confidence = struct.low_confidence;
  phaseResults["3"] = struct;
  emitCheckpoint(sink, "3", fingerprint);

  // 阶段结果 + 授权快照落 checkpoint(续跑幂等, R42/R43)
  writeCheckpoint(root, { plan, phase_results: { ...phaseResults, input_fingerprint: fingerprint } });

  emit(sink, { type: "complete_import", workflow_id: workflowId, adopted: result.adopted });
  return result;
}
