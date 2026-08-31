// searchRag 行为契约(M6 Track A1, L0 BM25 检索; L1 精排见 rerank.test.ts)。
// 风格同 rag.test.ts: mkdtemp + initVault + afterEach 清理。
// M6 收尾: searchRag 改为 async(全仓零消费方, review 已确认), 用例 await。
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

// M12-c/N47: current-source typed result(total/truncated/open_target)。
describe('searchRag typed result(N47)', () => {
  it('total/truncated 反映召回截断; 章正文 hit 带 open_target 路径与偏移', async () => {
    const root = makeRoot();
    writeChapter(root, 1, '克莱恩推开公寓的门, 走进雾气弥漫的街道。'.repeat(10));
    writeChapter(root, 2, '第二章: 他在灰雾中看见熟悉的身影。'.repeat(10));
    syncRagIndex(root);
    const full = await searchRag(root, '克莱恩 街道', { topK: 10 });
    expect(full.total).toBeGreaterThanOrEqual(1);
    expect(full.truncated).toBe(false);
    const cut = await searchRag(root, '克莱恩 街道', { topK: 1 });
    if ((cut.total ?? 0) > 1) {
      expect(cut.truncated).toBe(true);
      expect(cut.hits).toHaveLength(1);
    }
    const ch1 = full.hits.find((h) => h.chapter_index === 1);
    expect(ch1?.open_target).toMatchObject({ path: 'chapters/001.md' });
  });
});

describe("searchRag(L0 BM25)", () => {
  it("索引不存在 → 空 hits, ranking=bm25", async () => {
    const root = makeRoot(); // initVault 后尚无 rag-index.json。
    await expect(searchRag(root, "诡秘")).resolves.toEqual({ hits: [], ranking: "bm25" });
  });

  it("有索引: 中文查询命中正确章节 chunk(BM25 排序)", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘之主降临贝克兰德。");
    writeChapter(root, 2, "主角在码头搬运货物。");
    syncRagIndex(root, NOW);

    const res = await searchRag(root, "诡秘");
    expect(res.ranking).toBe("bm25");
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].source_type).toBe("chapter_text");
    expect(res.hits[0].chapter_index).toBe(1);
    expect(res.hits[0].text).toContain("诡秘之主");
  });

  it("topK 生效且无命中返回空 hits", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘教会。");
    syncRagIndex(root, NOW);

    const res = await searchRag(root, "诡秘", { topK: 0 });
    expect(res.hits).toEqual([]);
    expect(res.ranking).toBe("bm25");

    expect((await searchRag(root, "不存在的词xyz")).hits).toEqual([]);
  });
});
