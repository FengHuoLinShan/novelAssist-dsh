import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoreError } from '../errors.js';
import { resolveWithin, assertNoInternalSymlink } from '../paths.js';

/**
 * 每 vault 跨进程写锁(N32 / ADR-0021 §3)。
 *
 * 锁目录: `<vault>/.git/novelcraft/locks/vault-write` —— 位于 `.git` 内部控制区,
 * 天然不进 index/commit(铁律 2: 不构成第二真相源, ADR-0021 §8)。获取 = 对该目录做
 * **原子 mkdir**(non-recursive; 失败 `EEXIST` = 已被占用), 获胜者随即在目录内以
 * 同目录 temp + fsync + rename 原子写入版本化六字段 metadata:
 * `version/pid/hostname/nonce/acquiredAt/heartbeatAt`(ADR-0021 §8 版本化 schema
 * + 字段白名单; 锁目录/心跳间隔/超时属 ADR-0021 实施期开放项 1)。
 *
 * fail-closed(N32 / ADR-0021 §3「获取失败 → 拒绝或按策略重试, 不无锁继续」):
 * - 默认 `waitMs=0` 立即拒绝(不等待); 可配 `0..5000ms` 轮询等待, 越界抛
 *   VALIDATION_FAILED(不静默截断)。
 * - 仅当 metadata 可验证且 `now - heartbeatAt >= staleMs`(默认 30s)且 hostname
 *   等于本机且 pid 确认死亡(`kill(pid, 0)` → ESRCH)才回收: 未知/损坏/远端 host/
 *   存活进程(含 pid 复用)一律**不回收**, 等到预算耗尽报 `CONFLICT`。
 * - 释放必须经 owner nonce(+pid/hostname)校验; 不匹配/不可验证一律不删除。
 * - 锁路径任何组件是 symlink、`.git` 缺失或不是真实目录 → 零触碰拒绝
 *   (PATH_TRAVERSAL / NOT_A_GIT_REPO)。
 *
 * 回收协议(**文件级 claim: read→verify→rename(lock.json)→rmdir→mkdir→write**,
 * 解决独立审查发现的「stale 判断与 rename 双回收竞态」与「目录级 claim 打断
 * 在写者」两个问题): 两个回收者基于同一旧快照竞争时, 第二回收者不得移动/删除
 * 第一回收者的新活锁, 且在写者(刚 mkdir 的新持锁者)不得被回收者打断。因此回收
 * 不是「rename 整个目录后直接删」, 而是:
 *   1. 只把 `lock.json` 原子 rename 进私有 trash(claim); **锁目录原地不动** ——
 *      目录级 claim 会把他人刚 mkdir 的新活目录整体移走, 打断其元数据写入
 *      (open ENOENT/EINVAL, 双回收者可双双失败); 文件级 claim 下目录永不移动,
 *      在写者永不被打断;
 *   2. **claim 后验证**: trash 内 lock.json 必须仍匹配观测快照的
 *      nonce/pid/hostname/heartbeatAt —— 移开的确实是我们判定 stale 的那把锁;
 *   3. 移动的是不同 owner/无法验证 → 立即把 trash 原样 rename 还原(绝不 rm;
 *      目标路径此刻必为空, 还原无 clobber 窗口), 还原失败 → 抛 CONFLICT 且
 *      保留现场(不删任何人的锁);
 *   4. **清场**: rmdir 锁目录。ENOTEMPTY = 目录内有在写者的临时文件/崩溃残留
 *      → 不打断, 丢弃 verified-stale 副本(属主已确认死亡, 是垃圾), 返回 busy;
 *      其余 rmdir 失败 → 还原 trash 后返回;
 *   5. 新 lockDir mkdir 失败(他人抢先 mkdir 成功, 其目录已就位) → 同样丢弃
 *      verified-stale 副本, 返回 busy;
 *   6. 全部通过才写入新 metadata, 最后删除自己的 verified-stale trash。
 * 因 rename 是原子的且 trash 身份可验证, 「最多一个 acquire 成功」恒成立; 任何
 * 回收者都无法基于旧快照删除他人新活锁, 也无法打断在写者(见 tryReclaimLock
 * 内联注释)。
 *
 * 错误纪律(独立审查「medium」): heartbeat/release/acquire 内的全部 FS 错误统一
 * 转换为带合适 code 的 StoreError(锁域一律 CONFLICT)并保留现场; 清理/回滚错误
 * 绝不遮蔽主错误 —— 主错误恒为抛出的错误, 清理失败只追加进主错误的
 * message/details(见 appendCleanupTo)。回收成功路径的残留副本清理失败不遮蔽
 * 主成功, 以句柄上的 cleanupWarning(只做加法)呈现。
 *
 * 边界(ADR-0021 §3/§5 承诺边界必须诚实): 本锁只约束「遵守本协议」的协作进程,
 * 不声称阻止不遵守锁的外部编辑器; 互斥由 atomic mkdir 保证, metadata 仅作归属/
 * 陈旧判定依据, 不是文件系统屏障。
 *
 * 心跳: 持有者自行按节奏调 `lock.heartbeat()`(刷新 heartbeatAt); stale 判定以
 * heartbeatAt 为准, 即使 pid 已死亡也要等到心跳过期才进入回收判定(宽限期)。
 *
 * clock/process 判定可注入 `LockProbe`(测试用: 假时钟 + 假 pid 存活判定 +
 * 假 sleep), 默认实现 = Date.now / os.hostname / process.kill(pid, 0)。
 */

