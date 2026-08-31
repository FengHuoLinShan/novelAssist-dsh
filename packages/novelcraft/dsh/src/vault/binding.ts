// @novelcraft/dsh · 会话↔工作区绑定(vault 适配)。
// seam 契约(packages/novelcraft/README.md): 每书一个 DSH session 绑定一个 vault 根
// (D17); 子代理 prompt 注入书名/路径(§14)。
// 依据: 设计文档 §22.2(~/Novels/<书名>/)、N9(book.yml 字段)、
// vault 包(initVault/resolveVaultRoot/guardPath/paths)。
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  guardPath,
  initVault,
  paths as vaultPaths,
  readAsset,
  resolveVaultRoot,
  validateInitializedVault,
  type BookMeta,
  type VaultPaths,
} from '@novelcraft/vault';
import { parseFrontmatter } from '@novelcraft/store';
import { expandHome, type Config } from '../config.js';
import type { NovelcraftCache } from '../storage/domain.js';

export interface VaultBinding {
  /** 书名(book.yml title) */
  book: string;
  /** vault 根绝对路径 */
  root: string;
  /** 路径常量(缓存) */
  paths: VaultPaths;
}

/**
 * 强制 book 为「单个非空目录名」(R9 工作区隔离): 拒绝空名/纯空白、
 * '.'/'..'、路径分隔符(`/` `\`)与控制字符。不做 trim——含首尾空格的合法
 * 名字维持既有行为, 仅整串为空白时视为空名拒绝。
 */
