// imports Phase 1 行为契约(PLAN.md / store-rules / imports.md)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, parseFrontmatter, validateFrontmatter } from "@novelcraft/store";
import { ingestChapter } from "@novelcraft/writing";
import { commitScenes, enrichSceneBatch, fuseSceneBatch, normalizeNarrativeTag, planImport, provenanceKey, readCheckpoint, sliceChapterBatch } from "../src/index";
import type { SceneCandidate } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nci-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "第一章正文。", source: "paste" });
  ingestChapter(root, { chapterIndex: 2, text: "第二章正文。", source: "paste" });
  // R17: commitScenes 写前要求范围外干净工作区 → 夹具先提交初始状态。
  gitAdd(root);
  gitCommit(root, "fixture init");
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sceneJson(chapter: number, title: string, anchor: string) {
  return {
    title, start_chapter: chapter, end_chapter: chapter,
    start_anchor: anchor, end_anchor: anchor, confidence: 0.9,
  };
}

describe("planImport(授权快照)", () => {
  it("未确认抛错; 确认后写 checkpoint; 同 scope 幂等", () => {
    const root = makeRoot();
    expect(() => planImport(root, { startChapter: 1, endChapter: 2, confirmed: false })).toThrow(/authorization_confirmed/);
    const p1 = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    expect(p1.authorization.authorization_confirmed).toBe(true);
    expect(readCheckpoint(root)?.plan).toBeDefined();
    const p2 = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    expect(p2.workflow_id).toBe(p1.workflow_id); // 幂等
  });
});

describe("sliceChapterBatch(1a 降级条款)", () => {
  it("逐章切分; 单章失败整章 fallback 不影响他章", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      retryable: false,
      responses: [
        { throwError: new Error("boom") }, // 第 1 章失败
        { text: JSON.stringify({ scenes: [sceneJson(2, "第二章场景", "A2")] }) },
      ],
    });
    const r = await sliceChapterBatch(provider, root, [1, 2]);
    expect(r.failed_chapters).toEqual([1]);
    expect(r.items.filter((i) => i.fallback_required)).toHaveLength(1);
    expect(r.items.filter((i) => !i.fallback_required)[0].payload.title).toBe("第二章场景");
  });
  it("空 scenes → 整章 fallback", async () => {
    const root = makeRoot();
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ scenes: [] }) }] });
    const r = await sliceChapterBatch(provider, root, [1]);
    expect(r.failed_chapters).toEqual([1]);
  });
});

describe("enrichSceneBatch(1b 降级条款)", () => {
  const base: SceneCandidate = {
    candidate_id: "c1", source_round: "A", source_chapter_indices: [1],
    source_candidate_ids: [], operation: "kept", quality: "high", confidence: 0.9,
    fallback_required: false, needs_review: false, review_reason: "",
    phase: "phase1a_slicing", payload: { title: "S1" },
  };
  it("provider 失败 → 空语义 + narrative_tag=draft + 进复核", async () => {
    const provider = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const out = await enrichSceneBatch(provider, [base]);
    expect(out[0].needs_review).toBe(true);
    expect(out[0].payload.narrative_tag).toBe("draft");
    expect(out[0].payload.emotional_beat).toBeUndefined();
  });
  it("成功补全字段", async () => {
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ emotional_beat: "紧张", narrative_tag: "climax", confidence: 0.8 }) }],
    });
    const out = await enrichSceneBatch(provider, [base]);
    expect(out[0].payload.emotional_beat).toBe("紧张");
    expect(out[0].payload.narrative_tag).toBe("climax");
  });
});

describe("fuseSceneBatch(1c R60 归一)", () => {
  const mk = (id: string): SceneCandidate => ({
    candidate_id: id, source_round: "A", source_chapter_indices: [1],
    source_candidate_ids: [], operation: "kept", quality: "high", confidence: 0.9,
    fallback_required: false, needs_review: false, review_reason: "",
    phase: "phase1a_slicing", payload: { title: id },
  });
  it("合法 relation 保留, 未知值拒绝该条", async () => {
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          boundaries: [
            { left_candidate_id: "a", right_candidate_id: "b", relation: "same_scene", fusion_intent: "merged", confidence: 0.95 },
            { left_candidate_id: "b", right_candidate_id: "c", relation: "nope", confidence: 0.5 },
          ],
        }),
      }],
    });
    const out = await fuseSceneBatch(provider, [{ left: mk("a"), right: mk("b") }]);
    expect(out).toHaveLength(1);
    expect(out[0].fusion_intent).toBe("merged");
  });
});

