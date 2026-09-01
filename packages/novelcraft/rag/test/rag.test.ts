// rag 行为契约(small-modules §3 + D16 + R12)
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { chunkChapterText, readRagIndex, rebuildRagIndex, searchRagIndex, INDEX_VERSION_CN } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncr-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("chunkChapterText(annotation 固定值)", () => {
  it("切块 + index_version=cn-novel-v1 + visibility=author_only + chunk_id 稳定", () => {
    const chunks = chunkChapterText("第一段。\n\n第二段。\n\n第三段。", {
      chapterIndex: 3,
      contentHash: "h",
      targetChars: 6,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.index_version).toBe(INDEX_VERSION_CN);
      expect(c.visibility).toBe("author_only");
      expect(c.embedding_status).toBe("pending");
      expect(c.chunk_id.startsWith("ch3-")).toBe(true);
    }
  });
});

describe("rebuildRagIndex / readRagIndex(R12 可重建)", () => {
  it("落盘 .assistant/rag-index.json 且可读回", () => {
    const root = makeRoot();
    const chunks = chunkChapterText("内容", { chapterIndex: 1, contentHash: "h" });
    rebuildRagIndex(root, chunks);
    const idx = readRagIndex(root)!;
    expect(idx.chunks.length).toBe(chunks.length);
  });
  it("同输入重建幂等(chunk_id 稳定)", () => {
    const root = makeRoot();
    const a = chunkChapterText("A 段。\n\nB 段。", { chapterIndex: 1, contentHash: "h" });
    const b = chunkChapterText("A 段。\n\nB 段。", { chapterIndex: 1, contentHash: "h" });
    expect(a.map((c) => c.chunk_id)).toEqual(b.map((c) => c.chunk_id));
  });
  it("rag-index symlink 读写均 fail-closed，Vault 外文件不变(RV-10)", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "ncr-outside-"));
    dirs.push(outside);
    const sentinel = join(outside, "sentinel.json");
    writeFileSync(sentinel, "OUTSIDE", "utf8");
    symlinkSync(sentinel, join(root, ".assistant", "rag-index.json"));

    expect(() => readRagIndex(root)).toThrow(/symlink/i);
    expect(() => rebuildRagIndex(root, [])).toThrow(/symlink/i);
    expect(readFileSync(sentinel, "utf8")).toBe("OUTSIDE");
  });
});

describe("searchRagIndex(v1 文本检索)", () => {
  it("命中含查询词的片段, 按得分排序", () => {
    const chunks = chunkChapterText("诡秘之主出现。\n\n另一段没有关键词。", { chapterIndex: 1, contentHash: "h", targetChars: 10 });
    const idx = { rebuilt_at: "x", chunks };
    const hits = searchRagIndex(idx, "诡秘", 8);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("诡秘之主");
  });
});
