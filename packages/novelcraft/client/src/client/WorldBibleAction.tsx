import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { NS } from './locales.ts'
import { BOOK_CHANGED_EVENT, matchesBookChangedSession, useWorldWorkspace, type BookChangedDetail } from './useWatch.ts'
import css from './novelcraft.module.css'

export type WorldBibleActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type Mode = 'chat' | 'converge' | 'explore' | 'inspect' | 'bible_suggest'

const TOOL: Record<Mode, string> = {
  chat: 'novelcraft_world_chat',
  converge: 'novelcraft_world_converge',
  explore: 'novelcraft_world_explore',
  inspect: 'novelcraft_world_inspect',
  bible_suggest: 'novelcraft_world_bible_suggest',
}

export function WorldBibleAction(props: WorldBibleActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('chat')
  const [task, setTask] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [newPage, setNewPage] = useState(true)
  const [notice, setNotice] = useState('')
  const { data, loading, refresh } = useWorldWorkspace(connection, sessionId)

  useEffect(() => {
    const reset = (event?: Event) => {
      if (event && !matchesBookChangedSession((event as CustomEvent<BookChangedDetail>).detail, sessionId)) return
      setOpen(false)
      setMode('chat')
      setTask('')
      setSources([])
      setIncludeDrafts(false)
      setNewPage(true)
      setNotice('')
    }
    reset()
    window.addEventListener(BOOK_CHANGED_EVENT, reset)
    return () => window.removeEventListener(BOOK_CHANGED_EVENT, reset)
  }, [sessionId])

  const send = (prompt: string): void => {
    if (chatDraft.trim()) {
      setNotice(t('world.chatBusy'))
      return
    }
    inputActions.setDraft(prompt)
    inputActions.submit()
    setNotice(t('world.requested'))
  }

  const toggle = (ref: string, checked: boolean): void => {
    setSources((current) => checked ? [...new Set([...current, ref])] : current.filter((item) => item !== ref))
  }

  const run = (): void => {
    const input = task.trim()
    if (!input) return
    const suffix = `input=${JSON.stringify(input)}，source_refs=${JSON.stringify(sources)}，include_working_drafts=${includeDrafts}`
    send(`请调用 ${TOOL[mode]}，${suffix}${mode === 'bible_suggest' ? `，is_new_page=${newPage}` : ''}。`)
  }

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('world.title')} aria-label={t('world.title')}>
        <span className={css.petLabel}>{t('world.title')}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('world.title')}
        closeLabel={t('inbox.close')} contentClassName={css.modalContent}>
        <div className={css.workflowPanel}>
          <div className={css.panelToolbar}>
            <span className={css.chapterWorkspaceMeta}>{data?.bound?.book ?? ''}</span>
            <button type="button" className={css.actionButton} disabled={loading} onClick={() => void refresh()}>
              {loading ? t('workflow.loading') : t('inbox.refresh')}
            </button>
          </div>
          {notice ? <div className={css.message} role="status">{notice}</div> : null}
          {data?.bound == null ? <div className={css.empty}>{t('world.unbound')}</div> : (
            <>
              <label className={css.presetControl}>
                <span>{t('world.mode')}</span>
                <select value={mode} onChange={(event) => setMode(event.currentTarget.value as Mode)}>
                  <option value="chat">{t('world.mode.chat')}</option>
                  <option value="converge">{t('world.mode.converge')}</option>
                  <option value="explore">{t('world.mode.explore')}</option>
                  <option value="inspect">{t('world.mode.inspect')}</option>
                  <option value="bible_suggest">{t('world.mode.bible')}</option>
                </select>
              </label>
              <textarea className={css.outlineTask} aria-label={t('world.task')}
                placeholder={t('world.task')} value={task}
                onChange={(event) => setTask(event.currentTarget.value)} />
              <div className={css.sectionTitle}>{t('world.objects')}</div>
              {data.objects.length === 0 ? <div className={css.dossierEmpty}>{t('world.objects.empty')}</div> : null}
              <div className={css.sourcePicker}>
                {data.objects.map((object) => (
                  <label key={object.source_ref} className={css.sourceOption}>
                    <input type="checkbox" checked={sources.includes(object.source_ref)}
                      onChange={(event) => toggle(object.source_ref, event.currentTarget.checked)} />
                    <span>{object.name} · {object.entity_type} · {object.status}{object.tags.length ? ` · ${object.tags.join(' / ')}` : ''}</span>
                  </label>
                ))}
              </div>
              <div className={css.sectionTitle}>{t('world.pages')}</div>
              {data.pages.length === 0 ? <div className={css.dossierEmpty}>{t('world.pages.empty')}</div> : null}
              {data.pages.map((page) => (
                <article key={page.source_ref} className={css.workflowCard}>
                  <label className={css.sourceOption}>
                    <input type="checkbox" checked={sources.includes(page.source_ref)}
                      onChange={(event) => toggle(page.source_ref, event.currentTarget.checked)} />
                    <span className={css.cardTitle}>{page.title}</span>
                    <span className={css.cardMeta}>{page.status} · v{page.version_number}</span>
                  </label>
                  <p className={css.previewSummary}>{page.summary || t('world.page.noSummary')}</p>
                  {page.can_publish ? (
                    <button type="button" className={css.actionButton} onClick={() => send(
                      `请调用 novelcraft_store_adopt，kind=bible_page，ref=${JSON.stringify(page.source_ref)}。`,
                    )}>{t('world.publish')}</button>
                  ) : null}
                </article>
              ))}
              <label className={css.sourceOption}>
                <input type="checkbox" checked={includeDrafts}
                  onChange={(event) => setIncludeDrafts(event.currentTarget.checked)} />
                <span>{t('world.includeDrafts')}</span>
              </label>
              {mode === 'bible_suggest' ? (
                <label className={css.sourceOption}>
                  <input type="checkbox" checked={newPage}
                    onChange={(event) => setNewPage(event.currentTarget.checked)} />
                  <span>{t('world.newPage')}</span>
                </label>
              ) : null}
              <button type="button" className={css.actionButton} disabled={!task.trim()} onClick={run}>
                {t('world.run')}
              </button>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
