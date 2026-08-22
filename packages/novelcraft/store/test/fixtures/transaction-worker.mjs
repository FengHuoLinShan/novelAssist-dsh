// ============================================================================
// ADR-0021 进程测试基建 —— vault 写事务 worker(测试夹具, 非生产代码)
// ============================================================================
// 本文件是「进程级测试」的独立执行体, 由 vitest 测试以 node 子进程 spawn:
//   - 在真实 SIGKILL(不可捕获, 任何回滚代码都不可能运行)下, 按持久化 intent
//     验证崩溃点恢复(ADR-0021 §8 / 裁定 N32);
//   - 两进程抢 per-vault 跨进程锁(§3, fail-closed);
//   - 不协作编辑器在提交前复核点造成 CAS 冲突(§5/§6, 只测明确复核点,
//     不虚构 check→rename 的物理原子性——ADR 边界声明)。
//
// N32(裁定全文见 specs/adjudications.md): 「统一 VaultWriteTransaction: 调用方在
// 首写前声明完整 write set 并完成内容/路径/frontmatter/CAS preflight; 允许 write set
// 外无关 unstaged/untracked, 任何预存 staged 一律 fail-closed; 每 vault 使用跨进程锁,
// 文件以同目录临时文件 + rename 原子替换, Git 仅精确 stage/commit 声明路径且提交前
// 复核 staged 集与目标 hash; 失败时只回滚仍等于本事务输出 hash 的路径, 检测到外部
// 后续编辑则不覆盖并报告人工恢复; commit 是 canonical 事务终点, 业务写面禁用
// `git add -A`。」ADR-0021 状态: Accepted, implementation in progress。
//
// ── 生产驱动动态 import 验收 ──────────────────────────────────────────────
// worker 依序 import PRODUCTION_CANDIDATES，且只接受同时导出
// runTransactionProcess/recoverTransactionProcess 的生产模块。未命中即
// PRODUCTION_DRIVER_UNAVAILABLE；禁止回退内嵌参考实现，避免进程测试假绿。
//
// ── stdout READY 协议(逐行 JSON; 测试端事件驱动等待 + 显式超时, 不 sleep 忙等) ──
//   {"t":"ready", "mode":..., "pid":...}   启动完成, 等待 stdin {"cmd":"go"}
//   {"t":"phase", "phase":"intent-ready"|"first-rename"|"private-index"|
//                          "commit-object"|"review-point"|"ref-cas"|
//                          "shared-index-install"}                 完成该阶段副作用后到达门
//   {"t":"lock",  "state":"acquired"|"busy"|"stale-reclaimed", ...} 锁事件
//   {"t":"done",  "state":..., "commit":..., "summary":{...}}       正常收尾(退出码 0)
//   {"t":"error", "code":..., "detail":..., "intentKept":...}       失败关闭(退出码 1)
// ── stdin 命令(逐行 JSON) ──
//   {"cmd":"go"}  {"cmd":"proceed"}  {"cmd":"release"}  {"cmd":"abort"}
//
// 崩溃点语义(测试在收到对应 phase 行后立刻 SIGKILL 本进程):
//   intent-ready         intent 已耐久化, 工作树/index 仍零副作用(§4/§8)
//   first-rename         首个目标已 temp+rename 落盘, 其余目标未写(§5, partial)
//   private-index        私有 index 已建, exact tree 已冻结(§6)
//   commit-object        commit object 已生成但 ref 未动(§6, 悬空 commit)
//   review-point         提交前复核点前暂停(仅 --gate review-point 时出现; §6)
//   ref-cas              update-ref CAS 已成功, commit 已可达(§6)
//   shared-index-install 共享 index 已原子安装(§6)
// ============================================================================

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 约定常量(实现开放项留实现期, 本夹具取最小约定; ADR-0021 开放项 1/2/3/4) ──
export const LOCK_NAME = 'novelcraft-lock'; // 开放项1: .git/novelcraft-lock(pid + txid + since)
export const TXT_DIR_NAME = 'novelcraft-transactions'; // 开放项4: .git/novelcraft-transactions/<txid>/
export const INTENT_SCHEMA = 1;
export const CRASH_GATES = [
  'intent-ready',
  'first-rename',
  'private-index',
  'commit-object',
  'ref-cas',
  'shared-index-install',
];
export const REVIEW_GATE = 'review-point';

const LOCK_FILE = `.git/${LOCK_NAME}`;
const TXT_DIR = `.git/${TXT_DIR_NAME}`;

