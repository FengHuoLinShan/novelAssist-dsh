// rerankWithProvider + searchRag(L1 内容手精排)行为契约(M6 Track A1 收尾, N21 rag_rerank;
// M7 N24: rag_rerank 预算 2048→4096 回归——默认召回集不再 budget_exceeded)。
// 风格同 search.test.ts: mkdtemp + initVault + afterEach 清理。
// MockProvider 复用 @novelcraft/llm-step 内置(经 dist 解析 workspace 依赖)。
// runStep 默认 fixAttempts=1(共 2 次尝试): 非法输出用例需配 2 条响应, 否则队列耗尽走 provider_fatal。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "@novelcraft/store";
import { initVault } from "@novelcraft/vault";
import { MockProvider, checkBudget, estimateTokens } from "@novelcraft/llm-step";
import { INDEX_VERSION_CN, rerankWithProvider, searchRag, syncRagIndex, type RagChunk } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function mkChunk(chunk_id: string, text: string): RagChunk {
  return {
    chunk_id,
    source_type: "chapter_text",
    chunk_index: 0,
    char_count: text.length,
    text,
    visibility: "author_only",
    importance: 0.5,
    index_version: INDEX_VERSION_CN,
    embedding_status: "pending",
  };
}

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "rag-rerank-"));
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

describe("rerankWithProvider(rag_rerank, N21)", () => {
  it("正常重排: 输出按 ranked_ids 顺序", async () => {
    const chunks = [mkChunk("c1", "第一段正文"), mkChunk("c2", "第二段正文"), mkChunk("c3", "第三段正文")];
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ ranked_ids: ["c3", "c1", "c2"] }) }] });
    const out = await rerankWithProvider(provider, "查询", chunks);
    expect(out.map((c) => c.chunk_id)).toEqual(["c3", "c1", "c2"]);
  });

  it("部分 id + 未知 id: 未提及殿后(原相对序), 未知 id 忽略", async () => {
    const chunks = [mkChunk("c1", "一"), mkChunk("c2", "二"), mkChunk("c3", "三")];
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ ranked_ids: ["c2", "ghost", "c1"] }) }] });
    const out = await rerankWithProvider(provider, "q", chunks);
    expect(out.map((c) => c.chunk_id)).toEqual(["c2", "c1", "c3"]);
  });

  it("ranked_ids 缺失 → throw(schema_violation)", async () => {
    const chunks = [mkChunk("c1", "一")];
    // schema required 校验: 两次尝试都缺 ranked_ids → runStep ok=false → throw。
    const provider = new MockProvider({ responses: [{ text: "{}" }, { text: "{}" }] });
    await expect(rerankWithProvider(provider, "q", chunks)).rejects.toThrow("schema_violation");
  });

  it("ranked_ids 非数组 → throw(schema_violation)", async () => {
    const chunks = [mkChunk("c1", "一")];
    const bad = JSON.stringify({ ranked_ids: "not-an-array" });
    const provider = new MockProvider({ responses: [{ text: bad }, { text: bad }] });
    await expect(rerankWithProvider(provider, "q", chunks)).rejects.toThrow("schema_violation");
  });

  it("runStep 不 ok(非 JSON → schema_violation)→ throw", async () => {
    const chunks = [mkChunk("c1", "一")];
    const provider = new MockProvider({ responses: [{ text: "不是 JSON" }, { text: "也不是 JSON" }] });
    await expect(rerankWithProvider(provider, "q", chunks)).rejects.toThrow("schema_violation");
  });
});