describe("commitScenes(幂等/冲突/归一)", () => {
  function candidate(chapter: number, anchor: string): SceneCandidate {
    return {
      candidate_id: `ch${chapter}-${anchor}`, source_round: "A", source_chapter_indices: [chapter],
      source_candidate_ids: [], operation: "kept", quality: "high", confidence: 0.9,
      fallback_required: false, needs_review: false, review_reason: "",
      phase: "phase1a_slicing",
      payload: { title: `Scene ${anchor}`, start_anchor: anchor, end_anchor: anchor, narrative_tag: "imported" },
    };
  }
  it("创建 scenes + git commit; narrative_tag imported→draft(R61)", () => {
    const root = makeRoot();
    const r = commitScenes(root, [candidate(1, "A1"), candidate(2, "A2")], { workflowId: "w1" });
    expect(r.created).toHaveLength(2);
    const raw = readFileSync(join(root, "scenes", "s001.md"), "utf8");
    expect(raw).toContain('narrative_tag: "draft"');
    expect(raw).toContain("provenance_key:");
  });
  it("scene 必填齐备: scene_index/source 落盘且过 schema(frontmatter.ts:436)", () => {
    const root = makeRoot();
    commitScenes(root, [candidate(1, "A1")], { workflowId: "w1" });
    const raw = readFileSync(join(root, "scenes", "s001.md"), "utf8");
    expect(raw).toContain("scene_index: 1"); // 序贯整数, 与 id(slug 数字)同源
    expect(raw).toContain('source: "deep_import"'); // 深度导入写点语义
    const { data } = parseFrontmatter(raw);
    expect(validateFrontmatter("scene", data as never)).toEqual([]);
  });
  it("同 provenance_key 重放 → skip(幂等)", () => {
    const root = makeRoot();
    const c = candidate(1, "A1");
    const first = commitScenes(root, [c], { workflowId: "w1" });
    expect(first.created).toHaveLength(1);
    const second = commitScenes(root, [c], { workflowId: "w1" });
    expect(second.skipped).toHaveLength(1);
    expect(second.created).toHaveLength(0);
  });
  it("fallback 候选计数", () => {
    const root = makeRoot();
    const c = candidate(1, "A1");
    const fb = { ...c, candidate_id: "fb", fallback_required: true, needs_review: true, review_reason: "fallback" };
    const r = commitScenes(root, [c, fb], { workflowId: "w1" });
    expect(r.fallbacks).toBe(1);
  });
  it("scene fm 校验失败(title 类型非法)→ fail-closed 拒写且不产生文件(N23)", () => {
    const root = makeRoot();
    // N23(用户裁定): 落盘前按 'scene' schema 校验最终 fm; title 应为 string, 数字触发 INVALID_TYPE。
    const bad = { ...candidate(1, "A1"), payload: { ...candidate(1, "A1").payload, title: 42 } } as unknown as SceneCandidate;
    let err: unknown = null;
    try {
      commitScenes(root, [bad], { workflowId: "w1" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" }); // N23 fail-closed: 校验失败即抛 StoreError
    expect(existsSync(join(root, "scenes", "s001.md"))).toBe(false); // 不产生文件
  });
  it("整批先校验后写: 后项校验失败 → 前项(合法)也不落盘(整批原子)", () => {
    const root = makeRoot();
    const good = candidate(1, "A1");
    const bad = { ...candidate(2, "A2"), payload: { ...candidate(2, "A2").payload, title: 42 } } as unknown as SceneCandidate;
    let err: unknown = null;
    try {
      commitScenes(root, [good, bad], { workflowId: "w1" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(existsSync(join(root, "scenes", "s001.md"))).toBe(false); // 合法项也不写
    expect(existsSync(join(root, "scenes", "s002.md"))).toBe(false);
  });
  it("scene id 按现存合法 max(scene_index, sNNN)+1, 不复用空洞(已证实覆盖修复)", () => {
    const root = makeRoot();
    // 现存 s001(idx1)、s003(idx3)(空洞 s002): existing.length+1=3 会复用 s003 覆盖,
    // 修复后必须取 max=3 → 下一个 s004。
    writeFileSync(join(root, "scenes", "s001.md"), "---\nid: s001\nstatus: draft\nscene_index: 1\ntitle: 旧1\n---\n");
    writeFileSync(join(root, "scenes", "s003.md"), "---\nid: s003\nstatus: draft\nscene_index: 3\ntitle: 旧3\n---\n");
    gitAdd(root); gitCommit(root, "existing scenes");
    const before = readFileSync(join(root, "scenes", "s003.md"), "utf8");
    const r = commitScenes(root, [candidate(1, "A1")], { workflowId: "w1" });
    expect(r.created).toEqual(["s004"]);
    expect(readFileSync(join(root, "scenes", "s003.md"), "utf8")).toBe(before); // 旧文件未被覆盖
  });
  it("同批重复 provenance(同候选重复入参)→ 只落一份, 其余 skip", () => {
    const root = makeRoot();
    const c = candidate(1, "A1");
    const r = commitScenes(root, [c, c], { workflowId: "w1" });
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(readdirSync(join(root, "scenes")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });
  it("同批重复锚点(同章同 start_anchor)→ 只落一份, 后者锚点冲突", () => {
    const root = makeRoot();
    const a = candidate(1, "A1");
    const b = { ...candidate(1, "A1"), candidate_id: "ch1-b" } as SceneCandidate;
    const r = commitScenes(root, [a, b], { workflowId: "w1" });
    expect(r.created).toHaveLength(1);
    expect(r.conflicts).toEqual(["ch1-b(锚点冲突)"]);
    expect(readdirSync(join(root, "scenes")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });
  it("写前范围外脏工作区 → DIRTY_WORKSPACE, 零写入零 commit(R17)", () => {
    const root = makeRoot();
    writeFileSync(join(root, "untracked-notes.md"), "手改未提交", "utf8"); // 范围外脏改动
    let err: unknown = null;
    try {
      commitScenes(root, [candidate(1, "A1")], { workflowId: "w1" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "DIRTY_WORKSPACE" });
    expect(existsSync(join(root, "scenes", "s001.md"))).toBe(false);
  });
  it("gitAdd 只传本批精确相对文件(commit 不含无关路径)", () => {
    const root = makeRoot();
    const created = commitScenes(root, [candidate(1, "A1"), candidate(2, "A2")], { workflowId: "w1" }).created;
    const files = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    expect(created).toEqual(["s001", "s002"]);
    expect(files).toEqual(["scenes/s001.md", "scenes/s002.md"]);
  });
});

describe("provenanceKey / normalizeNarrativeTag", () => {
  it("来源顺序无关", () => {
    const a = provenanceKey({ workflowId: "w", candidateId: "c", sourceCandidateIds: ["a", "b"], operation: "kept", sourceChapterIndices: [2, 1] });
    const b = provenanceKey({ workflowId: "w", candidateId: "c", sourceCandidateIds: ["b", "a"], operation: "kept", sourceChapterIndices: [1, 2] });
    expect(a).toBe(b);
  });
  it("imported→draft, 截断 32", () => {
    expect(normalizeNarrativeTag("imported")).toBe("draft");
    expect(normalizeNarrativeTag("x".repeat(40))).toHaveLength(32);
    expect(normalizeNarrativeTag(undefined)).toBe("draft");
  });
});

describe("demo 所需: 全链顺序(1a→1b→1c→commit)", () => {
  it("MockProvider 全链跑通并落 scenes", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ scenes: [sceneJson(1, "S1", "A1")] }) },
        { text: JSON.stringify({ scenes: [sceneJson(2, "S2", "A2")] }) },
        { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
        { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
        { text: JSON.stringify({ boundaries: [{ left_candidate_id: "ch1-s0", right_candidate_id: "ch2-s0", relation: "separate", confidence: 0.9 }] }) },
      ],
    });
    const sliced = await sliceChapterBatch(provider, root, [1, 2]);
    const enriched = await enrichSceneBatch(provider, sliced.items.filter((i) => !i.fallback_required));
    const pairs = [];
    for (let i = 0; i + 1 < enriched.length; i++) pairs.push({ left: enriched[i], right: enriched[i + 1] });
    await fuseSceneBatch(provider, pairs);
    const r = commitScenes(root, enriched, { workflowId: "w-full" });
    expect(r.created).toHaveLength(2);
  });
});