export function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 规范化 + 包含性检查: 拒绝绝对路径 / `..` / 路径穿越(ADR §8: intent/快照/输出
// 路径必须归一化并限制在当前 vault; 完整 symlink/遍历校验属生产实现, 见注释)。
export function safeRel(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('INVALID_REL');
  if (path.isAbsolute(rel)) throw new Error('INVALID_REL_ABSOLUTE');
  const norm = path.normalize(rel);
  if (norm.startsWith('../') || norm === '..' || norm.split(path.sep).includes('..')) {
    throw new Error('INVALID_REL_TRAVERSAL');
  }
  const abs = path.resolve(root, norm);
  const rootAbs = path.resolve(root) + path.sep;
  if (abs !== path.resolve(root) && !abs.startsWith(rootAbs)) throw new Error('INVALID_REL_ESCAPE');
  return norm;
}

// ── 进程内工具 ────────────────────────────────────────────────────────────────

function git(vault, args, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  return execFileSync('git', ['-C', vault, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitOk(vault, args, opts) {
  try {
    git(vault, args, opts);
    return true;
  } catch {
    return false;
  }
}

function run(vault, args, opts) {
  return git(vault, args, opts).trim();
}

function currentBranch(vault) {
  return run(vault, ['symbolic-ref', '--short', 'HEAD']);
}

// ── 协议输出 ──────────────────────────────────────────────────────────────────

function emit(o) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

function fatal(err) {
  const e = err ?? new Error('UNKNOWN');
  emit({
    t: 'error',
    code: typeof e?.code === 'string' ? e.code : 'INTERNAL',
    detail: e?.message ?? String(e),
    intentKept: e?.intentKept === true,
    preserved: e?.preserved ?? [],
  });
  process.exit(1);
}

// 注: 不在此处安装全局错误处理器(测试进程 import 本模块导出时要零副作用);
// 仅在 isMain(作为子进程被执行)时安装, 见 main()。

// ── stdin 命令(逐行 JSON; 事件驱动, 无轮询) ─────────────────────────────────

import readline from 'node:readline';

let rl = null;
let cmdQueue = [];
let cmdWaiter = null;
let stdinClosed = false;

function ensureRl() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (cmdWaiter) {
      const w = cmdWaiter;
      cmdWaiter = null;
      clearTimeout(w.timer);
      w.resolve(o);
    } else {
      cmdQueue.push(o);
    }
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (cmdWaiter) {
      const w = cmdWaiter;
      cmdWaiter = null;
      clearTimeout(w.timer);
      w.reject(new Error('STDIN_CLOSED'));
    }
  });
  return rl;
}

function nextCmd(timeoutMs = 120_000) {
  ensureRl();
  if (cmdQueue.length > 0) return Promise.resolve(cmdQueue.shift());
  if (stdinClosed) return Promise.reject(new Error('STDIN_CLOSED'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (cmdWaiter) {
        cmdWaiter = null;
        reject(new Error('STDIN_TIMEOUT'));
      }
    }, timeoutMs);
    cmdWaiter = { resolve, reject, timer };
  });
}

async function waitCmd(pred, what, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const remaining = timeoutMs - (Date.now() - t0);
    if (remaining <= 0) throw new Error(`WAIT_CMD_TIMEOUT:${what}`);
    const o = await nextCmd(remaining);
    if (pred(o)) return o;
  }
}

// ── 锁(ADR §3 跨进程 per-vault 锁; 开放项1 细节留实现期, 夹具取约定) ────────
// 锁文件 = .git/novelcraft-lock, JSON {pid, txid, since}。
// 获取: O_EXCL 原子创建; EEXIST → 读持有者 pid, 存活 → busy(fail-closed),
// pid 已死(ESRCH, 进程被 SIGKILL 等) → 原子 rename 摘除 stale 锁后重试一次。
// 释放: 仅当持有者为本进程时 unlink。

function readLock(lp) {
  try {
    return JSON.parse(fs.readFileSync(lp, 'utf8'));
  } catch {
    return null; // 不存在 / 半写 / 损坏
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // EPERM = 存在但无权信号(仍视为存活)
  }
}

function acquireLock(vault, holder) {
  const lp = path.join(vault, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeFileSync(fd, JSON.stringify(holder));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return { ok: true, stale: attempt > 0 };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const info = readLock(lp);
      // 取不到/无法解析的锁: 归属不明, fail-closed 视为 busy(§3/§6 未知锁不清理)。
      if (!info || !pidAlive(info.pid)) {
        if (!info) return { ok: false, reason: 'busy', detail: 'lock unreadable' };
        // pid 已死 → 原子摘除 stale 锁(rename 同一文件系统内原子), 下一轮重试。
        const ghost = `${lp}.stale.${crypto.randomBytes(6).toString('hex')}`;
        try {
          fs.renameSync(lp, ghost);
        } catch (e2) {
          if (e2?.code !== 'ENOENT') throw e2; // 别人已摘除 → 重试
        }
      } else {
        return { ok: false, reason: 'busy', detail: `holder pid ${info.pid} alive` };
      }
    }
  }
  return { ok: false, reason: 'busy', detail: 'lock race' };
}

function releaseLock(vault, holder) {
  const lp = path.join(vault, LOCK_FILE);
  const info = readLock(lp);
  if (info && info.pid === holder.pid && info.txid === holder.txid) {
    try {
      fs.unlinkSync(lp);
    } catch {
      /* ENOENT 可接受 */
    }
  }
}

// 恢复入口用之: 仅当锁持有者已死(本进程被 SIGKILL 的情况)才清理 stale 锁。
function releaseStaleLock(vault) {
  const lp = path.join(vault, LOCK_FILE);
  const info = readLock(lp);
  if (info && !pidAlive(info.pid)) {
    try {
      fs.unlinkSync(lp);
    } catch {
      /* noop */
    }
  } else if (info && pidAlive(info.pid)) {
    throw Object.assign(new Error('LOCK_BUSY: recovery 与存活事务竞争'), { code: 'LOCK_BUSY' });
  }
}

// ── intent 持久化(ADR §8: 首个工作树/index 变更前耐久化; 原子写 + fsync + 就绪标记) ──

function intentDirAbs(vault, txid) {
  return path.join(vault, TXT_DIR, txid);
}

