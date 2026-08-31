// searchRag — L0 确定性检索(BM25 粗排) + L1 内容手精排 + L2 向量召回(M6 Track B)。
// 流程: 无索引 → 空 hits; 命中走 rankChunksBm25 召回(recall 默认 20);
// embeddingBackend 存在时先走 L2 向量融合召回:
//   - 有 vector 的 chunk 按查询向量余弦相似度取前 recall;
//   - 无 vector 的 chunk 走 BM25;
//   - 两组各自 min-max 归一化到 [0,1] 后按 max 分融合取 recall(两组不相交, 融合=并集按归一化分排序);
//   - 查询嵌入抛错 → 整条 L2 路径降级, 退化到纯 L0/L1(degraded 追加 embedding_failed)。
// provider 存在且召回 >1 条 → rag_rerank 重排召回集后取 topK(ranking=llm_rerank);
// 精排失败/超时 → 回退召回原序取 topK(ranking=vector 或 bm25, degraded 追加 rerank_failed)。
// ranking 语义(文件头注释, M6 Track B):
//   llm_rerank = 精排生效(召回面可以是向量融合或纯 BM25, 精排结果优先);
//   vector     = 向量召回生效且未精排(含精排失败降级后的向量召回序);
//   bm25       = 纯 BM25(未配置嵌入后端, 或嵌入失败退化)。
// degraded 多重时逗号拼接(如 'embedding_failed,rerank_failed')。
import { rankChunksBm25, scoreChunksBm25 } from "./bm25.js";
import { cosineSimilarity } from "./embed.js";
import { readRagIndex, type EmbeddingBackend, type RagChunk } from "./rag.js";
import { rerankWithProvider } from "./rerank.js";
import type { Provider } from "@novelcraft/llm-step";

export interface RagSearchResult {
  hits: RagChunk[];
  /** topK 截断前的召回集大小(受 recall 上限约束; N47 review 措辞收紧)。 */
  total?: number;
  /** topK 截断标记(total > hits.length 时 true)。 */
  truncated?: boolean;
  /** 召集触顶 recall 上限(全书匹配数 ≥ recall, total 是下界非全量; N47 review)。 */
  recall_capped?: boolean;
  ranking: "bm25" | "llm_rerank" | "vector";
  degraded?: string;
}

interface ScoredChunk {
  c: RagChunk;
  score: number;
}

/** min-max 归一化到 [0,1]; 全等分值(span=0)统一为 1(不可比组视为满相似)。 */
function minMaxNormalize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span === 0) return values.map(() => 1);
  return values.map((v) => (v - min) / span);
}

/** 两组(向量余弦组 / BM25 组)各自归一化后按 max 分融合取 limit。 */
function fuseGroups(vecGroup: ScoredChunk[], bmGroup: ScoredChunk[], limit: number): RagChunk[] {
  const normVec = minMaxNormalize(vecGroup.map((x) => x.score));
  const normBm = minMaxNormalize(bmGroup.map((x) => x.score));
  const fused: ScoredChunk[] = [];
  vecGroup.forEach((x, i) => fused.push({ c: x.c, score: normVec[i] }));
  bmGroup.forEach((x, i) => fused.push({ c: x.c, score: normBm[i] }));
  fused.sort((a, b) => b.score - a.score); // 稳定排序: 同分保持原顺序。
  return fused.slice(0, limit).map((x) => x.c);
}

/** L2 向量融合召回; 查询嵌入抛错 → 抛给调用方降级。 */
async function recallWithEmbedding(
  backend: EmbeddingBackend,
  chunks: readonly RagChunk[],
  query: string,
  recall: number,
): Promise<RagChunk[]> {
  const [qv] = await backend.embed([query]);
  const withVec = chunks.filter((c) => Array.isArray(c.vector) && c.vector.length > 0);
  const withoutVec = chunks.filter((c) => !(Array.isArray(c.vector) && c.vector.length > 0));
  const vecScored = withVec
    .map((c) => ({ c, score: cosineSimilarity(qv, c.vector!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, recall);
  // BM25 组: 真实分值(scoreChunksBm25), 过滤零分 → 降序 → 截 recall, 供归一化融合。
  const bmScored = scoreChunksBm25(withoutVec, query)
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, recall);
  return fuseGroups(vecScored, bmScored, recall);
}

export async function searchRag(
  root: string,
  query: string,
  opts?: {
    topK?: number;
    recall?: number;
    provider?: Provider;
    embeddingBackend?: EmbeddingBackend;
  },
): Promise<RagSearchResult> {
  const index = readRagIndex(root);
  if (!index) {
    return { hits: [], ranking: "bm25" };
  }
  const topK = opts?.topK ?? 8;
  const recall = opts?.recall ?? 20;
  const degradedParts: string[] = [];

  // L2 向量召回(可选): 失败 → 退化到纯 L0/L1, degraded 追加 embedding_failed。
  let vectorHits: RagChunk[] | undefined;
  if (opts?.embeddingBackend !== undefined) {
    try {
      vectorHits = await recallWithEmbedding(opts.embeddingBackend, index.chunks, query, recall);
    } catch {
      degradedParts.push("embedding_failed");
    }
  }
  const recalled = vectorHits ?? rankChunksBm25(index.chunks, query, recall);
  // N47: total = 召回截断前数量; truncated 由 topK 截断产生(调用方可信判断,
  // 不再把「8 条结果」误读为「只有 8 条」)。
  const total = recalled.length;
  const truncated = total > topK;
  // N47 review: total 受 recall 上限约束 —— 触顶时 total=recall 是下界非全量。
  const recallCapped = total >= recall;
  const totals = { total, truncated, ...(recallCapped ? { recall_capped: true as const } : {}) };

  // N47: open_target 确定性派生(不改落盘): 章正文 → chapters/NNN.md + 偏移;
  // 其余 source_type → 结构化资产目录约定(无偏移)。坏数据缺 chapter_index 跳过。
  const withTargets = (chunks: RagChunk[]): RagChunk[] =>
    chunks.map((c) => {
      if (c.source_type === "chapter_text" && typeof c.chapter_index === "number") {
        return {
          ...c,
          open_target: {
            path: `chapters/${String(c.chapter_index).padStart(3, "0")}.md`,
            ...(c.start_offset !== undefined ? { start_offset: c.start_offset } : {}),
            ...(c.end_offset !== undefined ? { end_offset: c.end_offset } : {}),
          },
        };
      }
      if (c.source_type === "outline") return { ...c, open_target: { path: "structure/" } };
      if (c.source_type === "memory") return { ...c, open_target: { path: "memory/events.jsonl" } };
      return { ...c, open_target: { path: "world/" } };
    });

  if (opts?.provider !== undefined && recalled.length > 1) {
    try {
      const reranked = await rerankWithProvider(opts.provider, query, recalled);
      return {
        ...totals,
        hits: withTargets(reranked.slice(0, topK)),
        ranking: "llm_rerank",
        ...(degradedParts.length > 0 ? { degraded: degradedParts.join(",") } : {}),
      };
    } catch {
      degradedParts.push("rerank_failed");
      return {
        ...totals,
        hits: withTargets(recalled.slice(0, topK)),
        ranking: vectorHits !== undefined ? "vector" : "bm25",
        ...(degradedParts.length > 0 ? { degraded: degradedParts.join(",") } : {}),
      };
    }
  }
  return {
    ...totals,
    hits: withTargets(recalled.slice(0, topK)),
    ranking: vectorHits !== undefined ? "vector" : "bm25",
    ...(degradedParts.length > 0 ? { degraded: degradedParts.join(",") } : {}),
  };
}
