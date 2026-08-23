// 浏览器侧 RPC 数据面: 轮询 /novelcraft 通道的 watch/state 与 inbox/list,
// 四动词经 inbox/act 回宿主(assistant.act 确定性函数)。数据流纯 React hooks。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcCaller } from './index.ts'
import type {
  ChapterDossierValue,
  ChapterEditStageValue,
  ChapterWorkspaceValue,
  InboxActPayload,
  InboxActValue,
  InboxListValue,
  IntakeStageValue,
  PresetsListValue,
  PresetsSelectValue,
  StoryMapValue,
  WatchStateValue,
  WritingDeskValue,
  AtlasAnnotationOpInput,
  AtlasImageIntakeStageValue,
  AtlasViewValue,
  AtlasAnnotationRequestValue,
} from '../wire.ts'
import { ENDPOINTS, RPC_CHANNEL } from '../wire.ts'

/** 通道调用薄封装: 传输错误折叠为 null(UI 显示缺省态)。 */
async function call<T>(
  connection: RpcCaller | undefined,
  endpoint: string,
  payload: unknown,
): Promise<T | null> {
  if (!connection) return null
  try {
    const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (result.ok) return result.value as T
    return null
  } catch {
    return null
  }
}

export async function stageTextIntakeFile(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  fileName: string,
  bytesBase64: string,
): Promise<IntakeStageValue | null> {
  return call<IntakeStageValue>(connection, ENDPOINTS.intakeStage, {
    sessionId,
    file_name: fileName,
    bytes_base64: bytesBase64,
  })
}

export async function stageAtlasImageIntakeFile(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  fileName: string,
  bytesBase64: string,
  nodeRef: string,
): Promise<AtlasImageIntakeStageValue | null> {
  return call<AtlasImageIntakeStageValue>(connection, ENDPOINTS.intakeStageImage, {
    sessionId,
    file_name: fileName,
    bytes_base64: bytesBase64,
    node_ref: nodeRef,
  })
}

export async function loadChapterWorkspace(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  chapterIndex: number,
  diffFromCommit?: string,
): Promise<ChapterWorkspaceValue | null> {
  return call<ChapterWorkspaceValue>(connection, ENDPOINTS.chapterWorkspace, {
    sessionId,
    chapterIndex,
    ...(diffFromCommit ? { diffFromCommit } : {}),
  })
}

