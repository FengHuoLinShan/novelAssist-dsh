// N35 / ADR-0024 service capability boundary; annotations remain ADR-0020 author-edit exception.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as publicApi from '../src/index.js';
import { createNovelCraftCapabilities, NovelCraftService } from '../src/index.js';

function fakeService(): NovelCraftService {
  const service: Record<string, unknown> = { marker: 'bound' };
  const methods = [
    'viewMapAtlas', 'inbox', 'ragSearch', 'chapterCurrent', 'chapterHistory', 'chapterDiff', 'chapterReview', 'receiptLimit',
    'runStep', 'actOnSignal', 'planMapAtlas', 'importAtlasImage', 'updateAtlasPrompt',
    'createAtlasUploadNode', 'proposeNextChapter', 'generateNextChapter', 'ingestTextFile',
    'reviewChapter', 'reviseChapter', 'rejectChapterFinding', 'rejectChapterCandidate', 'scanHealth',
    'radarSweep', 'refreshIndex', 'ragSync', 'ragEmbed', 'applyAtlasAnnotationQueue', 'adoptGuarded',
    'worldCreateGuarded', 'worldUpdateGuarded', 'reviewMapAtlasGuarded', 'deepImport',
    'saveChapterGuarded', 'restoreChapterGuarded',
    'workflowInspect', 'workflowResumeGuarded', 'workflowStartNewGuarded', 'workflowAbandonGuarded',
    'bookList', 'bookCreateGuarded', 'bookOpenGuarded',
  ];
  for (const name of methods) service[name] = vi.fn(function (this: Record<string, unknown>) { return this.marker; });
  // Existing raw direct annotation and raw facade members intentionally exist on service but must not be routed.
  service.applyAtlasAnnotations = vi.fn();
  service.facades = { store: { adopt: vi.fn() } };
  return service as unknown as NovelCraftService;
}

describe('createNovelCraftCapabilities', () => {
  it('public package root 不导出 raw tool registrar/deep-import adapter', () => {
    expect('registerNovelcraftTools' in publicApi).toBe(false);
    expect('ImportTraceSink' in publicApi).toBe(false);
    expect('importTraceFile' in publicApi).toBe(false);
  });

  it('严格三分 read/propose/adoptGuarded，命名空间深冻结且方法绑定 service', () => {
    const service = fakeService();
    const capabilities = createNovelCraftCapabilities(service);
    expect(Object.keys(capabilities).sort()).toEqual(['adoptGuarded', 'propose', 'read']);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.read)).toBe(true);
    expect(Object.isFrozen(capabilities.propose)).toBe(true);
    expect(Object.isFrozen(capabilities.propose.authorEdit)).toBe(true);
    expect(Object.isFrozen(capabilities.adoptGuarded)).toBe(true);
    expect(capabilities.read.inbox('root')).toBe('bound');
  });

  it('raw adopt/merge/direct page writer 不进入 capability', () => {
    const capabilities = createNovelCraftCapabilities(fakeService());
    expect('facades' in capabilities).toBe(false);
    expect('adopt' in capabilities.propose).toBe(false);
    expect('applyAtlasAnnotations' in capabilities.propose.authorEdit).toBe(false);
    expect('annotations' in capabilities.propose.authorEdit).toBe(true);
  });

  it('真实 NovelCraftService 不再暴露 raw applyAtlasAnnotations; 唯一作者编辑入口是队列(CAS 必填)', () => {
    expect('applyAtlasAnnotations' in NovelCraftService.prototype).toBe(false);
    expect('applyAtlasAnnotationQueue' in NovelCraftService.prototype).toBe(true);
    expect('facades' in NovelCraftService.prototype).toBe(false);
  });

  it('生产 tools 只经 capability namespaces 调用 domain 方法(N35)', () => {
    const toolsDir = new URL('../src/tools/', import.meta.url);
    const source = [
      readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8'),
      ...readdirSync(toolsDir)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(new URL(file, toolsDir), 'utf8')),
    ].join('\n');
    const direct = [...source.matchAll(/service\.(?!js\b|capabilities\.|vaults\.)[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
    expect(direct).toEqual([]);
  });

  it('annotation 是 propose.authorEdit 下唯一不审批 canonical 字段例外；adopt/status 留在 guarded', () => {
    const capabilities = createNovelCraftCapabilities(fakeService());
    expect(Object.keys(capabilities.propose.authorEdit)).toEqual(['annotations']);
    expect(Object.keys(capabilities.adoptGuarded).sort()).toEqual([
      'bookCreate', 'bookOpen', 'deepImport', 'restoreChapter', 'reviewMapAtlas', 'saveChapter', 'storeAdopt',
      'workflowAbandon', 'workflowResume', 'workflowStartNew', 'worldCreate', 'worldUpdate',
    ]);
  });
});
