import fs from 'node:fs';
import path from 'node:path';
import {
  paths,
  guardPath,
  readAsset,
  writeAsset,
  slugify,
  initVault,
  assertSafePathSegment,
  assertNoSymlinkOnPath,
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
  assertSafePathSegment,
  assertNoSymlinkOnPath,
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
  if (p === 'structure/outline.md') return 'outline'; // structure/outline.md 单文件(N12), 精确匹配
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
 * 请求 kind 允许的实际资产 kind 集合(R9/N2): 目录上下文定义语义。
 * - object 允许 world/objects(object)或 world/pending(pending)——pending 是对象候选;
 * - pending 只允许 world/pending;
 * - 其余 kind 只允许各自唯一目录(不得跨目录借 kind)。
 */
const KIND_ALLOWED: Record<ResolvableKind, readonly AssetKind[]> = {
  object: ['object', 'pending'],
  pending: ['pending'],
  scene: ['scene'],
  chapter: ['chapter'],
  chapter_candidate: ['chapter_candidate'],
  bible_page: ['bible_page'],
  thread: ['thread'],
  arc: ['arc'],
  foreshadowing: ['foreshadowing'],
  reveal: ['reveal'],
};

/**
 * 核对实际资产 kind 与请求 kind 兼容; 不兼容抛 INVALID_ASSET_KIND(R9)。
 * 绝不把实际 kind 替换成另一 kind 继续(调用方拿到的 kind 恒为实际目录 kind)。
 */
function compatibleKind(kind: ResolvableKind, rel: string): AssetKind {
  const actual = assetKindFromPath(rel);
  if (!KIND_ALLOWED[kind].includes(actual)) {
    throw new StoreError(
      'INVALID_ASSET_KIND',
      `资产 kind 不兼容: 请求 ${kind}, 实际 ${actual} (${rel})`,
    );
  }
  return actual;
}

/**
 * 构建候选绝对路径/路径表, 统一失败语义为 StoreError(PATH_TRAVERSAL): vault 构造器
 * (assertSafePathSegment/guardPath/assertNoSymlinkOnPath/paths)的 plain Error 在
 * store 层转译, fail-closed。
 */
function buildCandidate<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    throw new StoreError(
      'PATH_TRAVERSAL',
      `资产候选路径非法: ${(err as Error).message}`,
      err instanceof Error ? err.message : undefined,
    );
  }
}

/**
 * 最终目标路径的 vault 内 symlink 检查(R9): resolveWithin(guardPath) 的 real
 * containment 会放行指向 vault 内其他目录/文件的 symlink(如 world/objects/x.md
 * → bible 文件, kind 边界破坏; chapters/007.md → .assistant/calibration.md,
 * 审批后写入会写穿), 因此按 paths 构造层同款逐段 lstat 拒绝任何 symlink 组件;
 * 统一为 StoreError(PATH_TRAVERSAL) 语义。读(显式路径解析)与写(adopt 落盘目标)
 * 共用同一 gate。
 */
export function assertNoInternalSymlink(root: string, abs: string): void {
  try {
    assertNoSymlinkOnPath(root, abs);
  } catch (err) {
    throw new StoreError(
      'PATH_TRAVERSAL',
      `资产路径含 symlink(fail-closed): ${(err as Error).message}`,
      err instanceof Error ? err.message : undefined,
    );
  }
}

/**
 * 按 kind 把 ref(裸 slug 或相对路径)解析为工作区内的资产文件。
 * ref 含 '/' 或以 .md 结尾时视为相对路径; 否则按 kind 目录查 slug。
 *
 * R9 fail-closed:
 * - 裸 slug 一律经 vault 安全构造器(单文件段 + guardPath + 逐段 symlink 检查);
 * - 显式相对路径在 resolveWithin 之后先拒绝 vault 内 symlink(含指向 vault 内
 *   别类文件的 symlink), 再与请求 kind 目录兼容(跨 kind → INVALID_ASSET_KIND);
 * - 返回前再次核对实际 kind(candidates 中误放的异 kind 文件不会带错 kind 继续)。
 */
export function resolveAsset(root: string, kind: ResolvableKind, ref: string): ResolvedAsset {
  // R9: paths(root) 对任一固定目录 symlink 整体 fail-closed, 但抛的是 vault 的
  // plain Error; 本模块统一契约是 StoreError(PATH_TRAVERSAL), 经 buildCandidate 转译。
  const p = buildCandidate(() => paths(root));
  const candidates: string[] = [];
  if (ref.includes('/') || ref.endsWith('.md')) {
    // 显式相对路径: resolveWithin(lexical + real 双重 containment) → vault 内
    // symlink 拒绝 → 与请求 kind 目录兼容核对。
    const abs = resolveWithin(root, ref);
    assertNoInternalSymlink(root, abs);
    const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
    compatibleKind(kind, rel);
    candidates.push(abs);
  } else {
    switch (kind) {
      case 'object':
        candidates.push(
          buildCandidate(() => p.world.objectFile(ref)),
          buildCandidate(() => p.world.pendingFile(ref)),
        );
        break;
      case 'pending':
        candidates.push(buildCandidate(() => p.world.pendingFile(ref)));
        break;
      case 'scene':
        candidates.push(buildCandidate(() => p.scenes.sceneFile(ref)));
        break;
      case 'chapter':
        // 裸 slug = 章节号(§22.2 NNN 三零填充): 先验证为正整数(与 chapterFile 的
        // assertChapterIndex 一致, 非数字 ref 一律 fail-closed), 再经 vault 构造器
        // (guardPath + 逐段 symlink 检查)——与显式路径分支同等拒绝内部/外部/悬空 symlink。
        if (!/^\d+$/.test(ref) || Number(ref) < 1) {
          throw new StoreError(
            'PATH_TRAVERSAL',
            `章节 ref 必须是正整数: ${JSON.stringify(ref)}`,
          );
        }
        candidates.push(buildCandidate(() => p.chapters.chapterFile(Number(ref))));
        break;
      case 'chapter_candidate':
        candidates.push(buildCandidate(() => p.chapters.pendingFile(ref)));
        break;
      case 'bible_page':
        candidates.push(buildCandidate(() => p.bible.bibleFile(ref)));
        break;
      case 'thread':
      case 'arc':
      case 'foreshadowing':
      case 'reveal':
        candidates.push(buildCandidate(() => structureFile(root, kind, ref)));
        break;
    }
  }
  for (const abs of candidates) {
    if (fs.existsSync(abs)) {
      const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
      const actual = compatibleKind(kind, rel); // 返回前最终核对(R9)。
      return { rel, abs, slug: slugFromFilename(rel), kind: actual };
    }
  }
  throw new StoreError('NOT_FOUND', `未找到资产文件: ${ref} (kind=${kind})`);
}
