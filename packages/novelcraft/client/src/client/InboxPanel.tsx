// 收件箱面板(InboxPanel): 卡片列表 + 四动词 + 键盘流(j/k 选择, 1/2/3/4 动作,
// u 刷新, Escape 关闭)。四动词回宿主 assistant.act(确定性记录);
// adopt 由助手经 DSH approval 执行(§9 fail-closed)。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SignalCard } from '../wire.ts'
import { NS } from './locales.ts'
import { useInbox } from './useWatch.ts'
import { buildActPayload, type ActModifyFields, type InboxAction } from './actPayload.ts'
import css from './novelcraft.module.css'

export { buildActPayload, type ActModifyFields, type InboxAction } from './actPayload.ts'

export interface InboxPanelProps {
  connection: RpcCaller | undefined
  sessionId: string | undefined
  t: TranslateNS<typeof NS>
  onClose: () => void
}

const SEVERITY_DOT: Record<string, StateDotState> = {
  conflict: 'error',
  risk: 'warning',
  note: 'ongoing',
  hint: 'done',
}

const VERB_KEYS: Record<string, InboxAction> = {
  '1': 'accept',
  '2': 'reject',
  '3': 'modify',
  '4': 'defer',
}

/** 四动词按钮(含打回/改一改的内联理由行)。 */
function VerbRow(props: {
  card: SignalCard
  t: TranslateNS<typeof NS>
  busy: boolean
  onAct: (action: InboxAction, reason?: string, modified?: ActModifyFields) => void
}): JSX.Element {
  const { card, t, busy, onAct } = props
  const [pending, setPending] = useState<'reject' | 'modify' | null>(null)
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (pending) inputRef.current?.focus()
  }, [pending])

  const confirm = (): void => {
    if (pending === 'reject') {
      onAct('reject', reason)
    } else if (pending === 'modify') {
      onAct('modify', reason, { proposed_action: reason })
    }
    setPending(null)
    setReason('')
  }

  return (
    <div className={css.verbRow}>
      <div className={css.verbButtons}>
        <Button disabled={busy} onClick={() => onAct('accept')}>{t('inbox.verb.accept')}</Button>
        <Button disabled={busy} onClick={() => setPending('reject')}>{t('inbox.verb.reject')}</Button>
        <Button disabled={busy} onClick={() => setPending('modify')}>{t('inbox.verb.modify')}</Button>
        <Button disabled={busy} onClick={() => onAct('defer')}>{t('inbox.verb.defer')}</Button>
      </div>
      {pending ? (
        <div className={css.reasonRow}>
          <input
            ref={inputRef}
            className={css.reasonInput}
            value={reason}
            placeholder={t('inbox.reason.placeholder')}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') { setPending(null); setReason('') }
            }}
          />
          <Button disabled={!reason.trim() || busy} onClick={confirm}>{t('inbox.reason.confirm')}</Button>
        </div>
      ) : null}
    </div>
  )
}

export function InboxPanel(props: InboxPanelProps): JSX.Element {
  const { connection, sessionId, t, onClose } = props
  const { cards, bound, threshold, busy, refresh, actOn } = useInbox(connection, sessionId)
  const [selected, setSelected] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (selected >= cards.length && cards.length > 0) setSelected(0)
  }, [cards.length, selected])

  const handleAct = async (action: InboxAction, reason?: string, modified?: ActModifyFields): Promise<void> => {
    const card = cards[selected]
    if (!card) return
    // modified.title/proposed_action → wire modifiedTitle/modifiedProposedAction(buildActPayload)。
    const text = await actOn(buildActPayload(card, sessionId, action, reason, modified))
    setMessage(text ?? t('inbox.act.fail'))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const key = event.key
    if (key === 'j') { event.preventDefault(); setSelected((s) => Math.min(s + 1, cards.length - 1)); return }
    if (key === 'k') { event.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return }
    if (key === 'u') { event.preventDefault(); void refresh(); return }
    if (key === 'Escape') { event.preventDefault(); onClose(); return }
    const verb = VERB_KEYS[key]
    if (verb && !busy) {
      event.preventDefault()
      if (verb === 'accept' || verb === 'defer') void handleAct(verb)
      else setMessage(null)
    }
  }

  if (!bound) {
    return <div className={css.empty}>{t('inbox.unbound')}</div>
  }
  if (cards.length === 0) {
    return <div className={css.empty}>{t('inbox.empty')}</div>
  }

  return (
    <div ref={rootRef} tabIndex={0} className={css.inbox} onKeyDown={onKeyDown}>
      <div className={css.inboxMeta}>
        <span>{t('inbox.threshold')}: {threshold}</span>
        <Button onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
      </div>
      {message ? <div className={css.message}>{message}</div> : null}
      {cards.map((card, index) => (
        <article
          key={card.id}
          className={`${css.card} ${index === selected ? css.cardSelected : ''}`}
          onClick={() => setSelected(index)}
          data-selected={index === selected}
        >
          <header className={css.cardHeader}>
            <StateDot state={SEVERITY_DOT[card.severity] ?? 'done'} />
            <span className={css.cardTitle}>{card.title}</span>
            <span className={css.cardMeta}>{card.radar} · {t(`inbox.status.${card.status}` as never)}</span>
          </header>
          {card.evidence.length > 0 ? (
            <ul className={css.evidence}>
              {card.evidence.slice(0, 3).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : null}
          <p className={css.proposed}>{t('inbox.action')}: {card.proposed_action}</p>
          <VerbRow card={card} t={t} busy={busy} onAct={(a, r, m) => void handleAct(a, r, m)} />
        </article>
      ))}
      <footer className={css.keyboardHints}>j/k · 1-4 · u · Esc</footer>
    </div>
  )
}
