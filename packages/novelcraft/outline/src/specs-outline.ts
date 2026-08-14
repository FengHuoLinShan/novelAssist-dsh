// outline 内容步 spec 注册(catalog §2)。
import { loadSpec, registerSpec } from "@novelcraft/llm-step";
import type { LlmStepSpec } from "@novelcraft/llm-step";

const T = 1_800_000;

export function registerOutlineSpecs(): void {
  const specs: LlmStepSpec[] = [
    {
      specRef: "story_outline_generate",
      description: "小说总纲 strict preview(catalog §2.1)",
      inputNotes: "项目档案 + 世界设定 + 作者指令",
      outputSchema: {
        type: "object",
        required: ["title", "outline_markdown"],
        properties: {
          title: { type: "string" },
          creative_core: { type: "object", additionalProperties: true },
          outline_markdown: { type: "string" },
          major_storylines: { type: "array", items: { type: "object", additionalProperties: true } },
          macro_movements: { type: "array", items: { type: "object", additionalProperties: true } },
          open_decisions: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.55,
      timeoutMs: T,
      degradationNote: "语义修订最多重生 1 次; 总纲 revisions 由 git 承接。",
      contractVersion: "v1",
    },
    {
      specRef: "outline_generate",
      description: "P20 当前层创作: plot_thread / outline_arc / planned_scene(catalog §2.2)",
      inputNotes: "上下文 + target + 作者指令(人物≤6, 对象≤16)",
      outputSchema: {
        type: "object",
        required: ["target", "content"],
        properties: {
          target: { type: "string" },
          content: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.55,
      timeoutMs: T,
      degradationNote: "候选 + 三类审计; 最多两次语义修订。",
      contractVersion: "v1",
    },
    {
      specRef: "p20_semantic_audit",
      description: "三类独立审计: evidence / scope_rule / author_instruction(catalog §2.3)",
      inputNotes: "生成候选 + 对应审计面",
      outputSchema: {
        type: "object",
        required: ["verdict"],
        properties: {
          verdict: { enum: ["pass", "revise"] },
          violations: { type: "array", items: { type: "string" } },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0,
      timeoutMs: T,
      degradationNote: "permission_level=suggest, 只读。",
      contractVersion: "v1",
    },
    {
      specRef: "outline_analyze",
      description: "手动大纲结构分析(catalog §2.4)",
      inputNotes: "大纲文本 + 项目档案",
      outputSchema: {
        type: "object",
        required: ["analysis"],
        properties: { analysis: { type: "string" } },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.3,
      timeoutMs: T,
      degradationNote: "分析结果进收件箱, 不写结构资产。",
      contractVersion: "v1",
    },
    {
      specRef: "scene_fusion_draft",
      description: "Scene 工作台融合 synthesis v2(catalog §2.5)",
      inputNotes: "待融合 Scene 卡",
      outputSchema: {
        type: "object",
        required: ["title", "confidence"],
        properties: {
          title: { type: "string" },
          goal: { type: "string" },
          core_conflict: { type: "string" },
          emotional_beat: { type: "string" },
          must_happen: { type: "string" },
          must_not_happen: { type: "string" },
          narrative_tag: { type: "string" },
          confidence: { type: "number" },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.2,
      timeoutMs: T,
      degradationNote: "章节映射/POV/状态/provenance 由确定性逻辑保持。",
      contractVersion: "v2",
    },
  ];
  for (const s of specs) {
    if (loadSpec(s.specRef)) continue;
    registerSpec(s);
  }
}
