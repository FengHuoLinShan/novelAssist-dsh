// ADR-0021(N32) 事务执行器/恢复 —— 行为契约测试(vitest)。
//
// 覆盖(裁定 N32 / ADR-0021 §1–§8 验证要求①–⑪, 逐条注释引编号):
//   ① 共享 index 任何预存 staged、未知 index/ref lock、陈旧 expected state 均在
//      intent 前零副作用拒绝;
//   ② 私有 index 从 base HEAD 构建的 exact tree 只含实际变化集, 无关
//      unstaged/untracked 永不进 commit;
//   ③ 外部 ref 抢先前进使 update-ref CAS 失败, 不 force;
//   ④ preflight no-op 剔除, exact tree 变化集 = 实际变化集;
//   ⑤ 在 write/private-index/commit-object/ref/index 各点 crash(kill 模拟),
//      按 intent 与可达历史幂等收敛;
//   ⑥ BEFORE/OUTPUT 与 BASE/OUTPUT 所有 partial 组合: state 补完而 canonical
//      回滚重审批;
//   ⑦ 任一 CONFLICT、外部 staged/lock 均保留现场并拒绝;
//   ⑧ 后续外部 commit 或作者编辑后仍能按 txid/plan digest 找到成功 commit,
//      外部相同字节不被误认;
//   ⑨ intent schema/大小/path traversal/symlink 校验(fail-closed);
//   ⑩ canonical 未 commit 不重放 allowed-once(核心不 import DSH, 审批由 dsh 层
//      取得; 本测试断言「未 commit → 条件回滚且无提交」, 重审批属上层);
//   ⑪ 提交前复核点: update-ref CAS 前重新 hash 全 writeSet 工作树且均等于计划
//      output, 并复核 ref 仍 base、exact tree/plan digest 未变, 任一不符不
//      update-ref、按状态矩阵条件回滚/报告。
// 崩溃模拟: options.gates 在对应阶段抛 CrashSimulatedError(= SIGKILL 语义: 不执行
// 任何收尾), 随后由 recoverInterruptedTransactions 按持久化 intent 收敛。真实
// SIGKILL 的跨进程覆盖见 transaction-crash.test.ts(worker 协议驱动本模块生产 API)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpVault, initRepo, commitAll, writeAsset } from './helpers';
import { serializeFrontmatter } from '../src/frontmatter';
import { gitAdd, gitCommit, gitHead, gitStatusPorcelain, gitLogSubjects, gitInit } from '../src/git';
import { sha256Hex } from '../src/hash';
import {
  executeTransaction,
  recoverInterruptedTransactions,
  CrashSimulatedError,
  TransactionError,
  makeTxid,
  derivePlanIdentity,
  type TargetSpec,
  type TransactionRequest,
  type GatePhase,
} from '../src/transaction/execute';
import { acquireVaultWriteLock } from '../src/transaction/lock';
import { derivePlanIdentityPure } from '../src/transaction/git-transaction';
import { removeIntent } from '../src/transaction/intent';

const cleanups: Array<() => void> = [];

