// world/map-atlas · AtlasPlan 校验器与 planMapAtlas orchestrator 行为契约
// (计划 §4 Phase 3; catalog §4.11; §5 规则 1-3; N28)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, serializeFrontmatter } from "@novelcraft/store";
import { MockProvider } from "@novelcraft/llm-step";
import {
  buildPriorAtlas,
  changedUpdateTargets,
  compileAtlasContext,
  computeAtlasPageContentHash,
  computePlanSemanticKeys,
  newSourceIdentities,
  normalizePlanSources,
  planMapAtlas,
  readAtlasTree,
  validateAtlasPlan,
  validateAtlasPlanStructure,
  validatePlanSources,
  validateUpdateTargets,
  writeAtlasNode,
  writeAtlasPage,
} from "../src/index";
import type {
  AtlasNode,
  AtlasPage,
  AtlasPlan,
  AtlasPlanNode,
  AtlasPriorNode,
  SourceRef,
} from "../src/index";

// ---------------------------------------------------------------------------
// 纯函数 fixture
// ---------------------------------------------------------------------------

const MANIFEST: SourceRef[] = [
  {
    source_id: "bp-1",
    source_type: "bible_page",
    title: "临水城志",
    source_hash: "h1",
    source_status: "canonical",
    open_target: { kind: "bible_page", slug: "bp-1" },
  },
  {
    source_id: "bp-2",
    source_type: "bible_page",
    title: "雾岭草稿",
    source_hash: "h2",
    source_status: "draft",
    open_target: { kind: "bible_page", slug: "bp-2" },
  },
];

function src(overrides?: Partial<SourceRef>): SourceRef {
  return {
    source_type: "bible_page",
    source_id: "bp-1",
    open_target: { kind: "bible_page", slug: "bp-1" },
    ...overrides,
  };
}

function planNode(overrides: Partial<AtlasPlanNode> & { plan_key: string }): AtlasPlanNode {
  return {
    title: overrides.plan_key,
    level: "city",
    summary: "概述",
    visual_brief: "视觉简述 临水城",
    prompt: "外部生图参考文本",
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    sources: [],
    annotations: [],
    ...overrides,
  };
}

/** 合法基线: cover 根 → city 子(带 location + canonical source)。 */
function validPlan(): AtlasPlan {
  return {
    style_brief: "写实暗色",
    nodes: [
      planNode({ plan_key: "root-cover", level: "cover", title: "封面" }),
      planNode({
        plan_key: "n-city",
        level: "city",
        title: "临水城",
        parent_plan_key: "root-cover",
        location_ref: "loc-a",
        evidence: { supported: ["临水城在雾岭南侧"], visual_fill: [], conflicts: [] },
        sources: [src()],
        annotations: [{ label: "城门", position_x: 0.5, position_y: 0.5, target_plan_key: "root-cover" }],
      }),
    ],
  };
}