describe("rag_rerank 预算回归(M7 N24)", () => {
  it("默认召回集(recall=20 × 200 字)在新预算 4096 内, 旧预算 2048 拒绝(N24)", () => {
    // 与 rerank.ts buildRerankInput 相同格式组装: "查询: <query>" + 每候选一行 "[序号] [chunk_id] text前200字"。
    const query = "诡秘之主在贝克兰德的真实身份";
    const chunks = Array.from({ length: 20 }, (_, i) =>
      mkChunk("ch" + (i + 1) + "-0", "诡秘之主在贝克兰德暗中行动筹备线索。".repeat(200).slice(0, 200)),
    );
    const lines = chunks.map((c, i) => i + 1 + ". [" + c.chunk_id + "] " + c.text.slice(0, 200));
    const input = ["查询: " + query, "", "候选片段(各截断约 200 字, 按 chunk_id 引用):", ...lines].join("\n");

    // 输入估算 ≈ 20×200 CJK /1.6 + 前缀拉丁 /4 ≈ 2600 token(N24 依据)。
    expect(estimateTokens(input)).toBeLessThanOrEqual(4096);
    expect(checkBudget(input, 4096).allowed).toBe(true); // N24: 新预算放行默认召回集。
    expect(checkBudget(input, 2048).allowed).toBe(false); // N24 缺陷: 旧预算恒拒绝 → L1 恒降级回退 BM25。
  });
});

describe("searchRag(L1 内容手精排)", () => {
  it("无 provider → ranking bm25, BM25 序", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘之主降临贝克兰德。诡秘教会暗中活动。");
    writeChapter(root, 2, "贝克兰德的码头有诡秘的气息。");
    syncRagIndex(root, NOW);

    const res = await searchRag(root, "诡秘");
    expect(res.ranking).toBe("bm25");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch1-0", "ch2-0"]); // ch1 词频更高。
  });

  it("有 provider 正常 → ranking llm_rerank 且顺序被覆盖", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘之主降临贝克兰德。诡秘教会暗中活动。");
    writeChapter(root, 2, "贝克兰德的码头有诡秘的气息。");
    syncRagIndex(root, NOW);

    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ ranked_ids: ["ch2-0", "ch1-0"] }) }] });
    const res = await searchRag(root, "诡秘", { provider });
    expect(res.ranking).toBe("llm_rerank");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch2-0", "ch1-0"]); // 精排覆盖 BM25 序。
  });

  it("provider 抛错 → ranking bm25 + degraded=rerank_failed, hits 仍 BM25 序", async () => {
    const root = makeRoot();
    writeChapter(root, 1, "诡秘之主降临贝克兰德。诡秘教会暗中活动。");
    writeChapter(root, 2, "贝克兰德的码头有诡秘的气息。");
    syncRagIndex(root, NOW);

    const provider = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const res = await searchRag(root, "诡秘", { provider });
    expect(res.ranking).toBe("bm25");
    expect(res.degraded).toBe("rerank_failed");
    expect(res.hits.map((c) => c.chunk_id)).toEqual(["ch1-0", "ch2-0"]);
  });

  it("默认参数全召回集走通: recall=20 × 200 字, 不因预算降级, ranking=llm_rerank(N24)", async () => {
    // N24 回归: 20 章 × 200 字正文 → 精排输入估算 ≈2600 token, 旧预算 2048 恒 budget_exceeded
    // → 降级 rerank_failed; 新预算 4096 放行, L1 默认开(N21)。
    const root = makeRoot();
    const body200 = "诡秘之主在贝克兰德暗中行动筹备线索。".repeat(200).slice(0, 200);
    for (let n = 1; n <= 20; n++) writeChapter(root, n, body200);
    syncRagIndex(root, NOW);

    const ids = Array.from({ length: 20 }, (_, i) => "ch" + (20 - i) + "-0"); // 逆序 ranked_ids(全部合法)。
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ ranked_ids: ids }) }] });
    const res = await searchRag(root, "诡秘", { provider }); // 默认 recall=20、topK=8(不传缩减)。
    expect(res.ranking).toBe("llm_rerank");
    expect(res.degraded).toBeUndefined();
    expect(res.hits.length).toBe(8); // 默认 topK。
    expect(res.hits[0].chunk_id).toBe("ch20-0"); // 精排逆序生效, 未回退 BM25 原序。
  });
});