function makeVault(): string {
  const { root, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(root);
  return root;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function gitRun(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** git count-objects 的松散对象数(ODB 副作用探测, P1-1)。 */
function gitCountObjects(root: string): number {
  const out = execFileSync('git', ['count-objects', '-v'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m = /^count:\s*(\d+)$/m.exec(out);
  return m ? Number(m[1]) : -1;
}

/** sha256 object format 支持探测(本机 git >= 2.29 才支持; 不支持则跳过 P1-2 sha256 用例)。 */
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

function intentDirs(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, '.git', 'novelcraft-transactions')).filter((n) => n.startsWith('tx-'));
  } catch {
    return [];
  }
}

function productionLockDir(root: string): string {
  return path.join(root, '.git', 'novelcraft', 'locks', 'vault-write');
}

function privateIndexResidues(root: string): string[] {
  const gitDir = path.join(root, '.git');
  try {
    return fs.readdirSync(gitDir).filter((n) => n.startsWith('novelcraft-txn-') && n.endsWith('.index'));
  } catch {
    return [];
  }
}

/** 写两个候选对象并提交基线, 返回 { base, obj1Abs, obj2Abs, file1, file2, out1, out2 }。 */
function fixture(root: string): {
  base: string;
  obj1Abs: string;
  obj2Abs: string;
  sha1: string;
  sha2: string;
  out1: string;
  out2: string;
} {
  const obj1Abs = writeAsset(root, 'world/objects/obj1.md', { id: 'obj1', kind: 'character', name: '阿甲', status: 'candidate' }, '阿甲的正文 A');
  const obj2Abs = writeAsset(root, 'world/objects/obj2.md', { id: 'obj2', kind: 'location', name: '青石镇', status: 'candidate' }, '青石镇的正文 A');
  const base = commitAll(root, 'base');
  const out1 = serializeFrontmatter({ id: 'obj1', kind: 'character', name: '阿甲', status: 'canonical' }, '阿甲的正文 B');
  const out2 = serializeFrontmatter({ id: 'obj2', kind: 'location', name: '青石镇', status: 'canonical' }, '青石镇的正文 B');
  return { base, obj1Abs, obj2Abs, sha1: sha256Hex(fs.readFileSync(obj1Abs)), sha2: sha256Hex(fs.readFileSync(obj2Abs)), out1, out2 };
}

function canonicalRequest(f: ReturnType<typeof fixture>, extra?: Partial<TransactionRequest>): TransactionRequest {
  return {
    kind: 'canonical',
    purpose: '测试 adopt',
    writeSet: [
      { path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: f.out1 },
      { path: 'world/objects/obj2.md', expected: { absent: false, sha256: f.sha2 }, output: f.out2 },
    ],
    ...extra,
  };
}

/** 在指定门控点模拟 SIGKILL(crash): 之前完成的副作用全部保留, 收尾一律不运行。 */
function crashAt(phase: GatePhase): { gates: (p: GatePhase) => Promise<void> } {
  return {
    gates: async (p: GatePhase) => {
      if (p === phase) throw new CrashSimulatedError(phase);
    },
  };
}

// ============================================================================

describe('ADR-0021 事务执行器: 成功路径与提交隔离 (N32)', () => {
  it('成功提交: exact tree 只含实际变化集, 无关 unstaged/untracked 永不进 commit, index 同步, 清理 (②⑪)', async () => {
    const root = makeVault();
    const f = fixture(root);
    // 无关改动(writeSet 外): 已提交的文件 + 未跟踪文件, 均不得进事务 commit。
    fs.writeFileSync(path.join(root, 'world/objects/unrelated.md'), '作者手改\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'untracked note\n');

    const res = await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 });
    expect(res.outcome).toBe('committed');
    expect(res.txid).toMatch(/^tx-[0-9a-f]{64}$/);
    expect(gitHead(root)).toBe(res.commit);
    expect(gitLogSubjects(root, 100).some((s) => s.includes(res.txid))).toBe(true); // subject 契约(buildTxCommitMessage 口径)

    // ②: commit 只含实际变化集(无关文件绝不进 commit; 业务写面无 git add -A)。
    const changed = gitRun(root, ['diff-tree', '-r', '--name-only', f.base, res.commit]).split(/\r?\n/).filter(Boolean);
    expect(changed.sort()).toEqual(['world/objects/obj1.md', 'world/objects/obj2.md']);
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe(f.out1); // 工作树 = 输出
    // 共享 index 已同步到新 HEAD(writeSet 目标无 staged/修改; writeSet 外 untracked 允许存在, §1)。
    expect(gitStatusPorcelain(root).filter((l) => !l.startsWith('??'))).toEqual([]);
    expect(intentDirs(root)).toEqual([]); // §8 清理
    expect(productionLockDir(root) === undefined || !fs.existsSync(productionLockDir(root))).toBe(true);
    expect(privateIndexResidues(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.git', 'index.lock'))).toBe(false);
    // 无关改动原样保留(§1: writeSet 外允许存在, 不检查、不提交、不迁移)。
    expect(fs.readFileSync(path.join(root, 'world/objects/unrelated.md'), 'utf8')).toBe('作者手改\n');
    expect(gitStatusPorcelain(root).some((l) => l.includes('notes.md'))).toBe(true);
  });

  it('no-op 剔除(④): expected == 输出 → 不进变化集, 不进 commit', async () => {
    const root = makeVault();
    const f = fixture(root);
    const res = await executeTransaction(
      root,
      {
        kind: 'canonical',
        purpose: 'no-op 测试',
        writeSet: [
          // obj1: 输出 == 当前内容 → no-op(剔除)。
          { path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: fs.readFileSync(f.obj1Abs, 'utf8') },
          // obj2: 真实变化。
          { path: 'world/objects/obj2.md', expected: { absent: false, sha256: f.sha2 }, output: f.out2 },
        ],
      },
      { lockWaitMs: 0 },
    );
    expect(res.actualChangeSet).toEqual(['world/objects/obj2.md']);
    const changed = gitRun(root, ['diff-tree', '-r', '--name-only', f.base, res.commit]).split(/\r?\n/).filter(Boolean);
    expect(changed).toEqual(['world/objects/obj2.md']);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it('删除目标: expected present → output 省略 → 提交删除, 工作树/索引一致', async () => {
    const root = makeVault();
    const f = fixture(root);
    const res = await executeTransaction(
      root,
      {
        kind: 'canonical',
        purpose: '删除测试',
        writeSet: [
          { path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 } },
          { path: 'world/objects/obj2.md', expected: { absent: false, sha256: f.sha2 }, output: f.out2 },
        ],
      },
      { lockWaitMs: 0 },
    );
    expect(fs.existsSync(f.obj1Abs)).toBe(false);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(gitRun(root, ['ls-tree', '-r', '--name-only', res.commit]).split(/\r?\n/)).not.toContain('world/objects/obj1.md');
  });

  it('清理(§8): 成功事务后无锁/无私有 index/无 temp 残留; 空事务拒绝', async () => {
    const root = makeVault();
    const f = fixture(root);
    await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 });
    const gitDir = fs.readdirSync(path.join(root, '.git'));
    expect(gitDir.some((n) => n.startsWith('novelcraft-txn-'))).toBe(false);
    expect(gitDir.includes('index.lock')).toBe(false);
    expect(fs.existsSync(path.join(root, '.git', 'novelcraft', 'locks', 'vault-write'))).toBe(false);
    // 全 no-op → 空事务拒绝(§4)。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'canonical',
          purpose: '空事务',
          writeSet: [{ path: 'world/objects/obj1.md', expected: { absent: false, sha256: sha256Hex(fs.readFileSync(f.obj1Abs)) }, output: fs.readFileSync(f.obj1Abs, 'utf8') }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('ADR-0021 fail-closed 前置: intent 建立前零副作用 (①/F/背景4)', () => {
  it('预存 staged(不限 writeSet 内)→ STAGED_CONFLICT, 不自动清除不并入 (①§2)', async () => {
    const root = makeVault();
    const f = fixture(root);
    writeAsset(root, 'world/pending/staged.md', { id: 's', kind: 'object', name: '手改草稿', status: 'pending' }, 'staged body');
    gitAdd(root, ['world/pending/staged.md']);
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'STAGED_CONFLICT' });
    expect(gitHead(root)).toBe(f.base);
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 目标未动
    expect(intentDirs(root)).toEqual([]); // intent 未建立(零副作用)
    expect(gitStatusPorcelain(root).some((l) => l.startsWith('A ') && l.includes('world/pending/staged.md'))).toBe(true); // staged 保留
  });

  it('未知 .git/index.lock 与 ref lock → UNKNOWN_GIT_LOCK fail-closed (①§6)', async () => {
    const root = makeVault();
    const f = fixture(root);
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '外部锁\n');
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'UNKNOWN_GIT_LOCK' });
    fs.rmSync(path.join(root, '.git', 'index.lock'));

    const branch = gitRun(root, ['symbolic-ref', '--short', 'HEAD']);
    fs.mkdirSync(path.dirname(path.join(root, '.git', 'refs', 'heads', branch)), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', `${branch}.lock`), 'ref lock\n');
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'UNKNOWN_GIT_LOCK' });
    expect(intentDirs(root)).toEqual([]);
    expect(gitHead(root)).toBe(f.base);
  });

  it('陈旧 expected state → STALE_BASELINE, 零写入 (①F)', async () => {
    const root = makeVault();
    const f = fixture(root);
    // 生成后、事务前作者改了 obj1 → 期望 hash 失配, 绝不把启动时新内容当基线。
    fs.writeFileSync(f.obj1Abs, '作者事务前编辑 C\n');
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'STALE_BASELINE' });
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe('作者事务前编辑 C\n'); // 保留作者内容
    expect(intentDirs(root)).toEqual([]);
    expect(gitHead(root)).toBe(f.base);

    // 期望 absent 但目标存在 → STALE_BASELINE。
    await expect(
      executeTransaction(
        root,
        { kind: 'canonical', purpose: 'absent', writeSet: [{ path: 'world/objects/obj1.md', expected: { absent: true, sha256: '' } }] },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'STALE_BASELINE' });
  });

  it('expectedHead(生成→启动窗口)失配 → STALE_BASELINE (背景4/F)', async () => {
    const root = makeVault();
    const f = fixture(root);
    // 生成/审批基于 f.base, 事务启动前作者已提交新 commit。
    fs.writeFileSync(path.join(root, 'notes.md'), 'x');
    gitAdd(root, ['notes.md']);
    gitCommit(root, 'author commit');
    await expect(executeTransaction(root, canonicalRequest(f, { expectedHead: f.base }), { lockWaitMs: 0 })).rejects.toMatchObject({
      code: 'STALE_BASELINE',
    });
    expect(intentDirs(root)).toEqual([]);
  });

  it('锁: LOCK_BUSY fail-closed, 零副作用; 陈旧锁(pid 死亡)按 stale 回收 (③§3)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const held = await acquireVaultWriteLock(root, { waitMs: 0 });
    try {
      await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'LOCK_BUSY' });
      expect(gitHead(root)).toBe(f.base);
      expect(intentDirs(root)).toEqual([]);
    } finally {
      held.release();
    }

    // 陈旧锁: pid 已死 + 心跳过期 → 接管(staleMs=1 即时判定; host 同本机)。
    const lockDir = path.join(root, '.git', 'novelcraft', 'locks', 'vault-write');
    fs.mkdirSync(lockDir, { recursive: true });
    const staleMeta = {
      version: 1,
      pid: 9_999_999,
      hostname: os.hostname(),
      nonce: 'stale-nonce',
      acquiredAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000,
    };
    fs.writeFileSync(path.join(lockDir, 'lock.json'), JSON.stringify(staleMeta));
    const res = await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, lockStaleMs: 1 });
    expect(res.outcome).toBe('committed');
    expect(fs.existsSync(lockDir)).toBe(false); // 接管后已释放
  });
});

