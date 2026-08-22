// @novelcraft/trace 框架自测: 记录器有序 + 断言 DSL 正反例 + MockApproval fail-closed + policy 默认。
import { describe, expect, it } from "vitest";
import {
  DEGRADATION_CLAUSE,
  MockApproval,
  TraceRecorder,
  assertCheckpointAfterPhase,
  assertBatchPersistenceOrder,
  assertApplyStateMachine,
  assertDegradationClauses,
  assertEveryAdoptApproved,
  assertOrdered,
  assertShardsWithinPolicy,
  loadPolicyDefaults,
} from "../src/index";

function recorder(): TraceRecorder {
  return new TraceRecorder();
}

describe("TraceRecorder(内存有序追加)", () => {
  it("seq 单调递增, 事件按记录顺序可读", () => {
    const t = recorder();
    t.record({ type: "begin_import", workflow_id: "w", start_chapter: 1, end_chapter: 2, authorization_confirmed: true, input_fingerprint: "f" });
    t.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    const all = t.all();
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(0);
    expect(all[1].seq).toBe(1);
    expect(all[0].type).toBe("begin_import");
    expect(t.eventsOf("checkpoint")).toHaveLength(1);
  });
  it("clear 后清空且 seq 归零", () => {
    const t = recorder();
    t.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    t.clear();
    expect(t.length).toBe(0);
    t.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    expect(t.all()[0].seq).toBe(0);
  });
});

describe("assertOrdered(§15 顺序)", () => {
  it("before 先于 after → 通过", () => {
    const t = recorder();
    t.record({ type: "begin_import", workflow_id: "w", start_chapter: 1, end_chapter: 1, authorization_confirmed: true, input_fingerprint: "f" });
    t.record({ type: "stage_candidates", phase: "1a", batch_size: 1, count: 1, candidate_ids: ["a"] });
    expect(() => assertOrdered(t, "begin_import", "stage_candidates")).not.toThrow();
  });
  it("倒序或缺事件 → 抛错", () => {
    const t = recorder();
    t.record({ type: "stage_candidates", phase: "1a", batch_size: 1, count: 1, candidate_ids: ["a"] });
    t.record({ type: "begin_import", workflow_id: "w", start_chapter: 1, end_chapter: 1, authorization_confirmed: true, input_fingerprint: "f" });
    expect(() => assertOrdered(t, "begin_import", "stage_candidates")).toThrow(/begin_import/);
    expect(() => assertOrdered(t, "begin_import", "adopt")).toThrow(/adopt/);
  });
});

describe("assertEveryAdoptApproved(§9/§15 审批)", () => {
  it("allowed-once → adopt 通过", () => {
    const t = recorder();
    t.record({ type: "approval", action: "commit", decision: "allowed-once" });
    t.record({ type: "adopt", action: "commit", items: ["a"] });
    expect(() => assertEveryAdoptApproved(t)).not.toThrow();
  });
  it("无 approval 直接 adopt → 抛错", () => {
    const t = recorder();
    t.record({ type: "adopt", action: "commit", items: ["a"] });
    expect(() => assertEveryAdoptApproved(t)).toThrow(/allowed-once/);
  });
  it("rejected 之后 adopt → 抛错", () => {
    const t = recorder();
    t.record({ type: "approval", action: "commit", decision: "rejected" });
    t.record({ type: "adopt", action: "commit", items: ["a"] });
    expect(() => assertEveryAdoptApproved(t)).toThrow(/rejected/);
  });
  it("allowed-once 只授权一次: 两个 adopt 只有一个审批 → 抛错", () => {
    const t = recorder();
    t.record({ type: "approval", action: "commit", decision: "allowed-once" });
    t.record({ type: "adopt", action: "commit", items: ["a"] });
    t.record({ type: "adopt", action: "commit", items: ["b"] });
    expect(() => assertEveryAdoptApproved(t)).toThrow(/allowed-once/);
  });
});

describe("assertCheckpointAfterPhase(§15 checkpoint)", () => {
  it("每 phase 有 checkpoint → 通过", () => {
    const t = recorder();
    for (const p of ["1a", "1b", "1c"]) {
      t.record({ type: "checkpoint", phase: p, input_fingerprint: "f", done: true });
    }
    expect(() => assertCheckpointAfterPhase(t, ["1a", "1b", "1c"])).not.toThrow();
  });
  it("缺 phase 的 checkpoint → 抛错", () => {
    const t = recorder();
    t.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    expect(() => assertCheckpointAfterPhase(t, ["1a", "1b"])).toThrow(/1b/);
  });
  it("checkpoint 必须在其 stage_candidates 之后", () => {
    const t = recorder();
    t.record({ type: "stage_candidates", phase: "1a", batch_size: 1, count: 1, candidate_ids: ["a"] });
    t.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    expect(() => assertCheckpointAfterPhase(t, ["1a"])).not.toThrow();
    const t2 = recorder();
    t2.record({ type: "checkpoint", phase: "1a", input_fingerprint: "f", done: true });
    t2.record({ type: "stage_candidates", phase: "1a", batch_size: 1, count: 1, candidate_ids: ["a"] });
    expect(() => assertCheckpointAfterPhase(t2, ["1a"])).toThrow(/checkpoint/);
  });
});

