// 地图册(MapAtlasAction): 会话头动作, 打开地图册 Modal(Phase 6; 计划 §4 Phase 6)。
// tab「本次规划」(最近 run + prompt_only 候选, prompt 一键复制)/「我的地图册」(adopted 树)。
// 文字标签层: 双击加标签/拖动/行内改名/删除 → 本地 dirty → 「保存标签」走 atlas/annotation-request
// (只落队列 + 信号, 不写资产; 应用由 agent 工具消费队列, 坐标恒归一化 0–1, 规则 11)。
import { useMemo, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type NovelcraftKey } from './locales.ts'
import { readFileBase64, requestAtlasAnnotations, stageAtlasImageIntakeFile, useAtlasView } from './useWatch.ts'
import type { AtlasAnnotationOpInput, AtlasLabelCard, AtlasNodeCard, AtlasPageCard } from '../wire.ts'
import { MAX_TEXT_INTAKE_BYTES } from '../wire.ts'
import css from './novelcraft.module.css'

export type MapAtlasActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

/** 标签本地编辑态(增/改/删合并为 ops 提交)。 */
type LabelDraft = { base: AtlasLabelCard[]; current: AtlasLabelCard[]; deleted: Set<string>; added: Set<string> }

function draftOps(draft: LabelDraft): AtlasAnnotationOpInput[] {
  const ops: AtlasAnnotationOpInput[] = []
  const baseIds = new Map(draft.base.map((a) => [a.id, a]))
  for (const a of draft.current) {
    if (!draft.base.some((b) => b.id === a.id)) {
      ops.push({ op: 'add', id: a.id, label: a.label, position_x: a.position_x, position_y: a.position_y, ...(a.target_node_ref ? { target_node_ref: a.target_node_ref } : {}) })
    } else {
      const b = baseIds.get(a.id)!
      if (b.label !== a.label || b.position_x !== a.position_x || b.position_y !== a.position_y || b.target_node_ref !== a.target_node_ref) {
        ops.push({ op: 'update', id: a.id, label: a.label, position_x: a.position_x, position_y: a.position_y, target_node_ref: a.target_node_ref ?? null })
      }
    }
  }
  for (const b of draft.base) {
    if (!draft.current.some((a) => a.id === b.id)) ops.push({ op: 'delete', id: b.id })
  }
  return ops
}

/** 层级树(adopted nodes + 每节点页数徽标; 空页占位可点)。 */
function AtlasTree(props: {
  nodes: AtlasNodeCard[]
  pages: AtlasPageCard[]
  selected: string | null
  onSelect: (nodeId: string) => void
}): JSX.Element {
  const childrenOf = (parent: string | null) =>
    props.nodes.filter((n) => n.parent_ref === parent).sort((a, b) => a.title.localeCompare(b.title))
  const renderLevel = (parent: string | null, depth: number): JSX.Element[] =>
    childrenOf(parent).map((n) => {
      const pageCount = props.pages.filter((p) => p.node_ref === n.id).length
      return (
        <div key={n.id}>
          <div
            className={css.itemLine}
            style={{
              paddingLeft: depth * 14 + 4,
              cursor: 'pointer',
              fontWeight: props.selected === n.id ? 700 : 400,
              opacity: n.is_placeholder ? 0.75 : 1,
            }}
            onClick={() => props.onSelect(n.id)}
          >
            {n.title}
            <span style={{ opacity: 0.55, fontSize: 11, marginLeft: 6 }}>{n.level}</span>
            {n.is_placeholder ? <span style={{ fontSize: 11, marginLeft: 6 }}>◇ 空页占位(待上传图片)</span> : null}
            {pageCount > 0 ? <span style={{ fontSize: 11, marginLeft: 6 }}>×{pageCount}</span> : null}
          </div>
          {renderLevel(n.id, depth + 1)}
        </div>
      )
    })
  return <>{renderLevel(null, 0)}</>
}

