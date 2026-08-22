// buildActPayload: inbox/act 载荷构造纯函数(无 React/DOM 依赖)。
// wire 契约: modified.title/proposed_action → modifiedTitle/modifiedProposedAction,
// 与宿主 rpc.inboxAct 的映射(→ assistant ActInput.modified)对齐。
import { describe, expect, it } from 'vitest';
import { buildActPayload } from '../src/client/actPayload.js';

describe('buildActPayload(收件箱动作载荷构造)', () => {
  const card = { id: 'sig-1' };

  it('modify: 内联修改文本映射到 wire modifiedTitle/modifiedProposedAction', () => {
    const p = buildActPayload(card, 's1', 'modify', '改为建议修词', {
      title: '新标题',
      proposed_action: '新行动',
    });
    expect(p).toEqual({
      sessionId: 's1',
      signalId: 'sig-1',
      action: 'modify',
      reason: '改为建议修词',
      modifiedTitle: '新标题',
      modifiedProposedAction: '新行动',
    });
  });

  it('modify: 只改 proposed_action(UI 单输入框流)也映射进 wire', () => {
    const p = buildActPayload(card, 's1', 'modify', '理由', { proposed_action: '合并段落' });
    expect(p.modifiedProposedAction).toBe('合并段落');
    expect(p.modifiedTitle).toBeUndefined();
  });

  it('accept/defer: 最小字段(无 reason/无 modified 省略)', () => {
    expect(buildActPayload(card, undefined, 'accept')).toEqual({ signalId: 'sig-1', action: 'accept' });
    expect(buildActPayload(card, 's1', 'defer')).toEqual({ sessionId: 's1', signalId: 'sig-1', action: 'defer' });
  });

  it('空字符串修改文本省略(与宿主 act 的 truthy 判定一致: 空修改不覆盖原值)', () => {
    const p = buildActPayload(card, 's1', 'modify', 'x', { title: '', proposed_action: '' });
    expect(p.modifiedTitle).toBeUndefined();
    expect(p.modifiedProposedAction).toBeUndefined();
    expect(p.reason).toBe('x');
  });
});