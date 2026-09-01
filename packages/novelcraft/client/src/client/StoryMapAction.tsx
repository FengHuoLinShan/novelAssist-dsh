// 剧情地图(StoryMapAction): 会话头动作, 打开剧情地图 Modal(结构资产 + Scene/章节覆盖)。
// 数据源 = /novelcraft story/map(宿主读 store.storyMap, 文件真相)。纯读, 无动作。
import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type NovelcraftKey } from './locales.ts'
import { BOOK_CHANGED_EVENT, matchesBookChangedSession, useStoryMap, type BookChangedDetail } from './useWatch.ts'
import { ChapterDossier } from './ChapterDossier.tsx'
import css from './novelcraft.module.css'

export type StoryMapActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

/** 跨类关系边(ADR-0019: wire.storyMap.edges 投影; 显式 relations + related_*_ids 并集去重)。 */
type StoryEdge = { source: string; target: string; type: string; status: string; sourceKind?: string }

/** 关系边 type 的确定性分组顺序 + 显示名键(键名约定 story.edge.<type>)+ 每 type 一个徽章配色类。 */
const EDGE_TYPES: Array<{ type: string; key: NovelcraftKey; className: string }> = [
  { type: 'serves_thread', key: 'story.edge.serves_thread', className: css.edgeServesThread },
  { type: 'belongs_to_arc', key: 'story.edge.belongs_to_arc', className: css.edgeBelongsToArc },
  { type: 'reveals_foreshadowing', key: 'story.edge.reveals_foreshadowing', className: css.edgeRevealsForeshadowing },
  { type: 'pays_off_in_scene', key: 'story.edge.pays_off_in_scene', className: css.edgePaysOffInScene },
  { type: 'references_character', key: 'story.edge.references_character', className: css.edgeReferencesCharacter },
  { type: 'references_entity', key: 'story.edge.references_entity', className: css.edgeReferencesEntity },
  { type: 'references_memory', key: 'story.edge.references_memory', className: css.edgeReferencesMemory },
]

/** 按确定性顺序分组; 未识别 type 归入「其他」组(徽章显示名回退原 type 字符串)。 */
function groupEdges(edges: StoryEdge[]): Array<{ type: string; edges: StoryEdge[] }> {
  const groups: Array<{ type: string; edges: StoryEdge[] }> = []
  for (const spec of EDGE_TYPES) {
    const matches = edges.filter((e) => e.type === spec.type)
    if (matches.length > 0) groups.push({ type: spec.type, edges: matches })
  }
  const known = new Set(EDGE_TYPES.map((s) => s.type))
  const others = edges.filter((e) => !known.has(e.type))
  if (others.length > 0) groups.push({ type: 'other', edges: others })
  return groups
}

/** 徽章配色类: 已知 type 用专属配色, 未识别 type 用「其他」灰。 */
function edgeBadgeClass(type: string): string {
  return EDGE_TYPES.find((s) => s.type === type)?.className ?? css.edgeOther
}

function Section(props: { title: string; lines: string[] }): JSX.Element {
  if (props.lines.length === 0) return <></>
  return (
    <>
      <div className={css.sectionTitle}>{props.title}</div>
      {props.lines.map((line, i) => <div key={i} className={css.itemLine}>{line}</div>)}
    </>
  )
}

