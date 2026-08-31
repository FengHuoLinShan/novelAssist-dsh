// imports · 执行画像指纹接入 run/checkpoint identity(N34 / ADR-0023 §6, 独立审查 P5/R6)。
// 断言引: N34(编排启动解析一次不可变 ExecutionProfile; 内部统一继承)、ADR-0023 §6
//         (启动解析一次、不可变)、N33/ADR-0022(指纹绑定 run identity)。
// 审查项 5 收口: resumeImport 强制「当前指纹」与「checkpoint 指纹」都存在且完全匹配
//       (profileFingerprint 必填; checkpoint 无指纹 → resumable:false, 移除旧 fail-open);
//       runDeepImport 携带指纹时仍按「既有 checkpoint 指纹 mismatch → 拒绝旧 run」。
// 覆盖: runDeepImport 把 profileFingerprint/contractVersions 写入 begin_import 事件与
//       checkpoint; 执行画像变化 → runDeepImport 拒绝旧 run(provider 零调用);
//       resumeImport 指纹 mismatch / checkpoint 无指纹 → resumable:false; 同指纹续跑不拦。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider, composeSystemPrompt, createWorkflowBudget, estimateTokens, loadSpec } from "@novelcraft/llm-step";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { ingestChapter } from "@novelcraft/writing";
import { DEGRADATION_CLAUSE, TraceRecorder } from "@novelcraft/trace";
import { planImport, readCheckpoint, resumeImport, runDeepImport, writeCheckpoint } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nci-fp-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "克莱恩与苏婉同行。", source: "paste" });
  ingestChapter(root, { chapterIndex: 2, text: "第二章正文。", source: "paste" });
  gitAdd(root);
  gitCommit(root, "fixture init");
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FPA = "a".repeat(64);
const FPB = "b".repeat(64);
const CONTRACT_VERSIONS = { scene_slicing: "v1", alias_relation: "v3" };

function approveAlways(): Promise<"allowed-once"> {
  return Promise.resolve("allowed-once");
}

/** 2 章全链 happy 响应(按调用顺序: slice2 enrich2 fuse1 entity2 alias2 structure1)。 */
function happyResponses(): Array<{ text: string }> {
  const scene = (ch: number) => ({
    title: `S${ch}`, start_chapter: ch, end_chapter: ch,
    start_anchor: `A${ch}`, end_anchor: `A${ch}`, confidence: 0.9,
  });
  return [
    { text: JSON.stringify({ scenes: [scene(1)] }) },
    { text: JSON.stringify({ scenes: [scene(2)] }) },
    { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
    { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
    { text: JSON.stringify({ boundaries: [] }) },
    { text: JSON.stringify({ entities: [] }) },
    { text: JSON.stringify({ entities: [] }) },
    { text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) },
    { text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) },
    { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
  ];
}

describe("runDeepImport 携带执行画像指纹(P5: begin_import 事件 + checkpoint 落指纹/契约版本)", () => {
  it("profileFingerprint/contractVersions → begin_import 事件与 checkpoint 一致携带", async () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const rec = new TraceRecorder();
    const provider = new MockProvider({ responses: happyResponses() });
    const result = await runDeepImport(root, plan, {
      provider,
      approve: approveAlways,
      trace: rec,
      profileFingerprint: FPA,
      contractVersions: CONTRACT_VERSIONS,
    });
    expect(result.rejected).toBe(false);
    const begin = rec.eventsOf("begin_import")[0] as { profile_fingerprint?: string; contract_versions?: Record<string, string> };
    expect(begin.profile_fingerprint).toBe(FPA);
    expect(begin.contract_versions).toEqual(CONTRACT_VERSIONS);
    const cp = readCheckpoint(root);
    expect(cp?.profile_fingerprint).toBe(FPA);
    expect(cp?.contract_versions).toEqual(CONTRACT_VERSIONS);
  });

  it("不携带指纹(runtime 缺省, 旧调用面)→ 事件/checkpoint 无指纹字段, 行为不变", async () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const rec = new TraceRecorder();
    const provider = new MockProvider({ responses: happyResponses() });
    await runDeepImport(root, plan, { provider, approve: approveAlways, trace: rec });
    const begin = rec.eventsOf("begin_import")[0] as unknown as Record<string, unknown>;
    expect(begin.profile_fingerprint).toBeUndefined();
    expect(readCheckpoint(root)?.profile_fingerprint).toBeUndefined();
  });
});

