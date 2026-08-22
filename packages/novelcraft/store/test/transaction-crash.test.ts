// ============================================================================
// ADR-0021 进程测试基建 —— 崩溃恢复(真实 SIGKILL)
// ============================================================================
// 覆盖(裁定 N32 / ADR-0021 §8「崩溃点与入口」):
//   在 intent-ready / first-rename / private-index / commit-object / ref-cas /
//   shared-index-install 六个崩溃点用真实 SIGKILL 杀死事务进程(不可捕获, 任何
//   内存回滚都不可能运行), 再由一个全新进程(recover 模式)按持久化 intent 收敛:
//     - 尚无成功 commit 的 canonical 事务 → OUTPUT 条件回滚为 BEFORE(§7/§8),
//       worktree 完整回到 base, index 无残留, intent/私有 index/锁全部清理;
//     - commit 已可达(ref-cas 之后)→ "commit 已成功"收尾(§8): 不回滚、不重做,
//       仅受控同步共享 index 并清理 intent; 相对新 HEAD 无未提交事务残留。
//   外加一个 checkpoint/state 语义用例: intent.kind='state' 崩溃后由 recover 补完
//   同一事务为 commit(§8「checkpoint/state 补完」, 不主动回滚)。
//
// 进程/协议约束(防 flaky):
//   - 子进程 stdout READY 协议(worker 输出 {"t":"ready"} 后等待 stdin
//     {"cmd":"go"}), 测试端按事件 + 显式超时等待, 全程不 sleep 忙等;
//   - 每个崩溃点独立临时 vault, afterEach 杀死全部残留子进程并删除临时仓库;
//   - 每个场景显式 timeout(vitest per-test options)。
//
// 生产 API 验收: worker 必须动态 import store transaction process driver；
// 未命中即 PRODUCTION_DRIVER_UNAVAILABLE，禁止回退夹具参考实现，确保真实 SIGKILL
// 与恢复测试只证明生产代码。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpVault, initRepo, commitAll, writeAsset } from './helpers';
import { serializeFrontmatter } from '../src/frontmatter';
import { gitHead, gitStatusPorcelain, gitLogSubjects, gitInit } from '../src/git';
import { sha256hex, CRASH_GATES } from './fixtures/transaction-worker.mjs';

