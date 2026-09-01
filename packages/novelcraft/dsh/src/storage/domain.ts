// @novelcraft/dsh · ctx.storageDomain 适配(novelcraft domain)。
// seam 契约(packages/novelcraft/README.md): rebuildIndex 产物 → ctx.storage
// domain KV(sqlite/文件后端由 profile 决定)的可选持久化; 文件仍是唯一真相
// (设计文档 §22.2「索引规则」: 派生索引任何时刻可全量重建)。
// 依据: dsh-storage-domain seam(defineDomain/domainTable, zod 记录 schema,
// 版本号保护格式; 后端路由由 profile 的 storage-domain 插件配置决定)。
import type { Context } from '@deepseek-ai/cordis';
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { svc } from '../ctx.js';

/** 会话 → vault 绑定记录(D17: 一书一会话一 vault 根)。 */
export interface SessionBindingRecord {
  /** vault 根绝对路径(展开后的) */
  vaultRoot: string;
  /** 书名(作者语言, 用于子代理 prompt 注入 §14) */
  book: string;
  /** 绑定时间 ISO */
  boundAt: string;
}

/** 派生索引缓存记录(信封校验; 索引内层结构由 @novelcraft/store 的 VaultIndex.version 自描述)。 */
export interface IndexCacheRecord {
  /** vault 根绝对路径 */
  vaultRoot: string;
  /** 构建时间 ISO */
  builtAt: string;
  /** VaultIndex 版本(与 @novelcraft/store 的 version 字段一致) */
  indexVersion: number;
  /** 派生索引载荷(JSON 可序列化; 校验交给 envelope + version) */
  index: unknown;
}

const sessionSchema = z.object({
  vaultRoot: z.string().min(1),
  book: z.string().min(1),
  boundAt: z.string().min(1),
});

const indexSchema = z.object({
  vaultRoot: z.string().min(1),
  builtAt: z.string().min(1),
  indexVersion: z.number().int().nonnegative(),
  index: z.unknown(),
});

/** 内容手预设卡记录(N20; Key 永不进此表——预设只有 provider/model/参数, 铁律 6)。 */
const presetSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoning_effort: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  timeout_ms: z.number().optional(),
  workflow_budget: z.number().int().min(1).max(1_000_000_000).optional(),
  updatedAt: z.string().min(1),
});

/** NovelCraft 的唯一 domain: 会话绑定 + 派生索引缓存 + 内容手预设卡(三张表, 无 global)。 */
export const novelcraftDomain = defineDomain({
  name: 'novelcraft',
  version: 1,
  tables: {
    sessions: domainTable<string, SessionBindingRecord>(sessionSchema),
    indexes: domainTable<string, IndexCacheRecord>(indexSchema),
    presets: domainTable<string, z.infer<typeof presetSchema>>(presetSchema),
  },
});

/** 内容手预设卡记录类型(表值; 与 llm-step ContentPreset 对齐 + updatedAt)。 */
export type ContentPresetRecord = z.infer<typeof presetSchema>;

export type NovelcraftDomain = Domain<typeof novelcraftDomain>;

/** vault 根 → domain 表键(规范化: 去掉尾部斜杠, 保留大小写)。 */
export function domainKeyForRoot(root: string): string {
  return root.replace(/[\\/]+$/, '');
}

/**
 * 索引/绑定缓存门面: 惰性 open domain(单次, 生命周期随宿主 effect 关闭),
 * 写失败向上抛(缓存是派生数据, 失败不影响文件真相, 由调用方决定忽略或重试)。
 */