describe("validateAtlasPlanStructure 结构 8 条(§5 规则 1-3)", () => {
  it("合法 plan 通过", () => {
    expect(validateAtlasPlanStructure(validPlan())).toEqual([]);
  });

  it("①location_ref 重复 → 拒绝", () => {
    const plan = validPlan();
    plan.nodes.push(
      planNode({ plan_key: "n-dup", level: "district", title: "重复", parent_plan_key: "n-city", location_ref: "loc-a" }),
    );
    expect(validateAtlasPlanStructure(plan).join()).toContain("locations must be unique");
  });

  it("②plan_key 重复 / 非法模式 → 拒绝", () => {
    const dup = validPlan();
    dup.nodes.push(planNode({ plan_key: "n-city", level: "district", parent_plan_key: "n-city" }));
    expect(validateAtlasPlanStructure(dup).join()).toContain("plan keys must be unique");
    const bad = validPlan();
    bad.nodes.push(planNode({ plan_key: "Bad Key!", level: "district", parent_plan_key: "n-city" }));
    expect(validateAtlasPlanStructure(bad).join()).toContain("plan_key 非法");
  });

  it("③supported 有内容但零 sources → 拒绝", () => {
    const plan = validPlan();
    plan.nodes[1].sources = [];
    expect(validateAtlasPlanStructure(plan).join()).toContain("requires a retained source");
  });

  it("④parent_plan_key 与 existing_parent_node_id 互斥", () => {
    const plan = validPlan();
    plan.nodes[1].existing_parent_node_id = "n-existing";
    expect(validateAtlasPlanStructure(plan).join()).toContain("cannot have both");
  });

  it("⑤cover/world 必须根节点", () => {
    const plan = validPlan();
    plan.nodes.push(planNode({ plan_key: "n-c2", level: "cover", parent_plan_key: "root-cover" }));
    expect(validateAtlasPlanStructure(plan).join()).toContain("must be roots");
  });

  it("⑥父必须先于子出现", () => {
    const plan = validPlan();
    plan.nodes = [plan.nodes[1], plan.nodes[0]]; // 子在前
    expect(validateAtlasPlanStructure(plan).join()).toContain("before their children");
  });

  it("⑦父 rank 严格大于子(M4 翻转口径: cover=6>…>interior=0; 计划 §5 规则 1)", () => {
    const plan = validPlan();
    // street(1) 作 city(3) 的父 → 非法。
    plan.nodes.push(planNode({ plan_key: "n-street", level: "street", parent_plan_key: "n-city" }));
    plan.nodes.push(planNode({ plan_key: "n-bad", level: "city", parent_plan_key: "n-street" }));
    expect(validateAtlasPlanStructure(plan).join()).toContain("strictly above");
    // 同级也非法(严格)。
    const same = validPlan();
    same.nodes.push(planNode({ plan_key: "n-c3", level: "city", parent_plan_key: "n-city", location_ref: "loc-b" }));
    expect(validateAtlasPlanStructure(same).join()).toContain("strictly above");
  });

  it("⑧annotation target_plan_key 必须在 plan 内", () => {
    const plan = validPlan();
    plan.nodes[1].annotations = [{ label: "x", position_x: 0, position_y: 0, target_plan_key: "ghost" }];
    expect(validateAtlasPlanStructure(plan).join()).toContain("not part of the atlas plan");
  });

  it("超过 20 页 → 拒绝(catalog §4.11)", () => {
    const plan = validPlan();
    for (let i = 0; i < 19; i++) {
      plan.nodes.push(planNode({ plan_key: `n-x${i}`, level: "street", parent_plan_key: "n-city" }));
    }
    expect(validateAtlasPlanStructure(plan).join()).toContain("超过上限 20");
  });
});

