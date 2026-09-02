import { useEffect, useState } from 'react'
import { Button, IconRefreshOutline16, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS, type NovelcraftKey } from './locales.ts'
import { BOOK_CHANGED_EVENT, matchesBookChangedSession, useStoryMap, type BookChangedDetail } from './useWatch.ts'
import { ChapterDossier } from './ChapterDossier.tsx'
import css from './novelcraft.module.css'

export type StoryMapActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type StoryEdge = { source: string; target: string; type: string; status: string; sourceKind?: string }

const EDGE_TYPES: Array<{ type: string; key: NovelcraftKey; className: string }> = [
  { type: 'serves_thread', key: 'story.edge.serves_thread', className: css.edgeServesThread },
  { type: 'belongs_to_arc', key: 'story.edge.belongs_to_arc', className: css.edgeBelongsToArc },
  { type: 'reveals_foreshadowing', key: 'story.edge.reveals_foreshadowing', className: css.edgeRevealsForeshadowing },
  { type: 'pays_off_in_scene', key: 'story.edge.pays_off_in_scene', className: css.edgePaysOffInScene },
  { type: 'references_character', key: 'story.edge.references_character', className: css.edgeReferencesCharacter },
  { type: 'references_entity', key: 'story.edge.references_entity', className: css.edgeReferencesEntity },
  { type: 'references_memory', key: 'story.edge.references_memory', className: css.edgeReferencesMemory },
]

function groupEdges(edges: StoryEdge[]): Array<{ type: string; edges: StoryEdge[] }> {
  const groups = EDGE_TYPES.flatMap((spec) => {
    const matches = edges.filter((edge) => edge.type === spec.type)
    return matches.length > 0 ? [{ type: spec.type, edges: matches }] : []
  })
  const known = new Set(EDGE_TYPES.map((spec) => spec.type))
  const others = edges.filter((edge) => !known.has(edge.type))
  return others.length > 0 ? [...groups, { type: 'other', edges: others }] : groups
}

function Section(props: { title: string; lines: string[] }): JSX.Element | null {
  if (props.lines.length === 0) return null
  return (
    <section className={css.contentSection}>
      <h3 className={css.sectionTitle}>{props.title}</h3>
      {props.lines.map((line, index) => <div key={index} className={css.itemLine}>{line}</div>)}
    </section>
  )
}

