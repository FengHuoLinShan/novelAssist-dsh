import { describe, expect, it } from 'vitest'
import {
  chapterDraftIsDirty,
  chapterDraftKey,
  readAbsentChapterDraft,
  readChapterDraft,
  reconcileChapterDraft,
  selectedChapterIndex,
  type ChapterDraft,
} from '../src/client/ChapterWorkspaceView.tsx'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('chapter workspace state', () => {
  it('selects the first chapter only for initial index zero and preserves explicit chapter changes', () => {
    const chapters = [{ index: 1 }, { index: 2 }]
    expect(selectedChapterIndex(0, chapters)).toBe(1)
    expect(selectedChapterIndex(2, chapters)).toBe(2)
  })

  it('isolates browser drafts by session, book, and chapter', () => {
    expect(chapterDraftKey('session', 'book-a', 1)).not.toBe(chapterDraftKey('session', 'book-b', 1))
    expect(chapterDraftKey('session', 'book-a', 1)).not.toBe(chapterDraftKey('session', 'book-a', 2))
  })

  it('keeps a stale-base draft as a recoverable conflict instead of deleting it', () => {
    const storage = new MemoryStorage()
    const key = chapterDraftKey('session', 'book', 1)
    storage.setItem(key, JSON.stringify({ base: 'old', title: '旧标题', text: '未保存正文' }))

    const draft = readChapterDraft(storage, 'session', 'book', 1, {
      base: 'new',
      title: '当前标题',
      text: '当前正文',
    })

    expect(draft).toMatchObject({ base: 'new', title: '当前标题', text: '当前正文' })
    expect(draft.conflicts).toEqual([{ base: 'old', title: '旧标题', text: '未保存正文' }])
    expect(JSON.parse(storage.getItem(key) ?? 'null')).toEqual(draft)
    expect(readChapterDraft(storage, 'session', 'book', 1, {
      base: 'new',
      title: '当前标题',
      text: '当前正文',
    })).toEqual(draft)
  })

  it('updates an unchanged local mirror to the new base without inventing a conflict', () => {
    expect(reconcileChapterDraft(
      { base: 'old', title: '标题', text: '正文' },
      { base: 'new', title: '标题', text: '正文' },
    )).toEqual({ base: 'new', title: '标题', text: '正文', conflicts: [] })
  })

  it('detects unsaved title or body changes for fail-closed chapter actions', () => {
    const current = { base: 'hash', title: '标题', text: '正文' }
    const clean: ChapterDraft = { ...current, conflicts: [] }
    expect(chapterDraftIsDirty(clean, current)).toBe(false)
    expect(chapterDraftIsDirty({ ...clean, text: '未保存正文' }, current)).toBe(true)
    expect(chapterDraftIsDirty({ ...clean, title: '未保存标题' }, current)).toBe(true)
    expect(chapterDraftIsDirty({ base: 'absent', title: '第一章', text: '新章正文', conflicts: [] }, null)).toBe(true)
  })

  it('restores a non-empty first-chapter draft while the canonical chapter is still absent', () => {
    const storage = new MemoryStorage()
    const draft: ChapterDraft = { base: 'absent', title: '第一章', text: '未保存正文', conflicts: [] }
    storage.setItem(chapterDraftKey('session', 'book', 1), JSON.stringify(draft))
    expect(readAbsentChapterDraft(storage, 'session', 'book', 1)).toEqual(draft)
    expect(readAbsentChapterDraft(storage, 'session', 'book', 2)).toBeNull()
  })
})
