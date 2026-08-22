// imports · trace contract 行为契约(设计文档 §15 / ADR-0016 §1 / PLAN.md)。
// 用 MockProvider(@novelcraft/llm-step)+ MockApproval(@novelcraft/trace)跑 runDeepImport,
// 断言 §15 不变量: 顺序 / 审批 / checkpoint / 分片 / 降级 / 授权。
// 注释引用规则/裁定编号(沿用 phase1.test.ts 约定)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, gitHead, parseFrontmatter } from "@novelcraft/store";
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
import type { AdoptEvent, ApprovalEvent, RejectEvent, StageCandidatesEvent, TraceEvent, TraceEventInput, TraceSink } from "@novelcraft/trace";
import { planImport, runDeepImport, commitImportState } from "../src/index";
import type { DeepImportRuntime } from "../src/index";

const dirs: string[] = [];
function makeRoot(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), "ncitc-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  for (let i = 1; i <= n; i++) {
    ingestChapter(root, { chapterIndex: i, text: "第" + i + "章正文。", source: "paste" });
  }
  // R17: commitScenes 写前要求范围外干净工作区 → 夹具先提交初始状态
  // (planImport 的 checkpoint 与深导 trace 属导入流程工件, 不视为脏)。
  gitAdd(root);
  gitCommit(root, "fixture init");
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

