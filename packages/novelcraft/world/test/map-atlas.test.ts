// world/map-atlas 行为契约(map-atlas 实施计划 §2/§4 Phase 1; N28/N29)。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { gitAdd, gitCommit, gitStatusPorcelain } from "@novelcraft/store";
import {
  ATLAS_LEVEL_RANK,
  readAtlasRun,
  readAtlasTree,
  latestAtlasRun,
  listAtlasHistory,
  writeAtlasImage,
  writeAtlasNode,
  writeAtlasPage,
  writeAtlasRun,
} from "../src/index";
import type { AtlasNode, AtlasPage, AtlasRun } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function makePage(overrides: Partial<AtlasPage> & { id: string; node_ref: string }): AtlasPage {
  return {
    run_ref: "atlas-run-1",
    generation_status: "review_ready",
    review_status: "adopted",
    title: overrides.id,
    visual_brief: "",
    prompt: "",
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [],
    annotations: [],
    review_note: null,
    adopted_at: null,
    rejected_at: null,
    deprecated_at: null,
    content_hash: "sha256-deadbeef",
    ...overrides,
  };
}

describe("readAtlasTree(§2 文件模型; N28/N29)", () => {
  it("空 vault / 目录不存在 → 空结构, 不抛错", () => {
    const root = makeRoot();
    const t = readAtlasTree(root);
    expect(t.nodes).toEqual([]);
    expect(t.pages).toEqual([]);
    expect(t.pendingNodes).toEqual([]);
    expect(t.pendingPages).toEqual([]);
    expect(t.tree).toEqual([]);
  });

  it("node/page 写入→读回 round-trip(adopted → nodes/ + pages/)", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "cover", level: "cover", title: "封面", sort_order: 0 }));
    writeAtlasPage(
      root,
      makePage({
        id: "page-cover",
        node_ref: "cover",
        review_status: "adopted",
        title: "封面",
        visual_brief: "长安城俯瞰",
        annotations: [{ id: "ann-1", label: "长安", position_x: 0.5, position_y: 0.3, sort_order: 0 }],
      }),
      { adopted: true },
    );
    const t = readAtlasTree(root);
    expect(t.nodes.map((n) => n.id)).toEqual(["cover"]);
    expect(t.nodes[0].title).toBe("封面");
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].node_ref).toBe("cover");
    expect(t.pages[0].annotations[0].label).toBe("长安");
    expect(t.pendingNodes).toEqual([]);
    expect(t.pendingPages).toEqual([]);
  });

  it("generation_choice 仅 'upload' 时序列化/读回(specs/assets/map-atlas.md)", () => {
    const root = makeRoot();
    writeAtlasPage(root, makePage({ id: "page-upl", node_ref: "cover", review_status: "candidate", generation_choice: "upload" }));
    writeAtlasPage(root, makePage({ id: "page-plain", node_ref: "cover", review_status: "candidate" }));
    const t = readAtlasTree(root);
    const byId = new Map(t.pendingPages.map((p) => [p.id, p]));
    expect(byId.get("page-upl")!.generation_choice).toBe("upload");
    expect(byId.get("page-plain")!.generation_choice).toBeUndefined();
  });

  it("pending 与 adopted 分区正确(provisional → pending/nodes)", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "adopted", status: "adopted" }));
    writeAtlasNode(root, makeNode({ id: "candidate", status: "provisional" }));
    writeAtlasPage(root, makePage({ id: "page-adopted", node_ref: "adopted", review_status: "adopted" }), { adopted: true });
    writeAtlasPage(root, makePage({ id: "page-candidate", node_ref: "candidate", review_status: "candidate", generation_status: "review_ready" }));
    const t = readAtlasTree(root);
    expect(t.nodes.map((n) => n.id)).toEqual(["adopted"]);
    expect(t.pendingNodes.map((n) => n.id)).toEqual(["candidate"]);
    expect(t.pages.map((p) => p.id)).toEqual(["page-adopted"]);
    expect(t.pendingPages.map((p) => p.id)).toEqual(["page-candidate"]);
  });

  it("tree 排序确定性: sort_order 然后 title", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "root", level: "cover", title: "Root", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "beta", parent_ref: "root", level: "world", title: "Beta", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "alpha", parent_ref: "root", level: "world", title: "Alpha", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "gamma", parent_ref: "root", level: "world", title: "Alpha", sort_order: 1 }));
    const t = readAtlasTree(root);
    expect(t.tree.map((n) => n.node.id)).toEqual(["root"]);
    // sort_order 0(Alpha < Beta)先, 再 sort_order 1(gamma 同名 Alpha)。
    expect(t.tree[0].children.map((n) => n.node.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("is_placeholder 派生(N28): adopted 节点无 adopted page → true", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "empty", status: "adopted" }));
    writeAtlasNode(root, makeNode({ id: "filled", status: "adopted" }));
    writeAtlasPage(root, makePage({ id: "page-filled", node_ref: "filled", review_status: "adopted" }), { adopted: true });
    const t = readAtlasTree(root);
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    expect(byId.get("empty")!.is_placeholder).toBe(true); // N28 空页占位
    expect(byId.get("filled")!.is_placeholder).toBe(false);
    // provisional 节点不算占位。
    writeAtlasNode(root, makeNode({ id: "provisional", status: "provisional" }));
    const t2 = readAtlasTree(root);
    expect(t2.pendingNodes.find((n) => n.id === "provisional")!.is_placeholder).toBe(false);
  });

  it("image_missing 派生(N29): 有 image 元数据无本地文件 → true", () => {
    const root = makeRoot();
    writeAtlasPage(
      root,
      makePage({
        id: "page-x",
        node_ref: "cover",
        review_status: "adopted",
        image: { file: "images/page-x/v1.png", media_type: "image/png", sha256: "abc", width: 100, height: 100, byte_size: 8 },
      }),
      { adopted: true },
    );
    let t = readAtlasTree(root);
    expect(t.pages[0].image_missing).toBe(true); // 有 image.file 但文件不存在
    // 补上本地图片 → image_missing 翻转。
    writeAtlasImage(root, "page-x", "v1", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png");
    t = readAtlasTree(root);
    expect(t.pages[0].image_missing).toBe(false);
  });

  it("prompt_only 页面无 image → image_missing 恒 false(非缺图, 而是未生成)", () => {
    const root = makeRoot();
    writeAtlasPage(root, makePage({ id: "page-prompt", node_ref: "cover", review_status: "candidate", generation_status: "prompt_only" }));
    const t = readAtlasTree(root);
    expect(t.pendingPages[0].image).toBeUndefined();
    expect(t.pendingPages[0].image_missing).toBe(false);
  });
});