describe("validatePlanSources 来源白名单(规则 3)", () => {
  it("source 不在 manifest → 拒绝; open_target 不一致 → 拒绝", () => {
    const plan = validPlan();
    plan.nodes[1].sources = [src({ source_id: "bp-ghost" })];
    expect(validatePlanSources(plan, MANIFEST).join()).toContain("not in compiled context");
    const plan2 = validPlan();
    plan2.nodes[1].sources = [src({ open_target: { kind: "bible_page", slug: "bp-其他" } })];
    expect(validatePlanSources(plan2, MANIFEST).join()).toContain("not canonical");
  });

  it("working(draft) 不能单独支撑 supported(规则 3)", () => {
    const plan = validPlan();
    plan.nodes[1].sources = [
      src({ source_id: "bp-2", source_status: "draft", open_target: { kind: "bible_page", slug: "bp-2" } }),
    ];
    expect(validatePlanSources(plan, MANIFEST).join()).toContain("sole formal support");
  });

  it("annotation 的 source_ref 同样过白名单", () => {
    const plan = validPlan();
    plan.nodes[1].annotations = [
      { label: "x", position_x: 0, position_y: 0, source_ref: src({ source_id: "bp-ghost" }) },
    ];
    expect(validatePlanSources(plan, MANIFEST).join()).toContain("not in compiled context");
  });

  it("normalize 回填 actual-input hash/range，不信任模型伪造片段", () => {
    const plan = validPlan();
    plan.nodes[1].sources[0] = src({
      included_content_hash: "spoof",
      included_range: { start: 9, end: 10 },
      truncated: false,
    });
    normalizePlanSources(plan, [{
      ...MANIFEST[0],
      included_content_hash: "actual",
      included_range: { start: 0, end: 42 },
      truncated: true,
    }]);
    expect(plan.nodes[1].sources[0]).toMatchObject({
      included_content_hash: "actual",
      included_range: { start: 0, end: 42 },
      truncated: true,
    });

    const page: Omit<AtlasPage, "content_hash"> = {
      id: "p", run_ref: "r", node_ref: "n", generation_status: "prompt_only", review_status: "candidate",
      title: "t", visual_brief: "v", prompt: "p",
      evidence: { supported: [], visual_fill: [], conflicts: [] },
      source_manifest: [MANIFEST[0]], annotations: [], review_note: null,
      adopted_at: null, rejected_at: null, deprecated_at: null,
    };
    const legacyHash = computeAtlasPageContentHash(page);
    expect(computeAtlasPageContentHash({ ...page, source_manifest: [{ ...MANIFEST[0] }] })).toBe(legacyHash);
    expect(computeAtlasPageContentHash({
      ...page,
      source_manifest: [{ ...MANIFEST[0], included_content_hash: "actual", included_range: { start: 0, end: 42 }, truncated: true }],
    })).not.toBe(computeAtlasPageContentHash({
      ...page,
      source_manifest: [{ ...MANIFEST[0], included_content_hash: "changed", included_range: { start: 0, end: 42 }, truncated: true }],
    }));
  });
});

