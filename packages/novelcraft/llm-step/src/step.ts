// runStep 主流程(R2 核心): spec 解析 → 预算守卫 → provider 调用(超时/重试分类)
// → 输出 schema 校验(修复重试)→ journal 组装。
// 依据: 设计文档 §12(llm_step 原语契约: 必须带 output_schema/预算/超时/journal)。
// N34/ADR-0023 §6(独立审查 P2 修复): 执行默认合并链改为
//   spec 默认 < provider.executionDefaults < 请求 overrides
// —— provider 可携带执行画像默认(DSH 组合面附着), 内部裸 runStep(provider, req)
//   无需逐调用点改签名/散写常量即继承 timeout/maxTokens/temperature/top_p/model;
//   显式 undefined 判断(temperature=0 等合法零值不被默认吞掉)。
import { checkBudget, estimateTokens, type WorkflowBudget } from "./budget.js";
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

  // N34/ADR-0023 §6 合并链: spec 默认 < provider.executionDefaults < 请求 overrides。
  const d = provider.executionDefaults;
  const overrides = req.overrides ?? {};
  const maxTokens = overrides.maxTokens ?? d?.maxTokens ?? spec.budgetTokens;
  const budget = checkBudget(req.input, maxTokens);
  if (!budget.allowed) {
    return fail(spec, req, "budget_exceeded", `输入估算 ${budget.estimatedInput} tokens 超过预算 ${maxTokens}`, [], { inputTokens: budget.estimatedInput, outputTokens: 0 });
  }

  // 工作流累计预算 guard seam: 在 provider 前按「估算输入 + 输出上限」占用,
  // 超支 → budget_exceeded(不产生新的 provider 成本)。fix 重试不重复占用
  // (输出上限只按首次调用口径, 保守为一次)。
  const workflowBudget = options?.budget ?? provider.workflowBudget;
  if (workflowBudget && !workflowBudget.trySpend(budget.estimatedInput + (maxTokens > 0 ? maxTokens : 0))) {
    return fail(
      spec,
      req,
      "budget_exceeded",
      `工作流累计预算不足(剩余 ${workflowBudget.remaining} tokens, 本次需 ${budget.estimatedInput + (maxTokens > 0 ? maxTokens : 0)})`,
      [],
      { inputTokens: budget.estimatedInput, outputTokens: 0 },
    );
  }

  const timeoutMs = overrides.timeoutMs ?? d?.timeoutMs ?? spec.timeoutMs;
  const temperature = overrides.temperature ?? d?.temperature ?? spec.temperature;
  const top_p = overrides.top_p ?? d?.top_p; // 审查项 4: core strict 参数面支持(零值不被吞)
  const model = overrides.model ?? d?.model;
  const providerRoute = overrides.provider ?? d?.provider;
  const fixAttempts = req.fixAttempts ?? 1;

  const journal: StepResult["journal"] = [];
  let lastUsage = { inputTokens: budget.estimatedInput, outputTokens: 0 };
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
      journal.push({
        attempt: i + 1, startedAt, durationMs: Date.now() - t0,
        errorKind: "timeout", errorMessage: "预算超时(重试前已耗尽)",
      });
      return fail(spec, req, "timeout", "timeout", journal, lastUsage);
    }
    const controller = new AbortController();

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
      // wall-clock 兜底: 与 provider promise 竞速。即使 provider 忽略 signal 或
      // 永不 settle, 超时也必定返回 error.kind='timeout'(R2 超时契约)。
      const outcome = await raceWithTimeout(
        provider.complete({
          messages,
          ...(providerRoute !== undefined ? { provider: providerRoute } : {}),
          model,
          temperature,
          top_p,
          maxTokens: maxTokens || undefined,
          signal: controller.signal,
        }),
        remaining,
        controller,
      );
      if (outcome.timedOut) {
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          errorKind: "timeout", errorMessage: "超时",
        });
        return fail(spec, req, "timeout", "timeout", journal, lastUsage);
      }
      const resp = outcome.value;
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
        lastFailure = { kind: "schema_violation", message: "输出不是合法 JSON" };
        continue;
      }
      const issues = validateSchema(spec.outputSchema, parsed);
      if (issues.length > 0) {
        const issueMsg = issues.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join("; ");
        journal.push({
          attempt: i + 1, startedAt, durationMs: Date.now() - t0,
          providerText: resp.text.slice(0, 200),
          errorKind: "schema_violation",
          errorMessage: issueMsg,
        });
        lastFailure = { kind: "schema_violation", message: issueMsg };
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
      lastFailure = { kind: "provider_retryable", message };
      // 继续重试(受 attempts 与 deadline 双限)
    }
  }

  // 尝试耗尽: 按最后一次失败分类。schema 解析/校验耗尽 → schema_violation;
  // retryable provider 耗尽 → provider_retryable + 最后 message(而非固定 schema_violation)。
  if (lastFailure?.kind === "provider_retryable") {
    return fail(spec, req, "provider_retryable", lastFailure.message, journal, lastUsage);
  }
  return fail(spec, req, "schema_violation", `经 ${attempts} 次尝试仍未通过输出校验`, journal, lastUsage);
}

function fail(
  spec: LlmStepSpec,
  _req: StepRequest,
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
