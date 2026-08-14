// assistant · 建议雷达(suggest-, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 建议雷达(「林晚家族背景只出现 1 次, 建议补设定」)、§11 打扰分级(note 静默堆积,
// 达 N3 notify_threshold=5 才亮宠物)。
// 规则: canonical 对象 evidence 条数 ≤1 → note(设定单薄, 建议补设定)。
// 对账: 全部经 reconcileRadarSignals(§11 静默纪律 + 双向对账; 作者补足 evidence 后自动结算)。
import { listObjects } from "@novelcraft/world";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";
import type { CreateSignalInput } from "./signals.js";

/** 建议雷达全扫: 设定单薄的 canonical 对象 → 收件箱(幂等, 双向对账)。 */
export function scanSuggestRadar(root: string, now?: Date): RadarReconcileResult {
  const hits: CreateSignalInput[] = [];
  for (const o of listObjects(root)) {
    if (o.status !== "canonical") continue; // 只盯已采用对象(§7 建议雷达)。
    const n = o.evidence.length;
    if (n > 1) continue; // evidence ≥2 视为设定充实。
    hits.push({
      id: `suggest-thin-${o.slug}`,
      radar: "suggest",
      severity: "note",
      title: `『${o.name}』的设定只出现 ${n} 次, 建议补设定`,
      evidence: n > 0 ? o.evidence : ["该对象暂无 evidence 记录"],
      proposed_action: "补设定(微工作流)",
      reversibility: true,
    });
  }
  return reconcileRadarSignals(root, "suggest-", hits, now);
}
