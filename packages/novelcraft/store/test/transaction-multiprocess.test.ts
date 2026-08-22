// ============================================================================
// ADR-0021 进程测试基建 —— 跨进程锁 + 复核点 CAS 冲突
// ============================================================================
// 覆盖(裁定 N32 / ADR-0021 §3/§5/§6/§2):
//   1. 两进程抢 per-vault 跨进程锁: 持有者存活时第二进程 fail-closed
//      (LOCK_BUSY, 零工作树/index/ref 副作用); 释放后可正常提交。
//   2. 陈旧锁: 持有者被 SIGKILL 后, 按 pid 存活检测原子回收(stale-reclaimed),
//      不依赖心跳定时轮询(开放项1 细节留实现期, 夹具取约定)。
//   3. STAGED_CONFLICT(§2/N32): 整个 index 任何预存 staged → 事务在 intent 建立
//      前零写入拒绝, 不自动清除、不并入; 作者显式暂存信号保留。
//   4. 不协作编辑器(不遵守锁)在【提交前复核点】改写目标 → 复核点重新 hash
//      失配 → CAS_CONFLICT(§6/⑪): 不 update-ref、不 force、不覆盖; 冲突现场
//      保留(§7 CONFLICT fail-closed), OUTPUT 目标条件回滚, intent 保留供人工
//      恢复。只测明确复核点的冲突检测, 不虚构 check→rename 物理原子性(§5 边界)。
//
// 进程/协议约束(防 flaky): 同上文件 —— stdout READY 协议、事件驱动等待 +
// 显式超时、不 sleep 忙等、每场景独立临时 vault、afterEach 杀尽子进程并清理。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpVault, initRepo, commitAll, writeAsset } from './helpers';
import { serializeFrontmatter } from '../src/frontmatter';
import { gitAdd, gitHead, gitStatusPorcelain, gitLogSubjects } from '../src/git';
import { sha256hex, CRASH_GATES, REVIEW_GATE } from './fixtures/transaction-worker.mjs';

const WORKER = fileURLToPath(new URL('./fixtures/transaction-worker.mjs', import.meta.url));

// ── 子进程会话(与 transaction-crash.test.ts 同一套事件驱动协议) ─────────────

type SEvent = Record<string, any>;

class ChildSession {
  readonly proc: ChildProcess;
  private queue: SEvent[] = [];
  private waiter: { pred: (o: SEvent) => boolean; resolve: (o: SEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  exitCode: number | null = null;
  stderr = '';

  constructor(args: string[], label: string) {
    this.proc = spawn(process.execPath, [WORKER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.stderr += d.toString('utf8');
    });
    readline
      .createInterface({ input: this.proc.stdout! })
      .on('line', (line: string) => {
        let o: SEvent;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        this.queue.push(o);
        this.pump(label);
      });
    this.proc.on('exit', (code) => {
      this.exitCode = code;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.reject(new Error(`worker 提前退出 code=${code} (${label})\n${this.stderr}`));
      }
    });
    this.proc.on('error', (e) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.reject(e);
      }
    });
  }

  private pump(label: string) {
    if (!this.waiter) return;
    for (let i = 0; i < this.queue.length; i += 1) {
      if (this.waiter.pred(this.queue[i])) {
        const [hit] = this.queue.splice(i, 1);
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(hit);
        return;
      }
    }
    void label;
  }

  waitFor(pred: (o: SEvent) => boolean, timeoutMs: number, what: string): Promise<SEvent> {
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error(`nested waitFor(${what})`));
        return;
      }
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`超时等待 ${what} (${timeoutMs}ms); stderr: ${this.stderr.slice(-800)}`));
      }, timeoutMs);
      this.waiter = { pred, resolve, reject, timer };
      this.pump(what);
    });
  }

  send(cmd: object): void {
    this.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
  }

  async killSigkill(timeoutMs = 10_000): Promise<void> {
    if (this.exitCode === null) {
      this.proc.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等待 SIGKILL 退出超时')), timeoutMs);
        this.proc.once('exit', () => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    }
  }

  async waitExit(timeoutMs = 10_000): Promise<number | null> {
    if (this.exitCode !== null) return this.exitCode;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待进程退出超时')), timeoutMs);
      this.proc.once('exit', (code) => {
        clearTimeout(t);
        this.exitCode = code;
        resolve(code);
      });
    });
  }
}