export class NovelcraftCache {
  private readonly ctx: Context;
  private domainPromise?: Promise<NovelcraftDomain>;
  private domain?: NovelcraftDomain;
  private closed = false;
  private closePromise?: Promise<void>;
  /** 最近写入(durable 落盘前的同步读面; 文件真相下缓存只是加速, 允许短暂不一致)。 */
  private readonly pending = new Map<string, IndexCacheRecord>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 惰性打开 domain(幂等; 同一 context 内只 open 一次)。 */
  async open(): Promise<NovelcraftDomain> {
    if (this.closed) throw new Error('NovelcraftCache 已关闭');
    if (this.domain) return this.domain;
    if (!this.domainPromise) {
      const facility = svc<DomainFacility>(this.ctx, 'storageDomain');
      if (!facility) {
        throw new Error('ctx.storageDomain 服务不可用(索引缓存需要 storage-domain 插件; 文件真相不受影响)');
      }
      const opening = facility.open(novelcraftDomain).then(async (domain) => {
        if (this.closed) {
          await domain.close();
          throw new Error('NovelcraftCache 在打开期间已关闭');
        }
        this.domain = domain;
        return domain;
      });
      this.domainPromise = opening.catch((error) => {
        this.domainPromise = undefined;
        throw error;
      });
    }
    return this.domainPromise;
  }

  /** 覆盖写派生索引缓存(durable, 写链序; 落盘前 pending 即读可见)。 */
  async putIndex(root: string, indexVersion: number, index: unknown): Promise<void> {
    const record: IndexCacheRecord = {
      vaultRoot: domainKeyForRoot(root),
      builtAt: new Date().toISOString(),
      indexVersion,
      index,
    };
    this.pending.set(domainKeyForRoot(root), record);
    try {
      const domain = await this.open();
      await domain.table('indexes').put(domainKeyForRoot(root), record);
    } catch {
      // 缓存是派生数据; 落盘失败保留 pending 读面, 下次重建覆盖。
    }
  }

  /** 同步读索引缓存(pending 优先, 其次 domain 内存权威态; 未缓存返回 undefined)。 */
  getIndex(root: string): IndexCacheRecord | undefined {
    const key = domainKeyForRoot(root);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (!this.domain) return undefined;
    return this.domain.table('indexes').get(key);
  }

  /** 绑定会话 → vault 根。 */
  async bindSession(sessionId: string, vaultRoot: string, book: string): Promise<void> {
    const domain = await this.open();
    await domain
      .table('sessions')
      .put(sessionId, { vaultRoot: domainKeyForRoot(vaultRoot), book, boundAt: new Date().toISOString() });
  }

  /** 解析会话 → vault 根(未绑定返回 undefined)。 */
  async resolveSession(sessionId: string): Promise<string | undefined> {
    const domain = await this.open();
    return domain.table('sessions').get(sessionId)?.vaultRoot;
  }

  /** 删除会话绑定(session/disposed; domain 仅缓存, 删除失败由调用方容错)。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const domain = await this.open();
    return domain.table('sessions').delete(sessionId);
  }

  /** 会话绑定记录全量(诊断面)。 */
  async listSessions(): Promise<Array<[string, SessionBindingRecord]>> {
    const domain = await this.open();
    return [...domain.table('sessions').entries()];
  }

  /** 覆盖写一张预设卡(N20; 键 = 预设名)。 */
  async putPreset(preset: Omit<ContentPresetRecord, 'updatedAt'>): Promise<void> {
    const domain = await this.open();
    await domain
      .table('presets')
      .put(preset.name, { ...preset, updatedAt: new Date().toISOString() });
  }

  /** 删除一张预设卡(不存在 → false)。种子预设不在此表, 天然不可删。 */
  async deletePreset(name: string): Promise<boolean> {
    const domain = await this.open();
    return domain.table('presets').delete(name);
  }

  /** 全部已存预设卡(不含种子)。 */
  async listPresets(): Promise<ContentPresetRecord[]> {
    const domain = await this.open();
    return [...domain.table('presets').entries()].map(([, v]) => v);
  }

  /** 关闭 domain(宿主 effect disposer 调用; 幂等且并发调用共享同一 drain)。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.pending.clear();
    const opening = this.domainPromise;
    if (!this.domain && opening) {
      // Join an in-flight open. Its closed fence closes the eventual handle before rejecting.
      await opening.catch(() => undefined);
    }
    if (this.domain) {
      const domain = this.domain;
      this.domain = undefined;
      await domain.close();
    }
    this.domainPromise = undefined;
  }
}
