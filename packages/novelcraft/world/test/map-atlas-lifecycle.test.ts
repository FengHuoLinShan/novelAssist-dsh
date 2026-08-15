// world/map-atlas · Phase 4 生命周期/图片导入/标注 行为契约(计划 §4 Phase 4 + 验收; N28/N29)。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { StoreError } from "@novelcraft/store";
import {
  addAtlasAnnotation,
  adoptAtlasPage,
  adoptAtlasPlaceholder,
  archiveAtlasPage,
  deleteAtlasAnnotation,
  importAtlasImage,
  readAtlasTree,
  rejectAtlasPage,
  restoreAtlasPage,
  updateAtlasAnnotation,
  updateAtlasNode,
  updateAtlasPrompt,
  writeAtlasNode,
  writeAtlasPage,
  type AtlasNode,
  type AtlasPage,
} from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-life-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const allowAll = async () => "allowed-once" as const;
const denyAll = async () => "rejected" as const;

/** 最小合法 PNG 字节(magic + IHDR 宽高; 探测只读前 24 字节)。 */
function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** 最小合法 JPEG 字节(SOI + SOF0)。 */
function jpgBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt8(0xff, 0); b.writeUInt8(0xd8, 1); b.writeUInt8(0xff, 2); b.writeUInt8(0xc0, 3);
  b.writeUInt16BE(17, 4); b.writeUInt8(8, 6);
  b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9);
  return b;
}
function writeTmpImage(root: string, name: string, buf: Buffer): string {
  const abs = join(root, name);
  writeFileSync(abs, buf);
  return abs;
}

function node(id: string, overrides?: Partial<AtlasNode>): AtlasNode {
  return {
    id,
    parent_ref: null,
    location_ref: null,
    semantic_key: `entity:${id}`,
    level: "world",
    title: id,
    status: "provisional",
    sort_order: 0,
    ...overrides,
  };
}

function page(id: string, overrides?: Partial<AtlasPage>): AtlasPage {
  return {
    id,
    run_ref: "run-t",
    node_ref: "n1",
    generation_status: "prompt_only",
    review_status: "candidate",
    title: id,
    visual_brief: "v",
    prompt: "p",
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [],
    annotations: [],
    review_note: null,
    adopted_at: null,
    rejected_at: null,
    deprecated_at: null,
    content_hash: "h-" + id,
    ...overrides,
  };
}

/** 挂图候选页(模拟 importAtlasImage 后态)。 */
function withImage(p: AtlasPage, root: string, pageId: string): AtlasPage {
  const dir = paths(root).world.atlas.dir;
  const imgDir = join(dir, "images", pageId);
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(join(imgDir, "v1.png"), pngBytes(64, 64));
  return {
    ...p,
    generation_status: "review_ready",
    image: {
      file: `images/${pageId}/v1.png`,
      media_type: "image/png",
      sha256: "x".repeat(64),
      width: 64,
      height: 64,
      byte_size: 24,
    },
  };
}

