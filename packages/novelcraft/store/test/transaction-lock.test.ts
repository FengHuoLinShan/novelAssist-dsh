import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireVaultWriteLock,
  readLockMetadata,
  LOCK_METADATA_FILENAME,
  type LockMetadata,
  type LockProbe,
} from '../src/transaction/lock.js';
import { StoreError } from '../src/errors.js';

// ============================================================================
// per-vault 跨进程写锁(ADR-0021 §3 / N32)行为契约。
// 覆盖: 互斥(原子 mkdir + 真实子进程)/ waitMs 策略 / stale 回收与 fail-closed(未知
// 元数据/远端 host/存活 pid 不回收)/ 心跳 / owner nonce 校验释放 / symlink 路径安全。
// 用「真实子进程」与「可注入 clock/process probe」双路覆盖; 断言注释引 N32。
//
// 独立审查回归(2026):
//   high  —— 双回收竞态: 两个真实子进程实际调用生产 acquire/release, 同时竞争
//            (a)空锁与(b)stale 锁; 断言恰好一个成功, loser 不移动/删除 winner 的
//            新活锁(锁目录/owner nonce/pid 逐项核对 + 无 .reclaim-* 残留)。
//   medium—— heartbeat/release/acquire 的全部 FS 错误统一转换为 StoreError
//            (CONFLICT)且保留现场; 清理错误不遮蔽主错误; 失败后所有权保留可重试。
// 子进程 bundle: 测试用 esbuild 把「生产 src/transaction/lock.ts」打成单文件再以
// 真实 node 进程 spawn —— 子进程调用的是与单测同源的当前生产实现(非手写夹具)。
// ============================================================================

const cleanups: Array<() => void> = [];
const children: ChildProcess[] = [];

function tmpVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-lock-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const LOCKS_SUBPATH_FIXTURE = path.join('novelcraft', 'locks', 'vault-write');

function lockDirOf(root: string): string {
  return path.join(root, '.git', LOCKS_SUBPATH_FIXTURE);
}

function metaFileOf(root: string): string {
  return path.join(lockDirOf(root), LOCK_METADATA_FILENAME);
}

function readMeta(root: string): LockMetadata | null {
  try {
    return readLockMetadata(metaFileOf(root));
  } catch {
    return null;
  }
}

function reclaimLeftovers(root: string): string[] {
  try {
    return fs.readdirSync(path.dirname(lockDirOf(root))).filter((f) => f.startsWith('.reclaim-'));
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const c of children) {
    if (c.exitCode === null) c.kill();
  }
  children.length = 0;
  while (cleanups.length) cleanups.pop()!();
});

// ---------- fake clock/process probe(确定性覆盖 stale/宽限期/预算) ----------

interface FakeProbe extends LockProbe {
  advance(ms: number): void;
  time(): number;
  setAlive(alive: boolean): void;
}

function fakeProbe(opts?: {
  hostname?: string;
  alive?: boolean;
  onSleep?: (ms: number) => void;
}): FakeProbe {
  let t = 1_000_000; // 固定时钟起点, 测试内 advance 推进
  let alive = opts?.alive ?? true;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    time: () => t,
    setAlive: (v) => {
      alive = v;
    },
    hostname: () => opts?.hostname ?? 'test-host',
    isProcessAlive: () => alive,
    sleep: async (ms) => {
      t += ms;
      opts?.onSleep?.(ms);
    },
  };
}

/** 摆一个「外部持锁者」的锁目录 + metadata(fake probe 场景用)。 */
function plantForeignLock(root: string, overrides: Partial<LockMetadata> & { nonce: string }): void {
  const meta: LockMetadata = {
    version: 1,
    pid: 4242,
    hostname: 'test-host',
    acquiredAt: 1_000_000,
    heartbeatAt: 1_000_000,
    ...overrides,
  };
  fs.mkdirSync(path.dirname(lockDirOf(root)), { recursive: true });
  fs.mkdirSync(lockDirOf(root));
  fs.writeFileSync(metaFileOf(root), JSON.stringify(meta), 'utf8');
}

/** 直接摆原始字节的锁 metadata(损坏/未知 schema 场景)。 */
function plantRawLock(root: string, raw: string): void {
  fs.mkdirSync(path.dirname(lockDirOf(root)), { recursive: true });
  fs.mkdirSync(lockDirOf(root));
  fs.writeFileSync(metaFileOf(root), raw, 'utf8');
}

// ---------- 真实子进程持锁者(跨进程互斥 / 崩溃 stale 回收; 手写夹具) ----------