describe("run 读写(.assistant/atlas/runs; §2.3)", () => {
  function makeRun(id: string, created_at: string): AtlasRun {
    return {
      schema_version: 1,
      id,
      run_kind: "initial",
      status: "planning",
      options: { style_note: "", include_working_drafts: false, include_interiors: false, full_rebuild: false },
      context_hash: "",
      source_manifest: [],
      spatial_evidence: {},
      atlas_plan: { style_brief: "", nodes: [] },
      planned_page_count: 0,
      checkpoint: "spatial:2",
      error_code: null,
      error_message: null,
      journal: [],
      created_at,
    };
  }

  it("writeAtlasRun → readAtlasRun round-trip; latest/listAtlasHistory 按时间确定性排序", () => {
    const root = makeRoot();
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z"));
    writeAtlasRun(root, makeRun("atlas-run-2", "2026-08-15T00:00:01.000Z"));

    const r1 = readAtlasRun(root, "atlas-run-1");
    expect(r1.id).toBe("atlas-run-1");
    expect(r1.run_kind).toBe("initial");
    expect(r1.status).toBe("planning");
    expect(r1.checkpoint).toBe("spatial:2");

    expect(latestAtlasRun(root)!.id).toBe("atlas-run-2"); // 最新在前
    expect(listAtlasHistory(root).map((r) => r.id)).toEqual(["atlas-run-2", "atlas-run-1"]);
  });

  it("无 run 时 latestAtlasRun → null, listAtlasHistory → []", () => {
    const root = makeRoot();
    expect(latestAtlasRun(root)).toBeNull();
    expect(listAtlasHistory(root)).toEqual([]);
  });

  it("readAtlasRun 不存在 → 抛错(与 readObject 同口径)", () => {
    const root = makeRoot();
    expect(() => readAtlasRun(root, "missing")).toThrow(/不存在/);
  });
});

