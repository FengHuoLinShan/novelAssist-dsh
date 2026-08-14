// world/map-atlas · 空间事实提取行为契约(计划 §4 Phase 2; catalog §4.12; 规则 4; N28)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, serializeFrontmatter } from "@novelcraft/store";
import { MockProvider } from "@novelcraft/llm-step";
import {
  ATLAS_SPATIAL_BATCH_SIZE,
  ATLAS_SPATIAL_MAX_FACTS_PER_BATCH,
  ATLAS_SPATIAL_MAX_FACTS_PER_LOCATION,
  compileAtlasContext,
  computeSpatialFingerprint,
  extractSpatialFacts,
  partitionSpatialFacts,
  writeAtlasRun,
} from "../src/index";
import type { AtlasContextResult, AtlasRun, SpatialFact } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-sp-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeLocation(root: string, slug: string, name: string, body = ""): string {
  const file = paths(root).world.objectFile(slug);
  writeFileSync(
    file,
    serializeFrontmatter(
      { id: slug, name, kind: "location", status: "canonical", aliases: [], tags: [], evidence: [] },
      body,
    ),
    "utf8",
  );
  gitAdd(root, [file]);
  gitCommit(root, `test: location ${slug}`);
  return slug;
}

function writeBiblePage(root: string, slug: string, title: string, body: string): string {
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
  return slug;
}

/** 构造带 wiki 证据的地点上下文(n 个地点, 每地 1 页 bible)。 */
async function makeCtx(root: string, n: number): Promise<AtlasContextResult> {
  for (let i = 0; i < n; i++) {
    const slug = `loc-${String(i).padStart(2, "0")}`;
    writeLocation(root, slug, `地点${String(i).padStart(2, "0")}`);
    writeBiblePage(root, `bp-${String(i).padStart(2, "0")}`, `地点${String(i).padStart(2, "0")}志`, `正文${i}`);
  }
  return compileAtlasContext(root);
}

function llmFacts(locations: Array<{ location_key: string; facts: unknown[] }>): string {
  return JSON.stringify({ locations });
}

function makeRun(root: string, evidence: Record<string, unknown>): void {
  const run: AtlasRun = {
    schema_version: 1,
    id: "run-reuse",
    run_kind: "initial",
    status: "review_ready",
    options: { style_note: "", include_working_drafts: false, include_interiors: false, full_rebuild: false },
    context_hash: "",
    source_manifest: [],
    spatial_evidence: evidence,
    atlas_plan: { style_brief: "", nodes: [] },
    planned_page_count: 0,
    checkpoint: "",
    error_code: null,
    error_message: null,
    journal: [],
    created_at: "2026-08-15T00:00:00.000Z",
  };
  writeAtlasRun(root, run);
}

describe("extractSpatialFacts 校验与分桶(catalog §4.12; 规则 4)", () => {
  it("合法 facts 按 basis 确定性分桶(explicit→supported, inferred/working→visual_fill, conflicting→conflicts)", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 1);
    const key = ctx.packets[0].source_keys[0];
    const provider = new MockProvider({
      responses: [
        {
          text: llmFacts([
            {
              location_key: "loc-00",
              facts: [
                { statement: "临水城在雾岭南侧", basis: "explicit", source_keys: [key] },
                { statement: "两地之间应有商道", basis: "inferred", source_keys: [key] },
                { statement: "或在河谷设渡口", basis: "working", source_keys: [key] },
                { statement: "一说在北侧", basis: "conflicting", source_keys: [key] },
              ],
            },
          ]),
        },
      ],
    });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.facts.length).toBe(4);
    expect(ev.supported.map((f) => f.statement)).toEqual(["临水城在雾岭南侧"]);
    expect(ev.visual_fill.map((f) => f.statement)).toEqual(["两地之间应有商道", "或在河谷设渡口"]);
    expect(ev.conflicts.map((f) => f.statement)).toEqual(["一说在北侧"]);
    expect(ev.degraded).toBe(false);
    expect(ev.all_batches_failed).toBe(false);
    expect(ev.invalid_count).toBe(0);
    expect(ev.locations_checked).toBe(1);
    expect(ev.locations_with_facts).toBe(1);
    expect(provider.calls.length).toBe(1);
  });

  it("location_key/source_keys 非 packet 逐字 key 的条目丢弃并计 invalid(规则 4)", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 1);
    const key = ctx.packets[0].source_keys[0];
    const provider = new MockProvider({
      responses: [
        {
          text: llmFacts([
            {
              location_key: "loc-00",
              facts: [
                { statement: "合法", basis: "explicit", source_keys: [key] },
                { statement: "假来源", basis: "explicit", source_keys: ["wiki:不存在"] },
                { statement: "空来源", basis: "explicit", source_keys: [] },
                { statement: "坏 basis", basis: "maybe", source_keys: [key] },
              ],
            },
            { location_key: "ghost-loc", facts: [{ statement: "幽灵地点", basis: "explicit", source_keys: [key] }] },
          ]),
        },
      ],
    });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.facts.map((f) => f.statement)).toEqual(["合法"]);
    // 假来源 + 空来源 + 坏 basis + 幽灵地点 = 4。
    expect(ev.invalid_count).toBe(4);
  });

  it("每地点 ≤12 条截断", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 1);
    const key = ctx.packets[0].source_keys[0];
    const facts = Array.from({ length: 15 }, (_, i) => ({
      statement: `事实${i}`,
      basis: "explicit",
      source_keys: [key],
    }));
    const provider = new MockProvider({ responses: [{ text: llmFacts([{ location_key: "loc-00", facts }]) }] });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.facts.length).toBe(ATLAS_SPATIAL_MAX_FACTS_PER_LOCATION);
    expect(ATLAS_SPATIAL_MAX_FACTS_PER_LOCATION).toBe(12);
  });

  it("每批 ≤60 条截断(5 地点 × 13 条 → 60)", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 5);
    const locations = ctx.packets.map((p) => ({
      location_key: p.location_key,
      facts: Array.from({ length: 13 }, (_, i) => ({
        statement: `${p.location_key}-${i}`,
        basis: "explicit",
        source_keys: [p.source_keys[0]],
      })),
    }));
    const provider = new MockProvider({ responses: [{ text: llmFacts(locations) }] });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.facts.length).toBe(ATLAS_SPATIAL_MAX_FACTS_PER_BATCH);
    expect(ATLAS_SPATIAL_MAX_FACTS_PER_BATCH).toBe(60);
  });
});

