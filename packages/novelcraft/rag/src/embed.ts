// embedPendingChunks — L2 批量嵌入(M6 Track B): 对索引中待向量化片段
// (embedding_status ∈ {pending, failed} 且无 vector)调用嵌入后端, 逐批落盘。
// 语义:
// - 无索引 → 全 0(不建索引);
// - 目标 = pending/failed 且无 vector 的 chunk; 按 batch(默认 32)调 backend.embed(texts):
//   成功 → vector/embedding_model=backend.name/status='succeeded';
//   整批抛错 → 该批 status='failed' + embedding_error=message, 继续下一批;
// - 每批后 rebuildRagIndex(root, chunks) 落盘(中断可重入: 已嵌入的不重算);
// - 有任一 succeeded 时索引文件 embedding_model=backend.name;
// - skipped = 有 vector 或 status='skipped' 的现存 chunk 数(口径注释: 这些不在本次目标内)。
// cosineSimilarity — 余弦相似度(长度不等 → 0 防御; 空数组 → 0)。
import { writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { readRagIndex, rebuildRagIndex, type EmbeddingBackend, type RagChunk } from "./rag.js";

export interface RagEmbedStats {
  embedded: number;
  failed: number;
  skipped: number;
}

const DEFAULT_BATCH = 32;

/** 落盘: 无任一成功 → rebuildRagIndex 原样写; 有成功 → 追加 embedding_model(与 R5 同形)。 */
function persistIndex(root: string, chunks: RagChunk[], embeddingModel?: string): void {
  if (embeddingModel === undefined) {
    rebuildRagIndex(root, chunks);
    return;
  }
  const file = `${paths(root).assistant.dir}/rag-index.json`;
  const index = { rebuilt_at: new Date().toISOString(), chunks, embedding_model: embeddingModel };
  writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export async function embedPendingChunks(
  root: string,
  backend: EmbeddingBackend,
  opts?: { batch?: number },
): Promise<RagEmbedStats> {
  const index = readRagIndex(root);
  if (!index) {
    return { embedded: 0, failed: 0, skipped: 0 };
  }
  const chunks = index.chunks;
  const batchSize = opts?.batch ?? DEFAULT_BATCH;

  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  let anySucceeded = false;

  // 目标筛选: pending/failed 且无 vector; 其余(有 vector 或 status='skipped')计入 skipped。
  const targets: RagChunk[] = [];
  for (const c of chunks) {
    if ((Array.isArray(c.vector) && c.vector.length > 0) || c.embedding_status === "skipped") {
      skipped += 1;
      continue;
    }
    if (c.embedding_status === "pending" || c.embedding_status === "failed") {
      targets.push(c);
    }
  }

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    try {
      const vectors = await backend.embed(batch.map((c) => c.text));
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error("嵌入后端返回向量数量与输入不一致");
      }
      for (let j = 0; j < batch.length; j += 1) {
        const c = batch[j];
        const v = vectors[j];
        if (!Array.isArray(v)) {
          c.embedding_status = "failed";
          c.embedding_error = "bge_embed_failed: 向量缺失";
          failed += 1;
          continue;
        }
        c.vector = v;
        c.embedding_model = backend.name;
        c.embedding_status = "succeeded";
        delete c.embedding_error;
        embedded += 1;
        anySucceeded = true;
      }
    } catch (err) {
      for (const c of batch) {
        c.embedding_status = "failed";
        c.embedding_error = err instanceof Error ? err.message : String(err);
        failed += 1;
      }
    }
    // 每批后落盘(中断可重入); 有任一 succeeded 时索引文件 embedding_model=backend.name。
    persistIndex(root, chunks, anySucceeded ? backend.name : undefined);
  }

  return { embedded, failed, skipped };
}

/** 余弦相似度: 长度不等或任一为空 → 0(防御, 不可比即无相似度)。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
