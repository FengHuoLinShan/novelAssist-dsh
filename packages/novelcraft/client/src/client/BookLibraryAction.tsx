import { useState } from 'react'
import { Button, IconRefreshOutline16, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS } from './locales.ts'
import { useBookLibrary } from './useWatch.ts'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import css from './novelcraft.module.css'

export type BookLibraryActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

export function BookLibraryAction(props: BookLibraryActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const { data, loading, error, refresh } = useBookLibrary(connection, sessionId)

  const send = (prompt: string): void => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setMessage(t('book.chatBusy'))
  }

  const create = (): void => {
    const book = name.trim()
    if (!book) return
    send(t('book.prompt.create', { book }))
  }

  const books = [...(data?.books ?? [])].sort((left, right) => Number(right.current) - Number(left.current))
  const showCreator = createOpen || (data !== null && books.length === 0)

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('book.title')} aria-label={t('book.title')}>
        <span className={css.petLabel}>{t('book.title')}</span>
      </button>
      <NovelcraftModal open={open} onClose={() => setOpen(false)} title={t('book.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        <div className={css.workflowPanel}>
          <div className={css.panelToolbar}>
            <span className={css.chapterWorkspaceMeta}>
              {data?.bound ? `${t('book.current')}：${data.bound.book}` : t('book.unbound')}
            </span>
            <Button size="sm" variant="toolbar" icon={<IconRefreshOutline16 />}
              disabled={loading} onClick={() => void refresh()}>
              {loading ? t('workflow.loading') : t('inbox.refresh')}
            </Button>
          </div>
          {message ? <div className={css.message} role="status">{message}</div> : null}
          {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
          {error ? (
            <div className={css.emptyState} role="alert">
              <span>{t('common.loadFailed')}</span>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
            </div>
          ) : null}
          {data && books.length === 0 ? <div className={css.empty}>{t('book.empty')}</div> : null}
          {books.map((book) => (
            <article key={book.book} className={css.workflowCard}>
              <header className={css.cardHeader}>
                <span className={css.cardTitle}>{book.title}</span>
                {book.current ? <Pill active>{t('book.current')}</Pill> : null}
              </header>
              {!book.current ? (
                <Button size="sm" variant="outline" onClick={() => send(t('book.prompt.open', {
                  title: book.title,
                  book: book.book,
                }))}>
                  {t('book.open')}
                </Button>
              ) : null}
            </article>
          ))}
          {data && books.length > 0 && !showCreator ? (
            <Button variant="ghost" onClick={() => setCreateOpen(true)}>{t('book.createToggle')}</Button>
          ) : null}
          {showCreator ? (
            <form className={css.workflowRestart} onSubmit={(event) => { event.preventDefault(); create() }}>
              <label className={css.sectionTitle} htmlFor="novelcraft-new-book">{t('book.nameLabel')}</label>
              <p className={css.helperText}>{t('book.createHint')}</p>
              <div className={css.bookCreateRow}>
                <Input id="novelcraft-new-book" className={css.bookNameInput} value={name}
                  placeholder={t('book.name')} onChange={(event) => setName(event.currentTarget.value)} />
                <Button type="submit" variant="primary" disabled={!name.trim()}>{t('book.create')}</Button>
              </div>
            </form>
          ) : null}
        </div>
      </NovelcraftModal>
    </>
  )
}
