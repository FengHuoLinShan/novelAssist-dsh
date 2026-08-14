import fs from 'node:fs';
import path from 'node:path';
import {
  paths,
  guardPath,
  readAsset,
  writeAsset,
  slugify,
  initVault,
  BOOK_FILENAME,
  TARGET_LENGTHS,
  CURRENT_STAGES,
} from '@novelcraft/vault';
import { StoreError } from './errors.js';
import type { AssetKind } from './types.js';

// 直接依赖 workspace 包 @novelcraft/vault(工程约定: 插件之间只经 seam 互连, 但
// vault/store 同为 R1 内核, store 复用 vault 的路径规范与读写门禁)。
export {
  paths,
  guardPath,
  readAsset,
  writeAsset,
  slugify,
  initVault,
  BOOK_FILENAME,
  TARGET_LENGTHS,
  CURRENT_STAGES,
};
export type {
  BookMeta,
  RevealPolicy,
  TargetLength,
  CurrentStage,
} from '@novelcraft/vault';

/** vault 的路径表类型(R1 无 DSH seam, 直接透传)。 */
export type VaultPaths = ReturnType<typeof paths>;

/** 同 vault.guardPath, 但以 StoreError(PATH_TRAVERSAL)表达拒绝(R9/R31)。 */
export function resolveWithin(root: string, relPath: string): string {
  try {
    return guardPath(root, relPath);
  } catch (err) {
    throw new StoreError(
      'PATH_TRAVERSAL',
      `路径逃逸出工作区根: ${relPath}`,
      err instanceof Error ? err.message : undefined,
    );
  }
}

/** id = 文件名 slug(N2): 去掉扩展名的 basename。 */
export function slugFromFilename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

/** 由相对路径推断资产 kind(目录上下文给出, N2)。 */
export function assetKindFromPath(relPath: string): AssetKind {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'book.yml') return 'book';
  if (p.startsWith('world/objects/')) return 'object';
  if (p.startsWith('world/pending/')) return 'pending';
  if (p.startsWith('scenes/')) return 'scene';
  if (p.startsWith('chapters/pending/')) return 'chapter_candidate';
  if (p.startsWith('chapters/')) return 'chapter';
  if (p.startsWith('bible/')) return 'bible_page';
  if (p.startsWith('structure/outline')) return 'outline'; // structure/outline.md 单文件(N12)
  if (p.startsWith('structure/threads/')) return 'thread'; // N12 目录化
  if (p.startsWith('structure/arcs/')) return 'arc';
  if (p.startsWith('structure/foreshadowing/')) return 'foreshadowing';
  if (p.startsWith('structure/reveal/')) return 'reveal';
  if (p.startsWith('imports/')) return 'imported_chapter';
  throw new StoreError('INVALID_ASSET_KIND', `无法从路径推断资产 kind: ${relPath}`);
}

export type StructureKind = 'thread' | 'arc' | 'foreshadowing' | 'reveal';

/** 结构资产文件绝对路径; 直接经 vault 的 N12 目录化文件构造器(N12)。 */
export function structureFile(root: string, kind: StructureKind, slug: string): string {
  const s = paths(root).structure;
  switch (kind) {
    case 'thread':
      return s.threadFile(slug);
    case 'arc':
      return s.arcFile(slug);
    case 'foreshadowing':
      return s.foreshadowingFile(slug);
    case 'reveal':
      return s.revealFile(slug);
  }
}

export type ResolvableKind =
  | 'object'
  | 'pending'
  | 'scene'
  | 'chapter'
  | 'chapter_candidate'
  | 'bible_page'
  | 'thread'
  | 'arc'
  | 'foreshadowing'
  | 'reveal';

export interface ResolvedAsset {
  rel: string;
  abs: string;
  slug: string;
  kind: AssetKind;
}

/**
 * 按 kind 把 ref(裸 slug 或相对路径)解析为工作区内的资产文件。
 * ref 含 '/' 或以 .md 结尾时视为相对路径; 否则按 kind 目录查 slug。
 */
export function resolveAsset(root: string, kind: ResolvableKind, ref: string): ResolvedAsset {
  const p = paths(root);
  const candidates: string[] = [];
  if (ref.includes('/') || ref.endsWith('.md')) {
    candidates.push(resolveWithin(root, ref));
  } else {
    switch (kind) {
      case 'object':
        candidates.push(p.world.objectFile(ref), p.world.pendingFile(ref));
        break;
      case 'pending':
        candidates.push(p.world.pendingFile(ref));
        break;
      case 'scene':
        candidates.push(p.scenes.sceneFile(ref));
        break;
      case 'chapter':
        candidates.push(resolveWithin(root, `chapters/${ref}.md`));
        break;
      case 'chapter_candidate':
        candidates.push(resolveWithin(root, `chapters/pending/${ref}.md`));
        break;
      case 'bible_page':
        candidates.push(p.bible.bibleFile(ref));
        break;
      case 'thread':
      case 'arc':
      case 'foreshadowing':
      case 'reveal':
        candidates.push(structureFile(root, kind, ref));
        break;
    }
  }
  for (const abs of candidates) {
    if (fs.existsSync(abs)) {
      const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
      return { rel, abs, slug: slugFromFilename(rel), kind: assetKindFromPath(rel) };
    }
  }
  throw new StoreError('NOT_FOUND', `未找到资产文件: ${ref} (kind=${kind})`);
}
