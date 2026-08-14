import { describe, it, expect, afterEach } from 'vitest';
import { rebuildIndex, contentHash, slugFromFilename, resolveAsset } from '../src/index';
import { tmpVault, initRepo, commitAll, writeAsset } from './helpers';

const cleanups: Array<() => void> = [];
let root = '';

function fixture(): string {
  const { root: r, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(r);
  commitAll(r, 'init');
  root = r;
  return r;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scaffold(r: string): void {
  writeAsset(r, 'world/objects/obj_a.md', {
    id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical',
    aliases: ['婉儿'],
    relations: [{ target: 'obj_b', type: 'friend_of', status: 'canonical' }],
  }, 'A');
  writeAsset(r, 'world/objects/obj_b.md', {
    id: 'obj_b', kind: 'character', name: '红衣女子', status: 'canonical',
    aliases: ['红裙'],
  }, 'B');
  writeAsset(r, 'world/pending/pend_c.md', {
    id: 'pend_c', kind: 'location', name: '金陵', status: 'candidate',
    aliases: ['金陵城'],
  }, 'C');
  writeAsset(r, 'scenes/s012.md', {
    id: 's012', status: 'draft', scene_index: 12, narrative_tag: 'draft', source: 'deep_import',
    chapter_ids: [7, 8],
  }, 'scene');
  writeAsset(r, 'chapters/007.md', { chapter_index: 7, status: 'published', content_hash: contentHash('七') }, '七');
  writeAsset(r, 'chapters/008.md', { chapter_index: 8, status: 'published', content_hash: contentHash('八') }, '八');
  commitAll(r);
}

describe('rebuildIndex(R12 · 幂等可重建)', () => {
  it('is idempotent: two rebuilds are deep-equal', () => {
    const r = fixture();
    scaffold(r);
    const a = rebuildIndex(r);
    const b = rebuildIndex(r);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('derives alias → owner mapping', () => {
    const r = fixture();
    scaffold(r);
    const idx = rebuildIndex(r);
    const byNormalized = new Map(idx.aliases.map((e) => [e.normalized, e.owner]));
    expect(byNormalized.get('婉儿')).toBe('obj_a');
    expect(byNormalized.get('红裙')).toBe('obj_b');
    expect(byNormalized.get('金陵城')).toBe('pend_c');
  });

  it('derives directed relation pairs from object frontmatter', () => {
    const r = fixture();
    scaffold(r);
    const idx = rebuildIndex(r);
    expect(idx.relations).toContainEqual({ source: 'obj_a', target: 'obj_b', type: 'friend_of', status: 'canonical' });
  });

  it('derives Scene → chapter coverage', () => {
    const r = fixture();
    scaffold(r);
    const idx = rebuildIndex(r);
    const s012 = idx.scenes.find((s) => s.slug === 's012');
    expect(s012?.chapters).toEqual(['7', '8']);
    expect(idx.chapters.map((c) => c.index)).toEqual([7, 8]);
  });

  it('reflects manual file edits after rebuild (文件是唯一真相, R12)', () => {
    const r = fixture();
    scaffold(r);
    expect(rebuildIndex(r).aliases.map((a) => a.alias)).toContain('婉儿');
    writeAsset(r, 'world/objects/obj_a.md', {
      id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical',
      aliases: ['周明瑞'],
    }, 'A');
    const idx = rebuildIndex(r);
    expect(idx.aliases.map((a) => a.alias)).toContain('周明瑞');
    expect(idx.aliases.map((a) => a.alias)).not.toContain('婉儿');
  });
});

describe('N10 · slug 保留 CJK(中文 id 合法)', () => {
  it('slugFromFilename preserves CJK without ASCII assumptions', () => {
    expect(slugFromFilename('world/objects/克莱恩-莫雷蒂.md')).toBe('克莱恩-莫雷蒂');
    expect(slugFromFilename('world/objects/诡秘之主.md')).toBe('诡秘之主');
  });

  it('indexes and resolves a CJK-named object file', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/克莱恩-莫雷蒂.md', {
      id: '克莱恩-莫雷蒂', kind: 'character', name: '克莱恩·莫雷蒂', status: 'canonical',
      aliases: ['愚者'],
    }, '正文');
    commitAll(r);
    const idx = rebuildIndex(r);
    const obj = idx.objects.find((o) => o.slug === '克莱恩-莫雷蒂');
    expect(obj).toBeDefined();
    expect(obj?.name).toBe('克莱恩·莫雷蒂');
    expect(idx.aliases.find((a) => a.normalized === '愚者')?.owner).toBe('克莱恩-莫雷蒂');
    expect(resolveAsset(r, 'object', '克莱恩-莫雷蒂').slug).toBe('克莱恩-莫雷蒂');
  });
});

describe('N12 · 结构资产目录化索引', () => {
  it('indexes per-asset structure files under structure/<kind>/<slug>.md', () => {
    const r = fixture();
    writeAsset(r, 'structure/threads/t1.md', { id: 't1', status: 'draft', name: '主线', thread_type: 'main' }, '');
    writeAsset(r, 'structure/arcs/a1.md', { id: 'a1', status: 'canonical', title: '第一卷' }, '');
    writeAsset(r, 'structure/foreshadowing/f1.md', { id: 'f1', status: 'draft', name: '伏笔一' }, '');
    writeAsset(r, 'structure/reveal/r1.md', {
      id: 'r1', status: 'draft', target_type: 'character', target_id: 'obj_a', secret_summary: '秘密', related_thread_ids: [],
    }, '');
    writeAsset(r, 'structure/outline.md', { title: '总纲', creative_core: {}, outline_markdown: '# 总纲', major_storylines: [], macro_movements: [], open_decisions: [] }, '');
    commitAll(r);
    const idx = rebuildIndex(r);
    const bySlug = new Map(idx.structure.map((s) => [s.slug, s.kind]));
    expect(bySlug.get('t1')).toBe('thread');
    expect(bySlug.get('a1')).toBe('arc');
    expect(bySlug.get('f1')).toBe('foreshadowing');
    expect(bySlug.get('r1')).toBe('reveal');
    expect(bySlug.get('outline')).toBe('outline');
    // resolveAsset 用裸 slug 可解析结构资产(N12 读写)。
    expect(resolveAsset(r, 'thread', 't1').slug).toBe('t1');
    expect(resolveAsset(r, 'reveal', 'r1').slug).toBe('r1');
  });
});
