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
import {
  readRagIndex,
  rebuildRagIndex,
  type EmbeddingBackend,
  type RagChunk,
  type RagVectorWarning,
  type RagVectorWarningCode,
} from "./rag.js";

export interface RagEmbedStats {
  embedded: number;
  failed: number;
  skipped: number;
  invalidated?: number;
  warnings?: RagVectorWarning[];
}

const DEFAULT_BATCH = 32;

/** 落盘: 无任一成功 → rebuildRagIndex 原样写; 有成功 → 追加 embedding_model(与 R5 同形)。 */
function persistIndex(
  root: string,
  chunks: RagChunk[],
  embeddingModel?: string,
  embeddingDimension?: number,
): void {
  if (embeddingModel === undefined) {
    rebuildRagIndex(root, chunks);
    return;
  }
  const file = `${paths(root).assistant.dir}/rag-index.json`;
  const index = {
    rebuilt_at: new Date().toISOString(),
    chunks,
    embedding_model: embeddingModel,
    ...(embeddingDimension !== undefined ? { embedding_dimension: embeddingDimension } : {}),
  };
  writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function validateVector(
  vector: unknown,
  expectedDimension?: number,
): { ok: true; dimension: number } | { ok: false; code: RagVectorWarningCode } {
  if (!Array.isArray(vector) || vector.length === 0) return { ok: false, code: "vector_empty" };
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return { ok: false, code: "vector_non_finite" };
  }
  if (expectedDimension !== undefined && vector.length !== expectedDimension) {
    return { ok: false, code: "vector_dimension_mismatch" };
  }
  return { ok: true, dimension: vector.length };
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
  let invalidated = 0;
  const warnings: RagVectorWarning[] = [];
  let expectedDimension =
    index.embedding_model === backend.name && Number.isSafeInteger(index.embedding_dimension) &&
      (index.embedding_dimension ?? 0) > 0
      ? index.embedding_dimension
      : undefined;
  let anySucceeded = false;

  const invalidate = (chunk: RagChunk, code: RagVectorWarningCode): void => {
    delete chunk.vector;
    delete chunk.embedding_model;
    if (chunk.embedding_status !== "skipped") chunk.embedding_status = "pending";
    chunk.embedding_error = `vector_invalid:${code}`;
    invalidated += 1;
    warnings.push({ code, chunk_id: chunk.chunk_id, message: `向量不可用于 ${backend.name}: ${code}` });
  };

  // 目标筛选: pending/failed 且无 vector; 其余(有 vector 或 status='skipped')计入 skipped。
  const targets: RagChunk[] = [];
  for (const c of chunks) {
    if (c.vector !== undefined || c.embedding_status === "succeeded") {
      if (c.embedding_status !== "succeeded") {
        invalidate(c, "vector_status_invalid");
      } else if (c.embedding_model !== backend.name) {
        invalidate(c, "vector_model_mismatch");
      } else {
        const checked = validateVector(c.vector, expectedDimension);
        if (!checked.ok) invalidate(c, checked.code);
        else {
          expectedDimension ??= checked.dimension;
          anySucceeded = true;
          skipped += 1;
          continue;
        }
      }
    }
    if (c.embedding_status === "skipped") {
      skipped += 1;
      continue;
    }
    if (c.embedding_status === "pending" || c.embedding_status === "failed" || c.embedding_status === "succeeded") {
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
        const checked = validateVector(v, expectedDimension);
        if (!checked.ok) {
          delete c.vector;
          delete c.embedding_model;
          c.embedding_status = "failed";
          c.embedding_error = `vector_invalid:${checked.code}`;
          warnings.push({
            code: checked.code,
            chunk_id: c.chunk_id,
            message: `嵌入后端 ${backend.name} 返回不可用向量: ${checked.code}`,
          });
          failed += 1;
          continue;
        }
        expectedDimension ??= checked.dimension;
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
    persistIndex(root, chunks, anySucceeded ? backend.name : undefined, anySucceeded ? expectedDimension : undefined);
  }

  if (invalidated > 0 && targets.length === 0) {
    persistIndex(root, chunks, anySucceeded ? backend.name : undefined, anySucceeded ? expectedDimension : undefined);
  }

  return {
    embedded,
    failed,
    skipped,
    ...(invalidated > 0 ? { invalidated } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** 余弦相似度: 长度不等或任一为空 → 0(防御, 不可比即无相似度)。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!validateVector(a).ok || !validateVector(b, a.length).ok) return 0;
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
