// searchRag — L0 确定性检索(BM25 粗排) + L1 内容手精排(M6 Track A1 收尾)。
// 流程: 无索引 → 空 hits; 命中走 rankChunksBm25 召回(recall 默认 20);
// provider 存在且召回 >1 条 → rag_rerank 重排召回集后取 topK(ranking=llm_rerank);
// 精排失败/超时 → 回退 BM25 原序取 topK(ranking=bm25, degraded=rerank_failed);
// provider 不存在 → 召回直接取 topK(ranking=bm25)。
// ranking 的 'vector' 预留给嵌入精排(本轮不会产生)。
import { rankChunksBm25 } from "./bm25.js";
import { readRagIndex, type RagChunk } from "./rag.js";
import { rerankWithProvider } from "./rerank.js";
import type { Provider } from "@novelcraft/llm-step";

export interface RagSearchResult {
  hits: RagChunk[];
  ranking: "bm25" | "llm_rerank" | "vector";
  degraded?: string;
}

export async function searchRag(
  root: string,
  query: string,
  opts?: { topK?: number; recall?: number; provider?: Provider },
): Promise<RagSearchResult> {
  const index = readRagIndex(root);
  if (!index) {
    return { hits: [], ranking: "bm25" };
  }
  const topK = opts?.topK ?? 8;
  const recalled = rankChunksBm25(index.chunks, query, opts?.recall ?? 20);
  if (opts?.provider !== undefined && recalled.length > 1) {
    try {
      const reranked = await rerankWithProvider(opts.provider, query, recalled);
      return { hits: reranked.slice(0, topK), ranking: "llm_rerank" };
    } catch {
      return { hits: recalled.slice(0, topK), ranking: "bm25", degraded: "rerank_failed" };
    }
  }
  return { hits: recalled.slice(0, topK), ranking: "bm25" };
}