function holderScript(mode: 'release' | 'crash'): string {
  // mode=crash: 写入过期心跳(10 秒前)后立即退出(模拟持锁崩溃未释放);
  // mode=release: 等待 stdin 一行后按协议释放退出。
  const heartbeat = mode === 'crash' ? 'Date.now() - 10000' : 'Date.now()';
  const tail =
    mode === 'crash'
      ? `process.exit(1);`
      : `process.stdin.once('data', () => {
  fs.rmSync(lockDir, { recursive: true, force: true });
  process.stdout.write('RELEASED\\n');
  process.exit(0);
});`;
  return `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.argv[2];
const lockDir = path.join(root, '.git', 'novelcraft', 'locks', 'vault-write');
fs.mkdirSync(path.dirname(lockDir), { recursive: true });
fs.mkdirSync(lockDir);
const meta = {
  version: 1,
  pid: process.pid,
  hostname: os.hostname(),
  nonce: 'child-' + process.pid,
  acquiredAt: Date.now(),
  heartbeatAt: ${heartbeat},
};
fs.writeFileSync(path.join(lockDir, 'lock.json'), JSON.stringify(meta), 'utf8');
process.stdout.write('HELD\\n');
${tail}
`;
}

function spawnHolder(root: string, mode: 'release' | 'crash'): {
  child: ChildProcess;
  exit: Promise<{ code: number | null; stderr: string }>;
} {
  const script = path.join(
    os.tmpdir(),
    `nvc-lock-holder-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  fs.writeFileSync(script, holderScript(mode), 'utf8');
  cleanups.push(() => fs.rmSync(script, { force: true }));
  const child = spawn(process.execPath, [script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  return { child, exit };
}

function waitForLine(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(line)) resolve();
    });
    child.on('exit', (code) => reject(new Error(`child exited ${code} before ${JSON.stringify(line)}`)));
    child.on('error', reject);
  });
}

function patchHeartbeat(root: string, heartbeatAt: number): void {
  const p = metaFileOf(root);
  const meta = JSON.parse(fs.readFileSync(p, 'utf8')) as LockMetadata;
  fs.writeFileSync(p, JSON.stringify({ ...meta, heartbeatAt }), 'utf8');
}

// ============================================================================
// 生产子进程基建(独立审查 high): esbuild 打包「生产 src/transaction/lock.ts」
// 成单文件, 真实 node 子进程 import 后调用生产 acquire/release —— 与单测同源、
// 永远是最新实现, 不依赖 dist 构建状态。
// ============================================================================

/** 子进程入口(纯 JS, 由 esbuild bundle; 协议: LOCKED/RELEASED/ERROR 行 + stdin 释放)。 */
function productionChildSource(lockTsPath: string): string {
  return [
    `import { acquireVaultWriteLock } from ${JSON.stringify(lockTsPath)};`,
    `const mode = process.argv[2];`,
    `const root = process.argv[3];`,
    `const staleMs = Number(process.argv[4] ?? '0');`,
    `const watchdog = setTimeout(() => { process.stderr.write('child watchdog timeout\\n'); process.exit(2); }, 30_000);`,
    `function emit(line) { process.stdout.write(line + '\\n'); }`,
    `async function main() {`,
    `  if (mode !== 'acquire') { emit('ERROR UNKNOWN-MODE ' + mode); process.exit(0); }`,
    `  let lock;`,
    `  try {`,
    `    lock = await acquireVaultWriteLock(root, { waitMs: 0, staleMs });`,
    `  } catch (err) {`,
    `    const code = (err && err.code) || 'UNKNOWN';`,
    `    const msg = String((err && err.message) || err).replace(/\\n/g, ' ');`,
    `    emit('ERROR ' + code + ' ' + msg);`,
    `    process.exit(0);`,
    `  }`,
    `  emit('LOCKED ' + lock.nonce + ' ' + lock.pid + ' ' + lock.hostname);`,
    `  await new Promise((resolve) => {`,
    `    process.stdin.resume();`,
    `    process.stdin.once('data', () => resolve(undefined));`,
    `  });`,
    `  try {`,
    `    lock.release();`,
    `  } catch (err) {`,
    `    emit('ERROR ' + ((err && err.code) || 'UNKNOWN') + ' ' + String((err && err.message) || err));`,
    `    process.exit(1);`,
    `  }`,
    `  emit('RELEASED');`,
    `  clearTimeout(watchdog);`,
    `  process.exit(0);`,
    `}`,
    `main().catch((err) => { emit('ERROR FATAL ' + String((err && err.message) || err)); process.exit(1); });`,
  ].join('\n');
}

let bundlePromise: Promise<string> | null = null;
const bundleDirs: string[] = [];
// bundle 目录生命周期独立于每测试的 cleanups(afterEach 会弹栈清理, 而 bundle 要在
// 多个测试间复用) → 挂进程退出时尽力清理。
process.once('exit', () => {
  for (const d of bundleDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function getProductionChildBundle(): Promise<string> {
  if (bundlePromise === null) {
    bundlePromise = (async () => {
      const esbuild = (await import('esbuild')) as { build: (o: object) => Promise<unknown> };
      const lockTs = fileURLToPath(new URL('../src/transaction/lock.ts', import.meta.url));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-lock-child-'));
      bundleDirs.push(dir);
      const entry = path.join(dir, 'lock-child.ts');
      const outfile = path.join(dir, 'lock-child.mjs');
      fs.writeFileSync(entry, productionChildSource(lockTs), 'utf8');
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        outfile,
        logLevel: 'silent',
      });
      return outfile;
    })();
  }
  return bundlePromise;
}

interface LockChild {
  proc: ChildProcess;
  /** readline 收集的完整行(诊断用; 判定一律用 settled, 见 runTwoChildRace)。 */
  lines: string[];
  raw: string;
  stderr: string;
  /** 竞争判定行(LOCKED <nonce> <pid> <host> 或 ERROR <code> <msg>), 事件驱动确定。 */
  settled: string;
}

/** spawn 一个调用生产 acquire/release 的真实子进程(自动收尾 + 输出收集)。 */
async function spawnLockChild(root: string, staleMs: number): Promise<LockChild> {
  const bundle = await getProductionChildBundle();
  const proc = spawn(process.execPath, [bundle, 'acquire', root, String(staleMs)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(proc);
  const lines: string[] = [];
  const rl = readline.createInterface({ input: proc.stdout! });
  rl.on('line', (l) => lines.push(l));
  let raw = '';
  proc.stdout!.on('data', (d: Buffer) => {
    raw += d.toString();
  });
  let stderr = '';
  proc.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  return { proc, lines, raw, stderr, settled: '' };
}

/**
 * 事件驱动等待子进程输出匹配某行(显式超时, 不 sleep 忙等); resolve 值为匹配行。
 * 判定以本函数事件(原始 data 监听)为准, 不依赖 readline 收集的 lines 数组
 * (独立审查回归: lines 数组曾与判定行不一致导致 flaky 断言)。
 */
function waitForLineTimeout(proc: ChildProcess, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`超时等待子进程输出 ${pattern}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (pattern.test(line)) {
          clearTimeout(timer);
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`子进程提前退出 code=${code}, 未匹配 ${pattern}`));
    };
    const onError = (e: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      proc.stdout!.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
    };
    proc.stdout!.on('data', onData);
    proc.on('exit', onExit);
    proc.on('error', onError);
  });
}

