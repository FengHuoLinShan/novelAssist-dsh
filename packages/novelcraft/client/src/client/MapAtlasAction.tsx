import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button, IconRefreshOutline16, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { handoffToAssistant } from './assistantHandoff.ts'
import { NS, type NovelcraftKey } from './locales.ts'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import { readFileBase64, requestAtlasAnnotations, stageAtlasImageIntakeFile, useAtlasView } from './useWatch.ts'
import type { AtlasAnnotationOpInput, AtlasLabelCard, AtlasNodeCard, AtlasPageCard } from '../wire.ts'
import { MAX_TEXT_INTAKE_BYTES } from '../wire.ts'
import css from './novelcraft.module.css'

export type MapAtlasActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

type LabelDraft = { base: AtlasLabelCard[]; current: AtlasLabelCard[] }

const REVIEW_STATUS: Record<string, NovelcraftKey> = {
  candidate: 'atlas.status.pending',
  adopted: 'atlas.status.adopted',
  rejected: 'atlas.status.rejected',
  deprecated: 'atlas.status.archived',
}

function draftOps(draft: LabelDraft): AtlasAnnotationOpInput[] {
  const ops: AtlasAnnotationOpInput[] = []
  const baseIds = new Map(draft.base.map((label) => [label.id, label]))
  for (const label of draft.current) {
    const base = baseIds.get(label.id)
    if (!base) {
      ops.push({ op: 'add', id: label.id, label: label.label, position_x: label.position_x, position_y: label.position_y })
      continue
    }
    if (base.label !== label.label || base.position_x !== label.position_x || base.position_y !== label.position_y || base.target_node_ref !== label.target_node_ref) {
      ops.push({ op: 'update', id: label.id, label: label.label, position_x: label.position_x, position_y: label.position_y, target_node_ref: label.target_node_ref ?? null })
    }
  }
  for (const base of draft.base) {
    if (!draft.current.some((label) => label.id === base.id)) ops.push({ op: 'delete', id: base.id })
  }
  return ops
}

function AtlasTree(props: {
  t: TranslateNS<typeof NS>
  nodes: AtlasNodeCard[]
  pages: AtlasPageCard[]
  selected: string | null
  onSelect: (nodeId: string) => void
}): JSX.Element {
  const childrenOf = (parent: string | null) =>
    props.nodes.filter((node) => node.parent_ref === parent).sort((left, right) => left.title.localeCompare(right.title))
  const renderLevel = (parent: string | null, depth: number): JSX.Element[] => childrenOf(parent).map((node) => {
    const pageCount = props.pages.filter((page) => page.node_ref === node.id).length
    return (
      <div key={node.id}>
        <button type="button" className={`${css.atlasTreeRow} ${props.selected === node.id ? css.atlasTreeRowSelected : ''}`}
          style={{ '--atlas-indent': `${depth * 14}px` } as CSSProperties} onClick={() => props.onSelect(node.id)}>
          <span>{node.title}</span>
          {node.is_placeholder ? <Pill>{props.t('atlas.placeholder')}</Pill> : null}
          {pageCount > 0 ? <span className={css.cardMeta}>×{pageCount}</span> : null}
        </button>
        {renderLevel(node.id, depth + 1)}
      </div>
    )
  })
  return <div className={css.atlasTree}>{renderLevel(null, 0)}</div>
}

