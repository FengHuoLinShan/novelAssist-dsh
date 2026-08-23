// N35 / ADR-0024 — misuse-resistant NovelCraftService capability surface.
import type { NovelCraftService } from './service.js';

type MethodName = {
  [K in keyof NovelCraftService]: NovelCraftService[K] extends (...args: never[]) => unknown ? K : never
}[keyof NovelCraftService];
type Bound<K extends MethodName> = NovelCraftService[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;

export interface NovelCraftReadCapabilities {
  viewMapAtlas: Bound<'viewMapAtlas'>;
  inbox: Bound<'inbox'>;
  ragSearch: Bound<'ragSearch'>;
  chapterCurrent: Bound<'chapterCurrent'>;
  chapterHistory: Bound<'chapterHistory'>;
  chapterDiff: Bound<'chapterDiff'>;
  chapterReview: Bound<'chapterReview'>;
}

export interface NovelCraftAuthorEditCapabilities {
  /** ADR-0020 exception: fixed annotations field + queue provenance + content-hash CAS; no ApprovalGate. */
  annotations: Bound<'applyAtlasAnnotationQueue'>;
}

export interface NovelCraftProposeCapabilities {
  runStep: Bound<'runStep'>;
  planMapAtlas: Bound<'planMapAtlas'>;
  importAtlasImage: Bound<'importAtlasImage'>;
  updateAtlasPrompt: Bound<'updateAtlasPrompt'>;
  createAtlasUploadNode: Bound<'createAtlasUploadNode'>;
  proposeNextChapter: Bound<'proposeNextChapter'>;
  generateNextChapter: Bound<'generateNextChapter'>;
  ingestTextFile: Bound<'ingestTextFile'>;
  reviewChapter: Bound<'reviewChapter'>;
  reviseChapter: Bound<'reviseChapter'>;
  rejectChapterFinding: Bound<'rejectChapterFinding'>;
  scanHealth: Bound<'scanHealth'>;
  radarSweep: Bound<'radarSweep'>;
  refreshIndex: Bound<'refreshIndex'>;
  ragSync: Bound<'ragSync'>;
  ragEmbed: Bound<'ragEmbed'>;
  authorEdit: NovelCraftAuthorEditCapabilities;
}

export interface NovelCraftAdoptGuardedCapabilities {
  storeAdopt: Bound<'adoptGuarded'>;
  worldCreate: Bound<'worldCreateGuarded'>;
  worldUpdate: Bound<'worldUpdateGuarded'>;
  reviewMapAtlas: Bound<'reviewMapAtlasGuarded'>;
  deepImport: Bound<'deepImport'>;
  saveChapter: Bound<'saveChapterGuarded'>;
  restoreChapter: Bound<'restoreChapterGuarded'>;
}

export interface NovelCraftCapabilities {
  read: NovelCraftReadCapabilities;
  propose: NovelCraftProposeCapabilities;
  adoptGuarded: NovelCraftAdoptGuardedCapabilities;
}

function bind<K extends MethodName>(service: NovelCraftService, key: K): Bound<K> {
  const method = service[key];
  if (typeof method !== 'function') throw new Error(`NovelCraft capability method unavailable: ${String(key)}`);
  return method.bind(service) as Bound<K>;
}

/** Build once in the service constructor; frozen namespaces prevent runtime replacement/route confusion. */
export function createNovelCraftCapabilities(service: NovelCraftService): NovelCraftCapabilities {
  const authorEdit = Object.freeze({ annotations: bind(service, 'applyAtlasAnnotationQueue') });
  const capabilities: NovelCraftCapabilities = {
    read: Object.freeze({
      viewMapAtlas: bind(service, 'viewMapAtlas'),
      inbox: bind(service, 'inbox'),
      ragSearch: bind(service, 'ragSearch'),
      chapterCurrent: bind(service, 'chapterCurrent'),
      chapterHistory: bind(service, 'chapterHistory'),
      chapterDiff: bind(service, 'chapterDiff'),
      chapterReview: bind(service, 'chapterReview'),
    }),
    propose: Object.freeze({
      runStep: bind(service, 'runStep'),
      planMapAtlas: bind(service, 'planMapAtlas'),
      importAtlasImage: bind(service, 'importAtlasImage'),
      updateAtlasPrompt: bind(service, 'updateAtlasPrompt'),
      createAtlasUploadNode: bind(service, 'createAtlasUploadNode'),
      proposeNextChapter: bind(service, 'proposeNextChapter'),
      generateNextChapter: bind(service, 'generateNextChapter'),
      ingestTextFile: bind(service, 'ingestTextFile'),
      reviewChapter: bind(service, 'reviewChapter'),
      reviseChapter: bind(service, 'reviseChapter'),
      rejectChapterFinding: bind(service, 'rejectChapterFinding'),
      scanHealth: bind(service, 'scanHealth'),
      radarSweep: bind(service, 'radarSweep'),
      refreshIndex: bind(service, 'refreshIndex'),
      ragSync: bind(service, 'ragSync'),
      ragEmbed: bind(service, 'ragEmbed'),
      authorEdit,
    }),
    adoptGuarded: Object.freeze({
      storeAdopt: bind(service, 'adoptGuarded'),
      worldCreate: bind(service, 'worldCreateGuarded'),
      worldUpdate: bind(service, 'worldUpdateGuarded'),
      reviewMapAtlas: bind(service, 'reviewMapAtlasGuarded'),
      deepImport: bind(service, 'deepImport'),
      saveChapter: bind(service, 'saveChapterGuarded'),
      restoreChapter: bind(service, 'restoreChapterGuarded'),
    }),
  };
  return Object.freeze(capabilities);
}
