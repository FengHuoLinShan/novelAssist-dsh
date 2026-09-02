import { useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS, type NovelcraftKey } from './locales.ts'
import { MAX_TEXT_INTAKE_BYTES, type IntakeStageValue } from '../wire.ts'
import { readFileBase64, stageTextIntakeFile, useWritingDesk } from './useWatch.ts'
import { ChapterDossier } from './ChapterDossier.tsx'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import css from './novelcraft.module.css'

export type WritingDeskActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type Mode = 'chapters' | 'proposals' | 'reviews' | 'import'

export function WritingDeskAction(props: WritingDeskActionProps): JSX.Element {
  const { t, connection, sessionId, inputActions, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('chapters')
  const [intakeBusy, setIntakeBusy] = useState(false)
  const [stagedIntake, setStagedIntake] = useState<IntakeStageValue | null>(null)
  const [chapterIntent, setChapterIntent] = useState('')
  const [message, setMessage] = useState('')
  const [dossierChapter, setDossierChapter] = useState<number | null>(null)
  const { data, loading, error, refresh } = useWritingDesk(connection, sessionId)

  const chapters = data?.chapters ?? []
  const reviews = data?.reviews ?? []
  const proposals = data?.proposals ?? null
  const lastChapter = chapters.reduce((max, chapter) => Math.max(max, chapter.index), 0)
  const proposalBlocked = Boolean(proposals && data?.pending_chapters.includes(proposals.next_chapter))

  const send = (prompt: string): boolean => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setMessage(t('desk.chatBusy'))
    return sent
  }

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    if (chatDraft.trim()) {
      setMessage(t('desk.chatBusy'))
      return
    }
    if (file.size > MAX_TEXT_INTAKE_BYTES) {
      setMessage(t('intake.tooLarge'))
      return
    }
    setIntakeBusy(true)
    setStagedIntake(null)
    setMessage('')
    try {
      const value = await stageTextIntakeFile(connection, sessionId, file.name, await readFileBase64(file))
      if (value === null) {
        setMessage(t('intake.fail'))
        return
      }
      window.dispatchEvent(new CustomEvent('novelcraft:signals-changed'))
      setStagedIntake(value)
    } catch {
      setMessage(t('intake.fail'))
    } finally {
      setIntakeBusy(false)
    }
  }

  const tabs: Array<{ mode: Mode; key: NovelcraftKey }> = [
    { mode: 'chapters', key: 'desk.mode.chapters' },
    { mode: 'proposals', key: 'desk.mode.proposals' },
    { mode: 'reviews', key: 'desk.mode.reviews' },
    { mode: 'import', key: 'desk.mode.import' },
  ]

  return (
    <>
      <button type="button" className={css.petTrigger} title={t('desk.title')}
        aria-label={t('desk.title')} onClick={() => setOpen(true)}>
        <span className={css.petLabel}>{t('desk.title')}</span>
      </button>
      <NovelcraftModal open={open} onClose={() => setOpen(false)} title={t('desk.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
        {error ? (
          <div className={css.emptyState} role="alert">
            <span>{t('common.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {data && data.bound == null ? <div className={css.empty}>{t('desk.unbound')}</div> : null}
        {data?.bound && dossierChapter != null ? (
          <ChapterDossier connection={connection} sessionId={sessionId} t={t}
            chapterIndex={dossierChapter} onBack={() => setDossierChapter(null)} />
        ) : data?.bound ? (
          <div className={css.workflowPanel}>
            <div className={css.panelToolbar}>
              <div className={css.tabRow} role="tablist" aria-label={t('desk.title')}>
                {tabs.map((tab) => (
                  <Pill key={tab.mode} role="tab" aria-selected={mode === tab.mode}
                    active={mode === tab.mode} onClick={() => setMode(tab.mode)}>{t(tab.key)}</Pill>
                ))}
              </div>
              <Button size="sm" variant="toolbar" disabled={loading} onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
            </div>
            {message ? <div className={css.message} role="status">{message}</div> : null}
            <div className={css.statusLine}>{data.book}</div>
            {mode === 'chapters' ? (
              chapters.length === 0 ? <div className={css.emptyState}>
                <span>{t('desk.chapters.empty')}</span>
                <Button variant="primary" onClick={() => setMode('import')}>{t('intake.choose')}</Button>
              </div> : (
                <div className={css.workflowPanel}>
                  {chapters.map((chapter) => (
                    <button key={chapter.index} type="button" className={css.chapterRow}
                      onClick={() => setDossierChapter(chapter.index)}>
                      <span className={css.chapterRowIndex}>{t('story.chapterNumber', { index: chapter.index })}</span>
                      <span>{chapter.title ?? t('common.untitled')}</span>
                    </button>
                  ))}
                </div>
              )
            ) : null}
            {mode === 'proposals' ? (
              proposals == null || proposals.proposals.length === 0 ? (
                <div className={css.emptyState}>
                  <span>{t('desk.proposals.empty')}</span>
                  <label className={css.presetControl}>
                    <span>{t('desk.proposals.intent')}</span>
                    <textarea className={css.outlineTask} value={chapterIntent}
                      onChange={(event) => setChapterIntent(event.currentTarget.value)} />
                  </label>
                  <Button variant="primary" disabled={lastChapter < 1} onClick={() => send(
                    t('desk.prompt.propose', { chapter: lastChapter, intent: chapterIntent.trim() }),
                  )}>{t('desk.proposals.create')}</Button>
                </div>
              ) : (
                <div className={css.workflowPanel}>
                  <div className={css.sectionTitle}>{t('story.chapterNumber', { index: proposals.next_chapter })}</div>
                  <p className={css.helperText}>{t('desk.proposals.sources', {
                    used: proposals.source_count,
                    omitted: proposals.omitted_source_count,
                    warnings: proposals.warning_count,
                  })}</p>
                  {proposals.proposals.map((proposal) => (
                    <article key={proposal.proposal_id ?? proposal.title} className={css.workflowCard}>
                      <header className={css.cardHeader}><span className={css.cardTitle}>{proposal.title}</span></header>
                      <p className={css.proposed}>{proposal.premise}</p>
                      {proposal.basis?.length ? <p className={css.proposed}>{t('desk.proposals.basis')}：{proposal.basis.join(' / ')}</p> : null}
                      {proposal.cost ? <p className={css.proposed}>{t('desk.proposals.cost')}：{proposal.cost}</p> : null}
                      {proposal.risk ? <p className={css.proposed}>{t('desk.proposals.risk')}：{proposal.risk}</p> : null}
                      {proposal.proposal_id ? (
                        <Button variant="primary" disabled={proposalBlocked} onClick={() => send(
                          t('desk.prompt.continue', {
                            title: proposal.title,
                            chapter: proposals.next_chapter,
                            run: proposals.run_id,
                            proposal: proposal.proposal_id,
                          }),
                        )}>{t(proposalBlocked ? 'desk.proposals.pending' : 'desk.proposals.use')}</Button>
                      ) : <p className={css.helperText}>{t('desk.proposals.readOnly')}</p>}
                    </article>
                  ))}
                </div>
              )
            ) : null}
            {mode === 'reviews' ? (
              reviews.length === 0 ? <div className={css.empty}>{t('desk.reviews.empty')}</div> : (
                <div className={css.workflowPanel}>
                  {reviews.map((review) => (
                    <button key={review.review_id} type="button" className={css.chapterRow}
                      onClick={() => setDossierChapter(review.chapter_index)}>
                      <span className={css.cardTitle}>{t('story.chapterNumber', { index: review.chapter_index })}</span>
                      <span className={css.cardMeta}>{t('desk.reviews.findings')}：{review.finding_count}</span>
                    </button>
                  ))}
                </div>
              )
            ) : null}
            {mode === 'import' ? (
              <div className={css.intakePanel}>
                <p className={css.proposed}>{t('intake.hint')}</p>
                {chatDraft.trim() ? <div className={css.message} role="alert">{t('desk.chatBusy')}</div> : null}
                <label className={`${css.fileLabel} ${chatDraft.trim() ? css.fileLabelDisabled : ''}`}>
                  <span>{intakeBusy ? t('intake.staging') : t('intake.choose')}</span>
                  <input className={css.fileInput} type="file" accept=".txt,.md,text/plain,text/markdown"
                    disabled={intakeBusy || Boolean(chatDraft.trim())}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      void chooseFile(file)
                    }} />
                </label>
                {stagedIntake ? (
                  <section className={css.workflowCard} aria-label={t('intake.previewTitle')}>
                    <strong>{stagedIntake.file_name}</strong>
                    <p className={css.previewSummary}>{t('intake.previewSummary', {
                      count: stagedIntake.preview.chapter_count,
                      preamble: stagedIntake.preview.preamble_chars,
                    })}</p>
                    {stagedIntake.preview.headings.length > 0 ? (
                      <ol className={css.evidence}>
                        {stagedIntake.preview.headings.map((heading, index) => <li key={`${index}:${heading}`}>{heading}</li>)}
                      </ol>
                    ) : <p className={css.warning}>{t(stagedIntake.preview.blocked ? 'intake.unrecognizedLong' : 'intake.noHeadings')}</p>}
                    <Button variant="primary" disabled={stagedIntake.preview.blocked || Boolean(chatDraft.trim())}
                      onClick={() => send(t('desk.prompt.import', { file: stagedIntake.file_name }))}>
                      {t('intake.confirm')}
                    </Button>
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </NovelcraftModal>
    </>
  )
}