// ── 夹具与计划 ───────────────────────────────────────────────────────────────

interface TxPlan {
  txid: string;
  kind: 'canonical' | 'state';
  base: string;
  targets: Array<{ rel: string; expected: { absent: boolean; sha256: string }; output: string }>;
}

const cleanups: Array<() => void> = [];
const children: ChildSession[] = [];

/** 每场景一个全新临时 vault(真实 git 仓库)。 */
function makeFixture(): { root: string; plan: TxPlan; planFile: string; obj1Abs: string; obj2Abs: string } {
  const { root, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(root);
  const obj1Abs = writeAsset(
    root,
    'world/objects/obj1.md',
    { id: 'obj1', kind: 'character', name: '阿甲', status: 'candidate' },
    '阿甲的正文 A',
  );
  writeAsset(
    root,
    'world/objects/obj2.md',
    { id: 'obj2', kind: 'location', name: '青石镇', status: 'candidate' },
    '青石镇的正文 A',
  );
  const base = commitAll(root, 'base');
  const file1 = fs.readFileSync(obj1Abs);
  const file2 = fs.readFileSync(path.join(root, 'world/objects/obj2.md'));
  const out1 = serializeFrontmatter({ id: 'obj1', kind: 'character', name: '阿甲', status: 'canonical' }, '阿甲的正文 B');
  const out2 = serializeFrontmatter({ id: 'obj2', kind: 'location', name: '青石镇', status: 'canonical' }, '青石镇的正文 B');
  const plan: TxPlan = {
    // 统一 txid 契约(审计): canonical tx- + 64 位小写 hex。
    txid: `tx-${sha256hex(Buffer.from(`mp|${Date.now()}|${Math.random()}`))}`,
    kind: 'canonical',
    base,
    targets: [
      { rel: 'world/objects/obj1.md', expected: { absent: false, sha256: sha256hex(file1) }, output: out1 },
      { rel: 'world/objects/obj2.md', expected: { absent: false, sha256: sha256hex(file2) }, output: out2 },
    ],
  };
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-tx-plan-'));
  cleanups.push(() => fs.rmSync(planDir, { recursive: true, force: true }));
  const planFile = path.join(planDir, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  return { root, plan, planFile, obj1Abs, obj2Abs: path.join(root, 'world/objects/obj2.md') };
}

// ── 协议步进 ─────────────────────────────────────────────────────────────────

function gateOrder(gate?: string): string[] {
  const g = [...CRASH_GATES];
  if (gate === REVIEW_GATE) g.splice(g.indexOf('ref-cas'), 0, REVIEW_GATE);
  return g;
}

/** 启动 tx 子进程并步进门; until 收到后返回(不 proceed); 否则走完全部门并等待 done。 */
async function runTx(
  root: string,
  planFile: string,
  opts: { until?: string; gate?: string } = {},
): Promise<{ sess: ChildSession; done?: SEvent }> {
  const args = ['--mode', 'tx', '--vault', root, '--plan', planFile];
  if (opts.gate) args.push('--gate', opts.gate);
  const sess = new ChildSession(args, `tx:${opts.until ?? 'full'}`);
  children.push(sess);
  await sess.waitFor((o) => o.t === 'ready', 10_000, 'tx ready');
  sess.send({ cmd: 'go' });
  for (const g of gateOrder(opts.gate)) {
    await sess.waitFor((o) => o.t === 'phase' && o.phase === g, 15_000, `phase ${g}`);
    if (g === opts.until) return { sess, done: undefined };
    sess.send({ cmd: 'proceed' });
  }
  const done = await sess.waitFor((o) => o.t === 'done', 15_000, 'tx done');
  return { sess, done };
}

// ── 断言辅助 ─────────────────────────────────────────────────────────────────

function intentDirLeft(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, '.git', 'novelcraft-transactions'));
  } catch {
    return [];
  }
}