export async function stageChapterEdit(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  input: { chapterIndex: number; expectedContentHash: string; title?: string; text: string },
): Promise<ChapterEditStageValue | null> {
  return call<ChapterEditStageValue>(connection, ENDPOINTS.chapterStageEdit, {
    sessionId,
    chapterIndex: input.chapterIndex,
    expected_content_hash: input.expectedContentHash,
    ...(input.title !== undefined ? { title: input.title } : {}),
    text: input.text,
  })
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string' || !result.includes(',')) reject(new Error('read failed'))
      else resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** 事件触发短轮询下界与退避上界(ADR-0018 §2)。 */
export const POLL_MIN_MS = 1000
export const POLL_MAX_MS = 15000

/** 轮询退避策略(ADR-0018 §2): 数据有变化 → 立即回到短轮询下界; 无变化 → 指数退避封顶。 */
export function nextPollDelay(changed: boolean, previousDelayMs: number): number {
  return changed ? POLL_MIN_MS : Math.min(previousDelayMs * 2, POLL_MAX_MS)
}

/**
 * 一轮 run 完成后的续排决策(纯逻辑, ADR-0018 §2): 返回下一轮延迟, null = 不再续排。
 *
 * - epoch 已切代际(cleanup 后)→ null: 本 effect 已死, 不续排(新 effect 自行排程);
 * - 'stale'(本链被同代际更新请求取代, 如外部 refresh/事件刷新)→ POLL_MIN_MS:
 *   更新方(公共 refresh / 事件 handler)不一定负责续排 —— 公共 refresh 只登记
 *   latest-wins token 并在完成后直接返回, 不 schedule; 若在途 poll 被它取代后
 *   直接不续排, 轮询链就静默停摆。只要 effect 仍存活就必须确保存在下一轮
 *   短轮询。schedule 本身清旧 timer 幂等: 事件 handler 已排的 POLL_MIN_MS
 *   被同延迟替换, 不被破坏;
 * - 'changed'/'unchanged' → 沿用指数退避(变化回下界, 无变化翻倍封顶)。
 */
export function nextPollAction(
  result: 'changed' | 'unchanged' | 'stale',
  epochCurrent: boolean,
  previousDelayMs: number,
): number | null {
  if (!epochCurrent) return null
  if (result === 'stale') return POLL_MIN_MS
  return nextPollDelay(result === 'changed', previousDelayMs)
}

/** 宠物状态(四态 + 徽标数 + 剧情一句话)。 */
export interface WatchSnapshot {
  bound: boolean
  book: string | null
  open: number
  attention: boolean
  threshold: number
  radarRunning: boolean
  /** 剧情雷达一句话摘要(§9 静默态默认答复); 未绑定/失败为 null。 */
  plotSummary: string | null
}

const EMPTY_WATCH: WatchSnapshot = {
  bound: false,
  book: null,
  open: 0,
  attention: false,
  threshold: 5,
  radarRunning: false,
  plotSummary: null,
}

/** 请求竞态护栏的请求标号(纯逻辑, 见 createSeqGate)。 */
export interface RequestToken {
  /** effect 代际: cleanup 递增; 跨代际的旧请求一律作废。 */
  epoch: number
  /** 代际内请求序号: 新请求取代旧请求(latest-wins)。 */
  req: number
}

export interface SeqGate {
  /** 登记一个新请求; 响应到达时用 isCurrent 判定是否仍可应用。 */
  request(): RequestToken
  /** 该请求仍是「当前代际的最新请求」→ 响应可应用(latest-wins)。 */
  isCurrent(token: RequestToken): boolean
  /** 该 epoch 仍为当前代际 → 对应的 effect 仍活着(可续排)。 */
  isCurrentEpoch(epoch: number): boolean
  /** 只读当前代际快照(不登记请求、不递增): schedule 用它捕获 epoch marker,
   *  避免「预登记」请求把在途 refresh 判 stale 或自身被后续事件刷新作废。 */
  snapshotEpoch(): number
  /** cleanup 用: 代际 +1, 作废全部在途请求(卸载/依赖切换)。 */
  invalidate(): void
}

/**
 * 请求竞态护栏(纯逻辑, 无 React 依赖): 双信号封堵旧请求。
 * - invalidate() 只在 effect cleanup 调用: 依赖切换(session/connection)或卸载后,
 *   旧代际在途请求一律作废 —— 不 setState, 续排判定(isCurrentEpoch)也失配;
 * - request() 每次登记递增序号: 同代际内新请求 latest-wins, 旧请求响应作废。
 * 重新挂载 = 新组件实例, 新 gate 从初始代际恢复。
 */
export function createSeqGate(initialEpoch = 0): SeqGate {
  let epoch = initialEpoch
  let latest = 0
  return {
    request() {
      latest += 1
      return { epoch, req: latest }
    },
    isCurrent(token) {
      return token.epoch === epoch && token.req === latest
    },
    isCurrentEpoch(e) {
      return e === epoch
    },
    snapshotEpoch() {
      return epoch
    },
    invalidate() {
      epoch += 1
    },
  }
}

/** 轮询 watch/state(宠物数据源): 事件触发立即刷新 + 退避短轮询(ADR-0018 §2)。
 *  响应护栏: createSeqGate —— cleanup(invalidate)作废旧代际在途请求,
 *  同代际新请求 latest-wins; 依赖切换/卸载后旧响应不 setState 也不续排。 */
export function useWatch(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<WatchSnapshot>(EMPTY_WATCH)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRef = useRef<WatchSnapshot>(EMPTY_WATCH)
  const gateRef = useRef<SeqGate | null>(null)
  if (gateRef.current === null) gateRef.current = createSeqGate()
  const gate = gateRef.current

  /** 带固定请求标号执行一次刷新; 'stale' = 已被更新请求/cleanup 作废。 */
  const run = useCallback(
    async (token: RequestToken): Promise<'changed' | 'unchanged' | 'stale'> => {
      const value = await call<WatchStateValue>(connection, ENDPOINTS.watchState, {
        sessionId: sessionRef.current,
      })
      if (!gate.isCurrent(token)) return 'stale'
      if (!value) return 'unchanged'
      const next: WatchSnapshot = {
        bound: value.bound !== null,
        book: value.bound?.book ?? null,
        open: value.open,
        attention: value.attention,
        threshold: value.threshold,
        radarRunning: value.radarRunning,
        plotSummary: value.plotSummary ?? null,
      }
      const changed =
        next.bound !== lastRef.current.bound ||
        next.book !== lastRef.current.book ||
        next.open !== lastRef.current.open ||
        next.attention !== lastRef.current.attention ||
        next.threshold !== lastRef.current.threshold ||
        next.radarRunning !== lastRef.current.radarRunning ||
        next.plotSummary !== lastRef.current.plotSummary
      lastRef.current = next
      if (changed) setSnapshot(next)
      return changed ? 'changed' : 'unchanged'
    },
    [connection],
  )

  const refresh = useCallback(async (): Promise<boolean> => {
    const result = await run(gate.request())
    return result === 'changed'
  }, [run])

  const schedule = useCallback(
    (delayMs: number) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      // 只捕获当前代际 marker, 不登记请求: schedule 本不该参与请求序,
      // 预登记 token 既会把在途 refresh 判 stale, 也会被中间事件刷新作废(轮询落空)。
      const marker = gate.snapshotEpoch()
      timerRef.current = setTimeout(() => {
        // timeout 真正触发时先确认 marker 代际仍 current —— cleanup(切代际)后
        // 旧 timer 即使竞态触发也不得在新代际发请求。
        if (!gate.isCurrentEpoch(marker)) return
        // 此刻才登记本次轮询 token(latest-wins 保持: 若期间有事件刷新,
        // refresh 已先登记并重排, 本条 run 会被判 stale)。
        const token = gate.request()
        void run(token).then((result) => {
          // 续排决策收敛在 nextPollAction(纯逻辑): stale 且 epoch 仍 current 时
          // 也确保下一轮短轮询 —— 取代本链的外部 refresh 不负责 schedule,
          // 否则轮询会静默停摆(公共 refresh 缺口); cleanup 切代际则一律不续排。
          const next = nextPollAction(result, gate.isCurrentEpoch(marker), delayMs)
          if (next !== null) schedule(next)
        })
      }, delayMs)
    },
    [run],
  )

  useEffect(() => {
    void refresh()
    schedule(POLL_MIN_MS)
    const onFocus = () => {
      void refresh()
      schedule(POLL_MIN_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
        schedule(POLL_MIN_MS)
      }
    }
    // 宿主真推送(ADR-0018 §1): client/push → DOM 事件 → 立即刷新并重置退避。
    const onSignalsChanged = () => {
      void refresh()
      schedule(POLL_MIN_MS)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('novelcraft:signals-changed', onSignalsChanged)
    return () => {
      // 作废旧代际在途请求: 旧 session/connection 的响应不得 setState,
      // 其 .then 续排也会因 epoch 失配被拒(不会重排到新代际的 timer)。
      gate.invalidate()
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('novelcraft:signals-changed', onSignalsChanged)
    }
  }, [refresh, schedule])

  return { snapshot, refresh }
}

/** 收件箱视图(卡片列表 + 阈值)。 */
export function useInbox(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [cards, setCards] = useState<InboxListValue['signals']>([])
  const [bound, setBound] = useState<{ book: string; root: string } | null>(null)
  const [threshold, setThreshold] = useState(5)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const value = await call<InboxListValue>(connection, ENDPOINTS.inboxList, { sessionId })
    if (!value) return
    setCards(value.signals)
    setBound(value.bound)
    setThreshold(value.threshold)
  }, [connection, sessionId])

  /** 四动词: 回宿主执行 assistant.act; 返回作者语言消息。 */
  const actOn = useCallback(async (payload: InboxActPayload): Promise<string | null> => {
    setBusy(true)
    try {
      // call<T> 已解包 RpcResult.value: 成功直接是 InboxActValue, 失败(传输/RpcError)→ null。
      // 切勿再包一层 RpcResult 并访问 .value —— 成功路径必 TypeError。
      const value = await call<InboxActValue>(connection, ENDPOINTS.inboxAct, payload)
      if (value === null) return null
      void refresh()
      return value.message
    } finally {
      setBusy(false)
    }
  }, [connection, refresh])

  return { cards, bound, threshold, busy, refresh, actOn }
}