describe("computePlanSemanticKeys 与 update 约束(计划 Phase 3 update 口径)", () => {
  const PRIOR: AtlasPriorNode[] = [
    { node_id: "n-adopted", semantic_key: "entity:loc-a", level: "city", title: "临水城", location_ref: "loc-a", sources: [src({ source_hash: "h1" })] },
  ];

  it("entity:{location_slug} / path:{父语义}:{slug(title)}", () => {
    const plan = validPlan();
    const { keys, issues } = computePlanSemanticKeys(plan, []);
    expect(issues).toEqual([]);
    expect(keys["n-city"]).toBe("entity:loc-a");
    // M1(review): path 段 = sha256(title 去空白小写)前 20 hex(旧 _semantic_part 口径)。
    expect(keys["root-cover"]).toMatch(/^path:root:[0-9a-f]{20}$/);
    // existing_parent 引用 prior 节点 → 父语义链入 path。
    const child = validPlan();
    child.nodes = [
      planNode({ plan_key: "n-sub", level: "district", existing_parent_node_id: "n-adopted", title: "南区" }),
    ];
    const r2 = computePlanSemanticKeys(child, PRIOR);
    expect(r2.keys["n-sub"]).toMatch(/^path:entity:loc-a:/);
    // existing_parent 不在 prior → issue。
    const r3 = computePlanSemanticKeys(child, []);
    expect(r3.issues.join()).toContain("not in the current atlas");
  });

  it("changed = 来源 hash 变化(含同 source 牵连); new = 新增/hash 变/status 变的 canonical source", () => {
    const prior2: AtlasPriorNode[] = [
      ...PRIOR,
      { node_id: "n-other", semantic_key: "path:root:other", level: "region", title: "他", location_ref: null, sources: [src({ source_hash: "h1" })] },
    ];
    const { changedSemanticKeys } = changedUpdateTargets(prior2, [
      { ...MANIFEST[0], source_hash: "h1-改" },
      MANIFEST[1],
    ]);
    // 两个节点共享 bp-1 → 牵连都 changed。
    expect(changedSemanticKeys.has("entity:loc-a")).toBe(true);
    expect(changedSemanticKeys.has("path:root:other")).toBe(true);

    const newIds = newSourceIdentities([], MANIFEST);
    expect(newIds.has("bible_page:bp-1")).toBe(true); // canonical 新 source
    expect(newIds.has("bible_page:bp-2")).toBe(false); // draft 非 formal
    const noneNew = newSourceIdentities(MANIFEST, MANIFEST);
    expect(noneNew.size).toBe(0);
  });

  it("update: 非 missing 的新 location / 无新 source 的 path 节点 / 未 changed 的旧节点 → 各拒绝", () => {
    // 新 location 但不在 missing 集。
    const planAdd = validPlan();
    planAdd.nodes = [planNode({ plan_key: "n-new", level: "city", location_ref: "loc-b", sources: [src()] })];
    const issues1 = validateUpdateTargets(planAdd, PRIOR, {
      changedSemanticKeys: new Set(),
      missingLocationSlugs: new Set(),
      newSources: new Set(),
    });
    expect(issues1.join()).toContain("non-missing location");

    // 新 path 节点(无 location)无新 formal source。
    const planPath = validPlan();
    planPath.nodes = [planNode({ plan_key: "n-path", level: "region", title: "新区", sources: [src()] })];
    const issues2 = validateUpdateTargets(planPath, PRIOR, {
      changedSemanticKeys: new Set(),
      missingLocationSlugs: new Set(),
      newSources: new Set(),
    });
    expect(issues2.join()).toContain("newly retained source");

    // 已存在 semantic(entity:loc-a) 但未 changed。
    const issues3 = validateUpdateTargets(validPlan(), PRIOR, {
      changedSemanticKeys: new Set(),
      missingLocationSlugs: new Set(),
      newSources: new Set(),
    });
    expect(issues3.join()).toContain("unchanged existing node");

    // 合法: missing location + changed 旧节点。
    const ok = validateUpdateTargets(validPlan(), PRIOR, {
      changedSemanticKeys: new Set(["entity:loc-a"]),
      missingLocationSlugs: new Set(["loc-a"]),
      newSources: new Set(),
    });
    // validPlan 的 root-cover(path:root:…)是新 path 且无新 source → 仍拒; 去掉根只留 changed 节点。
    expect(ok.join()).toContain("newly retained source");
    const only = validPlan();
    only.nodes = [only.nodes[1]];
    only.nodes[0].parent_plan_key = null;
    only.nodes[0].level = "world"; // world 必根, parent null 合法
    const ok2 = validateUpdateTargets(only, PRIOR, {
      changedSemanticKeys: new Set(["entity:loc-a"]),
      missingLocationSlugs: new Set(),
      newSources: new Set(),
    });
    expect(ok2).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// orchestrator(MockProvider 端到端)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-plan-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeLocation(root: string, slug: string, name: string): string {
  const file = paths(root).world.objectFile(slug);
  writeFileSync(
    file,
    serializeFrontmatter(
      { id: slug, name, kind: "location", status: "canonical", aliases: [], tags: [], evidence: [] },
      "",
    ),
    "utf8",
  );
  gitAdd(root, [file]);
  gitCommit(root, `test: location ${slug}`);
  return slug;
}

function writeBible(root: string, slug: string, title: string, body: string): void {
  const file = paths(root).bible.bibleFile(slug);
  writeFileSync(
    file,
    serializeFrontmatter(
      { id: slug, status: "canonical", page_type: "location", page_key: slug, title, version_number: 1 },
      body,
    ),
    "utf8",
  );
  gitAdd(root, [file]);
  gitCommit(root, `test: bible ${slug}`);
}

function spatialResp(locationKey: string, sourceKey: string): string {
  return JSON.stringify({
    locations: [
      {
        location_key: locationKey,
        facts: [{ statement: "临水城在雾岭南侧", basis: "explicit", source_keys: [sourceKey] }],
      },
    ],
  });
}

function planResp(sourceId: string, locationRef = "loc-00"): string {
  return JSON.stringify({
    style_brief: "写实暗色",
    nodes: [
      {
        plan_key: "root-cover",
        title: "封面",
        level: "cover",
        summary: "总览",
        visual_brief: "世界封面",
        prompt: "封面外部生图参考",
        evidence: { supported: [], visual_fill: [], conflicts: [] },
        sources: [],
        annotations: [],
      },
      {
        plan_key: "n-city",
        parent_plan_key: "root-cover",
        location_ref: locationRef,
        title: "地点志",
        level: "city",
        summary: "城市概述",
        visual_brief: "地点志 全景, 临水城在雾岭南侧",
        prompt: "城市外部生图参考",
        evidence: { supported: ["临水城在雾岭南侧"], visual_fill: [], conflicts: [] },
        sources: [
          { source_type: "bible_page", source_id: sourceId, open_target: { kind: "bible_page", slug: sourceId } },
        ],
        annotations: [{ label: "城门", position_x: 0.5, position_y: 0.5 }],
      },
    ],
  });
}

describe("planMapAtlas orchestrator(计划 Phase 3 步骤 1-7)", () => {
  it("initial 端到端: planning→context→spatial→plan→validate→materialize(单 commit)→review_ready", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "临水城在雾岭南侧, 临河而建。");
    const provider = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: planResp("bp-00") }],
    });
    const r = await planMapAtlas(root, provider, { run_kind: "initial", runId: "run-t1" });
    expect(r.issues).toEqual([]);
    expect(r.run.status).toBe("review_ready");
    expect(r.run.error_code).toBeNull();
    expect(r.run.planned_page_count).toBe(2);
    expect(r.run.context_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.plan?.nodes.length).toBe(2);
    // 空间事实落 run(catalog §4.12)。
    expect((r.run.spatial_evidence as { facts?: unknown[] }).facts?.length).toBe(1);
    // 候选物化到 pending(规则: 候选不过 approval; prompt_only 不可 adopt, N28)。
    const tree = readAtlasTree(root);
    expect(tree.pendingNodes.map((n) => n.id).sort()).toEqual(["n-city", "root-cover"]);
    expect(tree.pendingPages.length).toBe(2);
    expect(tree.pendingPages.every((p) => p.generation_status === "prompt_only")).toBe(true);
    expect(tree.pendingPages.every((p) => p.review_status === "candidate")).toBe(true);
    expect(tree.pendingNodes.find((n) => n.id === "n-city")?.semantic_key).toBe("entity:loc-00");
    expect(tree.pendingNodes.find((n) => n.id === "n-city")?.parent_ref).toBe("root-cover");
    // 无 adopted 写入(fail-closed 面)。
    expect(tree.nodes.length).toBe(0);
    expect(tree.pages.length).toBe(0);
  });

  it("校验失败 → run failed(plan_validation_failed) + 无候选落盘(fail-closed)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "正文");
    const badPlan = JSON.stringify({
      style_brief: "x",
      nodes: [
        {
          plan_key: "n-bad",
          title: "坏",
          level: "city",
          summary: "s",
          visual_brief: "v",
          prompt: "p",
          location_ref: "loc-00",
          evidence: { supported: ["无来源断言"], visual_fill: [], conflicts: [] },
          sources: [], // ③supported 无 source
          annotations: [],
        },
      ],
    });
    const provider = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: badPlan }],
    });
    const r = await planMapAtlas(root, provider, { run_kind: "initial", runId: "run-t2" });
    expect(r.run.status).toBe("failed");
    expect(r.run.error_code).toBe("plan_validation_failed");
    expect(r.run.error_message).toContain("retained source");
    const tree = readAtlasTree(root);
    expect(tree.pendingNodes.length).toBe(0);
    expect(tree.pendingPages.length).toBe(0);
  });

  it("LLM 规划失败 → run failed(plan_generation_failed)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "正文");
    const provider = new MockProvider({
      retryable: false,
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { throwError: new Error("规划超时") }],
    });
    const r = await planMapAtlas(root, provider, { run_kind: "initial", runId: "run-t3" });
    expect(r.run.status).toBe("failed");
    expect(r.run.error_code).toBe("plan_generation_failed");
  });

  it("只有地点名 → failed(insufficient_sources), provider=0", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-name-only", "只有名字");
    const provider = new MockProvider({ responses: [] });
    const r = await planMapAtlas(root, provider, { run_kind: "initial", runId: "run-t4" });
    expect(r.run.status).toBe("failed");
    expect(r.run.error_code).toBe("insufficient_sources");
    expect(provider.calls.length).toBe(0);
  });

  it("update 无变化 → review_ready 空 plan 且不调 LLM(计划: 无变化短路)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "正文");
    // 第一次 initial 建 run(留下 manifest + spatial 指纹)。
    const p1 = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: planResp("bp-00") }],
    });
    await planMapAtlas(root, p1, { run_kind: "initial", runId: "run-u1" });
    // 模拟 Phase 4 adopt: 采用节点 + 页(sources 带当前 manifest hash)。
    const ctx = await compileAtlasContext(root);
    const hash = ctx.source_manifest.find((m) => m.source_id === "bp-00")?.source_hash ?? "";
    writeAtlasNode(
      root,
      {
        id: "n-adopted",
        parent_ref: null,
        location_ref: "loc-00",
        semantic_key: "entity:loc-00",
        level: "city",
        title: "临水城",
        status: "adopted",
        sort_order: 0,
      },
      { adopted: true },
    );
    writeAtlasPage(
      root,
      {
        id: "pg-adopted",
        run_ref: "run-u1",
        node_ref: "n-adopted",
        generation_status: "review_ready",
        review_status: "adopted",
        title: "临水城",
        visual_brief: "v",
        prompt: "p",
        evidence: { supported: [], visual_fill: [], conflicts: [] },
        source_manifest: [
          {
            source_type: "bible_page",
            source_id: "bp-00",
            source_hash: hash,
            source_status: "canonical",
            open_target: { kind: "bible_page", slug: "bp-00" },
          },
        ],
        annotations: [],
        review_note: null,
        adopted_at: "2026-08-15T00:00:00.000Z",
        rejected_at: null,
        deprecated_at: null,
        content_hash: "x",
      },
      { adopted: true },
    );
    // update: 指纹未变(spatial 复用) + 无 missing/changed/new → 短路, provider 零调用。
    const p2 = new MockProvider({ responses: [] });
    const r = await planMapAtlas(root, p2, { run_kind: "update", runId: "run-u2" });
    expect(r.run.status).toBe("review_ready");
    expect(r.run.planned_page_count).toBe(0);
    expect(r.plan?.nodes).toEqual([]);
    expect(p2.calls.length).toBe(0);
  });

  it("update 有 missing location → 只规划缺失地点(约束生效)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "正文");
    const p1 = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: planResp("bp-00") }],
    });
    await planMapAtlas(root, p1, { run_kind: "initial", runId: "run-m1" });
    // 新增地点必须先有 retained/openable 证据；只有名字不进 context(A1)。
    writeLocation(root, "loc-01", "雾岭");
    writeBible(root, "bp-01", "雾岭志", "正文");
    const p2 = new MockProvider({
      responses: [
        { text: JSON.stringify({ locations: [] }) },
        {
          text: JSON.stringify({
            style_brief: "写实暗色",
            nodes: [
              {
                plan_key: "n-new",
                title: "雾岭",
                level: "region",
                summary: "s",
                visual_brief: "雾岭 全景",
                prompt: "p",
                location_ref: "loc-01",
                evidence: { supported: [], visual_fill: [], conflicts: [] },
                sources: [],
                annotations: [],
              },
            ],
          }),
        },
      ],
    });
    const r = await planMapAtlas(root, p2, { run_kind: "update", runId: "run-m2" });
    expect(r.issues).toEqual([]);
    expect(r.run.status).toBe("review_ready");
    expect(r.plan?.nodes.map((n) => n.location_ref)).toEqual(["loc-01"]);
  });

  it("H1 回归: 仅新增 canonical 来源即触发 update(prevManifest 排除本轮 run)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "正文");
    const p1 = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: planResp("bp-00") }],
    });
    await planMapAtlas(root, p1, { run_kind: "initial", runId: "run-h1" });
    // adopt 节点+页(hash 对齐当前 manifest)。
    const ctx0 = await compileAtlasContext(root);
    const hash = ctx0.source_manifest.find((m) => m.source_id === "bp-00")?.source_hash ?? "";
    writeAtlasNode(
      root,
      {
        id: "n-adopted",
        parent_ref: null,
        location_ref: "loc-00",
        semantic_key: "entity:loc-00",
        level: "city",
        title: "临水城",
        status: "adopted",
        sort_order: 0,
      },
      { adopted: true },
    );
    writeAtlasPage(
      root,
      {
        id: "pg-adopted",
        run_ref: "run-h1",
        node_ref: "n-adopted",
        generation_status: "review_ready",
        review_status: "adopted",
        title: "临水城",
        visual_brief: "v",
        prompt: "p",
        evidence: { supported: [], visual_fill: [], conflicts: [] },
        source_manifest: [
          {
            source_type: "bible_page",
            source_id: "bp-00",
            source_hash: hash,
            source_status: "canonical",
            open_target: { kind: "bible_page", slug: "bp-00" },
          },
        ],
        annotations: [],
        review_note: null,
        adopted_at: "2026-08-15T00:00:00.000Z",
        rejected_at: null,
        deprecated_at: null,
        content_hash: "x",
      },
      { adopted: true },
    );
    // 仅新增一个 canonical bible 页(链接 loc-00; 旧来源 hash 未变 → 无 missing/changed, 只有 new source)。
    writeBible(root, "bp-new", "临水城补遗", "补充: 城东有新码头。");
    // 空间指纹变了(manifest 多了 bp-new → hashes 变)→ spatial 会调 provider。
    const newCtx = await compileAtlasContext(root);
    const newKey = newCtx.source_manifest.find((m) => m.source_id === "bp-new")?.source_id ?? "bp-new";
    const p2 = new MockProvider({
      responses: [
        { text: spatialResp("loc-00", "wiki:bp-00") },
        {
          text: JSON.stringify({
            style_brief: "写实暗色",
            nodes: [
              {
                plan_key: "n-dock",
                title: "城东码头",
                level: "district",
                summary: "s",
                visual_brief: "临水城 城东码头",
                prompt: "p",
                evidence: { supported: [], visual_fill: ["新码头位置待补"], conflicts: [] },
                sources: [
                  {
                    source_type: "bible_page",
                    source_id: newKey,
                    open_target: { kind: "bible_page", slug: newKey },
                  },
                ],
                annotations: [],
              },
            ],
          }),
        },
      ],
    });
    const r = await planMapAtlas(root, p2, { run_kind: "update", runId: "run-h2" });
    // 修复前: prevManifest 取到本轮 run-h2 自身 → newSources 恒空 → 误短路(不调 LLM)。
    expect(p2.calls.length).toBe(2);
    expect(r.run.status).toBe("review_ready");
    expect(r.plan?.nodes.map((n) => n.plan_key)).toEqual(["n-dock"]);
  });

  it("M3 回归: 大输入(近 8000 字证据)不触发 budget_exceeded(budgetTokens=0 输入主导豁免, N27)", async () => {
    const root = makeRoot();
    writeLocation(root, "loc-00", "临水城");
    writeBible(root, "bp-00", "临水城志", "字".repeat(7900));
    const provider = new MockProvider({
      responses: [{ text: spatialResp("loc-00", "wiki:bp-00") }, { text: planResp("bp-00") }],
    });
    const r = await planMapAtlas(root, provider, { run_kind: "initial", runId: "run-b1" });
    expect(r.run.error_code).not.toBe("budget_exceeded");
    expect(r.run.status).toBe("review_ready");
    expect(provider.calls.length).toBe(2);
  });
});
