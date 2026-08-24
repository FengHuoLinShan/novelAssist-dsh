// N33 / ADR-0022 — deep-import durable driver(runDeepImportWorkflow)行为契约。
// 真实临时 vault + MockProvider/MockApproval + GitRunPersistence(生产持久化面):
//  - happy path: 六阶段七批确定性 workflowId; artifact→receipt→cursor 全走 store
//    事务进 git 历史; adopt(commit_scenes)经 RunApplyPort 独立审批 + canonical 事务;
//    2b 空建议不请求审批(复核纪律); 完成闭环 checkpoint+trace 进 git, 工作区干净;
//  - 确定性 + resume 幂等: 同输入恒同 workflowId; 已完成 run 重跑零 provider 调用;
//  - provider_outcome_unknown: 不自动重试(无 reauthorize → 抛 DeepImportWorkflowError);
//    经 reauthorizeRemaining allowed-once 重新授权后才重试该批, 已完成批不重跑;
//  - 窗口二崩溃恢复: artifact+receipt 已提交、cursor 未推进 → resume 幂等推进 cursor,
//    不重跑 provider、不重复 apply(审批计数不增加);
//  - 2b 独立审批: 有实际变更才请求审批; allowed-once 后 canonical 写 + adopt。
// 断言注释引规则/裁定编号(N33 / ADR-0022 §4/§5/§6/§8 / 铁律3)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initVault } from "@novelcraft/vault";
import { CrashSimulatedError, gitAdd, gitCommit, gitHead, gitStatusPorcelain } from "@novelcraft/store";
import { createWorkflowBudget, MockProvider } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { loadPolicyDefaults, MockApproval, TraceRecorder } from "@novelcraft/trace";
import { ingestChapter } from "@novelcraft/writing";
import {
  deepImportEngineSeam,
  deepImportInputFingerprint,
  makeWorkflowId,
  runDeepImportWorkflow,
  workflowSha256,
  type DeepImportWorkflowRuntime,
} from "../src/index.js";
import { planImport } from "../src/index.js";

const dirs: string[] = [];
function makeRoot(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), "nci-driver-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  for (let i = 1; i <= n; i++) {
    ingestChapter(root, { chapterIndex: i, text: "第" + i + "章正文。", source: "paste" });
  }
  gitAdd(root);
  gitCommit(root, "fixture init");
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (x: string) => workflowSha256(x);

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}

/** 2 章全链 happy 响应(1a×2, 1b×2, 1c×1, 2a×2, 2b×2, 3×1 = 10 次 provider 调用)。 */
function happyResponses(): Array<{ text?: string; throwError?: Error }> {
  const responses: Array<{ text?: string; throwError?: Error }> = [];
  for (const ch of [1, 2]) responses.push({ text: JSON.stringify({ scenes: [sceneJson(ch, `S${ch}`, `A${ch}`)] }) });
  for (let i = 0; i < 2; i++) responses.push({ text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) });
  responses.push({
    text: JSON.stringify({ boundaries: [{ left_candidate_id: "ch1-s0", right_candidate_id: "ch2-s0", relation: "separate", confidence: 0.9 }] }),
  });
  for (let i = 0; i < 2; i++) responses.push({ text: JSON.stringify({ entities: [] }) });
  for (let i = 0; i < 2; i++) responses.push({ text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) });
  responses.push({ text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) });
  return responses;
}

/** 2b 非空响应(每 Scene 1 别名 + 1 关系)。 */
function rich2bResponse() {
  return {
    aliases: [{ entity_ref: "人物甲", alias: "红衣女子", confidence: 0.8 }],
    relations: [{ source_ref: "人物乙", target_ref: "人物甲", relation_type: "associate", confidence: 0.8 }],
    uncertain_items: [],
  };
}

function richResponses(): Array<{ text?: string; throwError?: Error }> {
  const responses = happyResponses();
  responses[7] = { text: JSON.stringify(rich2bResponse()) };
  responses[8] = { text: JSON.stringify(rich2bResponse()) };
  return responses;
}

