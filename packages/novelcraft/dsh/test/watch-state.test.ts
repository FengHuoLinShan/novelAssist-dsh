// N34 / ADR-0023 watch-state file truth, catch-up cap and non-reentrancy.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RadarKind } from '@novelcraft/assistant';
import { initVault } from '@novelcraft/vault';
import {
  ActiveVaultWatchScheduler,
  TransactionWatchStatePersistence,
  parseWatchState,
  WATCH_RADARS,
  type ManagedRadarJob,
  type RadarJobHost,
  type WatchState,
  type WatchStatePersistence,
  type VaultBinding,
} from '../src/index.js';

function binding(root = '/tmp/book'): VaultBinding {
  return { root, book: '书', paths: {} as VaultBinding['paths'] };
}

class MemoryState implements WatchStatePersistence {
  value?: WatchState;
  saves: Array<{ expected?: WatchState; next: WatchState }> = [];
  loads = 0;
  async load(): Promise<WatchState | undefined> {
    this.loads += 1;
    return this.value && structuredClone(this.value);
  }
  async save(_root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    this.saves.push({ expected: expected && structuredClone(expected), next: structuredClone(next) });
    if (JSON.stringify(expected) !== JSON.stringify(this.value)) throw new Error('strict CAS mismatch');
    this.value = structuredClone(next);
  }
}

/** 前 failSaves 次 save() 拒绝(CAS/IO 失败),之后与 MemoryState 一致。 */
class FlakyState extends MemoryState {
  failSaves: number;
  constructor(failSaves: number) {
    super();
    this.failSaves = failSaves;
  }
  override async save(_root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    this.saves.push({ expected: expected && structuredClone(expected), next: structuredClone(next) });
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      throw new Error('CAS rejected');
    }
    if (JSON.stringify(expected) !== JSON.stringify(this.value)) throw new Error('strict CAS mismatch');
    this.value = structuredClone(next);
  }
}

class FlakyLoadState extends MemoryState {
  failLoads = 1;
  override async load(): Promise<WatchState | undefined> {
    if (this.failLoads-- > 0) {
      this.loads += 1;
      throw new Error('transient load failure');
    }
    return super.load();
  }
}

/** load() 可被 gate 阻塞,用于 pending activate 与 deactivate 交错。 */
class GatedState extends MemoryState {
  gate?: Promise<void>;
  override async load(): Promise<WatchState | undefined> {
    if (this.gate) await this.gate;
    return super.load();
  }
}

class DriftingState extends MemoryState {
  drifted = false;
  override async save(_root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    this.saves.push({ expected: expected && structuredClone(expected), next: structuredClone(next) });
    if (!this.drifted) {
      this.drifted = true;
      this.value = {
        version: 1,
        configFingerprint: fingerprint,
        radars: { risk: { lastCompletedAt: '2025-12-31T23:59:00.000Z', nextDueAt: '2026-01-01T00:01:00.000Z' } },
      };
      throw new Error('external CAS winner');
    }
    if (JSON.stringify(expected) !== JSON.stringify(this.value)) throw new Error('strict CAS mismatch');
    this.value = structuredClone(next);
  }
}

class BlockingState extends MemoryState {
  releases: Array<() => void> = [];
  activeSaves = 0;
  maxActiveSaves = 0;
  override async save(_root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    this.saves.push({ expected: expected && structuredClone(expected), next: structuredClone(next) });
    this.activeSaves += 1;
    this.maxActiveSaves = Math.max(this.maxActiveSaves, this.activeSaves);
    await new Promise<void>((resolve) => this.releases.push(resolve));
    if (JSON.stringify(expected) !== JSON.stringify(this.value)) throw new Error('strict CAS mismatch');
    this.value = structuredClone(next);
    this.activeSaves -= 1;
  }
}

