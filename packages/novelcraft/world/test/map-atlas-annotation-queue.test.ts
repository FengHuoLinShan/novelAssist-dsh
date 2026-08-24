// annotation-queue 契约(N35 唯一受控结构化入口下沉到 world 层):
//   ① 成功路径: 合法载荷 → applyAtlasAnnotationOpsTx 应用 → 队列文件删除;
//   ② 封闭 schema: 未知顶层字段/缺 base_content_hash/缺 ops → 拒绝零写, 文件保留;
//   ③ CAS 失配(stale base)→ CONFLICT 零写, 文件保留待修;
//   ④ R9: symlink 的 .json 不被应用不被删除;
//   ⑤ 单文件失败不阻塞其余(failed 计数 + errors 汇总);
//   ⑥ atlasAnnotationQueueStatus 只读计数(文件/ops/去重页)。
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { readAtlasTree, writeAtlasNode, writeAtlasPage, type AtlasNode, type AtlasPage } from "../src/index.js";
import { atlasAnnotationQueueStatus, consumeAtlasAnnotationQueue } from "../src/index.js";

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ncma-queue-"));
  dirs.push(root);
  initVault(root, { title: "队列测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedPage(root: string): string {
  const n: AtlasNode = {
    id: "n1", parent_ref: null, location_ref: null, semantic_key: "entity:n1",
    level: "world", title: "n1", status: "provisional", sort_order: 0,
  };
  writeAtlasNode(root, n);
  const p: AtlasPage = {
    id: "pg1", run_ref: "run-t", node_ref: "n1", generation_status: "prompt_only",
    review_status: "candidate", title: "pg1", visual_brief: "v", prompt: "p",
    evidence: { supported: [], visual_fill: [], conflicts: [] }, source_manifest: [],
    annotations: [], review_note: null, adopted_at: null, rejected_at: null,
    deprecated_at: null, content_hash: "h-pg1",
  };
  writeAtlasPage(root, p);
  return readAtlasTree(root).pendingPages[0]!.content_hash;
}

function queueDirOf(root: string): string {
  return paths(root).assistant.atlas.annotationQueue;
}
function writeQueue(root: string, name: string, payload: unknown): string {
  const dir = queueDirOf(root);
  const abs = join(dir, name);
  writeFileSync(abs, JSON.stringify(payload), "utf8");
  return abs;
}

describe("consumeAtlasAnnotationQueue(N35 队列消费唯一实现)", () => {
  it("合法载荷 → 事务应用 + 清队列; 队列为空/目录缺失 → no_change", async () => {
    const root = makeRoot();
    const base = seedPage(root);
    expect(await consumeAtlasAnnotationQueue(root)).toEqual({ files: 0, applied: 0, failed: 0, errors: [] });
    const abs = writeQueue(root, "01.json", {
      page_ref: "pg1",
      base_content_hash: base,
      ops: [{ op: "add", label: "城门", position_x: 0.5, position_y: 0.5 }],
    });
    const r = await consumeAtlasAnnotationQueue(root);
    expect(r.files).toBe(1);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
    expect(existsSync(abs)).toBe(false);
    expect(readAtlasTree(root).pendingPages[0]!.annotations.length).toBe(1);
  });

  it("封闭 schema: 未知字段/缺 base_content_hash/缺 ops → 拒绝零写且文件保留", async () => {
    const root = makeRoot();
    seedPage(root);
    const f1 = writeQueue(root, "01.json", { page_ref: "pg1", base_content_hash: "h", ops: [], extra: 1 });
    const f2 = writeQueue(root, "02.json", { page_ref: "pg1", ops: [] });
    const f3 = writeQueue(root, "03.json", { page_ref: "pg1", base_content_hash: "h" });
    const r = await consumeAtlasAnnotationQueue(root);
    expect(r).toMatchObject({ files: 3, applied: 0, failed: 3 });
    expect(r.errors.length).toBe(3);
    expect(existsSync(f1)).toBe(true);
    expect(existsSync(f2)).toBe(true);
    expect(existsSync(f3)).toBe(true);
    expect(readAtlasTree(root).pendingPages[0]!.annotations.length).toBe(0);
  });

  it("CAS 失配(stale base)→ CONFLICT 零写, 文件保留待修", async () => {
    const root = makeRoot();
    seedPage(root);
    const abs = writeQueue(root, "01.json", {
      page_ref: "pg1",
      base_content_hash: "stale-not-the-hash",
      ops: [{ op: "add", label: "x", position_x: 0.1, position_y: 0.1 }],
    });
    const r = await consumeAtlasAnnotationQueue(root);
    expect(r.failed).toBe(1);
    expect(existsSync(abs)).toBe(true);
    expect(readAtlasTree(root).pendingPages[0]!.annotations.length).toBe(0);
  });

  it("R9: symlink 的 .json 不被应用不被删除; 坏文件失败不阻塞其余", async () => {
    const root = makeRoot();
    const base = seedPage(root);
    const outside = join(root, "..", `outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify({
      page_ref: "pg1", base_content_hash: base,
      ops: [{ op: "add", label: "外", position_x: 0.9, position_y: 0.9 }],
    }), "utf8");
    try {
      symlinkSync(outside, join(queueDirOf(root), "00-symlink.json"));
      writeQueue(root, "01-broken.json", "{not json");
      writeQueue(root, "02-good.json", {
        page_ref: "pg1", base_content_hash: base,
        ops: [{ op: "add", label: "好", position_x: 0.5, position_y: 0.5 }],
      });
      const r = await consumeAtlasAnnotationQueue(root);
      // symlink 不计入 files(不是普通文件), 坏 JSON 失败, 好文件照常应用。
      expect(r.files).toBe(2);
      expect(r.failed).toBe(1);
      expect(r.applied).toBe(1);
      expect(existsSync(outside)).toBe(true);
      expect(readAtlasTree(root).pendingPages[0]!.annotations.length).toBe(1);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("atlasAnnotationQueueStatus(只读计数)", () => {
  it("文件/ops/去重页计数; 目录缺失 → 全零", () => {
    const root = makeRoot();
    expect(atlasAnnotationQueueStatus(root)).toEqual({ files: 0, ops: 0, pages: [] });
    writeQueue(root, "01.json", { page_ref: "pg1", base_content_hash: "h", ops: [{ op: "add" }, { op: "add" }] });
    writeQueue(root, "02.json", { page_ref: "pg1", base_content_hash: "h", ops: [{ op: "add" }] });
    const s = atlasAnnotationQueueStatus(root);
    expect(s).toEqual({ files: 2, ops: 3, pages: ["pg1"] });
  });
});