/** 造两个 canonical 对象(2b 的可写目标)。 */
function seedCanonicalObjects(root: string): void {
  writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
  writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
  gitAdd(root);
  gitCommit(root, "seed objects");
}

function makePlan(root: string) {
  return planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
}

function runtime(
  provider: Provider,
  approval: MockApproval,
  overrides?: Partial<DeepImportWorkflowRuntime>,
): DeepImportWorkflowRuntime {
  return {
    provider,
    approve: (a, s, items) => approval.approve(a, s, items),
    trace: new TraceRecorder(),
    profileFingerprint: sha("profile-v1"),
    contractVersions: { scene_slicing: "v1", scene_enrichment: "v1" },
    ...overrides,
  };
}

function gitShow(root: string, rel: string): string {
  return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8" });
}

function gitHeadHas(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}


/** 本组测试走真实 git 事务, 单测可达数十秒; 显式放宽 vitest 默认 5s 超时。 */
function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 180_000);
}

describe("runDeepImportWorkflow(durable driver)", () => {
  itSlow("happy path: 七批确定性 workflowId; artifact→receipt→cursor 进 git; adopt 独立审批 + canonical 写; 完成闭环工作区干净(N33/ADR-0022)", async () => {
    const root = makeRoot();
    const plan = makePlan(root);
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const runWorkflowSpy = vi.spyOn(deepImportEngineSeam, "runWorkflow");
    const loadSpy = vi.spyOn(deepImportEngineSeam.GitRunPersistence.prototype, "loadRunState");
    const applySpy = vi.spyOn(deepImportEngineSeam.GitRunPersistence.prototype, "applyState");
    let r!: Awaited<ReturnType<typeof runDeepImportWorkflow>>;
    try {
      r = await runDeepImportWorkflow(root, plan, runtime(new MockProvider({ retryable: false, responses: happyResponses() }), approval));
      expect(runWorkflowSpy).toHaveBeenCalledTimes(1);
      expect(runWorkflowSpy.mock.calls[0][1]).toMatchObject({ mode: "start" });
      expect(loadSpy).toHaveBeenCalled();
      expect(applySpy.mock.calls.length).toBeGreaterThanOrEqual(20);
    } finally {
      runWorkflowSpy.mockRestore();
      loadSpy.mockRestore();
      applySpy.mockRestore();
    }

    // 结果形态与 legacy 一致
    expect(r.adopted).toBe(2);
    expect(r.committed).toHaveLength(2);
    expect(r.rejected).toBe(false);
    expect(r.aliases.approved).toBe(false); // 空建议 → 不请求 2b 审批
    expect(r.workflow_id).toMatch(/^imp-[0-9a-f]{16}-/);
    expect(existsSync(join(root, "scenes", "s001.md"))).toBe(true);

    // 确定性身份用纯函数证明，无需再跑一次完整 durable workflow。
    const inputFingerprint = deepImportInputFingerprint(
      root,
      plan,
      loadPolicyDefaults(),
      { scene_slicing: "v1", scene_enrichment: "v1" },
    );
    expect(makeWorkflowId("deep-import", inputFingerprint, plan.workflow_id)).toBe(r.workflow_id);

    // 审批: 仅 commit_scenes(独立 adopt 审批); 2b 空建议不弹审批(复核纪律)
    expect(approval.calls.map((c) => c.action)).toEqual(["采用章节候选"]);

    // run 状态全走 Git 持久化: manifest 7 批 completed + receipt 进 git 历史
    const runNs = `.assistant/import-runs/${r.workflow_id}`;
    expect(gitHeadHas(root, `${runNs}/run-plan.json`)).toBe(true);
    expect(gitHeadHas(root, `${runNs}/manifest.json`)).toBe(true);
    const manifest = JSON.parse(gitShow(root, `${runNs}/manifest.json`));
    expect((Object.values(manifest.batches) as Array<{ state: string }>).map((b) => b.state)).toEqual(
      Array(7).fill("completed"),
    );
    expect(manifest.status).toBe("completed");
    expect(manifest.profileFingerprint).toBe(sha("profile-v1"));
    // 每批 receipt 已提交且 resultHash 与 artifact 精确字节绑定
    for (const entry of Object.values(manifest.batches) as Array<{ artifactPath: string; receiptPath: string; resultHash: string }>) {
      expect(gitHeadHas(root, entry.artifactPath)).toBe(true);
      expect(gitHeadHas(root, entry.receiptPath)).toBe(true);
      const receipt = JSON.parse(gitShow(root, entry.receiptPath));
      expect(receipt.resultHash).toBe(entry.resultHash);
    }

    // adopt 经 canonical 事务: Scene 文件进 git 历史(commit 带 canonical txid trailer)
    const scenes = gitShow(root, "scenes/s001.md");
    expect(scenes).toContain('status: "draft"');
    expect(scenes).toContain(`workflow: "${r.workflow_id}"`);

    // 完成闭环: checkpoint(含授权快照/执行画像指纹)与 trace 进 git, 工作区干净
    expect(gitHeadHas(root, ".assistant/checkpoint.json")).toBe(true);
    expect(gitHeadHas(root, ".assistant/import-trace.jsonl")).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]);

    // trace 事件: begin_import 首条, complete_import 末条; adopt(commit_scenes)存在
    const events = readFileSync(join(root, ".assistant", "import-trace.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0].type).toBe("begin_import");
    expect(events[events.length - 1].type).toBe("complete_import");
    expect(events.some((e) => e.type === "adopt" && e.action === "commit_scenes")).toBe(true);
    // 2b 空建议: 无 approval(alias_relation)事件
    expect(events.some((e) => e.type === "approval" && e.action === "alias_relation")).toBe(false);
  });

  it("章节源字节变化产生新 fingerprint/workflow identity，不需要第二次全链运行(N33)", () => {
    const root = makeRoot();
    const plan = makePlan(root);
    const policy = loadPolicyDefaults();
    const contracts = { scene_slicing: "v1", scene_enrichment: "v1" };
    const first = deepImportInputFingerprint(root, plan, policy, contracts);
    writeFileSync(join(root, "chapters", "001.md"), readFileSync(join(root, "chapters", "001.md"), "utf8") + "\n作者补充。\n");
    const second = deepImportInputFingerprint(root, plan, policy, contracts);
    expect(second).not.toBe(first);
    expect(makeWorkflowId("deep-import", second, plan.workflow_id)).not.toBe(
      makeWorkflowId("deep-import", first, plan.workflow_id),
    );
  });

  itSlow("provider_outcome_unknown 不自动重试; 重新授权(allowed-once)后才重试该批, 已完成批不重跑(N33 §5.0/§8)", async () => {
    const root = makeRoot();
    const plan = makePlan(root);
    // 2a batch-plan 事务在 intent-ready 后崩溃(intent 已耐久、commit 未完成):
    // resume 先收敛同一事务补完 → 2a 呈现「计划已提交、无 artifact」=
    // provider_outcome_unknown —— 绝不自动重试(输入不变 → 同一 workflowId)。
    class Crash2aPlan extends deepImportEngineSeam.GitRunPersistence {
      armed = true;
      private lastPhase = "";
      constructor(r: string) {
        super(r, {
          transactionOptions: {
            gates: async (phase: string) => {
              if (this.armed && this.lastPhase === "2a" && phase === "intent-ready") {
                throw new CrashSimulatedError("crash-2a-plan");
              }
            },
          },
        });
      }
      override async applyState(tx: import("../src/index.js").RunStateTransaction) {
        this.lastPhase = (tx as { plan?: { phase?: string } }).plan?.phase ?? "";
        return super.applyState(tx);
      }
    }
    const OriginalPersistence = deepImportEngineSeam.GitRunPersistence;
    deepImportEngineSeam.GitRunPersistence = Crash2aPlan;
    const provider1 = new MockProvider({ retryable: false, responses: happyResponses() });
    const approval1 = new MockApproval({ decisions: ["allowed-once"] }); // commit 放行 → 2a 可达
    try {
      await expect(
        runDeepImportWorkflow(root, plan, runtime(provider1, approval1, { budget: createWorkflowBudget(1_000_000) })),
      ).rejects.toThrow(/crash-2a-plan/);
    } finally {
      deepImportEngineSeam.GitRunPersistence = OriginalPersistence;
    }
    // run1: 1a×2 + 1b×2 + 1c×1 + commit(0) = 5; 2a generator 未运行(计划事务先崩溃)
    expect(provider1.calls).toHaveLength(5);
    expect(approval1.calls).toHaveLength(1); // 仅 commit_scenes(独立 adopt 审批)
    const interruptedWorkflowId = readdirSync(join(root, '.assistant', 'import-runs'))[0];
    const manifestAfterCrash = JSON.parse(gitShow(root, `.assistant/import-runs/${interruptedWorkflowId}/manifest.json`));
    expect(manifestAfterCrash.budgetSpent).toBeGreaterThan(0);

    // 重新授权(reauthorizeRemaining → allowed-once)后才重试该批;
    // resume 只重跑 2a/2b/3 → provider 队列从 2a 响应开始(前 5 条 1a/1b/1c/commit 已消耗)
    const provider2 = new MockProvider({ retryable: false, responses: happyResponses().slice(5) });
    const reauth = vi.fn(async (info: { workflowId: string; batches: ReadonlyArray<{ batchId: string; phase: string }>; estimate: string }) => "allowed-once" as const);
    const r = await runDeepImportWorkflow(
      root,
      plan,
      runtime(provider2, new MockApproval({ decisions: ["allowed-once"] }), {
        reauthorizeRemaining: reauth,
        budget: createWorkflowBudget(1_000_000),
      }),
    );
    expect(r.adopted).toBe(2);
    // 重新授权请求: 只含 provider_outcome_unknown 批(2a), 已完成批不重跑
    expect(reauth).toHaveBeenCalledTimes(1);
    const info = reauth.mock.calls[0][0];
    expect(info.batches).toHaveLength(1);
    expect(info.batches[0].phase).toBe("2a");
    // provider 计数: run1 = 5(1a/1b/1c); run2 = 2a×2 + 2b×2 + 3×1 = 5; 总计 10
    expect(provider1.calls.length + provider2.calls.length).toBe(10);
    const manifest = JSON.parse(gitShow(root, `.assistant/import-runs/${r.workflow_id}/manifest.json`));
    expect(manifest.status).toBe("completed");
    expect(manifest.budgetSpent).toBeGreaterThan(manifestAfterCrash.budgetSpent);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  itSlow("重新授权被拒 → 仍不自动重试, 抛 provider_outcome_unknown(fail-closed)", async () => {
    const root = makeRoot();
    const plan = makePlan(root);
    class Crash2aPlan extends deepImportEngineSeam.GitRunPersistence {
      armed = true;
      private lastPhase = "";
      constructor(r: string) {
        super(r, {
          transactionOptions: {
            gates: async (phase: string) => {
              if (this.armed && this.lastPhase === "2a" && phase === "intent-ready") {
                throw new CrashSimulatedError("crash-2a-plan");
              }
            },
          },
        });
      }
      override async applyState(tx: import("../src/index.js").RunStateTransaction) {
        this.lastPhase = (tx as { plan?: { phase?: string } }).plan?.phase ?? "";
        return super.applyState(tx);
      }
    }
    const OriginalPersistence = deepImportEngineSeam.GitRunPersistence;
    deepImportEngineSeam.GitRunPersistence = Crash2aPlan;
    const provider1 = new MockProvider({ retryable: false, responses: happyResponses() });
    try {
      await runDeepImportWorkflow(root, plan, runtime(provider1, new MockApproval({ decisions: ["allowed-once"] }))).catch(() => {});
    } finally {
      deepImportEngineSeam.GitRunPersistence = OriginalPersistence;
    }
    const provider2 = new MockProvider({ retryable: false, responses: happyResponses() });
    const reauth = vi.fn(async (info: { workflowId: string; batches: ReadonlyArray<{ batchId: string; phase: string }>; estimate: string }) => "rejected" as const);
    await expect(
      runDeepImportWorkflow(root, plan, runtime(provider2, new MockApproval({ decisions: ["allowed-once"] }), { reauthorizeRemaining: reauth })),
    ).rejects.toMatchObject({ status: "provider_outcome_unknown" });
    expect(provider2.calls).toHaveLength(0); // 未重新授权 → 该批不重跑, 后续批不执行
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  itSlow("崩溃恢复: 事务中断(intent 已耐久未 commit)→ resume 补完同一事务, 不重跑 provider、不重复 apply(N33 §5.1/§6)", async () => {
    const root = makeRoot();
    const plan = makePlan(root);
    // 崩溃门控: 第 3 个事务(1a artifact-receipt)的 commit-object 阶段模拟 SIGKILL
    let txN = 0;
    let crashArmed = true;
    const transactionOptions = {
      gates: async (phase: string) => {
        if (phase === "intent-ready") txN += 1;
        if (crashArmed && txN === 3 && phase === "commit-object") {
          throw new CrashSimulatedError("crash-1a-artifact");
        }
      },
    };
    const provider1 = new MockProvider({ retryable: false, responses: happyResponses() });
    const approval1 = new MockApproval({ decisions: ["allowed-once"] });
    await expect(
      runDeepImportWorkflow(root, plan, runtime(provider1, approval1, { transactionOptions })),
    ).rejects.toThrow(/crash-1a-artifact/);
    expect(provider1.calls).toHaveLength(2); // 1a 两章 slice 已调用
    expect(approval1.calls).toHaveLength(0); // apply 未到达

    // 恢复: 同一输入重新调用 → resume(1a artifact 已提交 → 校验后补 cursor, 不重跑)
    crashArmed = false;
    // resume 从 1b 继续(1a 两章不重跑)→ provider 队列从 1b 响应开始
    const provider2 = new MockProvider({ retryable: false, responses: happyResponses().slice(2) });
    const approval2 = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImportWorkflow(root, plan, runtime(provider2, approval2, { transactionOptions }));
    expect(r.adopted).toBe(2);
    // provider 不重复: 1a 两章未重调(总 10 = run1 2 + run2 8)
    expect(provider1.calls.length + provider2.calls.length).toBe(10);
    // apply 不重复: commit_scenes 审批只发生一次(run2)
    expect(approval2.calls.map((c) => c.action)).toEqual(["采用章节候选"]);
    const manifest = JSON.parse(gitShow(root, `.assistant/import-runs/${r.workflow_id}/manifest.json`));
    expect(manifest.status).toBe("completed");
    expect(existsSync(join(root, "scenes", "s001.md"))).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  itSlow("2b 独立审批: 有实际变更才请求; allowed-once 后 canonical 写 + adopt(铁律3/N33 §6)", async () => {
    const root = makeRoot();
    seedCanonicalObjects(root);
    const plan = makePlan(root);
    const approval = new MockApproval({ decisions: ["allowed-once", "allowed-once"] });
    const trace = new TraceRecorder();
    const r = await runDeepImportWorkflow(root, plan, runtime(new MockProvider({ retryable: false, responses: richResponses() }), approval, { trace }));
    expect(r.aliases.approved).toBe(true);
    // legacy 契约(DeepImportResult.trace = runtime.trace ?? 新建 TraceRecorder):
    // 返回调用方传入的 trace 本身(而非 fanout wrapper), 保证 .all() 可检查。
    expect(r.trace).toBe(trace);
    expect(r.aliases.attached).toBe(1);
    expect(r.aliases.relations).toBe(1);
    expect(approval.calls.map((c) => c.action)).toEqual(["采用章节候选", "别名/关系写入(2b)"]);
    // 2b 审批明细含实际别名/目标对象
    expect(approval.calls[1].summary).toContain("红衣女子");
    expect(approval.calls[1].items.join()).toContain("obj-a");
    // canonical 写经事务进 git
    const objA = gitShow(root, "world/objects/obj-a.md");
    expect(objA).toContain("红衣女子");
    const events = (r.trace as TraceRecorder).all();
    expect(events.some((e) => e.type === "adopt" && e.action === "alias_relation")).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

});