/**
 * 双生产子进程竞争一把锁: 等双方各自 settle(赢家 LOCKED / 输家 ERROR)后返回;
 * 判定行记录在各自 `settled`(事件驱动, 确定), 不代发 release, 由调用方检查现场
 * 后再释放。
 */
async function runTwoChildRace(root: string, staleMs: number, timeoutMs = 30_000): Promise<{ a: LockChild; b: LockChild }> {
  const a = await spawnLockChild(root, staleMs);
  const b = await spawnLockChild(root, staleMs);
  const settle = async (c: LockChild): Promise<void> => {
    c.settled = await waitForLineTimeout(c.proc, /^(LOCKED |ERROR )/, timeoutMs).catch(
      (e: unknown) => {
        throw new Error(
          `${(e as Error).message}; stderr=${JSON.stringify(c.stderr.slice(-600))}; raw=${JSON.stringify(c.raw.slice(-600))}; lines=${JSON.stringify(c.lines)}`,
        );
      },
    );
  };
  await Promise.all([settle(a), settle(b)]);
  return { a, b };
}

/** 等待子进程真正退出(已退出则立即返回); 消除 exitCode 采样竞态。 */
function childExit(c: ChildProcess): Promise<number | null> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(c.exitCode);
  return new Promise((resolve) => c.once('exit', (code) => resolve(code)));
}

function settledLine(prefix: string, ...cs: LockChild[]): string | undefined {
  for (const c of cs) {
    if (c.settled.startsWith(prefix)) return c.settled;
  }
  return undefined;
}

function winnerOf(a: LockChild, b: LockChild): LockChild {
  return a.settled.startsWith('LOCKED ') ? a : b;
}

/** 竞争现场诊断(失败时附在断言消息里, 不参与判定)。 */
function raceDiagnostics(a: LockChild, b: LockChild): string {
  return `a: settled=${JSON.stringify(a.settled)} lines=${JSON.stringify(a.lines)} raw=${JSON.stringify(a.raw)} stderr=${JSON.stringify(a.stderr)}; b: settled=${JSON.stringify(b.settled)} lines=${JSON.stringify(b.lines)} raw=${JSON.stringify(b.raw)} stderr=${JSON.stringify(b.stderr)}`;
}

/** 让赢家经生产 release 释放并等待其真正退出。 */
async function releaseWinner(winner: LockChild): Promise<void> {
  winner.proc.stdin!.write('release\n');
  await waitForLineTimeout(winner.proc, /^RELEASED/, 15_000);
  await childExit(winner.proc);
}

/**
 * 取得一个确认已死亡的 pid(真实 kill(pid,0) → ESRCH), 供 stale 夹具使用。
 * 用 spawnSync 同步收尾: 子进程完全退出后 stdout 已全部到达, 不存在
 * write+exit 的管道刷新竞态。
 */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  const pid = Number((res.stdout ?? '').trim());
  if (res.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`无法取得已死 pid: status=${res.status} stdout=${JSON.stringify(res.stdout)}`);
  }
  return pid;
}

// ============================================================================

