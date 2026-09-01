import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { NS } from './locales.ts'
import { useBookLibrary } from './useWatch.ts'
import css from './novelcraft.module.css'

export type BookLibraryActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

export function BookLibraryAction(props: BookLibraryActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const { data, loading, refresh } = useBookLibrary(connection, sessionId)

  const send = (prompt: string): void => {
    if (chatDraft.trim()) {
      setMessage(t('book.chatBusy'))
      return
    }
    inputActions.setDraft(prompt)
    inputActions.submit()
    setMessage(t('book.requested'))
  }

  const create = (): void => {
    const book = name.trim()
    if (!book) return
    send(`请调用 novelcraft_book_create，book=${JSON.stringify(book)}。`)
  }

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('book.title')} aria-label={t('book.title')}>
        <span className={css.petLabel}>{t('book.title')}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('book.title')}
        closeLabel={t('inbox.close')} contentClassName={css.modalContent}>
        <div className={css.workflowPanel}>
          <div className={css.panelToolbar}>
            <span className={css.chapterWorkspaceMeta}>
              {data?.bound ? `${t('book.current')}: ${data.bound.book}` : t('book.unbound')}
            </span>
            <button type="button" className={css.actionButton} disabled={loading} onClick={() => void refresh()}>
              {loading ? t('workflow.loading') : t('inbox.refresh')}
            </button>
          </div>
          {message ? <div className={css.message} role="status">{message}</div> : null}
          {data && data.books.length === 0 ? <div className={css.empty}>{t('book.empty')}</div> : null}
          {data?.books.map((book) => (
            <article key={book.book} className={css.workflowCard}>
              <header className={css.cardHeader}>
                <span className={css.cardTitle}>{book.title}</span>
                {book.current ? <span className={`${css.statePill} ${css.state_completed}`}>{t('book.current')}</span> : null}
              </header>
              <div className={css.chapterWorkspaceMeta}>{book.book}</div>
              {!book.current ? (
                <button type="button" className={css.actionButton}
                  onClick={() => send(`请调用 novelcraft_book_open，book=${JSON.stringify(book.book)}。`)}>
                  {t('book.open')}
                </button>
              ) : null}
            </article>
          ))}
          <section className={css.workflowRestart}>
            <label className={css.sectionTitle} htmlFor="novelcraft-new-book">{t('book.create')}</label>
            <div className={css.bookCreateRow}>
              <input id="novelcraft-new-book" className={css.bookNameInput} value={name}
                placeholder={t('book.name')} onChange={(event) => setName(event.currentTarget.value)} />
              <button type="button" className={css.actionButton} disabled={!name.trim()} onClick={create}>
                {t('book.create')}
              </button>
            </div>
          </section>
        </div>
      </Modal>
    </>
  )
}
