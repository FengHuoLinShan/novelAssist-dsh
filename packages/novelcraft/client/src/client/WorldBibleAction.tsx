import { useEffect, useState } from 'react'
import { Button, IconRefreshOutline16, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS, type NovelcraftKey } from './locales.ts'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import { BOOK_CHANGED_EVENT, matchesBookChangedSession, useWorldWorkspace, type BookChangedDetail } from './useWatch.ts'
import css from './novelcraft.module.css'

export type WorldBibleActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type Mode = 'chat' | 'converge' | 'explore' | 'inspect' | 'bible_suggest'

const MODE_LABEL: Record<Mode, NovelcraftKey> = {
  chat: 'world.mode.chat',
  converge: 'world.mode.converge',
  explore: 'world.mode.explore',
  inspect: 'world.mode.inspect',
  bible_suggest: 'world.mode.bible',
}

const MODE_ACTION: Record<Mode, NovelcraftKey> = {
  chat: 'world.run.chat',
  converge: 'world.run.converge',
  explore: 'world.run.explore',
  inspect: 'world.run.inspect',
  bible_suggest: 'world.run.bible',
}

export function WorldBibleAction(props: WorldBibleActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'create' | 'content'>('create')
  const [mode, setMode] = useState<Mode>('chat')
  const [task, setTask] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [notice, setNotice] = useState('')
  const { data, loading, error, refresh } = useWorldWorkspace(connection, sessionId)

  useEffect(() => {
    const reset = (event?: Event) => {
      if (event && !matchesBookChangedSession((event as CustomEvent<BookChangedDetail>).detail, sessionId)) return
      setOpen(false)
      setView('create')
      setMode('chat')
      setTask('')
      setSources([])
      setIncludeDrafts(false)
      setNotice('')
    }
    reset()
    window.addEventListener(BOOK_CHANGED_EVENT, reset)
    return () => window.removeEventListener(BOOK_CHANGED_EVENT, reset)
  }, [sessionId])

  const send = (prompt: string): void => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setNotice(t('world.chatBusy'))
  }

  const toggle = (ref: string, checked: boolean): void => {
    setSources((current) => checked ? [...new Set([...current, ref])] : current.filter((item) => item !== ref))
  }

  const run = (): void => {
    const input = task.trim()
    if (!input || !data) return
    const selectedObjects = data.objects.filter((object) => sources.includes(object.source_ref)).map((object) =>
      t('world.prompt.referenceItem', { title: object.name, reference: object.source_ref }))
    const selectedPages = data.pages.filter((page) => sources.includes(page.source_ref)).map((page) =>
      t('world.prompt.referenceItem', { title: page.title, reference: page.source_ref }))
    const selected = [...selectedObjects, ...selectedPages]
    const references = selected.length > 0 ? t('world.prompt.references', { references: selected.join('、') }) : ''
    const drafts = includeDrafts ? t('world.prompt.drafts') : ''
    const pageIntent = mode === 'bible_suggest'
      ? t('world.prompt.newPage')
      : t('world.prompt.mode', { mode: t(MODE_LABEL[mode]) })
    send(t('world.prompt.request', { intent: pageIntent, input, references, drafts }))
  }

  const canRun = Boolean(task.trim())

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('world.title')} aria-label={t('world.title')}>
        <span className={css.petLabel}>{t('world.title')}</span>
      </button>
      <NovelcraftModal open={open} onClose={() => setOpen(false)} title={t('world.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
        {error ? (
          <div className={css.emptyState} role="alert">
            <span>{t('common.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {data && data.bound == null ? <div className={css.empty}>{t('world.unbound')}</div> : null}
        {data?.bound ? (
          <div className={css.workflowPanel}>
            <div className={css.panelToolbar}>
              <div className={css.tabRow} role="tablist" aria-label={t('world.title')}>
                <Pill role="tab" aria-selected={view === 'create'} active={view === 'create'} onClick={() => setView('create')}>{t('world.tab.create')}</Pill>
                <Pill role="tab" aria-selected={view === 'content'} active={view === 'content'} onClick={() => setView('content')}>{t('world.tab.content')}</Pill>
              </div>
              <Button size="sm" variant="toolbar" icon={<IconRefreshOutline16 />}
                disabled={loading} onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
            </div>
            {notice ? <div className={css.message} role="status">{notice}</div> : null}
            {view === 'create' ? (
              <form className={css.workflowPanel} onSubmit={(event) => { event.preventDefault(); run() }}>
                <label className={css.presetControl}>
                  <span>{t('world.mode')}</span>
                  <select value={mode} onChange={(event) => setMode(event.currentTarget.value as Mode)}>
                    {(Object.keys(MODE_LABEL) as Mode[]).map((key) => (
                      <option key={key} value={key}>{t(MODE_LABEL[key])}</option>
                    ))}
                  </select>
                </label>
                <label className={css.presetControl}>
                  <span>{t('world.taskLabel')}</span>
                  <textarea className={css.outlineTask} placeholder={t('world.task')}
                    value={task} onChange={(event) => setTask(event.currentTarget.value)} />
                </label>
                <details className={css.disclosure}>
                  <summary>{t('world.references')} ({sources.length})</summary>
                  <div className={css.sourcePicker}>
                    {data.objects.map((object, index) => (
                      <label key={`object:${object.source_ref}:${index}`} className={css.sourceOption}>
                        <input type="checkbox" checked={sources.includes(object.source_ref)}
                          onChange={(event) => toggle(object.source_ref, event.currentTarget.checked)} />
                        <span>{object.name}{object.tags.length ? ` · ${object.tags.join(' / ')}` : ''}</span>
                      </label>
                    ))}
                    {data.pages.map((page, index) => (
                      <label key={`page:${page.source_ref}:${index}`} className={css.sourceOption}>
                        <input type="checkbox" checked={sources.includes(page.source_ref)}
                          onChange={(event) => toggle(page.source_ref, event.currentTarget.checked)} />
                        <span>{page.title}</span>
                      </label>
                    ))}
                    {data.objects.length + data.pages.length === 0 ? <div className={css.dossierEmpty}>{t('world.references.empty')}</div> : null}
                  </div>
                  <label className={css.sourceOption}>
                    <input type="checkbox" checked={includeDrafts}
                      onChange={(event) => setIncludeDrafts(event.currentTarget.checked)} />
                    <span>{t('world.includeDrafts')}</span>
                  </label>
                </details>
                <Button type="submit" variant="primary" disabled={!canRun}>{t(MODE_ACTION[mode])}</Button>
              </form>
            ) : (
              <div className={css.workflowPanel}>
                <section className={css.contentSection}>
                  <h3 className={css.sectionTitle}>{t('world.objects')}</h3>
                  {data.objects.length === 0 ? <div className={css.empty}>{t('world.objects.empty')}</div> : null}
                  {data.objects.map((object, index) => (
                    <article key={`object:${object.source_ref}:${index}`} className={css.workflowCard}>
                      <span className={css.cardTitle}>{object.name}</span>
                      {object.tags.length ? <span className={css.helperText}>{object.tags.join(' / ')}</span> : null}
                      <Button size="sm" variant="ghost" onClick={() => {
                        setSources([object.source_ref]); setMode('chat'); setView('create')
                      }}>{t('world.improve')}</Button>
                    </article>
                  ))}
                </section>
                <section className={css.contentSection}>
                  <h3 className={css.sectionTitle}>{t('world.pages')}</h3>
                  {data.pages.length === 0 ? <div className={css.empty}>{t('world.pages.empty')}</div> : null}
                  {data.pages.map((page, index) => (
                    <article key={`page:${page.source_ref}:${index}`} className={css.workflowCard}>
                      <header className={css.cardHeader}>
                        <span className={css.cardTitle}>{page.title}</span>
                        <Pill active={page.can_publish}>{page.can_publish ? t('world.page.draft') : t('world.page.published')}</Pill>
                      </header>
                      <p className={css.previewSummary}>{page.summary || t('world.page.noSummary')}</p>
                      <div className={css.actionRow}>
                        {page.can_publish ? (
                          <Button variant="primary" onClick={() => send(
                            t('world.prompt.publish', { title: page.title, reference: page.source_ref }),
                          )}>{t('world.publish')}</Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => {
                          setSources([page.source_ref]); setMode('chat'); setView('create')
                        }}>{t('world.improve')}</Button>
                      </div>
                    </article>
                  ))}
                </section>
              </div>
            )}
          </div>
        ) : null}
      </NovelcraftModal>
    </>
  )
}
