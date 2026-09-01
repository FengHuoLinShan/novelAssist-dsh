// embedPendingChunks + searchRag L2(M6 Track B)行为契约。
// 风格同 search.test.ts: mkdtemp + initVault + afterEach 清理; 全部经注入的假 backend,
// 零网络(AGENTS.md: vitest 测试零网络)。
// 断言引: D16 嵌入后端可插拔、R5 片段资产、R12 派生索引可重建;
//   ranking 语义见 search.ts 头注释(llm_rerank / vector / bm25; degraded 逗号拼接)。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "@novelcraft/store";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import {
  cosineSimilarity,
  embedPendingChunks,
  readRagIndex,
  rebuildRagIndex,
  searchRag,
  syncRagIndex,
  validateVector,
  type EmbeddingBackend,
  type RagChunk,
} from "../src/index";

const NOW = new Date("2026-01-01T00:00:00.000Z");

/** 假嵌入后端: 返回 [text.length, 1, 0] 定维向量; fail 谓词可让整批抛错。 */
class FakeBackend implements EmbeddingBackend {
  readonly name = "fake-bge";
  calls: string[][] = [];
  constructor(private readonly opts: { fail?: (texts: string[]) => boolean } = {}) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.opts.fail?.(texts)) throw new Error("fake embedding boom");
    return texts.map((t) => [t.length, 1, 0]);
  }
}

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "rag-embed-"));
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

function setVector(root: string, chunkId: string, vector: number[]): void {
  const idx = readRagIndex(root)!;
  const c = idx.chunks.find((x) => x.chunk_id === chunkId)!;
  c.vector = vector;
  c.embedding_status = "succeeded";
  c.embedding_model = "fake-bge";
  rebuildRagIndex(root, idx.chunks);
}

function markStatus(root: string, chunkId: string, status: RagChunk["embedding_status"]): void {
  const idx = readRagIndex(root)!;
  const c = idx.chunks.find((x) => x.chunk_id === chunkId)!;
  c.embedding_status = status;
  rebuildRagIndex(root, idx.chunks);
}

/** 查询嵌入后端: qv 固定 [1,0,0]。 */
const queryBackend: EmbeddingBackend = {
  name: "fake-bge",
  embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
};

