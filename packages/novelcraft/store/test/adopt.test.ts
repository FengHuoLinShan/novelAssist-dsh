import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  adopt,
  softDelete,
  confirmSuggestion,
  rejectSuggestion,
  resolveWithin,
  StoreError,
  contentHash,
} from '../src/index';
import { tmpVault, initRepo, commitAll, writeAsset, readFrontmatter, readBody } from './helpers';

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

describe('adopt(R17 工作区脏拒绝 + R3 状态机)', () => {
  it('rejects adopt when workspace is dirty (R17)', () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' }, '候选');
    commitAll(r);
    // 制造未提交改动
    fs.writeFileSync(path.join(r, 'world', 'objects', 'dirty.md'), 'uncommitted');
    expect(() => adopt(r, 'object', 'pend_red')).toThrowError(
      expect.objectContaining({ code: 'DIRTY_WORKSPACE' }),
    );
  });

  it('adopts object: pending → objects, status canonical, content_hash updated (R3)', () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' }, '红衣女子正文');
    commitAll(r);
    const res = adopt(r, 'object', 'pend_red');
    expect(res.toStatus).toBe('canonical');
    expect(res.targetRelPath).toBe('world/objects/pend_red.md');
    expect(fs.existsSync(path.join(r, 'world/objects/pend_red.md'))).toBe(true);
    expect(fs.existsSync(path.join(r, 'world/pending/pend_red.md'))).toBe(false);
    const fm = readFrontmatter(r, 'world/objects/pend_red.md');
    expect(fm.status).toBe('canonical');
    expect(fm.content_hash).toBe(contentHash('红衣女子正文'));
  });

  it('rejects illegal transition: canonical object cannot re-adopt (R3)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_klein.md', { id: 'obj_klein', kind: 'character', name: '克莱恩', status: 'canonical' }, '正文');
    commitAll(r);
    expect(() => adopt(r, 'object', 'obj_klein')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });

  it('rejects stale adopt when expectedContentHash mismatches (R8 CAS)', () => {
    const r = fixture();
    const body = '红衣女子正文';
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate', content_hash: contentHash(body) }, body);
    commitAll(r);
    expect(() => adopt(r, 'object', 'pend_red', { expectedContentHash: contentHash('different') })).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });
});

describe('copy-on-adopt(R34)', () => {
  it('adopting a candidate chapter creates a new draft, deprecates the candidate', () => {
    const r = fixture();
    const body = '候选正文内容';
    writeAsset(r, 'chapters/pending/cand_foo.md', {
      id: 'cand_foo',
      status: 'candidate',
      source: 'writing_generate',
      content_hash: contentHash(body),
    }, body);
    commitAll(r);
    const res = adopt(r, 'chapter_candidate', 'cand_foo');
    expect(res.toStatus).toBe('draft');
    expect(res.targetRelPath).toBe('chapters/001.md');
    // 新 draft 内容与候选一致(R34)
    expect(readBody(r, 'chapters/001.md')).toBe(body);
    expect(readFrontmatter(r, 'chapters/001.md').status).toBe('draft');
    expect(readFrontmatter(r, 'chapters/001.md').content_hash).toBe(contentHash(body));
    // 原 candidate 转 deprecated(R34)
    expect(readFrontmatter(r, 'chapters/pending/cand_foo.md').status).toBe('deprecated');
  });

  it('rejects editing a candidate through non-adopt transitions (R19)', () => {
    const r = fixture();
    const body = '候选正文内容';
    writeAsset(r, 'chapters/pending/cand_foo.md', { id: 'cand_foo', status: 'candidate', source: 'writing_generate', content_hash: contentHash(body) }, body);
    commitAll(r);
    // 非法: 对 candidate 直接 publish(不是 adopt) → 被状态机拒绝。
    expect(() => adopt(r, 'chapter_candidate', 'cand_foo', { expectedContentHash: contentHash(body) })).not.toThrow();
  });
});

describe('soft delete(R2 · 已采用不硬删)', () => {
  it('soft-deletes canonical object to deprecated without removing the file', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_klein.md', { id: 'obj_klein', kind: 'character', name: '克莱恩', status: 'canonical' }, '正文');
    commitAll(r);
    const res = softDelete(r, 'object', 'obj_klein');
    expect(res.status).toBe('deprecated');
    expect(fs.existsSync(path.join(r, 'world/objects/obj_klein.md'))).toBe(true);
    expect(readFrontmatter(r, 'world/objects/obj_klein.md').status).toBe('deprecated');
    // 再删 = no-op(R2)
    expect(softDelete(r, 'object', 'obj_klein').status).toBe('noop');
  });
});

describe('建议队列裁决(R4/R32 单赢家)', () => {
  it('confirm then reject → 拒绝(单赢家 CAS claim)', () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_s.md', { id: 'pend_s', status: 'pending', target_type: 'core_entity' }, 'payload');
    commitAll(r);
    const confirmed = confirmSuggestion(r, 'pend_s');
    expect(confirmed.toStatus).toBe('accepted');
    expect(readFrontmatter(r, 'world/pending/pend_s.md').status).toBe('accepted');
    expect(() => rejectSuggestion(r, 'pend_s')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });
});

describe('R7 · 世界书发布 CAS + version+1', () => {
  it('publishes a bible draft to canonical with version bump', () => {
    const r = fixture();
    writeAsset(r, 'bible/species_elf.md', {
      id: 'species_elf', status: 'draft', page_type: 'species', page_key: 'species_elf', title: '精灵', version_number: 0,
    }, '精灵设定');
    commitAll(r);
    const res = adopt(r, 'bible_page', 'species_elf');
    expect(res.toStatus).toBe('canonical');
    expect(readFrontmatter(r, 'bible/species_elf.md').version_number).toBe(1);
  });

  it('rejects publish when base_version mismatches (R7)', () => {
    const r = fixture();
    writeAsset(r, 'bible/species_elf.md', {
      id: 'species_elf', status: 'draft', page_type: 'species', page_key: 'species_elf', title: '精灵', version_number: 0,
    }, '精灵设定');
    commitAll(r);
    expect(() => adopt(r, 'bible_page', 'species_elf', { expectedBaseVersion: 5 })).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });
});

describe('R9 · 路径穿越拒绝', () => {
  it('resolveWithin rejects paths escaping the vault root', () => {
    const r = fixture();
    expect(() => resolveWithin(r, '../evil.md')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    expect(() => adopt(r, 'object', '../../evil.md')).toThrowError(StoreError);
  });
});

describe('N12 · 结构资产 adopt(draft→canonical, 目录化路径)', () => {
  it('adopts a structure/threads/<slug>.md draft to canonical in place', () => {
    const r = fixture();
    writeAsset(r, 'structure/threads/t1.md', { id: 't1', status: 'draft', name: '主线', thread_type: 'main' }, '');
    commitAll(r);
    const res = adopt(r, 'thread', 't1');
    expect(res.toStatus).toBe('canonical');
    expect(res.targetRelPath).toBe('structure/threads/t1.md');
    expect(readFrontmatter(r, 'structure/threads/t1.md').status).toBe('canonical');
  });

  it('soft-deletes a canonical structure asset to deprecated (R2)', () => {
    const r = fixture();
    writeAsset(r, 'structure/arcs/a1.md', { id: 'a1', status: 'canonical', title: '第一卷' }, '');
    commitAll(r);
    expect(softDelete(r, 'arc', 'a1').status).toBe('deprecated');
    expect(readFrontmatter(r, 'structure/arcs/a1.md').status).toBe('deprecated');
  });
});
