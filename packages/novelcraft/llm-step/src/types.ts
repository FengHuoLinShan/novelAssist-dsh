// llm-step 类型(R2 核心契约, 依据设计文档 §4/§12/§22.5 + specs/prompts/catalog.md)
import type { WorkflowBudget } from "./budget.js";
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
  /** 覆盖 spec 默认(如按项目设置/预设卡, N20) */
  overrides?: {
    /** DSH provider 路由(如 'deepseek'); 缺省由 Provider 实现侧默认承接 */
    provider?: string;
    model?: string;
    temperature?: number;
    /** top_p [0,1](审查项 4: core strict 参数面支持; 传输契约不支持处由实现侧明确拒绝) */
    top_p?: number;
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
  /** DSH provider 路由覆盖(加法, N20 预设卡); 缺省由实现侧默认承接 */
  provider?: string;
  model?: string;
  temperature?: number;
  /** top_p [0,1](审查项 4: core strict 参数面支持; 传输契约不支持处由实现侧明确拒绝) */
  top_p?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Provider 可选执行默认(N34 / ADR-0023 §6 加法, 独立审查 P2):
 * 由执行画像(ExecutionProfile)经 DSH 组合后附着在 Provider 上, 使 imports/writing/world/rag
 * 内部的「裸 runStep(provider, req)」也真正继承 timeout/maxTokens/temperature/model——
 * 不逐包改调用点、不改 runStep 签名的破坏面。
 * runStep 按 spec 默认 < provider.executionDefaults < 请求 overrides 合并
 * (显式 undefined 判断, temperature=0 等合法零值不被吞掉)。
 */
export interface StepExecutionDefaults {
  /** DSH provider 路由默认(如 'deepseek'); 请求级 override 优先 */
  provider?: string;
  /** 模型 id 默认; 请求级 override 优先 */
  model?: string;
  /** 单步温度默认, [0,2] 有限数字; 请求级 override 优先 */
  temperature?: number;
  /** 单步 top_p 默认, [0,1] 有限数字; 请求级 override 优先(审查项 4) */
  top_p?: number;
  /** 单次输出 token 上限默认(1–200000 整数; 0/缺省 = spec 决定); 请求级 override 优先 */
  maxTokens?: number;
  /** 单步超时默认毫秒(1000–3600000 整数); 请求级 override 优先 */
  timeoutMs?: number;
}

export interface Provider {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  /**
   * 可选执行默认(加法): runStep 在 spec 默认与请求 overrides 之间读取本层。
   * 由 DSH 组合面(withResolvedDefaults / contentProviderFor)附着的执行画像默认;
   * 裸 runStep(provider, req) 无需经 applyExecutionProfileToRequest 也能继承。
   */
  executionDefaults?: StepExecutionDefaults;
  /** Optional orchestration-scoped cumulative tracker; explicit RunStepOptions.budget wins. */
  workflowBudget?: WorkflowBudget;
}
