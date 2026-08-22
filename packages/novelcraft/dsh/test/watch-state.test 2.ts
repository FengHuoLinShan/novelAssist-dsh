// N34 / ADR-0023 watch-state file truth, catch-up cap and non-reentrancy.
import { describe, expect, it } from 'vitest';
import type { RadarKind } from '@novelcraft/assistant';
import {
  ActiveVaultWatchScheduler,
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
  async load(): Promise<WatchState | undefined> { return this.value && structuredClone(this.value); }
  async save(_root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    this.saves.push({ expected: expected && structuredClone(expected), next: structuredClone(next) });
    this.value = structuredClone(next);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
});