export function StoryMapAction(props: StoryMapActionProps): JSX.Element {
  const { t, connection, inputActions, sessionId, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'view' | 'plan'>('view')
  const [chapter, setChapter] = useState<number | null>(null)
  const [outlineTask, setOutlineTask] = useState('')
  const [outlineTarget, setOutlineTarget] = useState<'story_outline' | 'plot_thread' | 'outline_arc'>('story_outline')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [includeWorkingDrafts, setIncludeWorkingDrafts] = useState(false)
  const [notice, setNotice] = useState('')
  const { data, loading, error, refresh } = useStoryMap(connection, sessionId)

  useEffect(() => {
    const reset = (event?: Event) => {
      if (event && !matchesBookChangedSession((event as CustomEvent<BookChangedDetail>).detail, sessionId)) return
      setOpen(false)
      setMode('view')
      setChapter(null)
      setOutlineTask('')
      setOutlineTarget('story_outline')
      setSelectedSources([])
      setIncludeWorkingDrafts(false)
      setNotice('')
    }
    reset()
    window.addEventListener(BOOK_CHANGED_EVENT, reset)
    return () => window.removeEventListener(BOOK_CHANGED_EVENT, reset)
  }, [sessionId])

  const chapters = data?.chapters ?? []
  const scenes = data?.scenes ?? []
  const threads = data?.threads ?? []
  const arcs = data?.arcs ?? []
  const foreshadowing = data?.foreshadowing ?? []
  const reveals = data?.reveals ?? []
  const edges = data?.edges ?? []
  const empty = chapters.length + scenes.length + threads.length + arcs.length + foreshadowing.length + reveals.length + edges.length === 0
  const activeMode = empty ? 'plan' : mode

  const labels = new Map<string, string>()
  for (const item of [...threads, ...arcs, ...foreshadowing, ...reveals]) labels.set(item.slug, item.name)
  for (const scene of scenes) labels.set(scene.slug, scene.title ?? t('common.unknownItem'))

  const send = (prompt: string): void => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setNotice(t('outline.chatBusy'))
  }

  const requestPreview = (): void => {
    const input = outlineTask.trim()
    if (!input) return
    const target = t(outlineTarget === 'story_outline'
      ? 'outline.target.story'
      : outlineTarget === 'plot_thread' ? 'outline.target.thread' : 'outline.target.arc')
    const selected = (data?.source_options ?? []).filter((source) => selectedSources.includes(source.ref))
    const sources = selected.length > 0
      ? t('outline.prompt.sources', { sources: selected.map((source) => source.label).join('、') })
      : ''
    const drafts = includeWorkingDrafts ? t('outline.prompt.drafts') : ''
    send(t('outline.prompt.preview', { target, input, sources, drafts }))
  }

  const applyPreview = (preview: NonNullable<typeof data>['outline_previews'][number]): void => {
    send(t('outline.prompt.apply', { title: preview.title, id: preview.run_id }))
  }

  const edgeGroups = groupEdges(edges)

  return (
    <>
      <button type="button" className={css.petTrigger} title={t('story.title')}
        aria-label={t('story.title')} onClick={() => setOpen(true)}>
        <span className={css.petLabel}>{t('story.title')}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('story.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
        {error ? (
          <div className={css.emptyState} role="alert">
            <span>{t('common.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {data && data.bound == null ? <div className={css.empty}>{t('story.unbound')}</div> : null}
        {data?.bound && chapter != null ? (
          <ChapterDossier connection={connection} sessionId={sessionId} t={t}
            chapterIndex={chapter} onBack={() => setChapter(null)} />
        ) : data?.bound ? (
          <div className={css.workflowPanel}>
            <div className={css.panelToolbar}>
              <div className={css.tabRow} role="tablist" aria-label={t('story.title')}>
                <Pill role="tab" aria-selected={activeMode === 'view'} active={activeMode === 'view'} disabled={empty} onClick={() => setMode('view')}>
                  {t('story.mode.view')}
                </Pill>
                <Pill role="tab" aria-selected={activeMode === 'plan'} active={activeMode === 'plan'} onClick={() => setMode('plan')}>
                  {t('story.mode.plan')}
                </Pill>
              </div>
              <Button size="sm" variant="toolbar" icon={<IconRefreshOutline16 />}
                disabled={loading} onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
            </div>
            {notice ? <div className={css.message} role="status">{notice}</div> : null}
            {activeMode === 'plan' ? (
              <form className={css.outlineWorkbench} onSubmit={(event) => { event.preventDefault(); requestPreview() }}>
                {empty ? <p className={css.empty}>{t('story.empty')}</p> : null}
                <label className={css.presetControl}>
                  <span>{t('outline.target')}</span>
                  <select value={outlineTarget} onChange={(event) => setOutlineTarget(event.currentTarget.value as typeof outlineTarget)}>
                    <option value="story_outline">{t('outline.target.story')}</option>
                    <option value="plot_thread">{t('outline.target.thread')}</option>
                    <option value="outline_arc">{t('outline.target.arc')}</option>
                  </select>
                </label>
                <label className={css.presetControl}>
                  <span>{t('outline.taskLabel')}</span>
                  <textarea className={css.outlineTask} placeholder={t('outline.task')}
                    value={outlineTask} onChange={(event) => setOutlineTask(event.currentTarget.value)} />
                </label>
                <details className={css.disclosure}>
                  <summary>{t('outline.sources')} ({selectedSources.length})</summary>
                  <div className={css.sourcePicker}>
                    {data.source_options.length === 0 ? <div className={css.dossierEmpty}>{t('outline.sources.empty')}</div> : null}
                    {data.source_options.map((source) => (
                      <label key={source.ref} className={css.sourceOption}>
                        <input type="checkbox" checked={selectedSources.includes(source.ref)}
                          onChange={(event) => setSelectedSources((current) => event.currentTarget.checked
                            ? [...current, source.ref]
                            : current.filter((ref) => ref !== source.ref))} />
                        <span>{source.label}</span>
                      </label>
                    ))}
                  </div>
                  <label className={css.sourceOption}>
                    <input type="checkbox" checked={includeWorkingDrafts}
                      onChange={(event) => setIncludeWorkingDrafts(event.currentTarget.checked)} />
                    <span>{t('outline.includeDrafts')}</span>
                  </label>
                </details>
                <Button type="submit" variant="primary" disabled={!outlineTask.trim()}>
                  {t(outlineTarget === 'story_outline'
                    ? 'outline.preview.story'
                    : outlineTarget === 'plot_thread' ? 'outline.preview.thread' : 'outline.preview.arc')}
                </Button>
                {data.outline_previews.length > 0 ? (
                  <details className={css.disclosure}>
                    <summary>{t('outline.previews')} ({data.outline_previews.length})</summary>
                    <div className={css.workflowPanel}>
                      {data.outline_previews.map((preview) => (
                        <article key={preview.run_id} className={css.workflowCard}>
                          <header className={css.cardHeader}><span className={css.cardTitle}>{preview.title}</span></header>
                          <p className={css.previewSummary}>{preview.summary}</p>
                          <div className={css.chapterWorkspaceMeta}>
                            {t('outline.receipt')}：{preview.source_count} · {t('outline.warnings')}：{preview.warning_count}
                          </div>
                          <Button variant="primary" onClick={() => applyPreview(preview)}>{t('outline.apply')}</Button>
                        </article>
                      ))}
                    </div>
                  </details>
                ) : null}
              </form>
            ) : (
              <div className={css.workflowPanel}>
                <h3 className={css.sectionTitle}>{t('story.chapters')}</h3>
                {chapters.map((item) => (
                  <button key={item.index} type="button" className={css.chapterRow} onClick={() => setChapter(item.index)}>
                    <span className={css.chapterRowIndex}>{t('story.chapterNumber', { index: item.index })}</span>
                    <span>{item.title ?? t('common.untitled')}</span>
                  </button>
                ))}
                <Section title={t('story.threads')} lines={threads.map((item) => {
                  const range = item.start_chapter != null
                    ? ` · ${t('story.chapterNumber', { index: `${item.start_chapter}${item.end_chapter != null ? `–${item.end_chapter}` : ''}` })}`
                    : ''
                  return `${item.name}${range}`
                })} />
                <Section title={t('story.arcs')} lines={arcs.map((item) => {
                  const range = item.chapter_range?.length
                    ? ` · ${t('story.chapterNumber', { index: `${item.chapter_range[0]}–${item.chapter_range[item.chapter_range.length - 1]}` })}`
                    : ''
                  return `${item.name}${range}`
                })} />
                <Section title={t('story.foreshadowing')} lines={foreshadowing.map((item) => item.name)} />
                <Section title={t('story.reveals')} lines={reveals.map((item) => item.name)} />
                <Section title={t('story.scenes')} lines={scenes.map((item) => {
                  const range = item.chapters?.length ? ` · ${t('story.chapterNumber', { index: item.chapters.join('、') })}` : ''
                  return `${item.title ?? t('common.untitled')}${range}`
                })} />
                {edgeGroups.length > 0 ? (
                  <section className={css.contentSection}>
                    <h3 className={css.sectionTitle}>{t('story.edges')}</h3>
                    {edgeGroups.map((group) => (
                      <div key={group.type}>
                        <div className={css.edgeGroupTitle}>
                          {t((`story.edge.${group.type}`) as NovelcraftKey)}
                        </div>
                        {group.edges.map((edge, index) => (
                          <div key={index} className={css.edgeRow}>
                            <span>{labels.get(edge.source) ?? t('common.unknownItem')} → {labels.get(edge.target) ?? t('common.unknownItem')}</span>
                            <span className={`${css.edgeBadge} ${EDGE_TYPES.find((spec) => spec.type === edge.type)?.className ?? css.edgeOther}`}>
                              {t(EDGE_TYPES.find((spec) => spec.type === edge.type)?.key ?? 'story.edge.other')}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </section>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  )
}
