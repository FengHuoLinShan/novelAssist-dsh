import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChapterWorkspaceValue } from '../wire.ts'
import type { RpcCaller } from './index.ts'
import { NS } from './locales.ts'
import { BOOK_CHANGED_EVENT, loadChapterWorkspace, matchesBookChangedSession, stageChapterEdit, type BookChangedDetail } from './useWatch.ts'
import css from './novelcraft.module.css'

export type ChapterWorkspaceViewProps = ConvViewProps & PropsLocale<typeof NS> & {
  connection: RpcCaller | undefined
}

export interface ChapterDraftSnapshot {
  base: string
  title: string
  text: string
}

export interface ChapterDraft extends ChapterDraftSnapshot {
  conflicts: ChapterDraftSnapshot[]
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>

export function chapterDraftKey(sessionId: string, book: string, chapterIndex: number): string {
  return `novelcraft:chapter-draft:${encodeURIComponent(sessionId)}:${encodeURIComponent(book)}:${chapterIndex}`
}

function isDraftSnapshot(value: unknown): value is ChapterDraftSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Partial<ChapterDraftSnapshot>
  return typeof draft.base === 'string' && typeof draft.title === 'string' && typeof draft.text === 'string'
}

export function reconcileChapterDraft(stored: unknown, current: ChapterDraftSnapshot): ChapterDraft {
  if (!isDraftSnapshot(stored)) return { ...current, conflicts: [] }
  const conflicts = Array.isArray((stored as Partial<ChapterDraft>).conflicts)
    ? (stored as Partial<ChapterDraft>).conflicts?.filter(isDraftSnapshot) ?? []
    : []
  if (stored.base === current.base) return { ...stored, conflicts }
  if (stored.title === current.title && stored.text === current.text) return { ...current, conflicts }
  const stale = { base: stored.base, title: stored.title, text: stored.text }
  return {
    ...current,
    conflicts: [stale, ...conflicts.filter((item) =>
      item.base !== stale.base || item.title !== stale.title || item.text !== stale.text)],
  }
}

export function chapterDraftIsDirty(draft: ChapterDraft | null, current: ChapterDraftSnapshot | null): boolean {
  if (!draft) return false
  if (!current) return draft.base === 'absent' && Boolean(draft.title || draft.text)
  return draft.title !== current.title || draft.text !== current.text
}

export function selectedChapterIndex(requested: number, chapters: Array<{ index: number }>): number {
  return requested === 0 ? chapters[0]?.index ?? 0 : requested
}

export function readChapterDraft(
  storage: DraftStorage,
  sessionId: string,
  book: string,
  chapterIndex: number,
  current: ChapterDraftSnapshot,
): ChapterDraft {
  const key = chapterDraftKey(sessionId, book, chapterIndex)
  let stored: unknown = null
  try {
    const raw = storage.getItem(key)
    stored = JSON.parse(raw ?? 'null') as unknown
    if (!isDraftSnapshot(stored)) {
      const legacy = JSON.parse(storage.getItem(`novelcraft:chapter-draft:${sessionId}:${chapterIndex}`) ?? 'null') as unknown
      if (isDraftSnapshot(legacy) && legacy.base === current.base) stored = legacy
    }
  } catch {
    return { ...current, conflicts: [] }
  }
  const resolved = reconcileChapterDraft(stored, current)
  if (isDraftSnapshot(stored) && JSON.stringify(resolved) !== JSON.stringify(stored)) {
    try {
      storage.setItem(key, JSON.stringify(resolved))
    } catch {
      // Storage is a convenience mirror; keep the recovered copy in this mount.
    }
  }
  return resolved
}

export function readAbsentChapterDraft(
  storage: DraftStorage,
  sessionId: string,
  book: string,
  chapterIndex: number,
): ChapterDraft | null {
  try {
    const stored = JSON.parse(storage.getItem(chapterDraftKey(sessionId, book, chapterIndex)) ?? 'null') as unknown
    if (!isDraftSnapshot(stored) || stored.base !== 'absent' || (!stored.title && !stored.text)) return null
    return {
      ...stored,
      conflicts: Array.isArray((stored as Partial<ChapterDraft>).conflicts)
        ? (stored as Partial<ChapterDraft>).conflicts?.filter(isDraftSnapshot) ?? []
        : [],
    }
  } catch {
    return null
  }
}

