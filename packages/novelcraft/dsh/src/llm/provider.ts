// @novelcraft/dsh · LLM Provider 适配(DshProvider)。
// seam 契约(packages/novelcraft/README.md): llm-step 的 Provider 接口在挂载阶段
// 以 ctx.llm 实现 —— complete(req) 内部转 DSH ctx.llm.stream 调用;
// model/temperature 取自 ResolvedPolicy(.assistant/llm.yml, 由调用方经
// StepRequest.overrides 传入, 本适配器不重复读文件)。
// 依据: 设计文档 §12/§22.5(llm_step 直连 ctx.llm, 无内部桥)、D14(无隐私模式,
// 原文直通 —— 本适配器只转发, 不落盘、不记录正文)。
// 审查项 6: 取消三条路径(finish aborted / adapter AbortError / signal abort)统一抛
// name=AbortError + retryable=false, llm-step 对其零重试(provider 前 fail-closed)。
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createAssistantMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmCallConfig,
  LlmFailure,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import {
  estimateTokens,
  promptHash,
  type Provider,
  type ProviderCallReceipt,
  type ProviderCallWarning,
  type ProviderFinishReason,
  type ProviderOutcome,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTextStatus,
  type Usage,
} from '@novelcraft/llm-step';
import { svc } from '../ctx.js';

export interface DshProviderOptions {
  /** 已挂载 llm 服务的 Cordis 上下文 */
  ctx: Context;
  /** 默认 provider 路由(Config.llm.provider) */
  provider: string;
  /** 默认模型 id(Config.llm.model); 调用方 overrides.model 优先 */
  model?: string;
  /** 消息来源标识(进 session log 的 provenance) */
  sourcePlugin?: string;
}

/** 流终止原因带失败详情时, 把 LlmFailure 映射为可重试分类(retryable 供 llm-step classifyError)。 */
function mapFailure(failure: LlmFailure): Error {
  const retryable =
    failure.code === 'RATE_LIMIT' ||
    failure.code === 'OVERLOADED' ||
    /5\d\d|timeout|network|ECONN|ETIMEDOUT/i.test(`${failure.code ?? ''} ${failure.message ?? ''}`);
  const err = new Error(`DSH llm 调用失败: ${failure.code ?? 'UNKNOWN'} ${failure.message ?? ''}`);
  Object.assign(err, {
    retryable,
    code: failure.code,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.providerRetryAfterMs !== undefined
      ? { providerRetryAfterMs: failure.providerRetryAfterMs }
      : {}),
    ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
  });
  return err;
}

/** 审查项 6: 统一取消错误 —— name=AbortError + retryable=false(llm-step classifyError 零重试)。 */
function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  (err as Error & { retryable?: boolean }).retryable = false;
  return err;
}

/** 判断抛出的错误是否属「取消/中止」(adapter AbortError / LlmError ABORTED 码)。 */
function isAbortError(err: unknown): boolean {
  if (err instanceof LlmError) return err.failure.code === 'ABORTED';
  return (err as Error | undefined)?.name === 'AbortError';
}

interface ProviderErrorFacts {
  callReceipt?: ProviderCallReceipt;
  finishReason?: ProviderFinishReason;
  textStatus?: ProviderTextStatus;
  providerOutcome?: ProviderOutcome;
  usage?: Usage;
  providerFailureCode?: string;
}

function attachProviderFacts(err: Error, facts: ProviderErrorFacts): Error {
  Object.assign(err, facts);
  return err;
}

/** Estimate the exact role/content envelope handed to DSH; this is intentionally heuristic. */
function estimateFullInput(messages: ProviderRequest['messages']): number {
  const rendered = messages.map((message) => `${message.role}\n${message.content}`).join('\n\n');
  return estimateTokens(rendered) + messages.length * 4 + 2;
}

function classifyOutcome(
  finishReason: ProviderFinishReason,
  textStatus: ProviderTextStatus,
  sawToolCall: boolean,
): ProviderOutcome {
  if (finishReason === 'missing') return 'protocol_error';
  if (finishReason === 'max-tokens') return 'truncated';
  if (finishReason === 'tool-calls' || sawToolCall) return 'unexpected_tool_calls';
  if (finishReason === 'aborted') return 'cancelled';
  if (finishReason === 'error') return 'provider_error';
  if (finishReason !== 'stop') return 'protocol_error';
  return textStatus === 'present' ? 'success' : 'empty_response';
}

/**
 * llm-step Provider 的 DSH 实现: 每次 complete 组装一次 GenerateOptions,
 * 把 system 消息放进 system 槽、user/assistant 消息转 dsh-llm Message,
 * 消费块流拼装文本, usage 块透传, error 终止映射为可分类错误,
 * 取消/中止(aborted)统一抛 name=AbortError + retryable=false(审查项 6)。
 */
export class DshProvider implements Provider {
  private readonly opts: DshProviderOptions;

