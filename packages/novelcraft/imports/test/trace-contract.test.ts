// imports · trace contract 行为契约(设计文档 §15 / ADR-0016 §1 / PLAN.md)。
// 用 MockProvider(@novelcraft/llm-step)+ MockApproval(@novelcraft/trace)跑 runDeepImport,
// 断言 §15 不变量: 顺序 / 审批 / checkpoint / 分片 / 降级 / 授权。
// 注释引用规则/裁定编号(沿用 phase1.test.ts 约定)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { ingestChapter } from "@novelcraft/writing";
import {
  DEGRADATION_CLAUSE,
  MockApproval,
  TraceRecorder,
  assertCheckpointAfterPhase,
  assertDegradationClauses,
  assertEveryAdoptApproved,
  assertOrdered,
  assertShardsWithinPolicy,
  loadPolicyDefaults,
} from "@novelcraft/trace";
import type { StageCandidatesEvent } from "@novelcraft/trace";
import { planImport, runDeepImport } from "../src/index";
import type { DeepImportRuntime } from "../src/index";

const dirs: string[] = [];
function makeRoot(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), "ncitc-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  for (let i = 1; i <= n; i++) {
    ingestChapter(root, { chapterIndex: i, text: "第" + i + "章正文。", source: "paste" });
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}

/** 生成 n 章(每章 1 Scene)全链 happy 响应的 MockProvider 响应队列(严格按调用顺序)。 */
function happyResponses(n: number): Array<{ text?: string; throwError?: Error }> {
  const responses: Array<{ text?: string; throwError?: Error }> = [];
  for (let ch = 1; ch <= n; ch++) responses.push({ text: JSON.stringify({ scenes: [sceneJson(ch, "S" + ch, "A" + ch)] }) });
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) });
  for (let i = 0; i < n - 1; i++) {
    responses.push({
      text: JSON.stringify({
        boundaries: [{ left_candidate_id: "ch" + (i + 1) + "-s0", right_candidate_id: "ch" + (i + 2) + "-s0", relation: "separate", confidence: 0.9 }],
      }),
    });
  }
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ entities: [] }) });
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) });
  // Phase 3 结构(N31): 本队列返回空结构; 非空 ≥0.96 项落 structure/ status=draft,
  // canonical 升格走 novelcraft_store_adopt 审批门(见 phase2-3.test.ts 的 N31 断言)。
  responses.push({ text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) });
  return responses;
}

function runtime(n: number, approval: MockApproval, overrides?: Partial<DeepImportRuntime>): DeepImportRuntime {
  const base: DeepImportRuntime = {
    provider: new MockProvider({ retryable: false, responses: happyResponses(n) }),
    approve: (a, s, items) => approval.approve(a, s, items),
    trace: new TraceRecorder(),
  };
  return overrides ? { ...base, ...overrides } : base;
}

describe("runDeepImport · 顺序(§15: begin_import 先于 stage_candidates 先于 adopt)", () => {
  it("全链 happy path: 顺序不变量 + adopt 前过审批", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    expect(r.adopted).toBe(2);
    assertOrdered(recorder, "begin_import", "stage_candidates"); // §15
    assertOrdered(recorder, "stage_candidates", "adopt"); // §15/§12
    expect(recorder.eventsOf("adopt")).toHaveLength(1);
  });
});

describe("runDeepImport · 审批(§9/§15: adopt 必过 approval, fail-closed)", () => {
  it("allowed-once → adopt 且 commit", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    expect(r.rejected).toBe(false);
    expect(r.committed).toHaveLength(2);
    assertEveryAdoptApproved(recorder); // 每个 adopt 前必有 approval=allowed-once
  });
  it("rejected → 无 adopt 无 commit(fail-closed)", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["rejected"] });
    const r = await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    expect(r.rejected).toBe(true);
    expect(r.rejection_decision).toBe("rejected");
    expect(r.committed).toHaveLength(0);
    expect(recorder.eventsOf("adopt")).toHaveLength(0);
    expect(recorder.eventsOf("reject")).toHaveLength(1);
  });
  it("审批脚本耗尽 → unavailable(fail-closed), 无 commit", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: [] }); // 空脚本 = 一律 unavailable
    const r = await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    expect(r.rejection_decision).toBe("unavailable");
    expect(r.committed).toHaveLength(0);
    expect(recorder.eventsOf("adopt")).toHaveLength(0);
  });
});