describe('ADR-0021 复核点与 CAS 竞争 (③⑪⑦)', () => {
  it('提交前复核点外部编辑 → CAS_CONFLICT: 不 update-ref、冲突保留、非冲突回滚、intent 留存 (⑪⑦)', async () => {
    const root = makeVault();
    const f = fixture(root);
    let injected = false;
    const err = await executeTransaction(
      root,
      canonicalRequest(f, {
        hooks: {
          beforeRefCas: () => {
            if (!injected) {
              injected = true;
              fs.writeFileSync(f.obj1Abs, '编辑器在复核点写入的 C', 'utf8'); // 不协作编辑器
            }
          },
        },
      }),
      { lockWaitMs: 0 },
    ).catch((e: unknown) => e as TransactionError);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.code).toBe('CAS_CONFLICT');
    expect(err.intentKept).toBe(true); // §7 CONFLICT → 保留现场 fail-closed
    expect(err.preserved).toContain('world/objects/obj1.md');
    expect(gitHead(root)).toBe(f.base); // 不 update-ref
    expect(gitLogSubjects(root, 100).some((s) => s.includes('vtx:'))).toBe(false); // 无事务 commit
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe('编辑器在复核点写入的 C'); // 冲突内容不覆盖
    expect(fs.readFileSync(f.obj2Abs, 'utf8')).toContain('青石镇的正文 A'); // obj2 OUTPUT → 条件回滚 BEFORE
    expect(intentDirs(root).length).toBe(1); // intent 作为人工恢复证据留存
    // 留存 intent 可被恢复入口重新判定(仍是 CONFLICT → preserved, 不自动覆盖)。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(rep.unresolved).toHaveLength(1);
  });

  it('外部 ref 抢先推进 → REF_CAS_CONFLICT, 不 force (③)', async () => {
    const root = makeVault();
    const f = fixture(root);
    let injected = false;
    const err = await executeTransaction(
      root,
      canonicalRequest(f, {
        hooks: {
          beforeRefCas: () => {
            if (!injected) {
              injected = true;
              // 外部(不遵守锁)提交抢先推进 ref。
              fs.writeFileSync(path.join(root, 'external.md'), '外部提交\n');
              gitAdd(root, ['external.md']);
              gitCommit(root, '外部抢先提交');
            }
          },
        },
      }),
      { lockWaitMs: 0 },
    ).catch((e: unknown) => e as TransactionError);
    expect(err.code).toBe('REF_CAS_CONFLICT');
    const externalHead = gitHead(root);
    expect(externalHead).not.toBe(f.base); // 外部 commit 保留, 不覆盖
    expect(gitLogSubjects(root, 100)).toContain('外部抢先提交');
    expect(intentDirs(root).length).toBe(1); // 保留现场
  });

  it('fault throw@before_cleanup: commit 已成功 → 不回滚(终点), 恢复只收尾 (⑤⑧)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const err = await executeTransaction(root, canonicalRequest(f), {
      lockWaitMs: 0,
      faults: { before_cleanup: 'throw' },
    }).catch((e: unknown) => e as TransactionError);
    expect(err.code).toBe('INTERNAL_FAULT');
    expect(gitHead(root)).not.toBe(f.base); // update-ref 已成功 → canonical 终点
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe(f.out1); // 不回滚
    expect(intentDirs(root).length).toBe(1); // 收尾未完成
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('committed'); // 已验证 commit 只收尾
    expect(intentDirs(root)).toEqual([]);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it('进程内异常(写阶段): canonical 矩阵条件回滚 + intent 清理 (⑤)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const err = await executeTransaction(
      root,
      canonicalRequest(f, {
        hooks: {
          beforeTargetWrite: (spec: TargetSpec) => {
            if (spec.path === 'world/objects/obj1.md') throw new Error('业务 provider 写前失败');
          },
        },
      }),
      { lockWaitMs: 0 },
    ).catch((e: unknown) => e as TransactionError);
    expect(err.message).toContain('业务 provider 写前失败');
    expect(gitHead(root)).toBe(f.base);
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 未写/已回滚
    expect(intentDirs(root)).toEqual([]); // 无冲突 → 回滚后清理
  });
});

describe('ADR-0021 崩溃恢复: crash 模拟 + 状态矩阵收敛 (⑤⑥⑦⑧)', () => {
  it('crash@intent-ready: 全 BEFORE/BASE → canonical 回滚(无写入), 可重新提交 (⑤⑥)', async () => {
    const root = makeVault();
    const f = fixture(root);
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    expect(intentDirs(root).length).toBe(1); // intent 已耐久化
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 零写入

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('rolled_back');
    expect(rep.unresolved).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
    expect(gitHead(root)).toBe(f.base);
    expect(gitStatusPorcelain(root)).toEqual([]);

    // 收敛完成后新事务正常进入(N32 §8: 收敛完成前不开始新事务)。
    const res = await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 });
    expect(res.outcome).toBe('committed');
  });

  it('crash@first-rename: BEFORE/OUTPUT 混合 → canonical 快照还原, 分支不动 (⑤⑥)', async () => {
    const root = makeVault();
    const f = fixture(root);
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe(f.out1); // 首目标已落盘
    expect(fs.readFileSync(f.obj2Abs, 'utf8')).toContain('青石镇的正文 A'); // 其余 BEFORE

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('rolled_back');
    expect(rep.entries[0].restored).toContain('world/objects/obj1.md');
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 快照还原
    expect(gitHead(root)).toBe(f.base);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });

  it('crash@ref-cas: commit 已可达 → 恢复只收尾, 不回滚不重做 (⑤⑧)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const plan = canonicalRequest(f);
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('ref-cas') })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(gitHead(root)).not.toBe(f.base); // ref CAS 已成功

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('committed');
    expect(rep.entries[0].commit).toBe(gitHead(root));
    expect(gitStatusPorcelain(root)).toEqual([]); // index 已同步, 相对新 HEAD 无残留
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe(f.out1); // 输出即新 HEAD 内容
    expect(intentDirs(root)).toEqual([]);
  });

  it('crash@ref-cas + 作者后续 commit: 仍按 txid/plan digest 找到, 收尾到新 HEAD (⑧)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const plan = canonicalRequest(f);
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('ref-cas') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const ourCommit = gitHead(root);
    fs.writeFileSync(path.join(root, 'notes.md'), '作者继续编辑\n');
    gitAdd(root); // 作者整面提交(含事务输出工作树), 事务 commit 仍在可达历史中
    const authorHead = gitCommit(root, '作者后续 commit');

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('committed'); // 在可达历史中找到本事务 commit
    expect(rep.entries[0].commit).toBe(ourCommit);
    expect(gitHead(root)).toBe(authorHead); // 外部 commit 保留
    expect(gitLogSubjects(root, 100).some((s) => s.includes('vtx:'))).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]); // index 同步到新 HEAD
    expect(intentDirs(root)).toEqual([]);
  });

  it('crash@commit-object + 外部 ref 竞争 → ref_race, 绝不 force (③⑧)', async () => {
    const root = makeVault();
    const f = fixture(root);
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, ...crashAt('commit-object') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    // 外部提交(与事务输出同内容但无 txid/trailer)推进 ref。
    gitAdd(root, ['world/objects/obj1.md', 'world/objects/obj2.md']);
    gitCommit(root, '外部相同字节提交');

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('ref_race'); // 外部相同字节不被误认为本事务 commit(⑧)
    expect(rep.unresolved).toEqual([rep.entries[0].txid]);
    expect(gitHead(root)).not.toBe(f.base); // 外部提交保留, 不 force
    expect(intentDirs(root).length).toBe(1); // intent 保留待人工
  });

  it('恢复遇 CONFLICT(外部编辑)→ 保留现场 fail-closed, 不覆盖不删除 (⑦)', async () => {
    const root = makeVault();
    const f = fixture(root);
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, ...crashAt('private-index') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    // 崩溃后作者编辑 obj1(两态都不等)。
    fs.writeFileSync(f.obj1Abs, '崩溃后作者编辑 D\n', 'utf8');

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(rep.entries[0].conflicts).toContain('world/objects/obj1.md');
    expect(rep.unresolved).toHaveLength(1);
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toBe('崩溃后作者编辑 D\n'); // 不覆盖
    expect(fs.readFileSync(f.obj2Abs, 'utf8')).toBe(f.out2); // OUTPUT 目标也保留(整单 fail-closed)
    expect(intentDirs(root).length).toBe(1);
    expect(gitHead(root)).toBe(f.base);
  });
});