  constructor(opts: DshProviderOptions) {
    this.opts = opts;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    // 审查项 4: DSH llm 执行契约(GenerateOptions)明确不支持 top_p(无该字段、无等价
    // 透传面)—— 绝不静默丢弃: 请求携带 top_p 时 fail-closed 拒绝, 由编排/调用方
    // 显式感知契约缺口(错误不可重试, 在 llm.stream 之前抛出, 零 provider 成本)。
    if (req.top_p !== undefined) {
      const err = new Error(
        'DSH llm 执行契约不支持 top_p(GenerateOptions 无该字段; 契约明确不支持则 fail-closed, 不静默丢弃)',
      );
      (err as Error & { retryable: boolean }).retryable = false;
      throw err;
    }
    const { ctx, provider } = this.opts;
    const sourcePlugin = this.opts.sourcePlugin ?? '@novelcraft/dsh';

    const llm = svc<LlmRuntime>(ctx, 'llm');
    if (!llm) {
      const err = new Error('DSH llm 服务不可用(profile 未挂载 llm)');
      (err as Error & { retryable: boolean }).retryable = false;
      throw err;
    }

    // M10-A5(§6.23.6): exact-route readiness fail-closed —— 发请求前核对 provider
    // 路由已在宿主 live 目录(listProviders)注册。selected(预设/请求选定)≠ready(路由
    // 已注册可派发); dormant 可配置项未激活或路由名拼错时提前拒绝并回传 live 目录,
    // 不把请求扔进流层拿模糊错误(失败要响; 错误不可重试, 在 llm.stream 之前抛出)。
    const route = req.provider ?? provider;
    const liveRoutes = llm.listProviders().map((p) => p.id);
    if (!liveRoutes.includes(route)) {
      const err = new Error(
        `LLM provider 路由未就绪: 「${route}」不在宿主 live 目录 [${liveRoutes.join(', ') || '空'}]` +
          '(selected≠ready; 请在宿主设置连接/激活该 provider 或修正路由名)',
      );
      (err as Error & { retryable: boolean }).retryable = false;
      throw err;
    }

    let system: string | undefined;
    const conversation = req.messages.filter((message) => {
      if (message.role !== 'system') return true;
      system = system === undefined ? message.content : `${system}\n\n${message.content}`;
      return false;
    });
    const estimatedInputTokens = estimateFullInput(req.messages);

    const callConfig: LlmCallConfig = {
      provider: route,
      model: req.model ?? this.opts.model ?? '',
      ...(req.reasoning_effort !== undefined
        ? { reasoningEffort: ReasoningEffortId(req.reasoning_effort) }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    };

    let callReceipt: ProviderCallReceipt | undefined;
    try {
      const prepared = await llm.prepareCall(callConfig, req.signal);
      const outputReserveTokens = prepared.config.maxTokens;
      const warnings: ProviderCallWarning[] = [];
      if (prepared.context === undefined) warnings.push('context_window_unknown');
      if (outputReserveTokens === undefined) warnings.push('output_reserve_unknown');
      const admissionStatus = outputReserveTokens === undefined
        ? 'output_reserve_unknown'
        : prepared.context === undefined
          ? 'capacity_unknown'
          : estimatedInputTokens + outputReserveTokens > prepared.context.contextWindow
            ? 'rejected'
            : 'admitted';
      callReceipt = {
        provider: prepared.config.provider,
        model: prepared.config.model,
        ...(req.reasoning_effort !== undefined ? { requestedEffort: req.reasoning_effort } : {}),
        ...(prepared.config.reasoningEffort !== undefined
          ? { effectiveEffort: prepared.config.reasoningEffort }
          : {}),
        effortSource: req.reasoning_effort !== undefined
          ? 'request'
          : prepared.adapterDefaults.reasoningEffort
            ? 'adapter_default'
            : 'provider_default',
        ...(prepared.context !== undefined ? { contextWindow: prepared.context.contextWindow } : {}),
        contextWindowKnown: prepared.context !== undefined,
        ...(outputReserveTokens !== undefined ? { effectiveMaxTokens: outputReserveTokens } : {}),
        maxTokensSource: req.maxTokens !== undefined
          ? 'request'
          : prepared.adapterDefaults.maxTokens
            ? 'adapter_default'
            : 'provider_default',
        estimatedInputTokens,
        inputEstimator: 'novelcraft-heuristic-v1',
        ...(outputReserveTokens !== undefined ? { outputReserveTokens } : {}),
        admissionStatus,
        ...(warnings.length > 0 ? { warnings } : {}),
        effectiveCallFingerprint: promptHash(JSON.stringify([
          prepared.config.provider,
          prepared.config.model,
          prepared.config.reasoningEffort ?? null,
          prepared.config.temperature ?? null,
          prepared.config.maxTokens ?? null,
          prepared.adapterDefaults.reasoningEffort === true,
          prepared.adapterDefaults.maxTokens === true,
        ])),
      };
      if (admissionStatus === 'rejected') {
        const err = new Error(
          `完整请求估算 ${estimatedInputTokens} + 输出预留 ${outputReserveTokens} ` +
            `超过模型上下文 ${prepared.context?.contextWindow ?? 0}`,
        );
        Object.assign(err, { retryable: false, code: CONTEXT_WINDOW_EXCEEDED_CODE });
        throw attachProviderFacts(err, {
          callReceipt,
          finishReason: 'missing',
          textStatus: 'empty',
          providerOutcome: 'context_overflow',
          providerFailureCode: CONTEXT_WINDOW_EXCEEDED_CODE,
        });
      }

      const messages: Message[] = conversation.map((message) => (
        message.role === 'assistant'
          ? createAssistantMessage({
              content: [{ type: 'text', text: message.content }],
              source: { provider: prepared.config.provider, model: prepared.config.model },
            })
          : createUserMessage({
              content: [{ type: 'text', text: message.content }],
              source: { kind: 'plugin', plugin: sourcePlugin },
            })
      ));
      const options: GenerateOptions = {
        ...prepared.config,
        messages,
        ...(system !== undefined ? { system } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      };
      const assembler = new BlockAssembler();
      let sawFinish = false;
      let sawToolCall = false;
      for await (const chunk of prepared.stream(options) as AsyncIterable<StreamChunk>) {
        assembler.push(chunk);
        if (chunk.type === 'finish') sawFinish = true;
        if (chunk.type === 'tool-call-delta' ||
            (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) sawToolCall = true;
      }
      const terminal = sawFinish ? assembler.finish : undefined;
      const finishReason = (terminal?.kind ?? 'missing') as ProviderFinishReason;
      const blocks = assembler.blocks();
      const text = blocks
        .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const hasText = text.trim().length > 0;
      const textStatus: ProviderTextStatus = hasText ? 'present' : 'empty';
      const usage = assembler.usage ? { ...assembler.usage } : undefined;
      const providerOutcome = classifyOutcome(finishReason, textStatus, sawToolCall);

      if (terminal?.kind === 'aborted') {
        throw attachProviderFacts(
          abortError(`调用已被取消(aborted): ${terminal.failure.code} ${terminal.failure.message}`),
          {
            callReceipt,
            finishReason,
            textStatus: hasText ? 'discarded' : 'empty',
            providerOutcome,
            ...(usage !== undefined ? { usage } : {}),
            providerFailureCode: terminal.failure.code,
          },
        );
      }
      if (terminal?.kind === 'error') {
        throw attachProviderFacts(mapFailure(terminal.failure), {
          callReceipt,
          finishReason,
          textStatus: hasText ? 'discarded' : 'empty',
          providerOutcome,
          ...(usage !== undefined ? { usage } : {}),
          providerFailureCode: terminal.failure.code,
        });
      }
      if (req.signal?.aborted) {
        throw attachProviderFacts(abortError('调用已被取消(aborted)'), {
          callReceipt,
          finishReason: 'aborted',
          textStatus: hasText ? 'discarded' : 'empty',
          providerOutcome: 'cancelled',
          ...(usage !== undefined ? { usage } : {}),
          providerFailureCode: 'ABORTED',
        });
      }
      return {
        text,
        ...(usage !== undefined ? { usage } : {}),
        finishReason,
        textStatus,
        providerOutcome,
        callReceipt,
      };
    } catch (err) {
      // LlmRuntime 之外的中间件/消费方错误仍然抛出; 取消/中止类(adapter AbortError、
      // LlmError ABORTED 码)统一映射为 AbortError, 其余 LlmError 走 mapFailure 分类。
      if (err instanceof LlmError) {
        if (err.failure.code === 'ABORTED') {
          throw attachProviderFacts(abortError(`调用已被取消(aborted): ${err.failure.message}`), {
            callReceipt,
            finishReason: 'aborted',
            textStatus: 'discarded',
            providerOutcome: 'cancelled',
            providerFailureCode: err.failure.code,
          });
        }
        throw attachProviderFacts(mapFailure(err.failure), {
          callReceipt,
          finishReason: 'error',
          textStatus: 'discarded',
          providerOutcome: 'provider_error',
          providerFailureCode: err.failure.code,
        });
      }
      if (isAbortError(err)) {
        const facts = err as ProviderErrorFacts;
        if (facts.providerOutcome !== undefined) throw err;
        throw attachProviderFacts(abortError('调用已被取消(aborted)'), {
          callReceipt,
          finishReason: 'aborted',
          textStatus: 'discarded',
          providerOutcome: 'cancelled',
          providerFailureCode: 'ABORTED',
        });
      }
      if (err instanceof Error) {
        throw attachProviderFacts(err, {
          ...(callReceipt !== undefined ? { callReceipt } : {}),
          ...((err as ProviderErrorFacts).providerOutcome === undefined
            ? { providerOutcome: 'provider_error' as const }
            : {}),
        });
      }
      throw err;
    }
  }
}