/** 本仓库每书一 git vault; 返回全部 commit message(新→旧)。 */
function gitLog(root: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** porcelain 状态行(非空即脏)。 */
function gitStatus(root: string): string[] {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** HEAD 树中是否存在相对路径(深导工件是否已进 git 历史)。 */
function gitHeadHas(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** HEAD 提交实际包含的文件相对路径(-z 原始输出, 精确断言 state commit 不捕获其他文件)。 */
function gitHeadFiles(root: string): string[] {
  return execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

/** 造三个 canonical 对象(obj-a/obj-b 为 2b 可写目标; obj-c 为「非写关系目标」, N23 必填齐备)。 */
function seedCanonicalObjects(root: string): void {
  writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
  writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
  writeFileSync(join(root, "world", "objects", "obj-c.md"), '---\nid: obj-c\nkind: "character"\nname: "人物丙"\nstatus: canonical\n---\n');
  gitAdd(root);
  gitCommit(root, "seed objects");
}

/** world/objects/*.md 原始字节快照(断言 2b 拒绝时对象文件不变)。 */
function objectSnapshots(root: string): Record<string, string> {
  const a = readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8");
  const b = readFileSync(join(root, "world", "objects", "obj-b.md"), "utf8");
  return { a, b };
}

/**
 * 带 git HEAD 感知的 trace sink: 每条事件记录时捕获 HEAD + 最新 commit subject。
 * 用于断言「adopt(alias_relation) 必须在 2b commit 之后 emit」——adopt 记录时刻的
 * HEAD 主题应已含 alias/relation; 而该 approval 记录时刻的 HEAD 主题尚未含(即
 * propose/approval 阶段零 commit, apply 的 commit 严格夹在 approval 与 adopt 之间)。
 */
function headAwareSink(root: string, inner: TraceSink): { sink: TraceSink; snapshots: Array<{ event: TraceEventInput; head: string; subject: string }> } {
  const snapshots: Array<{ event: TraceEventInput; head: string; subject: string }> = [];
  const sink: TraceSink = {
    record(event: TraceEventInput): TraceEvent {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const subject = gitLog(root)[0] ?? "";
      snapshots.push({ event, head, subject });
      return inner.record(event);
    },
  };
  return { sink, snapshots };
}

/** 1 章(1 Scene)全链响应, 2b 本轮产出 1 别名 + 1 关系(供非空 2b 审批测试)。 */
function nonEmpty2bResponses(): Array<{ text?: string; throwError?: Error }> {
  return [
    { text: JSON.stringify({ scenes: [sceneJson(1, "S1", "A1")] }) },
    { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
    { text: JSON.stringify({ entities: [] }) },
    {
      text: JSON.stringify({
        aliases: [{ entity_ref: "人物甲", alias: "红衣女子", confidence: 0.8 }],
        relations: [{ source_ref: "人物乙", target_ref: "人物甲", relation_type: "associate", confidence: 0.8 }],
        uncertain_items: [],
      }),
    },
    { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
  ];
}

/** 1 章全链响应, 2b 产出 1 别名(→obj-a)+ 1 关系(obj-a associate obj-c)。
 *  obj-c 是「非写关系目标」: 别名/关系都落在 obj-a, obj-c 只被引用不落盘,
 *  用于验证慢 LLM/审批窗口期间 obj-c 消失时零写 fail-closed。 */
function danglingTargetResponses(): Array<{ text?: string; throwError?: Error }> {
  return [
    { text: JSON.stringify({ scenes: [sceneJson(1, "S1", "A1")] }) },
    { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
    { text: JSON.stringify({ entities: [] }) },
    {
      text: JSON.stringify({
        aliases: [{ entity_ref: "人物甲", alias: "红衣女子", confidence: 0.8 }],
        relations: [{ source_ref: "人物甲", target_ref: "人物丙", relation_type: "associate", confidence: 0.8 }],
        uncertain_items: [],
      }),
    },
    { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
  ];
}

describe("runDeepImport · 顺序(§15: begin_import 先于 stage_candidates 先于 adopt)", () => {
  it("全链 happy path: 顺序不变量 + adopt 前过审批; 2b 空建议 → 无 alias_relation 审批/adopt", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    // 复核纪律: 2b 只读 propose 后无实际变更(空建议)→ 不请求第二审批/不 adopt;
    // 只有 commit_scenes 需要决策。
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    expect(r.adopted).toBe(2);
    assertOrdered(recorder, "begin_import", "stage_candidates"); // §15
    assertOrdered(recorder, "stage_candidates", "adopt"); // §15/§12
    // 只有 Scene 采用一次 adopt(2b 空建议无实际变更, 无写面无独立 adopt)
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes"]);
    // 2b 无独立审批请求(approval 仅 commit_scenes 一次)
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes"]);
  });
});

describe("runDeepImport · 审批(§9/§15: adopt 必过 approval, fail-closed)", () => {
  it("allowed-once → adopt 且 commit", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    // 2b 空建议无实际变更 → 只需 commit_scenes 一次决策
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const r = await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    expect(r.rejected).toBe(false);
    expect(r.committed).toHaveLength(2);
    assertEveryAdoptApproved(recorder); // 每个 adopt 前必有独立 approval=allowed-once
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

describe("runDeepImport · commit adopt 时序(复核: adopt 在 commitScenes 成功后, 仅实际创建才记录)", () => {
  it("放行但全 skip(幂等重跑, created=0)→ 无 adopt(commit_scenes), 只记录实际创建", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    // 第一次跑创建 2 Scene(fixture 已提交, provenance_key 落库)。
    await runDeepImport(root, plan, runtime(2, new MockApproval({ decisions: ["allowed-once"] }), { trace: new TraceRecorder() }));
    // 第二次同 scope 重跑: commitScenes 全 provenance skip → created=0;
    // 审批(commit_scenes)仍请求且放行, 但 adopt 必须不出现(零创建无 adopt)。
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    const run2 = await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });
    expect(run2.committed).toHaveLength(0);
    expect(run2.skipped).toHaveLength(2);
    // 审批放行(顺序不变)但零创建 → 无 adopt 事件(不再把全部候选记作 adopted)
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes"]);
    expect(approves[0].decision).toBe("allowed-once");
    expect(recorder.eventsOf("adopt")).toHaveLength(0);
    expect(() => assertEveryAdoptApproved(recorder)).not.toThrow();
  });

  it("commitScenes 抛错(R17 脏工作区)→ 无 adopt(commit_scenes) 假记录", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] });
    // 审批放行回调内写范围外脏文件 → commitScenes 的 R17 门禁抛 DIRTY_WORKSPACE:
    // adopt 若在 commitScenes 前 emit 就会留下假记录; 修复后必须零 adopt。
    const approve = async (action: string, summary: string, items: string[]) => {
      const d = await approval.approve(action, summary, items);
      if (action === "采用章节候选" && d === "allowed-once") {
        writeFileSync(join(root, "untracked-notes.md"), "手改未提交", "utf8");
      }
      return d;
    };
    await expect(
      runDeepImport(root, plan, {
        provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
        approve,
        trace: recorder,
      }),
    ).rejects.toMatchObject({ code: "DIRTY_WORKSPACE" });
    // approval 已放行, 但 commit 失败 → 无 adopt、无 complete_import(异常中断)
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes"]);
    expect(approves[0].decision).toBe("allowed-once");
    expect(recorder.eventsOf("adopt")).toHaveLength(0);
    expect(recorder.eventsOf("complete_import")).toHaveLength(0);
  });
});

describe("runDeepImport · checkpoint(§15/R42/R43: 每 phase 后 checkpoint, input_fingerprint 幂等)", () => {
  it("六阶段每 phase 后必有 checkpoint", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 2b 空建议无第二审批; 每 phase(含 2b)后仍写 checkpoint
    await runDeepImport(root, plan, runtime(2, approval, { trace: recorder }));
    assertCheckpointAfterPhase(recorder, ["1a", "1b", "1c", "commit", "2a", "2b", "3"]);
  });
  it("同 scope 重跑: input_fingerprint 一致 + provenance_key skip(幂等续跑)", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    // run1: 2b 空建议无实际变更 → 只消费 commit_scenes 一次决策
    const approval1 = new MockApproval({ decisions: ["allowed-once"] });
    const run1 = await runDeepImport(root, plan, runtime(2, approval1, { trace: new TraceRecorder() }));
    // 第二次跑: 阶段函数幂等(commitScenes provenance_key skip), 无新 commit 可消费;
    // 2b 无写面 → 亦不请求 2b 审批(只需 commit_scenes 1 次)。
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
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 2b 空建议无第二审批
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
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 2b 空建议无第二审批
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
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 2b 空建议无第二审批
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
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 2b propose 失败 → 降级, 无实际变更 → 无第二审批
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

describe("runDeepImport · 2b 独立审批(只读 propose → 汇总实际变更 → 审批 → apply; 拒绝不写 canonical)", () => {
  it("非空 2b 被拒 → 审批捕获实际对象/别名/关系明细; 对象文件/commit 不变, Scene 仍采用", async () => {
    const root = makeRoot(1);
    seedCanonicalObjects(root);
    const before = objectSnapshots(root);
    const commitsBefore = gitLog(root).length;
    const recorder = new TraceRecorder();
    // 决策序列: 1 = commit_scenes(Scene 采用放行); 2 = alias_relation(2b 独立审批拒绝)。
    const approval = new MockApproval({ decisions: ["allowed-once", "rejected"] });
    const r = await runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), {
      provider: new MockProvider({ retryable: false, responses: nonEmpty2bResponses() }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });

    // 复核: 审批 request 在只读 propose 之后发起, summary/items 必须列出实际将改写的
    // 目标对象与别名/关系(而非只有 Scene slug)——用户能据明细决定拒绝/放行。
    expect(approval.calls).toHaveLength(2);
    const aliasCall = approval.calls[1];
    expect(aliasCall.action).toBe("别名/关系写入(2b)");
    expect(aliasCall.items).toEqual(["obj-a: +别名「红衣女子」", "obj-b: +关系 associate→obj-a"]);
    expect(aliasCall.summary).toContain("红衣女子");
    expect(aliasCall.summary).toContain("obj-a");
    expect(aliasCall.summary).toContain("obj-b");
    expect(aliasCall.summary).toContain("associate");
    expect(aliasCall.summary).toContain("2 个 canonical 对象");

    // Scene 已采用 → 整体不被 2b 拒绝误标为全部拒绝
    expect(r.rejected).toBe(false);
    expect(r.committed).toHaveLength(1);
    // 2b 独立审批被拒 → 未写 canonical, summary 清楚标记 approved=false + decision
    expect(r.aliases.approved).toBe(false);
    expect(r.aliases.decision).toBe("rejected");
    expect(r.aliases.attached).toBe(0);
    expect(r.aliases.relations).toBe(0);
    // 拒绝时 provider 确已运行并产生建议, 但 canonical 字节/commit 不变
    expect(objectSnapshots(root)).toEqual(before);
    // 相较 seed 只多 Scene adopt 一次 commit + 深导 state commit(checkpoint/trace 进 git):
    // 无 2b commit
    const log = gitLog(root);
    expect(log.length).toBe(commitsBefore + 2);
    expect(log.some((m) => m.includes("alias/relation"))).toBe(false);
    // 深导完成后工作区洁净(state commit 只收工件, 不捕获其他文件), checkpoint/trace 入 HEAD
    expect(log[0]).toContain("deep-import state");
    expect(gitStatus(root)).toEqual([]);

    // trace: 独立 approval(alias_relation) + reject; 无 adopt(alias_relation)(只有实际执行写面才记录)
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes", "alias_relation"]);
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes"]);
    const rejects = recorder.eventsOf("reject") as RejectEvent[];
    expect(rejects.map((e) => ({ action: e.action, decision: e.decision }))).toEqual([{ action: "alias_relation", decision: "rejected" }]);
    expect(() => assertEveryAdoptApproved(recorder)).not.toThrow();
    // checkpoint 正常(2b 阶段收尾)
    assertCheckpointAfterPhase(recorder, ["2b"]);
  });

  it("非空 2b 放行 → canonical 对象被改写 + 恰一次 2b commit + adopt 在 commit 后 emit", async () => {
    const root = makeRoot(1);
    seedCanonicalObjects(root);
    const commitsBefore = gitLog(root).length;
    const recorder = new TraceRecorder();
    const { sink, snapshots } = headAwareSink(root, recorder);
    // 决策序列: 1 = commit_scenes; 2 = alias_relation(2b 独立审批放行)。
    const approval = new MockApproval({ decisions: ["allowed-once", "allowed-once"] });
    const r = await runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), {
      provider: new MockProvider({ retryable: false, responses: nonEmpty2bResponses() }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: sink,
    });

    expect(r.rejected).toBe(false);
    expect(r.aliases.approved).toBe(true);
    expect(r.aliases.decision).toBe("allowed-once");
    expect(r.aliases.attached).toBe(1); // 红衣女子 → obj-a
    expect(r.aliases.relations).toBe(1); // 人物乙 associate 人物甲 → obj-b
    // 审批明细: 列出目标对象与增量别名/关系(用户可见实际变更)
    expect(approval.calls[1].summary).toContain("红衣女子");
    expect(approval.calls[1].items).toEqual(["obj-a: +别名「红衣女子」", "obj-b: +关系 associate→obj-a"]);
    // canonical 对象被 2b 改写(N14 list 形态 + 铁律5 默认 candidate)
    const aFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).data;
    expect((aFm.aliases as string[])).toContain("红衣女子");
    const bFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-b.md"), "utf8")).data;
    expect(bFm.relations).toEqual([{ target: "obj-a", type: "associate", status: "candidate" }]);
    // 恰一次 2b commit + 恰一次深导 state commit(Scene adopt + 2b + state = 比 seed 多 3 次
    // commit, 且 alias/relation 恰好 1 次); 完成后工作区洁净
    const log = gitLog(root);
    expect(log.length).toBe(commitsBefore + 3);
    expect(log.filter((m) => m.includes("alias/relation"))).toHaveLength(1);
    expect(log[0]).toContain("deep-import state"); // state commit 在 complete 闭环最后
    expect(gitStatus(root)).toEqual([]);

    // trace: 两处 adopt(commit_scenes + alias_relation), 每个前均有独立 approval=allowed-once
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes", "alias_relation"]);
    expect(adopts[1].items).toEqual(["obj-a", "obj-b"]); // adopt 记录实际被改写的对象
    expect(() => assertEveryAdoptApproved(recorder)).not.toThrow();
    assertCheckpointAfterPhase(recorder, ["2b"]);

    // 复核(adopt 时序): adopt(alias_relation) 必须在其 commit 之后 emit ——
    // approval(alias_relation) 记录时 HEAD 还是 Scene commit(主题无 alias/relation);
    // adopt(alias_relation) 记录时 HEAD 已是 alias/relation commit。apply 的 commit
    // 严格夹在 approval 与 adopt 之间, 证明 adopt 不在写前发出。
    const aliasApprovalSnap = snapshots.find((s) => s.event.type === "approval" && s.event.action === "alias_relation");
    const aliasAdoptSnap = snapshots.find((s) => s.event.type === "adopt" && s.event.action === "alias_relation");
    expect(aliasApprovalSnap).toBeDefined();
    expect(aliasAdoptSnap).toBeDefined();
    expect(aliasApprovalSnap!.subject).not.toContain("alias/relation");
    expect(aliasAdoptSnap!.subject).toContain("alias/relation");
  });

  it("2b 空建议 → 无第二审批/adopt/commit; 2b 标 no_changes(不请求 approval)", async () => {
    const root = makeRoot(1);
    const commitsBefore = gitLog(root).length;
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 仅 commit_scenes
    const r = await runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), {
      provider: new MockProvider({ retryable: false, responses: happyResponses(1) }),
      approve: (a, s, items) => approval.approve(a, s, items),
      trace: recorder,
    });

    // 只读 propose 后无实际变更 → 不请求 2b 审批(approval 仅 commit_scenes 一次)
    expect(approval.calls).toHaveLength(1);
    expect(approval.calls[0].action).toBe("采用章节候选");
    // 无 adopt(alias_relation)、无 reject; 结果面 approved=false 且无 decision(从未请求)
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes"]);
    expect(recorder.eventsOf("approval")).toHaveLength(1);
    expect(recorder.eventsOf("reject")).toHaveLength(0);
    expect(r.aliases.approved).toBe(false);
    expect(r.aliases.decision).toBeUndefined();
    expect(r.aliases.attached).toBe(0);
    expect(r.aliases.relations).toBe(0);
    // 无 2b commit: 相较 fixture 只多 Scene adopt 一次 commit + 深导 state commit, 且无
    // alias/relation 主题; 完成后工作区洁净
    expect(gitLog(root).length).toBe(commitsBefore + 2);
    expect(gitLog(root).some((m) => m.includes("alias/relation"))).toBe(false);
    expect(gitLog(root)[0]).toContain("deep-import state");
    expect(gitStatus(root)).toEqual([]);
    // 2b 阶段仍收尾 checkpoint
    assertCheckpointAfterPhase(recorder, ["2b"]);
  });

  it("关系目标在 propose 后、plan 时已消失 → VALIDATION_FAILED, 零写零 commit 无 adopt", async () => {
    const root = makeRoot(1);
    seedCanonicalObjects(root);
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once"] }); // 仅 commit_scenes; plan 失败于 2b 审批前
    const inner = new MockProvider({ retryable: false, responses: danglingTargetResponses() });
    // 模拟慢 LLM 期间关系目标被删除: propose 解析 byName 时 obj-c 尚在(建议不 skip),
    // alias_relation 步(全链第 4 次 provider 调用)返回后立即删除 obj-c → plan 重新校验
    // 「存在 + status=canonical」时发现目标消失, fail-closed 零写。
    let calls = 0;
    const provider: Provider = {
      async complete(req) {
        const resp = await inner.complete(req);
        calls += 1;
        if (calls === 4) rmSync(join(root, "world", "objects", "obj-c.md"));
        return resp;
      },
    };
    await expect(
      runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), {
        provider,
        approve: (a, s, items) => approval.approve(a, s, items),
        trace: recorder,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // 零写: obj-a 未加别名/关系(plan 校验失败于首个 write 前)
    const aFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).data;
    expect(aFm.aliases).toBeUndefined();
    expect(aFm.relations).toBeUndefined();
    // 无 adopt(alias_relation), 2b 审批也从未发起(plan 失败先于审批)
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes"]);
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes"]);
    // 无 alias/relation commit
    expect(gitLog(root).some((m) => m.includes("alias/relation"))).toBe(false);
  });

  it("关系目标在 approval 后、apply 前移出 canonical → CONFLICT, 零写零 commit 无 adopt", async () => {
    const root = makeRoot(1);
    seedCanonicalObjects(root);
    const recorder = new TraceRecorder();
    const approval = new MockApproval({ decisions: ["allowed-once", "allowed-once"] });
    // 模拟批准期间并发作者把关系目标 obj-c(非写目标)移出 canonical: 提交 status 变更
    // (保持工作区干净, 让 apply 走到目标 canonical 复查而非 R17 脏工作区拦截)。
    // touched CAS(obj-a)通过后, 非 touched 目标复查发现 obj-c 已 deprecated → CONFLICT 零写。
    const approve = async (action: string, summary: string, items: string[]) => {
      const d = await approval.approve(action, summary, items);
      if (action === "别名/关系写入(2b)" && d === "allowed-once") {
        writeFileSync(join(root, "world", "objects", "obj-c.md"), '---\nid: obj-c\nkind: "character"\nname: "人物丙"\nstatus: deprecated\n---\n');
        gitAdd(root);
        gitCommit(root, "deprecate obj-c");
      }
      return d;
    };
    await expect(
      runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), {
        provider: new MockProvider({ retryable: false, responses: danglingTargetResponses() }),
        approve,
        trace: recorder,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 零写: obj-a 未加别名/关系(apply 复查失败于首个 write 前)
    const aFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).data;
    expect(aFm.aliases).toBeUndefined();
    expect(aFm.relations).toBeUndefined();
    // approval(alias_relation) 已记录(plan 非空), 但 adopt(alias_relation) 不出现(apply 失败)
    const approves = recorder.eventsOf("approval") as ApprovalEvent[];
    expect(approves.map((e) => e.action)).toEqual(["commit_scenes", "alias_relation"]);
    const adopts = recorder.eventsOf("adopt") as AdoptEvent[];
    expect(adopts.map((e) => e.action)).toEqual(["commit_scenes"]);
    expect(recorder.eventsOf("reject")).toHaveLength(0); // 异常路径, 非 reject 决策
    // 无 alias/relation commit
    expect(gitLog(root).some((m) => m.includes("alias/relation"))).toBe(false);
  });
});

