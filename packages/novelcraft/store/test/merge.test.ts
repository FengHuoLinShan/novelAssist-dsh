import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  mergeEntities,
  splitMerge,
  attachAlias,
  readMergeLog,
  StoreError,
  gitLogSubjects,
} from '../src/index';
import { tmpVault, initRepo, commitAll, writeAsset, readFrontmatter } from './helpers';

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

function objectCount(r: string): number {
  const dir = path.join(r, 'world', 'objects');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

describe('merge/split(R6 可逆)', () => {
  it('merges a draft into canonical, then split restores it', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical', aliases: ['婉儿'] }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', name: '红衣女子', status: 'draft', aliases: ['红裙'] }, 'B');
    commitAll(r);

    const merged = mergeEntities(r, 'obj_b', 'obj_a');
    expect(merged.inheritedAliases).toEqual(['红裙']);
    expect(readFrontmatter(r, 'world/objects/obj_b.md').status).toBe('merged');
    expect(readFrontmatter(r, 'world/objects/obj_b.md').merged_into).toBe('obj_a');
    expect(readFrontmatter(r, 'world/objects/obj_a.md').aliases).toEqual(['婉儿', '红裙']);
    // source 文件仍在(不硬删, R6/R2)
    expect(fs.existsSync(path.join(r, 'world/objects/obj_b.md'))).toBe(true);

    const split = splitMerge(r, 'obj_b');
    expect(split.restoredStatus).toBe('draft');
    expect(readFrontmatter(r, 'world/objects/obj_b.md').status).toBe('draft');
    expect(readFrontmatter(r, 'world/objects/obj_a.md').aliases).toEqual(['婉儿']);
  });
});

describe('R36/R37 · 合并目标 canonical + 已采用二次确认', () => {
  it('rejects merging into a non-canonical target (R36)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'draft' }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', name: '红衣女子', status: 'draft' }, 'B');
    commitAll(r);
    expect(() => mergeEntities(r, 'obj_b', 'obj_a')).toThrowError(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    );
  });

  it('requires second confirmation to merge a canonical source (R37)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical' }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', name: '红衣女子', status: 'canonical' }, 'B');
    commitAll(r);
    expect(() => mergeEntities(r, 'obj_b', 'obj_a')).toThrowError(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }),
    );
    // 确认后执行
    const merged = mergeEntities(r, 'obj_b', 'obj_a', { approved: true });
    expect(readFrontmatter(r, 'world/objects/obj_b.md').status).toBe('merged');
  });

  it('rejects merging into itself (R26)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'draft' }, 'A');
    commitAll(r);
    expect(() => mergeEntities(r, 'obj_a', 'obj_a')).toThrowError(
      expect.objectContaining({ code: 'MERGE_SELF' }),
    );
  });

  it('rejects merging objects of different kinds (R6 同类型才可融合)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical' }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'location', name: '金陵', status: 'draft' }, 'B');
    commitAll(r);
    expect(() => mergeEntities(r, 'obj_b', 'obj_a')).toThrowError(
      expect.objectContaining({ code: 'MERGE_TYPE_MISMATCH' }),
    );
  });
});

describe('attach_alias(R1/R24/R25/R36)', () => {
  it('attaches alias to existing object without creating a new object (R1)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_suwan.md', { id: 'obj_suwan', kind: 'character', name: '苏婉', status: 'canonical' }, '苏婉');
    commitAll(r);
    const before = objectCount(r);
    const res = attachAlias(r, 'obj_suwan', '红衣女子');
    expect(res.count).toBe(1);
    expect(objectCount(r)).toBe(before); // 对象数不增(R1)
    expect(readFrontmatter(r, 'world/objects/obj_suwan.md').aliases).toContain('红衣女子');
  });

  it('rejects a duplicate alias after normalization (R24)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_suwan.md', { id: 'obj_suwan', kind: 'character', name: '苏婉', status: 'canonical', aliases: ['Zhou Mingrui'] }, '苏婉');
    commitAll(r);
    expect(() => attachAlias(r, 'obj_suwan', 'zhou mingrui')).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_ALIAS' }),
    );
  });

  it('rejects placeholder aliases (R25)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_suwan.md', { id: 'obj_suwan', kind: 'character', name: '苏婉', status: 'canonical' }, '苏婉');
    commitAll(r);
    expect(() => attachAlias(r, 'obj_suwan', '未知')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS' }),
    );
  });

  it('rejects alias on a non-canonical target (R36)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_suwan.md', { id: 'obj_suwan', kind: 'character', name: '苏婉', status: 'draft' }, '苏婉');
    commitAll(r);
    expect(() => attachAlias(r, 'obj_suwan', '红衣女子')).toThrowError(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    );
  });
});