interface Controlled extends ManagedRadarJob { resolve(): void; reject(error: unknown): void; cancelled: boolean }
class Jobs implements RadarJobHost {
  starts: Array<{ radar: RadarKind; job: Controlled }> = [];
  start(_binding: VaultBinding, radar: RadarKind): Controlled {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((ok, bad) => { resolve = ok; reject = bad; });
    const job: Controlled = {
      id: `${radar}-${this.starts.length}`,
      done,
      resolve,
      reject,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    this.starts.push({ radar, job });
    return job;
  }
}

const fingerprint = 'a'.repeat(64);
const inertTimer = (() => 1) as unknown as typeof setTimeout;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 计数 setTimer 调用,返回自增句柄(每个 arm 重新取句柄)。 */
function timerSpy() {
  let armed = 0;
  return {
    setTimer: (((_cb: () => void, _delay: number) => { armed += 1; return armed; }) as unknown as typeof setTimeout),
    clearTimer: () => undefined,
    count: () => armed,
  };
}

describe('watch-state schema', () => {
  it('严格解析固定字段；未知 radar/secret/非法时间 fail-closed', () => {
    expect(parseWatchState({
      version: 1,
      configFingerprint: fingerprint,
      radars: { ingest: { nextDueAt: '2026-01-01T00:00:00.000Z' } },
    }).radars.ingest?.nextDueAt).toContain('2026');
    expect(() => parseWatchState({ version: 1, configFingerprint: fingerprint, radars: {}, apiKey: 'secret' })).toThrow();
    expect(() => parseWatchState({ version: 1, configFingerprint: fingerprint, radars: { unknown: { nextDueAt: '2026-01-01' } } })).toThrow();
    expect(() => parseWatchState({ version: 1, configFingerprint: fingerprint, radars: { ingest: { nextDueAt: 'not-time' } } })).toThrow();
  });

  it(
    'production persistence 通过 ADR-0021 state transaction 执行 absent/present CAS',
    // 真实 git 事务(initVault + 2 次 commit + 3 次 executeTransaction), 负载下 4-6s;
    // 与 store transaction-crash.test.ts 同款显式超时(默认 5s 在并行负载下会误超时)。
    { timeout: 30_000 },
    async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-watch-tx-'));
    try {
      initVault(root, { title: '守望事务测试', language: 'zh' });
      const persistence = new TransactionWatchStatePersistence();
      const first: WatchState = {
        version: 1,
        configFingerprint: fingerprint,
        radars: { ingest: { nextDueAt: '2026-01-01T00:00:00.000Z' } },
      };
      await persistence.save(root, undefined, first);
      expect(await persistence.load(root)).toEqual(first);
      const second: WatchState = structuredClone(first);
      second.radars.ingest = {
        lastCompletedAt: '2026-01-01T00:00:00.000Z',
        nextDueAt: '2026-01-01T00:01:00.000Z',
      };
      await persistence.save(root, first, second);
      expect(await persistence.load(root)).toEqual(second);
      await expect(persistence.save(root, first, second)).rejects.toThrow(/CAS/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    },
  );
});

describe('ActiveVaultWatchScheduler', () => {
  it('首次/配置变化每 radar 最多补跑一次，同 vault/radar 防重入', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const state = new MemoryState();
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => now,
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    scheduler.runDue('/tmp/book');
    expect(jobs.starts.map((x) => x.radar).sort()).toEqual([...WATCH_RADARS].sort());
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length); // N34: 不按遗漏历史轮数追赶

    jobs.starts[0].job.resolve();
    await flush();
    expect(state.saves).toHaveLength(1);
    expect(state.value?.radars[jobs.starts[0].radar]?.lastCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length); // 已完成项 nextDue 在未来，其余仍 running
    now += 60_000;
  });

  it('最后 session 离开只取消本 scheduler 管理的 radar jobs', async () => {
    const state = new MemoryState();
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    scheduler.deactivate('/tmp/book');
    expect(jobs.starts.every(({ job }) => job.cancelled)).toBe(true);
    expect(scheduler.isRunning('/tmp/book', 'ingest')).toBe(false);
    // 其它 workflow jobs 未交给 scheduler，天然不会被遍历或取消(N34)。
  });

  it('多个 radar 同时完成时 state transaction 串行，后一个 expected 含前一个 snapshot', async () => {
    const state = new BlockingState();
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    const first = jobs.starts[0];
    const second = jobs.starts[1];
    first.job.resolve();
    second.job.resolve();
    await flush();
    expect(state.saves).toHaveLength(1);
    expect(state.maxActiveSaves).toBe(1);
    expect(scheduler.isRunning('/tmp/book', second.radar)).toBe(true);

    state.releases.shift()?.();
    await flush();
    expect(state.saves).toHaveLength(2);
    expect(state.saves[1].expected?.radars[first.radar]?.lastCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.maxActiveSaves).toBe(1);
    state.releases.shift()?.();
    await flush();
    expect(state.value?.radars[first.radar]?.lastCompletedAt).toBeDefined();
    expect(state.value?.radars[second.radar]?.lastCompletedAt).toBeDefined();
  });

  it('持久状态未到期时不启动；跨多年逾期仍只启动一轮', async () => {
    const state = new MemoryState();
    state.value = {
      version: 1,
      configFingerprint: fingerprint,
      radars: Object.fromEntries(WATCH_RADARS.map((radar) => [radar, { nextDueAt: '2030-01-01T00:00:00.000Z' }])) as WatchState['radars'],
    };
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2029-01-01T00:00:00.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toEqual([]);
  });

  it('重复/并发 activate 只建立一个 load、entry、timer；deactivate 后可重新激活', async () => {
    const state = new MemoryState();
    const jobs = new Jobs();
    const spy = timerSpy();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: spy.setTimer,
      clearTimer: spy.clearTimer,
    });
    // 并发 activate：第二个调用被 pending 占位吸收，不产生第二个 load/entry/timer。
    await Promise.all([scheduler.activate(binding()), scheduler.activate(binding())]);
    expect(state.loads).toBe(1);
    expect(spy.count()).toBe(1);
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length);

