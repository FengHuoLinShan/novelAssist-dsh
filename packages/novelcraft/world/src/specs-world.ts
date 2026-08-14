// world 内容步 spec 注册(catalog §4; §19 映射)。
// M7 N27: 7 个 spec 的 temperature/timeout 与 catalog §4.x 转录核对一致(§4.1 temp 0.8 / §4.2 0 / §4.3 0.2 /
// §4.4 0 / §4.6-4.8 0.35, timeout 均 1800s); catalog 各节均无 max_tokens 行 → budgetTokens 0 保持, 无改动。
import { loadSpec, registerSpec } from "@novelcraft/llm-step";
import type { LlmStepSpec } from "@novelcraft/llm-step";

const t = 1_800_000; // WORLD_GENERATION_TIMEOUT_SECONDS

export function registerWorldSpecs(): void {
  const specs: LlmStepSpec[] = [
    {
      specRef: "world_creation_chat",
      description: "世界观自由共创对话(生成中心 chat, catalog §4.1)",
      inputNotes: "世界上下文 + 作者对话内容",
      outputSchema: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: true },
      budgetTokens: 0,
      temperature: 0.8,
      timeoutMs: t,
      degradationNote: "不写资产; 空文本同阶段重试 1 次。",
      contractVersion: "v1",
    },
    {
      specRef: "world_convergence",
      description: "只读收束 map/reduce(生成中心 convergence, catalog §4.2)",
      inputNotes: "作者选定来源窗口 + 对话内容",
      outputSchema: {
        type: "object",
        properties: {
          retained_source_keys: { type: "array", items: { type: "string" } },
          shared_source_keys: { type: "array", items: { type: "string" } },
          rules: { type: "object", additionalProperties: true },
        },
        required: ["retained_source_keys"],
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0,
      timeoutMs: t,
      degradationNote: "漏项/未知 key 修复 1 次; 不物化建议。",
      contractVersion: "v1",
    },
    {
      specRef: "world_exploration",
      description: "一跳探索 preview(生成中心 exploration, catalog §4.3)",
      inputNotes: "当前世界状态",
      outputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "object", additionalProperties: true } },
          stop_reason: { type: "string" },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.2,
      timeoutMs: t,
      degradationNote: "最多 3 个一跳缺口或停止原因; 不创建资产。",
      contractVersion: "v1",
    },
    {
      specRef: "world_semantic_inspection",
      description: "当前页检修(生成中心 semantic-inspection, catalog §4.4)",
      inputNotes: "冻结页面内容",
      outputSchema: {
        type: "object",
        properties: {
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0,
      timeoutMs: t,
      degradationNote: "findings 供作者复核; 最多 2 次尝试。",
      contractVersion: "v1",
    },
    {
      specRef: "world_core_entity",
      description: "世界对象建议收束(生成中心 suggestions, catalog §4.6)",
      inputNotes: "作者选定 target + 世界上下文",
      outputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          public_info: { type: "string" },
          hidden_truth: { type: "string" },
          importance_level: { type: "string" },
          reveal_level: { type: "string" },
          details: { type: "object", additionalProperties: true },
          character_card: { type: "object", additionalProperties: true },
          review_notes: { type: "string" },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.35,
      timeoutMs: t,
      degradationNote: "结果只进待处理建议, 不自动采用(§19)。",
      contractVersion: "v1",
    },
    {
      specRef: "world_bible_page",
      description: "世界书整页重构提案(生成中心 suggestions, catalog §4.7)",
      inputNotes: "当前页面 + 选定来源页",
      outputSchema: {
        type: "object",
        required: ["title", "sections"],
        properties: {
          title: { type: "string" },
          page_type: { type: "string" },
          overview: { type: "string" },
          sections: { type: "array", items: { type: "object", additionalProperties: true } },
          linked_asset_keys: { type: "array", items: { type: "string" } },
          design_rationale: { type: "string" },
          review_notes: { type: "string" },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.35,
      timeoutMs: t,
      degradationNote: "整页提案非 append/patch; apply 前重验 baseline(§19)。",
      contractVersion: "v1",
    },
    {
      specRef: "world_bible_new_page",
      description: "世界书全新页面提案(生成中心 suggestions, catalog §4.8)",
      inputNotes: "世界上下文",
      outputSchema: {
        type: "object",
        required: ["title", "sections"],
        properties: {
          title: { type: "string" },
          page_type: { type: "string" },
          overview: { type: "string" },
          sections: { type: "array", items: { type: "object", additionalProperties: true } },
          linked_asset_keys: { type: "array", items: { type: "string" } },
          design_rationale: { type: "string" },
          review_notes: { type: "string" },
          source_revision: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.35,
      timeoutMs: t,
      degradationNote: "结果只进待处理建议(§19)。",
      contractVersion: "v1",
    },
  ];
  for (const s of specs) {
    if (loadSpec(s.specRef)) continue;
    registerSpec(s);
  }
}
