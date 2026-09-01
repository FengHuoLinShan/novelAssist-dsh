// syncRagIndex 行为契约(M6 Track A1, L0 增量索引同步)。
// 风格同 rag.test.ts: mkdtemp + initVault + afterEach 清理。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "@novelcraft/store";
import { initVault } from "@novelcraft/vault";
import {
  INDEX_VERSION_CN,
  readRagIndex,
  rebuildRagIndex,
  syncRagIndex,
  type RagChunk,
} from "../src/index";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "rag-sync-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeChapter(root: string, n: number, body: string) {
  writeFileSync(
    join(root, "chapters", `${String(n).padStart(3, "0")}.md`),
    serializeFrontmatter({ chapter_index: n, status: "draft", content_hash: "x" }, body),
    "utf8",
  );
}
function writeWorld(root: string, basename: string, body: string) {
  writeFileSync(
    join(root, "world", `${basename}.md`),
    serializeFrontmatter({ id: basename, name: basename, status: "canonical" }, body),
    "utf8",
  );
}
function writeObject(root: string, basename: string, body: string) {
  writeFileSync(
    join(root, "world", "objects", `${basename}.md`),
    serializeFrontmatter({ id: basename, status: "canonical" }, body),
    "utf8",
  );
}

describe("syncRagIndex(首次全量)", () => {
  it("章节 + world 角色 + world 对象三类源都进索引, 字段正确; chapters/pending 不进", () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一章正文。\n\n第二段。");
    writeFileSync(join(root, "chapters", "pending", "002.md"), "候选正文不应进索引。", "utf8");
    writeWorld(root, "klein", "克莱恩·莫雷蒂, 值夜者。");
    writeObject(root, "sealed-artifact", "封印物 0-02, 命运之蛇。");

    const stats = syncRagIndex(root, NOW);
    expect(stats).toEqual({ added: 3, updated: 0, removed: 0, total: 3 });

    const idx = readRagIndex(root)!;
    expect(idx.chunks).toHaveLength(3);

    const ch = idx.chunks.find((c) => c.source_type === "chapter_text")!;
    expect(ch.chunk_id).toBe("ch1-0");
    expect(ch.chapter_index).toBe(1);
    expect(ch.visibility).toBe("author_only");
    expect(ch.importance).toBe(0.5);
    expect(ch.index_version).toBe(INDEX_VERSION_CN);
    expect(ch.embedding_status).toBe("pending");

    const char = idx.chunks.find((c) => c.chunk_id === "char-klein")!;
    expect(char.source_type).toBe("character");
    expect(char.chunk_index).toBe(0);
    expect(char.visibility).toBe("author_only");
    expect(char.importance).toBe(0.5);
    expect(char.index_version).toBe(INDEX_VERSION_CN);

    const obj = idx.chunks.find((c) => c.chunk_id === "obj-sealed-artifact")!;
    expect(obj.source_type).toBe("world_entity");
    expect(obj.chunk_index).toBe(0);
    expect(obj.text).toContain("封印物");

    // chapters/pending 里的文件不产生任何 chunk。
    expect(idx.chunks.some((c) => c.text.includes("候选正文"))).toBe(false);
  });
});

