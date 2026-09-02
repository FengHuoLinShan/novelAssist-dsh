import { useState } from 'react'
import { Button, IconRefreshOutline16, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS } from './locales.ts'
import { useWorkflowView } from './useWatch.ts'
import css from './novelcraft.module.css'

export type WorkflowActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

const STATE_CLASS = {
  running: css.state_running,
  'needs-attention': css.state_needsAttention,
  completed: css.state_completed,
  failed: css.state_failed,
} as const

const PRIORITY = { 'needs-attention': 0, failed: 1, running: 2, completed: 3 } as const

export function WorkflowAction(props: WorkflowActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const { data, loading, error, refresh } = useWorkflowView(connection, sessionId)

  const send = (prompt: string): void => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setMessage(t('workflow.chatBusy'))
  }

  const runs = [...(data?.runs ?? [])].sort((left, right) => PRIORITY[left.state] - PRIORITY[right.state])
  const activeRuns = runs.filter((run) => run.state !== 'completed')
  const completedRuns = runs.filter((run) => run.state === 'completed')
  const canRestart = activeRuns.some((run) => run.kind === 'deep-import' && (run.state === 'failed' || run.state === 'needs-attention'))

  const card = (run: (typeof runs)[number]) => {
    const label = run.kind === 'deep-import' ? t('workflow.kind.import') : t('workflow.kind.atlas')
    const percent = run.total_batches > 0 ? Math.round(run.completed_batches / run.total_batches * 100) : 0
    return (
      <article key={`${run.kind}:${run.workflow_id}`} className={css.workflowCard}>
        <header className={css.cardHeader}>
          <span className={css.cardTitle}>{label}</span>
          <Pill className={STATE_CLASS[run.state]}>{t(`workflow.state.${run.state}`)}</Pill>
        </header>
        <div className={css.progressTrack} aria-label={t('workflow.progress')}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className={css.proposed}>{run.message}</p>
        <div className={css.chapterWorkspaceMeta}>
          {t('workflow.progress')}：{run.completed_batches}/{run.total_batches || '—'}
        </div>
        <div className={css.actionRow}>
          {run.can_resume ? (
            <Button variant="primary" onClick={() => send(
              t('workflow.prompt.resume', { kind: label, id: run.workflow_id }),
            )}>{t('workflow.resume')}</Button>
          ) : null}
          {run.can_abandon ? (
            <Button size="sm" variant="outline" onClick={() => send(
              t('workflow.prompt.clear', { kind: label, id: run.workflow_id }),
            )}>{t('workflow.abandon')}</Button>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('workflow.title')} aria-label={t('workflow.title')}>
        <span className={css.petLabel}>{t('workflow.title')}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('workflow.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        <div className={css.workflowPanel}>
          <div className={css.panelToolbar}>
            <span className={css.chapterWorkspaceMeta}>{data?.bound?.book ?? ''}</span>
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
          {data?.bound == null && data !== null ? <div className={css.empty}>{t('workflow.unbound')}</div> : null}
          {data?.bound != null && runs.length === 0 ? <div className={css.empty}>{t('workflow.empty')}</div> : null}
          {activeRuns.map(card)}
          {canRestart && data?.restart_scope ? (
            <details className={css.disclosure}>
              <summary>{t('workflow.otherActions')}</summary>
              <div className={css.workflowRestart}>
                <p className={css.proposed}>{t('workflow.restartHint')} {data.restart_scope.start_chapter}–{data.restart_scope.end_chapter}</p>
                <Button variant="outline" onClick={() => send(
                  t('workflow.prompt.restart', {
                    start: data.restart_scope!.start_chapter,
                    end: data.restart_scope!.end_chapter,
                  }),
                )}>{t('workflow.restart')}</Button>
              </div>
            </details>
          ) : null}
          {completedRuns.length > 0 ? (
            <details className={css.disclosure}>
              <summary>{t('workflow.history')} ({completedRuns.length})</summary>
              <div className={css.workflowPanel}>{completedRuns.map(card)}</div>
            </details>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
