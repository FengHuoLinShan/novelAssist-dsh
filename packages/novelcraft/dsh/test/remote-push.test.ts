// @novelcraft/dsh · 远程推送 seam 行为契约(ADR-0018 §1 窄缝补丁)。
//
// 证明两件事:
//  1. scripts/apply-dsh-patches.mjs 已把通用 `client/push` 加入 api-proxy 转发循环
//     消费的 API_REMOTE_FORWARDED_EVENTS allowlist(runtime 数组, 补丁只动 .js);
//  2. `client/push` 是可用 cordis 事件: host 经 pushSignalsChanged emit, 消费面经
//     ctx.on('client/push', ...) 收到(channel + payload 原样)。运行时消费面
//     ctx.remote.$on 是纯字符串键 Map(dsh-api-gateway/lib/client.js), 无事件名校验。
import { Context } from '@deepseek-ai/cordis';
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes';
import { describe, expect, it } from 'vitest';
import { pushSignalsChanged, SIGNALS_CHANGED } from '../src/push.js';

describe('client/push 远程推送 seam(ADR-0018 §1)', () => {
  it('allowlist 已含 client/push(补丁生效)', () => {
    expect(API_REMOTE_FORWARDED_EVENTS as readonly string[]).toContain('client/push');
  });

  it('pushSignalsChanged emit → 消费面按 channel+payload 收到', () => {
    const ctx = new Context();
    const seen: Array<[string, unknown]> = [];
    const off = ctx.on('client/push', (channel, payload) => {
      seen.push([channel, payload]);
    });
    pushSignalsChanged(ctx, { root: '/tmp/vault' });
    expect(seen).toEqual([[SIGNALS_CHANGED, { root: '/tmp/vault' }]]);
    off();
  });
});
