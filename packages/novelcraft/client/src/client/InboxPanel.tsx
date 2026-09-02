import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Input, Pill, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SignalCard } from '../wire.ts'
import { NS, type NovelcraftKey } from './locales.ts'
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
  conflict: 'error', risk: 'warning', note: 'ongoing', hint: 'done',
}

const RADAR_LABEL: Record<string, NovelcraftKey> = {
  ingest: 'inbox.category.ingest',
  dedup: 'inbox.category.dedup',
  suggest: 'inbox.category.suggest',
  plot: 'inbox.category.plot',
  risk: 'inbox.category.risk',
  writing: 'inbox.category.writing',
}

const visibleEvidence = (lines: string[]): string[] => lines.filter((line) =>
  !/^(receipt|sha256|base|node):/i.test(line) && !line.includes('chapter_ids'),
)

function VerbRow(props: {
  t: TranslateNS<typeof NS>
  busy: boolean
  onAct: (action: InboxAction, reason?: string, modified?: ActModifyFields) => void
}): JSX.Element {
  const { t, busy, onAct } = props
  const [pending, setPending] = useState<'reject' | 'modify' | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (pending) document.getElementById('novelcraft-inbox-reason')?.focus()
  }, [pending])

  const confirm = (): void => {
    if (pending === 'reject') onAct('reject', reason)
    if (pending === 'modify') onAct('modify', reason, { proposed_action: reason })
    setPending(null)
    setReason('')
  }

  return (
    <div className={css.verbRow}>
      <div className={css.verbButtons}>
        <Button variant="primary" disabled={busy} onClick={() => onAct('accept')}>{t('inbox.verb.accept')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => setPending('modify')}>{t('inbox.verb.modify')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setPending('reject')}>{t('inbox.verb.reject')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => onAct('defer')}>{t('inbox.verb.defer')}</Button>
      </div>
      {pending ? (
        <form className={css.reasonRow} onSubmit={(event) => { event.preventDefault(); confirm() }}>
          <label className={css.visuallyHidden} htmlFor="novelcraft-inbox-reason">
            {t(pending === 'reject' ? 'inbox.reason.reject' : 'inbox.reason.modify')}
          </label>
          <Input id="novelcraft-inbox-reason" className={css.reasonInput}
            value={reason} placeholder={t(pending === 'reject' ? 'inbox.reason.reject' : 'inbox.reason.modify')}
            onChange={(event) => setReason(event.currentTarget.value)} />
          <Button type="submit" variant="primary" disabled={!reason.trim() || busy}>{t('inbox.reason.confirm')}</Button>
        </form>
      ) : null}
    </div>
  )
}

export function InboxPanel(props: InboxPanelProps): JSX.Element {
  const { connection, sessionId, t, onClose } = props
  const { cards, bound, busy, loading, error, refresh, actOn } = useInbox(connection, sessionId)
  const [selected, setSelected] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (selected !== null && selected >= cards.length) setSelected(null)
  }, [cards.length, selected])

  const handleAct = async (
    card: SignalCard,
    action: InboxAction,
    reason?: string,
    modified?: ActModifyFields,
  ): Promise<void> => {
    const text = await actOn(buildActPayload(card, sessionId, action, reason, modified))
    setMessage(text ?? t('inbox.act.fail'))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'u') { event.preventDefault(); void refresh(); return }
    if (event.key === 'j') {
      event.preventDefault()
      setSelected((current) => Math.min((current ?? -1) + 1, cards.length - 1))
      return
    }
    if (event.key === 'k') {
      event.preventDefault()
      setSelected((current) => Math.max((current ?? 1) - 1, 0))
    }
  }

  if (loading && cards.length === 0) return <div className={css.empty}>{t('common.loading')}</div>
  if (error) {
    return (
      <div className={css.emptyState} role="alert">
        <span>{t('common.loadFailed')}</span>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
      </div>
    )
  }
  if (!bound) return <div className={css.empty}>{t('inbox.unbound')}</div>
  if (cards.length === 0) return <div className={css.empty}>{t('inbox.empty')}</div>

  return (
    <div ref={rootRef} tabIndex={0} className={css.inbox} onKeyDown={onKeyDown}>
      <div className={css.inboxMeta}>
        <span>{t('inbox.count')}：{cards.length}</span>
        <Button size="sm" variant="toolbar" onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
      </div>
      {message ? <div className={css.message} role="status">{message}</div> : null}
      {cards.map((card, index) => {
        const expanded = index === selected
        const evidence = visibleEvidence(card.evidence)
        return (
          <article key={card.id} className={`${css.card} ${expanded ? css.cardSelected : ''}`}>
            <button type="button" className={css.cardSummary} aria-expanded={expanded}
              onClick={() => setSelected(expanded ? null : index)}>
              <StateDot state={SEVERITY_DOT[card.severity] ?? 'done'} />
              <span className={css.cardTitle}>{card.title}</span>
              <Pill>{t(RADAR_LABEL[card.radar] ?? 'inbox.category.other')}</Pill>
            </button>
            {expanded ? (
              <div className={css.cardDetails}>
                {evidence.length > 0 ? (
                  <details className={css.disclosure}>
                    <summary>{t('inbox.evidence')}</summary>
                    <ul className={css.evidence}>{evidence.map((line, i) => <li key={i}>{line}</li>)}</ul>
                  </details>
                ) : null}
                <p className={css.proposed}>{t('inbox.action')}：{card.proposed_action}</p>
                <VerbRow t={t} busy={busy} onAct={(action, reason, modified) => {
                  void handleAct(card, action, reason, modified)
                }} />
              </div>
            ) : null}
          </article>
        )
      })}
      <footer className={css.keyboardHints}>{t('inbox.keyboard')}</footer>
    </div>
  )
}