function PageCard(props: {
  t: TranslateNS<typeof NS>
  page: AtlasPageCard
  connection: RpcCaller | undefined
  sessionId: string | undefined
  onSaved: () => void
  onApply: () => boolean
  onDirtyChange: (dirty: boolean) => void
}): JSX.Element {
  const { page, t } = props
  const [draft, setDraft] = useState<LabelDraft>(() => ({ base: page.annotations, current: page.annotations }))
  const [saving, setSaving] = useState(false)
  const [queued, setQueued] = useState(false)
  const [message, setMessage] = useState('')
  const imgRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<string | null>(null)
  const dirty = draftOps(draft).length > 0
  const labelsValid = draft.current.every((label) => Boolean(label.label.trim()))
  const canLabel = Boolean(page.image) && !page.image_missing

  useEffect(() => {
    props.onDirtyChange(dirty)
    return () => props.onDirtyChange(false)
  }, [dirty, props.onDirtyChange])

  const addLabel = (x = 0.5, y = 0.5): void => {
    if (!canLabel) return
    const id = `ann-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setDraft((current) => ({
      ...current,
      current: [...current.current, { id, label: `${t('atlas.annotation.default')} ${current.current.length + 1}`, position_x: x, position_y: y }],
    }))
  }

  const pointOf = (event: React.PointerEvent | React.MouseEvent): { x: number; y: number } | null => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const moveLabel = (id: string, event: React.PointerEvent): void => {
    const point = pointOf(event)
    if (!point) return
    setDraft((current) => ({
      ...current,
      current: current.current.map((label) => label.id === id
        ? { ...label, position_x: point.x, position_y: point.y }
        : label),
    }))
  }

  const save = async (): Promise<void> => {
    const ops = draftOps(draft)
    if (ops.length === 0) return
    setSaving(true)
    setMessage('')
    const result = await requestAtlasAnnotations(props.connection, props.sessionId, page.id, page.content_hash, ops)
    setSaving(false)
    if (!result?.ok) {
      setMessage(t('atlas.annotation.failed'))
      return
    }
    setDraft({ base: draft.current, current: draft.current })
    setQueued(true)
    props.onSaved()
    if (!props.onApply()) setMessage(t('atlas.chatBusyQueued'))
  }

  return (
    <article className={css.atlasPage}>
      <header className={css.cardHeader}>
        <span className={css.cardTitle}>{page.title}</span>
        <Pill>{t(REVIEW_STATUS[page.review_status] ?? 'common.statusUnknown')}</Pill>
      </header>
      {page.evidence.conflicts.length > 0 ? (
        <div className={css.warning} role="alert">
          {t('atlas.conflicts')}：{page.evidence.conflicts.join('；')}
        </div>
      ) : null}
      {page.image_missing ? <div className={css.warning}>{t('atlas.imageMissing')}</div> : null}
      {page.image && !page.image_missing ? (
        <div ref={imgRef} className={css.atlasImageStage}
          onDoubleClick={(event) => { const point = pointOf(event); if (point) addLabel(point.x, point.y) }}
          onPointerMove={(event) => { if (dragRef.current) moveLabel(dragRef.current, event) }}
          onPointerUp={() => { dragRef.current = null }} onPointerLeave={() => { dragRef.current = null }}>
          {page.image.preview_data_url ? (
            <img src={page.image.preview_data_url} alt={page.title} className={css.atlasImage} />
          ) : (
            <div className={css.atlasPlaceholder}>
              {t('atlas.largeImage')} {page.image.width}×{page.image.height} · {(page.image.byte_size / 1024 / 1024).toFixed(1)} MB
            </div>
          )}
          {draft.current.map((label) => (
            <button key={label.id} type="button" className={css.atlasLabel}
              style={{ left: `${label.position_x * 100}%`, top: `${label.position_y * 100}%` }}
              onPointerDown={(event) => { dragRef.current = label.id; event.currentTarget.setPointerCapture(event.pointerId) }}
              onPointerUp={(event) => { dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}>
              {label.label}
            </button>
          ))}
        </div>
      ) : <div className={css.atlasPlaceholder}>{t('atlas.noImage')}</div>}

      <section className={css.contentSection}>
        <h3 className={css.sectionTitle}>{t('atlas.visualBrief')}</h3>
        <p className={css.previewSummary}>{page.visual_brief || t('common.none')}</p>
      </section>
      <details className={css.disclosure}>
        <summary>{t('atlas.imageGuide')}</summary>
        <div className={css.promptBlock}>{page.prompt || t('common.none')}</div>
        <Button size="sm" variant="outline" disabled={!page.prompt}
          onClick={() => { void navigator.clipboard?.writeText(page.prompt) }}>{t('atlas.copyGuide')}</Button>
        {page.evidence.supported.length > 0 ? <p className={css.helperText}>{t('atlas.supported')}：{page.evidence.supported.join('；')}</p> : null}
        {page.evidence.visual_fill.length > 0 ? <p className={css.helperText}>{t('atlas.visualFill')}：{page.evidence.visual_fill.join('；')}</p> : null}
      </details>
      {canLabel ? (
        <section className={css.contentSection}>
          <div className={css.sectionHeader}>
            <h3 className={css.sectionTitle}>{t('atlas.annotations')}</h3>
            <Button size="sm" variant="outline" onClick={() => addLabel()}>{t('atlas.annotation.add')}</Button>
          </div>
          <p className={css.helperText}>{t('atlas.annotation.hint')}</p>
          <div className={css.annotationList}>
            {draft.current.map((label) => (
              <div key={label.id} className={css.annotationRow}>
                <Input value={label.label} aria-label={t('atlas.annotation.name')}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    current: current.current.map((item) => item.id === label.id ? { ...item, label: event.currentTarget.value } : item),
                  }))} />
                <Button size="sm" variant="ghost" onClick={() => setDraft((current) => ({
                  ...current, current: current.current.filter((item) => item.id !== label.id),
                }))}>{t('atlas.annotation.delete')}</Button>
              </div>
            ))}
          </div>
          {!labelsValid ? <p className={css.warning}>{t('atlas.annotation.nameRequired')}</p> : null}
          <Button variant="primary" disabled={!dirty || saving || !labelsValid} onClick={() => void save()}>
            {saving ? t('atlas.annotation.saving') : dirty
              ? t('atlas.annotation.save')
              : t(queued ? 'atlas.annotation.queued' : 'atlas.annotation.saved')}
          </Button>
        </section>
      ) : null}
      {message ? <div className={css.message} role="status">{message}</div> : null}
    </article>
  )
}

export function MapAtlasAction(props: MapAtlasActionProps): JSX.Element {
  const { t, connection, sessionId, inputActions, useInput } = props
  const chatDraft = useInput((state: InputState) => state.draft)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'pending' | 'atlas'>('atlas')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [dirtyPage, setDirtyPage] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [message, setMessage] = useState('')
  const { data, loading, error, refresh } = useAtlasView(connection, sessionId)

  const adoptedPages = useMemo(() => data?.adopted.pages ?? [], [data])
  const pendingPages = useMemo(() => data?.pending.pages ?? [], [data])
  const nodes = tab === 'atlas' ? data?.adopted.nodes ?? [] : data?.pending.nodes ?? []
  const pages = tab === 'atlas' ? adoptedPages : pendingPages
  const nodePages = selectedNode ? pages.filter((page) => page.node_ref === selectedNode) : []
  const selectedPage = selectedPageId ? pages.find((page) => page.id === selectedPageId) : undefined
  const selectedNodeCard = nodes.find((node) => node.id === selectedNode)

  const confirmDiscard = (): boolean => !dirtyPage || window.confirm(t('atlas.annotation.discardConfirm'))
  const selectNode = (nodeId: string): void => {
    if (!confirmDiscard()) return
    const matches = pages.filter((page) => page.node_ref === nodeId)
    setSelectedNode(nodeId)
    setSelectedPageId(matches.length === 1 ? matches[0].id : null)
    setDirtyPage(false)
  }
  const selectTab = (next: 'pending' | 'atlas'): void => {
    if (!confirmDiscard()) return
    setTab(next)
    setSelectedNode(null)
    setSelectedPageId(null)
    setDirtyPage(false)
  }
  const close = (): void => {
    if (confirmDiscard()) setOpen(false)
  }

  const send = (prompt: string): boolean => {
    const sent = handoffToAssistant({
      draft: chatDraft,
      prompt,
      setDraft: inputActions.setDraft,
      submit: inputActions.submit,
      close: () => setOpen(false),
    })
    if (!sent) setMessage(t('atlas.chatBusy'))
    return sent
  }

  const chooseImage = async (file: File | undefined): Promise<void> => {
    if (!file || !selectedNode) return
    if (chatDraft.trim()) {
      setMessage(t('atlas.chatBusy'))
      return
    }
    if (file.size > MAX_TEXT_INTAKE_BYTES) {
      setMessage(t('atlas.imageTooLarge'))
      return
    }
    setUploadBusy(true)
    setMessage('')
    try {
      const exactPage = selectedPage?.generation_status === 'prompt_only' && selectedPage.review_status === 'candidate'
        ? { ref: selectedPage.id, contentHash: selectedPage.content_hash }
        : undefined
      if (nodePages.length > 1 && !exactPage) {
        setMessage(t('atlas.choosePage'))
        return
      }
      const result = await stageAtlasImageIntakeFile(
        connection,
        sessionId,
        file.name,
        await readFileBase64(file),
        selectedNode,
        exactPage,
      )
      if (!result) {
        setMessage(t('atlas.uploadFailed'))
        return
      }
      window.dispatchEvent(new CustomEvent('novelcraft:signals-changed'))
      send(t('atlas.prompt.import', {
        file: result.file_name,
        page: selectedNodeCard?.title ?? t('atlas.selectedPage'),
      }))
    } catch {
      setMessage(t('atlas.uploadFailed'))
    } finally {
      setUploadBusy(false)
    }
  }

  const atlasEmpty = Boolean(data?.bound) && data!.adopted.nodes.length === 0 && data!.pending.nodes.length === 0

  return (
    <>
      <button type="button" className={css.petTrigger} onClick={() => setOpen(true)}
        title={t('atlas.title')} aria-label={t('atlas.title')}>
        <span className={css.petLabel}>{t('atlas.title')}</span>
      </button>
      <NovelcraftModal open={open} onClose={close} title={t('atlas.title')}
        closeLabel={t('inbox.close')} className={css.dialogWide} contentClassName={css.modalContent}>
        {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
        {error ? (
          <div className={css.emptyState} role="alert">
            <span>{t('common.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {data && !data.bound ? <div className={css.empty}>{t('atlas.unbound')}</div> : null}
        {data?.bound ? (
          <div className={css.atlasPanel}>
            <div className={css.panelToolbar}>
              <div className={css.tabRow} role="tablist" aria-label={t('atlas.title')}>
                <Pill role="tab" aria-selected={tab === 'atlas'} active={tab === 'atlas'}
                  onClick={() => selectTab('atlas')}>{t('atlas.tab.mine')}</Pill>
                <Pill role="tab" aria-selected={tab === 'pending'} active={tab === 'pending'}
                  onClick={() => selectTab('pending')}>
                  {t('atlas.tab.pending')} {pendingPages.length > 0 ? `(${pendingPages.length})` : ''}
                </Pill>
              </div>
              <Button size="sm" variant="toolbar" icon={<IconRefreshOutline16 />}
                disabled={loading} onClick={() => void refresh()}>{t('inbox.refresh')}</Button>
            </div>
            {data.run ? (
              <div className={css.statusLine}>
                <span>{t('atlas.runSummary')}：{data.run.planned_page_count} {t('atlas.pagesUnit')}</span>
                {data.run.error_message ? <span className={css.warning}>{t('atlas.runNeedsAttention')}</span> : null}
              </div>
            ) : null}
            {data.queue.ops > 0 ? <div className={css.message}>{t('atlas.queuePending')}：{data.queue.ops}</div> : null}
            {message ? <div className={css.message} role="status">{message}</div> : null}
            {atlasEmpty ? (
              <div className={css.emptyState}>
                <span>{t('atlas.empty')}</span>
                <Button variant="primary" onClick={() => send(t('atlas.prompt.plan'))}>
                  {t('atlas.plan')}
                </Button>
              </div>
            ) : (
              <div className={css.atlasLayout}>
                <aside className={css.atlasSidebar}>
                  <h3 className={css.sectionTitle}>{tab === 'atlas' ? t('atlas.tab.mine') : t('atlas.tab.pending')}</h3>
                  {nodes.length > 0 ? (
                    <AtlasTree t={t} nodes={nodes} pages={pages} selected={selectedNode} onSelect={selectNode} />
                  ) : <div className={css.empty}>{t(tab === 'atlas' ? 'atlas.mine.empty' : 'atlas.pending.empty')}</div>}
                </aside>
                <main className={css.atlasDetail}>
                  {nodePages.length > 1 && !selectedPage ? (
                    <div className={css.workflowPanel}>
                      <span className={css.helperText}>{t('atlas.choosePage')}</span>
                      {nodePages.map((page) => (
                        <button key={page.id} type="button" className={css.chapterRow}
                          onClick={() => setSelectedPageId(page.id)}>
                          <span>{page.title}</span>
                          <Pill>{t(REVIEW_STATUS[page.review_status] ?? 'common.statusUnknown')}</Pill>
                        </button>
                      ))}
                    </div>
                  ) : selectedPage ? (
                    <>
                      <PageCard key={`${selectedPage.id}:${selectedPage.content_hash}`} t={t} page={selectedPage}
                        connection={connection} sessionId={sessionId} onSaved={() => void refresh()}
                        onApply={() => send(t('atlas.prompt.applyLabels'))} onDirtyChange={setDirtyPage} />
                      {selectedNode && selectedPage.generation_status === 'prompt_only' && !selectedPage.image ? (
                        <label className={`${css.fileLabel} ${chatDraft.trim() ? css.fileLabelDisabled : ''}`}>
                          <span>{uploadBusy ? t('atlas.uploading') : t('atlas.upload')}</span>
                          <input className={css.fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                            disabled={uploadBusy || Boolean(chatDraft.trim())}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0]
                              event.currentTarget.value = ''
                              void chooseImage(file)
                            }} />
                        </label>
                      ) : null}
                    </>
                  ) : (
                    <div className={css.emptyState}>
                      <span>{selectedNode ? t('atlas.placeholderHint') : t('atlas.selectNode')}</span>
                      {selectedNode && nodePages.length === 0 ? (
                        <label className={`${css.fileLabel} ${chatDraft.trim() ? css.fileLabelDisabled : ''}`}>
                          <span>{uploadBusy ? t('atlas.uploading') : t('atlas.upload')}</span>
                          <input className={css.fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                            disabled={uploadBusy || Boolean(chatDraft.trim())}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0]
                              event.currentTarget.value = ''
                              void chooseImage(file)
                            }} />
                        </label>
                      ) : null}
                    </div>
                  )}
                </main>
              </div>
            )}
          </div>
        ) : null}
      </NovelcraftModal>
    </>
  )
}
