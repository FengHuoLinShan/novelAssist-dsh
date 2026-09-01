// DshProvider 行为契约(seam: ctx.llm)。
// 断言引 seam 契约(packages/novelcraft/README.md「LLM 真 provider」):
// complete(req) 内部转 DSH ctx.llm 调用; system 进 system 槽;
// usage 透传; error 终止映射为可分类错误(retryable)。
// 审查项 6: 取消三条路径(finish aborted / adapter AbortError / signal abort)统一抛
// name=AbortError + retryable=false(llm-step classifyError 零重试, provider 前 fail-closed)。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { DshProvider } from '../src/index.js';
import { FakeAdapter, makeContext, type HarnessServices } from './helpers.js';

class ReasoningAdapter extends FakeAdapter {
  constructor(private readonly defaultEffort?: string) {
    super();
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
      reasoning: {
        efforts: ['off', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
        ...(this.defaultEffort !== undefined
          ? { defaultEffort: ReasoningEffortId(this.defaultEffort) }
          : {}),
      },
    };
  }
}

describe('DshProvider', () => {
  let h: HarnessServices;

  beforeEach(async () => {
    h = await makeContext();
  });

  it('组装 GenerateOptions 并把文本增量拼成响应(R2 Provider 契约)', async () => {
    h.adapter.enqueue({
      deltas: ['{"findings":', '[{"category":"c","severity":"high","quote":"q","suggestion":"s"}],', '"verdict":"ok"}'],
      usage: { inputTokens: 12, outputTokens: 34 },
    });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    const resp = await provider.complete({
      messages: [
        { role: 'system', content: '你是内容手。' },
        { role: 'user', content: '第一章正文' },
      ],
      temperature: 0.1,
      maxTokens: 100,
    });

    expect(resp.text).toBe('{"findings":[{"category":"c","severity":"high","quote":"q","suggestion":"s"}],"verdict":"ok"}');
    expect(resp.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(resp.callReceipt).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      effortSource: 'provider_default',
      contextWindowKnown: false,
    });

    const sent = h.adapter.requests[0];
    expect(sent.provider).toBe('fake');
    expect(sent.model).toBe('fake-model');
    expect(sent.temperature).toBe(0.1);
    expect(sent.maxTokens).toBe(100);
    // system 消息进 system 槽, user 消息转 dsh Message(单一 text 块)
    expect(sent.system).toBe('你是内容手。');
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'text', text: '第一章正文' });
  });

  it('请求级 model 覆盖(StepRequest.overrides.model 优先)', async () => {
    h.adapter.enqueue({ deltas: ['x'] });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: '默认模型' });
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: '覆盖模型',
    });
    expect(h.adapter.requests[0].model).toBe('覆盖模型');
  });

  it('opaque effort 经 prepareCall 贯通；请求覆盖 adapter 默认并回执真实 context', async () => {
    const adapter = new ReasoningAdapter('high');
    h.ctx.llm.registerAdapter(['reasoning-request'], adapter);
    adapter.enqueue({ deltas: ['ok'] });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'reasoning-request', model: 'model-x' });
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'max',
    });
    expect(adapter.requests[0].reasoningEffort).toBe('max');
    expect(response.callReceipt).toEqual({
      provider: 'reasoning-request',
      model: 'model-x',
      requestedEffort: 'max',
      effectiveEffort: 'max',
      effortSource: 'request',
      contextWindow: 1_000_000,
      contextWindowKnown: true,
    });
  });

  it('未请求 effort 时 materialize adapter default；无默认则标 provider_default', async () => {
    const withDefault = new ReasoningAdapter('high');
    const providerOwned = new ReasoningAdapter();
    h.ctx.llm.registerAdapter(['reasoning-default'], withDefault);
    h.ctx.llm.registerAdapter(['reasoning-provider'], providerOwned);
    withDefault.enqueue({ deltas: ['a'] });
    providerOwned.enqueue({ deltas: ['b'] });
    const a = await new DshProvider({ ctx: h.ctx, provider: 'reasoning-default', model: 'm' })
      .complete({ messages: [{ role: 'user', content: 'hi' }] });
    const b = await new DshProvider({ ctx: h.ctx, provider: 'reasoning-provider', model: 'm' })
      .complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(a.callReceipt).toMatchObject({ effectiveEffort: 'high', effortSource: 'adapter_default' });
    expect(b.callReceipt).toMatchObject({ effortSource: 'provider_default' });
    expect(b.callReceipt?.effectiveEffort).toBeUndefined();
  });

  it('unsupported effort 在 adapter stream 前 fail-closed', async () => {
    const adapter = new ReasoningAdapter('high');
    h.ctx.llm.registerAdapter(['reasoning-unsupported'], adapter);
    const provider = new DshProvider({ ctx: h.ctx, provider: 'reasoning-unsupported', model: 'm' });
    await expect(provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT', retryable: false });
    expect(adapter.requests).toHaveLength(0);
  });

  it('prepareCall 绑定一次 registration：解析期间替换 adapter 仍由旧 adapter dispatch', async () => {
    const next = new ReasoningAdapter('max');
    let swap = () => {};
    class SwappingAdapter extends ReasoningAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        const info = await super.resolveModel(provider, model);
        swap();
        return info;
      }
    }
    const old = new SwappingAdapter('high');
    const handle = h.ctx.llm.registerAdapter(['reasoning-swap'], old);
    swap = () => {
      handle.replace([]);
      h.ctx.llm.registerAdapter(['reasoning-swap'], next);
      swap = () => {};
    };
    old.enqueue({ deltas: ['old'] });
    next.enqueue({ deltas: ['new'] });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'reasoning-swap', model: 'm' });
    expect((await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).text).toBe('old');
    expect(old.requests).toHaveLength(1);
    expect(next.requests).toHaveLength(0);
    expect((await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).text).toBe('new');
    expect(next.requests).toHaveLength(1);
  });

  it('prepareCall 后中间件异常仍携带 secret-free effective receipt', async () => {
    const adapter = new ReasoningAdapter('high');
    h.ctx.llm.registerAdapter(['reasoning-middleware-error'], adapter);
    h.ctx.on('llm/stream', () => (async function* (): AsyncIterable<StreamChunk> {
      throw new Error('middleware exploded');
    })());
    const provider = new DshProvider({
      ctx: h.ctx,
      provider: 'reasoning-middleware-error',
      model: 'model-x',
    });
    const err = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((error: unknown) => error);
    expect(err).toMatchObject({
      message: 'middleware exploded',
      callReceipt: {
        provider: 'reasoning-middleware-error',
        model: 'model-x',
        effectiveEffort: 'high',
        effortSource: 'adapter_default',
        contextWindow: 1_000_000,
        contextWindowKnown: true,
      },
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it('error 终止(RATE_LIMIT)→ retryable 错误(供 llm-step 重试分类)', async () => {
    h.adapter.enqueue({
      finishKind: 'error',
      failure: { code: 'RATE_LIMIT', message: '429 too many' },
    });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('error 终止(AUTH)→ 非重试错误', async () => {
    h.adapter.enqueue({
      finishKind: 'error',
      failure: { code: 'AUTH', message: 'bad key' },
    });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('aborted 终止(finish aborted)→ 统一 AbortError: name=AbortError + retryable=false(审查项 6)', async () => {
    h.adapter.enqueue({ finishKind: 'aborted', failure: { code: 'ABORTED', message: 'signal' } });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    const err = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error & { retryable?: boolean }).retryable).toBe(false);
    expect((err as Error).message).toContain('aborted'); // 保留失败详情
  });

  it('signal abort(流已正常结束但信号已 abort)→ 统一 AbortError, 不返回半截文本(审查项 6)', async () => {
    h.adapter.enqueue({ deltas: ['partial-text'], finishKind: 'stop' });
    const controller = new AbortController();
    controller.abort(); // 调用前已 abort(同步生效)
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    const err = await provider
      .complete({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error & { retryable?: boolean }).retryable).toBe(false);
  });

  it('adapter 抛 AbortError(LlmError ABORTED 码)→ 统一 AbortError + retryable=false(审查项 6)', async () => {
    class ThrowingAbortAdapter extends FakeAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options);
        // dsh-llm 流协议把适配器抛错转为 terminal finish(ABORTED 码 → kind aborted)。
        throw new LlmError('adapter aborted', 'ABORTED');
      }
    }
    const throwing = new ThrowingAbortAdapter();
    h.ctx.llm.registerAdapter(['throw-abort'], throwing);
    const provider = new DshProvider({ ctx: h.ctx, provider: 'throw-abort', model: 'fake-model' });
    const err = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error & { retryable?: boolean }).retryable).toBe(false);
  });
});