export function StoryMapAction(props: StoryMapActionProps): JSX.Element {
  const { t, connection, inputActions, sessionId, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  /** 钻取中章节(章节档案 §17.5.1); null = 列表视图。 */
  const [chapter, setChapter] = useState<number | null>(null)
  const [outlineTask, setOutlineTask] = useState('')
  const [outlineTarget, setOutlineTarget] = useState<'story_outline' | 'plot_thread' | 'outline_arc'>('story_outline')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [includeWorkingDrafts, setIncludeWorkingDrafts] = useState(false)
  const [notice, setNotice] = useState('')
  const { data, loading, refresh } = useStoryMap(connection, sessionId)

  useEffect(() => {
    const reset = (event?: Event) => {
      if (event && !matchesBookChangedSession((event as CustomEvent<BookChangedDetail>).detail, sessionId)) return
      setOpen(false)
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

  const bound = data?.bound != null
  const chapters = data?.chapters ?? []
  const scenes = data?.scenes ?? []
  const threads = data?.threads ?? []
  const arcs = data?.arcs ?? []
  const foreshadowing = data?.foreshadowing ?? []
  const reveals = data?.reveals ?? []
  const edges = data?.edges ?? []
  const edgeGroups = groupEdges(edges)
  const empty = chapters.length + scenes.length + threads.length + arcs.length + foreshadowing.length + reveals.length + edges.length === 0

  const send = (prompt: string): void => {
    if (chatDraft.trim()) {
      setNotice(t('outline.chatBusy'))
      return
    }
    inputActions.setDraft(prompt)
    inputActions.submit()
    setNotice(t('outline.requested'))
  }

  const requestPreview = (): void => {
    const input = outlineTask.trim()
    if (!input) return
    const context = `input=${JSON.stringify(input)}，source_refs=${JSON.stringify(selectedSources)}，include_working_drafts=${includeWorkingDrafts}`
    send(outlineTarget === 'story_outline'
      ? `请调用 novelcraft_outline_preview，${context}。`
      : `请调用 novelcraft_outline_item_preview，target=${outlineTarget}，${context}。`)
  }

  const applyPreview = (preview: NonNullable<typeof data>['outline_previews'][number]): void => {
    const tool = preview.kind === 'story_outline' ? 'novelcraft_outline_apply' : 'novelcraft_outline_item_apply'
    send(`请调用 ${tool}，run_id=${JSON.stringify(preview.run_id)}。`)
  }

  return (
    <>
      <button
        type="button"
        className={css.petTrigger}
        title={t('story.title')}
        aria-label={t('story.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={css.petLabel}>{t('story.title')}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('story.title')}
        closeLabel={t('inbox.close')}
        contentClassName={css.modalContent}
      >
        {!bound ? (
          <div className={css.empty}>{t('story.unbound')}</div>
        ) : chapter != null ? (
          <ChapterDossier
            connection={connection}
            sessionId={sessionId}
            t={t}
            chapterIndex={chapter}
            onBack={() => setChapter(null)}
          />
        ) : (
          <div>
            {empty ? <div className={css.empty}>{t('story.empty')}</div> : null}
            <div className={css.sectionTitle}>{t('story.chapters')}</div>
            {chapters.map((c) => (
              <button
                key={c.index}
                type="button"
                className={css.chapterRow}
                onClick={() => setChapter(c.index)}
              >
                <span className={css.chapterRowIndex}>ch{c.index}</span>
                <span>{c.title ?? ''}</span>
              </button>
            ))}
            <section className={css.outlineWorkbench}>
              <div className={css.panelToolbar}>
                <div className={css.sectionTitle}>{t('outline.workbench')}</div>
                <button type="button" className={css.actionButton} disabled={loading} onClick={() => void refresh()}>
                  {loading ? t('workflow.loading') : t('inbox.refresh')}
                </button>
              </div>
              {notice ? <div className={css.message} role="status">{notice}</div> : null}
              <label className={css.presetControl}>
                <span>{t('outline.target')}</span>
                <select value={outlineTarget} onChange={(event) => setOutlineTarget(event.currentTarget.value as typeof outlineTarget)}>
                  <option value="story_outline">{t('outline.target.story')}</option>
                  <option value="plot_thread">{t('outline.target.thread')}</option>
                  <option value="outline_arc">{t('outline.target.arc')}</option>
                </select>
              </label>
              <textarea className={css.outlineTask} aria-label={t('outline.task')}
                placeholder={t('outline.task')} value={outlineTask}
                onChange={(event) => setOutlineTask(event.currentTarget.value)} />
              <details>
                <summary className={css.sectionTitle}>{t('outline.sources')} ({selectedSources.length})</summary>
                <div className={css.sourcePicker}>
                  {data?.source_options.length === 0 ? <div className={css.dossierEmpty}>{t('outline.sources.empty')}</div> : null}
                  {data?.source_options.map((source) => (
                    <label key={source.ref} className={css.sourceOption}>
                      <input type="checkbox" checked={selectedSources.includes(source.ref)}
                        onChange={(event) => setSelectedSources((current) => event.currentTarget.checked
                          ? [...current, source.ref]
                          : current.filter((ref) => ref !== source.ref))} />
                      <span>{source.label} · {source.status}</span>
                    </label>
                  ))}
                </div>
              </details>
              <label className={css.sourceOption}>
                <input type="checkbox" checked={includeWorkingDrafts}
                  onChange={(event) => setIncludeWorkingDrafts(event.currentTarget.checked)} />
                <span>{t('outline.includeDrafts')}</span>
              </label>
              <button type="button" className={css.actionButton} disabled={!outlineTask.trim()} onClick={requestPreview}>
                {t('outline.preview')}
              </button>
              <div className={css.sectionTitle}>{t('outline.previews')}</div>
              {data?.outline_previews.length === 0 ? <div className={css.dossierEmpty}>{t('outline.previews.empty')}</div> : null}
              {data?.outline_previews.map((preview) => (
                <article key={preview.run_id} className={css.workflowCard}>
                  <header className={css.cardHeader}>
                    <span className={css.cardTitle}>{preview.title}</span>
                    <span className={css.cardMeta}>{preview.kind === 'story_outline' ? t('outline.target.story') : preview.target === 'plot_thread' ? t('outline.target.thread') : t('outline.target.arc')}</span>
                  </header>
                  <p className={css.previewSummary}>{preview.summary}</p>
                  <div className={css.chapterWorkspaceMeta}>
                    {t('outline.receipt')}: {preview.source_count} · {t('outline.warnings')}: {preview.warning_count}
                  </div>
                  <button type="button" className={css.actionButton} onClick={() => applyPreview(preview)}>
                    {t('outline.apply')}
                  </button>
                </article>
              ))}
            </section>
            <Section title={t('story.threads')} lines={threads.map((x) => {
              const range = x.start_chapter != null ? `ch${x.start_chapter}${x.end_chapter != null ? '-' + x.end_chapter : ''}` : ''
              return `${x.name}${x.thread_type ? ' · ' + x.thread_type : ''}${range ? ' · ' + range : ''}`
            })} />
            <Section title={t('story.arcs')} lines={arcs.map((x) => {
              const range = x.chapter_range?.length ? `ch${x.chapter_range[0]}-${x.chapter_range[x.chapter_range.length - 1]}` : ''
              return `${x.name}${range ? ' · ' + range : ''}`
            })} />
            <Section title={t('story.foreshadowing')} lines={foreshadowing.map((x) => x.name)} />
            <Section title={t('story.reveals')} lines={reveals.map((x) => {
              const target = x.target_id ? ' → ' + x.target_id : ''
              const secret = x.secret_summary ? ' · ' + x.secret_summary : ''
              return `${x.name}${target}${secret}`
            })} />
            <Section title={t('story.scenes')} lines={scenes.map((x) => {
              const ch = x.chapters?.length ? ' · ch' + x.chapters.join(',') : ''
              return `${x.title ?? x.slug}${ch}`
            })} />
            {edgeGroups.length > 0 && (
              <>
                <div className={css.sectionTitle}>{t('story.edges')}</div>
                {edgeGroups.map((group) => (
                  <div key={group.type}>
                    <div className={css.edgeGroupTitle}>{t(('story.edge.' + group.type) as NovelcraftKey)}</div>
                    {group.edges.map((edge, i) => {
                      const deprecated = edge.status === 'deprecated'
                      const meta = EDGE_TYPES.find((s) => s.type === edge.type)
                      const badgeText = meta ? t(meta.key) : edge.type
                      return (
                        <div key={i} className={css.edgeRow}>
                          <span className={deprecated ? css.edgeLinkDeprecated : css.edgeLink}>
                            {edge.source} → {edge.target}
                          </span>
                          <span className={css.edgeBadge + ' ' + (deprecated ? css.edgeBadgeDeprecated : edgeBadgeClass(edge.type))}>
                            {badgeText}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