describe('merge-log(.assistant/merge-log.jsonl)', () => {
  it('appends a reversible merge record (adjudication #5)', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical' }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', name: '红衣女子', status: 'draft' }, 'B');
    commitAll(r);
    mergeEntities(r, 'obj_b', 'obj_a', { workflow: 'import-deep' });
    const log = readMergeLog(r);
    expect(log.length).toBe(1);
    expect(log[0].operation).toBe('merge');
    expect(log[0].source).toBe('obj_b');
    expect(log[0].target).toBe('obj_a');
    expect(log[0].reversible).toBe(true);
    expect(log[0].workflow).toBe('import-deep');
  });
});

describe('N23 · merge/split/attach_alias 落盘前校验(fail-closed)', () => {
  it('merge 拒绝 schema 不合规源对象: VALIDATION_FAILED, 无写入、无 commit', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical' }, 'A');
    // 源对象缺必填 name(object schema), 其余门禁全过
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', status: 'draft' }, 'B');
    commitAll(r);
    const headBefore = gitLogSubjects(r).length;
    expect(() => mergeEntities(r, 'obj_b', 'obj_a')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }), // N23
    );
    // 无部分状态: 双文件均未改写、无 merge-log、无 commit
    expect(readFrontmatter(r, 'world/objects/obj_b.md').status).toBe('draft');
    expect(readFrontmatter(r, 'world/objects/obj_b.md').merged_into).toBeUndefined();
    expect(readFrontmatter(r, 'world/objects/obj_a.md').aliases).toBeUndefined();
    expect(readMergeLog(r).length).toBe(0);
    expect(gitLogSubjects(r).length).toBe(headBefore);
  });

  it('split 拒绝 schema 不合规已合并源: VALIDATION_FAILED, 不恢复、无 split 记录', () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_a.md', { id: 'obj_a', kind: 'character', name: '苏婉', status: 'canonical' }, 'A');
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', name: '红衣女子', status: 'draft', aliases: ['红裙'] }, 'B');
    commitAll(r);
    mergeEntities(r, 'obj_b', 'obj_a');
    // 手改合并源为 schema 不合规(缺必填 name)
    writeAsset(r, 'world/objects/obj_b.md', { id: 'obj_b', kind: 'character', status: 'merged', merged_into: 'obj_a' }, 'B');
    const logBefore = readMergeLog(r).length;
    expect(() => splitMerge(r, 'obj_b')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }), // N23
    );
    // 无部分状态: 未恢复 status、无 split 记录
    expect(readFrontmatter(r, 'world/objects/obj_b.md').status).toBe('merged');
    expect(readMergeLog(r).length).toBe(logBefore);
  });

  it('attach_alias 拒绝 schema 不合规目标: VALIDATION_FAILED, 别名未写入、无 commit', () => {
    const r = fixture();
    // canonical 但缺必填 name(object schema)
    writeAsset(r, 'world/objects/obj_x.md', { id: 'obj_x', kind: 'character', status: 'canonical' }, 'X');
    commitAll(r);
    const headBefore = gitLogSubjects(r).length;
    expect(() => attachAlias(r, 'obj_x', '红衣女子')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }), // N23
    );
    expect(readFrontmatter(r, 'world/objects/obj_x.md').aliases).toBeUndefined();
    expect(gitLogSubjects(r).length).toBe(headBefore);
  });
});
