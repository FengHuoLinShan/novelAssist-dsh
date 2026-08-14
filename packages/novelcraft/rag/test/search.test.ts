// searchRag 行为契约(M6 Track A1, L0 BM25 检索)。
// 风格同 rag.test.ts: mkdtemp + initVault + afterEach 清理。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "@novelcraft/store";
import { initVault } from "@novelcraft/vault";
import { searchRag, syncRagIndex } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "rag-search-"));
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

describe("searchRag(L0 BM25)", () => {
  it("索引不存在 → 空 hits, ranking=bm25", () => {
    const root = makeRoot(); // initVault 后尚无 rag-index.json。
    expect(searchRag(root, "诡秘")).toEqual({ hits: [], ranking: "bm25" });
  });

  it("有索引: 中文查询命中正确章节 chunk(BM25 排序)", () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘之主降临贝克兰德。");
    writeChapter(root, 2, "主角在码头搬运货物。");
    syncRagIndex(root, NOW);

    const res = searchRag(root, "诡秘");
    expect(res.ranking).toBe("bm25");
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].source_type).toBe("chapter_text");
    expect(res.hits[0].chapter_index).toBe(1);
    expect(res.hits[0].text).toContain("诡秘之主");
  });

  it("topK 生效且无命中返回空 hits", () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘教会。");
    syncRagIndex(root, NOW);

    const res = searchRag(root, "诡秘", { topK: 0 });
    expect(res.hits).toEqual([]);
    expect(res.ranking).toBe("bm25");

    expect(searchRag(root, "不存在的词xyz").hits).toEqual([]);
  });
});
