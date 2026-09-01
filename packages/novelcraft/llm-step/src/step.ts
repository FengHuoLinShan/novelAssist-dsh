// runStep 主流程(R2 核心): spec 解析 → 预算守卫 → provider 调用(超时/重试分类)
// → 输出 schema 校验(修复重试)→ journal 组装。
// 依据: 设计文档 §12(llm_step 原语契约: 必须带 output_schema/预算/超时/journal)。
// N34/ADR-0023 §6(独立审查 P2 修复): 执行默认合并链改为
//   spec 默认 < provider.executionDefaults < 请求 overrides
// —— provider 可携带执行画像默认(DSH 组合面附着), 内部裸 runStep(provider, req)
//   无需逐调用点改签名/散写常量即继承 timeout/maxTokens/temperature/top_p/model;
//   显式 undefined 判断(temperature=0 等合法零值不被默认吞掉)。
import { estimateTokens, type WorkflowBudget } from "./budget.js";
import { composeSystemPrompt, outputSchemaHash, promptHash } from "./prompt-body.js";
import { loadSpec } from "./specs.js";
import type { LlmStepSpec, Provider, ProviderCallReceipt, ProviderFinishReason, ProviderOutcome, ProviderResponse, ProviderTextStatus, StepEffectiveParams, StepErrorKind, StepPromptFingerprint, StepRequest, StepResult, Usage } from "./types.js";
import { validateSchema } from "./validator.js";

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** 与 wall-clock 超时竞速: 超时先到则 abort controller 并以 timedOut 返回。
 * 即使 task 忽略 signal 或永不 settle, 调用方也能在 ms 内拿到结果(超时契约)。
 * task 的迟到 settle 已被 race 与显式 catch 观察, 不产生未处理 rejection;
 * timer 在 finally 中清理, 不泄漏。 */
