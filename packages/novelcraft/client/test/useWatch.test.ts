// useWatch 纯逻辑(轮询退避 + 请求竞态护栏)。
// 说明: hook 本体(useState/useEffect 生命周期)无运行测试 —— client 测试环境为
// node(无 jsdom), 不强加新依赖; useWatch 的 epoch/序号隔离与 useChapterDossier
// 的 chapterSeq 由 createSeqGate 覆盖语义 + typecheck/build 编译期覆盖,
// 生命周期接线行为在真实浏览器运行时验证。
import { describe, expect, it } from 'vitest';
import {
  createSeqGate,
  bookIdentityChanged,
  matchesBookChangedSession,
  nextPollAction,
  nextPollDelay,
  petState,
  POLL_MAX_MS,
  POLL_MIN_MS,
  watchAvailabilityAfterFailure,
  workflowNeedsPolling,
} from '../src/client/useWatch.js';

describe('nextPollDelay(轮询退避, ADR-0018 §2)', () => {
  it('数据有变化 → 立即回到短轮询下界', () => {
    expect(nextPollDelay(true, POLL_MAX_MS)).toBe(POLL_MIN_MS);
  });

  it('无变化 → 指数退避且不超上限', () => {
    expect(nextPollDelay(false, POLL_MIN_MS)).toBe(POLL_MIN_MS * 2);
    expect(nextPollDelay(false, POLL_MAX_MS)).toBe(POLL_MAX_MS);
    expect(nextPollDelay(false, 10_000)).toBe(POLL_MAX_MS); // 10_000*2=20_000 → 封顶 15_000
  });
});

describe('watch availability', () => {
  it('从未成功连接显示断线，已有成功快照后失败显示状态过期', () => {
    expect(watchAvailabilityAfterFailure('loading', true)).toBe('disconnected');
    expect(watchAvailabilityAfterFailure('loading', false)).toBe('disconnected');
    expect(watchAvailabilityAfterFailure('live', true)).toBe('stale');
    expect(watchAvailabilityAfterFailure('stale', true)).toBe('stale');
  });

  it('断线和过期优先于业务静默，在线零事项才显示静默', () => {
    const base = {
      bound: true, book: '测试书', open: 0, attention: false, threshold: 5,
      radarRunning: false, plotSummary: null,
    } as const;
    expect(petState({ ...base, availability: 'disconnected' })).toMatchObject({ label: 'pet.disconnected' });
    expect(petState({ ...base, availability: 'stale' })).toMatchObject({ label: 'pet.stale' });
    expect(petState({ ...base, availability: 'live' })).toMatchObject({ label: 'pet.silent' });
    expect(petState({ ...base, availability: 'live', open: 5, attention: true })).toMatchObject({ label: 'pet.attention' });
  });
});

describe('workflow polling', () => {
  it('只在存在运行中的 durable workflow 时持续刷新', () => {
    const view = (state: 'running' | 'completed' | 'failed') => ({
      bound: { book: 'test' }, restart_scope: null,
      runs: [{ workflow_id: 'wf', kind: 'deep-import', state }],
    });
    expect(workflowNeedsPolling(view('running') as never)).toBe(true);
    expect(workflowNeedsPolling(view('completed') as never)).toBe(false);
    expect(workflowNeedsPolling(view('failed') as never)).toBe(false);
    expect(workflowNeedsPolling(null)).toBe(false);
  });
});

describe('nextPollAction(续排决策: stale 缺口修复)', () => {
  it('changed/unchanged 且 epoch current → 沿用指数退避', () => {
    expect(nextPollAction('changed', true, POLL_MAX_MS)).toBe(POLL_MIN_MS);
    expect(nextPollAction('unchanged', true, POLL_MIN_MS)).toBe(POLL_MIN_MS * 2);
    expect(nextPollAction('unchanged', true, POLL_MAX_MS)).toBe(POLL_MAX_MS);
  });

  it('stale 且 epoch 仍 current → 确保下一轮短轮询(修复公共 refresh 不 schedule 的停摆缺口)', () => {
    // 任何退避状态下 stale 都必须回到 POLL_MIN_MS —— 取代本链的更新方(外部
    // refresh/事件)不负责续排, 否则轮询链静默停摆。
    for (const prev of [POLL_MIN_MS, 8000, POLL_MAX_MS]) {
      expect(nextPollAction('stale', true, prev)).toBe(POLL_MIN_MS);
    }
  });

  it('连接失败不进入长退避，尽快恢复新鲜状态', () => {
    expect(nextPollAction('failed', true, POLL_MAX_MS)).toBe(POLL_MIN_MS);
  });

  it('epoch 已切代际(cleanup) → 一律不续排(null), stale 也不例外', () => {
    expect(nextPollAction('changed', false, POLL_MIN_MS)).toBeNull();
    expect(nextPollAction('unchanged', false, POLL_MIN_MS)).toBeNull();
    expect(nextPollAction('stale', false, POLL_MIN_MS)).toBeNull();
    expect(nextPollAction('failed', false, POLL_MIN_MS)).toBeNull();
  });

  it('语义链: poll token → refresh token → poll 判 stale 后仍续排', () => {
    const gate = createSeqGate();
    const marker = gate.snapshotEpoch(); // schedule 捕获的 epoch marker
    const pollToken = gate.request(); // 轮询 timer 触发: 登记本次轮询 token
    const refreshToken = gate.request(); // 外部 refresh 登记(latest-wins 取代 poll)
    expect(gate.isCurrent(pollToken)).toBe(false); // poll 响应将判 stale
    expect(gate.isCurrent(refreshToken)).toBe(true); // refresh 自身是最新请求
    // poll 返回 stale 且 epoch 仍 current → 续排决策必须给出下一轮短轮询
    // (refresh 完成后直接返回, 不 schedule; 缺口由此补上)。
    expect(nextPollAction('stale', gate.isCurrentEpoch(marker), 8000)).toBe(POLL_MIN_MS);
    // 同代际后续轮询照常 latest-wins(不因修复引入重复排程)。
    const nextPollToken = gate.request();
    expect(gate.isCurrent(refreshToken)).toBe(false);
    expect(gate.isCurrent(nextPollToken)).toBe(true);
  });
});

