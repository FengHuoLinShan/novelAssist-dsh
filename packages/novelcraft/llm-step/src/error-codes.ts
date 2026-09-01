// llm-step 错误码映射(加法导出; DSH 适配层与客户端共用同一份知识, 避免两处手抄漂移)。
// 码值保持与 @novelcraft/dsh 历史 toolError 映射逐字一致。
import type { StepErrorKind } from "./types.js";

/** StepErrorKind → 稳定错误码(宿主 HarnessError code 通道)。 */
export const LLM_ERROR_CODES: Readonly<Record<StepErrorKind, string>> = Object.freeze({
  spec_not_found: "LLM_SPEC_NOT_FOUND",
  budget_exceeded: "LLM_BUDGET_EXCEEDED",
  timeout: "LLM_TIMEOUT",
  cancelled: "LLM_CANCELLED",
  context_overflow: "LLM_CONTEXT_OVERFLOW",
  truncated: "LLM_TRUNCATED",
  empty_response: "LLM_EMPTY_RESPONSE",
  unexpected_tool_calls: "LLM_UNEXPECTED_TOOL_CALLS",
  protocol_error: "LLM_PROTOCOL_ERROR",
  schema_violation: "LLM_SCHEMA_VIOLATION",
  provider_retryable: "LLM_PROVIDER_RETRYABLE",
  provider_fatal: "LLM_PROVIDER_FATAL",
});

/** kind → 错误码; 未知/缺失 kind 兜底 LLM_FAILED(fail-closed, 不猜测)。 */
export function llmErrorCode(kind: string | undefined): string {
  return LLM_ERROR_CODES[kind as StepErrorKind] ?? "LLM_FAILED";
}