function persistIntent(vault, intent) {
  const dir = intentDirAbs(vault, intent.txid);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `intent.json.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  fs.writeFileSync(fd, `${JSON.stringify(intent, null, 2)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, path.join(dir, 'intent.json'));
  const rfd = fs.openSync(path.join(dir, 'ready'), 'w');
  fs.fsyncSync(rfd);
  fs.closeSync(rfd);
  try {
    const dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {
    /* 目录 fsync 平台差异, 尽力而为 */
  }
}

function listReadyIntents(vault) {
  const base = path.join(vault, TXT_DIR);
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names.filter((n) => {
    try {
      return fs.existsSync(path.join(base, n, 'ready')) && fs.existsSync(path.join(base, n, 'intent.json'));
    } catch {
      return false;
    }
  });
}

function loadIntent(vault, txid) {
  const p = path.join(intentDirAbs(vault, txid), 'intent.json');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  validateIntent(vault, parsed);
  return parsed;
}

function validateIntent(vault, intent) {
  if (intent?.schema !== INTENT_SCHEMA) throw Object.assign(new Error('intent schema 失配'), { code: 'INVALID_INTENT' });
  if (!/^tx-[A-Za-z0-9-]{8,64}$/.test(intent?.txid ?? '')) {
    throw Object.assign(new Error('intent txid 非法'), { code: 'INVALID_INTENT' });
  }
  if (!['canonical', 'state'].includes(intent?.kind)) {
    throw Object.assign(new Error('intent kind 未注册'), { code: 'INVALID_INTENT' });
  }
  if (typeof intent?.branch !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(intent.branch)) {
    throw Object.assign(new Error('intent branch 非法'), { code: 'INVALID_INTENT' });
  }
  if (!Array.isArray(intent?.targets) || intent.targets.length === 0) {
    throw Object.assign(new Error('intent writeSet 缺失'), { code: 'INVALID_INTENT' });
  }
  for (const t of intent.targets) {
    try {
      safeRel(vault, t.rel);
    } catch (e) {
      throw Object.assign(e, { code: 'INVALID_INTENT' });
    }
    if (typeof t.expected?.sha256 !== 'string' || typeof t.outputB64 !== 'string' || typeof t.snapshot?.sha256 !== 'string') {
      throw Object.assign(new Error(`intent target 字段缺失: ${t.rel}`), { code: 'INVALID_INTENT' });
    }
  }
}

function cleanupIntent(vault, txid) {
  try {
    fs.rmSync(intentDirAbs(vault, txid), { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

// ── 工作树 / index 工具 ───────────────────────────────────────────────────────

function absOf(vault, rel) {
  return path.join(vault, safeRel(vault, rel));
}

function readCurrent(vault, rel) {
  const abs = absOf(vault, rel);
  if (!fs.existsSync(abs)) return { absent: true };
  const bytes = fs.readFileSync(abs);
  return { absent: false, sha256: sha256hex(bytes), bytes };
}

// §5: 同目录 temp + rename 单次原子替换(写前复核在调用方做)。
function writeViaTempRename(vault, rel, bytes) {
  const abs = absOf(vault, rel);
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.nvc-tx.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  fs.writeFileSync(fd, bytes);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, abs);
}

// §6: 私有 index(GIT_INDEX_FILE)从 base HEAD 初始化, 只精确 stage writeSet,
//     严禁 `git add -A`; exact tree 冻结后返回 tree sha。
function buildPrivateIndex(vault, base, rels, txid) {
  const idxPath = path.join(intentDirAbs(vault, txid), 'index');
  const env = { GIT_INDEX_FILE: idxPath };
  git(vault, ['read-tree', base], { env }); // 从 base HEAD 初始化私有 index
  git(vault, ['add', '--', ...rels], { env }); // 只精确 stage 声明路径(业务写面禁用 add -A)
  const staged = git(vault, ['diff', '--cached', '--name-only'], { env })
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  const want = new Set(rels.map((r) => safeRel(vault, r)));
  if (
    staged.length !== want.size ||
    staged.some((s) => !want.has(s)) ||
    [...want].some((w) => !staged.includes(w))
  ) {
    throw Object.assign(new Error(`私有 index 变化集 != writeSet: ${JSON.stringify(staged)}`), {
      code: 'CAS_CONFLICT',
    });
  }
  return run(vault, ['write-tree'], { env });
}

function commitTree(vault, tree, base, message) {
  return run(vault, [
    '-c',
    'user.name=novelcraft',
    '-c',
    'user.email=novelcraft@example.invalid',
    'commit-tree',
    tree,
    '-p',
    base,
    '-m',
    message,
  ]);
}

// §6: 提交前复核点(紧邻 update-ref CAS 之前): 全 writeSet 重 hash 均等于计划 output,
//     ref 仍为 base, 私有 exact tree 未变; 任一不符 → 不 update-ref, CAS_CONFLICT。
function reviewPreCommit(vault, intent) {
  for (const t of intent.targets) {
    const cur = readCurrent(vault, t.rel);
    if (cur.absent || cur.sha256 !== sha256hex(Buffer.from(t.outputB64, 'base64'))) {
      throw Object.assign(new Error(`提交前复核点目标 hash 不符: ${t.rel}`), { code: 'CAS_CONFLICT' });
    }
  }
  const head = run(vault, ['rev-parse', 'HEAD']);
  if (head !== intent.base) {
    throw Object.assign(new Error(`提交前复核点 ref 前移: ${head}`), { code: 'CAS_CONFLICT' });
  }
  const idxPath = path.join(intentDirAbs(vault, intent.txid), 'index');
  const treeNow = run(vault, ['write-tree'], { env: { GIT_INDEX_FILE: idxPath } });
  if (treeNow !== intent.planTree) {
    throw Object.assign(new Error(`私有 exact tree 变化: ${treeNow}`), { code: 'CAS_CONFLICT' });
  }
}

// §6: update-ref CAS 推进分支; 外部先推进(ref 提前 ≠ base)时失败, 不 force。
function casRef(vault, branch, commit, base) {
  try {
    git(vault, ['update-ref', `refs/heads/${branch}`, commit, base]);
  } catch (err) {
    throw Object.assign(new Error(`update-ref CAS 失败: ${err?.message}`), { code: 'REF_CAS_CONFLICT' });
  }
}

// §6: 共享 index 只在可验证归属的 index lock 临界区内原子安装(与 HEAD 一致的终态
//     index); 未知 index.lock 一律 fail-closed。
function installSharedIndex(vault, commit, txid) {
  const finalIdx = path.join(vault, '.git', `novelcraft-final-index.${txid}`);
  const env = { GIT_INDEX_FILE: finalIdx };
  git(vault, ['read-tree', '--empty'], { env });
  git(vault, ['read-tree', `${commit}^{tree}`], { env });
  const lockAbs = path.join(vault, '.git', 'index.lock');
  let fd;
  try {
    fd = fs.openSync(lockAbs, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw Object.assign(new Error('共享 index.lock 归属不明, fail-closed'), { code: 'INDEX_LOCKED' });
    }
    throw err;
  }
  fs.writeFileSync(fd, `pid ${process.pid}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const tmpIdx = path.join(vault, '.git', `novelcraft-index.${txid}.tmp`);
  fs.copyFileSync(finalIdx, tmpIdx);
  fs.renameSync(tmpIdx, path.join(vault, '.git', 'index')); // 同目录原子替换
  try {
    fs.unlinkSync(lockAbs);
  } catch {
    /* noop */
  }
}

// ── 恢复验证: 在当前可达历史中定位带 txid 的唯一 commit(ADR §6/⑧) ───────────
// 后续无关 commit 或作者继续编辑不造成假阴性; 外部恰好相同字节/同消息不造成假阳性
// (要求 parent == intent.base 且 tree == intent.planTree 全匹配)。

function findVerifiedCommit(vault, intent) {
  const out = git(vault, ['log', `--format=%H%x00%s`, intent.branch]).split('\0');
  const shas = [];
  const subjects = [];
  for (let i = 0; i < out.length; i += 2) {
    shas.push(out[i]);
    subjects.push(out[i + 1] ?? '');
  }
  const needle = `vtx:${intent.txid}`;
  const candidates = shas.filter((sha, i) => subjects[i].includes(needle));
  if (candidates.length !== 1) return null; // 0 或 >1 均视为未找到/不唯一 → fail-closed
  const sha = candidates[0];
  const parent = run(vault, ['rev-parse', `${sha}^`]);
  const tree = run(vault, ['rev-parse', `${sha}^{tree}`]);
  if (parent !== intent.base || tree !== intent.planTree) return null;
  return sha;
}

// ── 条件回滚(ADR §7/§8) ──────────────────────────────────────────────────────
// BEFORE = 等于事务前快照/原本不存在; OUTPUT = 等于计划输出; CONFLICT = 两者都不等。
// canonical 无成功 commit 时: 只把 OUTPUT 条件恢复为 BEFORE
// (新建文件安全删除 / 快照字节写回); BEFORE 保持不动; CONFLICT 保留现场并 fail-closed,
// 不 unstage、不删除、不覆盖。返回 { restored: string[], preserved: string[] }。
function rollbackToBefore(vault, intent) {
  const restored = [];
  const preserved = [];
  for (const t of intent.targets) {
    const abs = absOf(vault, t.rel);
    const cur = readCurrent(vault, t.rel);
    const outputSha = sha256hex(Buffer.from(t.outputB64, 'base64'));
    const cls = cur.absent
      ? t.snapshot.absent === true
        ? 'BEFORE'
        : 'CONFLICT'
      : cur.sha256 === t.snapshot.sha256
        ? 'BEFORE'
        : cur.sha256 === outputSha
          ? 'OUTPUT'
          : 'CONFLICT';
    if (cls === 'OUTPUT') {
      if (t.snapshot.absent === true || t.snapshot.bytesB64 === undefined) {
        try {
          fs.unlinkSync(abs);
        } catch {
          /* noop */
        }
      } else {
        writeViaTempRename(vault, t.rel, Buffer.from(t.snapshot.bytesB64, 'base64'));
      }
      restored.push(t.rel);
    } else if (cls === 'CONFLICT') {
      preserved.push(t.rel);
    }
  }
  return { restored, preserved };
}

// ── 参考协议驱动(REFERENCE_DRIVER, 测试夹具内嵌的最小诚实实现) ──────────────
// plan 形状(计划文件 JSON):
//   { txid?, kind: 'canonical'|'state', branch?, base, targets: [
//       { rel, expected: { absent, sha256 }, output: '<字节>' } ] }
// expected = 生成计划完成时定型的期望状态(内容 CAS 唯一基线; ADR §1/§4, N32)。

class ReferenceDriver {
  constructor(vault, plan, opts) {
    this.vault = vault;
    this.plan = plan;
    this.opts = opts ?? {};
    this.intent = null;
    this.holder = null;
  }

  async gates() {
    const g = [...CRASH_GATES];
    if (this.opts.gate === REVIEW_GATE) {
      const i = g.indexOf('ref-cas');
      g.splice(i, 0, REVIEW_GATE);
    }
    return g;
  }

  async gate(name) {
    emit({ t: 'phase', phase: name });
    const o = await waitCmd((c) => c?.cmd === 'proceed' || c?.cmd === 'abort', name);
    if (o.cmd === 'abort') {
      throw Object.assign(new Error('ABORTED'), { code: 'ABORTED' });
    }
  }

  async preflight() {
    // §2: 任何预存 staged(整个 index, 不限 writeSet 内)→ STAGED_CONFLICT, 不自动
    // 清除、不并入(N32)。零写入返回。
    if (!gitOk(this.vault, ['diff', '--cached', '--quiet'])) {
      throw Object.assign(new Error('index 存在预存 staged, fail-closed (N32/§2)'), {
        code: 'STAGED_CONFLICT',
      });
    }
    // §4 陈旧基线检查: 逐目标比较当前状态与 expected state; 事务绝不把启动时读到的
    // 任意新内容当基线(F 未采用)。
    for (const t of this.plan.targets) {
      const cur = readCurrent(this.vault, t.rel);
      const wantAbsent = t.expected.absent === true;
      if (cur.absent !== wantAbsent || (!cur.absent && cur.sha256 !== t.expected.sha256)) {
        throw Object.assign(new Error(`陈旧基线: ${t.rel}`), { code: 'STALE_BASELINE' });
      }
    }
    // §4: preflight 记录事务启动时字节快照(仅用于 §7 回滚, 不是 CAS 基线)。
    const targets = [];
    for (const t of this.plan.targets) {
      const cur = readCurrent(this.vault, t.rel);
      targets.push({
        rel: safeRel(this.vault, t.rel),
        expected: { absent: t.expected.absent === true, sha256: t.expected.sha256 },
        outputB64: Buffer.from(t.output, 'utf8').toString('base64'),
        snapshot: cur.absent
          ? { absent: true, sha256: '' }
          : { absent: false, sha256: cur.sha256, bytesB64: cur.bytes.toString('base64') },
      });
    }
    return targets;
  }

  async applyOutputs() {
    for (let i = 0; i < this.intent.targets.length; i += 1) {
      const t = this.intent.targets[i];
      // §5: 每个目标写前再复核当前状态仍等于生成计划时的 expected state。
      const cur = readCurrent(this.vault, t.rel);
      if (cur.absent !== t.expected.absent || (!cur.absent && cur.sha256 !== t.expected.sha256)) {
        throw Object.assign(new Error(`写前复核 CAS 失败: ${t.rel}`), { code: 'CAS_CONFLICT' });
      }
      writeViaTempRename(this.vault, t.rel, Buffer.from(t.outputB64, 'base64'));
      if (i === 0) {
        this.intent.phase = 'first-rename';
        persistIntent(this.vault, this.intent);
        await this.gate('first-rename'); // 崩溃点2: 首目标已落盘, 其余 BEFORE
      }
    }
    this.intent.phase = 'write-complete';
    persistIntent(this.vault, this.intent);
    emit({ t: 'phase', phase: 'write-complete' });
  }

  async makeCommit() {
    // §6: 私有 index + exact tree(只含实际变化集)。
    const rels = this.intent.targets.map((t) => t.rel);
    const tree = buildPrivateIndex(this.vault, this.intent.base, rels, this.intent.txid);
    this.intent.planTree = tree;
    this.intent.phase = 'private-index';
    persistIntent(this.vault, this.intent);
    await this.gate('private-index'); // 崩溃点3

    // §6: commit-tree 生成 commit object(悬空, 尚未可达)。
    const msg = `vault-tx vtx:${this.intent.txid} plan:${tree}`;
    const commit = commitTree(this.vault, tree, this.intent.base, msg);
    this.intent.commit = commit;
    this.intent.phase = 'commit-object';
    persistIntent(this.vault, this.intent);
    await this.gate('commit-object'); // 崩溃点4

    if (this.opts.gate === REVIEW_GATE) {
      await this.gate(REVIEW_GATE); // 崩溃点(测试专用): 不协作编辑器在此插入
    }

    reviewPreCommit(this.vault, this.intent); // 提交前复核点(§6/⑪)

    casRef(this.vault, this.intent.branch, commit, this.intent.base); // §6 update-ref CAS
    this.intent.phase = 'ref-cas';
    persistIntent(this.vault, this.intent);
    await this.gate('ref-cas'); // 崩溃点5: commit 已可达

    installSharedIndex(this.vault, commit, this.intent.txid);
    this.intent.phase = 'shared-index-install';
    persistIntent(this.vault, this.intent);
    await this.gate('shared-index-install'); // 崩溃点6

    return commit;
  }

  async run() {
    // 事务入口: 若存在未完成 intent → 先恢复收敛, 收敛完成前不开始新事务(§8)。
    const leftovers = listReadyIntents(this.vault);
    if (leftovers.length > 0) {
      throw Object.assign(
        new Error(`存在未收敛 intent: ${leftovers.join(',')}; 先经 recover 收敛`),
        { code: 'PENDING_INTENTS' },
      );
    }
    // 锁留在事务入口最先失败关闭的点: 收不到锁 → LOCK_BUSY, 零副作用(§3)。
    const holder = { pid: process.pid, txid: this.plan.txid ?? `tx-${crypto.randomBytes(8).toString('hex')}`, since: Date.now() };
    const lock = acquireLock(this.vault, holder);
    if (!lock.ok) {
      throw Object.assign(new Error(`跨进程锁获取失败: ${lock.detail}`), { code: 'LOCK_BUSY' });
    }
    this.holder = holder;
    const txid = holder.txid;
    try {
      const targets = await this.preflight();
      // §4/§8: 首写前耐久化 intent(原子写 + fsync + ready 就绪标记)。
      this.intent = {
        schema: INTENT_SCHEMA,
        txid,
        kind: this.plan.kind,
        branch: this.plan.branch,
        base: this.plan.base,
        phase: 'intent-ready',
        planTree: null,
        commit: null,
        targets,
        createdAt: Date.now(),
      };
      persistIntent(this.vault, this.intent); // 崩溃点1: intent 已耐久, 无任何工作树/index 副作用
      await this.gate('intent-ready');

      await this.applyOutputs(); // 崩溃点2 在此过程中

      const commit = await this.makeCommit(); // 崩溃点3/4/5/6 在此过程中

      // 收尾: 清理 intent(成功 commit 后), 释放锁。
      cleanupIntent(this.vault, txid);
      releaseLock(this.vault, holder);
      emit({
        t: 'done',
        state: 'committed',
        commit,
        summary: { txid, kind: this.intent.kind, branch: this.intent.branch, base: this.intent.base, planTree: this.intent.planTree },
      });
      return;
    } catch (err) {
      this.handleError(err, txid);
    }
  }

  handleError(err, txid) {
    // 进程内异常与崩溃同矩阵(§7/§8); 差别仅在崩溃时由 recover 进程执行同一逻辑。
    const preserved = [];
    const restored = [];
    if (this.intent && err.code !== 'PENDING_INTENTS' && err.code !== 'LOCK_BUSY') {
      if (['STAGED_CONFLICT', 'STALE_BASELINE'].includes(err.code)) {
        // intent 建立前失败 = 零工作树/index/ref 副作用; 不留下任何东西。
      } else {
        const res = rollbackToBefore(this.vault, this.intent);
        restored.push(...res.restored);
        preserved.push(...res.preserved);
        // 成功 commit 后不当回滚(§6: commit/ref 成功是 canonical 终点)。
        if (this.intent.commit && this.intent.phase === 'ref-cas') {
          preserved.push(...this.intent.targets.map((t) => t.rel));
        }
      }
    }
    const intentKept = preserved.length > 0; // fail-closed 保留 intent 现场供人工恢复
    if (err.code === 'REF_CAS_CONFLICT') {
      preserved.push(...this.intent?.targets.map((t) => t.rel) ?? []);
    }
    if (this.holder) releaseLock(this.vault, this.holder);
    emit({
      t: 'error',
      code: err.code ?? 'INTERNAL',
      detail: err.message,
      intentKept,
      preserved,
      restored,
    });
    process.exit(1);
  }
}

// ── 恢复入口(recover 进程: 全新进程, 无任何内存回滚可依赖) ───────────────────

async function recoverTransactions(vault) {
  // §8: 崩溃于 intent 写入之中 = 无就绪标记的半写残留, 恢复时忽略并清理(视为未开始)。
  const txBase = path.join(vault, TXT_DIR);
  let names = [];
  try {
    names = fs.readdirSync(txBase);
  } catch {
    /* 无事务目录 */
  }
  for (const n of names) {
    const dir = path.join(txBase, n);
    const hasReady = fs.existsSync(path.join(dir, 'ready'));
    const hasIntent = fs.existsSync(path.join(dir, 'intent.json'));
    if (!hasReady || !hasIntent) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  }
  const leftovers = listReadyIntents(vault);
  if (leftovers.length === 0) {
    emit({ t: 'done', state: 'no-intent', commit: null, summary: { v: 'none' } });
    return;
  }
  if (leftovers.length > 1) {
    throw Object.assign(new Error(`多 intent 并存, 需人工: ${leftovers.join(',')}`), { code: 'INVALID_INTENT' });
  }
  const txid = leftovers[0];
  const intent = loadIntent(vault, txid); // identity/schema/路径能力验证, fail-closed
  releaseStaleLock(vault); // 持有者已死(SIGKILL)才允许收敛; 存活持有者 → LOCK_BUSY

  const commit = findVerifiedCommit(vault, intent);
  if (commit) {
    // 「commit 已成功」收尾(§8): 不回滚、不重做; 仅受控同步共享 index + 清理 intent。
    installSharedIndex(vault, commit, txid);
    cleanupIntent(vault, txid);
    emit({
      t: 'done',
      state: 'completed',
      commit,
      summary: { txid, kind: intent.kind, branch: intent.branch, base: intent.base, planTree: intent.planTree },
    });
    return;
  }

  // 可达历史中无已验证 tx commit:
  const head = run(vault, ['rev-parse', 'HEAD']);
  if (head !== intent.base) {
    // HEAD 前进且不存在该 commit = 外部 ref 竞争; 停止并保留现场, 绝不 force(§8)。
    throw Object.assign(new Error('HEAD 前移且无验证 tx commit, 外部 ref 竞争; 保留现场'), {
      code: 'EXTERNAL_REF_RACE',
    });
  }

  if (intent.kind === 'state') {
    // checkpoint/state(§8): 命中机器状态补完同一事务, 不主动回滚。
    await completeForward(vault, intent, txid, commit);
    return;
  }

  // canonical adopt(§8): 无成功 commit → 条件回滚 + 交还上层重新审批。
  const res = rollbackToBefore(vault, intent);
  if (res.preserved.length > 0) {
    // CONFLICT → 保留现场 fail-closed, intent 不清理, 供人工恢复。
    emit({
      t: 'done',
      state: 'conflict-preserved',
      commit: null,
      summary: { txid, preserved: res.preserved, restored: res.restored },
    });
    return;
  }
  cleanupIntent(vault, txid);
  releaseStaleLock(vault);
  emit({
    t: 'done',
    state: 'rolled-back',
    commit: null,
    summary: { txid, restored: res.restored },
  });
}

// state 补完: 从 intent 继续(输出字节已定型于 intent, 不再可变; §8)。
async function completeForward(vault, intent, txid, _commit) {
  const outputShaOf = (t) => sha256hex(Buffer.from(t.outputB64, 'base64'));
  for (const t of intent.targets) {
    const cur = readCurrent(vault, t.rel);
    if (cur.absent || cur.sha256 !== outputShaOf(t)) {
      if (!cur.absent && cur.sha256 !== t.snapshot.sha256) {
        // 非 BEFORE/OUTPUT → 外部变化, fail-closed 保留。
        throw Object.assign(new Error(`state 补完遇 CONFLICT: ${t.rel}`), { code: 'CAS_CONFLICT' });
      }
      writeViaTempRename(vault, t.rel, Buffer.from(t.outputB64, 'base64'));
    }
  }
  const rels = intent.targets.map((t) => t.rel);
  const tree = buildPrivateIndex(vault, intent.base, rels, txid);
  // plan digest 重推导: intent 中输出字节已定型(intent 建立后不再可变), 因此
  // 崩溃于 private-index 之前(planTree 尚未记录)时, 从 intent 内容确定性重建
  // exact tree 即为 plan digest; 已记录则必须全匹配(fail-closed, §8 验证)。
  if (intent.planTree === null) {
    intent.planTree = tree;
  } else if (tree !== intent.planTree) {
    throw Object.assign(new Error(`私有 exact tree 与 plan digest 不符: ${tree}`), { code: 'CAS_CONFLICT' });
  }
  let commit = intent.commit;
  if (!commit) {
    const msg = `vault-tx vtx:${intent.txid} plan:${tree}`;
    commit = commitTree(vault, tree, intent.base, msg);
  }
  reviewPreCommit(vault, intent);
  casRef(vault, intent.branch, commit, intent.base);
  installSharedIndex(vault, commit, txid);
  cleanupIntent(vault, txid);
  releaseStaleLock(vault);
  emit({
    t: 'done',
    state: 'completed',
    commit,
    summary: { txid, kind: intent.kind, branch: intent.branch, base: intent.base, planTree: tree },
  });
}

// ── 生产模块动态 import 钩子(约定形状; 见文件头) ─────────────────────────────

const thisDir = path.dirname(fileURLToPath(import.meta.url));
// 生产实现位于 src/transaction/execute.ts，并由 src/index.ts barrel 暴露公共事务
// seam。测试环境优先验证包入口，源码候选用于未构建 dist 的工作树测试；全部候选
// 未命中时必须失败，不允许参考实现兜底。
const PRODUCTION_CANDIDATES = [
  '@novelcraft/store',
  '@novelcraft/store/dist/transaction/index.js',
  pathToFileURL(path.join(thisDir, '..', '..', 'src', 'transaction', 'index.ts')).href,
  pathToFileURL(path.join(thisDir, '..', '..', 'src', 'transaction', 'execute.ts')).href,
];

async function resolveTransactionModule() {
  for (const spec of PRODUCTION_CANDIDATES) {
    let mod;
    try {
      mod = await import(spec);
    } catch {
      continue; // 尚未落地: 尝试下一候选
    }
    if (mod && typeof mod.runTransactionProcess === 'function' && typeof mod.recoverTransactionProcess === 'function') {
      return { provider: spec, mod };
    }
  }
  throw Object.assign(new Error('生产 transaction process driver 不可用；测试禁止回退参考实现'), {
    code: 'PRODUCTION_DRIVER_UNAVAILABLE',
  });
}

// ── env 攻击注入(N32 复审 P1-2 生产子进程用例) ──────────────────────────────
// 夹具侧检查(plan/base 校验等)在注入前以干净 env 完成; 进入生产驱动前注入
// GIT_DIR/GIT_OBJECT_DIRECTORY/GIT_INDEX_FILE/GIT_NAMESPACE/GIT_CONFIG_* 重定向,
// 验证生产 execute/recover 的最小 allowlist env 清理 + 钉固 --git-dir/--work-tree
// 使攻击不生效(真实仓库照常推进、decoy 零副作用)。

function injectEnvAttack(attack) {
  if (attack.gitDir !== undefined) process.env.GIT_DIR = attack.gitDir;
  if (attack.objDir !== undefined) process.env.GIT_OBJECT_DIRECTORY = attack.objDir;
  if (attack.indexFile !== undefined) process.env.GIT_INDEX_FILE = attack.indexFile;
  if (attack.namespace !== undefined) process.env.GIT_NAMESPACE = attack.namespace;
  if (attack.configCount !== undefined && attack.configKeys !== undefined && attack.configValues !== undefined) {
    process.env.GIT_CONFIG_COUNT = String(attack.configCount);
    for (let i = 0; i < attack.configCount; i += 1) {
      process.env[`GIT_CONFIG_KEY_${i}`] = String(attack.configKeys[i]);
      process.env[`GIT_CONFIG_VALUE_${i}`] = String(attack.configValues[i]);
    }
  }
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      opts[key] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return opts;
}

async function runTxMode(vault, planFile, opts) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.txid ??= `tx-${crypto.randomBytes(8).toString('hex')}`;
  plan.branch ??= currentBranch(vault);
  const head = run(vault, ['rev-parse', 'HEAD']);
  if (head !== plan.base) {
    throw Object.assign(new Error(`base 失配: plan=${plan.base} head=${head}`), { code: 'BASE_MISMATCH' });
  }
  await waitCmd((c) => c?.cmd === 'go', 'go');
  // env 攻击注入在夹具侧检查之后、生产驱动之前(见 injectEnvAttack)。
  if (opts.envAttack) injectEnvAttack(JSON.parse(opts.envAttack));
  const { mod } = await resolveTransactionModule();
  await mod.runTransactionProcess(vault, plan, opts);
}

async function runRecoverMode(vault, opts) {
  const headOk = gitOk(vault, ['rev-parse', '--is-inside-work-tree']);
  if (!headOk) throw Object.assign(new Error('vault 非 git 仓库'), { code: 'NOT_A_GIT_REPO' });
  await waitCmd((c) => c?.cmd === 'go', 'go');
  if (opts?.envAttack) injectEnvAttack(JSON.parse(opts.envAttack));
  const { mod } = await resolveTransactionModule();
  await mod.recoverTransactionProcess(vault);
}

// 锁协议统一(集成要求: 仅一把生产 lock.ts per-vault 锁): lock-hold/lock-attempt 经
// 生产模块(候选序列同 tx/recover)取 acquireVaultWriteLock。stale 判定: 获取前锁目录
// 已存在且获取成功 = 原子回收(stale-reclaimed); 获取失败(CONFLICT)= busy(fail-closed)。
// 陈旧锁的 pid 存活判定交给 lock.ts(持有者被 SIGKILL → pid 死亡 + staleMs=1 即时回收)。

async function runLockHoldMode(vault, txid) {
  const { mod } = await resolveTransactionModule();
  const acquire = mod && typeof mod.acquireVaultWriteLock === 'function' ? mod.acquireVaultWriteLock : null;
  if (!acquire) {
    throw Object.assign(new Error('生产 per-vault 锁(lock.ts)不可用'), { code: 'PRODUCTION_LOCK_UNAVAILABLE' });
  }
  try {
    const lock = await acquire(vault, { waitMs: 0 });
    emit({ t: 'lock', state: 'acquired', pid: process.pid, txid: txid ?? lock.nonce });
    await waitCmd((c) => c?.cmd === 'release', 'release');
    lock.release();
    emit({ t: 'released', pid: process.pid });
    process.exit(0);
  } catch (err) {
    emit({ t: 'lock', state: 'busy', pid: process.pid, detail: err?.message ?? String(err) });
    process.exit(1);
  }
}

async function runLockAttemptMode(vault, txid) {
  const { mod } = await resolveTransactionModule();
  const acquire = mod && typeof mod.acquireVaultWriteLock === 'function' ? mod.acquireVaultWriteLock : null;
  if (!acquire) {
    throw Object.assign(new Error('生产 per-vault 锁(lock.ts)不可用'), { code: 'PRODUCTION_LOCK_UNAVAILABLE' });
  }
  await waitCmd((c) => c?.cmd === 'go', 'go');
  const lockDir = path.join(vault, '.git', 'novelcraft', 'locks', 'vault-write');
  const existed = fs.existsSync(lockDir);
  try {
    const lock = await acquire(vault, { waitMs: 0, staleMs: 1 });
    emit({ t: 'lock', state: existed ? 'stale-reclaimed' : 'acquired', pid: process.pid, txid: txid ?? lock.nonce });
    await waitCmd((c) => c?.cmd === 'release', 'release');
    lock.release();
    emit({ t: 'released', pid: process.pid });
    process.exit(0);
  } catch (err) {
    emit({ t: 'lock', state: 'busy', pid: process.pid, detail: err?.message ?? String(err) });
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const mode = opts.mode ?? 'tx';
  const vault = path.resolve(opts.vault ?? '.');
  if (mode === 'tx' || mode === 'recover') {
    if (!gitOk(vault, ['rev-parse', '--is-inside-work-tree'])) {
      throw Object.assign(new Error('vault 非 git 仓库'), { code: 'NOT_A_GIT_REPO' });
    }
  }
  emit({ t: 'ready', mode, pid: process.pid });
  try {
    if (mode === 'tx') {
      if (!opts.plan) throw Object.assign(new Error('缺少 --plan'), { code: 'BAD_ARGS' });
      await runTxMode(vault, opts.plan, { gate: opts.gate, envAttack: opts.envAttack });
    } else if (mode === 'recover') {
      await runRecoverMode(vault, { envAttack: opts.envAttack });
    } else if (mode === 'lock-hold') {
      await runLockHoldMode(vault, opts.txid);
    } else if (mode === 'lock-attempt') {
      await runLockAttemptMode(vault, opts.txid);
    } else {
      throw Object.assign(new Error(`未知 mode: ${mode}`), { code: 'BAD_ARGS' });
    }
    process.exit(0);
  } catch (err) {
    fatal(err);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 子进程执行时安装全局错误处理器(测试进程 import 本模块时不安装, 零副作用)。
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  main().catch(fatal);
}