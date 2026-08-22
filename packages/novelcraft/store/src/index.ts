import path from 'node:path';
import { paths, slugFromFilename, assetKindFromPath } from './paths.js';
import { parseFrontmatter, normalizeAliases, normalizeAliasKey } from './frontmatter.js';
import { readText, listFilesRecursive, exists } from './fs.js';

// ============================================================================
// 索引重建(R12): 文件是唯一真相, 索引是纯派生, 任何时刻可全量重建且幂等。
// ============================================================================

export interface IndexedObject {
  slug: string;
  file: string;
  kind: string;
  name: string;
  status: string;
  aliases: string[];
}

export interface AliasEntry {
  alias: string;
  normalized: string;
  owner: string;
}

export interface RelationEntry {
  source: string;
  target: string;
  type: string;
  status: string;
  /** 源的资产 kind(ADR-0019 §4 跨类索引)。缺省 = 对象(兼容存量对象边)。 */
  sourceKind?: string;
}

export interface SceneEntry {
  slug: string;
  file: string;
  status: string;
  chapters: string[];
}

export interface ChapterEntry {
  index: number;
  file: string;
  status: string;
  title?: string;
}

export interface StructureEntry {
  kind: string;
  slug: string;
  file: string;
  status: string;
  name?: string;
}

export interface VaultIndex {
  version: 1;
  objects: IndexedObject[];
  aliases: AliasEntry[];
  relations: RelationEntry[];
  scenes: SceneEntry[];
  chapters: ChapterEntry[];
  structure: StructureEntry[];
}

function normalizeChapterIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((s) => s.length > 0);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 纯函数: 扫描全 vault 产索引 JSON(对象 slug→文件、别名→owner、关系有向对、Scene→章节覆盖)。 */
export function rebuildIndex(root: string): VaultIndex {
  const p = paths(root);

  const objects: IndexedObject[] = [];
  const rawAliases: AliasEntry[] = [];
  const relations: RelationEntry[] = [];
  const scenes: SceneEntry[] = [];
  const chapters: ChapterEntry[] = [];
  const structure: StructureEntry[] = [];

  const scan = (absDir: string, cb: (rel: string, abs: string) => void): void => {
    if (!exists(absDir)) return;
    for (const rel of listFilesRecursive(absDir)) cb(rel, path.join(absDir, rel));
  };

  /** 提取资产 frontmatter 的 relations 有向对(N11/N14), 补 source/sourceKind。 */
  const collectRelations = (
    data: Record<string, unknown>,
    slug: string,
    sourceKind?: string,
  ): void => {
    if (!Array.isArray(data.relations)) return;
    for (const r of data.relations) {
      if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        const target = typeof o.target === 'string' ? o.target : typeof o.target_ref === 'string' ? (o.target_ref as string) : undefined;
        if (typeof target === 'string' && target !== '') {
          relations.push({
            source: slug,
            target,
            type: String(o.type ?? o.relation_type ?? ''),
            status: String(o.status ?? 'canonical'),
            ...(sourceKind ? { sourceKind } : {}),
          });
        }
      }
    }
  };

  const addObject = (rel: string, abs: string): void => {
    const { data } = parseFrontmatter(readText(abs));
    const slug = slugFromFilename(rel);
    const aliases = normalizeAliases(data.aliases);
    objects.push({
      slug,
      file: rel,
      kind: String(data.kind ?? ''),
      name: String(data.name ?? ''),
      status: String(data.status ?? ''),
      aliases,
    });
    for (const a of aliases) rawAliases.push({ alias: a, normalized: normalizeAliasKey(a), owner: slug });
    collectRelations(data, slug);
  };

  scan(p.world.objects, (rel, abs) => {
    if (rel.endsWith('.md')) addObject(`world/objects/${rel}`, abs);
  });
  scan(p.world.pending, (rel, abs) => {
    if (rel.endsWith('.md')) addObject(`world/pending/${rel}`, abs);
  });

  scan(p.scenes.dir, (rel, abs) => {
    if (!rel.endsWith('.md')) return;
    const { data } = parseFrontmatter(readText(abs));
    const slug = slugFromFilename(rel);
    scenes.push({
      slug,
      file: `scenes/${rel}`,
      status: String(data.status ?? ''),
      chapters: normalizeChapterIds(data.chapter_ids),
    });
    collectRelations(data, slug, 'scene'); // ADR-0019 §4: Scene 关系边进跨类索引
  });

  scan(p.chapters.dir, (rel, abs) => {
    if (!rel.endsWith('.md')) return;
    if (rel.startsWith('pending/')) return;
    const m = /^(\d{3})\.md$/.exec(rel);
    if (!m) return;
    const { data } = parseFrontmatter(readText(abs));
    chapters.push({
      index: parseInt(m[1], 10),
      file: `chapters/${rel}`,
      status: String(data.status ?? ''),
      title: typeof data.title === 'string' ? data.title : undefined,
    });
  });

  scan(p.structure.dir, (rel, abs) => {
    if (!rel.endsWith('.md')) return;
    // 白名单: 仅 structure/outline.md 与 threads/arcs/foreshadowing/reveal 目录下 md。
    // 散落/未知 md(如 notes.md、outline-extra.md)一律跳过, 不整体抛错也不误判。
    const isOutline = rel === 'outline.md';
    const isKnownKindDir = ['threads/', 'arcs/', 'foreshadowing/', 'reveal/'].some((prefix) =>
      rel.startsWith(prefix),
    );
    if (!isOutline && !isKnownKindDir) return;
    const { data } = parseFrontmatter(readText(abs));
    const kind = assetKindFromPath(`structure/${rel}`);
    const slug = slugFromFilename(rel);
    structure.push({
      kind,
      slug,
      file: `structure/${rel}`,
      status: String(data.status ?? ''),
      name: typeof data.name === 'string' ? data.name : typeof data.title === 'string' ? data.title : undefined,
    });
    if (kind !== 'outline') {
      collectRelations(data, slug, kind); // ADR-0019 §4: 结构资产关系边进跨类索引
    }
  });

  // 确定性排序 + 别名去重(canonical owner 优先)。
  objects.sort((a, b) => cmpStr(a.slug, b.slug));

  const statusBySlug = new Map(objects.map((o) => [o.slug, o.status]));
  const aliasSeen = new Set<string>();
  const aliases: AliasEntry[] = [];
  rawAliases
    .slice()
    .sort((a, b) => {
      const pa = statusBySlug.get(a.owner) === 'canonical' ? 0 : 1;
      const pb = statusBySlug.get(b.owner) === 'canonical' ? 0 : 1;
      return pa !== pb ? pa - pb : cmpStr(a.owner, b.owner);
    })
    .forEach((e) => {
      if (!aliasSeen.has(e.normalized)) {
        aliasSeen.add(e.normalized);
        aliases.push(e);
      }
    });
  aliases.sort((a, b) => cmpStr(a.normalized, b.normalized) || cmpStr(a.owner, b.owner));

  relations.sort((a, b) => cmpStr(a.source, b.source) || cmpStr(a.sourceKind ?? '', b.sourceKind ?? '') || cmpStr(a.target, b.target) || cmpStr(a.type, b.type));
  scenes.sort((a, b) => cmpStr(a.slug, b.slug));
  chapters.sort((a, b) => a.index - b.index);
  structure.sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(a.slug, b.slug));

  return { version: 1, objects, aliases, relations, scenes, chapters, structure };
}

// ============================================================================
// 包入口(barrel)
// ============================================================================

export * from './types.js';
export * from './errors.js';
export * from './hash.js';
export * from './paths.js';
export * from './frontmatter.js';
export * from './relations.js';
export * from './git.js';
export * from './adopt.js';
export * from './merge.js';
export * from './dedup.js';
export * from './health.js';
export * from './story-map.js';
export * from './dossier.js';
export * from './tx-write.js';

// ADR-0021/N32 public transaction seam. Business and host integrations consume
// this barrel; lock/intent/Git plumbing remain implementation-private.
export * from './transaction/recovery.js';
export type {
  TransactionRequest,
  TransactionOptions,
  TransactionResult,
  TargetSpec,
  StatePlanSource,
  GatePhase,
  TxErrorCode,
} from './transaction/execute.js';
export { probeTxCommitForTargets, readCommittedFile } from './transaction/git-transaction.js';
export {
  GATE_PHASES,
  EMPTY_SHA,
  runTransactionProcess,
  recoverTransactionProcess,
} from './transaction/execute.js';
// per-vault 跨进程锁(§3): 供宿主/编排持锁(如锁测试 harness 的 lock-hold/attempt 模式)。
export { acquireVaultWriteLock, type VaultLock, type VaultWriteLockOptions } from './transaction/lock.js';
