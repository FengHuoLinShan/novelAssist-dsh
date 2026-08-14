// 内置 spec 注册表(R2 首期 4 个, 转写自 specs/prompts/catalog.md)。
// 未定字段标【待定】并放宽(additionalProperties 允许)。
import type { LlmStepSpec } from "./types.js";

export const BUILTIN_SPECS: LlmStepSpec[] = [
  {
    // catalog §1.6: 0.88 阈值与同名同型复用属 store 层, 本 spec 只管抽取输出
    specRef: "entity_extraction",
    description: "Phase 2a: 按 Scene 抽取长期创作资产(世界对象)。",
    inputNotes: "冻结 Scene 文本 + 已采用对象目录(供复用判断)。",
    outputSchema: {
      type: "object",
      required: ["entities"],
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "entity_type", "evidence"],
            properties: {
              name: { type: "string" },
              entity_type: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              description: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
            },
            additionalProperties: true,
          },
        },
        notes: { type: "string" },
      },
      additionalProperties: true,
    },
    budgetTokens: 0,
    temperature: 0.1,
    timeoutMs: 600_000,
    degradationNote: "provider 失败只降级不丢对象(catalog §1.6 降级)。",
    contractVersion: "v1",
  },
  {
    // catalog §1.9: 无独立契约 JSON, 输出契约【待定】→ 放宽
    specRef: "dedup_judge",
    description: "去重 L1/L2: 判定候选组内同一/不同实体(带证据与置信度)。",
    inputNotes: "归一化名分组 + 各候选的来源 Scene 证据。",
    outputSchema: {
      type: "object",
      required: ["decisions"],
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            required: ["candidate_ids", "verdict", "confidence"],
            properties: {
              candidate_ids: { type: "array", items: { type: "string" } },
              verdict: { enum: ["same", "different", "uncertain"] },
              confidence: { type: "number" },
              reasoning: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
    budgetTokens: 0,
    temperature: 0.1,
    timeoutMs: 600_000,
    degradationNote: "uncertain 进不确定组, 交作者(catalog §1.9)。",
    contractVersion: "v1",
  },
  {
    // catalog §3.3: 无契约 JSON, 字段以 semantic_review.py 为准【待定】→ 放宽
    specRef: "semantic_review",
    description: "章完成语义近读: 分块独立审查, 产出 finding-bound 结果。",
    inputNotes: "冻结正文 + 合同(Scene 目标/必发生项等)。",
    outputSchema: {
      type: "object",
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["category", "severity", "quote", "suggestion"],
            properties: {
              category: { type: "string" },
              severity: { enum: ["high", "medium", "low"] },
              quote: { type: "string" },
              suggestion: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        verdict: { type: "string" },
      },
      additionalProperties: true,
    },
    budgetTokens: 0,
    temperature: 0.1,
    timeoutMs: 1_800_000,
    degradationNote: "findings 只进收件箱/修订中心, 不写正文(catalog §3.3)。",
    contractVersion: "v1",
  },
  {
    // catalog §1.8: 剧情线/篇章纲/伏笔; 结构去重置信 ≥0.96 自动应用属 store 层
    specRef: "structure_analysis",
    description: "Phase 3: 剧情结构分析(剧情线/篇章纲/伏笔计划)。",
    inputNotes: "Scene 结构 + 对象目录 + 可选正文节选。",
    outputSchema: {
      type: "object",
      required: ["threads", "arcs"],
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              confidence: { type: "number" },
              related_scenes: { type: "array", items: { type: "string" } },
            },
            additionalProperties: true,
          },
        },
        arcs: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              confidence: { type: "number" },
              chapter_range: { type: "array", items: { type: "number" } },
            },
            additionalProperties: true,
          },
        },
        foreshadowing: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: true,
    },
    budgetTokens: 0,
    temperature: 0.3,
    timeoutMs: 1_800_000,
    degradationNote: "失败保持结构资产不动(catalog §1.8 降级)。",
    contractVersion: "v1",
  },
  {
    // 写作前计划台(§17.4/§17.5.3): 轻量「下一步提案」, 非整章正文(writing_generate)。
    // 无契约 JSON → 内联放宽(additionalProperties)。
    specRef: "next_chapter_proposal",
    description: "写作前计划台: 基于总纲/剧情线/上一章结尾, 给出下一章 2–3 条续写方向(各带依据/成本/风险)。",
    inputNotes: "总纲 + 剧情线/篇章纲/伏笔摘要 + 上一章正文结尾。",
    outputSchema: {
      type: "object",
      required: ["proposals"],
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "premise"],
            properties: {
              title: { type: "string" },
              premise: { type: "string" },
              basis: { type: "array", items: { type: "string" } },
              cost: { type: "string" },
              risk: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
    budgetTokens: 0,
    temperature: 0.7,
    timeoutMs: 1_800_000,
    degradationNote: "提案只进 .assistant/proposals/ 临时预览, 不写正文; 失败不落盘。",
    contractVersion: "v1",
  },
  {
    // catalog §3.1: 正文候选生成(续写模式追加)。outputFormat=text → result={text}。
    specRef: "writing_generate",
    description: "正文候选生成: 基于选定续写方向/上下文输出下一章正文候选(续写模式追加)。",
    inputNotes: "选定提案(title/premise)+ 上下文(总纲/剧情线/上一章正文结尾)。",
    outputSchema: { type: "object" },
    outputFormat: "text",
    budgetTokens: 0,
    temperature: 0.7,
    timeoutMs: 1_800_000,
    degradationNote: "候选只进 chapters/pending/; 失败不改写正文(catalog §3.1)。",
    contractVersion: "v1",
  },
  {
    // M6 N21: 检索精排(rag_rerank) — BM25 召回后的候选片段按与查询的相关性重排
    // M7 N24: 预算 2048→4096, 覆盖默认召回集(recall=20 × 200 字输入估算 ≈2625 token)。
    specRef: "rag_rerank",
    description: "检索精排: 对召回候选片段按与查询的相关性重排, 返回按相关度降序的 chunk_id 列表。",
    inputNotes: "查询文本 + 编号候选片段(各截断约 200 字)。",
    outputSchema: {
      type: "object",
      required: ["ranked_ids"],
      properties: {
        ranked_ids: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    budgetTokens: 4096,
    temperature: 0.1,
    timeoutMs: 120_000,
    degradationNote: "失败/超时回退 BM25 原序, 检索不阻断写作。",
    contractVersion: "v1",
  },
];

const registry = new Map(BUILTIN_SPECS.map((s) => [s.specRef, s]));

export function registerSpec(spec: LlmStepSpec): void {
  if (registry.has(spec.specRef)) {
    throw new Error(`spec 已注册: ${spec.specRef}`);
  }
  registry.set(spec.specRef, spec);
}

export function loadSpec(specRef: string): LlmStepSpec | undefined {
  return registry.get(specRef);
}

export function listSpecRefs(): string[] {
  return [...registry.keys()];
}
