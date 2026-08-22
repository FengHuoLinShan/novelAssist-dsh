// world/map-atlas · Phase 4 生命周期/图片导入/标注 行为契约(计划 §4 Phase 4 + 验收; N28/N29)。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter, StoreError } from "@novelcraft/store";
import {
  addAtlasAnnotation,
  adoptAtlasPage,
  adoptAtlasPlaceholder,
  applyAtlasAnnotationOps,
  archiveAtlasPage,
  computeAtlasPageContentHash,
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

  it("reject → rejected 终态(文件保留在 pending, 不硬删); prompt_only 不可驳回", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    writeAtlasPage(root, page("pg-prompt"));
    await expect(rejectAtlasPage(root, "pg-prompt")).rejects.toThrow(/prompt_only/); // 移植锚点 Phase 4
    const r = await rejectAtlasPage(root, "pg1", { note: "重画" });
    expect(r.review_status).toBe("rejected");
    expect(r.rejected_at).toBeTruthy();
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(true);
    await expect(rejectAtlasPage(root, "pg1")).rejects.toThrow(/非候选/);
  });

  it("archive → deprecated(历史页不硬删); restore → adopted 且祖先补齐", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    const archived = await archiveAtlasPage(root, "pg1");
    expect(archived.review_status).toBe("deprecated");
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(true); // 不硬删
    const restored = await restoreAtlasPage(root, "pg1", allowAll);
    expect(restored.page.review_status).toBe("adopted");
    expect(restored.page.deprecated_at).toBeNull();
    // 再 archive 一次后 restore 需 approval
    await archiveAtlasPage(root, "pg1");
    await expect(restoreAtlasPage(root, "pg1", denyAll)).rejects.toThrow(/审批/);
  }, 15_000);

  it("updateAtlasPrompt: 仅 prompt_only 候选可改 + CAS", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", { content_hash: "h-old" }));
    const next = await updateAtlasPrompt(root, "pg1", "新 prompt", "h-old");
    expect(next.prompt).toBe("新 prompt");
    await expect(updateAtlasPrompt(root, "pg1", "x", "h-错")).rejects.toThrow(StoreError);
    writeAtlasPage(root, page("pg2", { generation_status: "review_ready" }));
    await expect(updateAtlasPrompt(root, "pg2", "x")).rejects.toThrow(/prompt_only/);
  });

  it("updateAtlasPrompt 一致性: 改 prompt 后 content_hash 用 computeAtlasPageContentHash 重算", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1", { content_hash: "h-old" }));
    const next = await updateAtlasPrompt(root, "pg1", "新 prompt", "h-old");
    expect(next.content_hash).not.toBe("h-old"); // 旧哈希不得残留
    // 与同口径重算一致(并读回落盘文件复核)。
    expect(next.content_hash).toBe(computeAtlasPageContentHash(next as AtlasPage));
    const { data } = parseFrontmatter(readFileSync(paths(root).world.atlas.pendingPageFile("pg1"), "utf8"));
    expect(data.content_hash).toBe(computeAtlasPageContentHash(next as AtlasPage));
    // CAS 用重算后的新哈希可再次修改。
    const again = await updateAtlasPrompt(root, "pg1", "再改", next.content_hash);
    expect(again.content_hash).not.toBe(next.content_hash);
    expect(again.content_hash).toBe(computeAtlasPageContentHash(again as AtlasPage));
  });

  it("updateAtlasNode: rank 翻转/循环/封面有父 拒", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    await adoptAtlasPlaceholder(root, "n-city", allowAll);
    // 合法: 改标题
    const r = await updateAtlasNode(root, "n-city", { title: "临水城" });
    expect(r.title).toBe("临水城");
    // 循环: n-cover.parent = n-city(n-city 的祖先是 n-cover)
    await expect(updateAtlasNode(root, "n-cover", { parent_ref: "n-city" })).rejects.toThrow(/循环/);
    // rank: n-city 提到 cover 之上
    await expect(updateAtlasNode(root, "n-city", { level: "cover" })).rejects.toThrow(/rank|cover/);
    // review 修②: 新父为 pending/悬空 → 拒(adopted 节点不得挂 provisional 父)
    writeAtlasNode(root, node("n-pending", { level: "region" }));
    await expect(updateAtlasNode(root, "n-city", { parent_ref: "n-pending" })).rejects.toThrow(/adopted/);
    await expect(updateAtlasNode(root, "n-city", { parent_ref: "ghost" })).rejects.toThrow(/adopted/);
  });
});