describe("extractSpatialFacts 批编排与降级(计划 Phase 2)", () => {
  it("6 地点 → 2 批 2 次 provider 调用(批 5)", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 6);
    expect(ATLAS_SPATIAL_BATCH_SIZE).toBe(5);
    const provider = new MockProvider({
      responses: [
        { text: llmFacts(ctx.packets.slice(0, 5).map((p) => ({ location_key: p.location_key, facts: [] }))) },
        { text: llmFacts([{ location_key: ctx.packets[5].location_key, facts: [] }]) },
      ],
    });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(provider.calls.length).toBe(2);
    expect(ev.locations_checked).toBe(6);
    expect(ev.degraded).toBe(false);
  });

  it("单批失败 degraded + 其他批 facts 保留 + next_checkpoint=首个失败批号", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 6);
    const key5 = ctx.packets[5].source_keys[0];
    const provider = new MockProvider({
      retryable: false,
      responses: [
        { throwError: new Error("LLM 超时") },
        {
          text: llmFacts([
            { location_key: ctx.packets[5].location_key, facts: [{ statement: "幸存", basis: "explicit", source_keys: [key5] }] },
          ]),
        },
      ],
    });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.degraded).toBe(true);
    expect(ev.all_batches_failed).toBe(false);
    expect(ev.facts.map((f) => f.statement)).toEqual(["幸存"]);
    expect(ev.next_checkpoint).toBe(0);
  });

  it("全批失败 → all_batches_failed + message", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 1);
    const provider = new MockProvider({ retryable: false, responses: [{ throwError: new Error("LLM 全灭") }] });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.all_batches_failed).toBe(true);
    expect(ev.degraded).toBe(false);
    expect(ev.facts).toEqual([]);
    expect(ev.message).toContain("失败");
  });

  it("无地点 → insufficient_sources 直通(不调 provider)", async () => {
    const root = makeRoot();
    const ctx = await compileAtlasContext(root);
    const provider = new MockProvider({ responses: [] });
    const ev = await extractSpatialFacts(root, provider, ctx);
    expect(ev.insufficient_sources).toBe(true);
    expect(provider.calls.length).toBe(0);
  });
});

describe("extractSpatialFacts 指纹复用(计划 Phase 2 步骤 5)", () => {
  it("同指纹非降级 run → 直接复用, 不调 provider; 指纹变化 → 重跑", async () => {
    const root = makeRoot();
    const ctx = await makeCtx(root, 1);
    const key = ctx.packets[0].source_keys[0];
    const first = new MockProvider({
      responses: [
        { text: llmFacts([{ location_key: "loc-00", facts: [{ statement: "旧事实", basis: "explicit", source_keys: [key] }] }]) },
      ],
    });
    const ev1 = await extractSpatialFacts(root, first, ctx);
    expect(ev1.facts.length).toBe(1);
    makeRun(root, ev1 as unknown as Record<string, unknown>);

    // 同指纹 → 复用。
    const second = new MockProvider({ responses: [] });
    const ev2 = await extractSpatialFacts(root, second, ctx);
    expect(ev2.reused).toBe(true);
    expect(ev2.facts.map((f) => f.statement)).toEqual(["旧事实"]);
    expect(second.calls.length).toBe(0);

    // 指纹变化(改对象正文 → wiki 未变, 改 bible 正文 → hash 变) → 重跑。
    writeBiblePage(root, "bp-00", "地点00志", "正文00-修订");
    const ctx2 = await compileAtlasContext(root);
    expect(computeSpatialFingerprint(ctx2)).not.toBe(computeSpatialFingerprint(ctx));
    const third = new MockProvider({
      responses: [{ text: llmFacts([{ location_key: "loc-00", facts: [] }]) }],
    });
    const ev3 = await extractSpatialFacts(root, third, ctx2);
    expect(ev3.reused).toBeUndefined();
    expect(third.calls.length).toBe(1);
  });
});

describe("partitionSpatialFacts 分桶上限(计划 Phase 2)", () => {
  it("去重保序 + conflicts ≤20 / 其他桶 ≤50", () => {
    const mk = (basis: SpatialFact["basis"], i: number): SpatialFact => ({
      location_key: "loc",
      statement: `${basis}-${i}`,
      basis,
      source_keys: ["wiki:x"],
    });
    const facts = [
      ...Array.from({ length: 55 }, (_, i) => mk("explicit", i)),
      ...Array.from({ length: 55 }, (_, i) => mk("inferred", i)),
      ...Array.from({ length: 25 }, (_, i) => mk("conflicting", i)),
      mk("explicit", 0), // 重复(同 location+statement) → 去重
    ];
    const p = partitionSpatialFacts(facts);
    expect(p.supported.length).toBe(50);
    expect(p.visual_fill.length).toBe(50);
    expect(p.conflicts.length).toBe(20);
  });
});