/** 地图册数据源(atlas/view; Phase 6: 规划 run + adopted/pending 树 + 标注队列)。 */
export function useAtlasView(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [data, setData] = useState<AtlasViewValue | null>(null)
  const refresh = useCallback(async () => {
    const value = await call<AtlasViewValue>(connection, ENDPOINTS.atlasView, { sessionId })
    if (value) setData(value)
  }, [connection, sessionId])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, refresh }
}

/** 标注请求(atlas/annotation-request; 落队列 + 信号, 不写资产)。 */
export async function requestAtlasAnnotations(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  pageRef: string,
  baseContentHash: string,
  ops: AtlasAnnotationOpInput[],
): Promise<AtlasAnnotationRequestValue | null> {
  return call<AtlasAnnotationRequestValue>(connection, ENDPOINTS.atlasAnnotationRequest, {
    sessionId,
    page_ref: pageRef,
    base_content_hash: baseContentHash,
    ops,
  })
}

/** 剧情地图数据源(story/map; 结构资产 + Scene/章节覆盖)。 */
export function useStoryMap(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [data, setData] = useState<StoryMapValue | null>(null)
  const refresh = useCallback(async () => {
    const value = await call<StoryMapValue>(connection, ENDPOINTS.storyMap, { sessionId })
    if (value) setData(value)
  }, [connection, sessionId])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, refresh }
}