function validateBookDirName(book: string): void {
  if (typeof book !== 'string' || book.trim().length === 0) {
    throw new Error(
      `Invalid book name: expected a non-empty directory name, got ${JSON.stringify(book)}`,
    );
  }
  if (book === '.' || book === '..') {
    throw new Error(`Invalid book name: "." and ".." are not allowed`);
  }
  if (/[\\/]/.test(book)) {
    throw new Error(
      `Invalid book name: path separators are not allowed in "${book}"`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(book)) {
    throw new Error(
      `Invalid book name: control characters are not allowed in "${book}"`,
    );
  }
}

/**
 * 会话↔vault 绑定器: 书名 → vaultsDir/<书名>; 初始化幂等;
 * 会话绑定持久化在 novelcraft domain 的 sessions 表。
 */
export class SessionVaultBinder {
  private readonly config: Config;
  private readonly cache?: NovelcraftCache;
  private readonly bySession = new Map<string, VaultBinding>();
  /** N34: 活跃 vault 引用只由服务端 session created/disposed 驱动。 */
  private readonly sessionsByRoot = new Map<string, Set<string>>();

  constructor(config: Config, cache?: NovelcraftCache) {
    this.config = config;
    this.cache = cache;
  }

  /**
   * 书名 → vault 根绝对路径(vaultsDir/<书名>)。
   *
   * 工作区隔离(R9): book 被强制为「单个非空目录名」——拒绝空名/纯空白、
   * '.'/'..'、路径分隔符(`/` `\`)与控制字符; 再经 vault.guardPath 双重
   * containment(lexical + realpath)兜底, 保证结果一定落在 vaultsDir 内。
   * 合法中文/含空格书名(如「诡秘之主」「The Way of Kings」)行为不变。
   * ensureVault 经本方法继承全部校验。
   */
  rootForBook(book: string): string {
    validateBookDirName(book);
    return guardPath(expandHome(this.config.vaultsDir), book);
  }

  /** 确保 vault 存在: 缺失则按 BookMeta 初始化; 已有则返回既有(不动现有文件)。 */
  ensureVault(book: string, meta?: Partial<BookMeta>): VaultBinding {
    const root = this.rootForBook(book);
    const p = vaultPaths(root);
    if (!existsSync(p.root) || !existsSync(p.bookYml)) {
      initVault(root, { title: book, ...(meta ?? {}) });
    }
    return { book, root, paths: p };
  }

  /** 从已存在的 vault 读取绑定(book.yml title); 不存在返回 undefined。 */
  readVault(root: string): VaultBinding | undefined {
    const p = vaultPaths(root);
    if (!existsSync(p.bookYml)) return undefined;
    const parsed = parseFrontmatter(readAsset(root, 'book.yml'));
    const title = typeof parsed.data?.title === 'string' ? parsed.data.title : path.basename(root);
    return { book: title, root, paths: p };
  }

  /** 绑定会话 → vault(内存 + domain 缓存); 返回原子捕获的 0→1 引用转换。 */
  async bindSession(
    sessionId: string,
    binding: VaultBinding,
  ): Promise<{ activated: boolean; count: number; deactivatedRoot?: string }> {
    const previous = this.bySession.get(sessionId);
    const sameBinding = previous?.root === binding.root;
    let deactivatedRoot: string | undefined;
    if (previous && !sameBinding) {
      const refsBefore = this.referenceCount(previous.root);
      this.removeReference(sessionId, previous.root);
      // 切走后旧 root 引用归零 → 守望应停(M11 review P1-1: 供 book_open 驱动生命周期)。
      if (refsBefore === 1) deactivatedRoot = previous.root;
    }
    const before = this.referenceCount(binding.root);
    this.bySession.set(sessionId, binding);
    let refs = this.sessionsByRoot.get(binding.root);
    if (!refs) this.sessionsByRoot.set(binding.root, (refs = new Set()));
    refs.add(sessionId);
    // 在任何 await 前捕获转换，避免 created/disposed 并发把“当前count=1”误判成二次激活。
    const transition = { activated: !sameBinding && before === 0, count: refs.size, ...(deactivatedRoot !== undefined ? { deactivatedRoot } : {}) };
    if (this.cache) {
      // domain 只是可重建缓存；缓存失败不得撤销已验证的服务端生命周期绑定(N34)。
      await this.cache.bindSession(sessionId, binding.root, binding.book).catch(() => undefined);
    }
    return transition;
  }

  /**
   * N34 session/created 入口：只按绝对 cwd 绑定已存在、**已初始化** 的 vault。
   * 不调用 ensureVault，不存在/非法路径只返回原因且零文件副作用。
   * 前置校验经 vault.validateInitializedVault(只读): book.yml 合法、.git 为真实
   * 目录且 HEAD 可解析、必要骨架存在——伪 book.yml(无 git)/半初始化一律不绑定、
   * 不激活 watch、绝不自动 init(R9/N34 工作区隔离)。
   */
  async bindByCwd(
    sessionId: string,
    cwd: string | undefined,
  ): Promise<
    | { status: 'bound'; binding: VaultBinding; activated: boolean; count: number }
    | { status: 'unbound'; reason: string }
  > {
    if (!cwd || !path.isAbsolute(cwd)) {
      return { status: 'unbound', reason: 'session cwd 缺失或不是绝对路径' };
    }
    if (!existsSync(cwd)) {
      return { status: 'unbound', reason: `session cwd 不存在: ${cwd}` };
    }
    const binding = this.resolveFromPath(cwd);
    if (!binding) {
      return { status: 'unbound', reason: `cwd 不属于已初始化 vault: ${cwd}` };
    }
    const validated = validateInitializedVault(binding.root);
    if (!validated.ok) {
      return {
        status: 'unbound',
        reason: `cwd 不是已初始化的 vault(${validated.reason}): ${cwd}`,
      };
    }
    const transition = await this.bindSession(sessionId, binding);
    return { status: 'bound', binding, ...transition };
  }

  /** session/disposed 入口；返回该 vault 是否失去最后一个服务端 session 引用。 */
  async unbindSession(sessionId: string): Promise<{
    binding?: VaultBinding;
    remaining: number;
    lastForVault: boolean;
  }> {
    const binding = this.bySession.get(sessionId);
    if (!binding) {
      if (this.cache) await this.cache.deleteSession(sessionId).catch(() => false);
      return { remaining: 0, lastForVault: false };
    }
    this.bySession.delete(sessionId);
    const remaining = this.removeReference(sessionId, binding.root);
    if (this.cache) await this.cache.deleteSession(sessionId).catch(() => false);
    return { binding, remaining, lastForVault: remaining === 0 };
  }

  private removeReference(sessionId: string, root: string): number {
    const refs = this.sessionsByRoot.get(root);
    if (!refs) return 0;
    refs.delete(sessionId);
    if (refs.size === 0) {
      this.sessionsByRoot.delete(root);
      return 0;
    }
    return refs.size;
  }

  /** 解析会话绑定(内存优先; 内存缺失时回查 domain)。 */
  async resolve(sessionId: string): Promise<VaultBinding | undefined> {
    const local = this.bySession.get(sessionId);
    if (local) return local;
    if (this.cache) {
      const root = await this.cache.resolveSession(sessionId);
      if (root) {
        const binding = this.readVault(root);
        // Cache fallback is a read-through lookup only. Reference ownership is exclusively advanced
        // by session/created through bindSession; otherwise a tool lookup could create a phantom ref
        // that suppresses the scheduler's real 0→1 activation.
        if (binding) return binding;
      }
    }
    return undefined;
  }

  /** 给任意目录内路径找最近 vault 根(vault.resolveVaultRoot); 找不到返回 undefined。 */
  resolveFromPath(startPath: string): VaultBinding | undefined {
    try {
      const root = resolveVaultRoot(startPath);
      return this.readVault(root);
    } catch {
      return undefined;
    }
  }

  /**
   * 子代理 prompt 注入文本(§14): 书名 + vault 根 + 目录语义一句话。
   * 不进正文; 编排脑可见书名/路径是设计内(无隐私模式 D14 只约束原文转发)。
   */
  contextInjection(binding: VaultBinding): string {
    return [
      `当前工作区: 小说「${binding.book}」`,
      `vault 根目录(绝对路径): ${binding.root}`,
      `目录语义: chapters/ 正文章节、scenes/ 场景、world/objects/ 已采用对象、`,
      `world/pending/ 待处理队列、structure/ 结构资产、bible/ 世界书、imports/ 导入停靠。`,
      `纪律: 正文与资产原文不得写入任何产出物或对外转发; 写操作需经工具审批。`,
    ].join('\n');
  }

  /** 当前服务端 session 对一个 vault 的引用数。 */
  referenceCount(root: string): number {
    return this.sessionsByRoot.get(root)?.size ?? 0;
  }

  /** 至少有一个服务端 session 的活跃 vault 快照。 */
  activeVaults(): VaultBinding[] {
    const byRoot = new Map<string, VaultBinding>();
    for (const binding of this.bySession.values()) {
      if (this.referenceCount(binding.root) > 0) byRoot.set(binding.root, binding);
    }
    return [...byRoot.values()];
  }

  /** 全部会话绑定快照(诊断面)。 */
  listBound(): Array<[string, VaultBinding]> {
    return [...this.bySession.entries()];
  }
}
