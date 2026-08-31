// @novelcraft/dsh · LLM Provider 适配(DshProvider)。
// seam 契约(packages/novelcraft/README.md): llm-step 的 Provider 接口在挂载阶段
// 以 ctx.llm 实现 —— complete(req) 内部转 DSH ctx.llm.stream 调用;
// model/temperature 取自 ResolvedPolicy(.assistant/llm.yml, 由调用方经
// StepRequest.overrides 传入, 本适配器不重复读文件)。
// 依据: 设计文档 §12/§22.5(llm_step 直连 ctx.llm, 无内部桥)、D14(无隐私模式,
// 原文直通 —— 本适配器只转发, 不落盘、不记录正文)。
// 审查项 6: 取消三条路径(finish aborted / adapter AbortError / signal abort)统一抛
// name=AbortError + retryable=false, llm-step 对其零重试(provider 前 fail-closed)。
import { createUserMessage, LlmError, type LlmRuntime } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmFailure,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Provider, ProviderRequest, ProviderResponse } from '@novelcraft/llm-step';
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
  (err as Error & { retryable: boolean; code?: string }).retryable = retryable;
  (err as Error & { code?: string }).code = failure.code;
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
    const messages: Message[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') {
        system = system === undefined ? m.content : `${system}\n\n${m.content}`;
        continue;
      }
      messages.push(
        createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'plugin', plugin: sourcePlugin },
        }) as Message,
      );
    }

    const options: GenerateOptions = {
      // 请求级 provider 覆盖优先(N20 预设卡); 缺省 = Config.llm.provider。
      provider: req.provider ?? provider,
      model: req.model ?? this.opts.model ?? '',
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    };

    let text = '';
    let usage: TokenUsage | undefined;
    let failure: LlmFailure | undefined;
    let aborted = false;
    try {
      for await (const chunk of llm.stream(options) as AsyncIterable<StreamChunk>) {
        switch (chunk.type) {
          case 'text-delta':
            text += chunk.text;
            break;
          case 'usage':
            usage = chunk.usage;
            break;
          case 'finish':
            // 审查项 6: finish aborted(适配器抛错经 dsh-llm 流协议转 terminal finish,
            // signal abort 或 failure.code==='ABORTED' → kind 'aborted')单独记取消;
            // kind 'error' 仍走 mapFailure 可重试分类。
            if (chunk.reason.kind === 'aborted') {
              aborted = true;
              failure = chunk.reason.failure;
            } else if (chunk.reason.kind === 'error') {
              failure = chunk.reason.failure;
            }
            break;
          default:
            break;
        }
      }
    } catch (err) {
      // LlmRuntime 之外的中间件/消费方错误仍然抛出; 取消/中止类(adapter AbortError、
      // LlmError ABORTED 码)统一映射为 AbortError, 其余 LlmError 走 mapFailure 分类。
      if (err instanceof LlmError) {
        if (err.failure.code === 'ABORTED') {
          throw abortError(`调用已被取消(aborted): ${err.failure.message}`);
        }
        throw mapFailure(err.failure);
      }
      if (isAbortError(err)) {
        throw abortError('调用已被取消(aborted)');
      }
      throw err;
    }
    // 审查项 6: 三条取消路径(finish aborted / adapter AbortError / signal abort)统一
    // 抛 name=AbortError + retryable=false —— 不返回半截文本、不产生「假成功」,
    // llm-step classifyError 对其零重试(provider 前 fail-closed)。
    if (aborted) {
      throw abortError(
        failure ? `调用已被取消(aborted): ${failure.code} ${failure.message}` : '调用已被取消(aborted)',
      );
    }
    if (failure) {
      throw mapFailure(failure);
    }
    // P2 修复: 调用因 signal abort 提前结束(流已消费完但信号已 abort, 如 wall-clock
    // 超时掐断)→ 视为取消(AbortError, 不可重试), 而非返回半截文本 ——
    // trace(provider 层 llm_step ok:false)与 runStep 超时语义对齐, 不产生「假成功」。
    if (req.signal?.aborted) {
      throw abortError('调用已被取消(aborted)');
    }
    return {
      text,
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : undefined,
    };
  }
}
