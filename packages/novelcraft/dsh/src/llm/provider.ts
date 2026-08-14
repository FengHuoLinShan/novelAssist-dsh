// @novelcraft/dsh · LLM Provider 适配(DshProvider)。
// seam 契约(packages/novelcraft/README.md): llm-step 的 Provider 接口在挂载阶段
// 以 ctx.llm 实现 —— complete(req) 内部转 DSH ctx.llm.stream 调用;
// model/temperature 取自 ResolvedPolicy(.assistant/llm.yml, 由调用方经
// StepRequest.overrides 传入, 本适配器不重复读文件)。
// 依据: 设计文档 §12/§22.5(llm_step 直连 ctx.llm, 无内部桥)、D14(无隐私模式,
// 原文直通 —— 本适配器只转发, 不落盘、不记录正文)。
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

/**
 * llm-step Provider 的 DSH 实现: 每次 complete 组装一次 GenerateOptions,
 * 把 system 消息放进 system 槽、user/assistant 消息转 dsh-llm Message,
 * 消费块流拼装文本, usage 块透传, error/aborted 终止映射为可分类错误。
 */
export class DshProvider implements Provider {
  private readonly opts: DshProviderOptions;

  constructor(opts: DshProviderOptions) {
    this.opts = opts;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const { ctx, provider } = this.opts;
    const sourcePlugin = this.opts.sourcePlugin ?? '@novelcraft/dsh';

    const llm = svc<LlmRuntime>(ctx, 'llm');
    if (!llm) {
      const err = new Error('DSH llm 服务不可用(profile 未挂载 llm)');
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
      provider,
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
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              failure = chunk.reason.failure;
            }
            break;
          default:
            break;
        }
      }
    } catch (err) {
      // LlmRuntime 之外的中间件/消费方错误仍然抛出; LlmError 直接带分类。
      if (err instanceof LlmError) {
        throw mapFailure(err.failure);
      }
      throw err;
    }
    if (failure) {
      throw mapFailure(failure);
    }
    return {
      text,
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : undefined,
    };
  }
}
