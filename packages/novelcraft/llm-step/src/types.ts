// llm-step 类型(R2 核心契约, 依据设计文档 §4/§12/§22.5 + specs/prompts/catalog.md)
import type { ValidatorSchema } from "./validator.js";

export interface LlmStepSpec {
  /** 全局唯一, llm_step(spec=) 引用 */
  specRef: string;
  /** 用途(作者语言一句话, catalog 的「用途一句话」) */
  description: string;
  /** 输入资料说明(catalog 的「输入」) */
  inputNotes: string;
  /** 输出 JSON Schema(catalog 的输出 Schema 字段级; 未定字段放宽 additionalProperties) */
  outputSchema: ValidatorSchema;
  /** 输出形态: json(默认, 走 schema 校验) | text(正文类输出, 如 targeted_revision) */
  outputFormat?: "json" | "text";
  /** 单次调用输出预算(token 上限; 0 = 不限) */
  budgetTokens: number;
  /** 温度(catalog 各 spec 的 temp) */
  temperature: number;
  /** 超时毫秒(catalog 各 spec 的 timeout) */
  timeoutMs: number;
  /** 降级条款文本(catalog 的「降级」; 供编排层决策, 不在本层自动降级) */
  degradationNote: string;
  /** 契约版本(prompt-contracts 版本语义) */
  contractVersion: string;
}

export interface StepRequest {
  specRef: string;
  /** 内容输入(原文/上下文; D14 无隐私模式, 原文直通) */
  input: string;
  /** 覆盖 spec 默认(如按项目设置) */
  overrides?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
  /** 修复预算: 首次 schema 违例后注入错误信息重试的最多次数(默认 1) */
  fixAttempts?: number;
}

export type StepErrorKind =
  | "spec_not_found"
  | "budget_exceeded"
  | "timeout"
  | "schema_violation"
  | "provider_retryable"
  | "provider_fatal";

export interface StepError {
  kind: StepErrorKind;
  message: string;
  /** schema_violation 时的校验问题列表 */
  issues?: unknown[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JournalEntry {
  attempt: number;
  startedAt: string;
  durationMs: number;
  providerText?: string;
  usage?: Usage;
  errorKind?: StepErrorKind;
  errorMessage?: string;
}

export interface StepResult {
  /** 校验通过的结构化输出 */
  result: unknown;
  journal: JournalEntry[];
  usage: Usage;
  ok: boolean;
  error?: StepError;
  specRef: string;
  contractVersion: string;
}

/** Provider 注入接口(真 DSH ctx.llm 适配留挂载阶段, 见 packages/novelcraft/README.md seam 契约) */
export interface ProviderRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
