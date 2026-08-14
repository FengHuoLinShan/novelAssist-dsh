// 浏览器侧 RPC 数据面: 轮询 /novelcraft 通道的 watch/state 与 inbox/list,
// 四动词经 inbox/act 回宿主(assistant.act 确定性函数)。数据流纯 React hooks。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller } from './index.ts'
import type {
  InboxActPayload,
  InboxActValue,
  InboxListValue,
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

export const POLL_INTERVAL_MS = 5000

/** 宠物状态(四态 + 徽标数)。 */
export interface WatchSnapshot {
  bound: boolean
  book: string | null
  open: number
  attention: boolean
  threshold: number
  radarRunning: boolean
}

const EMPTY_WATCH: WatchSnapshot = {
  bound: false,
  book: null,
  open: 0,
  attention: false,
  threshold: 5,
  radarRunning: false,
}

/** 轮询 watch/state(宠物数据源)。 */
export function useWatch(connection: RpcCaller | undefined, sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<WatchSnapshot>(EMPTY_WATCH)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const refresh = useCallback(async () => {
    const value = await call<WatchStateValue>(connection, ENDPOINTS.watchState, {
      sessionId: sessionRef.current,
    })
    if (!value) return
    setSnapshot({
      bound: value.bound !== null,
      book: value.bound?.book ?? null,
      open: value.open,
      attention: value.attention,
      threshold: value.threshold,
      radarRunning: value.radarRunning,
    })
  }, [connection])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

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

