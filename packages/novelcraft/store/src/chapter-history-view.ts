// store · 单章 Git 版本历史线卡视图(加法导出)。
// dsh 工具与 client RPC 此前各自手写同一份 camelCase→snake_case 映射;
// 收敛为单一视图函数(与 UI wire 卡片同形), 两端共用零漂移。
// 注意: title 保持可选(不把缺失标题强转空串), 由消费方决定回退展示。
import type { ChapterHistoryEntry } from "./chapter-version.js";

/** 单章版本历史线卡(wire 同形, snake_case)。 */
export interface ChapterHistoryCardView {
  commit: string;
  authored_at: string;
  subject: string;
  status: string;
  title?: string;
  content_hash: string;
  declared_hash_valid: boolean;
  byte_length: number;
}

/** ChapterHistoryEntry → 历史线卡(字段重命名的唯一事实源)。 */
export function chapterHistoryCardView(entry: ChapterHistoryEntry): ChapterHistoryCardView {
  return {
    commit: entry.commit,
    authored_at: entry.authoredAt,
    subject: entry.subject,
    status: entry.status,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    content_hash: entry.contentHash,
    declared_hash_valid: entry.declaredHashValid,
    byte_length: entry.byteLength,
  };
}