/** 写作台数据源(writing/desk; 四模式: 守望信号/计划结构/参照对象/评审摘要)。 */
export function useWritingDesk(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [data, setData] = useState<WritingDeskValue | null>(null)
  const refresh = useCallback(async () => {
    const value = await call<WritingDeskValue>(connection, ENDPOINTS.writingDesk, { sessionId })
    if (value) setData(value)
  }, [connection, sessionId])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, refresh }
}

/** 模型预设数据源(presets/list + presets/select; N20/D13)。select 失败返回 {ok:false, message}。 */
export function useModelPresets(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [data, setData] = useState<PresetsListValue | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const value = await call<PresetsListValue>(connection, ENDPOINTS.presetsList, { sessionId })
    if (value) setData(value)
  }, [connection, sessionId])
  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 选择/清除预设: 回宿主 selectPresetInLlmYml(N19 只动 llm.yml preset 键); 成功即刷新。 */
  const select = useCallback(
    async (preset: string | null): Promise<{ ok: boolean; message: string } | null> => {
      setBusy(true)
      try {
        // call<T> 已解包 RpcResult.value: 失败(传输/RpcError)→ null(UI 走预设失败文案)。
        const value = await call<PresetsSelectValue>(connection, ENDPOINTS.presetsSelect, {
          sessionId,
          preset,
        })
        if (value === null) return null
        if (value.ok) {
          void refresh()
          return { ok: true, message: value.message }
        }
        return { ok: false, message: value.message }
      } finally {
        setBusy(false)
      }
    },
    [connection, sessionId, refresh],
  )

  return { data, busy, refresh, select }
}

/** 章节档案数据源(chapter/dossier; §17.5.1 每章一整页钻取; chapterIndex 变化重取, null 清空)。 */
export function useChapterDossier(
  connection: RpcCaller | undefined,
  sessionId: string | undefined,
  chapterIndex: number | null,
) {
  const [data, setData] = useState<ChapterDossierValue | null>(null)
  // 章节序号护栏: 章切换后旧章的慢响应必须作废, 不得覆盖新章数据
  // (chapterIndex 每次变化递增 seq; 清空(null)也作废在途)。
  const chapterSeqRef = useRef(0)
  const refresh = useCallback(async () => {
    if (chapterIndex == null) {
      chapterSeqRef.current += 1
      setData(null)
      return
    }
    const seq = chapterSeqRef.current + 1
    chapterSeqRef.current = seq
    const value = await call<ChapterDossierValue>(connection, ENDPOINTS.chapterDossier, {
      sessionId,
      chapterIndex,
    })
    if (value === null || seq !== chapterSeqRef.current) return
    setData(value)
  }, [connection, sessionId, chapterIndex])
  useEffect(() => {
    void refresh()
    return () => {
      // 卸载/依赖切换: 递增作废在途章节请求, 防旧响应在 unmount 后 setState。
      chapterSeqRef.current += 1
    }
  }, [refresh])
  return { data, refresh }
}
