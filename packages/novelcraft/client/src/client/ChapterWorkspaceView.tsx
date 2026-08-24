import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChapterWorkspaceValue } from '../wire.ts'
import type { RpcCaller } from './index.ts'
import { NS } from './locales.ts'
import { loadChapterWorkspace, stageChapterEdit } from './useWatch.ts'
import css from './novelcraft.module.css'

export type ChapterWorkspaceViewProps = ConvViewProps & PropsLocale<typeof NS> & {
  connection: RpcCaller | undefined
}

interface LocalDraft {
  base: string
  title: string
  text: string
}

function draftKey(sessionId: string, chapterIndex: number): string {
  return `novelcraft:chapter-draft:${sessionId}:${chapterIndex}`
}

function readDraft(sessionId: string, chapterIndex: number, base: string): LocalDraft | null {
  try {
    const key = draftKey(sessionId, chapterIndex)
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<LocalDraft> | null
    if (value?.base === base && typeof value.title === 'string' && typeof value.text === 'string') {
      return value as LocalDraft
    }
    localStorage.removeItem(key)
  } catch {
    // Browsers may disable storage; editing still works for this mount.
  }
  return null
}

function writeDraft(sessionId: string, chapterIndex: number, draft: LocalDraft): void {
  try {
    localStorage.setItem(draftKey(sessionId, chapterIndex), JSON.stringify(draft))
  } catch {
    // Storage is a convenience mirror, never the canonical write path.
  }
}

export function ChapterWorkspaceView(props: ChapterWorkspaceViewProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state) => state.draft)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [data, setData] = useState<ChapterWorkspaceValue | null>(null)
  const [editor, setEditor] = useState<LocalDraft | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedFindings, setSelectedFindings] = useState<string[]>([])
  const [candidateRejectReason, setCandidateRejectReason] = useState('')
  const request = useRef(0)

  const refresh = useCallback(async (index = chapterIndex, diffFromCommit?: string) => {
    const seq = ++request.current
    const value = await loadChapterWorkspace(connection, sessionId, index, diffFromCommit)
    if (seq !== request.current || value === null) return
    setData(value)
    if (index === 0 && value.chapters[0]) {
      setChapterIndex(value.chapters[0].index)
      return
    }
    setEditing(false)
    setMessage('')
    setSelectedFindings([])
    setCandidateRejectReason('')
    if (value.chapter) {
      const saved = readDraft(String(sessionId), value.chapter.index, value.chapter.content_hash)
      setEditor(saved ?? {
        base: value.chapter.content_hash,
        title: value.chapter.title ?? '',
        text: value.chapter.body,
      })
    } else {
      setEditor(null)
    }
  }, [chapterIndex, connection, sessionId])

  useEffect(() => {
    void refresh(chapterIndex)
    return () => { request.current += 1 }
  }, [chapterIndex, connection, sessionId])

  const updateEditor = (next: LocalDraft): void => {
    setEditor(next)
    writeDraft(String(sessionId), chapterIndex, next)
  }

  const requireEmptyChatDraft = (): boolean => {
    if (chatDraft.trim() === '') return true
    setMessage(t('chapter.chatDraftBusy'))
    return false
  }

  const save = async (): Promise<void> => {
    if (!editor || !data?.chapter || !requireEmptyChatDraft()) return
    setBusy(true)
    setMessage('')
    try {
      const staged = await stageChapterEdit(connection, sessionId, {
        chapterIndex,
        expectedContentHash: editor.base,
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
    if (!data?.chapter || !requireEmptyChatDraft()) return
    inputActions.setDraft(`请调用 novelcraft_chapter_version，action=restore，chapter_index=${chapterIndex}，commit=${commit}，expected_content_hash=${data.chapter.content_hash}。`)
    inputActions.submit()
    setMessage(t('chapter.restoreRequested'))
  }

  const sendChapterAction = (prompt: string, sentMessage: string): void => {
    if (!requireEmptyChatDraft()) return
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
    )
  }

  const chapters = data?.chapters ?? []
  const chapter = data?.chapter ?? null
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
            onChange={(event) => { setEditing(false); setMessage(''); setChapterIndex(Number(event.target.value)) }}
          >
            {chapters.length === 0 ? <option value="">{t('chapter.empty')}</option> : null}
            {chapters.map((item) => <option key={item.index} value={item.index}>ch{item.index} {item.title ?? ''}</option>)}
          </select>
          <button type="button" className={css.tab} onClick={() => void refresh()}>{t('chapter.refresh')}</button>
        </div>
      </header>

      {data?.bound == null ? <div className={css.empty}>{t('chapter.unbound')}</div> : chapter == null && data?.candidate == null ? (
        <div className={css.empty}>{t('chapter.empty')}</div>
      ) : (
        <div className={css.chapterWorkspaceGrid}>
          {chapter && editor ? <section className={css.chapterEditorPane}>
            <div className={css.chapterEditorToolbar}>
              <input
                aria-label={t('chapter.title')}
                className={css.chapterTitleInput}
                value={editor.title}
                disabled={!editing || busy}
                onChange={(event) => updateEditor({ ...editor, title: event.target.value })}
              />
              <span className={css.chapterWorkspaceMeta}>{t('chapter.status')}: {chapter.status}</span>
              {editing ? (
                <>
                  <button type="button" className={css.tab} disabled={busy} onClick={() => void save()}>{busy ? t('chapter.saving') : t('chapter.save')}</button>
                  <button type="button" className={css.tab} disabled={busy} onClick={() => { setEditing(false); void refresh() }}>{t('chapter.cancel')}</button>
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
            {data.diff ? (
              <section className={css.chapterDiff}>
                <div className={css.sectionTitle}>{t('chapter.diff')} · {data.diff.from_commit.slice(0, 12)} → {data.diff.to_commit.slice(0, 12)}</div>
                <pre>{data.diff.patch || t('chapter.noDiff')}</pre>
                {data.diff.truncated ? <div className={css.message}>{t('chapter.truncated')}</div> : null}
              </section>
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
                  <input
                    aria-label={t('chapter.rejectReason')}
                    className={css.chapterTitleInput}
                    maxLength={1000}
                    placeholder={t('chapter.rejectReason')}
                    value={candidateRejectReason}
                    onChange={(event) => setCandidateRejectReason(event.target.value)}
                  />
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
                  <span className={css.cardTitle}>{item.subject || item.commit.slice(0, 12)}</span>
                  <span className={css.cardMeta}>{index === 0 ? t('chapter.current') : item.commit.slice(0, 8)}</span>
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
