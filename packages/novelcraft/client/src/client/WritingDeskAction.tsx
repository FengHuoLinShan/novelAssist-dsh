// 写作台(WritingDeskAction): 会话头动作, 打开写作台 Modal(四模式: 守望/计划/评审/参照)。
// 数据源 = /novelcraft writing/desk(宿主读 assistant 信号 + store.storyMap/rebuildIndex
// + .assistant/reviews)。纯读, 无动作; 四模式切换为本地 tab。
import { useState } from 'react'
import { Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type NovelcraftKey } from './locales.ts'
import { useWritingDesk } from './useWatch.ts'
import { ChapterDossier } from './ChapterDossier.tsx'
import css from './novelcraft.module.css'

export type WritingDeskActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type Mode = 'watch' | 'plan' | 'review' | 'reference'

const SEVERITY_DOT: Record<string, StateDotState> = {
  conflict: 'error', risk: 'warning', note: 'ongoing', hint: 'done',
}

function ModeTab(props: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={props.active ? css.tab + ' ' + css.tabActive : css.tab}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

export function WritingDeskAction(props: WritingDeskActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('watch')
  /** 钻取中章节(章节档案 §17.5.1); null = tab 视图。 */
  const [dossierChapter, setDossierChapter] = useState<number | null>(null)
  const { data } = useWritingDesk(connection, sessionId)

  const bound = data?.bound != null
  const signals = data?.signals ?? []
  const chapters = data?.chapters ?? []
  const threads = data?.threads ?? []
  const arcs = data?.arcs ?? []
  const objects = data?.objects ?? []
  const reviews = data?.reviews ?? []
  const proposals = data?.proposals ?? null

  const tab = (m: Mode, key: NovelcraftKey): JSX.Element => (
    <ModeTab label={t(key)} active={mode === m} onClick={() => setMode(m)} />
  )

  return (
    <>
      <button
        type="button"
        className={css.petTrigger}
        title={t('desk.title')}
        aria-label={t('desk.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={css.petLabel}>{t('desk.title')}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('desk.title')}
        closeLabel={t('inbox.close')}
        contentClassName={css.modalContent}
      >
        {!bound ? (
          <div className={css.empty}>{t('desk.unbound')}</div>
        ) : dossierChapter != null ? (
          <ChapterDossier
            connection={connection}
            sessionId={sessionId}
            t={t}
            chapterIndex={dossierChapter}
            onBack={() => setDossierChapter(null)}
          />
        ) : (
          <div>
            <div className={css.tabRow}>
              {tab('watch', 'desk.mode.watch')}
              {tab('plan', 'desk.mode.plan')}
              {tab('review', 'desk.mode.review')}
              {tab('reference', 'desk.mode.reference')}
            </div>

            {mode === 'watch' ? (
              signals.length === 0 ? (
                <div className={css.empty}>{t('inbox.empty')}</div>
              ) : (
                signals.map((s) => (
                  <article key={s.id} className={css.card}>
                    <header className={css.cardHeader}>
                      <StateDot state={SEVERITY_DOT[s.severity] ?? 'done'} />
                      <span className={css.cardTitle}>{s.title}</span>
                      <span className={css.cardMeta}>{s.radar}</span>
                    </header>
                    <p className={css.proposed}>{t('inbox.action')}: {s.proposed_action}</p>
                  </article>
                ))
              )
            ) : mode === 'plan' ? (
              <div>
                <div className={css.sectionTitle}>{t('desk.chapters')}</div>
                {chapters.length === 0 ? (
                  <div className={css.empty}>{t('desk.empty')}</div>
                ) : (
                  chapters.map((c) => (
                    <button
                      key={c.index}
                      type="button"
                      className={css.chapterRow}
                      onClick={() => setDossierChapter(c.index)}
                    >
                      <span className={css.chapterRowIndex}>ch{c.index}</span>
                      <span>{c.title ?? ''}</span>
                    </button>
                  ))
                )}
                <div className={css.sectionTitle}>{t('story.threads')}</div>
                {threads.map((x) => <div key={x.slug} className={css.itemLine}>{x.name}{x.thread_type ? ' · ' + x.thread_type : ''}</div>)}
                <div className={css.sectionTitle}>{t('story.arcs')}</div>
                {arcs.map((x) => <div key={x.slug} className={css.itemLine}>{x.name}</div>)}
                <div className={css.sectionTitle}>{t('desk.proposals')}</div>
                {proposals == null || proposals.proposals.length === 0 ? (
                  <div className={css.empty}>{t('desk.proposals.empty')}</div>
                ) : (
                  <div>
                    <div className={css.itemLine}>{t('desk.chapters')} {proposals.next_chapter}</div>
                    {proposals.proposals.map((prop) => (
                      <article key={prop.title} className={css.card}>
                        <header className={css.cardHeader}>
                          <span className={css.cardTitle}>{prop.title}</span>
                        </header>
                        <p className={css.proposed}>{prop.premise}</p>
                        {prop.basis != null && prop.basis.length > 0 ? <p className={css.proposed}>{t('desk.proposals.basis')}: {prop.basis.join(' / ')}</p> : null}
                        {prop.cost ? <p className={css.proposed}>{t('desk.proposals.cost')}: {prop.cost}</p> : null}
                        {prop.risk ? <p className={css.proposed}>{t('desk.proposals.risk')}: {prop.risk}</p> : null}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : mode === 'review' ? (
              reviews.length === 0 ? (
                <div className={css.empty}>{t('desk.reviews.empty')}</div>
              ) : (
                reviews.map((x) => (
                  <article key={x.review_id} className={css.card}>
                    <header className={css.cardHeader}>
                      <span className={css.cardTitle}>{t('desk.chapters')} {x.chapter_index}</span>
                      <span className={css.cardMeta}>{x.verdict} · {x.finding_count} 条</span>
                    </header>
                  </article>
                ))
              )
            ) : (
              objects.length === 0 ? (
                <div className={css.empty}>{t('desk.empty')}</div>
              ) : (
                objects.map((o) => (
                  <article key={o.slug} className={css.card}>
                    <header className={css.cardHeader}>
                      <span className={css.cardTitle}>{o.name}</span>
                      <span className={css.cardMeta}>{o.kind} · {o.status}</span>
                    </header>
                  </article>
                ))
              )
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
