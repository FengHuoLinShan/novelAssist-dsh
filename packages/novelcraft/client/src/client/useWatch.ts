// 浏览器侧 RPC 数据面: 轮询 /novelcraft 通道的 watch/state 与 inbox/list,
// 四动词经 inbox/act 回宿主(assistant.act 确定性函数)。数据流纯 React hooks。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller } from './index.ts'
import type {
  ChapterDossierValue,
  InboxActPayload,
  InboxActValue,
  InboxListValue,
  PresetsListValue,
  PresetsSelectValue,
  StoryMapValue,
  WatchStateValue,
  WritingDeskValue,
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

/** 事件触发短轮询下界与退避上界(ADR-0018 §2)。 */
export const POLL_MIN_MS = 1000
export const POLL_MAX_MS = 15000

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

/** 轮询 watch/state(宠物数据源): 事件触发立即刷新 + 退避短轮询(ADR-0018 §2)。 */
export function useWatch(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<WatchSnapshot>(EMPTY_WATCH)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRef = useRef<WatchSnapshot>(EMPTY_WATCH)

  const refresh = useCallback(async (): Promise<boolean> => {
    const value = await call<WatchStateValue>(connection, ENDPOINTS.watchState, {
      sessionId: sessionRef.current,
    })
    if (!value) return false
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
    return changed
  }, [connection])

  const schedule = useCallback(
    (delayMs: number) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void refresh().then((changed) => {
          schedule(changed ? POLL_MIN_MS : Math.min(delayMs * 2, POLL_MAX_MS))
        })
      }, delayMs)
    },
    [refresh],
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
      const result = await call<RpcResult<InboxActValue>>(connection, ENDPOINTS.inboxAct, payload)
      if (result === null) return null
      if (result.ok) {
        void refresh()
        return result.value.message
      }
      return null
    } finally {
      setBusy(false)
    }
  }, [connection, refresh])

  return { cards, bound, threshold, busy, refresh, actOn }
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
        const result = await call<RpcResult<PresetsSelectValue>>(connection, ENDPOINTS.presetsSelect, {
          sessionId,
          preset,
        })
        if (result === null) return null
        if (result.ok) {
          void refresh()
          return { ok: true, message: result.value.message }
        }
        return { ok: false, message: result.error?.message ?? '' }
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
  const refresh = useCallback(async () => {
    if (chapterIndex == null) {
      setData(null)
      return
    }
    const value = await call<ChapterDossierValue>(connection, ENDPOINTS.chapterDossier, {
      sessionId,
      chapterIndex,
    })
    if (value) setData(value)
  }, [connection, sessionId, chapterIndex])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, refresh }
}

