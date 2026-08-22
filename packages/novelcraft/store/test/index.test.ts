import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { rebuildIndex, contentHash, slugFromFilename, resolveAsset, assetKindFromPath } from '../src/index';
import { tmpVault, initRepo, commitAll, writeAsset } from './helpers';

const cleanups: Array<() => void> = [];
let root = '';

// 文件 symlink 探测(Windows 需开发者模式/管理员; 失败则整组跳过)。
const fileSymlinksSupported = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-store-linkprobe-'));
  try {
    fs.writeFileSync(path.join(base, 't.txt'), 'x');
    fs.symlinkSync(path.join(base, 't.txt'), path.join(base, 'l.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

// 目录 symlink 探测(Windows 无特权进程用 junction 亦可; 仍失败则整组跳过)。
const dirSymlinksSupported = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-store-dirlinkprobe-'));
  try {
    fs.symlinkSync(base, path.join(base, 'l'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

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

  it('对象边不写 sourceKind, 缺省即对象(存量兼容)', () => {
    const r = fixture();
    scaffold(r);
    const idx = rebuildIndex(r);
    const edge = idx.relations.find((x) => x.source === 'obj_a');
    expect(edge?.sourceKind).toBeUndefined();
  });

  it('结构资产与 Scene 的 relations 边进跨类索引并带 sourceKind(ADR-0019 §4/N14)', () => {
    const r = fixture();
    scaffold(r);
    writeAsset(r, 'structure/reveal/身世.md', {
      id: '身世', status: 'canonical', name: '身世',
      target_type: 'character', target_id: 'obj_a', secret_summary: '孤儿',
      related_thread_ids: [],
      relations: [{ target: '怀表', type: 'reveals_foreshadowing' }],
    }, '身世');
    writeAsset(r, 'structure/foreshadowing/怀表.md', {
      id: '怀表', status: 'canonical', name: '怀表',
      relations: [{ target: 's012', type: 'pays_off_in_scene' }],
    }, '怀表');
    writeAsset(r, 'scenes/s012.md', {
      id: 's012', status: 'draft', scene_index: 12, narrative_tag: 'draft', source: 'manual',
      chapter_ids: [7],
      relations: [{ target: '主线', type: 'serves_thread' }],
    }, 'scene');
    const idx = rebuildIndex(r);
    expect(idx.relations).toContainEqual({
      source: '身世', target: '怀表', type: 'reveals_foreshadowing', status: 'canonical', sourceKind: 'reveal',
    });
    expect(idx.relations).toContainEqual({
      source: '怀表', target: 's012', type: 'pays_off_in_scene', status: 'canonical', sourceKind: 'foreshadowing',
    });
    expect(idx.relations).toContainEqual({
      source: 's012', target: '主线', type: 'serves_thread', status: 'canonical', sourceKind: 'scene',
    });
  });

  it('跨类索引幂等: 两次 rebuild 边集合一致(纯派生, R12)', () => {
    const r = fixture();
    scaffold(r);
    writeAsset(r, 'structure/reveal/身世.md', {
      id: '身世', status: 'canonical', name: '身世',
      target_type: 'character', target_id: 'obj_a', secret_summary: '孤儿',
      related_thread_ids: [],
      relations: [{ target: '怀表', type: 'reveals_foreshadowing' }],
    }, '身世');
    const a = rebuildIndex(r).relations;
    const b = rebuildIndex(r).relations;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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

  it('结构目录扫描白名单: 散落 md / outline-extra.md 跳过, 不整体抛错也不误判 outline', () => {
    const r = fixture();
    writeAsset(r, 'structure/outline.md', { title: '总纲', creative_core: {}, outline_markdown: '# 总纲', major_storylines: [], macro_movements: [], open_decisions: [] }, '');
    writeAsset(r, 'structure/threads/t1.md', { id: 't1', status: 'draft', name: '主线', thread_type: 'main' }, '');
    // 散落/未知 md(旧行为: rebuildIndex 整体抛 INVALID_ASSET_KIND; outline-extra 被误判 outline)。
    writeAsset(r, 'structure/notes.md', { title: '杂记' }, '');
    writeAsset(r, 'structure/outline-extra.md', { title: '附录' }, '');
    writeAsset(r, 'structure/theme.md', { title: '主题' }, '');
    commitAll(r);
    const idx = rebuildIndex(r); // 不再抛错。
    const bySlug = new Map(idx.structure.map((s) => [s.slug, s.kind]));
    expect(bySlug.get('outline')).toBe('outline');
    expect(bySlug.get('t1')).toBe('thread');
    expect(bySlug.has('notes')).toBe(false);
    expect(bySlug.has('outline-extra')).toBe(false);
    expect(bySlug.has('theme')).toBe(false);
    expect(idx.structure).toHaveLength(2);
    // assetKindFromPath 对 outline 仅精确匹配 structure/outline.md。
    expect(assetKindFromPath('structure/outline.md')).toBe('outline');
    expect(() => assetKindFromPath('structure/outline-extra.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
  });
});

describe('resolveAsset kind 兼容(explicit ref 不得跨目录借 kind, R9)', () => {
  it('object 允许 world/objects 或 world/pending, 返回实际目录 kind', () => {
    const r = fixture();
    scaffold(r);
    expect(resolveAsset(r, 'object', 'world/objects/obj_a.md').kind).toBe('object');
    expect(resolveAsset(r, 'object', 'world/pending/pend_c.md').kind).toBe('pending');
  });

  it('scene/explicit → 指向 world/pending 等异 kind: INVALID_ASSET_KIND, 不得带错 kind 继续', () => {
    const r = fixture();
    scaffold(r);
    expect(() => resolveAsset(r, 'scene', 'world/pending/pend_c.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
    expect(() => resolveAsset(r, 'scene', 'world/objects/obj_a.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
    expect(() => resolveAsset(r, 'chapter', 'world/objects/obj_a.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
  });

  it('pending 只允许 world/pending; object 请求指向 scenes 拒绝', () => {
    const r = fixture();
    scaffold(r);
    expect(resolveAsset(r, 'pending', 'world/pending/pend_c.md').kind).toBe('pending');
    expect(() => resolveAsset(r, 'pending', 'world/objects/obj_a.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
    expect(() => resolveAsset(r, 'object', 'scenes/s012.md')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_KIND' }),
    );
  });

  it('裸 slug 经安全构造器: ../ 与反斜杠路径段 → PATH_TRAVERSAL(fail-closed)', () => {
    const r = fixture();
    scaffold(r);
    expect(() => resolveAsset(r, 'object', '../evil')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    expect(() => resolveAsset(r, 'scene', 'a\\b')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    expect(() => resolveAsset(r, 'object', '..')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
  });
});

describe('resolveAsset 显式路径 vault 内 symlink 拒绝(R9, 绕过构造器也要封)', () => {
  it.skipIf(!fileSymlinksSupported)(
    'explicit object path 是内部 symlink→bible 文件: PATH_TRAVERSAL 拒绝(fail-closed)',
    () => {
      const r = fixture();
      scaffold(r);
      // 真实 bible 资产 + world/objects/obj_link.md → bible/secret.md(vault 内 symlink)。
      writeAsset(r, 'bible/secret.md', { id: 'secret', page_key: 'secret', version_number: 0, status: 'draft' }, '');
      const link = path.join(r, 'world', 'objects', 'obj_link.md');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(r, 'bible', 'secret.md'), link);
      // guardPath(real containment)会放行 vault 内 symlink; 显式分支必须额外
      // 逐段 lstat 拒绝——否则 object 解析会命中 bible 资产。
      expect(() => resolveAsset(r, 'object', 'world/objects/obj_link.md')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(() => resolveAsset(r, 'object', 'obj_link')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );

  it.skipIf(!fileSymlinksSupported)('explicit 普通文件路径(无 symlink)仍正常解析', () => {
    const r = fixture();
    scaffold(r);
    expect(resolveAsset(r, 'object', 'world/objects/obj_a.md').slug).toBe('obj_a');
  });
});

describe('resolveAsset 裸 slug chapter/chapter_candidate symlink 拒绝(R9, 与显式分支/构造器同 gate)', () => {
  it('裸 slug chapter 正常解析: 章节号 → chapters/{NNN}.md(NNN 三零填充)', () => {
    const r = fixture();
    scaffold(r);
    const res = resolveAsset(r, 'chapter', '007');
    expect(res.rel).toBe('chapters/007.md');
    expect(res.slug).toBe('007');
    expect(res.kind).toBe('chapter');
  });

  it('裸 slug chapter 非数字 ref → PATH_TRAVERSAL(fail-closed, 章节号必须正整数)', () => {
    const r = fixture();
    scaffold(r);
    expect(() => resolveAsset(r, 'chapter', 'abc')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    expect(() => resolveAsset(r, 'chapter', '0')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    expect(() => resolveAsset(r, 'chapter', '')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
  });

  it('裸 slug chapter_candidate 正常解析(任意 slug: cand_foo 与数字 003)', () => {
    const r = fixture();
    scaffold(r);
    writeAsset(r, 'chapters/pending/cand_foo.md', {
      id: 'cand_foo', chapter_index: 3, status: 'candidate', source: 'writing_generate', content_hash: 'h',
    }, '候选');
    writeAsset(r, 'chapters/pending/003.md', {
      id: '003', chapter_index: 3, status: 'candidate', source: 'writing_generate', content_hash: 'h',
    }, '候选');
    expect(resolveAsset(r, 'chapter_candidate', 'cand_foo').rel).toBe('chapters/pending/cand_foo.md');
    expect(resolveAsset(r, 'chapter_candidate', '003').rel).toBe('chapters/pending/003.md');
  });

  it.skipIf(!fileSymlinksSupported)(
    '裸 slug chapter 内部 symlink(007→008): PATH_TRAVERSAL 拒绝, 不跟随',
    () => {
      const r = fixture();
      scaffold(r); // chapters/007.md、008.md 真实文件。
      const link = path.join(r, 'chapters', '007.md');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(r, 'chapters', '008.md'), link); // vault 内 symlink。
      // guardPath(real containment)会放行 root 内 symlink; 裸 slug 分支走
      // chapterFile(逐段 lstat)必须拒绝——否则 007 会解析/改写第 8 章。
      expect(() => resolveAsset(r, 'chapter', '007')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '裸 slug chapter_candidate 内部 symlink(pending/003→chapters/007): PATH_TRAVERSAL 拒绝(复现场景)',
    () => {
      const r = fixture();
      scaffold(r);
      // 复现: 已提交 chapters/pending/003.md symlink → chapters/007.md。
      const link = path.join(r, 'chapters', 'pending', '003.md');
      fs.symlinkSync(path.join(r, 'chapters', '007.md'), link);
      expect(() => resolveAsset(r, 'chapter_candidate', '003')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '裸 slug chapter 外部 symlink → PATH_TRAVERSAL(fail-closed)',
    () => {
      const r = fixture();
      scaffold(r);
      const outside = path.join(os.tmpdir(), `nvc-out-ch-${Date.now()}.md`);
      fs.writeFileSync(outside, '外部哨兵');
      try {
        const link = path.join(r, 'chapters', '007.md');
        fs.rmSync(link, { force: true });
        fs.symlinkSync(outside, link);
        expect(() => resolveAsset(r, 'chapter', '007')).toThrowError(
          expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
        );
      } finally {
        fs.rmSync(outside, { force: true });
      }
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '裸 slug chapter_candidate 悬空 symlink → PATH_TRAVERSAL(不跟随创建)',
    () => {
      const r = fixture();
      scaffold(r);
      const link = path.join(r, 'chapters', 'pending', 'dangling.md');
      fs.symlinkSync(path.join(r, 'chapters', 'does-not-exist.md'), link); // dangling。
      expect(() => resolveAsset(r, 'chapter_candidate', 'dangling')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );
});

describe('resolveAsset 入口 paths(root) 固定目录 symlink 转译(R9: vault plain Error → StoreError PATH_TRAVERSAL)', () => {
  it.skipIf(!dirSymlinksSupported)(
    '固定目录 symlink 出 vault: 任意 kind resolveAsset 抛 PATH_TRAVERSAL(StoreError, 非 plain Error)',
    () => {
      const r = fixture();
      scaffold(r);
      // chapters 整目录替换为指向外部的 symlink。
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-out-dir-'));
      cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
      fs.rmSync(path.join(r, 'chapters'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(r, 'chapters'), process.platform === 'win32' ? 'junction' : 'dir');
      // 修复前: paths(root) 抛 vault 的 plain Error(与模块统一契约不符)。
      expect(() => resolveAsset(r, 'object', 'obj_a')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(() => resolveAsset(r, 'chapter', '007')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(() => resolveAsset(r, 'object', 'world/objects/obj_a.md')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );

  it.skipIf(!dirSymlinksSupported)(
    '固定目录内部 symlink(kind 边界): 同样 PATH_TRAVERSAL',
    () => {
      const r = fixture();
      scaffold(r);
      // world/objects 整目录替换为指向 bible 的 symlink(vault 内, guardPath real
      // containment 放行; paths() 构造层逐段 lstat 必须拒绝)。
      const objectsDir = path.join(r, 'world', 'objects');
      fs.rmSync(objectsDir, { recursive: true, force: true });
      fs.symlinkSync(path.join(r, 'bible'), objectsDir, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveAsset(r, 'object', 'obj_a')).toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
    },
  );
});