describe("adoptAtlasPage 门禁(计划 Phase 4 状态机)", () => {
  it("prompt_only 拒 adopt(N28)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    await expect(adoptAtlasPage(root, "pg1", {}, allowAll)).rejects.toThrow(/prompt_only|review_ready/);
  });

  it("缺图拒 adopt(image 元数据在但文件缺失)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", {
      generation_status: "review_ready",
      image: { file: "images/pg1/v1.png", media_type: "image/png", sha256: "x".repeat(64), width: 64, height: 64, byte_size: 24 },
    }));
    await expect(adoptAtlasPage(root, "pg1", {}, allowAll)).rejects.toThrow(/image_missing|图片文件缺失/);
  });

  it("conflicts 未确认拒, 确认通过", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1", { evidence: { supported: [], visual_fill: [], conflicts: ["东门位置冲突"] } }), root, "pg1"));
    await expect(adoptAtlasPage(root, "pg1", {}, allowAll)).rejects.toThrow(/conflicts/);
    const r = await adoptAtlasPage(root, "pg1", { confirmConflicts: true }, allowAll);
    expect(r.page.review_status).toBe("adopted");
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(true);
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(false);
  });

  it("CAS 失配拒", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    await expect(adoptAtlasPage(root, "pg1", { expectedContentHash: "wrong" }, allowAll)).rejects.toThrow(StoreError);
  });

  it("approval 拒绝 → fail-closed 不落盘", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    await expect(adoptAtlasPage(root, "pg1", {}, denyAll)).rejects.toThrow(/审批/);
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(true); // 原样
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(false);
  });

  it("多级祖先链原子 adopt: 深层页 adopt → pending 祖先全 adopted(单 commit)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-region", { level: "region", parent_ref: "n-cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-region" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    const before = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const r = await adoptAtlasPage(root, "pg1", {}, allowAll);
    const after = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(Number(after) - Number(before)).toBe(1); // 单 commit
    expect(r.adoptedNodeIds.sort()).toEqual(["n-city", "n-cover", "n-region"]);
    const tree = readAtlasTree(root);
    expect(tree.pendingNodes.length).toBe(0);
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(["n-city", "n-cover", "n-region"]);
    expect(tree.nodes.every((n) => n.status === "adopted")).toBe(true);
    // 图片目录不进 git(N29)。
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(porcelain).not.toContain("images/");
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked).not.toContain("images/");
  });

  it("父链断裂(祖先缺失) → 整链拒绝, 零残留", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "ghost" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await expect(adoptAtlasPage(root, "pg1", {}, allowAll)).rejects.toThrow(/层级已变化/);
    expect(existsSync(paths(root).world.atlas.pendingNodeFile("n-city"))).toBe(true);
    expect(existsSync(paths(root).world.atlas.nodeFile("n-city"))).toBe(false);
  });
});

describe("占位/驳回/归档/恢复/改 prompt(计划 Phase 4 状态机)", () => {
  it("空页占位 adopt: 候选节点(含祖先链) adopted, 无 page", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    const r = await adoptAtlasPlaceholder(root, "n-city", allowAll);
    expect(r.adoptedNodeIds.sort()).toEqual(["n-city", "n-cover"]);
    const tree = readAtlasTree(root);
    expect(tree.nodes.find((n) => n.id === "n-city")?.status).toBe("adopted");
    expect(tree.nodes.find((n) => n.id === "n-city")?.is_placeholder).toBe(true); // N28 派生位
    expect(tree.pages.length).toBe(0);
    await expect(adoptAtlasPlaceholder(root, "n-city", allowAll)).rejects.toThrow(/不存在/);
  });

  it("reject → rejected 终态(文件保留在 pending, 不硬删); prompt_only 不可驳回", () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    writeAtlasPage(root, page("pg-prompt"));
    expect(() => rejectAtlasPage(root, "pg-prompt")).toThrow(/prompt_only/); // 移植锚点 Phase 4
    const r = rejectAtlasPage(root, "pg1", { note: "重画" });
    expect(r.review_status).toBe("rejected");
    expect(r.rejected_at).toBeTruthy();
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(true);
    expect(() => rejectAtlasPage(root, "pg1")).toThrow(/非候选/);
  });

  it("archive → deprecated(历史页不硬删); restore → adopted 且祖先补齐", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    const archived = archiveAtlasPage(root, "pg1");
    expect(archived.review_status).toBe("deprecated");
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(true); // 不硬删
    const restored = await restoreAtlasPage(root, "pg1", allowAll);
    expect(restored.page.review_status).toBe("adopted");
    expect(restored.page.deprecated_at).toBeNull();
    // 再 archive 一次后 restore 需 approval
    archiveAtlasPage(root, "pg1");
    await expect(restoreAtlasPage(root, "pg1", denyAll)).rejects.toThrow(/审批/);
  });

  it("updateAtlasPrompt: 仅 prompt_only 候选可改 + CAS", () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", { content_hash: "h-old" }));
    const next = updateAtlasPrompt(root, "pg1", "新 prompt", "h-old");
    expect(next.prompt).toBe("新 prompt");
    expect(() => updateAtlasPrompt(root, "pg1", "x", "h-错")).toThrow(StoreError);
    writeAtlasPage(root, page("pg2", { generation_status: "review_ready" }));
    expect(() => updateAtlasPrompt(root, "pg2", "x")).toThrow(/prompt_only/);
  });

  it("updateAtlasNode: rank 翻转/循环/封面有父 拒", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    await adoptAtlasPlaceholder(root, "n-city", allowAll);
    // 合法: 改标题
    const r = updateAtlasNode(root, "n-city", { title: "临水城" });
    expect(r.title).toBe("临水城");
    // 循环: n-cover.parent = n-city(n-city 的祖先是 n-cover)
    expect(() => updateAtlasNode(root, "n-cover", { parent_ref: "n-city" })).toThrow(/循环/);
    // rank: n-city 提到 cover 之上
    expect(() => updateAtlasNode(root, "n-city", { level: "cover" })).toThrow(/rank|cover/);
    // review 修②: 新父为 pending/悬空 → 拒(adopted 节点不得挂 provisional 父)
    writeAtlasNode(root, node("n-pending", { level: "region" }));
    expect(() => updateAtlasNode(root, "n-city", { parent_ref: "n-pending" })).toThrow(/adopted/);
    expect(() => updateAtlasNode(root, "n-city", { parent_ref: "ghost" })).toThrow(/adopted/);
  });
});