describe("执行画像变化拒绝旧 run(P5: 指纹 mismatch → fail-closed, provider 前)", () => {
  it("既有 checkpoint 指纹 ≠ 本次指纹 → runDeepImport 抛错, provider 零调用, 文件面不变", async () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    // 模拟旧 run 的 checkpoint(已记录旧指纹 A)。
    writeCheckpoint(root, {
      plan,
      profile_fingerprint: FPA,
      contract_versions: CONTRACT_VERSIONS,
      phase_results: { "1a": { candidates: 2 } },
    });
    const canary = new MockProvider({ responses: [] }); // 空队列: 被调用即抛(哨兵)
    await expect(
      runDeepImport(root, plan, {
        provider: canary,
        approve: approveAlways,
        profileFingerprint: FPB,
      }),
    ).rejects.toThrow(/执行画像指纹变化/);
    expect(canary.calls).toHaveLength(0); // 拒绝发生在任何 provider 调用之前
    expect(readCheckpoint(root)?.profile_fingerprint).toBe(FPA); // 旧 checkpoint 未被改写
  });

  it("同指纹续跑不拦; 旧 checkpoint 无指纹(升级前)不拦(尽力而为)", async () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    // 旧 checkpoint 无指纹(升级前形态)。
    writeCheckpoint(root, { plan, phase_results: { "1a": { candidates: 2 } } });
    const rec = new TraceRecorder();
    const provider = new MockProvider({ responses: happyResponses() });
    const result = await runDeepImport(root, plan, {
      provider,
      approve: approveAlways,
      trace: rec,
      profileFingerprint: FPA,
    });
    expect(result.rejected).toBe(false);
  });
});

describe("resumeImport 指纹 strict(审查项 5: 当前指纹与 checkpoint 指纹都必须存在且完全匹配)", () => {
  it("checkpoint 指纹 ≠ 当前指纹 → resumable:false, reason 含「执行画像指纹变化」", () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    writeCheckpoint(root, { plan, profile_fingerprint: FPA, phase_results: {} });
    const s = resumeImport(root, { profileFingerprint: FPB });
    expect(s.resumable).toBe(false);
    expect(s.reason).toContain("执行画像指纹变化");
    expect(s.safe_to_rerun).toEqual([]);
  });

  it("同指纹 → 正常 resumable(profileFingerprint 必填, strict 参数)", () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    writeCheckpoint(root, { plan, profile_fingerprint: FPA, phase_results: {} });
    expect(resumeImport(root, { profileFingerprint: FPA }).resumable).toBe(true);
  });

  it("checkpoint 无指纹(旧版/仅 planImport 形态)→ 传指纹也拒绝(fail-closed, 移除旧 fail-open)", () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    writeCheckpoint(root, { plan, phase_results: {} });
    const s = resumeImport(root, { profileFingerprint: FPB });
    expect(s.resumable).toBe(false);
    expect(s.reason).toContain("未记录执行画像指纹");
    expect(s.safe_to_rerun).toEqual([]);
  });
});

describe("workflowBudget 共享累计 tracker(审查项 3: runDeepImport 全链共享, 超支在 provider 前 fail-closed)", () => {
  it("runtime.budget 只够首个内容步 → 后续所有步骤 provider 零新增调用(累计消费, 非每步独立)", async () => {
    const root = makeRoot();
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const rec = new TraceRecorder();
    const provider = new MockProvider({ responses: happyResponses() });
    // 单次 slice 占用(N39: 估算输入 + system 提示估算 + scene_slicing 输出上限
    // spec budgetTokens=8192); 预算恰好够 1 次 → slice ch1 成功(1 次 provider),
    // 此后全链(1b/1c/2a/2b/3)累计超支。
    const sliceSpec = loadSpec("scene_slicing")!;
    const sliceInput = "【第 1 章正文】\n克莱恩与苏婉同行。\n";
    const perCall = estimateTokens(sliceInput) + estimateTokens(composeSystemPrompt(sliceSpec).text) + sliceSpec.budgetTokens;
    const budget = createWorkflowBudget(perCall);
    const result = await runDeepImport(root, plan, {
      provider,
      approve: approveAlways,
      trace: rec,
      budget,
    });
    expect(provider.calls).toHaveLength(1); // 共享累计: 只首个内容步到达 provider
    expect(result.rejected).toBe(false);
    // 超支步骤不整链失败: 1a 走整章 fallback 降级(与 per-step budget_exceeded 同语义)。
    const fallbacks = rec
      .eventsOf("degradation")
      .filter((e) => (e as { clause?: string }).clause === DEGRADATION_CLAUSE.phase1aFallback);
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
  });
});

// 占位确保 git 辅助引入被使用(vitest 无未用告警压力; execFileSync 供后续扩展)。
void execFileSync;