/** `.git` 下锁容器相对路径。 */
export const LOCKS_SUBPATH = 'novelcraft/locks';
/** 锁目录名(每 vault 一把写锁)。 */
export const LOCK_DIRNAME = 'vault-write';
/** 锁目录内 metadata 文件名。 */
export const LOCK_METADATA_FILENAME = 'lock.json';
/** 默认 waitMs: 0 = 获取失败立即拒绝(fail-closed, 不等待)。 */
export const DEFAULT_WAIT_MS = 0;
/** waitMs 上限(用户约束: 可配置最多 5 秒等待)。 */
export const MAX_WAIT_MS = 5_000;
/** 默认 stale 阈值: 心跳超过 30 秒未刷新才可能被回收。 */
export const DEFAULT_STALE_MS = 30_000;
/** 默认轮询间隔。 */
export const DEFAULT_POLL_MS = 25;
/** metadata 内容大小上限(ADR-0021 §8 超限内容 reject)。 */
export const MAX_METADATA_BYTES = 4_096;

/** 锁 metadata 的版本化 schema(六字段, ADR-0021 §8)。 */
export interface LockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly nonce: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

/**
 * clock/process 判定注入点(测试用; 默认实现见 defaultLockProbe)。
 * - now/hostname: 时钟与主机标识;
 * - isProcessAlive: 仅在同 host 前提下被调用(回收判定的 pid 存活探测);
 * - sleep: 等待轮询间隔(默认 setTimeout)。
 */