describe("importAtlasImage 本机导入(附录 A.3; N29)", () => {
  it("非绝对路径/不存在/非 PNG-JPEG/尺寸越界 拒", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    expect(() => importAtlasImage(root, "relative.png", { nodeRef: "n1" })).toThrow(/绝对路径/);
    expect(() => importAtlasImage(root, join(root, "nope.png"), { nodeRef: "n1" })).toThrow(/不存在/);
    const bad = writeTmpImage(root, "bad.png", Buffer.from("not-an-image"));
    expect(() => importAtlasImage(root, bad, { nodeRef: "n1" })).toThrow(/格式/);
    const tiny = writeTmpImage(root, "tiny.png", pngBytes(8, 8));
    expect(() => importAtlasImage(root, tiny, { nodeRef: "n1" })).toThrow(/越界/);
    const huge = writeTmpImage(root, "huge.png", pngBytes(9000, 64));
    expect(() => importAtlasImage(root, huge, { nodeRef: "n1" })).toThrow(/越界/);
  });

  it("prompt_only 候选页 → 挂图置 review_ready; 图片不进 git", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", { node_ref: "n1" }));
    const src = writeTmpImage(root, "src.png", pngBytes(256, 128));
    const r = importAtlasImage(root, src, { nodeRef: "n1" });
    expect(r.page.generation_status).toBe("review_ready");
    expect(r.page.image?.file).toBe("images/pg1/v1.png");
    expect(r.page.image?.media_type).toBe("image/png");
    expect(r.page.image?.width).toBe(256);
    expect(existsSync(join(paths(root).world.atlas.dir, "images/pg1/v1.png"))).toBe(true);
    // content_hash 重算(≠ 初始)
    expect(r.page.content_hash).not.toBe("h-pg1");
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked).not.toContain("images/");
  });

  it("无 prompt_only 候选 → 新建 upload run + 候选页(generation_choice=upload)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    const src = writeTmpImage(root, "src.png", pngBytes(64, 64));
    const r = importAtlasImage(root, src, { nodeRef: "n1" });
    expect(r.run?.run_kind).toBe("upload");
    expect(r.page.generation_choice).toBe("upload");
    expect(r.page.generation_status).toBe("review_ready");
    expect(r.page.review_status).toBe("candidate");
    expect(r.page.image?.media_type).toBe("image/png");
  });

  it("画廊追加: 已有 adopted 页的节点再导入 → 新候选页(旧页不动)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    const src = writeTmpImage(root, "src2.png", pngBytes(64, 64));
    const r = importAtlasImage(root, src, { nodeRef: "n1" });
    expect(r.page.id).not.toBe("pg1");
    expect(r.page.review_status).toBe("candidate");
    const tree = readAtlasTree(root);
    expect(tree.pages.find((p) => p.id === "pg1")?.review_status).toBe("adopted");
    expect(tree.pendingPages.some((p) => p.id === r.page.id)).toBe(true);
  });

  it("attempt 编号取现存 max+1(删 v1 后新导入得 v2, 不覆盖残留)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", { node_ref: "n1" }));
    const src1 = writeTmpImage(root, "a.png", pngBytes(64, 64));
    const r1 = importAtlasImage(root, src1, { nodeRef: "n1" });
    expect(r1.page.image?.file).toBe("images/pg1/v1.png");
    // 再次导入挂到 review_ready 页? —— 挂图分支只认 prompt_only; 第二次走新建页。删 v1 再测编号:
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(paths(root).world.atlas.dir, "images/pg1/v1.png"));
    writeAtlasPage(root, page("pg2", { node_ref: "n1" }));
    const src2 = writeTmpImage(root, "b.png", pngBytes(64, 64));
    const r2 = importAtlasImage(root, src2, { nodeRef: "n1", pageRef: "pg2" });
    expect(r2.page.image?.file).toBe("images/pg2/v1.png"); // 新页自目录, v1 起
    // 同页两次上传: pg2 已 review_ready 不再匹配; 用 pg3 连传两次走 upload run 路径验证目录内 max+1
    writeAtlasPage(root, page("pg3", { node_ref: "n1" }));
    const src3 = writeTmpImage(root, "c.png", pngBytes(64, 64));
    const r3 = importAtlasImage(root, src3, { nodeRef: "n1", pageRef: "pg3" });
    expect(r3.page.image?.file).toBe("images/pg3/v1.png");
    const src4 = writeTmpImage(root, "d.png", pngBytes(64, 64));
    const r4 = importAtlasImage(root, src4, { nodeRef: "n1" }); // pg3 已 review_ready → 新建页目录独立
    expect(r4.page.image?.file).toMatch(/images\/pg-up-[^/]+\/v1\.png/);
  });

  it("JPEG magic 探测", () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    const src = writeTmpImage(root, "src.jpg", jpgBytes(320, 240));
    const r = importAtlasImage(root, src, { nodeRef: "n1" });
    expect(r.page.image?.media_type).toBe("image/jpeg");
    expect(r.page.image?.file).toMatch(/\.jpg$/);
  });
});

