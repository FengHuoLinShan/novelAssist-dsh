// @novelcraft/dsh · 会话↔工作区绑定(vault 适配)。
// seam 契约(packages/novelcraft/README.md): 每书一个 DSH session 绑定一个 vault 根
// (D17); 子代理 prompt 注入书名/路径(§14)。
// 依据: 设计文档 §22.2(~/Novels/<书名>/)、N9(book.yml 字段)、
// vault 包(initVault/resolveVaultRoot/guardPath/paths)。
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  initVault,
  paths as vaultPaths,
  readAsset,
  resolveVaultRoot,
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
 * 会话↔vault 绑定器: 书名 → vaultsDir/<书名>; 初始化幂等;
 * 会话绑定持久化在 novelcraft domain 的 sessions 表。
 */
export class SessionVaultBinder {
  private readonly config: Config;
  private readonly cache?: NovelcraftCache;
  private readonly bySession = new Map<string, VaultBinding>();

  constructor(config: Config, cache?: NovelcraftCache) {
    this.config = config;
    this.cache = cache;
  }

  /** 书名 → vault 根绝对路径(vaultsDir/<书名>)。 */
  rootForBook(book: string): string {
    return path.join(expandHome(this.config.vaultsDir), book);
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

  /** 绑定会话 → vault(内存 + domain 持久化)。 */
  async bindSession(sessionId: string, binding: VaultBinding): Promise<void> {
    this.bySession.set(sessionId, binding);
    if (this.cache) {
      await this.cache.bindSession(sessionId, binding.root, binding.book);
    }
  }

  /** 解析会话绑定(内存优先; 内存缺失时回查 domain)。 */
  async resolve(sessionId: string): Promise<VaultBinding | undefined> {
    const local = this.bySession.get(sessionId);
    if (local) return local;
    if (this.cache) {
      const root = await this.cache.resolveSession(sessionId);
      if (root) {
        const binding = this.readVault(root);
        if (binding) {
          this.bySession.set(sessionId, binding);
          return binding;
        }
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
    const p = binding.paths;
    return [
      `当前工作区: 小说「${binding.book}」`,
      `vault 根目录(绝对路径): ${binding.root}`,
      `目录语义: chapters/ 正文章节、scenes/ 场景、world/objects/ 已采用对象、`,
      `world/pending/ 待处理队列、structure/ 结构资产、bible/ 世界书、imports/ 导入停靠。`,
      `纪律: 正文与资产原文不得写入任何产出物或对外转发; 写操作需经工具审批。`,
    ].join('\n');
  }

  /** 全部会话绑定快照(诊断面)。 */
  listBound(): Array<[string, VaultBinding]> {
    return [...this.bySession.entries()];
  }
}
