// rerankWithProvider — L1 内容手精排(M6 Track A1 收尾; spec rag_rerank, N21)。
// 语义:
// - input 组装: 查询 + 候选列表, 每候选一行 "[序号] [chunk_id] text前200字"(统一用 text, 不依赖 summary);
// - 候选数上限由调用方控制(本函数不截数量);
// - runStep 不 ok → throw(r.error.kind ?? 'rerank_failed'), 由调用方 catch 降级;
// - ranked_ids 缺失/非数组 → 视为失败 throw;
// - 重排: ranked_ids 中出现的已知 id 按序前置, 未知 id 忽略, 未提及 chunk 按原相对顺序殿后;
//   同输入(含同 ranked_ids)恒同输出, 确定性。
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import type { RagChunk } from "./rag.js";

const PREVIEW_CHARS = 200;

function buildRerankInput(query: string, chunks: readonly RagChunk[]): string {
  const lines = chunks.map((c, i) => i + 1 + ". [" + c.chunk_id + "] " + c.text.slice(0, PREVIEW_CHARS));
  return ["查询: " + query, "", "候选片段(各截断约 200 字, 按 chunk_id 引用):", ...lines].join("\n");
}

export async function rerankWithProvider(
  provider: Provider,
  query: string,
  chunks: readonly RagChunk[],
): Promise<RagChunk[]> {
  const input = buildRerankInput(query, chunks);
  const r = await runStep(provider, { specRef: "rag_rerank", input });
  if (!r.ok) {
    throw new Error(r.error?.kind ?? "rerank_failed");
  }
  const ranked = (r.result as { ranked_ids?: unknown } | null)?.ranked_ids;
  if (!Array.isArray(ranked)) {
    throw new Error("rerank_failed");
  }

  // 确定性重排(对象身份跟踪, 兼容重复 chunk_id 输入)。
  const byId = new Map<string, RagChunk>();
  for (const c of chunks) {
    if (!byId.has(c.chunk_id)) byId.set(c.chunk_id, c);
  }
  const head: RagChunk[] = [];
  const placed = new Set<RagChunk>();
  for (const id of ranked) {
    if (typeof id !== "string") continue; // 防御: 非字符串 id 忽略(schema 已保证为 string)。
    const c = byId.get(id);
    if (c === undefined || placed.has(c)) continue; // 未知 id / 重复 id 忽略。
    placed.add(c);
    head.push(c);
  }
  const tail = chunks.filter((c) => !placed.has(c));
  return [...head, ...tail];
}
