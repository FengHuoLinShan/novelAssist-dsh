// system 提示组装(M10-A2/A3, N38 加法): promptBody 优先 + 输出契约文本注入。
// 纪律(后续开发计划.md §0.6): 模型可见⟺可回放 —— 组装结果 hash 进 journal,
// 注入模式显式记录; 缺 promptBody 的 spec 回退 legacy 摘要路径(字节级不变,
// 由 prompt-body.test.ts golden 断言锁定)。
// N38: rc.8 GenerateOptions 无 response_format/json_schema 字段(A1 探测),
// schema 以文本注入 system 槽, 不使用 tools 伪装通道、不触碰共享层。
import { createHash } from "node:crypto";
import type { LlmStepSpec } from "./types.js";

/** legacy 摘要路径的 system 提示(M10 前唯一路径; 保留为缺 promptBody 时的回退)。 */
export function legacySystemPrompt(spec: LlmStepSpec): string {
  return [
    `你是 NovelCraft 内容手。任务: ${spec.description}`,
    `输入资料要求: ${spec.inputNotes}`,
    "输出必须是合法 JSON, 严格符合给定的 JSON Schema, 不得输出额外文字。",
    `降级条款(供上层决策, 不由你执行): ${spec.degradationNote}`,
  ].join("\n");
}

/** 输出契约文本(OUTPUT_CONTRACT): outputFormat=json 时注入 system 尾部; text 形态不注入。 */
export function renderOutputContract(spec: LlmStepSpec): string | undefined {
  if (spec.outputFormat === "text") return undefined;
  return [
    "输出契约(OUTPUT_CONTRACT): 你的输出必须是合法 JSON, 且严格符合以下 JSON Schema,不得输出任何额外文字:",
    "```json",
    JSON.stringify(spec.outputSchema),
    "```",
  ].join("\n");
}

export interface ComposedSystemPrompt {
  text: string;
  /** 组装来源: promptBody(真实 Prompt 正文) | legacy-summary(摘要回退) */
  source: "promptBody" | "legacy-summary";
  /** 输出契约注入模式; 与 journal/指纹的 schemaInjection 同词表 */
  schemaInjection: "text-contract" | "none";
}

/** system 提示组装: promptBody 存在时以其为主体, 否则回退 legacy 摘要; json 形态追加输出契约。 */
export function composeSystemPrompt(spec: LlmStepSpec): ComposedSystemPrompt {
  const contract = renderOutputContract(spec);
  const schemaInjection = contract === undefined ? "none" : "text-contract";
  if (spec.promptBody === undefined) {
    // 回退路径: legacy 文本 + 输出契约(注入从 M10 起对 json 形态生效)。
    const text =
      contract === undefined ? legacySystemPrompt(spec) : `${legacySystemPrompt(spec)}\n\n${contract}`;
    return { text, source: "legacy-summary", schemaInjection };
  }
  const parts = [spec.promptBody];
  if (contract !== undefined) parts.push(contract);
  parts.push(`降级条款(供上层决策, 不由你执行): ${spec.degradationNote}`);
  return { text: parts.join("\n\n"), source: "promptBody", schemaInjection };
}

/** sha256 前 16 hex(短指纹; 指纹用途是变更检测与 journal 回放对照, 非密码学承诺)。 */
export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** spec.outputSchema 规范化序列化 hash(键序稳定: JSON.stringify 保持插入序, 注册表 spec 为字面量常量)。 */
export function outputSchemaHash(spec: LlmStepSpec): string {
  return promptHash(JSON.stringify(spec.outputSchema));
}