async function raceWithTimeout<T>(
  task: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 显式观察 task 的迟到 rejection(如超时之后 provider 才 reject), 避免未处理 rejection
  task.catch(() => {});
  try {
    return await Promise.race([
      task.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ timedOut: true });
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function classifyError(err: unknown): { retryable: boolean; message: string } {
  const e = err as Error & { retryable?: boolean; code?: string };
  // Abort identity is terminal and outranks adapter-provided retryable metadata.
  if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
    return { retryable: false, message: e.message };
  }
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

function withCallReceipt(
  base: StepEffectiveParams,
  receipt: ProviderCallReceipt,
): StepEffectiveParams {
  return {
    ...base,
    provider: receipt.provider,
    model: receipt.model,
    ...(receipt.requestedEffort !== undefined ? { requested_effort: receipt.requestedEffort } : {}),
    ...(receipt.effectiveEffort !== undefined ? { effective_effort: receipt.effectiveEffort } : {}),
    effort_source: receipt.effortSource,
    context_window_status: receipt.contextWindowKnown ? "known" : "unknown",
    ...(receipt.contextWindow !== undefined ? { context_window: receipt.contextWindow } : {}),
    ...(receipt.effectiveMaxTokens !== undefined ? { maxTokens: receipt.effectiveMaxTokens } : {}),
    ...(receipt.maxTokensSource !== undefined ? { max_tokens_source: receipt.maxTokensSource } : {}),
    ...(receipt.admissionStatus !== undefined ? { admission_status: receipt.admissionStatus } : {}),
    ...(receipt.estimatedInputTokens !== undefined
      ? { estimated_input_tokens: receipt.estimatedInputTokens }
      : {}),
    ...(receipt.outputReserveTokens !== undefined
      ? { output_reserve_tokens: receipt.outputReserveTokens }
      : {}),
    ...(receipt.effectiveCallFingerprint !== undefined
      ? { effective_call_fingerprint: receipt.effectiveCallFingerprint }
      : {}),
  };
}

function responseFacts(resp: ProviderResponse): {
  finishReason: ProviderFinishReason;
  textStatus: ProviderTextStatus;
  providerOutcome: ProviderOutcome;
  failure?: { kind: StepErrorKind; message: string };
} {
  const finishReason = resp.finishReason ?? "missing";
  const textStatus = resp.textStatus ?? (resp.text.trim().length > 0 ? "present" : "empty");
  if (finishReason === "missing") {
    return { finishReason, textStatus, providerOutcome: "protocol_error", failure: { kind: "protocol_error", message: "provider stream 缺少 terminal finish" } };
  }
  if (finishReason === "max-tokens") {
    return { finishReason, textStatus, providerOutcome: "truncated", failure: { kind: "truncated", message: "模型输出达到 max-tokens，结果不完整" } };
  }
  if (finishReason === "tool-calls") {
    return { finishReason, textStatus, providerOutcome: "unexpected_tool_calls", failure: { kind: "unexpected_tool_calls", message: "内容步骤未配置工具，却收到 tool-calls" } };
  }
  if (finishReason === "aborted") {
    return { finishReason, textStatus, providerOutcome: "cancelled", failure: { kind: "cancelled", message: "模型调用已取消" } };
  }
  if (finishReason === "error") {
    return { finishReason, textStatus, providerOutcome: "provider_error", failure: { kind: "provider_fatal", message: "provider 以 error 终止" } };
  }
  if (finishReason !== "stop") {
    return { finishReason, textStatus, providerOutcome: "protocol_error", failure: { kind: "protocol_error", message: `未知 finish reason: ${String(finishReason)}` } };
  }
  if (textStatus !== "present") {
    return { finishReason, textStatus, providerOutcome: "empty_response", failure: { kind: "empty_response", message: "模型返回空 visible text" } };
  }
  return { finishReason, textStatus, providerOutcome: "success" };
}

interface ThrownProviderFacts {
  callReceipt?: ProviderCallReceipt;
  finishReason?: ProviderFinishReason;
  textStatus?: ProviderTextStatus;
  providerOutcome?: ProviderOutcome;
  usage?: Usage;
  providerFailureCode?: string;
  code?: string;
}

/**
 * runStep 可选参数(加法, 不破坏既有调用面)。
 */
export interface RunStepOptions {
  /**
   * 工作流累计预算 guard seam(N34 workflowBudget): 传入后每次调用占用
   * 估算输入 + 输出上限; 累计超支 → 在 provider 前 budget_exceeded(fail-closed)。
   * 由编排启动时按 ExecutionProfile.workflowBudget 创建(createWorkflowBudget)。
   */
  budget?: WorkflowBudget;
}

/** 显式 undefined 判断的默认合并: o ?? d ?? spec(合法零值不吞)。 */
export async function runStep(provider: Provider, req: StepRequest, options?: RunStepOptions): Promise<StepResult> {
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

  // M10-A2/A3(N38): system 提示一次组装(promptBody 优先 + 输出契约文本注入),
  // 指纹进 journal 与 StepResult —— 模型可见⟺可回放。fix 重试只追加 user 消息,
  // system 不随 attempt 变化。
  const composed = composeSystemPrompt(spec);
  const sysHash = promptHash(composed.text);
  const fingerprint: StepPromptFingerprint = {
    systemPromptHash: sysHash,
    schemaInjection: composed.schemaInjection,
    outputSchemaHash: outputSchemaHash(spec),
  };

  // N34/ADR-0023 §6 合并链: spec 默认 < provider.executionDefaults < 请求 overrides。
  const d = provider.executionDefaults;
  const overrides = req.overrides ?? {};
  const maxTokens = overrides.maxTokens ?? d?.maxTokens ?? spec.budgetTokens;
  // maxTokens 只表示输出预留，不再兼任 raw input 上限。完整 system/messages +
  // prepared output reserve/contextWindow 的 admission 由真实 Provider seam 完成。
  const estimatedInput = estimateTokens(req.input);

  // 工作流累计预算 guard seam: 在 provider 前按「真实输入成本(含 system 提示估算,
  // N39)+ 输出上限」占用 —— N38 注入后 json spec 的 system 含完整 JSON Schema 文本,
  // 累计口径按实际发给模型的内容估算, 不系统性低估。超支 → budget_exceeded
  // (不产生新的 provider 成本)。fix 重试不重复占用(输出上限只按首次口径)。
  const workflowBudget = options?.budget ?? provider.workflowBudget;
  const spendEstimate =
    estimatedInput + estimateTokens(composed.text) + (maxTokens > 0 ? maxTokens : 0);
  if (workflowBudget && !workflowBudget.trySpend(spendEstimate)) {
    return fail(
      spec,
      req,
      "budget_exceeded",
      `工作流累计预算不足(剩余 ${workflowBudget.remaining} tokens, 本次需 ${spendEstimate}(含 system 提示估算))`,
      [],
      { inputTokens: estimatedInput, outputTokens: 0 },
      fingerprint,
    );
  }

  const timeoutMs = overrides.timeoutMs ?? d?.timeoutMs ?? spec.timeoutMs;
  const temperature = overrides.temperature ?? d?.temperature ?? spec.temperature;
  const top_p = overrides.top_p ?? d?.top_p; // 审查项 4: core strict 参数面支持(零值不被吞)
  const model = overrides.model ?? d?.model;
  const providerRoute = overrides.provider ?? d?.provider;
  const reasoningEffort = overrides.reasoning_effort ?? d?.reasoning_effort;
  const fixAttempts = req.fixAttempts ?? 1;

  // M10-A6(N38): 合并链终值的生效参数回执(spec < provider.executionDefaults <
  // 请求 overrides), 成功与失败均携带; 未定字段省略, 不含输入正文与 Key。
  const effective: StepEffectiveParams = {
    ...(providerRoute !== undefined ? { provider: providerRoute } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { requested_effort: reasoningEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  let latestEffective = effective;

  const journal: StepResult["journal"] = [];
  // journal 统一入口: 每条 attempt 记录附模型可见指纹(promptHash + 注入模式, N38)。
  const pushEntry = (entry: StepResult["journal"][number]) => {
    journal.push({ ...entry, promptHash: sysHash, schemaInjection: composed.schemaInjection });
  };
  let lastUsage: Usage = { inputTokens: estimatedInput, outputTokens: 0 };
  // 跟踪最后一次失败类型: 尝试耗尽时按此分类(schema 耗尽 → schema_violation;
  // retryable provider 耗尽 → provider_retryable + 最后 message)
  let lastFailure: { kind: "schema_violation" | "provider_retryable"; message: string } | undefined;
  const deadline = Date.now() + timeoutMs;

  // 首次调用 + 最多 fixAttempts 次修复重试
  const attempts = 1 + fixAttempts;
  for (let i = 0; i < attempts; i++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const remaining = Math.max(1, deadline - Date.now());
    if (remaining <= 1) {
      pushEntry({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        errorKind: "timeout", errorMessage: "预算超时(重试前已耗尽)",
      });
      return fail(spec, req, "timeout", "timeout", journal, lastUsage, fingerprint, latestEffective);
    }
    const controller = new AbortController();

    try {
      const messages = [
        { role: "system" as const, content: composed.text },
        { role: "user" as const, content: req.input },
      ];
      if (i > 0 && lastFailure?.kind === "schema_violation") {
        // 修复重试: 注入上次错误信息
        messages.push({
          role: "user" as const,
          content: `上次输出未通过校验, 请修正后重新输出合法 JSON。`,
        });
      }
      // wall-clock 兜底: 与 provider promise 竞速。即使 provider 忽略 signal 或
      // 永不 settle, 超时也必定返回 error.kind='timeout'(R2 超时契约)。
      const outcome = await raceWithTimeout(
        provider.complete({
          messages,
          promptHash: sysHash,
          schemaInjection: composed.schemaInjection,
          ...(providerRoute !== undefined ? { provider: providerRoute } : {}),
          model,
          ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
          temperature,
          top_p,
          maxTokens: maxTokens || undefined,
          signal: controller.signal,
        }),
        remaining,
        controller,
      );
      if (outcome.timedOut) {
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "timeout", errorMessage: "超时",
        });
        return fail(spec, req, "timeout", "timeout", journal, lastUsage, fingerprint, latestEffective);
      }
      const resp = outcome.value;
      lastUsage = resp.usage ?? lastUsage;
      if (resp.callReceipt !== undefined) {
        latestEffective = withCallReceipt(effective, resp.callReceipt);
      }
      const facts = responseFacts(resp);
      const receiptFields = {
        outputChars: resp.text.length,
        ...(resp.text.length > 0 ? { outputTextHash: promptHash(resp.text) } : {}),
        ...(resp.usage !== undefined ? { usage: resp.usage } : {}),
        finishReason: facts.finishReason,
        textStatus: facts.textStatus,
        providerOutcome: facts.providerOutcome,
        ...(resp.callReceipt !== undefined ? { callReceipt: resp.callReceipt } : {}),
      };
      if (facts.failure !== undefined) {
        pushEntry({
          attempt: i + 1,
          startedAt,
          durationMs: Date.now() - t0,
          ...receiptFields,
          errorKind: facts.failure.kind,
          errorMessage: facts.failure.message,
        });
        return fail(
          spec,
          req,
          facts.failure.kind,
          facts.failure.message,
          journal,
          lastUsage,
          fingerprint,
          latestEffective,
        );
      }

      if (spec.outputFormat === "text") {
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          ...receiptFields,
        });
        return {
          result: { text: resp.text },
          journal,
          usage: lastUsage,
          ok: true,
          specRef: spec.specRef,
          contractVersion: spec.contractVersion,
          promptFingerprint: fingerprint,
          effective: latestEffective,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(resp.text));
      } catch {
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          ...receiptFields,
          errorKind: "schema_violation", errorMessage: "输出不是合法 JSON",
        });
        lastFailure = { kind: "schema_violation", message: "输出不是合法 JSON" };
        continue;
      }
      const issues = validateSchema(spec.outputSchema, parsed);
      if (issues.length > 0) {
        const issueMsg = issues.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join("; ");
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          ...receiptFields,
          errorKind: "schema_violation",
          errorMessage: issueMsg,
        });
        lastFailure = { kind: "schema_violation", message: issueMsg };
        continue;
      }
      pushEntry({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        ...receiptFields,
      });
      return {
        result: parsed,
        journal,
        usage: lastUsage,
        ok: true,
        specRef: spec.specRef,
        contractVersion: spec.contractVersion,
        promptFingerprint: fingerprint,
        effective: latestEffective,
      };
    } catch (err) {
      const thrown = (err ?? {}) as ThrownProviderFacts;
      const errorReceipt = thrown.callReceipt;
      if (errorReceipt !== undefined) latestEffective = withCallReceipt(effective, errorReceipt);
      if (thrown.usage !== undefined) lastUsage = thrown.usage;
      const errorReceiptFields = {
        ...(thrown.usage !== undefined ? { usage: thrown.usage } : {}),
        ...(thrown.finishReason !== undefined ? { finishReason: thrown.finishReason } : {}),
        ...(thrown.textStatus !== undefined ? { textStatus: thrown.textStatus } : {}),
        ...(thrown.providerOutcome !== undefined ? { providerOutcome: thrown.providerOutcome } : {}),
        ...(thrown.providerFailureCode !== undefined
          ? { providerFailureCode: thrown.providerFailureCode }
          : {}),
        ...(errorReceipt !== undefined ? { callReceipt: errorReceipt } : {}),
      };
      if (controller.signal.aborted) {
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "timeout", errorMessage: "超时",
          ...errorReceiptFields,
        });
        return fail(spec, req, "timeout", "timeout", journal, lastUsage, fingerprint, latestEffective);
      }
      const typedKind = thrown.providerOutcome === "cancelled" || (err as Error | undefined)?.name === "AbortError"
        ? "cancelled"
        : thrown.providerOutcome === "context_overflow" || thrown.code === "CONTEXT_WINDOW_EXCEEDED"
          ? "context_overflow"
          : thrown.providerOutcome === "protocol_error"
            ? "protocol_error"
            : undefined;
      if (typedKind !== undefined) {
        const message = (err as Error | undefined)?.message ?? typedKind;
        pushEntry({
          attempt: i + 1,
          startedAt,
          durationMs: Date.now() - t0,
          errorKind: typedKind,
          errorMessage: message,
          ...errorReceiptFields,
        });
        return fail(spec, req, typedKind, message, journal, lastUsage, fingerprint, latestEffective);
      }
      const { retryable, message } = classifyError(err);
      if (!retryable) {
        pushEntry({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "provider_fatal", errorMessage: message,
          ...errorReceiptFields,
        });
        return fail(spec, req, "provider_fatal", message, journal, lastUsage, fingerprint, latestEffective);
      }
      pushEntry({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        errorKind: "provider_retryable", errorMessage: message,
        ...errorReceiptFields,
      });
      lastFailure = { kind: "provider_retryable", message };
      // 继续重试(受 attempts 与 deadline 双限)
    }
  }

  // 尝试耗尽: 按最后一次失败分类。schema 解析/校验耗尽 → schema_violation;
  // retryable provider 耗尽 → provider_retryable + 最后 message(而非固定 schema_violation)。
  if (lastFailure?.kind === "provider_retryable") {
    return fail(spec, req, "provider_retryable", lastFailure.message, journal, lastUsage, fingerprint, latestEffective);
  }
  return fail(spec, req, "schema_violation", `经 ${attempts} 次尝试仍未通过输出校验`, journal, lastUsage, fingerprint, latestEffective);
}

function fail(
  spec: LlmStepSpec,
  _req: StepRequest,
  kind: StepErrorKind,
  message: string,
  journal: StepResult["journal"],
  usage: StepResult["usage"],
  fingerprint?: StepPromptFingerprint,
  effective?: StepEffectiveParams,
): StepResult {
  return {
    result: null,
    journal,
    usage,
    ok: false,
    error: { kind, message },
    specRef: spec.specRef,
    contractVersion: spec.contractVersion,
    ...(fingerprint !== undefined ? { promptFingerprint: fingerprint } : {}),
    ...(effective !== undefined ? { effective } : {}),
  };
}

export { estimateTokens };