describe("精确 stage: 本次写面相对 POSIX pathspec, 绝不 git add -A(N32 §6; 保留无关用户改动)", () => {
  const lastCommitFiles = (root: string) =>
    execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);

  it("reject/updatePrompt: 无关未跟踪+已跟踪改动不被 sweep, 每个 commit 只含目标页", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    writeAtlasPage(root, page("pg2", { content_hash: "h-pg2" }));
    // 无关用户改动: 未跟踪笔记 + 已跟踪 book.yml 未暂存修改。
    writeFileSync(join(root, "notes.md"), "# 用户笔记\n", "utf8");
    const bookYml = paths(root).bookYml;
    writeFileSync(bookYml, readFileSync(bookYml, "utf8") + "# 用户备注\n", "utf8");

    await rejectAtlasPage(root, "pg1");
    // 本次 commit 只含被驳回页的精确路径(不含 notes.md/book.yml)。
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg1.md"]);
    // 无关改动原样保留在工作区(未跟踪 / 未暂存)。
    let porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(porcelain).toContain("notes.md");
    expect(porcelain).toContain("book.yml");

    await updateAtlasPrompt(root, "pg2", "新 prompt", "h-pg2");
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg2.md"]);
    porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(porcelain).toContain("notes.md");
    expect(porcelain).toContain("book.yml");
  });

  it("adopt 祖先链: 单 commit 含移动目标+删除源(含删除), pending 从 git 消失", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    // 精确含删除(--no-renames: 移动显示为 D 旧路径 + A 新路径, 不折叠成 rename):
    // 3 新路径 + 3 被删 pending 源, 不多不少。
    const status = execFileSync(
      "git", ["show", "--name-status", "--format=", "--no-renames", "HEAD"],
      { cwd: root, encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .sort();
    expect(status).toEqual([
      "A\tworld/atlas/nodes/n-city.md",
      "A\tworld/atlas/nodes/n-cover.md",
      "A\tworld/atlas/pages/pg1.md",
      "D\tworld/atlas/pending/nodes/n-city.md",
      "D\tworld/atlas/pending/nodes/n-cover.md",
      "D\tworld/atlas/pending/pages/pg1.md",
    ]);
    // 删除已落 index: pending 路径不再 tracked; 新路径 tracked。
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked).not.toContain("world/atlas/pending/");
    expect(tracked).toContain("world/atlas/nodes/n-city.md");
    expect(tracked).toContain("world/atlas/pages/pg1.md");
    // 工作区零残留(单 commit 后)。
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("archive 精确 stage: 老页路径唯一入 commit, 无关用户改动保留", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    writeFileSync(join(root, "notes.md"), "# 用户笔记\n", "utf8"); // 无关未跟踪改动
    await archiveAtlasPage(root, "pg1");
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pages/pg1.md"]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toContain("notes.md");
  });
});