describe("runDeepImport · 完成后 state commit(深导工件进 git 历史, 工作区不残留脏)", () => {
  it("happy 闭环: 最后恰一次 deep-import state commit, checkpoint 进 HEAD, 工作区 clean", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const r = await runDeepImport(root, plan, runtime(2, new MockApproval({ decisions: ["allowed-once"] })));
    expect(r.adopted).toBe(2);

    // 深导完成 = 工作区洁净(不再有 ?? .assistant/ 卡住后续 store adopt 的全局洁净检查)
    expect(gitStatus(root)).toEqual([]);
    // 最后一条 commit 是 state commit, checkpoint/trace 工件进 git 历史(trace contract §15/§22.2)
    expect(gitLog(root)[0]).toContain("deep-import state");
    expect(gitHeadHas(root, ".assistant/checkpoint.json")).toBe(true);
    // 内存 sink: trace 无落盘文件 → 只提交 checkpoint, 不产生 import-trace.jsonl
    expect(gitHeadHas(root, ".assistant/import-trace.jsonl")).toBe(false);
    expect(existsSync(join(root, ".assistant", "checkpoint.json"))).toBe(true);
  });

  it("Scene 审批拒绝(rejected 闭环): 仍做 state commit, 工作区 clean, 零 Scene commit", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const r = await runDeepImport(root, plan, runtime(2, new MockApproval({ decisions: ["rejected"] })));
    expect(r.rejected).toBe(true);
    expect(r.committed).toHaveLength(0);

    expect(gitStatus(root)).toEqual([]);
    expect(gitLog(root)[0]).toContain("deep-import state");
    expect(gitHeadHas(root, ".assistant/checkpoint.json")).toBe(true);
    expect(gitLog(root).some((m) => m.includes("deep-import scenes commit"))).toBe(false);
  });

  it("state commit 幂等: 完成后再次 commitImportState 无变化 → 不新增 commit", async () => {
    const root = makeRoot(1);
    const plan = planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    await runDeepImport(root, plan, runtime(1, new MockApproval({ decisions: ["allowed-once"] })));
    expect(gitStatus(root)).toEqual([]);

    const before = gitLog(root).length;
    commitImportState(root); // 工件均已提交且无变化 → 零提交
    expect(gitLog(root).length).toBe(before);
    expect(gitStatus(root)).toEqual([]);
  });

  it("commitImportState 前置门禁: 范围外预存 staged 文件 → DIRTY_WORKSPACE, HEAD 不变、外部文件仍 staged", async () => {
    const root = makeRoot(1);
    writeFileSync(join(root, ".assistant", "checkpoint.json"), JSON.stringify({ plan: { workflow_id: "w1" } }, null, 2) + "\n");
    writeFileSync(join(root, ".assistant", "import-trace.jsonl"), JSON.stringify({ type: "begin_import" }) + "\n");
    // 预存 staged 外部文件: 普通 `git commit` 会把 index 里已 staged 的内容一起提交
    // → helper 必须前置 R17 门禁 fail-closed, 不能只靠「只 add 工件」规避。
    writeFileSync(join(root, "staged-notes.md"), "预存 staged 外部文件", "utf8");
    gitAdd(root, ["staged-notes.md"]);
    const headBefore = gitHead(root);

    expect(() => commitImportState(root)).toThrow(expect.objectContaining({ code: "DIRTY_WORKSPACE" }));
    // 零新 commit; 外部文件仍 staged 未被提交; 工件也未被 stage/commit
    expect(gitHead(root)).toBe(headBefore);
    expect(gitHeadHas(root, "staged-notes.md")).toBe(false);
    expect(gitStatus(root).some((l) => l.includes("staged-notes.md"))).toBe(true);
    expect(gitHeadHas(root, ".assistant/checkpoint.json")).toBe(false);
    expect(gitHeadHas(root, ".assistant/import-trace.jsonl")).toBe(false);
  });

  it("commitImportState 前置门禁: 范围外未跟踪文件同样 fail-closed, 工件不进 HEAD", async () => {
    const root = makeRoot(1);
    writeFileSync(join(root, ".assistant", "checkpoint.json"), JSON.stringify({ plan: { workflow_id: "w1" } }, null, 2) + "\n");
    writeFileSync(join(root, "untracked-notes.md"), "手改未提交", "utf8");
    const headBefore = gitHead(root);

    expect(() => commitImportState(root)).toThrow(expect.objectContaining({ code: "DIRTY_WORKSPACE" }));
    expect(gitHead(root)).toBe(headBefore);
    expect(gitHeadHas(root, ".assistant/checkpoint.json")).toBe(false);
    // 外部未跟踪文件原样保留; 工件也仍是未跟踪(helper 抛错于任何 stage 之前)
    expect(gitStatus(root)).toContain("?? untracked-notes.md");
    expect(gitStatus(root)).toContain("?? .assistant/");
  });

  it("commitImportState 通过门禁后精确提交: 只收 checkpoint/trace 两工件", async () => {
    const root = makeRoot(1);
    writeFileSync(join(root, ".assistant", "checkpoint.json"), JSON.stringify({ plan: { workflow_id: "w1" } }, null, 2) + "\n");
    writeFileSync(join(root, ".assistant", "import-trace.jsonl"), JSON.stringify({ type: "begin_import" }) + "\n");

    commitImportState(root);

    expect(gitStatus(root)).toEqual([]);
    expect(gitLog(root)[0]).toContain("deep-import state");
    expect(gitHeadFiles(root)).toEqual([".assistant/checkpoint.json", ".assistant/import-trace.jsonl"]);
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
