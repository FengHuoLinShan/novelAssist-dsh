// imports Phase 1 spec 注册(catalog §1.1–1.5, 契约字段以 prompt-contracts 为准)。
import { loadSpec, registerSpec } from "@novelcraft/llm-step";
import type { LlmStepSpec } from "@novelcraft/llm-step";

const sceneFields = (): LlmStepSpec["outputSchema"]["properties"] => ({
  title: { type: "string" },
  goal: { type: "string" },
  core_conflict: { type: "string" },
  core_conflict_status: { enum: ["present", "not_applicable"] },
  start_chapter: { type: "number" },
  end_chapter: { type: "number" },
  start_anchor: { type: "string" },
  end_anchor: { type: "string" },
  boundary_status: { type: "string" },
  boundary_basis: { type: "string" },
  confidence: { type: "number" },
});

export function registerImportSpecs(): void {
  const specs: LlmStepSpec[] = [
    {
      specRef: "scene_slicing",
      description: "Phase 1a 主窗口切分(catalog §1.1)",
      inputNotes: "章节正文 + Phase1a 上下文(边界章节/项目档案)",
      outputSchema: {
        type: "object",
        required: ["scenes"],
        properties: {
          window_edges: { type: "object", additionalProperties: true },
          scenes: { type: "array", items: { type: "object", required: ["title", "confidence"], properties: sceneFields(), additionalProperties: true } },
        },
        additionalProperties: true,
      },
      budgetTokens: 8192,
      temperature: 0.2,
      timeoutMs: 900_000,
      degradationNote: "锚点伪造不允许; 重叠/空洞由确定性协调, 失败保留精确整章 fallback、不部分采用。",
      contractVersion: "v1",
    },
    {
      specRef: "scene_anchor_repair",
      description: "Phase 1a anchor 修复(catalog §1.2)",
      inputNotes: "章节正文 + 未定位的锚点描述",
      outputSchema: {
        type: "object",
        required: ["status", "reason"],
        properties: {
          status: { enum: ["resolved", "partial", "unresolved"] },
          start_anchor: { type: "string" },
          end_anchor: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: true,
      },
      budgetTokens: 32768,
      temperature: 0,
      timeoutMs: 900_000,
      degradationNote: "partial/unresolved 合法; 不得为满足 schema 伪造另一侧锚点。",
      contractVersion: "v1",
    },
    {
      specRef: "scene_gap_recovery",
      description: "Phase 1a 连续缺口恢复(catalog §1.3)",
      inputNotes: "缺口左右边界章节正文",
      outputSchema: {
        type: "object",
        required: ["status", "reason"],
        properties: {
          status: { type: "string" },
          left_right_relation: { type: "string" },
          segments: { type: "array", items: { type: "object", required: ["title"], properties: sceneFields(), additionalProperties: true } },
          reason: { type: "string" },
        },
        additionalProperties: true,
      },
      budgetTokens: 8192,
      temperature: 0.1,
      timeoutMs: 900_000,
      degradationNote: "恢复结果须过唯一锚点/顺序/无重叠/无空洞校验, 按整个 gap 原子应用; 失败整章 fallback。",
      contractVersion: "v1",
    },
    {
      specRef: "scene_enrichment",
      description: "Phase 1b Scene 深化(catalog §1.4)",
      inputNotes: "Scene 卡 + 原文片段",
      outputSchema: {
        type: "object",
        required: ["confidence"],
        properties: {
          emotional_beat: { type: "string" },
          must_happen: { type: "string" },
          must_not_happen: { type: "string" },
          narrative_tag: { enum: ["draft", "hook", "inciting_incident", "rising_action", "climax", "valley", "transition", "payoff"] },
          narrative_function: { type: "string" },
          basis: { type: "string" },
          uncertain_fields: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        additionalProperties: true,
      },
      budgetTokens: 32768,
      temperature: 0.2,
      timeoutMs: 1_200_000,
      degradationNote: "provider/schema 失败保留空语义 + narrative_tag=draft 并进复核; imported 提交时归一 draft。",
      contractVersion: "v1",
    },
    {
      specRef: "alias_relation",
      description: "Phase 2b: 本 Scene 增量别名与关系(catalog §1.7)",
      inputNotes: "Scene 正文 + 已采用实体索引",
      outputSchema: {
        type: "object",
        required: ["aliases", "relations", "uncertain_items"],
        properties: {
          aliases: {
            type: "array",
            items: {
              type: "object",
              required: ["entity_ref", "alias", "confidence"],
              properties: {
                entity_ref: { type: "string" },
                alias: { type: "string" },
                alias_type: { type: "string" },
                identity_scope: { type: "string" },
                identity_basis: { type: "string" },
                evidence_quotes: { type: "array", items: { type: "string" } },
                confidence: { type: "number" },
              },
              additionalProperties: true,
            },
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              required: ["source_ref", "target_ref", "relation_type", "confidence"],
              properties: {
                source_ref: { type: "string" },
                target_ref: { type: "string" },
                relation_type: { type: "string" },
                persistence_scope: { type: "string" },
                directionality: { type: "string" },
                claim_status: { type: "string" },
                description: { type: "string" },
                strength: { type: "number" },
                evidence_quotes: { type: "array", items: { type: "string" } },
                confidence: { type: "number" },
              },
              additionalProperties: true,
            },
          },
          uncertain_items: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.2,
      timeoutMs: 600_000,
      degradationNote: "别名不建重复对象, 只写待复核内联证据; 关系不自动覆盖已采用(catalog §1.7)。",
      contractVersion: "v3",
    },
    {
      specRef: "scene_fusion",
      description: "Phase 1c 边界复核 + 融合(catalog §1.5)",
      inputNotes: "相邻候选对 + 原文边界上下文",
      outputSchema: {
        type: "object",
        required: ["boundaries"],
        properties: {
          boundaries: {
            type: "array",
            items: {
              type: "object",
              required: ["left_candidate_id", "right_candidate_id", "relation", "confidence"],
              properties: {
                left_candidate_id: { type: "string" },
                right_candidate_id: { type: "string" },
                relation: { type: "string" }, // 归一/过滤在 materializer(R60), schema 不拒绝
                fusion_intent: { type: "string" }, // 归一/过滤在 materializer(R60)
                basis: { type: "string" },
                uncertainties: { type: "array", items: { type: "string" } },
                confidence: { type: "number" },
              },
              additionalProperties: true,
            },
          },
          candidate_concerns: { type: "array", items: { type: "object", additionalProperties: true } },
          synthesis: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      budgetTokens: 0,
      temperature: 0.1,
      timeoutMs: 1_200_000,
      degradationNote: "仅来源精确且无 concern/uncertainty 的连通组进 synthesis; 低置信只形成建议不自动采用。",
      contractVersion: "v1",
    },
  ];
  for (const s of specs) {
    if (loadSpec(s.specRef)) continue; // 幂等: 重复注册忽略
    registerSpec(s);
  }
}
