import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initVault } from '@novelcraft/vault';
import {
  contentHash,
  diffChapterVersions,
  gitAdd,
  gitCommit,
  listChapterHistory,
  readCurrentChapter,
  serializeFrontmatter,
  StoreError,
} from '../src/index.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'nc-chapter-version-'));
  roots.push(value);
  initVault(value, { title: '版本测试', language: 'zh' });
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function commitChapter(vault: string, body: string, subject: string): string {
  const rel = 'chapters/001.md';
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, serializeFrontmatter({
    chapter_index: 1,
    title: '第一章',
    status: 'draft',
    content_hash: contentHash(body),
  }, body));
  gitAdd(vault, [rel]);
  return gitCommit(vault, subject);
}

describe('current chapter + Git history (§6.15)', () => {
  it('reads only a clean hash-matched current chapter and derives history/diff from Git', () => {
    const vault = root();
    const first = commitChapter(vault, '初稿\n', 'chapter 1 v1');
    const second = commitChapter(vault, '修改稿\n', 'chapter 1 v2');

    expect(readCurrentChapter(vault, 1)).toMatchObject({
      body: '修改稿\n',
      status: 'draft',
      head: second,
      contentHash: contentHash('修改稿\n'),
    });
    const history = listChapterHistory(vault, 1);
    expect(history.map((entry) => entry.commit)).toEqual([second, first]);
    expect(history[0].byteLength).toBe(Buffer.byteLength('修改稿\n'));

    const diff = diffChapterVersions(vault, 1, first, second);
    expect(diff.patch).toContain('-初稿');
    expect(diff.patch).toContain('+修改稿');
    expect(diff.from.contentHash).toBe(contentHash('初稿\n'));
    expect(diff.to.contentHash).toBe(contentHash('修改稿\n'));
  });

  it('fails closed for an uncommitted chapter or a declared/actual hash mismatch', () => {
    const vault = root();
    commitChapter(vault, '已提交\n', 'chapter 1');
    writeFileSync(path.join(vault, 'chapters/001.md'), serializeFrontmatter({
      chapter_index: 1,
      status: 'draft',
      content_hash: contentHash('外部改动\n'),
    }, '外部改动\n'));
    expect(() => readCurrentChapter(vault, 1)).toThrowError(expect.objectContaining({ code: 'DIRTY_WORKSPACE' }));

    gitAdd(vault, ['chapters/001.md']);
    gitCommit(vault, 'external edit');
    writeFileSync(path.join(vault, 'chapters/001.md'), serializeFrontmatter({
      chapter_index: 1,
      status: 'draft',
      content_hash: 'a'.repeat(64),
    }, '损坏\n'));
    gitAdd(vault, ['chapters/001.md']);
    gitCommit(vault, 'bad hash');
    expect(() => readCurrentChapter(vault, 1)).toThrowError(StoreError);
    expect(() => readCurrentChapter(vault, 1)).toThrow(/content_hash/);
  });
});
