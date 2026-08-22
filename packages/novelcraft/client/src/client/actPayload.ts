// 收件箱动作载荷构造(纯函数, 无 React/DOM 依赖; InboxPanel 与测试共用)。
// wire 契约: InboxActPayload.modifiedTitle/modifiedProposedAction ↔ assistant
// ActInput.modified.title/proposed_action(宿主 rpc.inboxAct 负责映射落盘)。
import type { InboxActPayload, SignalCard } from '../wire.ts'

export type InboxAction = InboxActPayload['action']

/** 打回/改一改内联编辑字段(与 assistant ActInput.modified 同形状, 作者语言)。 */
export interface ActModifyFields {
  title?: string
  proposed_action?: string
}

/**
 * 构造 inbox/act 载荷。
 * - modified.title / modified.proposed_action → wire modifiedTitle / modifiedProposedAction;
 * - 空字符串省略(与宿主 act 的 truthy 判定一致: 空修改不覆盖原值)。
 */
export function buildActPayload(
  card: Pick<SignalCard, 'id'>,
  sessionId: string | undefined,
  action: InboxAction,
  reason?: string,
  modified?: ActModifyFields,
): InboxActPayload {
  return {
    sessionId,
    signalId: card.id,
    action,
    ...(reason ? { reason } : {}),
    ...(modified?.title ? { modifiedTitle: modified.title } : {}),
    ...(modified?.proposed_action ? { modifiedProposedAction: modified.proposed_action } : {}),
  }
}