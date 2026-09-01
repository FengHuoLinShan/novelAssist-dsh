// world/map-atlas · 来源上下文编译行为契约(计划 §4 Phase 2; 规则 4; N28/N29)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, serializeFrontmatter } from "@novelcraft/store";
import { INDEX_VERSION_CN, rebuildRagIndex } from "@novelcraft/rag";
import {
  ATLAS_CHARS_PER_LOCATION,
  ATLAS_MAX_LOCATIONS,
  ATLAS_WIKI_PER_LOCATION,
  compileAtlasContext,
  validatePlanSources,
  writeAtlasNode,
} from "../src/index";
import type { AtlasNode, AtlasPlan } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-ctx-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 直接落盘世界对象(可带 importance; createObject 不支持该字段)。 */
function writeObject(
  root: string,
  fm: Record<string, unknown> & { name: string },
  body = "",
): string {
  const slug = String(fm.id ?? `obj-${fm.name}`);
  const file = paths(root).world.objectFile(slug);
  writeFileSync(
    file,
    serializeFrontmatter(
      {
        status: "canonical",
        kind: "location",
        aliases: [],
        tags: [],
        evidence: [],
        ...fm,
        id: slug,
      },
      body,
    ),
    "utf8",
  );
  gitAdd(root, [file]);
  gitCommit(root, `test: object ${slug}`);
  return slug;
}

/** 直接落盘世界书页(bible_page required: id/status/page_type/page_key/title/version_number)。 */
function writeBiblePage(
  root: string,
  fm: Record<string, unknown> & { slug: string; title: string },
  body = "",
): string {
  const file = paths(root).bible.bibleFile(fm.slug);
  writeFileSync(
    file,
    serializeFrontmatter(
      {
        status: "canonical",
        page_type: "location",
        page_key: fm.slug,
        version_number: 1,
        ...fm,
        id: fm.slug,
      },
      body,
    ),
    "utf8",
  );
  gitAdd(root, [file]);
  gitCommit(root, `test: bible ${fm.slug}`);
  return fm.slug;
}

function makeNode(overrides: Partial<AtlasNode> & { id: string }): AtlasNode {
  return {
    parent_ref: null,
    location_ref: null,
    semantic_key: `entity:${overrides.id}`,
    level: "world",
    title: overrides.id,
    status: "adopted",
    sort_order: 0,
    ...overrides,
  };
}