export interface LockProbe {
  now(): number;
  hostname(): string;
  isProcessAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export interface VaultWriteLockOptions {
  /** 等待获取的最大毫秒数, 整数 0..MAX_WAIT_MS; 默认 0(立即拒绝, N32 fail-closed)。 */
  waitMs?: number;
  /** 心跳 stale 阈值(毫秒); 默认 DEFAULT_STALE_MS(30s)。 */
  staleMs?: number;
  /** 等待轮询间隔(毫秒); 默认 DEFAULT_POLL_MS。 */
  pollMs?: number;
  /** 注入 clock/process probe; 缺省用实时实现。 */
  probe?: LockProbe;
}

/** 持有中的锁句柄: heartbeat 续期、owner(nonce)校验释放、holdsLock 状态查询。 */
export interface VaultLock {
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly lockDir: string;
  readonly metaFile: string;
  /**
   * 仅在「回收成功但清理 stale 副本失败」这类极端残留时出现(fail-closed 仍成功,
   * 现场保留待人工/后续清理); 正常路径恒为 undefined。只做加法(铁律 4)。
   */
  readonly cleanupWarning?: string;
  holdsLock(): boolean;
  /** 刷新 heartbeatAt(持有者心跳); 所有权丢失/已释放 → 抛 CONFLICT(fail-closed)。 */
  heartbeat(): void;
  /** owner 释放(nonce+pid+hostname 校验); 已释放时幂等 no-op。 */
  release(): void;
}

/** 实时默认 probe: Date.now / os.hostname / kill(pid, 0) / setTimeout。 */
export const defaultLockProbe: LockProbe = {
  now: () => Date.now(),
  hostname: () => os.hostname(),
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = 进程不存在(确认死亡); 其余(EPERM 等)= 存在但无权信号 → 视为存活(fail-closed)。
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const NONCE_RE = /^[A-Za-z0-9-]{1,128}$/;
const HOSTNAME_RE = /^[\x20-\x7e]{1,255}$/;

function invalidMetadata(detail: string): StoreError {
  return new StoreError('CONFLICT', `锁元数据无效(${detail}), fail-closed (N32/ADR-0021 §8)`);
}

/**
 * 锁域 FS 错误的统一包装(独立审查 medium): 任何原始 node FS 错误在此转成
 * StoreError(锁域一律 CONFLICT, fail-closed), 并保留路径/原始信息(现场可查)。
 */
function fsStoreError(label: string, err: unknown, target?: unknown): StoreError {
  const msg = err instanceof Error ? err.message : String(err);
  return new StoreError('CONFLICT', `${label}(fail-closed, N32): ${msg}`, target);
}

/**
 * 把清理/回滚错误转换成 StoreError 并**追加**进主错误(不替换主错误)——
 * 「清理错误不能遮蔽主错误」: 调用方恒抛出主错误, 清理失败只作附加说明。
 * StoreError 的 code/details 是 readonly → 返回携带合并 message/details 的
 * 新 StoreError(code 不变), 调用方必须以返回值作为最终抛出对象。
 */
function appendCleanupTo(main: StoreError, label: string, err: unknown): StoreError {
  const clean = fsStoreError(label, err);
  const base = (typeof main.details === 'object' && main.details !== null ? main.details : {}) as Record<string, unknown>;
  return new StoreError(main.code, `${main.message}; [清理失败] ${clean.message}`, {
    ...base,
    cleanupFailed: clean.message,
  });
}

/** 原始读取 metadata(ENOENT 等不可读 → undefined; 用于区分「缺失」与「损坏」)。 */
function readRawOrUndefined(metaFile: string): string | undefined {
  try {
    return fs.readFileSync(metaFile, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 回滚删除前的归属守卫(「绝不 rm 别人的锁」): 仅当目标目录仍是我们的
 * (metadata nonce == 我们)或尚无任何身份(空目录/只有我们自己的 temp 标记)
 * 才允许删除; metadata 归属他人或损坏、或存在他人 temp 标记 → false(保留现场)。
 */
function dirOwnedOrUnclaimed(lockDir: string, metaFile: string, nonce: string): boolean {
  const raw = readRawOrUndefined(metaFile);
  if (raw !== undefined) {
    try {
      return parseLockMetadata(raw).nonce === nonce;
    } catch {
      return false; // 损坏/未知 metadata → 不删(需人工, fail-closed)
    }
  }
  try {
    for (const f of fs.readdirSync(lockDir)) {
      if (f.startsWith('.tmp-') && !f.includes(nonce)) return false; // 他人 temp → 不删
    }
  } catch {
    // 目录已不可读/已被移走 → 无法证明归属 → 保守不删。
    return false;
  }
  return true;
}

/**
 * metadata 字段白名单校验(ADR-0021 §8): 版本、字段全集、类型、取值范围、大小
 * 任一不符即无效(fail-closed)。返回带字面 version 的规范化对象。
 */
export function parseLockMetadata(raw: string): LockMetadata {
  if (raw.length > MAX_METADATA_BYTES) {
    throw invalidMetadata(`超过 ${MAX_METADATA_BYTES} 字节`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidMetadata('非法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidMetadata('非对象');
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['version', 'pid', 'hostname', 'nonce', 'acquiredAt', 'heartbeatAt']);
  const keys = Object.keys(record);
  if (keys.length !== allowed.size || keys.some((k) => !allowed.has(k))) {
    throw invalidMetadata('字段白名单不符(未知字段或字段缺失)');
  }
  const { version, pid, hostname, nonce, acquiredAt, heartbeatAt } = record;
  if (version !== 1) throw invalidMetadata(`version=${JSON.stringify(version)}`);
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw invalidMetadata(`pid=${JSON.stringify(pid)} 非正整数`);
  }
  if (typeof hostname !== 'string' || !HOSTNAME_RE.test(hostname)) {
    throw invalidMetadata(`hostname=${JSON.stringify(hostname)} 非法`);
  }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    throw invalidMetadata(`nonce=${JSON.stringify(nonce)} 非法`);
  }
  if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt) || acquiredAt < 0) {
    throw invalidMetadata(`acquiredAt=${JSON.stringify(acquiredAt)} 非法`);
  }
  if (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt) || heartbeatAt < 0) {
    throw invalidMetadata(`heartbeatAt=${JSON.stringify(heartbeatAt)} 非法`);
  }
  return { version, pid, hostname, nonce, acquiredAt, heartbeatAt };
}

/** 读取并校验锁 metadata; 缺失/损坏/不符白名单 → 抛 CONFLICT(fail-closed)。 */
export function readLockMetadata(metaFile: string): LockMetadata {
  let raw: string;
  try {
    raw = fs.readFileSync(metaFile, 'utf8');
  } catch {
    throw new StoreError('CONFLICT', `锁元数据不可读(fail-closed, N32/ADR-0021 §8): ${metaFile}`);
  }
  return parseLockMetadata(raw);
}

/** 非抛出版: 读取 + 校验, 任一失败返回 null(获取循环的 fail-closed 判定用)。 */
function tryReadLockMetadata(metaFile: string): LockMetadata | null {
  try {
    return readLockMetadata(metaFile);
  } catch {
    return null;
  }
}

/**
 * 锁路径解析 + 路径安全(ADR-0021 §8 path allowlist / symlink 拒绝):
 * - `.git` 缺失 → NOT_A_GIT_REPO; `.git` 是文件(gitdir 指针/worktree 形态)或
 *   symlink → fail-closed 拒绝(本项目每书一个普通 git 仓库);
 * - 锁**容器目录** `<vault>/.git/novelcraft/locks` 经 guardPath 词法+real 双重
 *   containment; 最终组件 `vault-write` **刻意不做 realpath 解析**, 只做词法拼接 +
 *   lstat 逐段 symlink 检查(assertNoInternalSymlink) + 原子 mkdir 语义。
 *
 * 为什么最终组件不做 realpath(独立审查回归): guardPath 的 realLocation 对「最深
 * 存在祖先」先 lstat 后 realpathSync, 而 stale 回收协议(文件级 claim: 只 rename
 * lock.json, 锁目录原地不动)在清场阶段会 rmdir 掉 `vault-write` —— 若回收者的
 * rmdir 恰好落在另一进程 lstat(成功)与 realpathSync 之间, realpathSync 报 ENOENT,
 * guardPath 抛错被 resolveWithin 包装成 PATH_TRAVERSAL: 锁竞争的失败者被误报为
 * 「路径逃逸」。
 * 容器 `locks`/`novelcraft` 永不被 rename(只被递归 mkdir 创建; 不存在时回退到
 * 恒为真实目录的 `.git`), 对容器做 real 检查无此竞态; `vault-write` 的安全性由
 * lstat 逐段检查(检查后 mkdir 对 symlink 一律 EEXIST → 按占用处理, 回收/删除只
 * 操作目录条目、绝不跟随 symlink 写穿)保证, 无需 realpath。
 */
function resolveLockDir(root: string): { lockDir: string; locksDir: string } {
  const gitDir = resolveWithin(root, '.git'); // guardPath 词法+real containment
  let st;
  try {
    st = fs.lstatSync(gitDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StoreError('NOT_A_GIT_REPO', `工作区不是 git 仓库(缺 .git): ${root}`);
    }
    throw new StoreError('CONFLICT', `无法检查 .git(fail-closed): ${(err as Error).message}`);
  }
  if (st.isSymbolicLink()) {
    throw new StoreError('PATH_TRAVERSAL', '锁路径含 symlink(fail-closed): .git');
  }
  if (!st.isDirectory()) {
    throw new StoreError(
      'NOT_A_GIT_REPO',
      '.git 必须是真实目录(不支持 gitdir 指针/worktree 形态), fail-closed: ' + gitDir,
    );
  }
  // 容器目录 real 检查(locks/novelcraft 永不被 rename, 无 lstat→realpath 竞态);
  // 中间组件被普通文件顶替(ENOTDIR/非目录)按 PATH_TRAVERSAL fail-closed(与旧
  // guardPath(全路径)行为一致, 只是不再对可被回收 rename 的 vault-write 做 realpath)。
  const locksDir = resolveWithin(root, path.join('.git', LOCKS_SUBPATH));
  let locksSt;
  try {
    locksSt = fs.lstatSync(locksDir, { throwIfNoEntry: false });
  } catch (err) {
    throw new StoreError(
      'PATH_TRAVERSAL',
      `锁路径中间组件非法(fail-closed): ${locksDir}`,
      (err as Error).message,
    );
  }
  if (locksSt !== undefined && !locksSt.isDirectory()) {
    throw new StoreError('PATH_TRAVERSAL', `锁路径中间组件不是目录(fail-closed): ${locksDir}`);
  }
  const lockDir = path.join(locksDir, LOCK_DIRNAME);
  assertNoInternalSymlink(root, lockDir); // 逐段 lstat: 任一组件 symlink → PATH_TRAVERSAL
  return { lockDir, locksDir };
}

function lockIdentityMatches(a: LockMetadata, b: LockMetadata): boolean {
  return (
    a.nonce === b.nonce &&
    a.pid === b.pid &&
    a.hostname === b.hostname &&
    a.heartbeatAt === b.heartbeatAt
  );
}

/**
 * 同目录 temp + fsync + rename 原子写入 metadata(ADR-0021 §8 原子写)。
 * 全部 FS 错误统一转 StoreError(CONFLICT)并保留现场: 写入失败后尽力清理 temp,
 * 清理失败只追加说明、绝不替换主错误(独立审查 medium)。
 */
function writeLockMetadata(metaFile: string, meta: LockMetadata): void {
  const tmp = `${metaFile}.tmp-${meta.nonce}`;
  let fd: number;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
  } catch (err) {
    const main = fsStoreError(`打开锁元数据临时文件失败: ${tmp}`, err, metaFile);
    try {
      fs.unlinkSync(tmp); // 尽力清理; 失败不遮蔽主错误
    } catch (e) {
      throw appendCleanupTo(main, '清理锁元数据临时文件失败', e);
    }
    throw main;
  }
  let primary: StoreError | undefined;
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(meta), 'utf8');
      fs.fsyncSync(fd);
    } catch (err) {
      primary = fsStoreError('写入/fsync 锁元数据失败', err, metaFile);
    }
  } finally {
    // close 失败: 若尚无主错误则以它为主, 否则只追加(不遮蔽)。
    try {
      fs.closeSync(fd);
    } catch (err) {
      const closeErr = fsStoreError('关闭锁元数据临时文件失败', err, metaFile);
      if (primary === undefined) primary = closeErr;
      else primary = appendCleanupTo(primary, '关闭锁元数据临时文件失败', err);
    }
  }
  if (primary !== undefined) {
    try {
      fs.unlinkSync(tmp);
    } catch (err) {
      throw appendCleanupTo(primary, '清理锁元数据临时文件失败', err);
    }
    throw primary;
  }
  try {
    fs.renameSync(tmp, metaFile);
  } catch (err) {
    const renameErr = fsStoreError('原子写入锁元数据失败(rename)', err, metaFile);
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      throw appendCleanupTo(renameErr, '清理锁元数据临时文件失败', e);
    }
    throw renameErr;
  }
}