describe('ADR-0021 state / run_bootstrap 补完 (⑥⑧)', () => {
  it('state 崩溃@first-rename → 恢复补完同一事务为 commit, 不主动回滚 (⑥)', async () => {
    const root = makeVault();
    const f = fixture(root);
    // 已提交 plan 来源(§8 能力重推导): state 必须携带, 恢复时按 base HEAD 重验证。
    const planContent = JSON.stringify({ planDigest: 'committed-plan-v1' });
    writeAsset(root, '.assistant/checkpoint.json', { plan: 'v1' }, planContent);
    commitAll(root, 'plan commit');
    const digest = sha256Hex(fs.readFileSync(path.join(root, '.assistant/checkpoint.json')));
    // 目标严格限定机器 namespace(永不 canonical 资产, 复审 Blocker)。
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint',
      planSource: { path: '.assistant/checkpoint.json', digest },
      writeSet: [
        { path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: f.out1 },
        { path: '.assistant/signals/plot.jsonl', expected: { absent: true, sha256: '' }, output: f.out2 },
      ],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(CrashSimulatedError);

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed');
    expect(rep.entries[0].commit).toBe(gitHead(root));
    expect(fs.readFileSync(path.join(root, '.assistant/signals/ingest.jsonl'), 'utf8')).toBe(f.out1);
    expect(fs.readFileSync(path.join(root, '.assistant/signals/plot.jsonl'), 'utf8')).toBe(f.out2);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });

  it('state 带已提交 planSource: 执行期强校验(§8 能力重推导)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const planContent = JSON.stringify({ planDigest: 'committed-plan-v1' });
    writeAsset(root, '.assistant/checkpoint.json', { plan: 'v1' }, planContent);
    const planBase = commitAll(root, 'plan commit');
    const digest = sha256Hex(fs.readFileSync(path.join(root, '.assistant/checkpoint.json')));

    // 匹配 → 成功(目标 ∈ 机器 namespace allowlist)。
    const ok = await executeTransaction(
      root,
      {
        kind: 'state',
        purpose: 'state with plan',
        planSource: { path: '.assistant/checkpoint.json', digest },
        writeSet: [
          { path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: f.out1 },
          { path: '.assistant/signals/plot.jsonl', expected: { absent: true, sha256: '' }, output: f.out2 },
        ],
      },
      { lockWaitMs: 0 },
    );
    expect(ok.outcome).toBe('committed');
    expect(gitHead(root)).not.toBe(planBase);

    // 失配 → INVALID_REQUEST(审批后进入事务仍重新 preflight/CAS, §4)。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'state',
          purpose: 'state with wrong plan',
          planSource: { path: '.assistant/checkpoint.json', digest: sha256Hex('tampered') },
          writeSet: [{ path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: f.out1 }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    // 无能力 → 拒绝(复审 Blocker: state 必须带 planSource, 无能力拒绝)。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'state',
          purpose: 'state without plan',
          writeSet: [{ path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: f.out1 }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    // canonical 资产路径 → 拒绝(复审 Blocker: state 永不写 canonical 资产)。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'state',
          purpose: 'state to canonical path',
          planSource: { path: '.assistant/checkpoint.json', digest },
          writeSet: [{ path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: f.out1 }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('run_bootstrap: 无已提交 plan 也能补完; 越界路径/既有 run 拒绝 (⑧)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'run_bootstrap');
    const plan: TransactionRequest = {
      kind: 'run_bootstrap',
      purpose: '首次 run',
      txid,
      runId: 'run-1',
      inputFingerprint: sha256Hex('input-config-v1'),
      runFile: '.assistant/checkpoint.json',
      writeSet: [{ path: '.assistant/checkpoint.json', expected: { absent: true, sha256: '' }, output: '{"run":"run-1","phase":"boot"}' }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);

    // 首次 run 还没有已提交 plan(§8 run_bootstrap 例外): 恢复必须补完, 不主动回滚。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed');
    expect(fs.readFileSync(path.join(root, '.assistant/checkpoint.json'), 'utf8')).toBe('{"run":"run-1","phase":"boot"}');
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);

    // 越界路径(canonical 资产路径)→ 执行期拒绝。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'run_bootstrap',
          purpose: '越界',
          runId: 'run-2',
          inputFingerprint: sha256Hex('x'),
          runFile: 'world/objects/obj1.md',
          writeSet: [{ path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: 'x' }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    // 既有 run(已提交)→ 拒绝覆盖。
    await expect(
      executeTransaction(
        root,
        {
          kind: 'run_bootstrap',
          purpose: '覆盖 run',
          runId: 'run-1',
          inputFingerprint: sha256Hex('x'),
          runFile: '.assistant/checkpoint.json',
          writeSet: [{ path: '.assistant/checkpoint.json', expected: { absent: true, sha256: '' }, output: 'x' }],
        },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('N32 复审 P2: state/checkpoint 删除补完 —— 受保护删除 (intent-ready 恢复)', () => {
  /** state 删除夹具: 已提交 planSource + 机器 namespace 待删文件(del)。 */
  function stateDeleteFixture(
    root: string,
  ): {
    base: string;
    planSource: { path: string; digest: string };
    delRel: string;
    delAbs: string;
    delSha: string;
  } {
    fs.mkdirSync(path.join(root, '.assistant', 'signals'), { recursive: true });
    fs.writeFileSync(path.join(root, '.assistant', 'checkpoint.json'), JSON.stringify({ planDigest: 'committed-plan-v1' }), 'utf8');
    const delBytes = 'machine-state-to-delete\n';
    fs.writeFileSync(path.join(root, '.assistant', 'signals', 'del.jsonl'), delBytes, 'utf8');
    const base = commitAll(root, 'base');
    const digest = sha256Hex(fs.readFileSync(path.join(root, '.assistant', 'checkpoint.json')));
    return {
      base,
      planSource: { path: '.assistant/checkpoint.json', digest },
      delRel: '.assistant/signals/del.jsonl',
      delAbs: path.join(root, '.assistant', 'signals', 'del.jsonl'),
      delSha: sha256Hex(delBytes),
    };
  }

  it('state 删除 @intent-ready: BEFORE 删除目标受保护删除并补完为 commit, 幂等 (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const txid = makeTxid(root, 'state');
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint delete',
      txid,
      planSource: fx.planSource,
      // 无 output = 计划删除(§1 语义); expected present = 生成计划时的内容 CAS 基线。
      writeSet: [{ path: fx.delRel, expected: { absent: false, sha256: fx.delSha } }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    // 崩溃于 intent-ready: 零工作树副作用, 删除目标仍为 BEFORE(文件存在 == 快照)。
    expect(fs.existsSync(fx.delAbs)).toBe(true);

    // 修复前: 补完复核「应为删除」恒 CAS_CONFLICT → intent 永久保留(unresolved)。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed');
    expect(rep.entries[0].commit).toBe(gitHead(root));
    expect(rep.unresolved).toEqual([]);
    expect(fs.existsSync(fx.delAbs)).toBe(false); // 删除真正执行(受保护 temp+rename)
    expect(gitHead(root)).not.toBe(fx.base); // 已提交
    expect(gitStatusPorcelain(root)).toEqual([]); // 工作树/index 与 HEAD 一致(删除已入库)
    expect(intentDirs(root)).toEqual([]);

    // 幂等恢复: intent 已收敛清理, 再次 recover 零动作。
    const rep2 = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep2.scanned).toEqual([]);
    expect(rep2.entries).toEqual([]);
    expect(rep2.unresolved).toEqual([]);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it('state 删除 @first-rename(写目标在前, 删除在后): 混态补完, BEFORE 删除目标被删 (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const keepAbs = path.join(root, '.assistant', 'signals', 'keep.jsonl');
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint write+delete',
      planSource: fx.planSource,
      writeSet: [
        // 首目标为写: 崩溃点2(first-rename)后已落盘 → OUTPUT; 删除目标仍 BEFORE。
        { path: '.assistant/signals/keep.jsonl', expected: { absent: true, sha256: '' }, output: 'updated-state\n' },
        { path: fx.delRel, expected: { absent: false, sha256: fx.delSha } },
      ],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(fs.readFileSync(keepAbs, 'utf8')).toBe('updated-state\n'); // 首目标已落盘
    expect(fs.existsSync(fx.delAbs)).toBe(true); // 删除目标仍 BEFORE(未处理)

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed');
    expect(fs.readFileSync(keepAbs, 'utf8')).toBe('updated-state\n'); // OUTPUT 写目标不动
    expect(fs.existsSync(fx.delAbs)).toBe(false); // BEFORE 删除目标被受保护删除
    expect(gitStatusPorcelain(root)).toEqual([]); // 两目标均入库
    expect(intentDirs(root)).toEqual([]);
  });

  it('state 删除 @first-rename 且删除为首目标: OUTPUT(已删) 目标跳过, 补完 commit (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const keepAbs = path.join(root, '.assistant', 'signals', 'keep.jsonl');
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint delete+write',
      planSource: fx.planSource,
      writeSet: [
        // 首目标为删除: 崩溃点2 前文件已被摘除 → OUTPUT(已删除), 恢复跳过不重复动作。
        { path: fx.delRel, expected: { absent: false, sha256: fx.delSha } },
        { path: '.assistant/signals/keep.jsonl', expected: { absent: true, sha256: '' }, output: 'updated-state\n' },
      ],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(fs.existsSync(fx.delAbs)).toBe(false); // 首删除已执行
    expect(fs.existsSync(keepAbs)).toBe(false); // 后续写目标仍 BEFORE

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed');
    expect(fs.existsSync(fx.delAbs)).toBe(false);
    expect(fs.readFileSync(keepAbs, 'utf8')).toBe('updated-state\n');
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });

  it('state 删除 @intent-ready + 外部编辑: CONFLICT 保留现场, 不删除不覆盖不 commit (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const txid = makeTxid(root, 'state');
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint delete',
      txid,
      planSource: fx.planSource,
      writeSet: [{ path: fx.delRel, expected: { absent: false, sha256: fx.delSha } }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    // 崩溃后作者编辑删除目标(非快照、非删除 → CONFLICT)。
    fs.writeFileSync(fx.delAbs, '外部编辑后的内容\n', 'utf8');

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(rep.entries[0].conflicts).toContain(fx.delRel);
    expect(rep.unresolved).toEqual([txid]); // fail-closed: intent 保留待人工
    expect(fs.readFileSync(fx.delAbs, 'utf8')).toBe('外部编辑后的内容\n'); // 不受保护删除(不覆盖)
    expect(gitHead(root)).toBe(fx.base); // 未 commit
    expect(intentDirs(root)).toEqual([txid]);
  });

  it('state 删除临时文件 unlink 非 ENOENT 失败: intent 保留且不提交, 故障解除后可恢复 (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const txid = makeTxid(root, 'state');
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint delete unlink failure',
      txid,
      planSource: fx.planSource,
      writeSet: [{ path: fx.delRel, expected: { absent: false, sha256: fx.delSha } }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);

    const originalUnlink = fs.unlinkSync.bind(fs);
    const tmpSuffix = `.novelcraft-txn-${txid}.tmp`;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((file: fs.PathLike) => {
      if (String(file).endsWith(tmpSuffix)) {
        const error = Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        throw error;
      }
      return originalUnlink(file);
    }) as typeof fs.unlinkSync);
    try {
      const failed = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
      expect(failed.entries[0].outcome).toBe('preserved');
      expect(failed.unresolved).toEqual([txid]);
      expect(gitHead(root)).toBe(fx.base);
      expect(intentDirs(root)).toEqual([txid]);
      expect(fs.existsSync(`${fx.delAbs}${tmpSuffix}`)).toBe(true);
    } finally {
      spy.mockRestore();
    }

    const recovered = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(recovered.entries[0].outcome).toBe('completed');
    expect(recovered.unresolved).toEqual([]);
    expect(fs.existsSync(`${fx.delAbs}${tmpSuffix}`)).toBe(false);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });

  it('state 删除正常提交(无崩溃): 删除入库、工作树/索引/HEAD 一致 (N32 P2)', async () => {
    const root = makeVault();
    const fx = stateDeleteFixture(root);
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint delete',
      planSource: fx.planSource,
      writeSet: [{ path: fx.delRel, expected: { absent: false, sha256: fx.delSha } }],
    };
    const res = await executeTransaction(root, plan, { lockWaitMs: 0 });
    expect(res.outcome).toBe('committed');
    expect(res.actualChangeSet).toEqual([fx.delRel]);
    expect(fs.existsSync(fx.delAbs)).toBe(false);
    expect(gitHead(root)).toBe(res.commit);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });
});

describe('ADR-0021 intent 校验: 篡改/穿越/schema (⑨)', () => {
  it('tampered planDigest / 路径穿越 / 未知 schema → invalid 保留, 新事务被拒', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'canonical');
    await expect(
      executeTransaction(root, { ...canonicalRequest(f), txid }, { lockWaitMs: 0, ...crashAt('intent-ready') }),
    ).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');

    // (a) 篡改 planDigest → 重推导失配 → invalid。
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw.planDigest = sha256Hex('tampered');
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    let rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid');
    expect(rep.unresolved).toEqual([txid]);
    expect(intentDirs(root)).toEqual([txid]); // 保留供人工修复
    // 新事务入口被未收敛 intent 挡住(§8: force 不能绕过)。
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'INVALID_INTENT' });

    // (b) 路径穿越(../)→ 存储层白名单拒绝 → invalid。
    removeIntent(root, txid);
    await expect(
      executeTransaction(root, { ...canonicalRequest(f), txid }, { lockWaitMs: 0, ...crashAt('intent-ready') }),
    ).rejects.toBeInstanceOf(CrashSimulatedError);
    const raw2 = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw2.targets[0].path = '../escape.md';
    fs.writeFileSync(intentPath, JSON.stringify(raw2));
    rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid');
    expect(rep.entries[0].message).toMatch(/非法段|穿越/);
    expect(intentDirs(root)).toEqual([txid]);

    // (c) 未知 schema → invalid。
    removeIntent(root, txid);
    await expect(
      executeTransaction(root, { ...canonicalRequest(f), txid }, { lockWaitMs: 0, ...crashAt('intent-ready') }),
    ).rejects.toBeInstanceOf(CrashSimulatedError);
    const raw3 = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw3.schema = 999;
    fs.writeFileSync(intentPath, JSON.stringify(raw3));
    rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid');
    expect(intentDirs(root)).toEqual([txid]);
  });
});
// ============================================================================
// N32 复审 Blocker 回归(store386 保持全绿之上新增):
//   A. 恶意 state 路径 / 无能力恢复 —— 持久化可重推导 plan capability, 无能力不补交;
//   B. fullWriteSet/actualWriteSet 明确恢复 —— no-op 目标不被误判 tamper;
//   C. 公开 request plain-data 对抗 —— 任何 getter 前 codec 校验, Proxy/accessor/class
//      fail-closed。
// ============================================================================

describe('复审 Blocker A: state 恶意路径 / 无能力恢复, 不补交 (§8)', () => {
  /** 已提交 planSource + 两个机器 namespace 目标的 state 计划(崩溃点可注入)。 */
  function statePlanFor(root: string, f: ReturnType<typeof fixture>, extra?: Partial<TransactionRequest>): TransactionRequest {
    const planContent = JSON.stringify({ planDigest: 'committed-plan-v1' });
    writeAsset(root, '.assistant/checkpoint.json', { plan: 'v1' }, planContent);
    commitAll(root, 'plan commit');
    const digest = sha256Hex(fs.readFileSync(path.join(root, '.assistant/checkpoint.json')));
    return {
      kind: 'state',
      purpose: 'checkpoint',
      planSource: { path: '.assistant/checkpoint.json', digest },
      writeSet: [
        { path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: f.out1 },
        { path: '.assistant/signals/plot.jsonl', expected: { absent: true, sha256: '' }, output: f.out2 },
      ],
      ...extra,
    };
  }

  it('intent 目标被篡改为 canonical 资产路径 → 恢复 invalid 拒绝补交, 现场保留', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'state');
    await expect(executeTransaction(root, statePlanFor(root, f, { txid }), { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw.targets[0].path = 'world/objects/obj1.md'; // 恶意改写为 canonical 资产路径
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid'); // 不补交
    expect(rep.unresolved).toEqual([txid]); // 保留供人工修复
    expect(intentDirs(root)).toEqual([txid]);
    const headBefore = gitRun(root, ['rev-parse', 'HEAD']);
    expect(gitHead(root)).toBe(headBefore); // 分支未动
    expect(fs.existsSync(path.join(root, '.assistant/signals/ingest.jsonl'))).toBe(false); // 零补交
  });

  it('state intent 缺持久化 planSource → 恢复 invalid, 无能力不补交', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'state');
    await expect(executeTransaction(root, statePlanFor(root, f, { txid }), { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    delete raw.planSource; // 旧形态/被剥离能力
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid');
    expect(rep.entries[0].message).toMatch(/缺持久化 planSource/);
    expect(intentDirs(root)).toEqual([txid]);
  });

  it('state intent planSource.digest 被篡改 → 恢复 preserved, 能力不可重推导不补交', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'state');
    await expect(executeTransaction(root, statePlanFor(root, f, { txid }), { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw.planSource.digest = sha256Hex('tampered-plan');
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(rep.entries[0].message).toMatch(/失配/);
    expect(intentDirs(root)).toEqual([txid]);
    const headBefore = gitRun(root, ['rev-parse', 'HEAD']);
    expect(gitHead(root)).toBe(headBefore); // 未补交
  });

  it('run_bootstrap intent 缺持久化自描述(runId 被剥离)→ 恢复 invalid, 不补交', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'run_bootstrap');
    const plan: TransactionRequest = {
      kind: 'run_bootstrap',
      purpose: '首次 run',
      txid,
      runId: 'run-1',
      inputFingerprint: sha256Hex('input-config-v1'),
      runFile: '.assistant/checkpoint.json',
      writeSet: [{ path: '.assistant/checkpoint.json', expected: { absent: true, sha256: '' }, output: '{"run":"run-1"}' }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    delete raw.runId;
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('invalid');
    expect(rep.entries[0].message).toMatch(/缺持久化自描述/);
    expect(intentDirs(root)).toEqual([txid]);
  });

  it('run_bootstrap intent runFile 被篡改为 canonical 路径 → 恢复拒绝补交(受控 bootstrap 路径)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const txid = makeTxid(root, 'run_bootstrap');
    const plan: TransactionRequest = {
      kind: 'run_bootstrap',
      purpose: '首次 run',
      txid,
      runId: 'run-1',
      inputFingerprint: sha256Hex('input-config-v1'),
      runFile: '.assistant/checkpoint.json',
      writeSet: [{ path: '.assistant/checkpoint.json', expected: { absent: true, sha256: '' }, output: '{"run":"run-1"}' }],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    const intentPath = path.join(root, '.git', 'novelcraft-transactions', txid, 'intent.json');
    const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    raw.runFile = 'world/objects/obj1.md'; // 受控 bootstrap 路径被改写为 canonical 资产
    fs.writeFileSync(intentPath, JSON.stringify(raw));
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved'); // 补交前能力复核拒绝, 不补交
    expect(rep.entries[0].message).toMatch(/allowlist/);
    expect(intentDirs(root)).toEqual([txid]);
    expect(fs.existsSync(path.join(root, '.assistant/checkpoint.json'))).toBe(false); // 零补交
  });
});

describe('复审 Blocker B: no-op 目标恢复, 不误判 tamper (fullWriteSet/actualWriteSet)', () => {
  it('state 崩溃@first-rename 含 no-op 目标(工作树编辑未提交)→ 恢复补完, no-op 保留', async () => {
    const root = makeVault();
    // 已提交 plan 来源。
    const planContent = JSON.stringify({ planDigest: 'committed-plan-v1' });
    writeAsset(root, '.assistant/checkpoint.json', { plan: 'v1' }, planContent);
    // no-op 目标: 提交内容 X, 随后工作树改为 Y(未提交编辑; expected == 输出 == Y)。
    const plotAbs = path.join(root, '.assistant/signals/plot.jsonl');
    fs.mkdirSync(path.join(root, '.assistant/signals'), { recursive: true });
    fs.writeFileSync(plotAbs, 'X\n');
    const base = commitAll(root, 'base');
    fs.writeFileSync(plotAbs, 'Y\n'); // 作者编辑(未提交): 与 HEAD blob 不同
    const digest = sha256Hex(fs.readFileSync(path.join(root, '.assistant/checkpoint.json')));
    const outA = '{"event":"ingest-done"}\n';
    const plan: TransactionRequest = {
      kind: 'state',
      purpose: 'checkpoint',
      expectedHead: base,
      planSource: { path: '.assistant/checkpoint.json', digest },
      writeSet: [
        { path: '.assistant/signals/ingest.jsonl', expected: { absent: true, sha256: '' }, output: outA },
        // no-op: expected(== 输出) == 当前工作树; HEAD 上是 'X\n' → 恢复必须按
        // actualWriteSet 推导 tree, 否则 plan digest 伪失配误判 tamper(复审 Blocker)。
        { path: '.assistant/signals/plot.jsonl', expected: { absent: false, sha256: sha256Hex('Y\n') }, output: 'Y\n' },
      ],
    };
    await expect(executeTransaction(root, plan, { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(CrashSimulatedError);

    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('completed'); // 不误判 tamper, 补完同一事务
    expect(rep.entries[0].commit).toBe(gitHead(root));
    expect(fs.readFileSync(path.join(root, '.assistant/signals/ingest.jsonl'), 'utf8')).toBe(outA);
    expect(fs.readFileSync(plotAbs, 'utf8')).toBe('Y\n'); // no-op 目标内容原样保留
    expect(gitStatusPorcelain(root)).toEqual(['M .assistant/signals/plot.jsonl']); // 作者未提交编辑保留并可见
    expect(intentDirs(root)).toEqual([]);
  });
});

describe('复审 Blocker C: 公开 request plain-data 对抗(任何 getter 前 fail-closed)', () => {
  it('Proxy request → INVALID_REQUEST, 零 getter 触发; 零副作用', async () => {
    const root = makeVault();
    const f = fixture(root);
    let gets = 0;
    const proxyRequest = new Proxy(canonicalRequest(f), {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        gets += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        gets += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    await expect(executeTransaction(root, proxyRequest, { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(gets).toBe(0); // isProxy 在一切属性访问之前判定
    expect(intentDirs(root)).toEqual([]); // 零副作用(未到 intent 建立)
    expect(gitHead(root)).toBe(gitRun(root, ['rev-parse', 'HEAD']));
  });

  it('accessor request / class instance request → INVALID_REQUEST(fail-closed)', async () => {
    const root = makeVault();
    const f = fixture(root);
    let touched = false;
    const accessorReq: Record<string, unknown> = { purpose: 'x', writeSet: [] };
    Object.defineProperty(accessorReq, 'kind', {
      get() {
        touched = true;
        return 'canonical';
      },
      enumerable: true,
      configurable: true,
    });
    await expect(executeTransaction(root, accessorReq as unknown as TransactionRequest, { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(touched).toBe(false); // accessor 描述符在 getter 触发前被拒

    class RequestLike {
      kind = 'canonical';
      purpose = 'x';
      writeSet = [
        { path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: f.out1 },
      ];
    }
    await expect(executeTransaction(root, new RequestLike() as unknown as TransactionRequest, { lockWaitMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(intentDirs(root)).toEqual([]);
  });

  it('writeSet 目标 / planSource / hooks 为 Proxy 或 accessor → INVALID_REQUEST', async () => {
    const root = makeVault();
    const f = fixture(root);
    let gets = 0;
    const proxyTarget = new Proxy(
      { path: 'world/objects/obj1.md', expected: { absent: false, sha256: f.sha1 }, output: f.out1 },
      {
        get(target, key, receiver) {
          gets += 1;
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          gets += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    await expect(
      executeTransaction(root, { ...canonicalRequest(f), writeSet: [proxyTarget as unknown as TargetSpec] }, { lockWaitMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(gets).toBe(0);

    const proxyPlanSource = new Proxy({ path: '.assistant/checkpoint.json', digest: sha256Hex('x') }, {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(
      executeTransaction(
        root,
        { kind: 'state', purpose: 'x', planSource: proxyPlanSource as unknown as { path: string; digest: string }, writeSet: [] },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(gets).toBe(0);
  });

  it('未知顶层字段 → INVALID_REQUEST; run_bootstrap 缺 runFile → INVALID_REQUEST', async () => {
    const root = makeVault();
    const f = fixture(root);
    await expect(
      executeTransaction(root, { ...canonicalRequest(f), bogusField: 1 } as unknown as TransactionRequest, { lockWaitMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // run_bootstrap: runId/inputFingerprint 在但 runFile 缺失(快照保留校验)。
    await expect(
      executeTransaction(
        root,
        { kind: 'run_bootstrap', purpose: 'x', runId: 'r-1', inputFingerprint: sha256Hex('c'), writeSet: [] },
        { lockWaitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(intentDirs(root)).toEqual([]);
  });
});

// ============================================================================
// N32 最终复审 P1 回归(authority/noop/plain-data 397 保持全绿之上新增):
//   P1-1. intent READY 之前零 ODB/私有 index 副作用 —— plan identity 先纯字节推导;
//   P1-2. 生产 execute/recovery 复用 git-transaction 加固原语: sha1+sha256 object
//         format、最小 env 清 GIT_* 重定向、commit 阶段复用 commitTransaction;
//   P1-3. 共享 index 安装 TOCTOU: 拿锁后 identity/bytes/tree CAS 复核, 事务期间
//         作者 staged 不得被覆盖; update-ref 前/安装前 staged 重验。
// ============================================================================

describe('N32 最终复审 P1-1: intent READY 前零 ODB/私有 index 副作用', () => {
  it('crash@after_preflight 与 crash@intent-ready: 零新对象、零私有 index(P1-1)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const countBefore = gitCountObjects(root);
    expect(privateIndexResidues(root)).toEqual([]);

    // (a) crash@after_preflight: intent 尚未建立 → 零 ODB/私有 index/intent 副作用。
    await expect(
      executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, faults: { after_preflight: 'crash' } }),
    ).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(gitCountObjects(root)).toBe(countBefore); // 零新 ODB 对象(无 hash-object -w)
    expect(privateIndexResidues(root)).toEqual([]); // 零私有 index
    expect(intentDirs(root)).toEqual([]); // intent 未建立

    // (b) crash@intent-ready: intent 已耐久化(READY), 但 ODB/私有 index 仍零副作用。
    await expect(executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0, ...crashAt('intent-ready') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    expect(intentDirs(root).length).toBe(1); // intent 已 READY(恢复元数据在)
    expect(gitCountObjects(root)).toBe(countBefore); // 零新 ODB 对象(纯字节推导零副作用)
    expect(privateIndexResidues(root)).toEqual([]); // 零私有 index
    expect(fs.readFileSync(f.obj1Abs, 'utf8')).toContain('阿甲的正文 A'); // 工作树零副作用

    // 恢复收敛(canonical 未 commit → 条件回滚), intent 清理。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('rolled_back');
    expect(intentDirs(root)).toEqual([]);
    expect(gitHead(root)).toBe(f.base);
  });
});

describe('N32 最终复审 P1-2: 生产路径复用 git-transaction 加固原语(sha256 + env 攻击)', () => {
  it('derivePlanIdentityPure 与 materialize 一致且零副作用(纯字节推导, P1-1 基础)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const before = gitCountObjects(root);
    const pure = derivePlanIdentityPure(root, f.base, [
      { path: 'world/objects/obj1.md', outputBytes: f.out1 },
      { path: 'world/objects/obj2.md', outputBytes: f.out2 },
    ]);
    // 纯推导结果: tree 40-hex、digest 64-hex、blob 40-hex。
    expect(pure.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(pure.planDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const t of pure.targetBlobs) {
      expect(t.blob).toMatch(/^[0-9a-f]{40}$/);
    }
    // 零副作用: 无新 ODB 对象、无私有 index 工件。
    expect(gitCountObjects(root)).toBe(before);
    expect(privateIndexResidues(root)).toEqual([]);
    // 与 materialize 一致(derivePlanIdentity 物化; 输出字节相同 → 同 tree/digest)。
    const mat = derivePlanIdentity(root, f.base, [
      { path: 'world/objects/obj1.md', output: f.out1 },
      { path: 'world/objects/obj2.md', output: f.out2 },
    ], 'pure-check');
    expect(mat.tree).toBe(pure.tree);
    expect(mat.planDigest).toBe(pure.planDigest);
    expect(mat.targetBlobs).toEqual(pure.targetBlobs);
  });

  it.skipIf(!sha256Supported)('sha256 object format 仓库: 生产 execute 全流程 + 崩溃恢复(64-hex OID, P1-2)', async () => {
    const { root, cleanup } = tmpVault();
    cleanups.push(cleanup);
    // 以 GIT_DEFAULT_HASH=sha256 重新初始化(initVault 受控透传; 断言 64-hex OID)。
    process.env.GIT_DEFAULT_HASH = 'sha256';
    try {
      initRepo(root);
    } finally {
      delete process.env.GIT_DEFAULT_HASH;
    }
    expect(gitRun(root, ['rev-parse', '--show-object-format'])).toBe('sha256');
    const f = fixture(root);
    expect(f.base).toMatch(/^[0-9a-f]{64}$/); // base commit 64-hex

    // 成功提交: commit/tree 64-hex, index 同步, 身份固定 novelcraft。
    const res = await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 });
    expect(res.outcome).toBe('committed');
    expect(res.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(res.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(gitHead(root)).toBe(res.commit);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(gitLogSubjects(root, 100).some((s) => s.includes(res.txid))).toBe(true);

    // 崩溃 + 恢复: 首轮提交后工作树内容 == out1/out2, 用新 expected 构建第二轮计划。
    const out1c = serializeFrontmatter({ id: 'obj1', kind: 'character', name: '阿甲', status: 'canonical' }, '阿甲的正文 C');
    const out2c = serializeFrontmatter({ id: 'obj2', kind: 'location', name: '青石镇', status: 'canonical' }, '青石镇的正文 C');
    const plan2 = canonicalRequest(f, {
      writeSet: [
        { path: 'world/objects/obj1.md', expected: { absent: false, sha256: sha256Hex(f.out1) }, output: out1c },
        { path: 'world/objects/obj2.md', expected: { absent: false, sha256: sha256Hex(f.out2) }, output: out2c },
      ],
    });
    await expect(executeTransaction(root, plan2, { lockWaitMs: 0, ...crashAt('first-rename') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    let rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('rolled_back');
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);

    const plan3 = canonicalRequest(f, {
      writeSet: [
        { path: 'world/objects/obj1.md', expected: { absent: false, sha256: sha256Hex(f.out1) }, output: out1c },
        { path: 'world/objects/obj2.md', expected: { absent: false, sha256: sha256Hex(f.out2) }, output: out2c },
      ],
    });
    await expect(executeTransaction(root, plan3, { lockWaitMs: 0, ...crashAt('ref-cas') })).rejects.toBeInstanceOf(
      CrashSimulatedError,
    );
    rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('committed');
    expect(rep.entries[0].commit).toMatch(/^[0-9a-f]{64}$/);
    expect(gitHead(root)).toBe(rep.entries[0].commit);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
  });

  it('生产 execute env 攻击: GIT_DIR/GIT_OBJECT_DIRECTORY/GIT_INDEX_FILE/GIT_NAMESPACE/GIT_CONFIG 注入不生效(P1-2)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const decoy = tmpVault();
    cleanups.push(decoy.cleanup);
    gitInit(decoy.root);
    const extObjDir = path.join(decoy.root, 'objects');
    fs.mkdirSync(extObjDir, { recursive: true });
    const evilIndex = path.join(decoy.root, 'evil-index');
    const saved = new Map<string, string | undefined>();
    for (const k of ['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      saved.set(k, process.env[k]);
    }
    process.env.GIT_DIR = decoy.root;
    process.env.GIT_OBJECT_DIRECTORY = extObjDir;
    process.env.GIT_INDEX_FILE = evilIndex;
    process.env.GIT_NAMESPACE = 'evil-ns';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'evil-editor';
    let res: Awaited<ReturnType<typeof executeTransaction>>;
    try {
      res = await executeTransaction(root, canonicalRequest(f), { lockWaitMs: 0 });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    // 真实仓库照常推进(攻击不生效): commit 落真实仓库, 身份固定 novelcraft(配置注入被清)。
    expect(res.outcome).toBe('committed');
    expect(gitHead(root)).toBe(res.commit);
    expect(gitRun(root, ['log', '-1', '--format=%an <%ae>'])).toBe('novelcraft <novelcraft@example.invalid>');
    expect(gitRun(root, ['for-each-ref'])).not.toContain('evil-ns'); // 无 namespace ref
    // decoy 零副作用: 无对象、无 evil index、无 ref、无 novelcraft 工件。
    expect(fs.readdirSync(extObjDir)).toEqual([]);
    expect(fs.existsSync(evilIndex)).toBe(false);
    expect(gitRun(decoy.root, ['for-each-ref'])).toBe('');
    expect(fs.readdirSync(path.join(decoy.root, '.git')).filter((n) => n.includes('novelcraft-'))).toEqual([]);
    expect(intentDirs(root)).toEqual([]);
    expect(privateIndexResidues(root)).toEqual([]);
  });
});

describe('N32 最终复审 P1-3: 共享 index 安装 TOCTOU 与 staged 重验', () => {
  it('拿锁后作者 staged(绕过锁的原始替换)→ SHARED_INDEX_CONFLICT, 不覆盖, staged 保留, 恢复 preserved(P1-3)', async () => {
    const root = makeVault();
    const f = fixture(root);
    let injected = false;
    const err = await executeTransaction(
      root,
      canonicalRequest(f, {
        hooks: {
          // 拿锁后、安装前的真实 TOCTOU 窗口: 模拟不遵守锁的作者直接把 staged
          // 写进共享 index(git add 走临时 index 后原始替换, 绕过 git 锁互斥)。
          afterSharedIndexLock: () => {
            if (injected) return;
            injected = true;
            fs.writeFileSync(path.join(root, 'notes.md'), '作者暂存\n');
            const gitDir = path.join(root, '.git');
            const tmpIdx = path.join(gitDir, 'evil-tmp-index');
            fs.copyFileSync(path.join(gitDir, 'index'), tmpIdx);
            execFileSync('git', ['add', 'notes.md'], {
              cwd: root,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, GIT_INDEX_FILE: tmpIdx },
            });
            fs.renameSync(tmpIdx, path.join(gitDir, 'index'));
          },
        },
      }),
      { lockWaitMs: 0 },
    ).catch((e: unknown) => e as TransactionError);
    expect(err.code).toBe('SHARED_INDEX_CONFLICT'); // 拿锁后复核发现 index 身份/字节/tree 变化
    expect(gitHead(root)).not.toBe(f.base); // update-ref 已成功 → commit 是 canonical 终点
    // 作者的 staged 不被覆盖: 共享 index 仍含 notes.md 的 staged 条目。
    expect(gitStatusPorcelain(root).some((l) => l.startsWith('A ') && l.includes('notes.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.git', 'index.lock'))).toBe(false); // 锁已释放
    // 恢复: index 非 BASE/OUTPUT → 保留现场, intent 留存。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(rep.unresolved).toEqual([rep.entries[0].txid]);
    expect(gitStatusPorcelain(root).some((l) => l.startsWith('A ') && l.includes('notes.md'))).toBe(true);
  });

  it('update-ref 前 staged 重验: 作者在复核点 git add → STAGED_CONFLICT, 不 update-ref, staged 保留(P1-3)', async () => {
    const root = makeVault();
    const f = fixture(root);
    const err = await executeTransaction(
      root,
      canonicalRequest(f, {
        hooks: {
          beforeRefCas: () => {
            fs.writeFileSync(path.join(root, 'notes.md'), '作者暂存\n');
            gitAdd(root, ['notes.md']); // 作者在复核点 git add(commitTransaction 复用原语重验)
          },
        },
      }),
      { lockWaitMs: 0 },
    ).catch((e: unknown) => e as TransactionError);
    expect(err.code).toBe('STAGED_CONFLICT'); // update-ref 前 staged 重验(fail-closed)
    expect(gitHead(root)).toBe(f.base); // 不 update-ref、无事务 commit
    expect(gitLogSubjects(root, 100).some((s) => s.includes('vtx:'))).toBe(false);
    // 作者 staged 保留(不自动清除、不覆盖)。
    expect(gitStatusPorcelain(root).some((l) => l.startsWith('A ') && l.includes('notes.md'))).toBe(true);
    expect(intentDirs(root).length).toBe(1); // 矩阵: index CONFLICT → 保留现场
    // 恢复: 作者 staged 仍被识别为外部内容 → preserved。
    const rep = await recoverInterruptedTransactions(root, { lockStaleMs: 1 });
    expect(rep.entries[0].outcome).toBe('preserved');
    expect(gitStatusPorcelain(root).some((l) => l.startsWith('A ') && l.includes('notes.md'))).toBe(true);
  });
});