describe("compileAtlasContext 地点选择(计划 §4 Phase 2)", () => {
  it("空 vault → insufficient_sources + 空 packets(计划 Phase 2 无地点口径)", async () => {
    const root = makeRoot();
    const r = await compileAtlasContext(root);
    expect(r.insufficient_sources).toBe(true);
    expect(r.packets).toEqual([]);
    expect(r.source_manifest).toEqual([]);
    expect(r.message).toContain("没有可核对的已采用地点");
    expect(r.context_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("只选 canonical 且 kind=location 的对象(draft location 与非 location 排除)", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    writeObject(root, { id: "loc-b", name: "雾岭" });
    writeObject(root, { id: "loc-c", name: "旧港" });
    writeObject(root, { id: "char-1", name: "阿黎", kind: "character" });
    writeObject(root, { id: "loc-draft", name: "草案地", status: "draft" });
    writeBiblePage(root, { slug: "bp-a", title: "临水城志" }, "A");
    writeBiblePage(root, { slug: "bp-b", title: "雾岭志" }, "B");
    writeBiblePage(root, { slug: "bp-c", title: "旧港志" }, "C");
    const r = await compileAtlasContext(root);
    expect(r.insufficient_sources).toBe(false);
    expect(r.packets.map((p) => p.location_key).sort()).toEqual(["loc-a", "loc-b", "loc-c"]);
  });

  it("排序: 已有 atlas 节点 > 世界书链接 > importance 降序 > name(规则 4 确定性)", async () => {
    const root = makeRoot();
    // importance: hi=10, mid=5, lo=1; linked 有 bible 链接; atlas 已有节点。
    writeObject(root, { id: "loc-lo", name: "低", importance: 1 });
    writeObject(root, { id: "loc-hi", name: "高", importance: 10 });
    writeObject(root, { id: "loc-mid", name: "中", importance: 5 });
    writeObject(root, { id: "loc-linked", name: "链", importance: 0 });
    writeObject(root, { id: "loc-atlas", name: "册", importance: 0 });
    writeBiblePage(root, { slug: "bp-1", title: "无关页", linked_asset_refs: ["loc-linked"] }, "linked");
    writeBiblePage(root, { slug: "bp-lo", title: "低志" }, "lo");
    writeBiblePage(root, { slug: "bp-hi", title: "高志" }, "hi");
    writeBiblePage(root, { slug: "bp-mid", title: "中志" }, "mid");
    writeBiblePage(root, { slug: "bp-atlas", title: "册志" }, "atlas");
    writeAtlasNode(root, makeNode({ id: "n1", location_ref: "loc-atlas" }));
    const r = await compileAtlasContext(root);
    expect(r.packets.map((p) => p.location_key)).toEqual([
      "loc-atlas",
      "loc-linked",
      "loc-hi",
      "loc-mid",
      "loc-lo",
    ]);
  });

  it("超过 20 个地点时按排序取前 20(计划 ≤20)", async () => {
    const root = makeRoot();
    for (let i = 0; i < 22; i++) {
      writeObject(root, { id: `loc-${String(i).padStart(2, "0")}`, name: `地点${String(i).padStart(2, "0")}` });
    }
    writeBiblePage(root, {
      slug: "bp-all",
      title: "地点合集",
      linked_asset_refs: Array.from({ length: 22 }, (_, i) => `loc-${String(i).padStart(2, "0")}`),
    }, "可核对证据");
    const r = await compileAtlasContext(root);
    expect(r.packets.length).toBe(ATLAS_MAX_LOCATIONS);
    expect(ATLAS_MAX_LOCATIONS).toBe(20);
    // name 升序 → 前 20 个(00..19)。
    expect(r.packets[0].location_key).toBe("loc-00");
    expect(r.packets[19].location_key).toBe("loc-19");
  }, 15_000);
});

describe("compileAtlasContext 世界书证据(计划 §2/§4 Phase 2)", () => {
  it("canonical 必选; draft 默认不选, include_working_drafts=true 时可选(计划 §2)", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    writeBiblePage(root, { slug: "bp-c", title: "临水城志", status: "canonical" }, "正文 canonical");
    writeBiblePage(root, { slug: "bp-d", title: "临水城草稿", status: "draft" }, "正文 draft");
    const strict = await compileAtlasContext(root);
    expect(strict.packets[0].wiki.map((w) => w.source_key)).toEqual(["wiki:bp-c"]);
    const loose = await compileAtlasContext(root, { include_working_drafts: true });
    expect(loose.packets[0].wiki.map((w) => w.source_key).sort()).toEqual(["wiki:bp-c", "wiki:bp-d"]);
    // manifest 记录来源状态(前端 badge)。
    expect(loose.source_manifest.find((m) => m.source_id === "bp-d")?.source_status).toBe("draft");
  });

  it("标题含地点名/别名 或 linked_asset_refs 命中; 每地点 ≤3 页(计划 wiki 上限)", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城", aliases: ["水城"] });
    for (let i = 0; i < 4; i++) {
      writeBiblePage(root, { slug: `bp-t${i}`, title: `临水城卷${i}` }, `内容${i}`);
    }
    writeBiblePage(root, { slug: "bp-alias", title: "水城旧事" }, "别名命中");
    writeBiblePage(root, { slug: "bp-link", title: "无关", linked_asset_refs: [{ slug: "loc-a" }] }, "链接命中");
    writeBiblePage(root, { slug: "bp-miss", title: "其他城" }, "不命中");
    const r = await compileAtlasContext(root);
    const keys = r.packets[0].wiki.map((w) => w.source_key);
    expect(keys.length).toBe(ATLAS_WIKI_PER_LOCATION);
    expect(ATLAS_WIKI_PER_LOCATION).toBe(3);
    // 显式链接页优先(对齐旧引擎 linked-first; review F4), 其余按 slug: bp-link, bp-alias, bp-t0。
    expect(keys).toEqual(["wiki:bp-link", "wiki:bp-alias", "wiki:bp-t0"]);
    expect(keys).not.toContain("wiki:bp-miss");
  });
});

