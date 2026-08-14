// rankChunksBm25 — 标准 BM25(k1=1.5, b=0.75)粗排(M6 Track A1, L0)。
// - 文档 = chunk.text 的 tokenizeRagText 结果;
// - chunk.summary 命中查询词时按出现次数额外 +0.5/词 加分;
// - topK 默认 8; 零得分文档不返回; 空 query / 空 chunks 返回 []。
// 纯确定性: 同输入恒同输出(同分保持输入顺序, sort 为稳定排序)。
// M6 Track B 加法: scoreChunksBm25 抽出带原始分值的打分(供 L2 向量融合归一化用);
// rankChunksBm25 行为与之前完全一致(过滤 >0 → 降序 → 截 topK)。
import { tokenizeRagText } from "./tokenize.js";

const K1 = 1.5;
const B = 0.75;

/**
 * BM25 打分(M6 Track B 加法): 对全部输入 chunk 打分, 不过滤、不排序、不截断。
 * 供 L2 向量融合(两组各自 min-max 归一化)复用同一评分口径。
 */
export function scoreChunksBm25<T extends { text: string; summary?: string }>(
  chunks: readonly T[],
  query: string,
): Array<{ c: T; score: number }> {
  if (chunks.length === 0 || query.trim().length === 0) {
    return [];
  }

  const docs = chunks.map((c) => tokenizeRagText(c.text));
  const docLen = docs.map((d) => d.length);
  const avgLen = docLen.reduce((a, b) => a + b, 0) / docs.length;
  if (avgLen === 0) {
    return []; // 全部文档无可分词内容, 无命中。
  }
  const n = docs.length;

  // 文档频率 df(按文档去重统计)。
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // BM25 idf(带 +1 平滑, 避免负值)。
  const idf = (term: string): number => {
    const nq = df.get(term) ?? 0;
    return Math.log(1 + (n - nq + 0.5) / (nq + 0.5));
  };

  const qTerms = tokenizeRagText(query);
  const qDistinct = [...new Set(qTerms)];

  return chunks.map((c, i) => {
    // 正文 TF。
    const tf = new Map<string, number>();
    for (const t of docs[i]) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const qt of qDistinct) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      score += (idf(qt) * f * (K1 + 1)) / (f + K1 * (1 - B + B * (docLen[i] / avgLen)));
    }
    // summary 命中加分: 每个查询词在 summary 中的出现次数 × 0.5。
    if (c.summary !== undefined && c.summary.length > 0) {
      const sumTf = new Map<string, number>();
      for (const t of tokenizeRagText(c.summary)) {
        sumTf.set(t, (sumTf.get(t) ?? 0) + 1);
      }
      for (const qt of qDistinct) {
        score += 0.5 * (sumTf.get(qt) ?? 0);
      }
    }
    return { c, score };
  });
}

export function rankChunksBm25<T extends { text: string; summary?: string }>(
  chunks: readonly T[],
  query: string,
  topK = 8,
): T[] {
  return scoreChunksBm25(chunks, query)
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score) // 稳定排序: 同分保持原顺序。
    .slice(0, topK)
    .map((x) => x.c);
}