describe("syncRagIndex(增量)", () => {
  it("改一章 → 只该章 chunk 更新; 其他源 chunk 字段(含手工塞入的 vector/embedding)原样保留", () => {
    const root = makeRoot();
    writeChapter(root, 1, "旧正文甲。");
    writeWorld(root, "klein", "克莱恩正文。");
    writeObject(root, "o1", "对象正文。");

    const first = syncRagIndex(root, NOW);
    expect(first).toEqual({ added: 3, updated: 0, removed: 0, total: 3 });

    // 手工注入 vector/embedding 状态(模拟 L1 嵌入后端填充)。
    const idx = readRagIndex(root)!;
    const charChunk = idx.chunks.find((c) => c.chunk_id === "char-klein")!;
    charChunk.vector = [0.1, 0.2, 0.3];
    charChunk.embedding_status = "succeeded";
    charChunk.embedding_model = "test-embed";
    rebuildRagIndex(root, idx.chunks, NOW);

    // 只改第一章内容。
    writeChapter(root, 1, "新正文乙。");

    const second = syncRagIndex(root, NOW);
    expect(second).toEqual({ added: 0, updated: 1, removed: 0, total: 3 });

    const after = readRagIndex(root)!;
    const chAfter = after.chunks.find((c) => c.chunk_id === "ch1-0")!;
    expect(chAfter.text).toBe("新正文乙。");
    expect(chAfter.embedding_status).toBe("pending"); // 重新切块 → 待嵌入。

    // 来源未变的 world chunk: vector/embedding 字段原样保留(未被重建)。
    const charAfter = after.chunks.find((c) => c.chunk_id === "char-klein")!;
    expect(charAfter.vector).toEqual([0.1, 0.2, 0.3]);
    expect(charAfter.embedding_status).toBe("succeeded");
    expect(charAfter.embedding_model).toBe("test-embed");

    // 未变化的 object chunk 同样保留字段。
    const objAfter = after.chunks.find((c) => c.chunk_id === "obj-o1")!;
    expect(objAfter.text).toBe("对象正文。");
  });

  it("事件同步保留索引级 embedding 身份元数据(RV-15)", () => {
    const root = makeRoot();
    writeChapter(root, 1, "正文。");
    syncRagIndex(root, NOW);
    const file = join(root, ".assistant", "rag-index.json");
    const seeded = JSON.parse(readFileSync(file, "utf8"));
    seeded.embedding_model = "test-embed";
    seeded.embedding_dimension = 3;
    writeFileSync(file, JSON.stringify(seeded, null, 2) + "\n", "utf8");

    syncRagIndex(root, NOW);
    expect(readRagIndex(root)).toMatchObject({ embedding_model: "test-embed", embedding_dimension: 3 });
  });

  it("删章 → 其 chunk 移除(removed)", () => {
    const root = makeRoot();
    writeChapter(root, 1, "甲。");
    writeChapter(root, 2, "乙。");
    writeWorld(root, "klein", "克莱恩正文。");

    expect(syncRagIndex(root, NOW).added).toBe(3);
    rmSync(join(root, "chapters", "002.md"));

    const second = syncRagIndex(root, NOW);
    expect(second).toEqual({ added: 0, updated: 0, removed: 1, total: 2 });
    const idx = readRagIndex(root)!;
    expect(idx.chunks.some((c) => c.chapter_index === 2)).toBe(false);
    expect(idx.chunks.some((c) => c.chapter_index === 1)).toBe(true);
  });

  it("新增 world 文件 → added", () => {
    const root = makeRoot();
    writeChapter(root, 1, "甲。");
    expect(syncRagIndex(root, NOW).added).toBe(1);

    writeWorld(root, "new-char", "新角色正文。");
    const second = syncRagIndex(root, NOW);
    expect(second).toEqual({ added: 1, updated: 0, removed: 0, total: 2 });
    const idx = readRagIndex(root)!;
    expect(idx.chunks.some((c) => c.chunk_id === "char-new-char")).toBe(true);
  });

  it("幂等: 连跑两次, 第二次 added/updated/removed 全 0, 索引文件字节一致", () => {
    const root = makeRoot();
    writeChapter(root, 1, "甲。\n\n乙。");
    writeWorld(root, "klein", "克莱恩正文。");
    writeObject(root, "o1", "对象正文。");

    const first = syncRagIndex(root, NOW);
    expect(first.added).toBe(3);
    const afterFirst = JSON.stringify(readRagIndex(root));

    const second = syncRagIndex(root, NOW);
    expect(second).toEqual({ added: 0, updated: 0, removed: 0, total: 3 });
    expect(JSON.stringify(readRagIndex(root))).toBe(afterFirst);
  });

  it("保留非三类源 chunk(不管理, 不计数 removed)", () => {
    const root = makeRoot();
    writeChapter(root, 1, "甲。");
    expect(syncRagIndex(root, NOW).added).toBe(1);

    const memoryChunk: RagChunk = {
      chunk_id: "mem-e1-0",
      source_type: "memory",
      chunk_index: 0,
      char_count: 4,
      text: "记忆片段",
      visibility: "author_only",
      importance: 0.5,
      index_version: INDEX_VERSION_CN,
      embedding_status: "pending",
    };
    const idx = readRagIndex(root)!;
    rebuildRagIndex(root, [...idx.chunks, memoryChunk], NOW);

    const second = syncRagIndex(root, NOW);
    expect(second).toEqual({ added: 0, updated: 0, removed: 0, total: 2 });
    expect(readRagIndex(root)!.chunks.some((c) => c.chunk_id === "mem-e1-0")).toBe(true);
  });
});