describe("assertShardsWithinPolicy(policy-defaults §4)", () => {
  const policy = loadPolicyDefaults();
  it("批大小在上限内 → 通过", () => {
    const t = recorder();
    t.record({ type: "stage_candidates", phase: "1a", batch_size: 50, count: 50, candidate_ids: [] });
    t.record({ type: "stage_candidates", phase: "2a", batch_size: 12, count: 3, candidate_ids: [] });
    t.record({ type: "stage_candidates", phase: "2b", batch_size: 4, count: 1, candidate_ids: [] });
    expect(() => assertShardsWithinPolicy(t, policy)).not.toThrow();
  });
  it("超上限 → 抛错", () => {
    const t = recorder();
    t.record({ type: "stage_candidates", phase: "2a", batch_size: 13, count: 13, candidate_ids: [] });
    expect(() => assertShardsWithinPolicy(t, policy)).toThrow(/2a/);
  });
});

describe("assertDegradationClauses(§15 降级)", () => {
  it("条款齐全 → 通过", () => {
    const t = recorder();
    t.record({ type: "degradation", clause: DEGRADATION_CLAUSE.phase1aFallback, phase: "1a" });
    expect(() => assertDegradationClauses(t, [DEGRADATION_CLAUSE.phase1aFallback])).not.toThrow();
  });
  it("缺条款 → 抛错", () => {
    const t = recorder();
    expect(() => assertDegradationClauses(t, [DEGRADATION_CLAUSE.dedupFailed])).toThrow(/dedup_failed/);
  });
});

describe("N33 batch/resume/apply trace contract", () => {
  it("batch 必须 plan → artifact → cursor，恰推进一次", () => {
    const t = recorder();
    t.record({ type: "batch_planned", workflow_id: "w", batch_id: "b", phase: "2a", ordinal: 0 });
    t.record({ type: "batch_artifact", workflow_id: "w", batch_id: "b", result_hash: "h", transaction_id: "tx" });
    t.record({ type: "batch_cursor", workflow_id: "w", batch_id: "b", state: "completed" });
    expect(() => assertBatchPersistenceOrder(t)).not.toThrow();
    const bad = recorder();
    bad.record({ type: "batch_artifact", workflow_id: "w", batch_id: "b", result_hash: "h", transaction_id: "tx" });
    expect(() => assertBatchPersistenceOrder(bad)).toThrow(/未先提交 plan/);
  });

  it("apply applied 必须来自 applying 且携 transaction identity", () => {
    const t = recorder();
    t.record({ type: "apply_state", workflow_id: "w", apply_id: "a", target: "x", from: "waiting_approval", to: "applying" });
    t.record({ type: "apply_state", workflow_id: "w", apply_id: "a", target: "x", from: "applying", to: "applied", transaction_id: "tx" });
    expect(() => assertApplyStateMachine(t)).not.toThrow();
    const bad = recorder();
    bad.record({ type: "apply_state", workflow_id: "w", apply_id: "a", target: "x", from: "applying", to: "applied" });
    expect(() => assertApplyStateMachine(bad)).toThrow(/transaction identity/);
  });

  it("resume 明确记录 provider_outcome_unknown，不把未知当 completed", () => {
    const t = recorder();
    t.record({ type: "resume", workflow_id: "w", outcome: "provider_outcome_unknown", remaining_batches: 1 });
    expect(t.eventsOf("resume")).toMatchObject([{ outcome: "provider_outcome_unknown", remaining_batches: 1 }]);
  });
});

describe("MockApproval / loadPolicyDefaults", () => {
  it("脚本化按序弹出; 耗尽 fail-closed 返回 unavailable", async () => {
    const m = new MockApproval({ decisions: ["allowed-once"] });
    expect(await m.approve("a", "s", [])).toBe("allowed-once");
    expect(await m.approve("a", "s", [])).toBe("unavailable"); // 耗尽 = fail-closed
    expect(m.calls).toHaveLength(2);
  });
  it("默认值 50/12/4; 覆盖生效", () => {
    expect(loadPolicyDefaults()).toEqual({ slicingBatchSize: 50, phase2BatchSize: 12, aliasConcurrency: 4 });
    expect(loadPolicyDefaults({ phase2BatchSize: 6 }).phase2BatchSize).toBe(6);
  });
});