describe("compileAtlasContext 预算与确定性(计划 §4 Phase 2 预算; 规则 4)", () => {
  it("每地点文本 ≤8000 字(单族独占预算截断)", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    writeBiblePage(root, { slug: "bp-big", title: "临水城" }, "字".repeat(12000));
    const r = await compileAtlasContext(root);
    const total = r.packets[0].wiki.reduce((s, w) => s + w.text.length, 0);
    expect(total).toBe(ATLAS_CHARS_PER_LOCATION);
    expect(ATLAS_CHARS_PER_LOCATION).toBe(8000);
    // manifest 只从实际片段生成，同时保留原文/实发双 hash。
    expect(r.packets[0].source_keys).toEqual(["wiki:bp-big"]);
    expect(r.source_manifest.length).toBe(1);
    expect(r.source_manifest[0]).toMatchObject({
      source_id: "bp-big",
      included_range: { start: 0, end: ATLAS_CHARS_PER_LOCATION },
      truncated: true,
    });
    expect(r.source_manifest[0].included_content_hash).not.toBe(r.source_manifest[0].source_hash);
  });

  it("整条来源被预算丢弃后不进 manifest，plan validator 也不允许引用", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    writeBiblePage(root, { slug: "bp-a-big", title: "临水城 A" }, "字".repeat(9000));
    writeBiblePage(root, { slug: "bp-z-drop", title: "临水城 Z" }, "未送入证据");
    const dropped = await compileAtlasContext(root);
    expect(dropped.packets[0].source_keys).toEqual(["wiki:bp-a-big"]);
    expect(dropped.source_manifest.map((source) => source.source_id)).toEqual(["bp-a-big"]);
    const plan: AtlasPlan = {
      style_brief: "x",
      nodes: [{
        plan_key: "n1", parent_plan_key: null, location_ref: "loc-a", title: "临水城",
        level: "city", summary: "x", visual_brief: "临水城", prompt: "x",
        evidence: { supported: ["x"], visual_fill: [], conflicts: [] },
        sources: [{
          source_type: "bible_page", source_id: "bp-z-drop",
          open_target: { kind: "bible_page", slug: "bp-z-drop" },
        }],
        annotations: [],
      }],
    };
    expect(validatePlanSources(plan, dropped.source_manifest).join()).toContain("not in compiled context");
  });

  it("review F1 回归: 8 个地点各近 8000 字, 证据不被批预算清空(批预算=5×8000 结构性满足)", async () => {
    const root = makeRoot();
    for (let i = 0; i < 8; i++) {
      const slug = `loc-${String(i).padStart(2, "0")}`;
      writeObject(root, { id: slug, name: `地点${String(i).padStart(2, "0")}` });
      writeBiblePage(root, { slug: `bp-${String(i).padStart(2, "0")}`, title: `地点${String(i).padStart(2, "0")}志` }, "字".repeat(7900));
    }
    const r = await compileAtlasContext(root);
    expect(r.packets.length).toBe(8);
    for (const p of r.packets) {
      const total = p.wiki.reduce((s, w) => s + w.text.length, 0);
      expect(total).toBeGreaterThan(7000); // 第 6~8 地点证据仍在(F1 修复前会被清空)。
      expect(total).toBeLessThanOrEqual(ATLAS_CHARS_PER_LOCATION);
    }
  });

  it("同输入两次编译 context_hash 相同(确定性)", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城", importance: 3 });
    writeBiblePage(root, { slug: "bp-1", title: "临水城志" }, "正文");
    const a = await compileAtlasContext(root);
    const b = await compileAtlasContext(root);
    expect(a.context_hash).toBe(b.context_hash);
    expect(a.location_source_hashes).toEqual(b.location_source_hashes);
    expect(a.source_manifest.map((m) => m.source_id)).toEqual(
      b.source_manifest.map((m) => m.source_id),
    );
  });

  it("同一 source 跨地点只有一条无歧义 manifest，context_hash 覆盖实际 packet", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "甲城", importance: 10 });
    writeObject(root, { id: "loc-b", name: "共享" });
    writeBiblePage(root, { slug: "bp-shared", title: "共享志", linked_asset_refs: ["loc-a"] }, "共".repeat(6000));
    writeBiblePage(root, { slug: "bp-big", title: "乙城档", linked_asset_refs: ["loc-b"] }, "大".repeat(7000));
    const first = await compileAtlasContext(root);
    const shared = first.source_manifest.filter((source) => source.source_id === "bp-shared");
    expect(shared).toHaveLength(1);
    const snippets = first.packets.flatMap((packet) => packet.wiki)
      .filter((item) => item.source_key === "wiki:bp-shared");
    expect(snippets).toHaveLength(2);
    expect(new Set(snippets.map((item) => item.text))).toHaveLength(1);
    expect(shared[0].included_range?.end).toBe(snippets[0].text.length);
    const manifestKeys = new Set(first.source_manifest.map((source) =>
      `${source.source_type === "bible_page" ? "wiki" : "rag"}:${source.source_id}`));
    expect(new Set(first.packets.flatMap((packet) => packet.source_keys))).toEqual(manifestKeys);

    writeObject(root, { id: "loc-a", name: "甲城", aliases: ["新别名"], importance: 10 });
    const changed = await compileAtlasContext(root);
    expect(changed.context_hash).not.toBe(first.context_hash);
  });

  it("空证据不阻断后续有效来源；Unicode 截断不拆 surrogate pair", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    for (let i = 0; i < 3; i++) writeBiblePage(root, { slug: `bp-empty-${i}`, title: `临水城空页 ${i}` }, "");
    writeBiblePage(root, { slug: "bp-z-valid", title: "临水城志" }, "有效证据");
    const valid = await compileAtlasContext(root);
    expect(valid.packets[0].source_keys).toEqual(["wiki:bp-z-valid"]);

    writeBiblePage(root, { slug: "bp-0-emoji", title: "临水城 emoji", linked_asset_refs: ["loc-a"] }, `a${"😀".repeat(5000)}`);
    const unicode = await compileAtlasContext(root);
    const item = unicode.packets[0].wiki.find((source) => source.source_key === "wiki:bp-0-emoji");
    expect(item).toBeDefined();
    const last = item!.text.charCodeAt(item!.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(unicode.packets[0].wiki.reduce((sum, source) => sum + source.text.length, 0))
      .toBeLessThanOrEqual(ATLAS_CHARS_PER_LOCATION);
  });

  it("derived RAG 含 lone surrogate 时 fail-closed，不产生 hash 归一碰撞", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    rebuildRagIndex(root, [{
      chunk_id: "bad-unicode",
      source_type: "world_entity",
      chunk_index: 0,
      char_count: 4,
      text: "临水城\ud800",
      visibility: "author_only",
      importance: 1,
      index_version: INDEX_VERSION_CN,
      embedding_status: "pending",
    }]);
    await expect(compileAtlasContext(root)).rejects.toThrow(/Unicode/);
  });

  it("只有地点名、无 retained/openable 证据时 insufficient，不为名字支付 LLM", async () => {
    const root = makeRoot();
    writeObject(root, { id: "loc-a", name: "临水城" });
    const r = await compileAtlasContext(root);
    expect(r.packets).toEqual([]);
    expect(r.source_manifest).toEqual([]);
    expect(r.insufficient_sources).toBe(true);
    expect(r.message).toContain("没有可核对的保留证据");
  });
});
