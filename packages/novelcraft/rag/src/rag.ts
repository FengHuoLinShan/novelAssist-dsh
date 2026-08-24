// rag · 片段资产与可重建索引(R5, small-modules §3; D16 嵌入后端可插拔)。
// chunk 是派生索引可重建(R12); 文件是唯一真相。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

export const RAG_SOURCE_TYPES = ["chapter_text", "world_entity", "character", "memory", "outline"] as const;
export type RagSourceType = (typeof RAG_SOURCE_TYPES)[number];
export const RAG_VISIBILITIES = ["author_only", "author_safe", "reader_known", "public"] as const;
export type RagVisibility = (typeof RAG_VISIBILITIES)[number];
export const RAG_EMBEDDING_STATUSES = ["pending", "pending_vectorization", "succeeded", "failed", "skipped"] as const;
export const INDEX_VERSION_CN = "cn-novel-v1";

export interface RagChunk {
  chunk_id: string;
  source_type: RagSourceType;
  source_content_hash?: string;
  chapter_index?: number;
  chunk_index: number;
  start_offset?: number;
  end_offset?: number;
  char_count: number;
  text: string;
  summary?: string;
  visibility: RagVisibility;
  importance: number;
  index_version: string;
  embedding_status: (typeof RAG_EMBEDDING_STATUSES)[number];
  embedding_error?: string;
  /** 嵌入向量(L1 起由嵌入后端填充; 未嵌入时为 undefined)。 */
  vector?: number[];
  /** 生成 vector 所用的嵌入模型名(与 embedding_status 联动)。 */
  embedding_model?: string;
}

/** 嵌入后端注入接口(D16): provider 嵌入 API 或本地模型。 */
export interface EmbeddingBackend {
  /** 返回同序向量; 实现方决定模型与维度。 */
  embed(texts: string[]): Promise<number[][]>;
  readonly name: string;
}

/** 章节切块(确定性, annotation 固定值: cn-novel-v1; visibility 默认 author_only)。 */
export function chunkChapterText(
  text: string,
  opts: { chapterIndex: number; contentHash: string; targetChars?: number },
): RagChunk[] {
  const target = opts.targetChars ?? 1200;
  const out: RagChunk[] = [];
  const paras = text.split(/\n{2,}/);
  let buf = "";
  let idx = 0;
  const flush = () => {
    if (!buf.trim()) return;
    out.push({
      chunk_id: `ch${opts.chapterIndex}-${idx}`,
      source_type: "chapter_text",
      source_content_hash: opts.contentHash,
      chapter_index: opts.chapterIndex,
      chunk_index: idx,
      char_count: buf.length,
      text: buf.trim(),
      visibility: "author_only",
      importance: 0.5,
      index_version: INDEX_VERSION_CN,
      embedding_status: "pending",
    });
    idx += 1;
    buf = "";
  };
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > target && buf) {
      flush();
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return out;
}

/** 派生索引落盘(可全量重建): .assistant 下 rag-index.json。 */
export interface RagIndexFile {
  rebuilt_at: string;
  chunks: RagChunk[];
  /** 全库向量所用的嵌入模型(L1; 未嵌入时省略)。 */
  embedding_model?: string;
}

export function rebuildRagIndex(root: string, chunks: RagChunk[], now: Date = new Date()): RagIndexFile {
  const index: RagIndexFile = { rebuilt_at: now.toISOString(), chunks };
  writeFileSync(
    `${paths(root).assistant.dir}/rag-index.json`,
    JSON.stringify(index, null, 2) + "\n",
    "utf8",
  );
  return index;
}

export function readRagIndex(root: string): RagIndexFile | undefined {
  const file = `${paths(root).assistant.dir}/rag-index.json`;
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as RagIndexFile;
}

/** 检索: v1 文本包含 + 关键词粗排(嵌入后端接入后由 embed 排序)。 */
export function searchRagIndex(index: RagIndexFile, query: string, topK = 8): RagChunk[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const scored = index.chunks.map((c) => {
    let score = 0;
    for (const term of terms) {
      if (c.text.includes(term)) score += 1;
      if (c.summary?.includes(term)) score += 0.5;
    }
    return { c, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.c);
}