describe('transaction/lock — 每 vault 跨进程写锁(N32/ADR-0021 §3)', () => {
  // ---------- 获取 / 互斥 ----------

  it('acquire 以原子 mkdir 建锁目录并写六字段 metadata; release 清理(N32)', async () => {
    const root = tmpVault();
    const lock = await acquireVaultWriteLock(root); // 默认 probe(真实时钟/pid)
    expect(lock.holdsLock()).toBe(true);
    expect(fs.existsSync(lockDirOf(root))).toBe(true);
    const meta = readMeta(root)!;
    // metadata 六字段白名单(ADR-0021 §8): version/pid/hostname/nonce/acquiredAt/heartbeatAt。
    expect(Object.keys(meta).sort()).toEqual([
      'acquiredAt',
      'heartbeatAt',
      'hostname',
      'nonce',
      'pid',
      'version',
    ]);
    expect(meta.version).toBe(1);
    expect(meta.pid).toBe(process.pid);
    expect(meta.hostname).toBe(os.hostname());
    expect(meta.nonce).toBe(lock.nonce);
    expect(meta.acquiredAt).toBeGreaterThan(0);
    expect(meta.heartbeatAt).toBe(meta.acquiredAt);
    lock.release();
    expect(lock.holdsLock()).toBe(false);
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  it('默认 waitMs=0: 占用中立即 CONFLICT, 绝不无锁继续(fail-closed, N32)', async () => {
    const root = tmpVault();
    const a = await acquireVaultWriteLock(root);
    await expect(acquireVaultWriteLock(root)).rejects.toMatchObject({ code: 'CONFLICT' });
    // 原锁未被触碰。
    expect(readMeta(root)!.nonce).toBe(a.nonce);
    a.release();
    const b = await acquireVaultWriteLock(root);
    expect(b.nonce).not.toBe(a.nonce);
    b.release();
  });

  it('waitMs 预算内对方释放则可获取; 预算耗尽 → CONFLICT(可配最多 5 秒, N32)', async () => {
    const root = tmpVault();
    const probe = fakeProbe();
    const a = await acquireVaultWriteLock(root, { probe });
    // 等锁者: 第 2 次轮询时持锁方释放 → 第 3 次 mkdir 成功。
    let sleeps = 0;
    const waiter = fakeProbe({
      onSleep: () => {
        sleeps++;
        if (sleeps === 2) fs.rmSync(lockDirOf(root), { recursive: true, force: true });
      },
    });
    const b = await acquireVaultWriteLock(root, { waitMs: 5000, pollMs: 25, probe: waiter });
    expect(b.holdsLock()).toBe(true);
    expect(sleeps).toBe(2);
    b.release();
    a.release(); // 目录已被 b.release 删除 → 幂等 no-op
    // 永不释放 → 预算耗尽 CONFLICT, 锁保持原 owner。
    const c = await acquireVaultWriteLock(root, { probe: fakeProbe() });
    const exhausted = fakeProbe();
    await expect(
      acquireVaultWriteLock(root, { waitMs: 100, pollMs: 25, probe: exhausted }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readMeta(root)!.nonce).toBe(c.nonce);
    c.release();
  });

  it('waitMs 越界(>5 秒/负数/非整数) → VALIDATION_FAILED; 边界 5000ms 合法', async () => {
    const root = tmpVault();
    for (const waitMs of [5001, -1, 1.5, Number.NaN]) {
      await expect(acquireVaultWriteLock(root, { waitMs })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    const lock = await acquireVaultWriteLock(root, { waitMs: 5000 });
    lock.release();
  });

  // ---------- 真实子进程: 跨进程互斥 + 崩溃 stale 回收 ----------

  it('真实子进程持锁期间互斥(立即拒绝); 子进程释放后本进程可获取(N32 跨进程锁)', async () => {
    const root = tmpVault();
    const holder = spawnHolder(root, 'release');
    await waitForLine(holder.child, 'HELD');
    await expect(acquireVaultWriteLock(root, { waitMs: 0 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    holder.child.stdin!.write('release\n');
    const { code, stderr } = await holder.exit;
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const lock = await acquireVaultWriteLock(root);
    expect(lock.holdsLock()).toBe(true);
    lock.release();
  });

  it('真实子进程崩溃退出(未释放): 心跳过期 + 同 host + pid 死亡 → 自动回收(N32)', async () => {
    const root = tmpVault();
    const holder = spawnHolder(root, 'crash'); // 写过期心跳后立即 exit(1), 不释放
    const { code } = await holder.exit;
    expect(code).toBe(1);
    // 子进程 pid 已死亡(真实 kill(pid,0) → ESRCH), heartbeatAt 已过期 → 首轮即回收。
    const lock = await acquireVaultWriteLock(root, { staleMs: 100, waitMs: 0 });
    expect(lock.nonce).not.toMatch(/^child-/);
    expect(readMeta(root)!.pid).toBe(process.pid);
    // 回收用的重命名副本已清理, 不留 `.reclaim-*` 垃圾。
    expect(reclaimLeftovers(root)).toEqual([]);
    lock.release();
  });

  it('真实子进程存活: 即使心跳过期也拒绝回收(fail-closed, N32)', async () => {
    const root = tmpVault();
    const holder = spawnHolder(root, 'release');
    await waitForLine(holder.child, 'HELD');
    patchHeartbeat(root, Date.now() - 10_000); // 心跳过期, 但 holder 进程仍存活
    await expect(
      acquireVaultWriteLock(root, { staleMs: 100, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readMeta(root)!.nonce).toMatch(/^child-/); // 子进程的锁未被误删
    holder.child.stdin!.write('release\n');
    expect((await holder.exit).code).toBe(0);
  });

  // ---------- 独立审查 high: 双真实子进程竞争(生产 acquire/release) ----------

  it(
    '双真实子进程竞争空锁: 恰好一个 acquire 成功, loser 立即 CONFLICT 且不移动/删除 winner 的锁',
    { timeout: 60_000 },
    async () => {
      const root = tmpVault();
      // staleMs 必须为正整数(否则 VALIDATION_FAILED); 空锁场景无 stale 判定, 100ms 即可。
      const { a, b } = await runTwoChildRace(root, 100);
      // 判定以事件驱动的 settled 行为准(不依赖 readline lines 数组, 消除观察竞态)。
      const locked = settledLine('LOCKED ', a, b);
      expect(locked, raceDiagnostics(a, b)).toBeTruthy();
      expect([a, b].filter((c) => c.settled.startsWith('LOCKED ')), raceDiagnostics(a, b)).toHaveLength(1);
      // 输家必须是锁占用 CONFLICT(fail-closed, N32)——绝不允许误报 PATH_TRAVERSAL
      // 等无关错误码(独立审查回归: 回收 rename 竞态曾让输家误报 PATH_TRAVERSAL)。
      expect([a, b].filter((c) => c.settled.startsWith('ERROR CONFLICT')), raceDiagnostics(a, b)).toHaveLength(1);
      const winner = winnerOf(a, b);
      const [, nonce, pidStr] = locked!.split(' ');
      expect(nonce).toBeTruthy();
      expect(Number(pidStr)).toBe(winner.proc.pid);
      // loser 不移动/删除 winner: 锁目录仍在、metadata 仍是 winner 的 nonce/pid、
      // 无 `.reclaim-*` 残留(第二回收者不得基于旧快照重占)。
      expect(fs.existsSync(lockDirOf(root))).toBe(true);
      const meta = readMeta(root)!;
      expect(meta.nonce).toBe(nonce);
      expect(meta.pid).toBe(winner.proc.pid);
      expect(reclaimLeftovers(root)).toEqual([]);
      // winner 经生产 release 释放 → 锁清理; 双方都以 0 真正退出(先等 exit 事件,
      // 消除 exitCode 采样竞态), 且双方 stderr 均为空(无错误输出)。
      await releaseWinner(winner);
      expect(await childExit(a.proc), raceDiagnostics(a, b)).toBe(0);
      expect(await childExit(b.proc), raceDiagnostics(a, b)).toBe(0);
      expect(a.stderr, raceDiagnostics(a, b)).toBe('');
      expect(b.stderr, raceDiagnostics(a, b)).toBe('');
      expect(fs.existsSync(lockDirOf(root))).toBe(false);
    },
  );

  it(
    '双真实子进程竞争 stale 锁: 恰好一个回收成功, loser 不移动/删除 winner 的新活锁(claim 后验证)',
    { timeout: 60_000 },
    async () => {
      const root = tmpVault();
      // 真实已死 pid + 过期心跳 + 本机 hostname → 两个孩子都判定 stale。
      const stalePid = deadPid();
      plantForeignLock(root, {
        nonce: 'stale-owner',
        pid: stalePid,
        hostname: os.hostname(),
        acquiredAt: Date.now() - 120_000,
        heartbeatAt: Date.now() - 60_000,
      });
      const { a, b } = await runTwoChildRace(root, 100); // staleMs=100 → 必然 stale
      const locked = settledLine('LOCKED ', a, b);
      expect(locked, raceDiagnostics(a, b)).toBeTruthy();
      // 最多一个 acquire 成功(独立审查 high 核心): 两个回收者竞争同一 stale 锁。
      expect([a, b].filter((c) => c.settled.startsWith('LOCKED ')), raceDiagnostics(a, b)).toHaveLength(1);
      // 输家必须是 CONFLICT(fail-closed, N32)——回收 rename 竞态不得误报
      // PATH_TRAVERSAL(独立审查回归修复的正是这一点)。
      expect([a, b].filter((c) => c.settled.startsWith('ERROR CONFLICT')), raceDiagnostics(a, b)).toHaveLength(1);
      const winner = winnerOf(a, b);
      const [, nonce] = locked!.split(' ');
      expect(nonce).not.toBe('stale-owner'); // 赢家是新 nonce(真回收, 非原锁)
      // loser 未基于旧快照移动/删除 winner 的新活锁: 锁目录仍在、owner 是 winner、
      // 无 `.reclaim-*` 残留(winner 清理了自己的 trash; loser 还原/未留下任何副本)。
      expect(fs.existsSync(lockDirOf(root))).toBe(true);
      const meta = readMeta(root)!;
      expect(meta.nonce).toBe(nonce);
      expect(meta.pid).toBe(winner.proc.pid);
      expect(reclaimLeftovers(root)).toEqual([]);
      await releaseWinner(winner);
      // 双方都以 0 真正退出(先等 exit 事件, 消除 exitCode 采样竞态), stderr 为空。
      expect(await childExit(a.proc), raceDiagnostics(a, b)).toBe(0);
      expect(await childExit(b.proc), raceDiagnostics(a, b)).toBe(0);
      expect(a.stderr, raceDiagnostics(a, b)).toBe('');
      expect(b.stderr, raceDiagnostics(a, b)).toBe('');
      expect(fs.existsSync(lockDirOf(root))).toBe(false);
    },
  );

  // ---------- stale 回收与 fail-closed(fake probe + 真实 fs) ----------

  it('同 host + pid 死亡 + 心跳过期 → 回收(fake probe; N32)', async () => {
    const root = tmpVault();
    plantForeignLock(root, { nonce: 'dead-owner', pid: 987654, heartbeatAt: 990_000 });
    const lock = await acquireVaultWriteLock(root, {
      probe: fakeProbe({ alive: false }),
      staleMs: 300,
      waitMs: 0,
    });
    expect(lock.nonce).not.toBe('dead-owner');
    expect(readMeta(root)!.pid).toBe(process.pid);
    expect(reclaimLeftovers(root)).toEqual([]);
    lock.release();
  });

  it('存活 pid(含 pid 复用)+ 心跳过期 → 不回收; 等待期间也不回收(N32 fail-closed)', async () => {
    const root = tmpVault();
    plantForeignLock(root, { nonce: 'live-owner', pid: 987654, heartbeatAt: 990_000 });
    const probe = fakeProbe({ alive: true });
    await expect(
      acquireVaultWriteLock(root, { probe, staleMs: 300, waitMs: 100, pollMs: 20 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readMeta(root)!.nonce).toBe('live-owner'); // 未被删除/覆盖
  });

  it('远端 host + pid 死亡 + 心跳过期 → 不回收(fail-closed, N32)', async () => {
    const root = tmpVault();
    plantForeignLock(root, { nonce: 'remote-owner', hostname: 'other-host', pid: 987654, heartbeatAt: 990_000 });
    await expect(
      acquireVaultWriteLock(root, { probe: fakeProbe(), staleMs: 300, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readMeta(root)!.nonce).toBe('remote-owner');
  });

  it('pid 死亡但心跳新鲜(宽限期未过) → 不回收(fail-closed, N32)', async () => {
    const root = tmpVault();
    // heartbeatAt 与 fake 时钟同刻 → 未过 stale 窗口, 即使 pid 已死也不回收。
    plantForeignLock(root, { nonce: 'fresh-dead', pid: 987654, heartbeatAt: 1_000_000 });
    await expect(
      acquireVaultWriteLock(root, { probe: fakeProbe({ alive: false }), staleMs: 300, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readMeta(root)!.nonce).toBe('fresh-dead');
    // 时钟推过 stale 窗口 + pid 死亡 → 此时才回收。
    const probe = fakeProbe({ alive: false });
    probe.advance(10_000);
    const lock = await acquireVaultWriteLock(root, { probe, staleMs: 300, waitMs: 0 });
    expect(lock.nonce).not.toBe('fresh-dead');
    lock.release();
  });

  const corruptMetadataCases: Array<{ name: string; raw: string }> = [
    { name: '非法 JSON', raw: 'not-json{{{' },
    { name: '空对象', raw: '{}' },
    { name: '缺字段(heartbeatAt)', raw: JSON.stringify({ version: 1, pid: 1, hostname: 'h', nonce: 'n', acquiredAt: 0 }) },
    { name: 'version 不符', raw: JSON.stringify({ version: 2, pid: 1, hostname: 'h', nonce: 'n', acquiredAt: 0, heartbeatAt: 0 }) },
    { name: '未知多余字段', raw: JSON.stringify({ version: 1, pid: 1, hostname: 'h', nonce: 'n', acquiredAt: 0, heartbeatAt: 0, owner: 'x' }) },
    { name: 'pid 非正整数', raw: JSON.stringify({ version: 1, pid: -3, hostname: 'h', nonce: 'n', acquiredAt: 0, heartbeatAt: 0 }) },
    { name: '超大内容', raw: '{"version":1,"pid":1,"hostname":"' + 'a'.repeat(5000) + '","nonce":"n","acquiredAt":0,"heartbeatAt":0}' },
  ];
  for (const c of corruptMetadataCases) {
    it(`未知/损坏 metadata 不回收(fail-closed): ${c.name}`, async () => {
      const root = tmpVault();
      plantRawLock(root, c.raw);
      await expect(
        acquireVaultWriteLock(root, { probe: fakeProbe({ alive: false }), staleMs: 300, waitMs: 0 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(fs.existsSync(lockDirOf(root))).toBe(true); // 现场保留, 需人工
    });
  }

  it('锁目录存在但无 metadata(半写残留) → 不回收(fail-closed, 需人工清理)', async () => {
    const root = tmpVault();
    fs.mkdirSync(path.dirname(lockDirOf(root)), { recursive: true });
    fs.mkdirSync(lockDirOf(root)); // 空目录, 无 metadata
    await expect(
      acquireVaultWriteLock(root, { probe: fakeProbe({ alive: false }), staleMs: 300, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.existsSync(lockDirOf(root))).toBe(true);
  });

  // ---------- 心跳 ----------

  it('heartbeat 刷新 heartbeatAt; stale 判定以 heartbeatAt 为准(N32 心跳/超时)', async () => {
    const root = tmpVault();
    const probe = fakeProbe();
    const a = await acquireVaultWriteLock(root, { probe });
    probe.advance(1_000);
    // 未心跳: heartbeatAt 已过期 1s(文件与句柄一致)。
    expect(readMeta(root)!.heartbeatAt).toBe(1_000_000);
    expect(a.heartbeatAt).toBe(1_000_000);
    a.heartbeat();
    expect(readMeta(root)!.heartbeatAt).toBe(probe.time());
    expect(a.heartbeatAt).toBe(probe.time());
    // 心跳后 heartbeatAt 新鲜: 即使 probe 判定 pid 死亡也不回收(宽限期生效)。
    await expect(
      acquireVaultWriteLock(root, { probe: fakeProbe({ alive: false }), staleMs: 300, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    a.release();
  });

  it('已释放锁上 heartbeat 抛 CONFLICT; release 幂等(N32)', async () => {
    const root = tmpVault();
    const a = await acquireVaultWriteLock(root);
    a.release();
    expect(a.holdsLock()).toBe(false);
    expect(() => a.heartbeat()).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => a.release()).not.toThrow(); // 幂等
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  // ---------- 错误释放: owner nonce/pid/hostname 校验(N32) ----------

  it('非 owner nonce/pid 释放 → CONFLICT 且锁保留(fail-closed, N32)', async () => {
    const root = tmpVault();
    const a = await acquireVaultWriteLock(root);
    const original = readMeta(root)!;
    // 篡改 nonce → 本 handle 必须拒绝释放。
    fs.writeFileSync(metaFileOf(root), JSON.stringify({ ...original, nonce: 'someone-else' }), 'utf8');
    expect(() => a.release()).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(fs.existsSync(lockDirOf(root))).toBe(true); // 锁保留
    expect(readMeta(root)!.nonce).toBe('someone-else');
    // 篡改 pid → 仍拒绝。
    fs.writeFileSync(metaFileOf(root), JSON.stringify({ ...original, pid: 1 }), 'utf8');
    expect(() => a.release()).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(fs.existsSync(lockDirOf(root))).toBe(true);
    // 恢复 owner metadata 后 release 成功, 立即释放给他人。
    fs.writeFileSync(metaFileOf(root), JSON.stringify(original), 'utf8');
    a.release();
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
    const b = await acquireVaultWriteLock(root);
    expect(b.nonce).not.toBe(a.nonce);
    b.release();
  });

  it('元数据被删除(目录仍在)→ 释放/心跳 fail-closed, 不删除现场', async () => {
    const root = tmpVault();
    const a = await acquireVaultWriteLock(root);
    fs.unlinkSync(metaFileOf(root)); // 现场损坏: 目录在但 metadata 没了
    expect(() => a.release()).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(fs.existsSync(lockDirOf(root))).toBe(true);
    expect(() => a.heartbeat()).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    // 人工恢复 owner metadata 后可正常释放。
    fs.writeFileSync(
      metaFileOf(root),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: os.hostname(),
        nonce: a.nonce,
        acquiredAt: a.acquiredAt,
        heartbeatAt: a.heartbeatAt,
      }),
      'utf8',
    );
    a.release();
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  // ---------- 独立审查 medium: FS 错误统一转换为 StoreError(保留现场) ----------

  // chmod 权限语义: Windows 无效, root 不受权限约束 → 跳过。
  const permSensitive =
    process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

  it.skipIf(permSensitive)('acquire: 锁容器目录不可写 → StoreError(CONFLICT), 不产生锁目录', async () => {
    const root = tmpVault();
    const locksDir = path.dirname(lockDirOf(root));
    fs.mkdirSync(locksDir, { recursive: true });
    fs.chmodSync(locksDir, 0o555); // 无写权限 → mkdir(lockDir) EACCES
    cleanups.push(() => {
      try {
        fs.chmodSync(locksDir, 0o755);
      } catch {
        /* ignore */
      }
    });
    await expect(acquireVaultWriteLock(root)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.existsSync(lockDirOf(root))).toBe(false); // 现场: 无锁目录残留
    fs.chmodSync(locksDir, 0o755);
  });

  it.skipIf(permSensitive)('heartbeat: 锁目录不可写 → StoreError(CONFLICT), 现场保留, 恢复后可续期/释放', async () => {
    const root = tmpVault();
    const lock = await acquireVaultWriteLock(root);
    const before = readMeta(root)!;
    fs.chmodSync(lockDirOf(root), 0o555); // 可读不可写 → metadata 写入 EACCES
    cleanups.push(() => {
      try {
        fs.chmodSync(lockDirOf(root), 0o755);
      } catch {
        /* ignore */
      }
    });
    let caught: unknown;
    try {
      lock.heartbeat();
    } catch (e) {
      caught = e;
    }
    // 必须是 StoreError(CONFLICT), 不允许裸 node FS 错误泄漏。
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).code).toBe('CONFLICT');
    expect(lock.holdsLock()).toBe(true); // 失败不丢所有权
    expect(readMeta(root)!.heartbeatAt).toBe(before.heartbeatAt); // 现场保留(未被半写)
    expect(reclaimLeftovers(root)).toEqual([]);
    fs.chmodSync(lockDirOf(root), 0o755);
    lock.heartbeat(); // 恢复后可续期
    expect(readMeta(root)!.heartbeatAt).toBeGreaterThan(before.heartbeatAt);
    lock.release();
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  it.skipIf(permSensitive)('release: 锁目录不可写 → StoreError(CONFLICT), 所有权保留可重试, 恢复后释放成功', async () => {
    const root = tmpVault();
    const lock = await acquireVaultWriteLock(root);
    fs.chmodSync(lockDirOf(root), 0o555);
    cleanups.push(() => {
      try {
        fs.chmodSync(lockDirOf(root), 0o755);
      } catch {
        /* ignore */
      }
    });
    let caught: unknown;
    try {
      lock.release();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).code).toBe('CONFLICT');
    expect(lock.holdsLock()).toBe(true); // 释放失败 → 仍持有, 可重试
    expect(fs.existsSync(lockDirOf(root))).toBe(true); // 现场保留(未删除他人可查证据)
    expect(readMeta(root)!.nonce).toBe(lock.nonce);
    fs.chmodSync(lockDirOf(root), 0o755);
    lock.release();
    expect(lock.holdsLock()).toBe(false);
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  it.skipIf(permSensitive)('锁目录不可读(0o000): heartbeat/release 拒绝且零删除(StoreError CONFLICT)', async () => {
    const root = tmpVault();
    const lock = await acquireVaultWriteLock(root);
    fs.chmodSync(lockDirOf(root), 0o000); // 不可读 → verifyOwned 读 metadata 失败
    cleanups.push(() => {
      try {
        fs.chmodSync(lockDirOf(root), 0o755);
      } catch {
        /* ignore */
      }
    });
    for (const op of [() => lock.heartbeat(), () => lock.release()] as Array<() => void>) {
      let caught: unknown;
      try {
        op();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StoreError);
      expect((caught as StoreError).code).toBe('CONFLICT');
      expect(fs.existsSync(lockDirOf(root))).toBe(true); // 绝不删除现场
    }
    fs.chmodSync(lockDirOf(root), 0o755);
    lock.release();
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });

  // ---------- symlink / 路径安全(N32 path allowlist, ADR-0021 §8) ----------

  it('.git 缺失 → NOT_A_GIT_REPO; .git 为普通文件 → 拒绝(fail-closed)', async () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-lock-nogit-'));
    cleanups.push(() => fs.rmSync(noGit, { recursive: true, force: true }));
    await expect(acquireVaultWriteLock(noGit)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });

    const fileGit = tmpVault();
    fs.rmSync(path.join(fileGit, '.git'), { recursive: true });
    fs.writeFileSync(path.join(fileGit, '.git'), 'gitdir: /somewhere/else', 'utf8'); // worktree gitdir 指针形态
    await expect(acquireVaultWriteLock(fileGit)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
  });

  it('锁路径组件 symlink → PATH_TRAVERSAL, 零触碰目标(N32/ADR-0021 §8)', async () => {
    // .git/novelcraft 是 symlink(指向 vault 外) → 拒绝且不写任何文件到目标。
    const root = tmpVault();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-lock-outside-'));
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(root, '.git', 'novelcraft'), 'dir');
    await expect(acquireVaultWriteLock(root)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    expect(fs.readdirSync(outside)).toEqual([]);

    // vault-write 本身是 symlink → 拒绝, 目标不变。
    const root2 = tmpVault();
    const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-lock-outside2-'));
    cleanups.push(() => fs.rmSync(outside2, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root2, '.git', 'novelcraft', 'locks'), { recursive: true });
    fs.symlinkSync(outside2, lockDirOf(root2), 'dir');
    await expect(acquireVaultWriteLock(root2)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    expect(fs.readdirSync(outside2)).toEqual([]);
  });

  it('锁生命周期端到端: 释放后可立即被他人重新获取(fake probe)', async () => {
    const root = tmpVault();
    const probe = fakeProbe();
    const a = await acquireVaultWriteLock(root, { probe });
    probe.advance(10);
    a.heartbeat();
    a.release();
    const b = await acquireVaultWriteLock(root, { probe, waitMs: 0 });
    expect(b.holdsLock()).toBe(true);
    expect(b.nonce).not.toBe(a.nonce);
    b.release();
    expect(fs.existsSync(lockDirOf(root))).toBe(false);
  });
});