/** 页面卡(图片预览 + prompt 复制 + evidence + 标签层)。 */
function PageCard(props: {
  page: AtlasPageCard
  adoptedNodes: AtlasNodeCard[]
  connection: RpcCaller | undefined
  sessionId: string | undefined
  onSaved: () => void
}): JSX.Element {
  const { page } = props
  const [draft, setDraft] = useState<LabelDraft>(() => ({ base: page.annotations, current: page.annotations, deleted: new Set(), added: new Set() }))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const imgRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<string | null>(null)
  const dirty = draftOps(draft).length > 0
  // 验收: 缺图态不渲染标签层(规则 9: 标签必须落在图上)。
  const canLabel = !!page.image && !page.image_missing

  const toNormalized = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } | null => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }

  const addLabel = (e: React.MouseEvent) => {
    if (!canLabel) return
    const p = toNormalized(e)
    if (!p) return
    const id = `ann-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const label = `标签 ${draft.current.length + 1}`
    setDraft({ ...draft, current: [...draft.current, { id, label, position_x: p.x, position_y: p.y }] })
  }

  const moveLabel = (id: string, e: React.PointerEvent) => {
    const p = toNormalized(e)
    if (!p) return
    setDraft((d) => ({
      ...d,
      current: d.current.map((a) => (a.id === id ? { ...a, position_x: p.x, position_y: p.y } : a)),
    }))
  }

  const save = async () => {
    const ops = draftOps(draft)
    if (ops.length === 0) return
    setSaving(true)
    setMessage('')
    const r = await requestAtlasAnnotations(props.connection, props.sessionId, page.id, page.content_hash, ops)
    setSaving(false)
    if (r?.ok) {
      setMessage(r.message)
      setDraft({ base: draft.current, current: draft.current, deleted: new Set(), added: new Set() })
      props.onSaved()
    } else {
      setMessage(r?.message ?? '入队失败(连接不可用); 本地草稿已保留, 可重试。')
    }
  }

  return (
    <div style={{ padding: 8 }}>
      <div className={css.sectionTitle}>{page.title} · {page.review_status}</div>
      {page.evidence.conflicts.length > 0 ? (
        <div style={{ color: '#c0392b', fontSize: 12, marginBottom: 6 }}>
          ⚠ 设定冲突 {page.evidence.conflicts.length} 条(adopt 时需确认): {page.evidence.conflicts.join('；')}
        </div>
      ) : null}
      {page.image_missing ? <div style={{ fontSize: 12, marginBottom: 6 }}>⚠ 图片文件缺失({page.image?.file})</div> : null}
      {page.image && !page.image_missing ? (
        <div
          ref={imgRef}
          onDoubleClick={addLabel}
          onPointerMove={(e) => { if (dragRef.current) moveLabel(dragRef.current, e) }}
          onPointerUp={() => { dragRef.current = null }}
          onPointerLeave={() => { dragRef.current = null }}
          style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', userSelect: 'none' }}
        >
          {page.image.preview_data_url ? (
            <img src={page.image.preview_data_url} alt={page.title} style={{ maxWidth: '100%', display: 'block' }} />
          ) : (
            <div style={{ padding: 24, border: '1px dashed #999', fontSize: 12 }}>
              大图不内嵌预览({page.image.width}×{page.image.height}, {(page.image.byte_size / 1024 / 1024).toFixed(1)}MB); 本地路径 {page.image.file}
            </div>
          )}
          {draft.current.map((a) => (
            <div
              key={a.id}
              onPointerDown={(e) => { dragRef.current = a.id; e.preventDefault() }}
              onDoubleClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: `${a.position_x * 100}%`,
                top: `${a.position_y * 100}%`,
                transform: 'translate(-50%, -100%)',
                cursor: 'move',
                background: 'rgba(0,0,0,0.72)',
                color: '#fff',
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}
              title="拖动移动; 双击文字改名"
            >
              <span
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => {
                  const label = (e.target as HTMLElement).innerText.trim()
                  if (label && label !== a.label) {
                    setDraft((d) => ({ ...d, current: d.current.map((x) => (x.id === a.id ? { ...x, label } : x)) }))
                  }
                }}
              >
                {a.label}
              </span>
              <span
                style={{ marginLeft: 6, cursor: 'pointer', opacity: 0.8 }}
                onClick={() => setDraft((d) => ({ ...d, current: d.current.filter((x) => x.id !== a.id) }))}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 16, border: '1px dashed #999', fontSize: 12, marginBottom: 6 }}>
          缺图态: 该页还没有图片(双击加标签等功能在有图后可用); prompt 可复制去外部生图后回传。
        </div>
      )}
      <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>
        <div>视觉简述: {page.visual_brief || '(空)'}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>prompt: {page.prompt || '(空)'}</span>
          <button
            style={{ fontSize: 11 }}
            onClick={() => { void navigator.clipboard?.writeText(page.prompt) }}
            disabled={!page.prompt}
          >
            复制 prompt
          </button>
        </div>
        {page.evidence.supported.length > 0 ? <div>支撑: {page.evidence.supported.join('；')}</div> : null}
        {page.evidence.visual_fill.length > 0 ? <div>视觉补全(待核): {page.evidence.visual_fill.join('；')}</div> : null}
      </div>
      {canLabel ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : dirty ? '保存标签(入队)' : '标签已同步'}
          </button>
          <span style={{ fontSize: 11, opacity: 0.7 }}>双击图片加标签; 拖动移动; 双击文字改名; × 删除。坐标恒为 0–1 归一化。</span>
        </div>
      ) : null}
      {message ? <div style={{ fontSize: 12, marginTop: 4 }}>{message}</div> : null}
    </div>
  )
}

export function MapAtlasAction(props: MapAtlasActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'run' | 'atlas'>('atlas')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const { data, refresh } = useAtlasView(connection, sessionId)

  const adoptedPages = useMemo(() => data?.adopted.pages ?? [], [data])
  const pendingPages = useMemo(() => data?.pending.pages ?? [], [data])
  // 选中节点无页 → undefined(空页占位显示「待上传图片」态); 仅未选中时回退首条。
  const selectedPage: AtlasPageCard | undefined =
    selectedNode ? adoptedPages.find((p) => p.node_ref === selectedNode) : adoptedPages[0]
  const selectedPending: AtlasPageCard | undefined =
    selectedNode ? pendingPages.find((p) => p.node_ref === selectedNode) : pendingPages[0]

  const chooseImage = async (file: File | undefined) => {
    if (!file || !selectedNode) return
    if (file.size > MAX_TEXT_INTAKE_BYTES) {
      setUploadMessage('图片超过 50MB, 请压缩后重试。')
      return
    }
    setUploadBusy(true)
    setUploadMessage('')
    try {
      const result = await stageAtlasImageIntakeFile(connection, sessionId, file.name, await readFileBase64(file), selectedNode)
      setUploadMessage(result?.message ?? '图片授权失败, 请检查格式和尺寸。')
      if (result) window.dispatchEvent(new CustomEvent('novelcraft:signals-changed'))
    } catch {
      setUploadMessage('图片授权失败, 请检查格式和尺寸。')
    } finally {
      setUploadBusy(false)
    }
  }

  return (
    <>
      <button className={css.petButton} onClick={() => setOpen(true)} title={t('atlas.title' as NovelcraftKey)}>
        🗺
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('atlas.title' as NovelcraftKey)} closeLabel={t('inbox.close')}>
          <div style={{ minWidth: 720, maxWidth: 960, maxHeight: '80vh', overflow: 'auto', padding: 8 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button style={{ fontWeight: tab === 'run' ? 700 : 400 }} onClick={() => { setTab('run'); setSelectedNode(null) }}>本次规划</button>
              <button style={{ fontWeight: tab === 'atlas' ? 700 : 400 }} onClick={() => { setTab('atlas'); setSelectedNode(null) }}>我的地图册</button>
              <button onClick={() => void refresh()}>刷新</button>
              {selectedNode ? (
                <label className={css.fileLabel}>
                  <span>{uploadBusy ? '校验中…' : '为选中节点选图'}</span>
                  <input
                    className={css.fileInput}
                    type="file"
                    accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                    disabled={uploadBusy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      void chooseImage(file)
                    }}
                  />
                </label>
              ) : null}
              <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>
                {data?.queue && data.queue.ops > 0 ? `待应用 ${data.queue.ops} 个标签修改` : ''}
              </span>
            </div>
            {uploadMessage ? <div className={css.message}>{uploadMessage}</div> : null}
            {!data?.bound ? <div className={css.itemLine}>未绑定 vault(先选书)。</div> : null}
            {data?.bound && tab === 'run' ? (
              <div>
                {data.run ? (
                  <div className={css.itemLine}>
                    run {data.run.id} · {data.run.status} · 计划 {data.run.planned_page_count} 页
                    {data.run.error_message ? ` · 失败: ${data.run.error_message}` : ''}
                  </div>
                ) : (
                  <div className={css.itemLine}>还没有规划 run; 让助手调用 novelcraft_map_atlas_plan 开始。</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1, borderRight: '1px solid #ddd', paddingRight: 8 }}>
                    <div className={css.sectionTitle}>候选节点(prompt_only 不可直接采用, 需先传图)</div>
                    <AtlasTree nodes={data.pending.nodes} pages={pendingPages} selected={selectedNode} onSelect={setSelectedNode} />
                  </div>
                  <div style={{ flex: 2 }}>
                    {selectedPending ? (
                      <PageCard key={selectedPending.id + selectedPending.content_hash} page={selectedPending} adoptedNodes={data.adopted.nodes} connection={connection} sessionId={sessionId} onSaved={() => void refresh()} />
                    ) : (
                      <div className={css.itemLine}>左侧选一个候选节点查看页卡。</div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
            {data?.bound && tab === 'atlas' ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, borderRight: '1px solid #ddd', paddingRight: 8 }}>
                  <div className={css.sectionTitle}>地图册(已采用 {data.adopted.nodes.length} 节点 / {adoptedPages.length} 页)</div>
                  <AtlasTree nodes={data.adopted.nodes} pages={adoptedPages} selected={selectedNode} onSelect={setSelectedNode} />
                </div>
                <div style={{ flex: 2 }}>
                  {selectedPage ? (
                    <PageCard key={selectedPage.id + selectedPage.content_hash} page={selectedPage} adoptedNodes={data.adopted.nodes} connection={connection} sessionId={sessionId} onSaved={() => void refresh()} />
                  ) : (
                    <div className={css.itemLine}>
                      {selectedNode ? '待上传图片: 该空页占位节点还没有页面; 请让助手导入图片(novelcraft_map_atlas_upload) 后 adopt。' : '左侧选择节点; 空页占位节点点选后进入「待上传图片」态。'}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
      </Modal>
    </>
  )
}