    // deactivate 只请求取消；旧 jobs 全部实际 settle 后，再激活走新的一轮 load。
    scheduler.deactivate('/tmp/book');
    for (const { job } of jobs.starts) job.reject(new Error('cancelled'));
    await flush();
    await scheduler.activate(binding());
    expect(state.loads).toBe(2);
    expect(spy.count()).toBe(2);
  });

  it('首次 durable load 瞬态失败保留可取消占位并定时重试，不永久丢失活跃引用', async () => {
    const state = new FlakyLoadState();
    const jobs = new Jobs();
    const callbacks: Array<() => void> = [];
    const errors: unknown[] = [];
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: (((callback: () => void) => { callbacks.push(callback); return callbacks.length; }) as unknown as typeof setTimeout),
      clearTimer: () => undefined,
      onError: (_root, error) => errors.push(error),
    });
    await scheduler.activate(binding());
    expect(state.loads).toBe(1);
    expect(errors).toHaveLength(1);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    await flush();
    expect(state.loads).toBe(2);
    expect(callbacks).toHaveLength(1); // successful retry armed the ordinary due timer
    scheduler.deactivate('/tmp/book');
  });

  it('activate 进行中 deactivate：pending 激活作废，load 完成不复活', async () => {
    const state = new GatedState();
    const jobs = new Jobs();
    const spy = timerSpy();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: spy.setTimer,
      clearTimer: spy.clearTimer,
    });
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    const activating = scheduler.activate(binding());
    scheduler.deactivate('/tmp/book'); // load 仍在途时 deactivate
    release();
    await activating;
    // 不复活：无 timer、无 job；后续 runDue 也是空操作。
    expect(spy.count()).toBe(0);
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toEqual([]);
    expect(scheduler.isRunning('/tmp/book', 'ingest')).toBe(false);

    // 之后正常重新激活仍然可用。
    state.gate = undefined;
    await scheduler.activate(binding());
    expect(spy.count()).toBe(1);
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length);
  });

  it('save 被拒不推进 durable 基准：第二 save expected 是真实 S0，失败 radar 退避后可重试', async () => {
    const state = new FlakyState(1); // 第一次 save() 拒绝
    const jobs = new Jobs();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => now,
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    const first = jobs.starts[0];
    const second = jobs.starts[1];
    first.job.resolve();
    second.job.resolve();
    await flush();
    await flush();
    expect(state.saves).toHaveLength(2);
    const [, secondSave] = state.saves;
    // 文件原本不存在，第二 save 的真实 durable expected 仍为 absent；第一 radar 的幻影更新不得出现。
    expect(secondSave.expected).toBeUndefined();
    // 第二更新不丢：radar2 的 lastCompletedAt 落到第二 save 与最终持久状态。
    expect(secondSave.next.radars[second.radar]?.lastCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.value?.radars[second.radar]?.lastCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.value?.radars[first.radar]?.lastCompletedAt).toBeUndefined();
    // 失败 radar 释放 occupancy，但退避窗口内不重启；窗口后可恢复。
    expect(scheduler.isRunning('/tmp/book', first.radar)).toBe(false);
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length);
    now += 60_000;
    scheduler.runDue('/tmp/book');
    expect(jobs.starts).toHaveLength(WATCH_RADARS.length + 2);
    expect(jobs.starts[WATCH_RADARS.length]?.radar).toBe(first.radar);
    expect(jobs.starts[WATCH_RADARS.length + 1]?.radar).toBe(second.radar);
  });

  it('真实 CAS drift 后 reload durable winner，退避后的 save 使用刷新基准', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const state = new DriftingState();
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => now,
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    const failedRadar = jobs.starts[0].radar;
    jobs.starts[0].job.resolve();
    await flush();
    await flush();
    expect(state.value?.radars.risk?.lastCompletedAt).toBe('2025-12-31T23:59:00.000Z');
    now += 60_000;
    scheduler.runDue('/tmp/book');
    const retry = jobs.starts.slice(WATCH_RADARS.length).find(({ radar }) => radar === failedRadar);
    expect(retry).toBeDefined();
    retry!.job.resolve();
    await flush();
    await flush();
    expect(state.saves).toHaveLength(2);
    expect(state.saves[1].expected).toMatchObject({ radars: { risk: { lastCompletedAt: '2025-12-31T23:59:00.000Z' } } });
  });

  it('onError 抛错零 unhandled rejection，saveChain 不被毒化，后续事务可运行', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let now = Date.parse('2026-01-01T00:00:00.000Z');
      const state = new FlakyState(1); // 第一 save 拒绝
      const jobs = new Jobs();
      let observerCalls = 0;
      const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
        enabled: true,
        intervalMs: 60_000,
        configFingerprint: fingerprint,
        now: () => now,
        setTimer: inertTimer,
        clearTimer: () => undefined,
        onError: () => { observerCalls += 1; throw new Error('observer boom'); },
      });
      await scheduler.activate(binding());
      scheduler.runDue('/tmp/book');

      // 轮 1：radar0 成功但 save 拒绝；持抛错的 onError 必须被隔离。
      jobs.starts[0].job.resolve();
      await flush();
      await flush();
      expect(observerCalls).toBe(1);
      expect(scheduler.isRunning('/tmp/book', jobs.starts[0].radar)).toBe(false);

      // 轮 2：radar1 job 失败(error 上报)+ save 成功；两路异常都不得 unhandled。
      jobs.starts[1].job.reject(new Error('radar boom'));
      await flush();
      await flush();
      expect(observerCalls).toBe(2);
      expect(state.saves).toHaveLength(2);
      expect(state.value?.radars[jobs.starts[1].radar]?.nextDueAt).toBe('2026-01-01T00:01:00.000Z');

      // 轮 3：saveChain 未被毒化；radar0 的持久化失败和 radar1 的运行失败都可重试。
      now += 60_000;
      scheduler.runDue('/tmp/book');
      expect(jobs.starts).toHaveLength(WATCH_RADARS.length + 2);
      const retry0 = jobs.starts[WATCH_RADARS.length];
      const retry1 = jobs.starts[WATCH_RADARS.length + 1];
      expect(retry0.radar).toBe(jobs.starts[0].radar);
      expect(retry1.radar).toBe(jobs.starts[1].radar);
      retry0.job.resolve();
      retry1.job.resolve();
      await flush();
      await flush();
      expect(state.saves).toHaveLength(4);
      expect(state.value?.radars[retry0.radar]?.lastCompletedAt).toBe('2026-01-01T00:01:00.000Z');
      expect(state.value?.radars[retry1.radar]?.lastCompletedAt).toBe('2026-01-01T00:01:00.000Z');

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('radar 失败保留既有 lastCompletedAt，仅推进 nextDueAt', async () => {
    const state = new MemoryState();
    state.value = {
      version: 1,
      configFingerprint: fingerprint,
      radars: { ingest: { lastCompletedAt: '2025-12-01T00:00:00.000Z', nextDueAt: '2026-01-01T00:00:00.000Z' } },
    };
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:10.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    const ingest = jobs.starts.find(({ radar }) => radar === 'ingest');
    expect(ingest).toBeDefined();
    ingest!.job.reject(new Error('radar boom'));
    await flush();
    // 失败只推进 nextDueAt，既有 lastCompletedAt 原样保留。
    expect(state.value?.radars.ingest?.lastCompletedAt).toBe('2025-12-01T00:00:00.000Z');
    expect(state.value?.radars.ingest?.nextDueAt).toBe('2026-01-01T00:01:10.000Z');
  });

  it('jobs.start 同步抛错被隔离并退避，不逃逸 timer 回调', async () => {
    const state = new MemoryState();
    const errors: unknown[] = [];
    const scheduler = new ActiveVaultWatchScheduler(state, {
      start() { throw new Error('sync start boom'); },
    }, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
      onError: (_root, error) => errors.push(error),
    });
    await scheduler.activate(binding());
    expect(() => scheduler.runDue('/tmp/book')).not.toThrow();
    expect(errors).toHaveLength(WATCH_RADARS.length);
    expect(() => scheduler.runDue('/tmp/book')).not.toThrow();
    expect(errors).toHaveLength(WATCH_RADARS.length); // 退避期内不 hot-loop
  });

  it('超过 Node timer 上限的 dueAt 以 2^31-1 分段 re-arm', async () => {
    const state = new MemoryState();
    state.value = {
      version: 1,
      configFingerprint: fingerprint,
      radars: Object.fromEntries(WATCH_RADARS.map((radar) => [radar, { nextDueAt: '2100-01-01T00:00:00.000Z' }])),
    };
    const delays: number[] = [];
    const scheduler = new ActiveVaultWatchScheduler(state, new Jobs(), {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: (((_callback: () => void, delay: number) => { delays.push(delay); return 1; }) as unknown as typeof setTimeout),
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    expect(delays.at(-1)).toBe(2_147_483_647);
  });

  it('deactivate/reactivate 等待旧 generation 的 in-flight save 后再 load', async () => {
    const state = new BlockingState();
    const jobs = new Jobs();
    const scheduler = new ActiveVaultWatchScheduler(state, jobs, {
      enabled: true,
      intervalMs: 60_000,
      configFingerprint: fingerprint,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      setTimer: inertTimer,
      clearTimer: () => undefined,
    });
    await scheduler.activate(binding());
    scheduler.runDue('/tmp/book');
    jobs.starts[0].job.resolve();
    await flush();
    expect(state.activeSaves).toBe(1);
    scheduler.deactivate('/tmp/book');
    for (const { job } of jobs.starts.slice(1)) job.reject(new Error('cancelled'));
    const reactivation = scheduler.activate(binding());
    await flush();
    expect(state.loads).toBe(1); // 新 generation 尚未读取旧快照
    state.releases.shift()?.();
    await reactivation;
    expect(state.loads).toBe(2);
    expect(state.maxActiveSaves).toBe(1);
  });
});