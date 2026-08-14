// DshProvider 行为契约(seam: ctx.llm)。
// 断言引 seam 契约(packages/novelcraft/README.md「LLM 真 provider」):
// complete(req) 内部转 DSH ctx.llm 调用; system 进 system 槽;
// usage 透传; error/aborted 终止映射为可分类错误(retryable)。
import { beforeEach, describe, expect, it } from 'vitest';
import { DshProvider } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

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

  it('aborted 终止 → 错误(带失败详情)', async () => {
    h.adapter.enqueue({ finishKind: 'aborted', failure: { code: 'ABORTED', message: 'signal' } });
    const provider = new DshProvider({ ctx: h.ctx, provider: 'fake', model: 'fake-model' });
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/DSH llm 调用失败/);
  });
});