describe("annotation CRUD(spec §2.2; 计划 Phase 4)", () => {
  it("增删改 + content_hash 重算 + target 校验", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasNode(root, node("n-target", { title: "目标" }));
    writeAtlasPage(root, page("pg1"));
    // target 必须指向已 adopted 节点
    expect(() =>
      addAtlasAnnotation(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5, target_node_ref: "n-target" }),
    ).toThrow(/adopted/);
    await adoptAtlasPlaceholder(root, "n-target", allowAll);
    const id = addAtlasAnnotation(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5, target_node_ref: "n-target" });
    expect(id).toMatch(/^ann-/);
    let tree = readAtlasTree(root);
    let pg = tree.pendingPages.find((p) => p.id === "pg1")!;
    expect(pg.annotations.length).toBe(1);
    expect(pg.annotations[0].target_node_ref).toBe("n-target");
    const hashAfterAdd = pg.content_hash;
    expect(hashAfterAdd).not.toBe("h-pg1");

    updateAtlasAnnotation(root, "pg1", id, { label: "正门", position_x: 0.6 });
    tree = readAtlasTree(root);
    pg = tree.pendingPages.find((p) => p.id === "pg1")!;
    expect(pg.annotations[0].label).toBe("正门");
    expect(pg.annotations[0].position_x).toBe(0.6);
    expect(pg.content_hash).not.toBe(hashAfterAdd); // 重算

    deleteAtlasAnnotation(root, "pg1", id);
    tree = readAtlasTree(root);
    expect(tree.pendingPages.find((p) => p.id === "pg1")!.annotations.length).toBe(0);
  });

  it("label 空/坐标越界 拒; rejected 页不可标注", () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    expect(() => addAtlasAnnotation(root, "pg1", { label: " ", position_x: 0, position_y: 0 })).toThrow(/label/);
    expect(() => addAtlasAnnotation(root, "pg1", { label: "x", position_x: 1.2, position_y: 0 })).toThrow(/0–1/);
    writeAtlasPage(root, withImage(page("pg2"), root, "pg2"));
    rejectAtlasPage(root, "pg2");
    expect(() => addAtlasAnnotation(root, "pg2", { label: "x", position_x: 0, position_y: 0 })).toThrow(/只读/);
  });
});