class VaultWriteLockHandle implements VaultLock {
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: number;
  heartbeatAt: number;
  readonly lockDir: string;
  readonly metaFile: string;
  cleanupWarning?: string;
  private readonly probe: LockProbe;
  private held = true;

  constructor(meta: LockMetadata, lockDir: string, metaFile: string, probe: LockProbe) {
    this.nonce = meta.nonce;
    this.pid = meta.pid;
    this.hostname = meta.hostname;
    this.acquiredAt = meta.acquiredAt;
    this.heartbeatAt = meta.heartbeatAt;
    this.lockDir = lockDir;
    this.metaFile = metaFile;
    this.probe = probe;
  }

  holdsLock(): boolean {
    return this.held;
  }

  private toMeta(): LockMetadata {
    return {
      version: 1,
      pid: this.pid,
      hostname: this.hostname,
      nonce: this.nonce,
      acquiredAt: this.acquiredAt,
      heartbeatAt: this.heartbeatAt,
    };
  }

  /**
   * owner 校验(N32: 释放/心跳必须持有者本人): 重读 metadata 并核对
   * nonce+pid+hostname。返回 false = 锁目录已消失(已释放/被回收); 元数据
   * 缺失/损坏/不匹配 → 抛 CONFLICT 且不触碰现场(fail-closed)。
   */
  private verifyOwned(): boolean {
    if (!this.held) {
      throw new StoreError('CONFLICT', '锁已释放, 操作被拒绝 (N32)');
    }
    const meta = tryReadLockMetadata(this.metaFile);
    if (meta === null) {
      if (!fs.existsSync(this.lockDir)) return false; // 目录已消失 → 不再持有
      throw new StoreError(
        'CONFLICT',
        '锁元数据缺失或损坏, 所有权无法证明, 拒绝操作(fail-closed, N32/ADR-0021 §8)',
      );
    }
    if (meta.nonce !== this.nonce || meta.pid !== this.pid || meta.hostname !== this.hostname) {
      throw new StoreError(
        'CONFLICT',
        '锁所有权不匹配(owner nonce/pid/hostname 校验失败), 拒绝操作(fail-closed, N32)',
      );
    }
    return true;
  }

