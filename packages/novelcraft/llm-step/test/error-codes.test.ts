// error-codes 契约: 码值稳定 + 未知 kind 兜底 fail-closed。
// 断言注释引 R2(内容手核心)/宿主 HarnessError code 通道约定。
import { describe, expect, it } from "vitest";
import { LLM_ERROR_CODES, llmErrorCode } from "../src/error-codes.js";
import type { StepErrorKind } from "../src/types.js";

describe("llm-step error-codes", () => {
  it("六种 StepErrorKind 全覆盖且码值稳定(与宿主 HarnessError code 通道逐字一致)", () => {
    expect(Object.keys(LLM_ERROR_CODES).sort()).toEqual([
      "budget_exceeded",
      "provider_fatal",
      "provider_retryable",
      "schema_violation",
      "spec_not_found",
      "timeout",
    ]);
    expect(LLM_ERROR_CODES.spec_not_found).toBe("LLM_SPEC_NOT_FOUND");
    expect(LLM_ERROR_CODES.budget_exceeded).toBe("LLM_BUDGET_EXCEEDED");
    expect(LLM_ERROR_CODES.timeout).toBe("LLM_TIMEOUT");
    expect(LLM_ERROR_CODES.schema_violation).toBe("LLM_SCHEMA_VIOLATION");
    expect(LLM_ERROR_CODES.provider_retryable).toBe("LLM_PROVIDER_RETRYABLE");
    expect(LLM_ERROR_CODES.provider_fatal).toBe("LLM_PROVIDER_FATAL");
  });

  it("未知/缺失 kind 兜底 LLM_FAILED(fail-closed, 不猜测)", () => {
    expect(llmErrorCode(undefined)).toBe("LLM_FAILED");
    expect(llmErrorCode("")).toBe("LLM_FAILED");
    expect(llmErrorCode("no_such_kind" as StepErrorKind)).toBe("LLM_FAILED");
  });

  it("已知 kind 精确映射", () => {
    expect(llmErrorCode("timeout")).toBe("LLM_TIMEOUT");
    expect(llmErrorCode("provider_fatal")).toBe("LLM_PROVIDER_FATAL");
  });
});