function writeDraft(sessionId: string, book: string, chapterIndex: number, draft: ChapterDraft): void {
  try {
    localStorage.setItem(chapterDraftKey(sessionId, book, chapterIndex), JSON.stringify(draft))
  } catch {
    // Storage is a convenience mirror, never the canonical write path.
  }
}

export function ChapterWorkspaceView(props: ChapterWorkspaceViewProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [data, setData] = useState<ChapterWorkspaceValue | null>(null)
  const [editor, setEditor] = useState<ChapterDraft | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedFindings, setSelectedFindings] = useState<string[]>([])
  const [candidateRejectReason, setCandidateRejectReason] = useState('')
  const request = useRef(0)

  const refresh = useCallback(async function refreshChapter(index: number, diffFromCommit?: string): Promise<void> {
    const seq = ++request.current
    setLoadState('loading')
    const value = await loadChapterWorkspace(connection, sessionId, index, diffFromCommit)
    if (seq !== request.current) return
    if (value === null) {
      setLoadState('error')
      return
    }
    setData(value)
    const selected = selectedChapterIndex(index, value.chapters)
    if (selected !== index) {
      setChapterIndex(selected)
      await refreshChapter(selected)
      return
    }
    setLoadState('ready')
    setSelectedFindings([])
    setCandidateRejectReason('')
    if (value.chapter && value.bound) {
      const saved = readChapterDraft(localStorage, String(sessionId), value.bound.book, value.chapter.index, {
        base: value.chapter.content_hash,
        title: value.chapter.title ?? '',
        text: value.chapter.body,
      })
      setEditor(saved)
      setMessage('')
    } else if (value.bound && value.chapters.length === 0) {
      const pending = readAbsentChapterDraft(localStorage, String(sessionId), value.bound.book, 1)
      setEditor(pending)
      if (pending) setChapterIndex(1)
      setMessage('')
    } else {
      setEditor(null)
      setMessage('')
    }
  }, [connection, sessionId])

  useEffect(() => {
    const reload = (event?: Event) => {
      if (event && !matchesBookChangedSession((event as CustomEvent<BookChangedDetail>).detail, sessionId)) return
      request.current += 1
      setData(null)
      setEditor(null)
      setEditing(false)
      setChapterIndex(0)
      setLoadState('loading')
      void refresh(0)
    }
    reload()
    window.addEventListener(BOOK_CHANGED_EVENT, reload)
    return () => {
      request.current += 1
      window.removeEventListener(BOOK_CHANGED_EVENT, reload)
    }
  }, [refresh, sessionId])

  const chapter = data?.chapter ?? null
  const current = chapter ? { base: chapter.content_hash, title: chapter.title ?? '', text: chapter.body } : null
  const dirty = chapterDraftIsDirty(editor, current)

  const updateEditor = (next: ChapterDraft): void => {
    setEditor(next)
    if (data?.bound) writeDraft(String(sessionId), data.bound.book, chapterIndex, next)
  }

  const requireEmptyChatDraft = (): boolean => {
    if (chatDraft.trim() === '') return true
    setMessage(t('chapter.chatDraftBusy'))
    return false
  }

  const requireCleanEditor = (): boolean => {
    if (!dirty) return true
    setMessage(t('chapter.unsavedChangesBlocked'))
    return false
  }

  const save = async (): Promise<void> => {
    if (!editor || !data?.bound || !requireEmptyChatDraft()) return
    const newChapter = data.chapter == null && editor.base === 'absent'
    if (!newChapter && data.chapter == null) return
    setBusy(true)
    setMessage('')
    try {
      const staged = await stageChapterEdit(connection, sessionId, {
        chapterIndex,
        ...(newChapter ? { expectedAbsent: true } : { expectedContentHash: editor.base }),
        title: editor.title,
        text: editor.text,
      })
      if (!staged) {
        setMessage(t('chapter.saveFailed'))
        return
      }
      inputActions.setDraft(`请调用 novelcraft_chapter_version，action=save，receipt_id=${staged.receipt_id}，保存第 ${chapterIndex} 章。`)
      inputActions.submit()
      setMessage(staged.message)
      window.dispatchEvent(new CustomEvent('novelcraft:signals-changed'))
    } finally {
      setBusy(false)
    }
  }

  const restore = (commit: string): void => {
    if (!data?.chapter || !requireCleanEditor() || !requireEmptyChatDraft()) return
    inputActions.setDraft(`请调用 novelcraft_chapter_version，action=restore，chapter_index=${chapterIndex}，commit=${commit}，expected_content_hash=${data.chapter.content_hash}。`)
    inputActions.submit()
    setMessage(t('chapter.restoreRequested'))
  }

  const sendChapterAction = (prompt: string, sentMessage: string, allowDirty = false): void => {
    if ((!allowDirty && !requireCleanEditor()) || !requireEmptyChatDraft()) return
    inputActions.setDraft(prompt)
    inputActions.submit()
    setMessage(sentMessage)
  }

  const reviewTarget = (target: 'current' | 'candidate'): void => {
    const refArg = target === 'candidate' && data?.candidate ? `，ref=${data.candidate.ref}` : ''
    sendChapterAction(
      `请调用 novelcraft_chapter_review，action=review，target=${target}，chapter=${chapterIndex}${refArg}。`,
      t('chapter.reviewRequested'),
    )
  }

  const reviseSelected = (): void => {
    if (selectedFindings.length === 0) {
      setMessage(t('chapter.selectFinding'))
      return
    }
    sendChapterAction(
      `请调用 novelcraft_chapter_review，action=revise，target=current，chapter=${chapterIndex}，finding_ids=${JSON.stringify(selectedFindings)}。`,
      t('chapter.reviseRequested'),
    )
  }

  const adoptCandidate = (): void => {
    if (!data?.candidate) return
    sendChapterAction(
      `请调用 novelcraft_chapter_review，action=adopt，target=candidate，chapter=${chapterIndex}，ref=${data.candidate.ref}，expected_content_hash=${data.candidate.content_hash}。`,
      t('chapter.adoptRequested'),
    )
  }

  const rejectCandidate = (): void => {
    if (!data?.candidate || candidateRejectReason.trim() === '') return
    sendChapterAction(
      `请调用 novelcraft_chapter_review，action=reject，target=candidate，chapter=${chapterIndex}，ref=${data.candidate.ref}，expected_content_hash=${data.candidate.content_hash}，reason=${JSON.stringify(candidateRejectReason.trim())}。`,
      t('chapter.rejectRequested'),
      true,
    )
  }

  const finishEditing = (): void => {
    setEditing(false)
    setMessage(dirty ? t('chapter.editingFinishedDraftKept') : editor?.conflicts.length ? t('chapter.conflictKept') : '')
  }

  const startFirstChapter = (): void => {
    if (!data?.bound) return
    setChapterIndex(1)
    setEditor({ base: 'absent', title: '', text: '', conflicts: [] })
    setEditing(true)
    setMessage('')
  }

  const recoverConflict = (conflict: ChapterDraftSnapshot): void => {
    if (!editor || !chapter) return
    updateEditor({ ...editor, base: chapter.content_hash, title: conflict.title, text: conflict.text })
    setEditing(true)
    setMessage(t('chapter.conflictRecovered'))
  }

  const chapters = data?.chapters ?? []
  return (
    <main className={css.chapterWorkspace}>
      <header className={css.chapterWorkspaceHeader}>
        <div>
          <h2 className={css.chapterWorkspaceTitle}>{t('chapter.view')}</h2>
          <div className={css.chapterWorkspaceMeta}>{data?.bound?.book ?? ''}</div>
        </div>
        <div className={css.chapterWorkspaceActions}>
          <select
            aria-label={t('chapter.select')}
            value={chapterIndex || ''}
            disabled={loadState !== 'ready'}
            onChange={(event) => {
              const next = Number(event.target.value)
              setEditing(false)
              setMessage('')
              setChapterIndex(next)
              void refresh(next)
            }}
          >
            {chapters.length === 0 ? <option value="">{t('chapter.empty')}</option> : null}
            {chapters.map((item) => <option key={item.index} value={item.index}>{t('chapter.option', { index: item.index, title: item.title ?? '' })}</option>)}
          </select>
          <button type="button" className={css.tab} disabled={loadState === 'loading'} onClick={() => void refresh(chapterIndex)}>{t('chapter.refresh')}</button>
        </div>
      </header>

      {loadState === 'loading' ? <div className={css.empty}>{t('common.loading')}</div> : loadState === 'error' ? (
        <div className={css.empty} role="alert">
          <div>{t('common.loadFailed')}</div>
          <button type="button" className={css.tab} onClick={() => void refresh(chapterIndex)}>{t('common.retry')}</button>
        </div>
      ) : data?.bound == null ? <div className={css.empty}>{t('chapter.unbound')}</div> : chapter == null && data?.candidate == null && editor == null ? (
        <div className={css.emptyState}>
          <span>{t('chapter.empty')}</span>
          <button type="button" className={css.tab} onClick={startFirstChapter}>{t('chapter.createFirst')}</button>
        </div>
      ) : (
        <div className={css.chapterWorkspaceGrid}>
          {editor ? <section className={css.chapterEditorPane}>
            <div className={css.chapterEditorToolbar}>
              <input
                aria-label={t('chapter.title')}
                className={css.chapterTitleInput}
                value={editor.title}
                disabled={!editing || busy}
                onChange={(event) => updateEditor({ ...editor, title: event.target.value })}
              />
              <span className={css.chapterWorkspaceMeta}>{t('chapter.status')}: {chapter?.status ?? t('chapter.new')}</span>
              {editing ? (
                <>
                  <button type="button" className={css.tab} disabled={busy || !editor.text.trim()} onClick={() => void save()}>{busy ? t('chapter.saving') : t('chapter.save')}</button>
                  <button type="button" className={css.tab} disabled={busy} onClick={finishEditing}>{t('chapter.cancel')}</button>
                </>
              ) : <button type="button" className={css.tab} onClick={() => setEditing(true)}>{t('chapter.edit')}</button>}
            </div>
            {message ? <div className={css.message} role="status">{message}</div> : null}
            <textarea
              aria-label={t('chapter.body')}
              className={css.chapterTextarea}
              value={editor.text}
              readOnly={!editing}
              onChange={(event) => updateEditor({ ...editor, text: event.target.value })}
            />
            {editor.conflicts.length > 0 ? (
              <section className={css.chapterConflict} role="alert">
                <strong>{t('chapter.conflictTitle')}</strong>
                <div>{t('chapter.conflictKept')}</div>
                {editor.conflicts.map((conflict, index) => (
                  <details key={`${conflict.base}:${index}`}>
                    <summary>{t('chapter.conflictCopy')} · {conflict.title}</summary>
                    <pre>{conflict.text}</pre>
                    <button type="button" className={css.tab} onClick={() => recoverConflict(conflict)}>{t('chapter.conflictRecover')}</button>
                  </details>
                ))}
              </section>
            ) : null}
            {data.diff ? (
              <details className={css.chapterDiff}>
                <summary className={css.sectionTitle}>{t('chapter.diff')}</summary>
                <pre>{data.diff.patch || t('chapter.noDiff')}</pre>
                {data.diff.truncated ? <div className={css.message}>{t('chapter.truncated')}</div> : null}
              </details>
            ) : null}
          </section> : null}

          <aside className={css.chapterHistoryPane}>
            {chapter ? <section>
              <div className={css.chapterReviewHeader}>
                <h3 className={css.sectionTitle}>{t('chapter.review')}</h3>
                <button type="button" className={css.tab} onClick={() => reviewTarget('current')}>{t('chapter.reviewCurrent')}</button>
              </div>
              {data.review == null ? <div className={css.dossierEmpty}>{t('chapter.noReview')}</div> : (
                <div>
                  <div className={css.chapterWorkspaceMeta}>
                    {data.review.verdict} · {data.review.fresh ? t('chapter.fresh') : t('chapter.stale')}
                  </div>
                  {data.review.findings.map((finding) => (
                    <label key={finding.finding_id} className={css.chapterFinding}>
                      <input
                        type="checkbox"
                        disabled={!data.review?.fresh || finding.rejected}
                        checked={selectedFindings.includes(finding.finding_id)}
                        onChange={(event) => setSelectedFindings((current) => event.target.checked
                          ? [...current, finding.finding_id]
                          : current.filter((id) => id !== finding.finding_id))}
                      />
                      <span><strong>{finding.severity} · {finding.category}</strong><br />{finding.quote}<br />{finding.suggestion}</span>
                    </label>
                  ))}
                  {data.review.fresh && data.review.findings.length > 0 ? (
                    <button type="button" className={css.tab} onClick={reviseSelected}>{t('chapter.reviseSelected')}</button>
                  ) : null}
                </div>
              )}
            </section> : null}

            {data.candidate ? (
              <section className={css.chapterCandidate}>
                <div className={css.chapterReviewHeader}>
                  <h3 className={css.sectionTitle}>{t('chapter.candidate')}</h3>
                  <span className={css.chapterWorkspaceMeta}>{data.candidate.source}</span>
                </div>
                <pre>{data.candidate.body}</pre>
                <div className={css.chapterWorkspaceMeta}>
                  {data.candidate.review
                    ? `${data.candidate.review.verdict} · ${data.candidate.review.fresh ? t('chapter.fresh') : t('chapter.stale')}`
                    : t('chapter.noReview')}
                </div>
                {data.candidate.review?.findings.map((finding) => (
                  <div key={finding.finding_id} className={css.chapterFinding}>
                    <span><strong>{finding.severity} · {finding.category}</strong><br />{finding.quote}<br />{finding.suggestion}</span>
                  </div>
                ))}
                <div className={css.chapterWorkspaceActions}>
                  <button type="button" className={css.tab} onClick={() => reviewTarget('candidate')}>{t('chapter.reviewCandidate')}</button>
                  <button
                    type="button"
                    className={css.tab}
                    disabled={data.candidate.review?.verdict !== 'pass' || !data.candidate.review.fresh}
                    onClick={adoptCandidate}
                  >{t('chapter.adoptCandidate')}</button>
                </div>
                <div className={css.chapterWorkspaceActions}>
                  <label className={css.presetControl}>
                    <span>{t('chapter.rejectReason')}</span>
                    <input
                      className={css.chapterTitleInput}
                      maxLength={1000}
                      value={candidateRejectReason}
                      onChange={(event) => setCandidateRejectReason(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={css.tab}
                    disabled={candidateRejectReason.trim() === ''}
                    onClick={rejectCandidate}
                  >{t('chapter.rejectCandidate')}</button>
                </div>
              </section>
            ) : null}

            <h3 className={css.sectionTitle}>{t('chapter.history')}</h3>
            {data.history.map((item, index) => (
              <article key={item.commit} className={css.card}>
                <header className={css.cardHeader}>
                  <span className={css.cardTitle}>{item.subject || t('chapter.history')}</span>
                  {index === 0 ? <span className={css.cardMeta}>{t('chapter.current')}</span> : null}
                </header>
                <div className={css.chapterWorkspaceMeta}>{item.authored_at} · {item.byte_length} {t('chapter.bytes')}</div>
                {!item.declared_hash_valid ? <div className={css.message}>{t('chapter.invalidHash')}</div> : null}
                <div className={css.chapterWorkspaceActions}>
                  <button type="button" className={css.tab} onClick={() => void refresh(chapterIndex, item.commit)}>{t('chapter.diff')}</button>
                  {index > 0 ? <button type="button" className={css.tab} onClick={() => restore(item.commit)}>{t('chapter.restore')}</button> : null}
                </div>
              </article>
            ))}
          </aside>
        </div>
      )}
    </main>
  )
}