  heartbeat(): void {
    if (!this.held) {
      throw new StoreError('CONFLICT', '锁已释放, 不能心跳 (N32)');
    }
    if (!this.verifyOwned()) {
      this.held = false;
      throw new StoreError('CONFLICT', '锁已不再持有(目录已消失), 不能心跳 (N32)');
    }
    this.heartbeatAt = this.probe.now();
    writeLockMetadata(this.metaFile, this.toMeta()); // 内部 FS 错误已统一 StoreError
  }

  release(): void {
    if (!this.held) return; // 幂等
    if (!this.verifyOwned()) {
      this.held = false; // 锁目录已消失 → 视为已释放(no-op)
      return;
    }
    // 验明正身后才删除(ADR-0021 §3 边界: 只约束协作进程; 本 handle 的 pid 存活,
    // 回收协议只针对 pid 已死的 stale 锁, 故活锁期间无他人可移走本目录)。
    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch (err) {
      // 主错误 = 释放失败: 转 StoreError 且保留现场(目录不删), held 保持 true 可重试。
      throw fsStoreError('释放锁失败(现场保留, 可重试)', err, this.lockDir);
    }
    this.held = false;
  }
}

/**
 * stale 回收判定 + 原子重占(N32 / ADR-0021 §3「锁文件 + 持有者 pid + 心跳/超时」):
 * 仅当 ①心跳过期(now - heartbeatAt >= staleMs)②hostname 同本机 ③pid 确认死亡
 * 三者全成立才回收; 未知/损坏/远端/存活进程一律返回 undefined(fail-closed)。
 *
 * 双回收竞态防护(独立审查 high, 文件级 claim: read→verify→claim→清场→write):
 * - rename 前复核: 最新快照必须与观测身份一致(而非仅用旧快照), 不一致不 claim;
 * - **claim = 只 rename 走 metadata 文件**(lock.json → `.reclaim-<uuid>`), 锁目录
 *   原地不动: 目录级 claim 的 rename 可能把「另一回收者刚 mkdir 的新活目录」整体
 *   移走, 打断其元数据写入(open ENOENT/EINVAL), 造成双方都失败(独立审查回归:
 *   双真实子进程竞争曾以 ~2% 复现); 文件级 claim 下目录永不移动, 在写者永不被打断,
 *   「最多一个 acquire 成功」由 rename 原子性 + 身份验证恒成立;
 * - **claim 后验证**: trash 内 metadata 必须仍匹配观测的 nonce/pid/hostname/
 *   heartbeatAt —— 移开的确是我们观测的那把 stale 锁; 不匹配(他人刚写入的新活
 *   metadata 被我们移走)/不可验证 → 立即原样 rename 还原 —— 目标路径此刻必为空
 *   (被移走的就是它), 还原无 clobber 窗口; 还原失败 → 抛 CONFLICT 且保留现场
 *   (绝不 rm);
 * - **清场**: rmdir 锁目录。ENOTEMPTY = 目录内有在写者的临时文件/崩溃残留 →
 *   不打断, 丢弃 verified-stale 副本(其属主已确认死亡, 是垃圾; 在写者稍后将建立
 *   新锁), 返回 undefined(保守 busy); 其余 rmdir 失败 → 还原 trash 后返回;
 * - 新 lockDir mkdir 失败(他人抢先 mkdir 成功)→ 他人目录已就位, verified-stale
 *   副本同样按垃圾清理, 返回 undefined;
 * - 写新 metadata 失败 → 回滚「自建目录(经归属守卫) + verified-stale trash」,
 *   清理失败只追加、主错误恒为写入失败;
 * - 最后删除自己的 verified-stale trash; 删除失败不遮蔽主成功(cleanupWarning)。
 */
