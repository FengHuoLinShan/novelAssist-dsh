// runStep 主流程(R2 核心): spec 解析 → 预算守卫 → provider 调用(超时/重试分类)
// → 输出 schema 校验(修复重试)→ journal 组装。
// 依据: 设计文档 §12(llm_step 原语契约: 必须带 output_schema/预算/超时/journal)。
import { checkBudget, estimateTokens } from "./budget.js";
import { loadSpec } from "./specs.js";
import type { LlmStepSpec, Provider, StepErrorKind, StepRequest, StepResult } from "./types.js";
import { validateSchema } from "./validator.js";

function systemPromptFor(spec: LlmStepSpec): string {
  return [
    `你是 NovelCraft 内容手。任务: ${spec.description}`,
    `输入资料要求: ${spec.inputNotes}`,
    "输出必须是合法 JSON, 严格符合给定的 JSON Schema, 不得输出额外文字。",
    `降级条款(供上层决策, 不由你执行): ${spec.degradationNote}`,
  ].join("\n");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function classifyError(err: unknown): { retryable: boolean; message: string } {
  const e = err as Error & { retryable?: boolean; code?: string };
  if (typeof e?.retryable === "boolean") {
    return { retryable: e.retryable, message: e.message };
  }
  // 网络/超时类代码按可重试处理; 其余 fatal
  const msg = String(e?.message ?? e ?? "unknown");
  if (/ECONN|ETIMEDOUT|network|fetch|abort|rate.?limit|429|5\d\d/i.test(msg)) {
    return { retryable: true, message: msg };
  }
  return { retryable: false, message: msg };
}

export async function runStep(provider: Provider, req: StepRequest): Promise<StepResult> {
  const spec = loadSpec(req.specRef);
  if (!spec) {
    return {
      result: null,
      journal: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      ok: false,
      error: { kind: "spec_not_found", message: `spec 不存在: ${req.specRef}` },
      specRef: req.specRef,
      contractVersion: "unknown",
    };
  }

  const overrides = req.overrides ?? {};
  const maxTokens = overrides.maxTokens ?? spec.budgetTokens;
  const budget = checkBudget(req.input, maxTokens);
  if (!budget.allowed) {
    return fail(spec, req, "budget_exceeded", `输入估算 ${budget.estimatedInput} tokens 超过预算 ${maxTokens}`, [], { inputTokens: budget.estimatedInput, outputTokens: 0 });
  }

  const timeoutMs = overrides.timeoutMs ?? spec.timeoutMs;
  const temperature = overrides.temperature ?? spec.temperature;
  const model = overrides.model;
  const providerRoute = overrides.provider;
  const fixAttempts = req.fixAttempts ?? 1;

  const journal: StepResult["journal"] = [];
  let lastText = "";
  let lastUsage = { inputTokens: budget.estimatedInput, outputTokens: 0 };
  const deadline = Date.now() + timeoutMs;

  // 首次调用 + 最多 fixAttempts 次修复重试
  const attempts = 1 + fixAttempts;
  for (let i = 0; i < attempts; i++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const remaining = Math.max(1, deadline - Date.now());
    if (remaining <= 1) {
      journal.push({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        errorKind: "timeout", errorMessage: "预算超时(重试前已耗尽)",
      });
      return fail(spec, req, "timeout", "timeout", journal, lastUsage);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const messages = [
        { role: "system" as const, content: systemPromptFor(spec) },
        { role: "user" as const, content: req.input },
      ];
      if (i > 0) {
        // 修复重试: 注入上次错误信息
        messages.push({
          role: "user" as const,
          content: `上次输出未通过校验, 请修正后重新输出合法 JSON。`,
        });
      }
      const resp = await provider.complete({
        messages,
        ...(providerRoute !== undefined ? { provider: providerRoute } : {}),
        model,
        temperature,
        maxTokens: maxTokens || undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastText = resp.text;
      lastUsage = resp.usage ?? lastUsage;

      if (spec.outputFormat === "text") {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          providerText: resp.text.slice(0, 200), usage: lastUsage,
        });
        return {
          result: { text: resp.text },
          journal,
          usage: lastUsage,
          ok: true,
          specRef: spec.specRef,
          contractVersion: spec.contractVersion,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(resp.text));
      } catch {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          providerText: resp.text.slice(0, 200),
          errorKind: "schema_violation", errorMessage: "输出不是合法 JSON",
        });
        continue;
      }
      const issues = validateSchema(spec.outputSchema, parsed);
      if (issues.length > 0) {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          providerText: resp.text.slice(0, 200),
          errorKind: "schema_violation",
          errorMessage: issues.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join("; "),
        });
        continue;
      }
      journal.push({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        providerText: resp.text.slice(0, 200), usage: lastUsage,
      });
      return {
        result: parsed,
        journal,
        usage: lastUsage,
        ok: true,
        specRef: spec.specRef,
        contractVersion: spec.contractVersion,
      };
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "timeout", errorMessage: "超时",
        });
        return fail(spec, req, "timeout", "timeout", journal, lastUsage);
      }
      const { retryable, message } = classifyError(err);
      if (!retryable) {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "provider_fatal", errorMessage: message,
        });
        return fail(spec, req, "provider_fatal", message, journal, lastUsage);
      }
      journal.push({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        errorKind: "provider_retryable", errorMessage: message,
      });
      // 继续重试(受 attempts 与 deadline 双限)
    }
  }

  return fail(spec, req, "schema_violation", `经 ${attempts} 次尝试仍未通过输出校验`, journal, lastUsage);
}

function fail(
  spec: LlmStepSpec,
  req: StepRequest,
  kind: StepErrorKind,
  message: string,
  journal: StepResult["journal"],
  usage: StepResult["usage"],
): StepResult {
  return {
    result: null,
    journal,
    usage,
    ok: false,
    error: { kind, message },
    specRef: spec.specRef,
    contractVersion: spec.contractVersion,
  };
}

export { estimateTokens };