/** 测试侧 git(直接 execFileSync; 断言/夹具用, 非生产路径)。 */
function gitRun(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** sha256 object format 支持探测(本机 git >= 2.29 才支持; 不支持则跳过 P1-2 sha256 子进程用例)。 */
const sha256Supported = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-sha256-probe-'));
    try {
      execFileSync('git', ['init', '-q', '--object-format=sha256'], { cwd: probe, stdio: 'ignore' });
      return true;
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();

const WORKER = fileURLToPath(new URL('./fixtures/transaction-worker.mjs', import.meta.url));

// ── 子进程会话(事件驱动等待 + 显式超时; 无 sleep 忙等) ─────────────────────

type SEvent = Record<string, any>;

class ChildSession {
  readonly proc: ChildProcess;
  private queue: SEvent[] = [];
  private waiter: { pred: (o: SEvent) => boolean; resolve: (o: SEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  exitCode: number | null = null;
  stderr = '';

  constructor(args: string[], label: string) {
    this.proc = spawn(process.execPath, [WORKER, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        w.reject(new Error(`worker 提前退出 code=${code} (${label})\nstdout=${JSON.stringify(this.queue)}\nstderr=${this.stderr}`));
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

  /** 事件驱动等待任意 JSON 事件匹配; 超时显式给出, 失败带上下文。 */
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

interface TxTarget {
  rel: string;
  expected: { absent: boolean; sha256: string };
  output: string;
}
interface TxPlan {
  txid: string;
  kind: 'canonical' | 'state';
  base: string;
  targets: TxTarget[];
  /** state: 已提交 plan 来源(§8 能力重推导, 恢复时按 base HEAD 重验证)。 */
  planSource?: { path: string; digest: string };
}

const cleanups: Array<() => void> = [];
const children: ChildSession[] = [];

function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

/** 每场景一个全新临时 vault(真实 git 仓库), 内容随计划而定; opts.sha256 时以
 * GIT_DEFAULT_HASH=sha256 初始化(initVault 受控透传, N32 复审 P1-2)。 */
function makeFixture(kind: 'canonical' | 'state', opts: { sha256?: boolean } = {}): { root: string; plan: TxPlan; planFile: string; obj1Abs: string; obj2Abs: string } {
  const { root, cleanup } = tmpVault();
  registerCleanup(cleanup);
  if (opts.sha256) {
    process.env.GIT_DEFAULT_HASH = 'sha256';
    try {
      initRepo(root);
    } finally {
      delete process.env.GIT_DEFAULT_HASH;
    }
  } else {
    initRepo(root);
  }
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
  // state 事务: 已提交 plan 来源在 base 提交**之前**落盘(计划随 base HEAD 提交, 才能
  // 在恢复时按 base HEAD:<path> 重推导; 复审 Blocker: 目标严格机器 namespace)。
  let planSource: { path: string; digest: string } | undefined;
  if (kind === 'state') {
    fs.mkdirSync(path.join(root, '.assistant'), { recursive: true });
    fs.writeFileSync(path.join(root, '.assistant', 'checkpoint.json'), JSON.stringify({ planDigest: 'crash-plan-v1' }), 'utf8');
  }
  const base = commitAll(root, 'base');
  if (kind === 'state') {
    planSource = {
      path: '.assistant/checkpoint.json',
      digest: sha256hex(fs.readFileSync(path.join(root, '.assistant', 'checkpoint.json'))),
    };
  }
  const file1 = fs.readFileSync(obj1Abs);
  const file2 = fs.readFileSync(path.join(root, 'world/objects/obj2.md'));
  // 计划输出在「生成/审批」完成时定型(ADR §1/§4: expected state 是内容 CAS 唯一基线)。
  const out1 = serializeFrontmatter({ id: 'obj1', kind: 'character', name: '阿甲', status: 'canonical' }, '阿甲的正文 B');
  const out2 = serializeFrontmatter({ id: 'obj2', kind: 'location', name: '青石镇', status: 'canonical' }, '青石镇的正文 B');
  const plan: TxPlan = {
    // 统一 txid 契约(审计): canonical tx- + 64 位小写 hex。
    txid: `tx-${sha256hex(Buffer.from(`crash|${Date.now()}|${Math.random()}`))}`,
    kind,
    base,
    targets: kind === 'state'
      ? [
          { rel: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: out1 },
          { rel: '.assistant/signals/plot.jsonl', expected: { absent: true, sha256: '' }, output: out2 },
        ]
      : [
          { rel: 'world/objects/obj1.md', expected: { absent: false, sha256: sha256hex(file1) }, output: out1 },
          { rel: 'world/objects/obj2.md', expected: { absent: false, sha256: sha256hex(file2) }, output: out2 },
        ],
    planSource,
  };
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-tx-plan-'));
  registerCleanup(() => fs.rmSync(planDir, { recursive: true, force: true }));
  const planFile = path.join(planDir, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  return { root, plan, planFile, obj1Abs, obj2Abs: path.join(root, 'world/objects/obj2.md') };
}

// ── 协议步进 ─────────────────────────────────────────────────────────────────

function gateOrder(): string[] {
  return [...CRASH_GATES];
}

/**
 * 启动 tx 子进程并步进门: 依次等待每个 phase 行并发送 proceed, 直到收到
 * `until`(若给)对应的 phase 行即返回(不 proceed, 由调用方决定 SIGKILL 或继续)。
 * until 为空则全程走完并等待 done。
 */
async function runTx(
  root: string,
  planFile: string,
  opts: { until?: string; gate?: string; envAttack?: string } = {},
): Promise<{ sess: ChildSession; done?: SEvent }> {
  const args = ['--mode', 'tx', '--vault', root, '--plan', planFile];
  if (opts.gate) args.push('--gate', opts.gate);
  if (opts.envAttack) args.push('--env-attack', opts.envAttack);
  const sess = new ChildSession(args, `tx:${opts.until ?? 'full'}`);
  children.push(sess);
  await sess.waitFor((o) => o.t === 'ready', 10_000, 'tx ready');
  sess.send({ cmd: 'go' });
  for (const g of gateOrder()) {
    await sess.waitFor((o) => o.t === 'phase' && o.phase === g, 15_000, `phase ${g}`);
    if (g === opts.until) return { sess, done: undefined };
    sess.send({ cmd: 'proceed' });
  }
  const done = await sess.waitFor((o) => o.t === 'done', 15_000, 'tx done');
  return { sess, done };
}

/** recover 模式: 全新进程(无任何内存回滚可依赖)收敛残留 intent。 */
async function runRecover(root: string, opts: { envAttack?: string } = {}): Promise<{ sess: ChildSession; done: SEvent }> {
  const args = ['--mode', 'recover', '--vault', root];
  if (opts.envAttack) args.push('--env-attack', opts.envAttack);
  const sess = new ChildSession(args, 'recover');
  children.push(sess);
  await sess.waitFor((o) => o.t === 'ready', 10_000, 'recover ready');
  sess.send({ cmd: 'go' });
  const done = await sess.waitFor((o) => o.t === 'done', 20_000, 'recover done');
  await sess.waitExit(10_000);
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

const AFTER_COMMIT_GATES = new Set(['ref-cas', 'shared-index-install']);

// ============================================================================

describe('ADR-0021 崩溃恢复: 真实 SIGKILL + 全新进程 recover (N32/§8)', () => {
  afterEach(() => {
    for (const c of children.splice(0)) {
      c.proc.kill('SIGKILL');
    }
    while (cleanups.length) cleanups.pop()!(); // 删除全部临时 vault / 计划目录
  });

  for (const gate of CRASH_GATES) {
    const expectCommitted = AFTER_COMMIT_GATES.has(gate);
    it(
      `SIGKILL@${gate} 后 recover ${expectCommitted ? '补 commit 收尾' : '条件回滚到 BEFORE'} (N32)`,
      { timeout: 60_000 },
      async () => {
        const { root, plan, planFile, obj1Abs } = makeFixture('canonical');
        const { sess } = await runTx(root, planFile, { until: gate });
        await sess.killSigkill(); // 真实 SIGKILL: 不可捕获、回滚代码不可能运行
        const { done } = await runRecover(root);

        if (expectCommitted) {
          // §8「commit 已成功」收尾: commit 唯一可验证存在于可达历史, 不回滚。
          expect(done.state).toBe('completed');
          expect(done.commit).toBeTruthy();
          expect(hasTxCommit(root, plan.txid)).toBe(true);
          expect(gitHead(root)).toBe(done.commit); // ref CAS 已推进
          expect(gitStatusPorcelain(root)).toEqual([]); // 相对新 HEAD 无未提交事务残留
          expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 B'); // 输出即新 HEAD 内容
        } else {
          // §8 canonical: 无成功 commit → OUTPUT 条件回滚为 BEFORE(新建安全删除/
          // 快照写回), BEFORE 保持不动; 绝不 restore HEAD 或 reset(R17/N32)。
          expect(done.state).toBe('rolled-back');
          expect(gitHead(root)).toBe(plan.base); // 分支纹丝不动
          expect(gitStatusPorcelain(root)).toEqual([]); // worktree 完整回到 base, index 无残留
          expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 快照还原
          expect(hasTxCommit(root, plan.txid)).toBe(false); // 无可达 tx commit(悬空 object 不算成功)
        }

        // 所有崩溃点共同: intent/私有 index/锁全部收敛清理(§8 收敛完成后不残留)。
        expect(intentDirLeft(root)).toEqual([]);
        expect(lockExists(root)).toBe(false);
      },
    );
  }

  it(
    'state 事务 SIGKILL@first-rename 后由 recover 补完为 commit(§8 checkpoint/state 补完, N32)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile } = makeFixture('state');
      const { sess } = await runTx(root, planFile, { until: 'first-rename' });
      await sess.killSigkill();
      const { done } = await runRecover(root);

      // state/checkpoint: 命中机器状态补完同一事务, 不主动回滚(§8; 复审 Blocker:
      // 目标严格机器 namespace + 持久化 planSource 在恢复时按 base HEAD 重验证通过)。
      expect(done.state).toBe('completed');
      expect(done.commit).toBeTruthy();
      expect(hasTxCommit(root, plan.txid)).toBe(true);
      expect(gitHead(root)).toBe(done.commit);
      expect(gitStatusPorcelain(root)).toEqual([]);
      expect(fs.readFileSync(path.join(root, '.assistant/signals/ingest.jsonl'), 'utf8')).toContain('阿甲的正文 B');
      expect(intentDirLeft(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);
    },
  );

  it(
    '无 intent 的干净 vault recover 为 no-intent noop(§8 入口幂等)',
    { timeout: 30_000 },
    async () => {
      const { root } = makeFixture('canonical');
      const { done } = await runRecover(root);
      expect(done.state).toBe('no-intent');
      expect(gitHead(root)).toBeTruthy();
      expect(gitStatusPorcelain(root)).toEqual([]);
    },
  );
});
// ============================================================================
// N32 最终复审 P1-2 生产子进程用例(真实 SIGKILL + 全新进程 recover):
//   环境重定向攻击注入(GIT_DIR/GIT_OBJECT_DIRECTORY/GIT_INDEX_FILE/
//   GIT_NAMESPACE/GIT_CONFIG_*)下, 生产 execute/recover 的最小 allowlist env 清理
//   + 钉固 --git-dir/--work-tree 使攻击不生效: 真实仓库照常推进/回滚, decoy 零副作用;
//   sha256 object format 仓库(64-hex OID)全流程 + 崩溃恢复。
// ============================================================================

describe('N32 最终复审 P1-2: 生产子进程 env 攻击 + sha256 仓库 (P1-2)', () => {
  afterEach(() => {
    for (const c of children.splice(0)) {
      c.proc.kill('SIGKILL');
    }
    while (cleanups.length) cleanups.pop()!(); // 删除全部临时 vault / 计划目录
  });

  it(
    'env 攻击注入下 tx 全流程: 真实仓库推进、身份固定 novelcraft、decoy 零副作用 (P1-2)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile } = makeFixture('canonical');
      const decoy = tmpVault();
      registerCleanup(decoy.cleanup);
      gitInit(decoy.root);
      const extObjDir = path.join(decoy.root, 'objects');
      fs.mkdirSync(extObjDir, { recursive: true });
      const attack = JSON.stringify({
        gitDir: decoy.root,
        objDir: extObjDir,
        indexFile: path.join(decoy.root, 'evil-index'),
        namespace: 'evil-ns',
        configCount: 2,
        configKeys: ['user.name', 'user.email'],
        configValues: ['evil', 'evil@example.invalid'],
      });

      const { done } = await runTx(root, planFile, { envAttack: attack });
      expect(done!.state).toBe('committed'); // 真实仓库照常推进(攻击不生效)
      expect(done!.commit).toBeTruthy();
      expect(hasTxCommit(root, plan.txid)).toBe(true);
      expect(gitHead(root)).toBe(done!.commit);
      expect(gitRun(root, ['log', '-1', '--format=%an <%ae>'])).toBe('novelcraft <novelcraft@example.invalid>'); // 配置注入被清
      expect(gitRun(root, ['for-each-ref'])).not.toContain('evil-ns'); // 无 namespace ref
      expect(gitStatusPorcelain(root)).toEqual([]);
      // decoy 零副作用: 无对象、无 evil index、无 ref。
      expect(fs.readdirSync(extObjDir)).toEqual([]);
      expect(fs.existsSync(path.join(decoy.root, 'evil-index'))).toBe(false);
      expect(gitRun(decoy.root, ['for-each-ref'])).toBe('');
      expect(fs.existsSync(path.join(root, '.git', 'index.lock'))).toBe(false);
      expect(intentDirLeft(root)).toEqual([]);
    },
  );

  it(
    'env 攻击注入下 SIGKILL@first-rename + recover: 真实仓库条件回滚, decoy 零副作用 (P1-2)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile, obj1Abs } = makeFixture('canonical');
      const decoy = tmpVault();
      registerCleanup(decoy.cleanup);
      gitInit(decoy.root);
      const extObjDir = path.join(decoy.root, 'objects');
      fs.mkdirSync(extObjDir, { recursive: true });
      const attack = JSON.stringify({
        gitDir: decoy.root,
        objDir: extObjDir,
        indexFile: path.join(decoy.root, 'evil-index'),
        namespace: 'evil-ns',
      });

      const { sess } = await runTx(root, planFile, { until: 'first-rename', envAttack: attack });
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 B'); // 首目标已落盘(真实仓库)
      await sess.killSigkill();
      const { done } = await runRecover(root, { envAttack: attack });
      expect(done.state).toBe('rolled-back'); // 全新 recover 进程同样免疫攻击
      expect(gitHead(root)).toBe(plan.base);
      expect(gitStatusPorcelain(root)).toEqual([]);
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 快照还原
      expect(intentDirLeft(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);
      // decoy 零副作用。
      expect(fs.readdirSync(extObjDir)).toEqual([]);
      expect(fs.existsSync(path.join(decoy.root, 'evil-index'))).toBe(false);
      expect(gitRun(decoy.root, ['for-each-ref'])).toBe('');
    },
  );

  it.skipIf(!sha256Supported)(
    'sha256 仓库(生产子进程): SIGKILL@first-rename 后 recover 条件回滚, 64-hex OID (P1-2)',
    { timeout: 60_000 },
    async () => {
      const { root, plan, planFile, obj1Abs } = makeFixture('canonical', { sha256: true });
      expect(gitRun(root, ['rev-parse', '--show-object-format'])).toBe('sha256');
      expect(plan.base).toMatch(/^[0-9a-f]{64}$/); // 计划 base 为 64-hex OID

      const { sess } = await runTx(root, planFile, { until: 'first-rename' });
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 B');
      await sess.killSigkill();
      const { done } = await runRecover(root);
      expect(done.state).toBe('rolled-back');
      expect(gitHead(root)).toBe(plan.base);
      expect(gitStatusPorcelain(root)).toEqual([]);
      expect(fs.readFileSync(obj1Abs, 'utf8')).toContain('阿甲的正文 A');
      expect(intentDirLeft(root)).toEqual([]);
      expect(lockExists(root)).toBe(false);

      // 完整 tx(不崩溃)在 sha256 仓库提交成功(64-hex commit)。
      const { done: done2 } = await runTx(root, planFile);
      expect(done2!.state).toBe('committed');
      expect(done2!.commit).toMatch(/^[0-9a-f]{64}$/);
      expect(gitHead(root)).toBe(done2!.commit);
      expect(hasTxCommit(root, plan.txid)).toBe(true);
      expect(gitStatusPorcelain(root)).toEqual([]);
    },
  );
});