function tryReclaimLock(
  probe: LockProbe,
  staleMs: number,
  locksDir: string,
  lockDir: string,
  metaFile: string,
  nonce: string,
): VaultLock | undefined {
  const observed = tryReadLockMetadata(metaFile);
  if (observed === null) return undefined; // 未知/损坏/缺 metadata → 不回收
  const now = probe.now();
  if (now - observed.heartbeatAt < staleMs) return undefined; // 心跳未过期 → 宽限期内
  if (observed.hostname !== probe.hostname()) return undefined; // 远端 host → 不回收
  if (probe.isProcessAlive(observed.pid)) return undefined; // 存活(含 pid 复用)→ 不回收
  // 声明前最新快照复核: 观测身份+心跳未变(期间未被他人回收/刷新)→ 才允许 claim。
  // 这只是缩小误移窗口的优化; 真正的安全网是 claim 后验证。
  const recheck = tryReadLockMetadata(metaFile);
  if (recheck === null || !lockIdentityMatches(recheck, observed)) return undefined;
  // —— 原子 claim + 验证: 只移走 metadata 文件, 锁目录原地不动 ——
  const trash = path.join(locksDir, `.reclaim-${crypto.randomUUID()}`);
  try {
    fs.renameSync(metaFile, trash);
  } catch {
    return undefined; // 已被他人 claim/删除(ENOENT)或权限失败 → 保守重试(零副作用)
  }
  const movedMeta = tryReadLockMetadata(trash);
  if (movedMeta === null || !lockIdentityMatches(movedMeta, observed)) {
    // 移走的不是我们观测的 stale metadata(他人刚写入的新活锁被我们移走):
    // 立即原样还原, 绝不 rm; 还原失败 → CONFLICT 保留现场。目标路径此刻必为空
    // (被移走的就是它), 故还原没有 clobber 窗口。
    try {
      fs.renameSync(trash, metaFile);
    } catch (err) {
      throw fsStoreError('锁 claim 验证失败且无法还原被移开的元数据(现场保留)', err, {
        trash,
        metaFile,
      });
    }
    return undefined;
  }
  // —— 已验证 trash 就是观测的那把 stale 锁: 清场 + 重占 ——
  // rmdir 成功 = 目录确已空(只有我们移走的 lock.json); ENOTEMPTY = 有在写者的
  // 临时文件/崩溃残留 → 不打断(目录不移动), 丢弃 verified-stale 副本后返回 busy。
  try {
    fs.rmdirSync(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      try {
        fs.rmSync(trash, { recursive: true, force: true });
      } catch {
        // 清理 verified-stale 副本失败: 不遮蔽主路径, 现场保留(垃圾待人工/后续)。
      }
      return undefined;
    }
    // 其余失败(权限等): 保守还原 trash 后返回; 还原失败 → CONFLICT 保留现场。
    try {
      fs.renameSync(trash, metaFile);
    } catch (e) {
      throw fsStoreError('清场失败且无法还原被移开的元数据(现场保留)', e, { trash, metaFile });
    }
    return undefined;
  }
  try {
    fs.mkdirSync(lockDir);
  } catch {
    // 重占竞态(他人抢先 mkdir 成功, 其目录已就位): verified-stale 副本是垃圾
    // (属主已确认死亡), 清理后返回 undefined; 清理失败 → CONFLICT 保留现场。
    try {
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (e) {
      throw fsStoreError('重占失败且无法清理 verified-stale 副本(现场保留)', e, { trash, lockDir });
    }
    return undefined;
  }
  const acquiredAt = probe.now();
  const fresh: LockMetadata = {
    version: 1,
    pid: process.pid,
    hostname: probe.hostname(),
    nonce,
    acquiredAt,
    heartbeatAt: acquiredAt,
  };
  try {
    writeLockMetadata(metaFile, fresh);
  } catch (err) {
    // 主错误 = 写入失败(已是 StoreError); 回滚只清理「自己的东西」。
    let main = err instanceof StoreError ? err : fsStoreError('回收后写入锁元数据失败', err);
    if (dirOwnedOrUnclaimed(lockDir, metaFile, nonce)) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch (e) {
        main = appendCleanupTo(main, '清理自建锁目录失败', e);
      }
    }
    // trash 已在验证中确认身份 == 观测 stale 锁且无人可改 → 属我们, 可安全清理。
    try {
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (e) {
      main = appendCleanupTo(main, '清理 stale 锁副本失败', e);
    }
    throw main;
  }
  try {
    fs.rmSync(trash, { recursive: true, force: true });
  } catch (err) {
    // 主操作已成功: 清理失败不遮蔽成功; 转 StoreError 并挂句柄(只做加法)。
    const handle = new VaultWriteLockHandle(fresh, lockDir, metaFile, probe);
    handle.cleanupWarning = fsStoreError('清理回收副本失败(现场保留)', err, trash).message;
    return handle;
  }
  return new VaultWriteLockHandle(fresh, lockDir, metaFile, probe);
}

/**
 * 获取 per-vault 跨进程写锁(N32 / ADR-0021 §3)。
 *
 * @param root vault 根目录(必须是真实 git 仓库);
 * @param opts waitMs(0..5000, 默认 0 立即拒绝) / staleMs(默认 30s) /
 *   pollMs / probe(clock/process 注入);
 * @returns 持有中的锁句柄(release() 释放; heartbeat() 续期);
 * @throws StoreError:
 *   - `CONFLICT` 锁被占用且等待预算内未获取(或锁状态未知/异常)——
 *     绝不无锁继续;
 *   - `PATH_TRAVERSAL` 锁路径含 symlink/逃逸;
 *   - `NOT_A_GIT_REPO` vault 无 `.git` 真实目录;
 *   - `VALIDATION_FAILED` waitMs/staleMs/pollMs 越界。
 */
export async function acquireVaultWriteLock(
  root: string,
  opts: VaultWriteLockOptions = {},
): Promise<VaultLock> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new StoreError(
      'VALIDATION_FAILED',
      `waitMs 必须在 0..${MAX_WAIT_MS}ms 整数(默认 ${DEFAULT_WAIT_MS}= 立即拒绝 fail-closed, N32): ${String(waitMs)}`,
    );
  }
  if (!Number.isInteger(staleMs) || staleMs <= 0) {
    throw new StoreError('VALIDATION_FAILED', `staleMs 必须为正整数: ${String(staleMs)}`);
  }
  if (!Number.isInteger(pollMs) || pollMs <= 0) {
    throw new StoreError('VALIDATION_FAILED', `pollMs 必须为正整数: ${String(pollMs)}`);
  }
  const probe = opts.probe ?? defaultLockProbe;
  const nonce = crypto.randomUUID();
  const { lockDir, locksDir } = resolveLockDir(root);
  const metaFile = path.join(lockDir, LOCK_METADATA_FILENAME);

  try {
    fs.mkdirSync(locksDir, { recursive: true }); // 容器目录(非原子声明点)
  } catch (err) {
    throw fsStoreError('创建锁容器目录失败', err, locksDir);
  }

  const start = probe.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir); // 原子 mkdir: EEXIST = 已被占用
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw fsStoreError('创建锁目录失败', err, lockDir);
      }
      const reclaimed = tryReclaimLock(probe, staleMs, locksDir, lockDir, metaFile, nonce);
      if (reclaimed !== undefined) return reclaimed;
      if (probe.now() - start >= waitMs) {
        throw new StoreError(
          'CONFLICT',
          `vault 写锁被占用, ${waitMs}ms 内未获取(fail-closed, N32/ADR-0021 §3): ${lockDir}`,
          { waitMs, lockDir },
        );
      }
      await probe.sleep(pollMs);
      continue;
    }
    // mkdir 成功(独占): 立即写六字段 metadata; 失败只回滚「自己的目录」
    // (归属守卫: 期间若被他人移走/替换, 绝不删除非我们之物)。
    const acquiredAt = probe.now();
    const meta: LockMetadata = {
      version: 1,
      pid: process.pid,
      hostname: probe.hostname(),
      nonce,
      acquiredAt,
      heartbeatAt: acquiredAt,
    };
    try {
      writeLockMetadata(metaFile, meta);
    } catch (err) {
      const main = err instanceof StoreError ? err : fsStoreError('写入锁元数据失败', err);
      if (dirOwnedOrUnclaimed(lockDir, metaFile, nonce)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch (e) {
          throw appendCleanupTo(main, '清理自建锁目录失败', e);
        }
      }
      throw main;
    }
    return new VaultWriteLockHandle(meta, lockDir, metaFile, probe);
  }
}