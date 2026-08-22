// N34 / ADR-0023 — file-truth watch state and one-timer-per-vault scheduler.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RadarKind } from '@novelcraft/assistant';
import { EMPTY_SHA, executeTransaction } from '@novelcraft/store';
import type { VaultBinding } from '../vault/binding.js';

export const WATCH_STATE_PATH = '.assistant/watch-state.json';
export const WATCH_STATE_VERSION = 1;
export const WATCH_RADARS: readonly RadarKind[] = ['ingest', 'dedup', 'suggest', 'plot', 'risk', 'writing'];

export interface RadarWatchState {
  lastCompletedAt?: string;
  nextDueAt: string;
}

export interface WatchState {
  version: 1;
  configFingerprint: string;
  radars: Partial<Record<RadarKind, RadarWatchState>>;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function parseWatchState(value: unknown): WatchState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('watch-state 必须是对象');
  const record = value as Record<string, unknown>;
  const allowedTop = new Set(['version', 'configFingerprint', 'radars']);
  if (Object.keys(record).some((key) => !allowedTop.has(key))) throw new Error('watch-state 含未知顶层字段');
  if (record.version !== WATCH_STATE_VERSION) throw new Error(`watch-state version 必须为 ${WATCH_STATE_VERSION}`);
  if (typeof record.configFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.configFingerprint)) {
    throw new Error('watch-state configFingerprint 必须是 sha256 hex');
  }
  if (!record.radars || typeof record.radars !== 'object' || Array.isArray(record.radars)) {
    throw new Error('watch-state.radars 必须是对象');
  }
  const known = new Set<string>(WATCH_RADARS);
  const radars: WatchState['radars'] = {};
  for (const [kind, raw] of Object.entries(record.radars as Record<string, unknown>)) {
    if (!known.has(kind)) throw new Error(`未知 radar: ${kind}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`radar ${kind} 状态非法`);
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== 'lastCompletedAt' && key !== 'nextDueAt')) {
      throw new Error(`radar ${kind} 含未知字段`);
    }
    if (!validIso(entry.nextDueAt)) throw new Error(`radar ${kind}.nextDueAt 非法`);
    if (entry.lastCompletedAt !== undefined && !validIso(entry.lastCompletedAt)) {
      throw new Error(`radar ${kind}.lastCompletedAt 非法`);
    }
    radars[kind as RadarKind] = {
      ...(entry.lastCompletedAt === undefined ? {} : { lastCompletedAt: entry.lastCompletedAt }),
      nextDueAt: entry.nextDueAt,
    };
  }
  return { version: 1, configFingerprint: record.configFingerprint, radars };
}

/** Strict read; malformed state fails closed instead of being silently reset. */
export function readWatchState(root: string): WatchState | undefined {
  const file = path.join(root, WATCH_STATE_PATH);
  if (!existsSync(file)) return undefined;
  return parseWatchState(JSON.parse(readFileSync(file, 'utf8')));
}

export interface WatchStatePersistence {
  load(root: string): Promise<WatchState | undefined>;
  /** Must be implemented by an ADR-0021 state transaction; no direct-write fallback. */
  save(root: string, expected: WatchState | undefined, next: WatchState): Promise<void>;
}

/** Production persistence: watch state is committed through the ADR-0021 state transaction seam. */
export class TransactionWatchStatePersistence implements WatchStatePersistence {
  async load(root: string): Promise<WatchState | undefined> {
    return readWatchState(root);
  }

  async save(root: string, expected: WatchState | undefined, next: WatchState): Promise<void> {
    const normalizedNext = parseWatchState(next);
    const file = path.join(root, WATCH_STATE_PATH);
    const currentBytes = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (expected === undefined && currentBytes !== undefined) {
      throw new Error('watch-state CAS: expected absent but file exists');
    }
    if (expected !== undefined) {
      const normalizedExpected = parseWatchState(expected);
      if (currentBytes === undefined) throw new Error('watch-state CAS: expected file is absent');
      const observed = readWatchState(root);
      if (JSON.stringify(observed) !== JSON.stringify(normalizedExpected)) {
        throw new Error('watch-state CAS: durable state differs from expected snapshot');
      }
    }
    const expectedSha = currentBytes === undefined
      ? EMPTY_SHA
      : createHash('sha256').update(currentBytes).digest('hex');
    // N32/ADR-0021 §8 能力契约(复审 Blocker): state/checkpoint 必须携带已提交
    // planSource(恢复时按 base HEAD:<path> digest 重推导), 且路径 ∈ 机器 namespace
    // allowlist; 首次创建(watch-state 未落盘)走 run_bootstrap 例外(自描述
    // runId/inputFingerprint/runFile + 全目标 expected absent, 补完不回滚)。
    if (expected === undefined) {
      await executeTransaction(root, {
        kind: 'run_bootstrap',
        purpose: 'bootstrap Node-hosted watch scheduler state',
        runId: `watch-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`,
        inputFingerprint: normalizedNext.configFingerprint,
        runFile: WATCH_STATE_PATH,
        writeSet: [{
          path: WATCH_STATE_PATH,
          expected: { absent: true, sha256: '' },
          output: `${JSON.stringify(normalizedNext, null, 2)}\n`,
        }],
      });
      return;
    }
    await executeTransaction(root, {
      kind: 'state',
      purpose: 'persist Node-hosted watch scheduler cursor',
      planSource: { path: WATCH_STATE_PATH, digest: expectedSha },
      writeSet: [{
        path: WATCH_STATE_PATH,
        expected: { absent: currentBytes === undefined, sha256: expectedSha },
        output: `${JSON.stringify(normalizedNext, null, 2)}\n`,
      }],
    });
  }
}

export interface ManagedRadarJob {
  id: string;
  done: Promise<void>;
  cancel(reason: string): void;
}

export interface RadarJobHost {
  /** Implementations start an unowned DSH job. */
  start(binding: VaultBinding, radar: RadarKind): ManagedRadarJob;
}

interface ActiveVault {
  binding: VaultBinding;
  /** Last snapshot actually loaded from or accepted by durable persistence. */
  durableState: WatchState | undefined;
  /** Runtime scheduling view; may fill missing radars without pretending they are durable. */
  state: WatchState;
  timer?: ReturnType<typeof setTimeout>;
  running: Map<RadarKind, ManagedRadarJob>;
  /** Serialize state transactions so concurrent radar completion CAS snapshots cannot overtake each other. */
  saveChain: Promise<void>;
  /** Transient backoff after a failed state transaction; never masquerades as durable state. */
  retryNotBefore: Partial<Record<RadarKind, number>>;
  stopped: boolean;
  /** Activation placeholder installed before load() settles; runDue/arm must not touch pending entries. */
  pending: boolean;
}

export interface WatchSchedulerOptions {
  enabled: boolean;
  intervalMs: number;
  configFingerprint: string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (root: string, error: unknown) => void;
}

/** Node-hosted scheduler: browser connectivity is intentionally not an input. */
export class ActiveVaultWatchScheduler {
  private readonly active = new Map<string, ActiveVault>();
  /** Per-root activation generation; deactivate bumps it so an in-flight activate load cannot resurrect the vault. */
  private readonly generations = new Map<string, number>();
  /** Persists across deactivate/reactivate so generations cannot overlap state transactions. */
  private readonly saveBarriers = new Map<string, Promise<void>>();
  /** Old generation jobs must actually settle after cancel before the same vault can reactivate. */
  private readonly jobBarriers = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<WatchSchedulerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<WatchSchedulerOptions['clearTimer']>;

  constructor(
    private readonly persistence: WatchStatePersistence,
    private readonly jobs: RadarJobHost,
    private readonly options: WatchSchedulerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) {
      throw new Error('watch intervalMs 必须是 >=1000 的安全整数');
    }
    if (!/^[0-9a-f]{64}$/.test(options.configFingerprint)) throw new Error('watch configFingerprint 非法');
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Idempotent 0→1 activation; a concurrent activate() is absorbed by the pending placeholder. */
  async activate(binding: VaultBinding): Promise<void> {
    if (!this.options.enabled || this.active.has(binding.root)) return;
    const generation = (this.generations.get(binding.root) ?? 0) + 1;
    this.generations.set(binding.root, generation);
    // Pending placeholder first: at most one load/entry/timer per root. A second activate() while
    // the load is in flight sees the root as taken and returns without a second load/re-entry.
    const entry: ActiveVault = {
      binding,
      durableState: undefined,
      state: { version: 1, configFingerprint: this.options.configFingerprint, radars: {} },
      running: new Map(),
      saveChain: Promise.resolve(),
      retryNotBefore: {},
      stopped: false,
      pending: true,
    };
    this.active.set(binding.root, entry);
    try {
      // A previous generation may still be committing state or stopping a managed job. Never load
      // until both settle: cancel is only a request and must not permit cross-generation re-entry.
      await Promise.all([
        this.saveBarriers.get(binding.root) ?? Promise.resolve(),
        this.jobBarriers.get(binding.root) ?? Promise.resolve(),
      ]);
      if (entry.stopped || this.generations.get(binding.root) !== generation) return;
      const observed = await this.persistence.load(binding.root);
      // A deactivate() (or a newer activation) raced this load: the pending activation is
      // invalidated — load completion must not resurrect the vault.
      if (entry.stopped || this.generations.get(binding.root) !== generation) return;
      const nowIso = new Date(this.now()).toISOString();
      entry.durableState = observed === undefined ? undefined : structuredClone(observed);
      const state: WatchState = observed && observed.configFingerprint === this.options.configFingerprint
        ? structuredClone(observed)
        : { version: 1, configFingerprint: this.options.configFingerprint, radars: {} };
      for (const radar of WATCH_RADARS) {
        if (!state.radars[radar]) state.radars[radar] = { nextDueAt: nowIso };
      }
      entry.state = state;
      entry.pending = false;
      this.arm(entry);
    } catch (loadError) {
      if (entry.stopped || this.generations.get(binding.root) !== generation) return;
      // A transient durable-load failure must not strand an active vault reference forever. Keep a
      // cancellable placeholder and retry later; deactivate()/stopAll() clears this owned timer.
      this.report(binding.root, loadError);
      entry.pending = true;
      entry.timer = this.setTimer(() => {
        if (entry.stopped || this.active.get(binding.root) !== entry) return;
        this.active.delete(binding.root);
        void this.activate(binding).catch((error) => this.report(binding.root, error));
      }, Math.min(this.options.intervalMs, 2_147_483_647));
    }
  }

  /** 1→0 deactivation: stop timer, cancel managed jobs, and invalidate any pending activation. */
  deactivate(root: string): void {
    const entry = this.active.get(root);
    if (!entry) return;
    entry.stopped = true;
    if (entry.timer) this.clearTimer(entry.timer);
    for (const job of entry.running.values()) {
      try { job.cancel('last NovelCraft session disposed'); } catch (cancelError) { this.report(root, cancelError); }
    }
    entry.running.clear();
    this.active.delete(root);
    // Deletion invalidates pending generation equality and avoids retaining arbitrary roots forever.
    this.generations.delete(root);
  }

  /** HMR/plugin disposal: cancel every owned timer/job and drain old-generation work. */
  async stopAll(): Promise<void> {
    for (const root of [...this.active.keys()]) this.deactivate(root);
    // Barriers are instance-local, so HMR must drain them before a replacement scheduler scans live
    // sessions. Include already-deactivated roots and loop because job settlement can enqueue its
    // final save in a following microtask.
    while (true) {
      const pending = [...new Set([
        ...this.jobBarriers.values(),
        ...this.saveBarriers.values(),
      ])];
      if (pending.length === 0) break;
      await Promise.all(pending);
      await Promise.resolve();
    }
  }

  isRunning(root: string, radar: RadarKind): boolean {
    return this.active.get(root)?.running.has(radar) ?? false;
  }

  /** Deterministic test/manual seam; one invocation starts at most one job per overdue radar. */
  runDue(root: string): void {
    const entry = this.active.get(root);
    if (!entry || entry.stopped || entry.pending) return;
    const now = this.now();
    for (const radar of WATCH_RADARS) {
      const due = entry.state.radars[radar];
      if (!due || Date.parse(due.nextDueAt) > now ||
          (entry.retryNotBefore[radar] ?? 0) > now || entry.running.has(radar)) continue;
      try {
        const job = this.jobs.start(entry.binding, radar);
        entry.running.set(radar, job); // per-vault/per-radar non-reentrancy
        const lifecycleDone = job.done.then(() => undefined, () => undefined);
        const priorJobs = this.jobBarriers.get(root) ?? Promise.resolve();
        const jobsBarrier = Promise.all([priorJobs, lifecycleDone]).then(() => undefined);
        this.jobBarriers.set(root, jobsBarrier);
        void jobsBarrier.then(() => {
          if (this.jobBarriers.get(root) === jobsBarrier) this.jobBarriers.delete(root);
        });
        const settled = job.done.then(
          () => this.finish(entry, radar, true, this.now()),
          (error) => this.finish(entry, radar, false, this.now(), error),
        );
        // finish() never rejects and routes every failure through report(); this final net keeps the
        // derived chain from surfacing an unhandled rejection even if a future change lets one escape.
        void settled.catch((escape) => this.report(entry.binding.root, escape));
      } catch (startError) {
        // Synchronous host failures must not escape the timer callback or hot-loop an overdue radar.
        entry.retryNotBefore[radar] = now + this.options.intervalMs;
        this.report(entry.binding.root, startError);
      }
    }
    this.arm(entry);
  }

  private async finish(
    entry: ActiveVault,
    radar: RadarKind,
    completed: boolean,
    settledAt: number,
    error?: unknown,
  ): Promise<void> {
    const root = entry.binding.root;
    // The barrier is scheduler-global, not entry-local: a new activation must wait for every state
    // transaction started by the previous generation before it loads a durable snapshot.
    const predecessor = this.saveBarriers.get(root) ?? Promise.resolve();
    const persist = predecessor.then(async () => {
      let accepted = false;
      let next: WatchState | undefined;
      const now = settledAt;
      try {
        if (entry.stopped) return;
        const previous = entry.durableState === undefined ? undefined : structuredClone(entry.durableState);
        next = structuredClone(entry.state);
        const prior = next.radars[radar];
        next.radars[radar] = {
          ...(completed
            ? { lastCompletedAt: new Date(now).toISOString() }
            : prior?.lastCompletedAt
              ? { lastCompletedAt: prior.lastCompletedAt }
              : {}),
          nextDueAt: new Date(now + this.options.intervalMs).toISOString(),
        };
        await this.persistence.save(root, previous, next);
        accepted = true;
      } catch (persistError) {
        // A rejected/unknown transaction may mean durable state moved. Reload it before any retry;
        // never loop forever with a stale CAS baseline. Backoff starts when failure is observed.
        entry.retryNotBefore[radar] = this.now() + this.options.intervalMs;
        this.report(root, persistError);
        try {
          const refreshed = await this.persistence.load(root);
          entry.durableState = refreshed === undefined ? undefined : structuredClone(refreshed);
          const refreshedRuntime: WatchState = refreshed && refreshed.configFingerprint === this.options.configFingerprint
            ? structuredClone(refreshed)
            : { version: 1, configFingerprint: this.options.configFingerprint, radars: {} };
          const retryIso = new Date(this.now()).toISOString();
          for (const kind of WATCH_RADARS) {
            if (!refreshedRuntime.radars[kind]) refreshedRuntime.radars[kind] = { nextDueAt: retryIso };
          }
          entry.state = refreshedRuntime;
        } catch (reloadError) {
          this.report(root, reloadError);
        }
      }
      entry.running.delete(radar);
      if (accepted && next) {
        entry.durableState = structuredClone(next);
        entry.state = next;
        delete entry.retryNotBefore[radar];
      }
      if (error !== undefined) this.report(root, error);
      this.arm(entry);
    });
    const tail = persist.then(
      () => undefined,
      (rejected) => this.report(root, rejected),
    );
    entry.saveChain = tail;
    this.saveBarriers.set(root, tail);
    void tail.then(() => {
      if (this.saveBarriers.get(root) === tail) this.saveBarriers.delete(root);
    });
    await tail;
  }

  /** onError isolation: a throwing observer must not unhandled-reject or poison saveChain. */
  private report(root: string, error: unknown): void {
    try {
      this.options.onError?.(root, error);
    } catch {
      // Observer errors are swallowed here — they must never surface as an unhandled rejection
      // or poison the serialized save chain.
    }
  }

  private arm(entry: ActiveVault): void {
    if (entry.stopped || entry.pending) return;
    if (entry.timer) this.clearTimer(entry.timer);
    let next = Number.POSITIVE_INFINITY;
    for (const radar of WATCH_RADARS) {
      if (entry.running.has(radar)) continue;
      const at = entry.state.radars[radar]?.nextDueAt;
      if (at) {
        const durableDue = Date.parse(at);
        next = Math.min(next, Math.max(durableDue, entry.retryNotBefore[radar] ?? 0));
      }
    }
    if (!Number.isFinite(next)) return;
    // Node clamps larger delays to 1ms. Wake at the platform maximum and re-arm instead.
    const delay = Math.min(2_147_483_647, Math.max(0, next - this.now()));
    entry.timer = this.setTimer(() => this.runDue(entry.binding.root), delay);
  }
}