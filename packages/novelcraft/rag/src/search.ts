// searchRag — L0 确定性检索(BM25 粗排, M6 Track A1)。
// 索引不存在 → 空 hits; 命中走 rankChunksBm25。
// opts.recall 预留给 L1(本轮声明不使用)。
import { rankChunksBm25 } from "./bm25.js";
import { readRagIndex, type RagChunk } from "./rag.js";

export interface RagSearchResult {
  hits: RagChunk[];
  ranking: "bm25";
  degraded?: string;
}

export function searchRag(
  root: string,
  query: string,
  opts?: { topK?: number; recall?: number },
): RagSearchResult {
  const index = readRagIndex(root);
  if (!index) {
    return { hits: [], ranking: "bm25" };
  }
  const hits = rankChunksBm25(index.chunks, query, opts?.topK ?? 8);
  return { hits, ranking: "bm25" };
}
