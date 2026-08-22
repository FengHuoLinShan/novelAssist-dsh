/**
 * git-transaction.test.ts — ADR-0021 §6 Git 提交协议原语行为契约(N32, 2026-08-15;
 * 独立审查加固①②轮后新增攻击面/竞态覆盖; 适配统一 txid 契约(codec/execute 同口径
 * `tx-` + 64 位小写 hex))。
 *
 * 真实临时 git 仓库(vitest), 断言注释引 N32/ADR 章句, 覆盖:
 *  ① 私有 index 从 base HEAD 构建的 exact tree 只含实际变化集, 无关 unstaged/untracked
 *     永不进 commit(N32 §6; ADR-0021 §1/§6);
 *  ② writeSet 删除目标 force-remove 后 exact tree 正确(ADR-0021 §6);
 *  ③ 外部 ref 抢先推进使 `update-ref` CAS 失败, 不 force(N32 影响③; 早退检查);
 *  ④ 后续无关 commit 后仍按 txid/plan-digest 在可达历史找到唯一 tx commit(N32 影响⑧);
 *  ⑤ 外部相同字节(message/tree/parent 全同)但身份/日期不同的 commit 不造成假阳性
 *     (N32 影响⑧ + 加固③: 字节级重算 OID 唯一接受门);
 *  ⑥ 身份正确但 trailer 缺失或 tree 不符不认(严格验证, ADR-0021 §6);
 *  ⑦ 未知 ref(detached/unborn)与共享 index.lock fail-closed(ADR-0021 §6/失败关闭);
 *  ⑧ 新 HEAD shared index bytes 原子安装后 status 干净、内容 == 计划输出(ADR-0021 §6);
 *  ⑨ plan digest 确定性(同 base/tree/writeSet → 同 digest, 与 txid 无关; 仍 sha256);
 *  ⑩ writeSet 路径穿越/绝对路径/空段/重复/.git 内部/非法 txid/kind/mode fail-closed;
 * ⑪ 加固①: 两仓 GIT_DIR/GIT_NAMESPACE 环境重定向攻击 —— allowlist 清除 + 钉固
 *     --git-dir/--work-tree, 真实仓库正常推进、decoy 零副作用;
 * ⑫ 加固②: replace refs / grafts / shallow 等改变 provenance 的仓库状态 →
 *     REPO_STATE_UNSAFE fail-closed(commit 与 find 均拒绝);
 * ⑬ 加固③: 确定性 author/committer date(规范常量)使 commit OID = tx 参数纯函数;
 *     同参数重试同 OID(幂等); find 以字节级重算 OID 为唯一门, 日期伪造 → TX_NOT_FOUND;
 * ⑭ 加固④: ref 只允许当前 symbolic HEAD 对应 refs/heads/*(拒 tag/任意 ref); commit 前
 *     再次验证 symbolic HEAD 未切换(切换 → REF_CAS_FAILED, 不写目标 ref);
 * ⑮ 加固⑤: sha256 object format 仓库(本机 git 支持时)64-hex OID 全流程;
 * ⑯ 加固⑦: 真实 CAS 窗口(测试钩子推进 ref / 真实 ref lock)→ update-ref 失败分类
 *     REF_CAS_FAILED;
 * ⑰ 加固⑧: GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES 对象重定向攻击 ——
 *     对象只落真实仓库 ODB, 外部对象目录零对象;
 * ⑱ 加固⑨: shared index 预存 staged → STAGED_CONFLICT(commit 前早退与 update-ref 前
 *     重验窗口); 目标工作树 ≠ 计划期望状态 → WORKTREE_CONFLICT; update-ref 前出现的
 *     共享 index.lock → INDEX_LOCKED;
 * ⑲ 加固⑩: find 由规范 writeSet(含 mode)重算 tree/plan digest(不信任自报值), 重复
 *     trailers 拒绝(非 Map 覆盖);
 * ⑳ 加固⑪: 事务私有 index 的 .lock 残留 → INDEX_LOCKED; finally 以 (dev,ino) 守卫
 *     不删除并发者替换后的私有 index。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitAdd, gitCommit, gitInit } from '../src/git';
import { sha256Hex } from '../src/hash';
import { tmpVault } from './helpers';
import {
  buildHeadIndexBytes,
  buildTxCommitMessage,
  commitTransaction,
  computeExpectedTxCommitOid,
  derivePlanIdentityPure,
  findTxCommit,
  GitTransactionError,
  NOVELCRAFT_TX_DATE,
  resolveCurrentRef,
  type CommitTxnResult,
  type TxCommitIdentity,
  type TxTargetWrite,
} from '../src/transaction/git-transaction';

/** sha256 object format 支持探测(本机 git >= 2.29 才支持; 不支持则跳过 ⑮)。 */
let sha256Supported = true;
try {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-sha256-probe-'));
  try {
    execFileSync('git', ['init', '-q', '--object-format=sha256'], { cwd: probe, stdio: 'ignore' });
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
} catch {
  sha256Supported = false;
}

const cleanups: Array<() => void> = [];

function repo(): { root: string } {
  const { root, cleanup } = tmpVault();
  cleanups.push(cleanup);
  gitInit(root);
  return { root };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** 测试侧 git CLI(直接 execFileSync; 生产实现不用 git add/commit, 测试夹具可自由使用)。 */
function g(
  root: string,
  args: string[],
  opts: { input?: string | Buffer; env?: Record<string, string>; allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    if (opts.allowFailure) return '';
    throw err;
  }
}

const NOVELCRAFT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'novelcraft',
  GIT_AUTHOR_EMAIL: 'novelcraft@example.invalid',
  GIT_COMMITTER_NAME: 'novelcraft',
  GIT_COMMITTER_EMAIL: 'novelcraft@example.invalid',
};

/** 统一 txid 契约(codec isTxId 同口径: `tx-` + 64 位小写 hex); 测试用确定性派生(名称 → txid)。 */
const txidFor = (name: string): string => `tx-${sha256Hex(`txid:${name}`)}`;

/** 夹具初始 commit(生产路径外; 仅构建 base HEAD)。 */
function initCommit(root: string, files: Record<string, string>, msg = 'init'): string {
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  gitAdd(root);
  return gitCommit(root, msg);
}

function txnParams(
  root: string,
  baseHead: string,
  targets: TxTargetWrite[],
  over: Partial<{ ref: string; txid: string; kind: string; expect: { tree?: string; planDigest?: string }; hooks: NonNullable<Parameters<typeof commitTransaction>[0]['hooks']> }> = {},
): Parameters<typeof commitTransaction>[0] {
  return {
    repoDir: root,
    ref: over.ref ?? 'refs/heads/main',
    baseHead,
    txid: over.txid ?? txidFor('default'),
    kind: over.kind ?? 'adopt',
    targets,
    expect: over.expect,
    hooks: over.hooks,
  };
}

function identityOf(res: CommitTxnResult): TxCommitIdentity {
  return {
    txid: res.txid,
    kind: res.kind,
    baseHead: res.baseHead,
    targetBlobs: res.targetBlobs.map((t) => ({ path: t.path, mode: t.mode, blob: t.blob })),
  };
}

function changedPaths(root: string, commit: string): string[][] {
  return g(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', `${commit}^`, commit])
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

function txError(fn: () => unknown): GitTransactionError {
  try {
    fn();
  } catch (err) {
    if (err instanceof GitTransactionError) return err;
    throw err;
  }
  throw new Error('应当抛出 GitTransactionError, 但未抛出');
}

/** 无 novelcraft 工件残留断言(私有 index/head index 等)。 */
function expectNoNovelcraftArtifacts(root: string): void {
  expect(fs.readdirSync(path.join(root, '.git')).filter((f) => f.includes('novelcraft-'))).toEqual([]);
}

describe('transaction/git-transaction — ADR-0021 §6 Git 提交协议原语(真实 git, N32)', () => {
  it('exact tree: 只含实际变化集; 无关 unstaged/untracked 不入 commit; 固定 novelcraft 身份 + trailers', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'b.md': 'B1\n', 'dir/c.md': 'C1\n' });
    const { ref, head } = resolveCurrentRef(root);
    expect(head).toBe(base);
    expect(ref).toBe('refs/heads/main');

    // 无关改动(不在 writeSet): a.md 修改 + notes.md untracked —— 允许存在, 不检查不提交(N32 §1)。
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'N\n');
    // 模拟上层写面: 计划输出已写入工作树(b.md/dir/c.md; update-ref 前工作树期望状态重验)。
    fs.writeFileSync(path.join(root, 'b.md'), 'B2\n');
    fs.writeFileSync(path.join(root, 'dir/c.md'), 'C2\n');

    // 实际变化集: b.md / dir/c.md(计划输出在生成时定型)。
    const res = commitTransaction(
      txnParams(root, head, [
        { path: 'b.md', outputBytes: 'B2\n' },
        { path: 'dir/c.md', outputBytes: 'C2\n' },
      ]),
    );
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(res.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(res.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.txid).toMatch(/^tx-[0-9a-f]{64}$/);
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(res.commit); // CAS 推进

    // ① exact tree: 变更集恰等于实际变化集(ADR-0021 §4: 私有 exact tree 的变化集必须恰等)。
    expect(changedPaths(root, res.commit)).toEqual([
      ['M', 'b.md'],
      ['M', 'dir/c.md'],
    ]);
    // a.md 的 blob 未变(无关 unstaged 不入 commit), notes.md 不在树中。
    expect(g(root, ['rev-parse', `${base}:a.md`]).trim()).toBe(g(root, ['rev-parse', `${res.commit}:a.md`]).trim());
    expect(g(root, ['rev-parse', `${res.commit}:notes.md`], { allowFailure: true }).trim()).toBe('');
    expect(g(root, ['ls-tree', '-r', res.commit]).trim()).not.toContain('notes.md');

    // 固定 novelcraft author/committer(N32 影响⑧ 身份验证基础)。
    expect(g(root, ['log', '--format=%an|%ae|%cn|%ce', '-n', '1']).trim()).toBe(
      'novelcraft|novelcraft@example.invalid|novelcraft|novelcraft@example.invalid',
    );
    // trailers 完整且 plan-digest 精确。
    const body = g(root, ['log', '--format=%B', '-n', '1']).trimEnd();
    expect(body).toContain(`txid: ${res.txid}`);
    expect(body).toContain('kind: adopt');
    expect(body).toContain(`plan-digest: ${res.planDigest}`);

    // 工作区: 无关改动仍在(不 reset 不还原)。共享 index 本用例未同步(仍是 base 状态,
    // 对应 ADR-0021 §6 的「构建与新 HEAD 一致的最终 index 并原子安装」——由本模块
    // buildHeadIndexBytes 产 bytes、上层安装, 见下方 index bytes 用例)。此时:
    //   a.md: 无关 unstaged(共享 index==base, worktree A2)→ ' M';
    //   b.md/dir/c.md: 模拟上层写面已写计划输出(共享 index 为 base 旧 blob、worktree 为
    //     计划输出、HEAD 已是新 blob)→ 'MM'(index vs HEAD + worktree vs index);
    //   notes.md: 无关 untracked → '??'。本事务未把任何文件 stage 进共享 index。
    const statusEntries = g(root, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).map((l) => ({
      status: l.slice(0, 2),
      path: l.slice(3),
    }));
    const statusByPath = new Map(statusEntries.map((e) => [e.path, e.status]));
    expect(statusByPath.get('a.md')).toBe(' M');
    expect(statusByPath.get('b.md')).toBe('MM');
    expect(statusByPath.get('dir/c.md')).toBe('MM');
    expect(statusByPath.get('notes.md')).toBe('??');
    expect(statusEntries).toHaveLength(4);
    expect(statusEntries.some((e) => e.status.startsWith('A'))).toBe(false);

    // 私有 index 已清理(不残留 tx 工件)。
    expectNoNovelcraftArtifacts(root);
  });

  it('writeSet 删除目标: force-remove 后 exact tree 不含该路径, 其余不变', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'b.md': 'B1\n', 'dir/c.md': 'C1\n' });
    // 模拟上层写面: 删除目标已从工作树移除、写目标已写入计划输出。
    fs.rmSync(path.join(root, 'b.md'));
    fs.writeFileSync(path.join(root, 'dir/c.md'), 'C2\n');
    const res = commitTransaction(
      txnParams(root, base, [
        { path: 'b.md' }, // 无 outputBytes = 删除目标
        { path: 'dir/c.md', outputBytes: 'C2\n' },
      ], { txid: txidFor('del'), kind: 'map-atlas' }),
    );
    expect(changedPaths(root, res.commit)).toEqual([
      ['D', 'b.md'],
      ['M', 'dir/c.md'],
    ]);
    expect(g(root, ['rev-parse', `${res.commit}:a.md`]).trim()).toBe(g(root, ['rev-parse', `${base}:a.md`]).trim());
    expect(g(root, ['rev-parse', `${res.commit}:b.md`], { allowFailure: true }).trim()).toBe('');
    expect(g(root, ['rev-parse', `${res.commit}:dir/c.md`]).trim()).not.toBe(g(root, ['rev-parse', `${base}:dir/c.md`]).trim());
  });

  it('ref 竞争: 外部先推进 → update-ref CAS 失败(REF_CAS_FAILED), 不 force, 私有工件清理', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'b.md': 'B1\n' });
    // 不遵守本协议的进程抢先提交并推进 ref(测试用 commit-tree 模拟; N32 §3 边界: 不阻止外部)。
    const extTree = g(root, ['rev-parse', `${base}^{tree}`]).trim();
    const extCommit = g(root, ['commit-tree', extTree, '-p', base], {
      input: 'external commit\n',
      env: {
        GIT_AUTHOR_NAME: 'editor',
        GIT_AUTHOR_EMAIL: 'editor@example.invalid',
        GIT_COMMITTER_NAME: 'editor',
        GIT_COMMITTER_EMAIL: 'editor@example.invalid',
      },
    }).trim();
    g(root, ['update-ref', 'refs/heads/main', extCommit, base]);

    // 本事务仍按计划 base 提交 → 开启检查(ref 当前 == ext != base)即 REF_CAS_FAILED(N32 影响③)。
    const err = txError(() =>
      commitTransaction(txnParams(root, base, [{ path: 'b.md', outputBytes: 'B2\n' }], { txid: txidFor('race') })),
    );
    expect(err.code).toBe('REF_CAS_FAILED');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(extCommit); // 外部推进未被覆盖
    // 未产生任何可达新 commit(base + ext 两条)。
    expect(g(root, ['rev-list', 'HEAD']).trim().split(/\r?\n/).filter(Boolean).length).toBe(2);
    expectNoNovelcraftArtifacts(root);
  });

  it('后续无关 commit 后仍按 txid/plan-digest 在可达历史找到唯一 tx commit', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'b.md': 'B1\n' });
    fs.writeFileSync(path.join(root, 'b.md'), 'B2\n'); // 模拟上层写面
    const res = commitTransaction(txnParams(root, base, [{ path: 'b.md', outputBytes: 'B2\n' }], { txid: txidFor('seq') }));
    // 后续提交(作者继续编辑/外部提交; 基于 tx commit)。
    const subTree = g(root, ['rev-parse', `${res.commit}^{tree}`]).trim();
    const sub = g(root, ['commit-tree', subTree, '-p', res.commit], {
      input: 'subsequent author edit\n',
      env: {
        GIT_AUTHOR_NAME: 'author',
        GIT_AUTHOR_EMAIL: 'author@example.invalid',
        GIT_COMMITTER_NAME: 'author',
        GIT_COMMITTER_EMAIL: 'author@example.invalid',
      },
    }).trim();
    g(root, ['update-ref', 'refs/heads/main', sub, res.commit]);

    // ④ 后续无关 commit 不造成假阴性(N32 影响⑧: 可达历史包含祖先)。
    expect(findTxCommit(root, sub, identityOf(res))).toEqual({ commit: res.commit });
    expect(findTxCommit(root, res.commit, identityOf(res))).toEqual({ commit: res.commit });
  });

  it('同字节外部 commit(message/tree/parent 全同、身份/日期不同)不造成假阳性', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const res = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('forge') }));

    // 逐字节复刻 message(与真 commit 的 message 完全相同), tree/parent 相同, 仅身份/日期为 external。
    // 从 `cat-file commit` 原样切出 message 字节(不用 `git log %B`, 其会追加换行, 非字节原样)。
    const commitMsg = (sha: string): string => {
      const raw = g(root, ['cat-file', 'commit', sha]);
      return raw.slice(raw.indexOf('\n\n') + 2);
    };
    const msgBytes = commitMsg(res.commit);
    const forged = g(root, ['commit-tree', `${res.commit}^{tree}`, '-p', base], {
      input: msgBytes,
      env: {
        ...NOVELCRAFT_ENV, // 身份也伪装成 novelcraft —— 唯一差异在 author/committer date(加固③)
        GIT_AUTHOR_DATE: '2000-01-01 00:00:00 +0000',
        GIT_COMMITTER_DATE: '2000-01-01 00:00:00 +0000',
      },
    }).trim();
    // 同字节确认: 两 commit 的 message 字节完全一致; tree/parent 相同(仅 author/committer 行不同)。
    expect(commitMsg(forged)).toBe(msgBytes);
    expect(commitMsg(forged)).toBe(buildTxCommitMessage(res.txid, res.kind, res.planDigest));
    expect(g(root, ['rev-parse', `${forged}^{tree}`]).trim()).toBe(g(root, ['rev-parse', `${res.commit}^{tree}`]).trim());
    expect(g(root, ['rev-parse', `${forged}^`]).trim()).toBe(base);
    expect(g(root, ['cat-file', 'commit', forged]).includes('author novelcraft <novelcraft@example.invalid>')).toBe(true);

    const identity = identityOf(res);
    // ⑤ 只含 forged 的历史 → 不认(字节级 OID 门拒绝日期伪造)。
    const err = txError(() => findTxCommit(root, forged, identity));
    expect(err.code).toBe('TX_NOT_FOUND');
    // forged + 真 commit 都在可达历史(merge 双亲)→ 仍唯一命中真 commit。
    const merged = g(root, ['commit-tree', `${res.commit}^{tree}`, '-p', res.commit, '-p', forged], {
      input: 'merge of both\n',
      env: {
        GIT_AUTHOR_NAME: 'merger',
        GIT_AUTHOR_EMAIL: 'merger@example.invalid',
        GIT_COMMITTER_NAME: 'merger',
        GIT_COMMITTER_EMAIL: 'merger@example.invalid',
      },
    }).trim();
    expect(findTxCommit(root, merged, identity)).toEqual({ commit: res.commit });
  });

  it('严格验证: 身份正确但 trailer 缺失, 或 tree 不符, 均不认', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const res = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('trailer') }));
    const identity = identityOf(res);

    // 同身份 + 同 tree, 但 message 无任何 trailer → 不认。
    const plain = g(root, ['commit-tree', `${res.commit}^{tree}`, '-p', base], {
      input: 'plain commit without trailers\n',
      env: NOVELCRAFT_ENV,
    }).trim();
    const plainErr = txError(() => findTxCommit(root, plain, identity));
    expect(plainErr.code).toBe('TX_NOT_FOUND');

    // 同身份 + 相同 trailers(同 txid/kind/digest bytes), 但 tree 不同(base tree)→ 不认。
    const wrongTree = g(root, ['commit-tree', `${base}^{tree}`, '-p', base], {
      input: buildTxCommitMessage(res.txid, res.kind, res.planDigest),
      env: NOVELCRAFT_ENV,
    }).trim();
    const treeErr = txError(() => findTxCommit(root, wrongTree, identity));
    expect(treeErr.code).toBe('TX_NOT_FOUND');
  });

  it('未知 ref fail-closed: detached HEAD 与 unborn 分支均 UNKNOWN_REF', () => {
    const { root } = repo();
    initCommit(root, { 'a.md': 'A1\n' });
    g(root, ['checkout', '-q', '--detach']);
    expect(txError(() => resolveCurrentRef(root)).code).toBe('UNKNOWN_REF');

    // unborn: 全新仓库(无任何 commit)。
    const { root: r2 } = repo();
    expect(txError(() => resolveCurrentRef(r2)).code).toBe('UNKNOWN_REF');
  });

  it('未知 .git/index.lock fail-closed: commit 前拒绝, 零 ref 副作用 + 私有工件不残留', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const lockPath = path.resolve(root, g(root, ['rev-parse', '--git-path', 'index.lock']).trim());
    fs.writeFileSync(lockPath, '');
    const err = txError(() =>
      commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('lock') })),
    );
    expect(err.code).toBe('INDEX_LOCKED');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base); // 零副作用
    expectNoNovelcraftArtifacts(root);
  });

  it('新 HEAD shared index bytes: 原子安装后 status 干净、树条目一致、内容 == 计划输出', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'dir/b.md': 'B1\n' });
    // 上层写面流程: rename 计划输出到工作树后提交事务。
    const outputA = 'A2\n';
    const outputB = 'B2\n';
    fs.writeFileSync(path.join(root, 'a.md'), outputA);
    fs.writeFileSync(path.join(root, 'dir/b.md'), outputB);
    const res = commitTransaction(
      txnParams(root, base, [
        { path: 'a.md', outputBytes: outputA },
        { path: 'dir/b.md', outputBytes: outputB },
      ], { txid: txidFor('idx') }),
    );

    // ⑧ 构建与新 HEAD 一致(或更精确: 与 commit 一致)的共享 index bytes。
    const bytes = buildHeadIndexBytes(root, res.commit);
    expect(bytes.length).toBeGreaterThan(0);

    // 同目录 temp + rename 原子安装(上层职责; 本模块只产 bytes, N32/ADR-0021 §6)。
    const indexPath = path.resolve(root, g(root, ['rev-parse', '--git-path', 'index']).trim());
    const tmpIdx = path.join(path.dirname(indexPath), `.index.tmp-${Date.now()}`);
    fs.writeFileSync(tmpIdx, bytes);
    fs.renameSync(tmpIdx, indexPath);

    expect(g(root, ['status', '--porcelain']).trim()).toBe(''); // worktree == 新 HEAD
    const treeEntries = g(root, ['ls-tree', '-r', res.commit]).trim().split(/\r?\n/).filter(Boolean);
    expect(treeEntries).toContain(`100644 blob ${g(root, ['rev-parse', `${res.commit}:a.md`]).trim()}\ta.md`);
    expect(treeEntries).toContain(`100644 blob ${g(root, ['rev-parse', `${res.commit}:dir/b.md`]).trim()}\tdir/b.md`);
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe(outputA);
    expect(fs.readFileSync(path.join(root, 'dir/b.md'), 'utf8')).toBe(outputB);
  });

  it('plan digest 确定性: 同 base/tree/writeSet → 同 digest(与 txid 无关); 不同输出 → 不同 digest', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const params = txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('det'), kind: 'checkpoint' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面(r1/r2 输出)
    const r1 = commitTransaction(params);
    g(root, ['update-ref', 'refs/heads/main', base, r1.commit]); // 回退基线, 同输入重跑
    const r2 = commitTransaction({ ...params, txid: txidFor('det-2') });
    expect(r2.planDigest).toBe(r1.planDigest);
    expect(r2.tree).toBe(r1.tree);
    g(root, ['update-ref', 'refs/heads/main', base, r2.commit]);
    fs.writeFileSync(path.join(root, 'a.md'), 'A3\n'); // 模拟上层写面(r3 输出)
    const r3 = commitTransaction({ ...params, txid: txidFor('det-3'), targets: [{ path: 'a.md', outputBytes: 'A3\n' }] });
    expect(r3.planDigest).not.toBe(r1.planDigest);
  });

  it('writeSet 路径安全 / txid / kind / mode 校验: BAD_TARGET fail-closed, 零副作用', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const badPaths: TxTargetWrite[] = [
      { path: '' },
      { path: '../escape.md' },
      { path: '/abs.md' },
      { path: 'a/../../escape.md' },
      { path: 'a//b.md' },
      { path: './a.md' },
      { path: 'a/./b.md' },
      { path: '.git/config' },
      { path: 'a\\b.md' },
      { path: 'x'.repeat(600) },
      // 加固⑥: Windows drive / UNC / 控制字符 / 大小写不敏感 .git 段。
      { path: 'C:/x.md' },
      { path: 'C:x.md' },
      { path: 'c:/x.md' },
      { path: '//server/share.md' },
      { path: 'a\u0001b.md' },
      { path: 'a.md\u007f' },
      { path: '.GIT/config' },
      { path: 'Dir/.gIt/x.md' },
      { path: 'a/.GIT/b.md' },
    ];
    for (const t of badPaths) {
      expect(txError(() => commitTransaction(txnParams(root, base, [t], { txid: txidFor('bad') }))).code).toBe('BAD_TARGET');
      expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base); // 每次失败零副作用
    }
    // 重复目标路径。
    const dup = txError(() =>
      commitTransaction(
        txnParams(root, base, [
          { path: 'a.md', outputBytes: 'x' },
          { path: 'a.md', outputBytes: 'y' },
        ]),
      ),
    );
    expect(dup.code).toBe('BAD_TARGET');
    // 非法 txid / kind / mode(统一 txid 契约: 非 `tx-`+64hex 一律拒绝)。
    expect(txError(() => commitTransaction({ ...txnParams(root, base, []), txid: 'bad txid!' })).code).toBe('BAD_TARGET');
    expect(txError(() => commitTransaction({ ...txnParams(root, base, []), txid: 'txn-1' })).code).toBe('BAD_TARGET');
    expect(txError(() => commitTransaction({ ...txnParams(root, base, []), kind: 'bad kind!' })).code).toBe('BAD_TARGET');
    expect(
      txError(() => commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'x', mode: '100666' as TxTargetWrite['mode'] }]))).code,
    ).toBe('BAD_TARGET');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base);
  });

  // ============================================================================
  // 独立审查加固第 1 轮用例
  // ============================================================================

  it('⑪ 两仓 GIT_DIR/GIT_NAMESPACE 攻击: 环境重定向不生效(allowlist 清除 + --git-dir/--work-tree 钉固)', () => {
    const { root } = repo();
    const decoy = tmpVault();
    cleanups.push(decoy.cleanup);
    gitInit(decoy.root);
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    // 攻击: 父进程环境被注入指向/命名 decoy 仓库的 GIT_DIR 与 GIT_NAMESPACE
    // (GIT_NAMESPACE 若生效会把 update-ref 写进 refs/namespaces/<ns>/…)。
    process.env.GIT_DIR = decoy.root;
    process.env.GIT_NAMESPACE = 'evil-ns';
    let landed = '';
    try {
      landed = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('env') })).commit;
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_NAMESPACE;
    }
    // 真实仓库被推进(不是 decoy、不是 namespace)。
    expect(landed).toMatch(/^[0-9a-f]{40}$/);
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(landed);
    expect(g(root, ['rev-parse', 'HEAD']).trim()).not.toBe(base);
    expect(g(root, ['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/).filter(Boolean)).not.toContain(
      'refs/namespaces/evil-ns/refs/heads/main',
    );
    // decoy 零副作用: 无对象、无 commit、无工件残留。
    expect(g(decoy.root, ['count-objects']).trim()).toMatch(/^0 objects/);
    expect(g(decoy.root, ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { allowFailure: true }).trim()).toBe('');
    expect(fs.readdirSync(path.join(decoy.root, '.git')).filter((f) => f.includes('novelcraft-'))).toEqual([]);
  });

  it('⑫ replace refs / grafts / shallow: 改变 provenance 的仓库状态 → REPO_STATE_UNSAFE fail-closed', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const tree = g(root, ['rev-parse', `${base}^{tree}`]).trim();
    const alt = g(root, ['commit-tree', tree, '-p', base], { input: 'alt\n', env: NOVELCRAFT_ENV }).trim();
    // (a) replace refs。
    g(root, ['replace', base, alt]);
    expect(g(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']).trim()).not.toBe('');
    expect(
      txError(() => commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('repl') }))).code,
    ).toBe('REPO_STATE_UNSAFE');
    expect(
      txError(() => findTxCommit(root, base, { txid: txidFor('repl'), kind: 'adopt', baseHead: base, targetBlobs: [] })).code,
    ).toBe('REPO_STATE_UNSAFE');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base); // 零副作用
    g(root, ['replace', '-d', base]);
    expect(g(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']).trim()).toBe('');
    // (b) shallow 标记。
    fs.writeFileSync(path.join(root, '.git', 'shallow'), '');
    expect(
      txError(() => commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('shal') }))).code,
    ).toBe('REPO_STATE_UNSAFE');
    fs.rmSync(path.join(root, '.git', 'shallow'));
    // (c) grafts 文件。
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'info', 'grafts'), '');
    expect(
      txError(() => findTxCommit(root, base, { txid: txidFor('x'), kind: 'adopt', baseHead: base, targetBlobs: [] })).code,
    ).toBe('REPO_STATE_UNSAFE');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base);
  });

  it('⑬ 确定性日期与字节级 OID 重算: 同参数重试 → 同 commit; find 只接受 OID 相同; 日期伪造 → 不认; 拒 tag', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const params = txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('det-date'), kind: 'checkpoint' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const r1 = commitTransaction(params);
    // commit 对象字节携带规范确定性日期(加固③)。
    const raw = g(root, ['cat-file', 'commit', r1.commit]);
    expect(raw).toContain(`author novelcraft <novelcraft@example.invalid> ${NOVELCRAFT_TX_DATE} +0000`);
    expect(raw).toContain(`committer novelcraft <novelcraft@example.invalid> ${NOVELCRAFT_TX_DATE} +0000`);
    // 字节级重算: res.commit === computeExpectedTxCommitOid(root, identity)(commit-tree 字节精确,
    // tree/plan digest 由规范 writeSet 重算, 加固⑩)。
    expect(computeExpectedTxCommitOid(root, identityOf(r1))).toBe(r1.commit);
    // find 以重算 OID 为门命中。
    expect(findTxCommit(root, r1.commit, identityOf(r1))).toEqual({ commit: r1.commit });
    // 同参数(同 txid)回退后重跑 → 同 OID(commit OID = tx 参数纯函数, 重试幂等)。
    g(root, ['update-ref', 'refs/heads/main', base, r1.commit]);
    const r2 = commitTransaction(params);
    expect(r2.commit).toBe(r1.commit);
    expect(r2.planDigest).toBe(r1.planDigest);

    // 日期伪造: 同 tree/parent/message/trailers + novelcraft 身份, 仅 author/committer date 不同。
    const commitMsg = (sha: string): string => {
      const c = g(root, ['cat-file', 'commit', sha]);
      return c.slice(c.indexOf('\n\n') + 2);
    };
    const forged = g(root, ['commit-tree', `${r1.commit}^{tree}`, '-p', base], {
      input: commitMsg(r1.commit),
      env: { ...NOVELCRAFT_ENV, GIT_AUTHOR_DATE: '2000-01-01 00:00:00 +0000', GIT_COMMITTER_DATE: '2000-01-01 00:00:00 +0000' },
    }).trim();
    expect(forged).not.toBe(r1.commit); // 日期不同 → OID 不同
    expect(txError(() => findTxCommit(root, forged, identityOf(r1))).code).toBe('TX_NOT_FOUND');

    // ⑭ tag ref 拒绝(加固④): ref=refs/tags/* 永远不是当前 symbolic HEAD → UNKNOWN_REF。
    g(root, ['tag', 'v1', base]);
    const tagErr = txError(() => commitTransaction({ ...txnParams(root, base, []), ref: 'refs/tags/v1' }));
    expect(tagErr.code).toBe('UNKNOWN_REF');
    // HEAD 被手工指向 tag → resolveCurrentRef 拒绝(非 refs/heads/*)。
    g(root, ['symbolic-ref', 'HEAD', 'refs/tags/v1']);
    expect(txError(() => resolveCurrentRef(root)).code).toBe('UNKNOWN_REF');
  });

  it('⑭ symbolic HEAD 切换: commit 前再次验证, REF_CAS_FAILED 且不写目标 ref', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    g(root, ['branch', 'other', base]);
    const err = txError(() =>
      commitTransaction(
        txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], {
          txid: txidFor('head'),
          hooks: { beforeRefCas: () => g(root, ['checkout', '-q', 'other']) },
        }),
      ),
    );
    expect(err.code).toBe('REF_CAS_FAILED');
    expect(g(root, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/other');
    expect(g(root, ['rev-parse', 'refs/heads/main']).trim()).toBe(base); // 目标 ref 未被推进
    expectNoNovelcraftArtifacts(root);
  });

  it('⑯ 真实 CAS 窗口: 钩子在 update-ref 前推进 ref → REF_CAS_FAILED; 真实 ref lock → REF_CAS_FAILED', () => {
    // (a) 钩子推进 ref —— 早期检查之后、update-ref 之前的真实竞争窗口(加固⑦)。
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    let hookFired = false;
    const err = txError(() =>
      commitTransaction(
        txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], {
          txid: txidFor('win'),
          hooks: {
            beforeRefCas: () => {
              hookFired = true;
              const ext = g(root, ['commit-tree', `${base}^{tree}`, '-p', base], { input: 'external\n', env: NOVELCRAFT_ENV }).trim();
              g(root, ['update-ref', 'refs/heads/main', ext, base]);
            },
          },
        }),
      ),
    );
    expect(hookFired).toBe(true);
    expect(err.code).toBe('REF_CAS_FAILED');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).not.toBe(base); // 外部推进未被覆盖
    expect(g(root, ['rev-list', 'HEAD']).trim().split(/\r?\n/).filter(Boolean).length).toBe(2); // base + external
    expectNoNovelcraftArtifacts(root);

    // (b) 真实 ref lock: .git/refs/heads/main.lock 存在 → update-ref 锁失败 → REF_CAS_FAILED。
    const { root: r2 } = repo();
    const b2 = initCommit(r2, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(r2, 'a.md'), 'A3\n'); // 模拟上层写面
    fs.writeFileSync(path.join(r2, '.git', 'refs', 'heads', 'main.lock'), '');
    const err2 = txError(() => commitTransaction(txnParams(r2, b2, [{ path: 'a.md', outputBytes: 'A3\n' }], { txid: txidFor('lock2') })));
    expect(err2.code).toBe('REF_CAS_FAILED');
    expect(g(r2, ['rev-parse', 'HEAD']).trim()).toBe(b2); // ref 未动
    expectNoNovelcraftArtifacts(r2);
  });

  it.skipIf(!sha256Supported)('⑮ sha256 object format 仓库: 64-hex OID 全流程 + OID 重算一致(plan digest 仍 sha256)', () => {
    const { root } = repo();
    // 覆盖为 sha256 仓库(本机 git 不支持时整体跳过)。
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    g(root, ['init', '-q', '-b', 'main', '--object-format=sha256']);
    expect(g(root, ['rev-parse', '--show-object-format']).trim()).toBe('sha256');
    fs.writeFileSync(path.join(root, 'a.md'), 'A1\n');
    gitAdd(root);
    const base = gitCommit(root, 'init');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面

    const res = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('sha256') }));
    expect(res.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(res.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(res.planDigest).toMatch(/^[0-9a-f]{64}$/); // plan digest 仍为 sha256(与 object format 无关)
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(res.commit);
    // 字节级重算: sha256 object format 下以 sha256 哈希 commit 对象(重算 tree/digest)。
    expect(computeExpectedTxCommitOid(root, identityOf(res))).toBe(res.commit);
    expect(findTxCommit(root, res.commit, identityOf(res))).toEqual({ commit: res.commit });
    // 后续无关 commit(64-hex)后仍唯一命中。
    const sub = g(root, ['commit-tree', `${res.commit}^{tree}`, '-p', res.commit], { input: 'sub\n', env: NOVELCRAFT_ENV }).trim();
    expect(sub).toMatch(/^[0-9a-f]{64}$/);
    g(root, ['update-ref', 'refs/heads/main', sub, res.commit]);
    expect(findTxCommit(root, sub, identityOf(res))).toEqual({ commit: res.commit });
  });

  // ============================================================================
  // 独立审查加固第 2 轮用例
  // ============================================================================

  it('⑰ GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES 攻击: 对象只落真实仓库 ODB, 外部对象目录零对象', () => {
    const { root } = repo();
    const ext = tmpVault();
    cleanups.push(ext.cleanup);
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const extObjDir = path.join(ext.root, 'objects');
    const extAltDir = path.join(ext.root, 'alternates');
    fs.mkdirSync(extObjDir, { recursive: true });
    // 攻击: 环境注入 GIT_OBJECT_DIRECTORY(对象写重定向)与 GIT_ALTERNATE_OBJECT_DIRECTORIES。
    process.env.GIT_OBJECT_DIRECTORY = extObjDir;
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = extAltDir;
    let landed = '';
    try {
      landed = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('objdir') })).commit;
    } finally {
      delete process.env.GIT_OBJECT_DIRECTORY;
      delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    }
    expect(landed).toMatch(/^[0-9a-f]{40}$/);
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(landed); // 真实仓库被推进(对象在真实 ODB)
    // 外部对象目录零对象(对象写入不可能被导向外部目录, 加固⑧)。
    expect(fs.readdirSync(extObjDir)).toEqual([]);
    expect(fs.existsSync(extAltDir)).toBe(false);
  });

  it('⑱ 预存 staged → STAGED_CONFLICT(commit 前早退与 update-ref 前重验窗口)', () => {
    // (a) commit 前早退: 任何预存 staged 零对象写入拒绝。
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'b.md'), 'B\n');
    g(root, ['add', 'b.md']); // 外部编辑器预存 staged(N32 §2)
    const err = txError(() => commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('staged') })));
    expect(err.code).toBe('STAGED_CONFLICT');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base);
    expectNoNovelcraftArtifacts(root);

    // (b) update-ref 前重验窗口: 钩子在 commit 对象创建后 stage 外部文件 → STAGED_CONFLICT。
    const { root: r2 } = repo();
    const b2 = initCommit(r2, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(r2, 'a.md'), 'A2\n'); // 模拟上层写面
    const err2 = txError(() =>
      commitTransaction(
        txnParams(r2, b2, [{ path: 'a.md', outputBytes: 'A2\n' }], {
          txid: txidFor('staged2'),
          hooks: {
            beforeRefCas: () => {
              fs.writeFileSync(path.join(r2, 'b.md'), 'B\n');
              g(r2, ['add', 'b.md']);
            },
          },
        }),
      ),
    );
    expect(err2.code).toBe('STAGED_CONFLICT');
    expect(g(r2, ['rev-parse', 'HEAD']).trim()).toBe(b2); // 零 ref 副作用
    expectNoNovelcraftArtifacts(r2);
  });

  it('⑱ 目标工作树 ≠ 计划期望状态 → WORKTREE_CONFLICT(update-ref 前重验), 不提交', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    // 并发编辑把工作树内容改成与计划输出不同(上层写面写入后又被外部改动)。
    fs.writeFileSync(path.join(root, 'a.md'), 'CONCURRENT-EDIT\n');
    const err = txError(() =>
      commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('wt') })),
    );
    expect(err.code).toBe('WORKTREE_CONFLICT');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base); // 未提交
    expectNoNovelcraftArtifacts(root);
  });

  it('⑱ update-ref 前出现的共享 index.lock → INDEX_LOCKED(重验竞态窗口)', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const err = txError(() =>
      commitTransaction(
        txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], {
          txid: txidFor('idxlock2'),
          hooks: { beforeRefCas: () => fs.writeFileSync(path.join(root, '.git', 'index.lock'), '') },
        }),
      ),
    );
    expect(err.code).toBe('INDEX_LOCKED');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base); // 零 ref 副作用
    expectNoNovelcraftArtifacts(root);
  });

  it('⑲ 重复 trailers 拒绝(非 Map 覆盖): 同身份/日期/树但 message 带重复 txid trailer → 不认', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n'); // 模拟上层写面
    const res = commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: txidFor('dup') }));
    const identity = identityOf(res);
    // 伪造 message: 与真实 commit 相同身份/日期/tree/parent, 但 trailer 块中 txid 出现两次。
    const dupMsg = buildTxCommitMessage(res.txid, res.kind, res.planDigest) + `txid: ${res.txid}\n`;
    const forged = g(root, ['commit-tree', `${res.commit}^{tree}`, '-p', base], {
      input: dupMsg,
      env: { ...NOVELCRAFT_ENV, GIT_AUTHOR_DATE: '2026-01-01 00:00:00 +0000', GIT_COMMITTER_DATE: '2026-01-01 00:00:00 +0000' },
    }).trim();
    expect(forged).not.toBe(res.commit);
    // 重复 trailer → 不认(TX_NOT_FOUND; 且绝不因 Map 覆盖语义误判命中)。
    expect(txError(() => findTxCommit(root, forged, identity)).code).toBe('TX_NOT_FOUND');
  });

  it('⑳+ P1-1: derivePlanIdentityPure 纯字节推导零副作用, 与 materialize(commitTransaction expect 门)一致', () => {
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n', 'dir/b.md': 'B1\n', 'dir/sub/c.md': 'C1\n', 'del.md': 'D1\n' });
    const countBefore = g(root, ['count-objects', '-v']).match(/^count:\s*(\d+)$/m)?.[1];
    const pure = derivePlanIdentityPure(root, base, [
      { path: 'a.md', outputBytes: 'A2\n' },
      { path: 'dir/b.md' }, // 删除目标(无 outputBytes)
      { path: 'dir/sub/d.md', outputBytes: 'D\n' }, // 新增(嵌套目录)
      { path: 'del.md' }, // 删除
    ]);
    // 形态: tree 40-hex、plan digest 64-hex、写目标 blob 40-hex、删除目标 blob=null。
    expect(pure.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(pure.planDigest).toMatch(/^[0-9a-f]{64}$/);
    const byPath = new Map(pure.targetBlobs.map((t) => [t.path, t]));
    expect(byPath.get('a.md')?.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(byPath.get('dir/sub/d.md')?.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(byPath.get('dir/b.md')).toEqual({ path: 'dir/b.md', mode: null, blob: null });
    // 零副作用: count-objects 不变、无 novelcraft 工件(不调 hash-object -w、不建私有 index)。
    const countAfter = g(root, ['count-objects', '-v']).match(/^count:\s*(\d+)$/m)?.[1];
    expect(countAfter).toBe(countBefore);
    expectNoNovelcraftArtifacts(root);
    // materialize(工作树写计划输出 + commitTransaction)与纯推导一致(expect 计划门)。
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n');
    fs.rmSync(path.join(root, 'dir/b.md'));
    fs.writeFileSync(path.join(root, 'dir/sub/d.md'), 'D\n');
    fs.rmSync(path.join(root, 'del.md'));
    const res = commitTransaction(
      txnParams(root, base, [
        { path: 'a.md', outputBytes: 'A2\n' },
        { path: 'dir/b.md' },
        { path: 'dir/sub/d.md', outputBytes: 'D\n' },
        { path: 'del.md' },
      ], { txid: txidFor('pure'), expect: { tree: pure.tree, planDigest: pure.planDigest } }),
    );
    expect(res.tree).toBe(pure.tree);
    expect(res.planDigest).toBe(pure.planDigest);
    // 变更集恰为 writeSet(嵌套目录删除/新增正确)。
    expect(changedPaths(root, res.commit)).toEqual([
      ['M', 'a.md'],
      ['D', 'del.md'],
      ['D', 'dir/b.md'],
      ['A', 'dir/sub/d.md'],
    ]);
  });

  it.skipIf(!sha256Supported)('⑳+ P1-1: derivePlanIdentityPure sha256 仓库(64-hex OID)与 materialize 一致、零副作用', () => {
    const { root } = repo();
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    g(root, ['init', '-q', '-b', 'main', '--object-format=sha256']);
    fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.md'), 'A1\n');
    fs.writeFileSync(path.join(root, 'dir/b.md'), 'B1\n');
    gitAdd(root);
    const base = gitCommit(root, 'init');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const countBefore = g(root, ['count-objects', '-v']).match(/^count:\s*(\d+)$/m)?.[1];
    const pure = derivePlanIdentityPure(root, base, [
      { path: 'a.md', outputBytes: 'A2\n' },
      { path: 'dir/b.md', outputBytes: 'B2\n' },
    ]);
    expect(pure.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(pure.planDigest).toMatch(/^[0-9a-f]{64}$/); // plan digest 仍 sha256(与 object format 无关)
    expect(g(root, ['count-objects', '-v']).match(/^count:\s*(\d+)$/m)?.[1]).toBe(countBefore);
    expectNoNovelcraftArtifacts(root);
    // materialize 一致 + commitTransaction 全流程(64-hex OID)。
    fs.writeFileSync(path.join(root, 'a.md'), 'A2\n');
    fs.writeFileSync(path.join(root, 'dir/b.md'), 'B2\n');
    const res = commitTransaction(
      txnParams(root, base, [
        { path: 'a.md', outputBytes: 'A2\n' },
        { path: 'dir/b.md', outputBytes: 'B2\n' },
      ], { txid: txidFor('pure256'), expect: { tree: pure.tree, planDigest: pure.planDigest } }),
    );
    expect(res.tree).toBe(pure.tree);
    expect(res.commit).toMatch(/^[0-9a-f]{64}$/);
  });

  it('⑳ 事务私有 index 的 .lock 残留 → INDEX_LOCKED; finally 不删除并发者替换的私有 index', () => {
    // (a) 私有 index .lock 无法证明归属 → INDEX_LOCKED(零副作用)。
    //     模块私有 index 路径 = <gitdir>/novelcraft-txn-<txid>.index, 其 .lock 同名 + '.lock'。
    const { root } = repo();
    const base = initCommit(root, { 'a.md': 'A1\n' });
    const lockpTxid = txidFor('lockp');
    fs.writeFileSync(path.join(root, '.git', `novelcraft-txn-${lockpTxid}.index.lock`), '');
    const err = txError(() =>
      commitTransaction(txnParams(root, base, [{ path: 'a.md', outputBytes: 'A2\n' }], { txid: lockpTxid })),
    );
    expect(err.code).toBe('INDEX_LOCKED');
    expect(g(root, ['rev-parse', 'HEAD']).trim()).toBe(base);
    expect(fs.readdirSync(path.join(root, '.git')).filter((f) => f.includes('novelcraft-txn-'))).toEqual([
      `novelcraft-txn-${lockpTxid}.index.lock`,
    ]);

    // (b) 钩子期间并发者替换私有 index → commit 正常返回但 finally 不删除并发者文件(dev/ino 守卫)。
    const { root: r2 } = repo();
    const b2 = initCommit(r2, { 'a.md': 'A1\n' });
    fs.writeFileSync(path.join(r2, 'a.md'), 'A2\n'); // 模拟上层写面
    const concTxid = txidFor('conc');
    const privateIndex = path.join(r2, '.git', `novelcraft-txn-${concTxid}.index`);
    const res = commitTransaction(
      txnParams(r2, b2, [{ path: 'a.md', outputBytes: 'A2\n' }], {
        txid: concTxid,
        hooks: {
          beforeRefCas: () => {
            fs.rmSync(privateIndex);
            fs.writeFileSync(privateIndex, 'concurrent-index-bytes');
          },
        },
      }),
    );
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(g(r2, ['rev-parse', 'HEAD']).trim()).toBe(res.commit); // 事务照常提交
    // 并发者替换的私有 index 文件(不同 inode)未被 finally 误删。
    expect(fs.existsSync(privateIndex)).toBe(true);
    expect(fs.readFileSync(privateIndex, 'utf8')).toBe('concurrent-index-bytes');
  });
});