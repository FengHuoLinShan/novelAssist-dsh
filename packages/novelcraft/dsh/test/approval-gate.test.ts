// ApprovalGate 行为契约(seam: ctx.approval)。
// 断言引 seam 契约: request({action, summary, items}) → allowed-once/rejected,
// fail-closed(无 agent / 服务缺失 / 异常 → 拒绝)。
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { ApprovalGate, GateDeniedError } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

describe('ApprovalGate', () => {
  it('allowed-once → allowed; guard 放行执行写动作', async () => {
    const h: HarnessServices = await makeContext({ approval: { outcome: 'allowed-once' } });
    const gate = new ApprovalGate(h.ctx);
    let ran = false;
    const result = await gate.guard(fakeAgent, { action: '采用对象', summary: '测试对象' }, async () => {
      ran = true;
      return 42;
    });
    expect(result).toBe(42);
    expect(ran).toBe(true);
    // 审计面: 请求带作者语言 reason + 变更条目数
    expect(h.approval.requests[0]).toMatchObject({ toolName: 'novelcraft' });
    expect(h.approval.requests[0].reason).toContain('采用对象');
    expect(h.approval.requests[0].reason).toContain('测试对象');
  });

  it('rejected → guard 抛 GateDeniedError, 写动作不执行(fail-closed)', async () => {
    const h = await makeContext({ approval: { outcome: 'rejected' } });
    const gate = new ApprovalGate(h.ctx);
    let ran = false;
    await expect(
      gate.guard(fakeAgent, { action: '采用对象', summary: 'x' }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(GateDeniedError);
    expect(ran).toBe(false);
  });

  it('无 agent → unavailable(无开轮 = 无法审批, 直接 fail-closed)', async () => {
    const h = await makeContext({ approval: { outcome: 'allowed-once' } });
    const gate = new ApprovalGate(h.ctx);
    await expect(gate.request(undefined, { action: 'a', summary: 'b' })).resolves.toBe('unavailable');
    expect(h.approval.requests).toHaveLength(0);
  });

  it('审批服务缺失 → unavailable(fail-closed)', async () => {
    const ctx = new Context();
    const gate = new ApprovalGate(ctx);
    await expect(gate.request(fakeAgent, { action: 'a', summary: 'b' })).resolves.toBe('unavailable');
  });

  it('审批服务抛异常 → unavailable(不把异常当放行)', async () => {
    const ctx = new Context();
    ctx.provide('approval', { request: async () => { throw new Error('boom'); } });
    const gate = new ApprovalGate(ctx);
    await expect(gate.request(fakeAgent, { action: 'a', summary: 'b' })).resolves.toBe('unavailable');
  });
});