describe("writeAtlasImage(§4 Phase 1; N29 图片不进 git)", () => {
  it("只写本地图片目录; git status 干净且图片文件在磁盘", () => {
    const root = makeRoot();
    gitAdd(root);
    gitCommit(root, "baseline");
    const rel = writeAtlasImage(root, "page-x", "v1", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png");
    expect(rel).toBe("images/page-x/v1.png");
    expect(existsSync(join(root, "world", "atlas", "images", "page-x", "v1.png"))).toBe(true);
    // N29: 图片被 gitignore, 不产生未提交改动。
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("支持 sourcePath 复制模式", () => {
    const root = makeRoot();
    const src = join(tmpdir(), `ncma-src-${Date.now()}.png`);
    rmSync(src, { force: true });
    // 写一个源文件供复制。
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const rel = writeAtlasImage(root, "page-y", "v2", src, "png");
      expect(rel).toBe("images/page-y/v2.png");
      expect(existsSync(join(root, "world", "atlas", "images", "page-y", "v2.png"))).toBe(true);
    } finally {
      rmSync(src, { force: true });
    }
  });

  it("guardPath/路径段拒绝 ../ 穿越(N29)", () => {
    const root = makeRoot();
    expect(() => writeAtlasImage(root, "../evil", "v1", new Uint8Array([1]), "png")).toThrow(/非法路径段/);
    expect(() => writeAtlasImage(root, "page", "..", new Uint8Array([1]), "png")).toThrow(/非法路径段/);
    expect(() => writeAtlasImage(root, "page", "v1", new Uint8Array([1]), "../evil")).toThrow(/非法图片扩展名|非法路径段/);
    // writeAtlasNode 的 id 含可逃逸的 ../ → guardPath 拒绝(节点/页面写面同样过 guardPath)。
    expect(() =>
      writeAtlasNode(root, makeNode({ id: "../../../../outside", level: "world" })),
    ).toThrow(/escapes vault root/);
  });

  it("非法扩展名拒绝(A.3 白名单)", () => {
    const root = makeRoot();
    expect(() => writeAtlasImage(root, "page", "v1", new Uint8Array([1]), "gif")).toThrow(/非法图片扩展名/);
  });
});

describe("ATLAS_LEVEL_RANK(规则 1 层级锚点)", () => {
  it("父级 rank 严格大于子级", () => {
    expect(ATLAS_LEVEL_RANK.cover).toBeGreaterThan(ATLAS_LEVEL_RANK.world);
    expect(ATLAS_LEVEL_RANK.world).toBeGreaterThan(ATLAS_LEVEL_RANK.region);
    expect(ATLAS_LEVEL_RANK.region).toBeGreaterThan(ATLAS_LEVEL_RANK.city);
    expect(ATLAS_LEVEL_RANK.city).toBeGreaterThan(ATLAS_LEVEL_RANK.district);
    expect(ATLAS_LEVEL_RANK.district).toBeGreaterThan(ATLAS_LEVEL_RANK.street);
    expect(ATLAS_LEVEL_RANK.street).toBeGreaterThan(ATLAS_LEVEL_RANK.interior);
  });
});
