// 宠物(PetAction): 会话头动作, 四态 = 静默/微光/忙碌/待确认(§17)。
// 数据源 = /novelcraft watch/state RPC(宿主读 .assistant/signals 与 jobs)。
import { useState, type KeyboardEvent } from 'react'
import { Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type NovelcraftKey } from './locales.ts'
import { useWatch } from './useWatch.ts'
import { InboxPanel } from './InboxPanel.tsx'
import css from './novelcraft.module.css'

export type PetActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

interface PetState {
  label: NovelcraftKey
  dot: StateDotState
}

/** 四态判定: 待确认 > 忙碌 > 微光 > 静默(阈值 N3: notify_threshold)。 */
function petState(open: number, threshold: number, radarRunning: boolean): PetState {
  if (open >= threshold) return { label: 'pet.attention', dot: 'error' }
  if (radarRunning) return { label: 'pet.busy', dot: 'warning' }
  if (open > 0) return { label: 'pet.glow', dot: 'ongoing' }
  return { label: 'pet.silent', dot: 'done' }
}

export function PetAction(props: PetActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const { snapshot } = useWatch(connection, sessionId)
  const state = petState(snapshot.open, snapshot.threshold, snapshot.radarRunning)

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
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${t('inbox.title')}${snapshot.bound && snapshot.book ? ` · ${snapshot.book}` : ''}`}
        closeLabel={t('inbox.close')}
        contentClassName={css.modalContent}
      >
        <InboxPanel
          connection={connection}
          sessionId={sessionId}
          t={t}
          onClose={() => setOpen(false)}
        />
      </Modal>
    </>
  )
}
