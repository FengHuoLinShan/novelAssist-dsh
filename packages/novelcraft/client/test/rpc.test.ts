// @novelcraft/client 宿主半身 RPC 处理器行为契约。
// 断言引设计文档 §9/§17 + wire 契约: watch/state 四态数据、inbox/list 卡片
// (作者语言)、inbox/act 四动词回 assistant.act(adopt 指引给助手, UI 不写资产);
// 未绑定 → capability 缺省, 不炸通道。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { pushSignal } from '@novelcraft/assistant';
import { initVault } from '@novelcraft/vault';
import { describe, expect, it } from 'vitest';
import { createNovelcraftHandlers, type NovelcraftHostService } from '../src/index.js';

interface TestEnv {
  ctx: Context;
  root: string;
  cleanup: () => void;
}

function setup(): TestEnv {
  const ctx = new Context();
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-client-'));
  initVault(root, { title: '测试书' });
  const service: NovelcraftHostService = {
    vaults: {
      resolve: async (sessionId) => (sessionId === 's1' ? { book: '测试书', root } : undefined),
      resolveFromPath: (p) => (p.startsWith(root) ? { book: '测试书', root } : undefined),
    },
  };
  ctx.provide('novelcraft', service);
  ctx.provide('jobs', {
    list: () => [{ kind: 'novelcraft-radar', status: 'running' }],
  });
  return { ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('novelcraft RPC 处理器', () => {
  it('watch/state: 未绑定 → capability 缺省(静默零态)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ sessionId: 'unknown' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ bound: null, open: 0, attention: false, threshold: 5, radarRunning: false });
    }
    env.cleanup();
  });

  it('watch/state: 绑定 + 5 条信号 → attention(N3 阈值 5), radar 运行中可见', async () => {
    const env = setup();
    for (let i = 0; i < 5; i++) {
      pushSignal(env.root, {
        radar: 'dedup',
        severity: 'risk',
        title: `重复信号 ${i}`,
        evidence: ['第1章'],
        proposed_action: '合并',
        reversibility: true,
      });
    }
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书', root: env.root });
      expect(result.value.open).toBe(5);
      expect(result.value.attention).toBe(true);
      expect(result.value.radarRunning).toBe(true);
    }
    env.cleanup();
  });

  it('watch/state: workspacePath 回退解析(无 sessionId)', async () => {
    const env = setup();
    pushSignal(env.root, {
      radar: 'suggest',
      severity: 'note',
      title: '补设定建议',
      evidence: ['第2章'],
      proposed_action: '生成世界书页',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ workspacePath: path.join(env.root, 'chapters') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound?.book).toBe('测试书');
      expect(result.value.open).toBe(1);
      expect(result.value.attention).toBe(false); // 1 < 5 → 微光, 不触发待确认
    }
    env.cleanup();
  });

  it('inbox/list: 卡片作者语言字段 + 阈值', async () => {
    const env = setup();
    pushSignal(env.root, {
      radar: 'plot',
      severity: 'conflict',
      title: '伏笔 A 与第3章冲突',
      evidence: ['伏笔列表 #1', '第3章第2节'],
      proposed_action: '回收伏笔或改写第3章',
      reversibility: false,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxList({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals).toHaveLength(1);
      expect(result.value.signals[0]).toMatchObject({
        radar: 'plot',
        severity: 'conflict',
        title: '伏笔 A 与第3章冲突',
        status: 'open',
      });
      expect(result.value.threshold).toBe(5);
    }
    env.cleanup();
  });

  it('inbox/act: accept → 记录决定 + adopt 指引(资产写入留给助手/approval)', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'dedup',
      severity: 'risk',
      title: '重复对象',
      evidence: ['第1章'],
      proposed_action: '合并',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ sessionId: 's1', signalId: sig.id, action: 'accept' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('adopt');
      expect(result.value.message).toContain('助手');
    }
    // 信号已处理: 列表不再包含
    const list = await h.inboxList({ sessionId: 's1' });
    if (list.ok) expect(list.value.signals).toHaveLength(0);
    env.cleanup();
  });

  it('inbox/act: reject 无理由 → 失败消息(校准原料必填)', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'writing',
      severity: 'note',
      title: '第1章节奏偏慢',
      evidence: ['第1章'],
      proposed_action: '删冗余段',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ sessionId: 's1', signalId: sig.id, action: 'reject' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('理由');
    env.cleanup();
  });

  it('inbox/act: modify(带理由)→ 微工作流路由', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'dedup',
      severity: 'risk',
      title: '「甲」与「乙」疑似重复',
      evidence: ['第2章'],
      proposed_action: '合并',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({
      sessionId: 's1',
      signalId: sig.id,
      action: 'modify',
      reason: '不是重复, 是父子关系',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('microflow');
      expect(result.value.microflow).toBe('去重修复');
    }
    env.cleanup();
  });

  it('inbox/act: 未绑定 → 作者语言错误(不炸通道)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ signalId: 'x', action: 'defer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('未绑定');
    env.cleanup();
  });
});