describe("approval 后写前重验(审批可能耗时; 拒绝并发修改, R17/CAS)", () => {
  it("adoptAtlasPage: approve 回调内并发修改候选(重算哈希) → CONFLICT 拒绝, 无 adopt commit", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    // 审批期间另一进程改了候选页(改 prompt + 重算 content_hash + 已提交)。
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pendingPageFile("pg1");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const base = { ...(data as unknown as AtlasPage), prompt: "并发修改" };
      const next = { ...base, content_hash: computeAtlasPageContentHash(base) };
      writeFileSync(file, serializeFrontmatter(next as unknown as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent tamper");
      return "allowed-once" as const;
    };
    await expect(
      adoptAtlasPage(root, "pg1", { expectedContentHash: "h-pg1" }, approveTampers),
    ).rejects.toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    // 无 adopt commit(仅并发编辑的 1 个 commit), 无 adopted 页, 候选原文件保留。
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1);
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(false);
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(true);
  });

  it("adoptAtlasPage: approve 回调内改写目标但未提交 → CAS CONFLICT 拒绝, 无 commit", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveDirty = async () => {
      // 并发写入未提交改动(不 git add/commit)。
      writeFileSync(paths(root).world.atlas.pendingPageFile("pg1"), `---\nid: "pg1"\n---\n并发残写\n`, "utf8");
      return "allowed-once" as const;
    };
    await expect(adoptAtlasPage(root, "pg1", {}, approveDirty)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(0); // 零 commit
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(false);
  });

  it("adoptAtlasPlaceholder: approve 回调内提交删除候选节点 → HEAD/CAS CONFLICT 拒绝, 无 commit", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveDeletes = async () => {
      rmSync(paths(root).world.atlas.pendingNodeFile("n-city"));
      gitAdd(root);
      gitCommit(root, "concurrent delete node");
      return "allowed-once" as const;
    };
    await expect(adoptAtlasPlaceholder(root, "n-city", approveDeletes)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1); // 仅并发删除的 commit
    expect(existsSync(paths(root).world.atlas.nodeFile("n-city"))).toBe(false);
    expect(existsSync(paths(root).world.atlas.nodeFile("n-cover"))).toBe(false);
  });

  it("restoreAtlasPage: approve 回调内并发修改归档页 → CONFLICT 拒绝, 无 restore commit", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    await archiveAtlasPage(root, "pg1");
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pageFile("pg1");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const base = { ...(data as unknown as AtlasPage), prompt: "归档后并发修改" };
      const next = { ...base, content_hash: computeAtlasPageContentHash(base) };
      writeFileSync(file, serializeFrontmatter(next as unknown as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent tamper archived");
      return "allowed-once" as const;
    };
    await expect(
      restoreAtlasPage(root, "pg1", approveTampers, { expectedContentHash: "h-pg1" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1); // 仅并发编辑的 commit
    // 依旧 archived(未恢复)。
    const tree = readAtlasTree(root);
    expect(tree.pages.find((p) => p.id === "pg1")?.review_status).toBe("deprecated");
  });

  it("adoptAtlasPage: 未传 expectedContentHash, 回调内改候选并 commit → 审批快照 CAS 仍 CONFLICT", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, withImage(page("pg1"), root, "pg1"));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pendingPageFile("pg1");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const base = { ...(data as unknown as AtlasPage), prompt: "并发修改" };
      const next = { ...base, content_hash: computeAtlasPageContentHash(base) };
      writeFileSync(file, serializeFrontmatter(next as unknown as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent tamper");
      return "allowed-once" as const;
    };
    // 调用者未传 expected: 旧实现 fail-open 会采用「新但未审批」内容; 现在强制
    // 审批前 pre.page.content_hash 为 CAS 基线 → CONFLICT。
    await expect(adoptAtlasPage(root, "pg1", {}, approveTampers)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1); // 仅并发编辑的 commit
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(false);
    expect(existsSync(paths(root).world.atlas.pendingPageFile("pg1"))).toBe(true);
  });

  it("restoreAtlasPage: 未传 expectedContentHash, 回调内改归档页并 commit → 审批快照 CAS 仍 CONFLICT", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    await adoptAtlasPage(root, "pg1", {}, allowAll);
    await archiveAtlasPage(root, "pg1");
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pageFile("pg1");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const base = { ...(data as unknown as AtlasPage), prompt: "归档后并发修改" };
      const next = { ...base, content_hash: computeAtlasPageContentHash(base) };
      writeFileSync(file, serializeFrontmatter(next as unknown as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent tamper archived");
      return "allowed-once" as const;
    };
    await expect(restoreAtlasPage(root, "pg1", approveTampers)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1);
    const tree = readAtlasTree(root);
    expect(tree.pages.find((p) => p.id === "pg1")?.review_status).toBe("deprecated");
  });

  it("adoptAtlasPlaceholder: 回调内改候选节点内容并 commit → 祖先链快照失配 CONFLICT, 不采用", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pendingNodeFile("n-city");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const next = { ...data, title: "并发改题" };
      writeFileSync(file, serializeFrontmatter(next as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent node tamper");
      return "allowed-once" as const;
    };
    // 节点无 page hash: 以审批前整条链原始字节指纹为基线。
    await expect(adoptAtlasPlaceholder(root, "n-city", approveTampers)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1); // 仅并发编辑的 commit
    expect(existsSync(paths(root).world.atlas.nodeFile("n-city"))).toBe(false);
    expect(existsSync(paths(root).world.atlas.nodeFile("n-cover"))).toBe(false);
  });

  it("adoptAtlasPage: 回调内改祖先父引用(接另一真实节点)并 commit → 祖先链快照失配 CONFLICT", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n-cover", { level: "cover" }));
    writeAtlasNode(root, node("n-other", { level: "region", parent_ref: "n-cover" }));
    writeAtlasNode(root, node("n-city", { level: "city", parent_ref: "n-cover" }));
    writeAtlasPage(root, withImage(page("pg1", { node_ref: "n-city" }), root, "pg1"));
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const approveTampers = async () => {
      const file = paths(root).world.atlas.pendingNodeFile("n-city");
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const next = { ...data, parent_ref: "n-other" }; // 链结构改变(仍是合法链)。
      writeFileSync(file, serializeFrontmatter(next as Record<string, unknown>, body), "utf8");
      gitAdd(root);
      gitCommit(root, "concurrent parent swap");
      return "allowed-once" as const;
    };
    await expect(adoptAtlasPage(root, "pg1", {}, approveTampers)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(after - before).toBe(1);
    expect(existsSync(paths(root).world.atlas.pageFile("pg1"))).toBe(false);
    expect(existsSync(paths(root).world.atlas.nodeFile("n-city"))).toBe(false);
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
    const r2 = importAtlasImage(root, src2, { nodeRef: "n1" }, { pageRef: "pg2" });
    expect(r2.page.image?.file).toBe("images/pg2/v1.png"); // 新页自目录, v1 起
    // 同页两次上传: pg2 已 review_ready 不再匹配; 用 pg3 连传两次走 upload run 路径验证目录内 max+1
    writeAtlasPage(root, page("pg3", { node_ref: "n1" }));
    const src3 = writeTmpImage(root, "c.png", pngBytes(64, 64));
    const r3 = importAtlasImage(root, src3, { nodeRef: "n1" }, { pageRef: "pg3" });
    expect(r3.page.image?.file).toBe("images/pg3/v1.png");
    const src4 = writeTmpImage(root, "d.png", pngBytes(64, 64));
    const r4 = importAtlasImage(root, src4, { nodeRef: "n1" }); // pg3 已 review_ready → 新建页目录独立
    expect(r4.page.image?.file).toMatch(/images\/pg-up-[^/]+\/v1\.png/);
  });

  it("JPEG magic 探测", async () => {
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

  it("label 空/坐标越界 拒; rejected 页不可标注", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    expect(() => addAtlasAnnotation(root, "pg1", { label: " ", position_x: 0, position_y: 0 })).toThrow(/label/);
    expect(() => addAtlasAnnotation(root, "pg1", { label: "x", position_x: 1.2, position_y: 0 })).toThrow(/0–1/);
    writeAtlasPage(root, withImage(page("pg2"), root, "pg2"));
    await rejectAtlasPage(root, "pg2");
    expect(() => addAtlasAnnotation(root, "pg2", { label: "x", position_x: 0, position_y: 0 })).toThrow(/只读/);
  });

  it("标注写只 stage 本页文件: 完整精确相对 POSIX pathspec, 不 -A 卷入无关改动(ADR-0021 §6)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    // 无关改动: 未跟踪杂散文件 + 已跟踪节点文件的手改(皆不提交)。
    writeFileSync(join(root, "stray.txt"), "stray\n", "utf8");
    const nodeFile = paths(root).world.atlas.pendingNodeFile("n1");
    writeFileSync(nodeFile, readFileSync(nodeFile, "utf8") + "<!-- 作者手改 -->\n", "utf8");

    // N35 CAS 队列通道保留: 错误基线 → CONFLICT, 零 commit。
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(() =>
      applyAtlasAnnotationOps(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: "wrong",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    const afterCas = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(afterCas - before).toBe(0);

    const lastCommitFiles = (r: string) =>
      execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: r, encoding: "utf8" })
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
    const dirty = () =>
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .sort();

    const id = addAtlasAnnotation(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5 });
    // 最近 commit 只含本页文件(完整精确相对 POSIX 路径, 非目录前缀/非 ./ 开头)。
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg1.md"]);
    expect(dirty()).toEqual([" M world/atlas/pending/nodes/n1.md", "?? stray.txt"]); // 无关改动未被卷入

    // 更新/删除/队列批量同样只 stage 本页文件(全生命周期)。
    updateAtlasAnnotation(root, "pg1", id, { label: "正门" });
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg1.md"]);
    // 批量 ops 必须携带 expectedContentHash CAS(N35): 取当前页 hash 为基线。
    const pgHash = readAtlasTree(root).pendingPages.find((p) => p.id === "pg1")!.content_hash;
    expect(applyAtlasAnnotationOps(root, "pg1", [{ op: "update", id, label: "西门" }], { expectedContentHash: pgHash }).applied).toBe(1);
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg1.md"]);
    deleteAtlasAnnotation(root, "pg1", id);
    expect(lastCommitFiles(root)).toEqual(["world/atlas/pending/pages/pg1.md"]);
    expect(dirty()).toEqual([" M world/atlas/pending/nodes/n1.md", "?? stray.txt"]); // 无关改动始终原样未提交
  });

  it("applyAtlasAnnotationOps 缺 expectedContentHash → VALIDATION_FAILED 零写(N35; queue 载荷同样必填)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const count = () => Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const before = count();
    expect(() =>
      applyAtlasAnnotationOps(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }]),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", message: expect.stringMatching(/CAS/) }));
    expect(count()).toBe(before); // 零 commit
    expect(readAtlasTree(root).pendingPages.find((p) => p.id === "pg1")!.annotations.length).toBe(0); // 零残留
    // queue/nohash 拒绝在 dsh 层(service.applyAtlasAnnotationQueue)覆盖; 此处锁定 world 层
    // CAS 缺失语义: 即使 ops 合法, 缺 hash 也绝不动页面(ADR-0021 expected-state 基线前置)。
  });

  it("严格 discriminated union: 未知 op/未知字段/缺必填字段拒绝(绝不把拼写错误当 delete)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const id = addAtlasAnnotation(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5 });
    const base = readAtlasTree(root).pendingPages.find((p) => p.id === "pg1")!.content_hash;
    const rejectWith = (ops: unknown[]) => {
      expect(() =>
        applyAtlasAnnotationOps(root, "pg1", ops as never, { expectedContentHash: base }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    };
    // 拼写错误 op 值绝不触发 delete: 标注必须仍在(先验后效即证明不是 delete 分支)。
    rejectWith([{ op: "delet", id }]);
    rejectWith([{ op: "delet" }]);
    rejectWith([{ op: "delete" }]);                    // delete 缺 id
    rejectWith([{ op: "delete", id: "" }]);            // delete id 空
    rejectWith([{ op: "add", label: "x" }]);           // add 缺坐标
    rejectWith([{ op: "add", position_x: 0, position_y: 0 }]); // add 缺 label
    rejectWith([{ op: "add", label: "x", position_x: "0.5", position_y: 0 }]); // 坐标类型错
    rejectWith([{ op: "update", id, label: "" }]);     // update label 空
    rejectWith([{ op: "update", label: "y" }]);        // update 缺 id
    rejectWith([{ op: "add", label: "x", position_x: 0, position_y: 0, foo: 1 }]); // 未知字段
    rejectWith([{ op: "delete", id, label: "x" }]);    // delete 只允许 op/id
    // 全部注入失败 → 页面零残留、零变化(标注仍在, hash 不变, 零 commit)。
    const pg = readAtlasTree(root).pendingPages.find((p) => p.id === "pg1")!;
    expect(pg.annotations.map((a) => a.id)).toEqual([id]);
    expect(pg.content_hash).toBe(base);
  });

  it("正文与未知 frontmatter 逐字/语义保留; 只改 annotations + content_hash(N35)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    // 手工改写页面: 追加未知 frontmatter 字段 + 非空正文(逐字保留目标; body 无尾换行)。
    const file = paths(root).world.atlas.pendingPageFile("pg1");
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      serializeFrontmatter(
        { ...data, custom_note: "作者自定义字段", nested: { a: [1, 2], b: "中文" }, tags: ["地图", "城"] },
        "# 临水城\n\n这是正文第一段。\n\n- 列表项\n\n末尾无换行",
      ),
      "utf8",
    );
    const base = readAtlasTree(root).pendingPages.find((p) => p.id === "pg1")!.content_hash;
    const id = addAtlasAnnotation(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5 });
    const after = parseFrontmatter(readFileSync(file, "utf8"));
    // 正文逐字保留(含无尾换行); 未知 frontmatter 语义保留。
    expect(after.body).toBe("# 临水城\n\n这是正文第一段。\n\n- 列表项\n\n末尾无换行");
    expect(after.data.custom_note).toBe("作者自定义字段");
    expect(after.data.nested).toEqual({ a: [1, 2], b: "中文" });
    expect(after.data.tags).toEqual(["地图", "城"]);
    expect((after.data.annotations as unknown[]).map((a) => (a as { label: string }).label)).toEqual(["城门"]);
    expect(String(after.data.content_hash)).not.toBe(base);
    // 更新后再次验证: 未知字段/正文全生命周期保留。
    updateAtlasAnnotation(root, "pg1", id, { label: "正门" });
    const after2 = parseFrontmatter(readFileSync(file, "utf8"));
    expect(after2.body).toBe(after.body);
    expect(after2.data.custom_note).toBe("作者自定义字段");
    expect(after2.data.nested).toEqual({ a: [1, 2], b: "中文" });
    expect((after2.data.annotations as unknown[]).map((a) => (a as { label: string }).label)).toEqual(["正门"]);
  });
});
