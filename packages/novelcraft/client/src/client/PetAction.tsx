// 宠物(PetAction): 会话头动作；先呈现连接新鲜度，再呈现守望业务状态。
import { useState, type KeyboardEvent } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS } from './locales.ts'
import { petState, useWatch } from './useWatch.ts'
import { InboxPanel } from './InboxPanel.tsx'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import css from './novelcraft.module.css'

export type PetActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

export function PetAction(props: PetActionProps): JSX.Element {
  const { t, connection, sessionId, inputActions, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const { snapshot } = useWatch(connection, sessionId)
  const state = petState(snapshot)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen((v) => !v)
    }
  }

  const title = snapshot.bound && snapshot.book
    ? `${t('pet.title')} · ${snapshot.book}`
    : t('pet.title')

  return (
    <>
      <button
        type="button"
        className={css.petTrigger}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <StateDot state={state.dot} />
        <span className={css.petLabel}>{t(state.label)}</span>
        {snapshot.open > 0 ? <span className={css.petBadge}>{snapshot.open}</span> : null}
      </button>
      <NovelcraftModal
        open={open}
        onClose={() => setOpen(false)}
        title={`${t('inbox.title')}${snapshot.bound && snapshot.book ? ` · ${snapshot.book}` : ''}`}
        closeLabel={t('inbox.close')}
        className={css.dialog}
        contentClassName={css.modalContent}
      >
        {/* 仅在线静默态展示剧情摘要，断线时不把旧数据冒充当前状态。 */}
        {snapshot.availability === 'live' && snapshot.open === 0 && snapshot.plotSummary ? (
          <p className={css.plotSummary} aria-label={t('pet.plot')}>
            {t('pet.plot')}: {snapshot.plotSummary}
          </p>
        ) : null}
        <InboxPanel
          connection={connection}
          sessionId={sessionId}
          t={t}
          onClose={() => setOpen(false)}
          onContinue={(prompt) => handoffToAssistant({
            draft: chatDraft,
            prompt,
            setDraft: inputActions.setDraft,
            submit: inputActions.submit,
            close: () => setOpen(false),
          })}
        />
      </NovelcraftModal>
    </>
  )
}