describe("runDeepImport · checkpoint(§15/R42/R43: 每 phase 后 checkpoint, input_fingerprint 幂等)", () => {
  it("六阶段每 phase 后必有 checkpoint", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    assertCheckpointAfterPhase(recorder, ["1a", "1b", "1c", "commit", "2a", "2b", "3"]);
  });
  it("同 scope 重跑: input_fingerprint 一致 + provenance_key skip(幂等续跑)", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const approval1 = new MockApproval({ decisions: ["allowed-once"] });
    const run1 = await runDeepImport(root, plan, runtime(2, approval1, { trace: new TraceRecorder() }));
    // 第二次跑: 阶段函数幂等(commitScenes provenance_key skip), 实体/别名无新 commit 可消费
    const approval2 = new MockApproval({ decisions: ["allowed-once"] });
    const run2 = await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => approval2.approve(a, s, items),
      trace: new TraceRecorder(),
    });
    expect(run2.input_fingerprint).toBe(run1.input_fingerprint); // R42 同 scope 幂等
    expect(run2.committed).toHaveLength(0);
    expect(run2.skipped).toHaveLength(2); // provenance_key skip
  });
});

describe("runDeepImport · 分片(policy-defaults §4: 1a 50 / 2a 12 / 2b 4)", () => {
  it("批大小在 policy 上限内; 收紧 policy 后按上限切分", async () => {
    const root = makeRoot(5);
    const plan = planImport(root, { startChapter: 1, endChapter: 5, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const policy = loadPolicyDefaults({ slicingBatchSize: 2, phase2BatchSize: 2, aliasConcurrency: 1 });
    await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(5) }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
      policy,
    });
    assertShardsWithinPolicy(recorder, policy);
    const staged = recorder.eventsOf("stage_candidates") as StageCandidatesEvent[];
    expect(staged.filter((e) => e.phase === "1a")).toHaveLength(3); // 5 章 / 2
    expect(staged.filter((e) => e.phase === "2a")).toHaveLength(3); // 5 Scene / 2
    expect(staged.filter((e) => e.phase === "2b")).toHaveLength(5); // 5 Scene / 1
  });
});

describe("runDeepImport · 降级(R52–R55)", () => {
  it("1a provider 失败 → 整章 fallback(R54)", async () => {
    const root = makeRoot(1);
    const plan = planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, {
      provider: new MockProvider({
        retryable: false,
        responses: [
          { throwError: new Error("boom") }, // 1a 切分失败
          { text: JSON.stringify({ entities: [] }) },
          { text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) },
          { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
        ],
      }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    expect(r.adopted).toBe(1); // 整章 fallback 仍作为一个保底 Scene 提交
    assertDegradationClauses(recorder, [DEGRADATION_CLAUSE.phase1aFallback]);
  });
  it("1b provider 失败 → 空语义进复核(R52)", async () => {
    const root = makeRoot(1);
    const plan = planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    await runDeepImport(root, plan, {
      provider: new MockProvider({
        retryable: false,
        responses: [
          { text: JSON.stringify({ scenes: [sceneJson(1, "S1", "A1")] }) },
          { throwError: new Error("boom") }, // 1b 补全失败
          { text: JSON.stringify({ entities: [] }) },
          { text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) },
          { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
        ],
      }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    assertDegradationClauses(recorder, [DEGRADATION_CLAUSE.phase1bEmptySemantics]);
  });
  it("2b provider 失败 → 只降级不丢对象(R53)", async () => {
    const root = makeRoot(1);
    const plan = planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, {
      provider: new MockProvider({
        retryable: false,
        responses: [
          { text: JSON.stringify({ scenes: [sceneJson(1, "S1", "A1")] }) },
          { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
          { text: JSON.stringify({ entities: [] }) },
          { throwError: new Error("boom") }, // 2b 别名/关系失败
          { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
        ],
      }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    expect(r.aliases.uncertain).toBe(1); // 只降级, 不丢对象
    assertDegradationClauses(recorder, [DEGRADATION_CLAUSE.phase2bNoDrop]);
  });
});

describe("runDeepImport · 授权(R40: authorization_confirmed 强制 true)", () => {
  it("未确认快照 → 拒绝执行", async () => {
    const root = makeRoot(2);
    const plan = { ...planImport(root, { startChapter: 1, endChapter: 2, confirmed: true }), authorization: { authorization_confirmed: false, authorized_at: "", adoption_policy: "", scope: { start_chapter: 1, end_chapter: 2 } } };
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    await expect(
      runDeepImport(root, plan, runtime(2, approval, { trace: new TraceRecorder() })),
    ).rejects.toThrow(/authorization_confirmed/);
  });
});