function lockExists(root: string): boolean {
  try {
    fs.accessSync(path.join(root, '.git', 'novelcraft-lock'));
    return true;
  } catch {
    return false;
  }
}

function hasTxCommit(root: string, txid: string): boolean {
  return gitLogSubjects(root, 100).some((s) => s.includes(`vtx:${txid}`));
}

// ============================================================================

describe('ADR-0021 跨进程锁 + 复核点 CAS (N32)', () => {
  afterEach(() => {
    for (const c of children.splice(0)) {
      c.proc.kill('SIGKILL');
    }
    while (cleanups.length) cleanups.pop()!(); // 删除全部临时 vault / 计划目录
  });

  it(
    '两进程抢锁: 持有者存活 → 第二进程 LOCK_BUSY 零副作用; 释放后可成功提交 (§3/N32)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile, obj1Abs } = makeFixture();
      const baseBefore = gitHead(root);

      // 进程 A: lock-hold 持有 per-vault 锁(READY 后即持锁, 等待 release)。
      const hold = new ChildSession(['--mode', 'lock-hold', '--vault', root, '--txid', 'tx-' + 'a'.repeat(64)], 'hold-A');
      children.push(hold);
      await hold.waitFor((o) => o.t === 'ready', 10_000, 'hold ready');
      await hold.waitFor((o) => o.t === 'lock' && o.state === 'acquired', 10_000, 'hold acquired');

      // 进程 B: 同一 vault 发起事务 → fail-closed LOCK_BUSY, 且在首写前拒绝(零副作用)。
      const args = ['--mode', 'tx', '--vault', root, '--plan', planFile];
      const busy = new ChildSession(args, 'tx-B');
      children.push(busy);
      await busy.waitFor((o) => o.t === 'ready', 10_000, 'B ready');
      busy.send({ cmd: 'go' });
      const errB = await busy.waitFor((o) => o.t === 'error', 15_000, 'B LOCK_BUSY');
      expect(errB.code).toBe('LOCK_BUSY');
      expect(await busy.waitExit(10_000)).toBe(1);
      expect(gitHead(root)).toBe(baseBefore); // ref 不动
      expect(gitStatusPorcelain(root)).toEqual([]); // 工作树/index 零副作用
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 A');
      expect(intentDirLeft(root)).toEqual([]); // intent 未建立

      // 进程 A: release 后锁释放。
      hold.send({ cmd: 'release' });
      await hold.waitFor((o) => o.t === 'released', 10_000, 'A released');

      // 进程 C: 同一 plan 重新发起事务 → 全程走完, commit 成功(锁是唯一串行化依据)。
      const { done: doneC } = await runTx(root, planFile);
      expect(doneC!.state).toBe('committed');
      expect(doneC!.commit).toBeTruthy();
      expect(hasTxCommit(root, plan.txid)).toBe(true);
      expect(gitHead(root)).toBe(doneC!.commit);
      expect(gitStatusPorcelain(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);
    },
  );

  it(
    '陈旧锁(SIGKILL 持有者): 按 pid 存活检测原子回收 stale-reclaimed, 后续事务可执行 (§3)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile } = makeFixture();

      const hold = new ChildSession(['--mode', 'lock-hold', '--vault', root, '--txid', 'tx-' + 'b'.repeat(64)], 'hold-die');
      children.push(hold);
      await hold.waitFor((o) => o.t === 'ready', 10_000, 'hold ready');
      await hold.waitFor((o) => o.t === 'lock' && o.state === 'acquired', 10_000, 'hold acquired');
      await hold.killSigkill(); // 持有者进程死亡, 锁文件残留(pid 已死)

      // 新进程按 pid 存活检测判定 stale 并原子回收(不依赖超时轮询 → 无 flaky)。
      const att = new ChildSession(['--mode', 'lock-attempt', '--vault', root, '--txid', 'tx-' + 'c'.repeat(64)], 'attempt-B');
      children.push(att);
      await att.waitFor((o) => o.t === 'ready', 10_000, 'att ready');
      att.send({ cmd: 'go' });
      await att.waitFor((o) => o.t === 'lock' && o.state === 'stale-reclaimed', 10_000, 'stale-reclaimed');
      att.send({ cmd: 'release' });
      await att.waitFor((o) => o.t === 'released', 10_000, 'att released');

      // 回收后事务可正常完成。
      const { done } = await runTx(root, planFile);
      expect(done!.state).toBe('committed');
      expect(hasTxCommit(root, plan.txid)).toBe(true);
      expect(gitStatusPorcelain(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);
    },
  );

  it(
    'STAGED_CONFLICT: 任何预存 staged → intent 建立前零写入拒绝, 作者暂存保留 (§2/N32)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile, obj1Abs } = makeFixture();
      // 作者显式暂存 writeSet 外文件(信号, 事务不替作者决定其去留)。
      writeAsset(root, 'world/pending/staged.md', { id: 'staged1', kind: 'object', name: '手改草稿', status: 'pending' }, 'staged body');
      gitAdd(root, ['world/pending/staged.md']);
      expect(gitStatusPorcelain(root).some((l) => l.startsWith('A '))).toBe(true);

      const args = ['--mode', 'tx', '--vault', root, '--plan', planFile];
      const sess = new ChildSession(args, 'tx-staged');
      children.push(sess);
      await sess.waitFor((o) => o.t === 'ready', 10_000, 'ready');
      sess.send({ cmd: 'go' });
      const err = await sess.waitFor((o) => o.t === 'error', 15_000, 'STAGED_CONFLICT');
      expect(err.code).toBe('STAGED_CONFLICT');
      expect(await sess.waitExit(10_000)).toBe(1);

      // 零写入: ref 不动、目标未动、intent/锁不残留(N32: 有 staged 且无本协议 intent
      // 仍 STAGED_CONFLICT; 不自动清除任何 staged)。
      expect(gitHead(root)).toBe(plan.base);
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 A');
      expect(intentDirLeft(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);
      const porcelain = gitStatusPorcelain(root);
      expect(porcelain.some((l) => l.startsWith('A ') && l.includes('world/pending/staged.md'))).toBe(true);
      expect(porcelain.filter((l) => l.includes('world/objects/obj1.md') || l.includes('world/objects/obj2.md'))).toEqual([]);
    },
  );

  it(
    '不协作编辑器在提交前复核点改写目标 → CAS_CONFLICT, 不 update-ref、不覆盖、现场保留 (§6/⑪, §5 边界, N32)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile, obj1Abs, obj2Abs } = makeFixture();
      // 走 to review-point: 全部目标已 rename 落盘, 停在紧邻提交前复核点(§6)。
      const { sess } = await runTx(root, planFile, { until: REVIEW_GATE, gate: REVIEW_GATE });
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 B'); // 事务输出已落盘

      // 不协作编辑器(不遵守 per-vault 锁)在复核点直接改写目标。
      fs.writeFileSync(obj1Abs, '编辑器在复核点写入的 C', 'utf8');

      sess.send({ cmd: 'proceed' }); // 复核点重新 hash 全 writeSet → obj1 失配
      const err = await sess.waitFor((o) => o.t === 'error', 15_000, 'CAS_CONFLICT');
      expect(err.code).toBe('CAS_CONFLICT');
      expect(err.intentKept).toBe(true); // §7 CONFLICT → 保留现场 fail-closed
      expect(err.preserved).toContain('world/objects/obj1.md');
      expect(await sess.waitExit(10_000)).toBe(1);

      // 不 update-ref(分支不动, 无 commit); 编辑器内容不被覆盖; OUTPUT 目标被条件回滚。
      expect(gitHead(root)).toBe(plan.base);
      expect(hasTxCommit(root, plan.txid)).toBe(false);
      expect(fs.readFileSync(obj1Abs, 'utf8')).toBe('编辑器在复核点写入的 C');
      expect(fs.readFileSync(obj2Abs, 'utf8')).toContain('青石镇的正文 A'); // obj2 OUTPUT → 回滚 BEFORE
      // 冲突现场保留(intent 作为人工恢复证据), 锁已释放(回滚完成后)。
      expect(intentDirLeft(root)).toContain(plan.txid);
      expect(lockExists(root)).toBe(false);
    },
  );
});