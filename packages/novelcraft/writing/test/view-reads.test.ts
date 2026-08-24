// view-reads 契约: UI 读面聚合(reviewSummaries / latestProposalForChapter /
// pendingChapterRefs)。R9 纪律 + 坏数据容错 + 与既有同口径(文件名序)。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initVault, paths } from '@novelcraft/vault';
import {
  latestProposalForChapter,
  pendingChapterRefs,
  reviewSummaries,
} from '../src/index.js';
import { serializeFrontmatter, contentHash } from '@novelcraft/store';

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nc-viewreads-'));
  dirs.push(root);
  initVault(root, { title: '读面测试书', language: 'zh' });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reviewSummaries', () => {
  it('空目录 → []; 逐文件容错投影 + 稳定排序; 坏 JSON 与 symlink 跳过(R9)', () => {
    const root = makeRoot();
    expect(reviewSummaries(root)).toEqual([]);
    const dir = paths(root).assistant.reviews;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'r-b.json'), JSON.stringify({
      review_id: 'rb', chapter_index: 2, verdict: 'pass', findings: [1, 2], reviewed_at: '2026-08-02T00:00:00Z',
    }));
    writeFileSync(path.join(dir, 'r-a.json'), JSON.stringify({
      chapter_index: 1, verdict: 'needs_work', reviewed_at: '2026-08-01T00:00:00Z',
    }));
    writeFileSync(path.join(dir, 'r-broken.json'), '{not json');
    const outside = path.join(root, '..', `outside-review-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify({ review_id: 'x', chapter_index: 9 }));
    try {
      symlinkSync(outside, path.join(dir, 'r-symlink.json'));
      const cards = reviewSummaries(root);
      expect(cards.length).toBe(2);
      // 缺 review_id 回退文件名; 缺 findings 计 0。
      expect(cards[0]).toEqual({
        review_id: 'r-a', chapter_index: 1, verdict: 'needs_work', finding_count: 0, reviewed_at: '2026-08-01T00:00:00Z',
      });
      expect(cards[1]).toEqual({
        review_id: 'rb', chapter_index: 2, verdict: 'pass', finding_count: 2, reviewed_at: '2026-08-02T00:00:00Z',
      });
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe('latestProposalForChapter', () => {
  it('按 next_chapter 取文件名序最后一条; 无匹配/目录缺失 → undefined', () => {
    const root = makeRoot();
    expect(latestProposalForChapter(root, 2)).toBeUndefined();
    const dir = paths(root).assistant.proposals;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'next-001-a.json'), JSON.stringify({
      run_id: 'a', chapter_index: 1, next_chapter: 2, generated_at: '2026-08-01T00:00:00Z', proposals: [],
    }));
    writeFileSync(path.join(dir, 'next-001-b.json'), JSON.stringify({
      run_id: 'b', chapter_index: 1, next_chapter: 2, generated_at: '2026-08-02T00:00:00Z', proposals: [],
    }));
    writeFileSync(path.join(dir, 'next-004-c.json'), JSON.stringify({
      run_id: 'c', chapter_index: 4, next_chapter: 5, generated_at: '2026-08-03T00:00:00Z', proposals: [],
    }));
    expect(latestProposalForChapter(root, 2)?.run_id).toBe('b');
    expect(latestProposalForChapter(root, 5)?.run_id).toBe('c');
    expect(latestProposalForChapter(root, 9)).toBeUndefined();
  });
});

describe('pendingChapterRefs', () => {
  it('只认合法且内容通过候选校验的 NNN.md; 坏候选/其他文件排除', () => {
    const root = makeRoot();
    expect(pendingChapterRefs(root)).toEqual([]);
    const dir = paths(root).chapters.pending;
    mkdirSync(dir, { recursive: true });
    // 与 generateNextChapter 落盘格式一致: frontmatter '---' 结束后空行接 body,
    // 否则 parseFrontmatter 剥离后 body 变形, content_hash 校验失败。
    const body = '候选二章正文\n';
    writeFileSync(path.join(dir, '002.md'), [
      '---',
      'chapter_index: 2',
      'status: candidate',
      `content_hash: ${contentHash(body)}`,
      'source: writing_generate',
      '---',
      '',
    ].join('\n') + body);
    // status 非 candidate → readChapterCandidate 拒绝 → 排除。
    writeFileSync(path.join(dir, '003.md'), serializeFrontmatter(
      { status: 'draft', chapter_index: 3 }, '坏候选',
    ));
    // 非 NNN.md 命名 → 排除。
    writeFileSync(path.join(dir, 'readme.txt'), 'x');
    expect(pendingChapterRefs(root)).toEqual([2]);
  });
});
