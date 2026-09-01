import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
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

export function WorkflowAction(props: WorkflowActionProps): JSX.Element {
  const { connection, inputActions, sessionId, t, useInput } = props
  const chatDraft = useInput((state) => state.draft)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const { data, loading, refresh } = useWorkflowView(connection, sessionId)

  const send = (prompt: string): void => {
    if (chatDraft.trim()) {
      setMessage(t('workflow.chatBusy'))
      return
    }
    inputActions.setDraft(prompt)
    inputActions.submit()
    setMessage(t('workflow.requested'))
  }

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('workflow.title')} aria-label={t('workflow.title')}>
        <span className={css.petLabel}>{t('workflow.title')}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('workflow.title')}
        closeLabel={t('inbox.close')} contentClassName={css.modalContent}>
        <div className={css.workflowPanel}>
          <div className={css.panelToolbar}>
            <span className={css.chapterWorkspaceMeta}>{data?.bound?.book ?? ''}</span>
            <button type="button" className={css.actionButton} disabled={loading} onClick={() => void refresh()}>
              {loading ? t('workflow.loading') : t('inbox.refresh')}
            </button>
          </div>
          {message ? <div className={css.message} role="status">{message}</div> : null}
          {data?.bound == null ? <div className={css.empty}>{t('workflow.unbound')}</div> : null}
          {data?.bound != null && data.runs.length === 0 ? <div className={css.empty}>{t('workflow.empty')}</div> : null}
          {data?.runs.map((run) => (
            <article key={`${run.kind}:${run.workflow_id}`} className={css.workflowCard}>
              <header className={css.cardHeader}>
                <span className={css.cardTitle}>{run.kind === 'deep-import' ? t('workflow.kind.import') : t('workflow.kind.atlas')}</span>
                <span className={`${css.statePill} ${STATE_CLASS[run.state]}`}>
                  {t(`workflow.state.${run.state}`)}
                </span>
              </header>
              <div className={css.progressTrack} aria-label={t('workflow.progress')}>
                <span style={{ width: `${run.total_batches > 0 ? Math.round(run.completed_batches / run.total_batches * 100) : 0}%` }} />
              </div>
              <p className={css.proposed}>{run.message}</p>
              <div className={css.chapterWorkspaceMeta}>
                {t('workflow.progress')}: {run.completed_batches}/{run.total_batches || '—'}
              </div>
              <div className={css.actionRow}>
                {run.can_resume ? <button type="button" className={css.actionButton} onClick={() => send(
                  `请调用 novelcraft_workflow_resume，workflow_id=${JSON.stringify(run.workflow_id)}。`,
                )}>{t('workflow.resume')}</button> : null}
                {run.can_abandon ? <button type="button" className={css.actionButton} onClick={() => send(
                  `请调用 novelcraft_workflow_abandon，kind=${run.kind}，workflow_id=${JSON.stringify(run.workflow_id)}。`,
                )}>{t('workflow.abandon')}</button> : null}
              </div>
            </article>
          ))}
          {data?.restart_scope ? (
            <section className={css.workflowRestart}>
              <div className={css.sectionTitle}>{t('workflow.restart')}</div>
              <p className={css.proposed}>{t('workflow.restartHint')} {data.restart_scope.start_chapter}–{data.restart_scope.end_chapter}</p>
              <button type="button" className={css.actionButton} onClick={() => send(
                `请调用 novelcraft_workflow_start_new，start_chapter=${data.restart_scope!.start_chapter}，end_chapter=${data.restart_scope!.end_chapter}。`,
              )}>{t('workflow.restart')}</button>
            </section>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
