// chapter-history-view 契约: 单一映射事实源(camelCase → snake_case 线卡),
// title 保持可选(不强转空串), 由消费方决定回退展示。
import { describe, expect, it } from 'vitest';
import { chapterHistoryCardView, type ChapterHistoryEntry } from '../src/index.js';

const entry: ChapterHistoryEntry = {
  commit: 'abc123',
  authoredAt: '2026-08-24T00:00:00Z',
  subject: 'chapter: 003',
  status: 'canonical',
  title: '第三章',
  contentHash: 'sha256:deadbeef',
  declaredHashValid: true,
  byteLength: 1024,
};

describe('chapterHistoryCardView', () => {
  it('字段映射与 wire 卡片同形(snake_case)', () => {
    expect(chapterHistoryCardView(entry)).toEqual({
      commit: 'abc123',
      authored_at: '2026-08-24T00:00:00Z',
      subject: 'chapter: 003',
      status: 'canonical',
      title: '第三章',
      content_hash: 'sha256:deadbeef',
      declared_hash_valid: true,
      byte_length: 1024,
    });
  });

  it('title 缺失时保持 absent(键不出现), 不强转空串', () => {
    const { title: _omitted, ...noTitle } = entry;
    const card = chapterHistoryCardView(noTitle);
    expect('title' in card).toBe(false);
    expect(card.subject).toBe('chapter: 003');
  });
});