describe('createSeqGate(latest-wins 请求护栏)', () => {
  it('书切换只作废同会话读面，旧响应不能回填', () => {
    expect(matchesBookChangedSession({ sessionId: 's1', book: 'b' }, 's1')).toBe(true);
    expect(matchesBookChangedSession({ sessionId: 's2', book: 'b' }, 's1')).toBe(false);
    const gate = createSeqGate();
    const oldBookRequest = gate.request();
    gate.invalidate(); // book-changed: clear first, then new request
    const newBookRequest = gate.request();
    expect(gate.isCurrent(oldBookRequest)).toBe(false);
    expect(gate.isCurrent(newBookRequest)).toBe(true);
  });

  it('同标题但不同 Vault root 仍判定切书并作废旧响应', () => {
    expect(bookIdentityChanged('/vaults/a', '/vaults/b')).toBe(true)
    expect(bookIdentityChanged('/vaults/a', '/vaults/a')).toBe(false)
    const gate = createSeqGate()
    const sameTitleOldRoot = gate.request()
    if (bookIdentityChanged('/vaults/a', '/vaults/b')) gate.invalidate()
    expect(gate.isCurrent(sameTitleOldRoot)).toBe(false)
  })

  it('新请求 latest-wins: 旧请求响应作废(同代际内)', () => {
    const gate = createSeqGate();
    const r1 = gate.request();
    const r2 = gate.request();
    expect(gate.isCurrent(r1)).toBe(false); // 已被 r2 取代
    expect(gate.isCurrent(r2)).toBe(true);
  });

  it('invalidate(cleanup 语义)作废全部在途请求, 新代际请求可应用', () => {
    const gate = createSeqGate();
    const old = gate.request();
    gate.invalidate(); // effect cleanup: 卸载/依赖切换
    expect(gate.isCurrent(old)).toBe(false);
    expect(gate.isCurrentEpoch(old.epoch)).toBe(false); // 续排判定也失配
    const fresh = gate.request();
    expect(gate.isCurrentEpoch(fresh.epoch)).toBe(true);
    expect(gate.isCurrent(fresh)).toBe(true);
  });

  it('跨代际旧请求即使序号更大也不可应用(cleanup 优先)', () => {
    const gate = createSeqGate();
    const a = gate.request(); // epoch0/req1
    gate.invalidate(); // epoch1
    const b = gate.request(); // epoch1/req2
    expect(gate.isCurrent(a)).toBe(false); // 旧 epoch 作废
    expect(gate.isCurrent(b)).toBe(true);
  });

  it('invalidate 后可恢复(重挂载/重排语义): 连续 invalidate 后照常工作', () => {
    const gate = createSeqGate();
    gate.invalidate();
    gate.invalidate();
    const t = gate.request();
    expect(gate.isCurrent(t)).toBe(true);
    // 重挂载 = 新实例, 从初始代际恢复。
    const remounted = createSeqGate();
    expect(remounted.request().epoch).toBe(0);
  });
});

describe('createSeqGate(epoch marker 只读快照 + 轮询启动语义)', () => {
  it('snapshotEpoch 只读: 不登记请求, 初始 refresh 不被 schedule 作废', () => {
    const gate = createSeqGate();
    const initial = gate.request(); // 初始 refresh 的 token1
    const marker = gate.snapshotEpoch(); // schedule 新行为: 只捕获 marker(旧行为是 request() → 立即作废 initial)
    expect(marker).toBe(initial.epoch);
    // 读取 marker 未登记新请求: token1 仍是最新, 初始 refresh 响应立即可应用。
    expect(gate.isCurrent(initial)).toBe(true);
    expect(gate.isCurrentEpoch(marker)).toBe(true);
  });

  it('同 epoch timer 触发时的新 request 可应用(latest-wins 保持)', () => {
    const gate = createSeqGate();
    const marker = gate.snapshotEpoch(); // schedule 捕获 marker
    // timeout 真正触发: 先确认 marker 仍为当前代际, 再登记本次轮询 token。
    expect(gate.isCurrentEpoch(marker)).toBe(true);
    const token = gate.request();
    expect(token.epoch).toBe(marker);
    expect(gate.isCurrent(token)).toBe(true); // 本次请求未被 schedule 预登记作废
  });

  it('invalidate 后旧 marker 不能启动: 守卫失配, 旧 timer 不在新代际登记请求', () => {
    const gate = createSeqGate();
    const marker = gate.snapshotEpoch(); // 旧 effect 的 schedule marker
    gate.invalidate(); // cleanup: 切代际
    // timeout 回调首步守卫失配 → 直接 return, 不 request(新代际请求序不受旧 timer 污染)。
    expect(gate.isCurrentEpoch(marker)).toBe(false);
    const fresh = gate.request(); // 新 effect 自行登记
    expect(fresh.epoch).not.toBe(marker);
    expect(gate.isCurrent(fresh)).toBe(true);
  });
});