describe("embedPendingChunks(L2 批量嵌入)", () => {
  it("无索引 → 全 0 且不调 backend(不建索引)", async () => {
    const root = makeRoot(); // initVault 后尚无 rag-index.json。
    const backend = new FakeBackend();
    expect(await embedPendingChunks(root, backend)).toEqual({ embedded: 0, failed: 0, skipped: 0 });
    expect(backend.calls).toEqual([]);
  });

  it("状态机 pending→succeeded: 向量/模型名/状态落盘, 二次调用幂等", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    writeChapter(root, 2, "第二段正文");
    writeChapter(root, 3, "第三段正文");
    syncRagIndex(root, NOW);
    const backend = new FakeBackend();

    const first = await embedPendingChunks(root, backend);
    expect(first).toEqual({ embedded: 3, failed: 0, skipped: 0 });
    const idx = readRagIndex(root)!;
    expect(idx.chunks.every((c) => c.embedding_status === "succeeded")).toBe(true);
    expect(idx.chunks.every((c) => Array.isArray(c.vector) && c.vector.length === 3)).toBe(true);
    expect(idx.chunks.every((c) => c.embedding_model === "fake-bge")).toBe(true);
    // 有任一 succeeded → 索引文件 embedding_model=backend.name
    const file = JSON.parse(
      readFileSync(join(root, ".assistant", "rag-index.json"), "utf8"),
    ) as { embedding_model?: string; embedding_dimension?: number };
    expect(file.embedding_model).toBe("fake-bge");
    expect(file.embedding_dimension).toBe(3);

    const second = await embedPendingChunks(root, backend);
    expect(second).toEqual({ embedded: 0, failed: 0, skipped: 3 }); // 已嵌入 → 全部 skipped
    expect(backend.calls).toHaveLength(1); // 第二轮不重复调 backend
  });

  it("写入边界拒绝错维/非 finite 向量，坏项不污染同批成功项", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    writeChapter(root, 2, "第二段正文");
    writeChapter(root, 3, "第三段正文");
    syncRagIndex(root, NOW);
    const backend: EmbeddingBackend = {
      name: "mixed-backend",
      embed: async () => [[1, 0], [1, 0, 0], [Number.POSITIVE_INFINITY, 0]],
    };
    const result = await embedPendingChunks(root, backend);
    expect(result).toMatchObject({ embedded: 1, failed: 2, skipped: 0 });
    expect(result.warnings?.map((warning) => warning.code).sort()).toEqual([
      "vector_dimension_mismatch",
      "vector_non_finite",
    ]);
    const index = readRagIndex(root)!;
    expect(index.embedding_model).toBe("mixed-backend");
    expect(index.embedding_dimension).toBe(2);
    expect(index.chunks[0].embedding_status).toBe("succeeded");
    expect(index.chunks.slice(1).every((chunk) => chunk.vector === undefined)).toBe(true);
  });

  it("旧模型向量在写边界失效并按当前 backend 重嵌入", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    syncRagIndex(root, NOW);
    const index = readRagIndex(root)!;
    index.chunks[0].vector = [1, 0, 0];
    index.chunks[0].embedding_status = "succeeded";
    index.chunks[0].embedding_model = "old-model";
    rebuildRagIndex(root, index.chunks, NOW);
    const backend = new FakeBackend();
    const result = await embedPendingChunks(root, backend);
    expect(result).toMatchObject({ embedded: 1, failed: 0, skipped: 0, invalidated: 1 });
    expect(result.warnings?.[0]).toMatchObject({ code: "vector_model_mismatch", chunk_id: "ch1-0" });
    expect(readRagIndex(root)!.chunks[0]).toMatchObject({
      embedding_model: "fake-bge",
      embedding_status: "succeeded",
    });
  });

  it("批级失败继续下批: 首批成功, 失败批标记 failed, 重跑只补失败批", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    writeChapter(root, 2, "第二段正文");
    writeChapter(root, 3, "第三段正文");
    syncRagIndex(root, NOW);
    // batch=2: [ch1,ch2] 成功; [ch3] 含「第三段」→ 整批抛错。
    const flaky = new FakeBackend({ fail: (texts) => texts.some((t) => t.includes("第三段")) });
    const first = await embedPendingChunks(root, flaky, { batch: 2 });
    expect(first).toEqual({ embedded: 2, failed: 1, skipped: 0 });
    const idx = readRagIndex(root)!;
    expect(idx.chunks[0].embedding_status).toBe("succeeded");
    expect(idx.chunks[2].embedding_status).toBe("failed");
    expect(idx.chunks[2].embedding_error).toContain("fake embedding boom");

    // 重跑(好 backend): 只补 failed 的那一个。
    const good = new FakeBackend();
    const second = await embedPendingChunks(root, good, { batch: 2 });
    expect(second).toEqual({ embedded: 1, failed: 0, skipped: 2 });
    expect(readRagIndex(root)!.chunks[2].embedding_status).toBe("succeeded");
    expect(readRagIndex(root)!.chunks[2].embedding_error).toBeUndefined();
  });

  it("中断重入: 首次全批失败 → 全部 failed; 二次全量补齐", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    writeChapter(root, 2, "第二段正文");
    writeChapter(root, 3, "第三段正文");
    syncRagIndex(root, NOW);
    const alwaysFail = new FakeBackend({ fail: () => true });
    const first = await embedPendingChunks(root, alwaysFail);
    expect(first).toEqual({ embedded: 0, failed: 3, skipped: 0 });
    const idx = readRagIndex(root)!;
    expect(idx.chunks.every((c) => c.embedding_status === "failed")).toBe(true);

    const good = new FakeBackend();
    const second = await embedPendingChunks(root, good);
    expect(second).toEqual({ embedded: 3, failed: 0, skipped: 0 });
    expect(readRagIndex(root)!.chunks.every((c) => c.embedding_status === "succeeded")).toBe(true);
  });

  it("skipped 计数口径: 有 vector 或 status='skipped' 的现存 chunk 计入", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "第一段正文");
    writeChapter(root, 2, "第二段正文");
    syncRagIndex(root, NOW);
    markStatus(root, "ch2-0", "skipped"); // 手工标记跳过(无 vector)
    const backend = new FakeBackend();
    const stats = await embedPendingChunks(root, backend);
    expect(stats).toEqual({ embedded: 1, failed: 0, skipped: 1 });
    expect(readRagIndex(root)!.chunks[0].embedding_status).toBe("succeeded");
    expect(readRagIndex(root)!.chunks[1].embedding_status).toBe("skipped");
  });
});

describe("cosineSimilarity(防御)", () => {
  it("长度不等 → 0; 空数组 → 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [])).toBe(0);
  });
  it("同向 → 1, 正交 → 0, 反向 → -1", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
  it("NaN/Infinity 向量拒绝参与 cosine", () => {
    expect(validateVector([Number.NaN, 0])).toEqual({ ok: false, code: "vector_non_finite" });
    expect(validateVector([Number.POSITIVE_INFINITY, 0])).toEqual({ ok: false, code: "vector_non_finite" });
    expect(cosineSimilarity([Number.NaN, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [Number.POSITIVE_INFINITY, 0])).toBe(0);
  });
});

describe("searchRag(L2 向量召回)", () => {
  // 三章「剑」词频递减 → BM25: ch1 > ch2 > ch3;
  // 向量方向远离 qv=[1,0,0] → 余弦: ch3 > ch2 > ch1(两序不同)。
  function setupCosineRoot(): string {
    const root = makeRoot();
    writeChapter(root, 1, "剑剑剑剑剑");
    writeChapter(root, 2, "剑剑剑剑");
    writeChapter(root, 3, "剑剑");
    syncRagIndex(root, NOW);
    setVector(root, "ch1-0", [0, 1, 0]); // cos 0
    setVector(root, "ch2-0", [0.7, 0.7, 0]); // cos ≈ 0.707
    setVector(root, "ch3-0", [1, 0, 0]); // cos 1
    return root;
  }

  it("cosine 序: ranking='vector' 且顺序按余弦(与 BM25 序不同)", async () => {
    const root = setupCosineRoot();
    const res = await searchRag(root, "剑", { embeddingBackend: queryBackend });
    expect(res.ranking).toBe("vector");
    expect(res.degraded).toBeUndefined();
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch3-0", "ch2-0", "ch1-0"]);
    // 对照组: 无 embedding → 纯 BM25 序。
    const plain = await searchRag(root, "剑");
    expect(plain.ranking).toBe("bm25");
    expect(plain.hits.map((c) => c.chunk_id)).toEqual(["ch1-0", "ch2-0", "ch3-0"]);
  });

  it("无 vector chunk 经 BM25 融合仍可命中(两组归一化融合)", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "青锋剑出鞘, 剑光如雪");
    writeChapter(root, 2, "苏婉握着青锋剑, 站在桥上"); // 无 vector → 走 BM25 组
    syncRagIndex(root, NOW);
    setVector(root, "ch1-0", [1, 0, 0]); // 余弦 1.0
    // ch2-0 保持 pending 无 vector。
    const res = await searchRag(root, "青锋剑", { embeddingBackend: queryBackend });
    expect(res.ranking).toBe("vector");
    const ids = res.hits.map((c) => c.chunk_id);
    expect(ids).toContain("ch2-0"); // 无 vector chunk 经 BM25 融合仍进入召回
    expect(res.hits[0].chunk_id).toBe("ch1-0"); // 向量组余弦满分的排最前
  });

  it("query embed 抛错 → degraded 含 embedding_failed 且 hits 仍 BM25(N21/N22/N36)", async () => {
    const root = setupCosineRoot();
    const broken: EmbeddingBackend = {
      name: "fake-bge",
      embed: async () => {
        throw new Error("embed network down");
      },
    };
    const res = await searchRag(root, "剑", { embeddingBackend: broken });
    expect(res.ranking).toBe("bm25"); // 退化到纯 L0/L1
    expect(res.degraded).toContain("embedding_failed");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch1-0", "ch2-0", "ch3-0"]); // BM25 序
  });

  it("NaN/错维/混模型全部失效时稳定退回 BM25 并返回 typed warnings", async () => {
    const root = setupCosineRoot();
    const index = readRagIndex(root)!;
    index.chunks[0].vector = [Number.NaN, 0, 0];
    index.chunks[1].vector = [1, 0];
    index.chunks[2].embedding_model = "old-model";
    rebuildRagIndex(root, index.chunks, NOW);
    const result = await searchRag(root, "剑", { embeddingBackend: queryBackend });
    expect(result.ranking).toBe("bm25");
    expect(result.degraded).toBe("vector_invalid");
    expect(result.hits.map((chunk) => chunk.chunk_id)).toEqual(["ch1-0", "ch2-0", "ch3-0"]);
    expect(new Set(result.warnings?.map((warning) => warning.code))).toEqual(new Set([
      "vector_non_finite",
      "vector_dimension_mismatch",
      "vector_model_mismatch",
    ]));
  });

  it("向量召回 + provider 精排叠加: 精排生效 → ranking='llm_rerank'", async () => {
    const root = setupCosineRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ ranked_ids: ["ch1-0", "ch2-0", "ch3-0"] }) }],
    });
    const res = await searchRag(root, "剑", { embeddingBackend: queryBackend, provider });
    expect(res.ranking).toBe("llm_rerank");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch1-0", "ch2-0", "ch3-0"]);
  });

  it("向量召回 + 精排失败 → ranking='vector', degraded 逗号拼接 rerank_failed", async () => {
    const root = setupCosineRoot();
    const provider = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const res = await searchRag(root, "剑", { embeddingBackend: queryBackend, provider });
    expect(res.ranking).toBe("vector"); // 向量召回序未被精排破坏
    expect(res.degraded).toBe("rerank_failed");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch3-0", "ch2-0", "ch1-0"]);
  });
});
