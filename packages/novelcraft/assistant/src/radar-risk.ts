// assistant · 风险雷达(risk-, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 风险雷达(「第 9 章伏笔至今未回收」)、§11 打扰分级(risk 进角标, note 静默堆积)。
// 规则:
//   1. 伏笔超期: planned_payoff_chapter 为数值且 < 当前最大章 index 且无 reveals_foreshadowing 边指向 → risk;
//   2. 章断档: 章 index 序列 1..max 缺号 → note;
//   3. 悬空关系: index.relations 的 target 不在 (objects ∪ scenes ∪ structure) slug 集 → risk。
// 对账: 全部经 reconcileRadarSignals(§11 静默纪律 + 双向对账; 条件消失自动结算)。
import { rebuildIndex, storyMap, type StoryMap, type VaultIndex } from "@novelcraft/store";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";
import { signalIdFromKey, signalLogicalKey, type CreateSignalInput } from "./signals.js";

/** 风险雷达全扫: 伏笔超期 + 章断档 + 悬空关系 → 收件箱(幂等, 双向对账)。 */
export function scanRiskRadar(root: string, now?: Date): RadarReconcileResult {
  return reconcileRadarSignals(root, "risk-", collectRiskRadarHits(root), now);
}

export function collectRiskRadarHits(
  root: string,
  data: { map: StoryMap; index: VaultIndex } = { map: storyMap(root), index: rebuildIndex(root) },
): CreateSignalInput[] {
  const hits: CreateSignalInput[] = [];
  const { map, index } = data;
  const maxChapter = map.chapters.reduce((m, c) => Math.max(m, c.index), 0);

  // 1. 伏笔超期(§7 风险雷达): 计划回收点已过且未被 reveals_foreshadowing 边回收。
  for (const f of map.foreshadowing) {
    const p = f.planned_payoff_chapter;
    if (typeof p !== "number") continue; // 未计划回收点, 不判超期。
    const revealed = map.edges.some(
      (e) => e.type === "reveals_foreshadowing" && e.target === f.slug,
    );
    if (revealed) continue;
    if (p >= maxChapter) continue; // 计划点未到(或全书未写), 不超期。
    hits.push({
      id: `risk-foreshadow-overdue-${f.slug}`,
      logical_key: signalLogicalKey("risk", "foreshadow_overdue", f.slug),
      radar: "risk",
      severity: "risk",
      title: `『${f.name}』伏笔计划第 ${p} 章回收, 目前已写到第 ${maxChapter} 章`,
      evidence: [`planned_payoff_chapter=${p}, 当前最大章=${maxChapter}`],
      proposed_action: "安排回收或调整计划回收点",
      reversibility: true,
    });
  }

  // 2. 章断档: 序列 1..max 缺号(§7 风险雷达连续性检查)。
  const present = new Set(map.chapters.map((c) => c.index));
  for (let n = 1; n <= maxChapter; n++) {
    if (present.has(n)) continue;
    hits.push({
      id: `risk-chapter-gap-${n}`,
      logical_key: signalLogicalKey("risk", "chapter_gap", n),
      radar: "risk",
      severity: "note",
      title: `第 ${n} 章缺失(章序号断档)`,
      evidence: [`chapters/ 目录中不存在 ${String(n).padStart(3, "0")}.md`],
      proposed_action: "确认是否漏导入或刻意跳号",
      reversibility: true,
    });
  }

  // 3. 悬空关系: target 不在 (objects ∪ scenes ∪ structure) slug 集(ADR-0019 §4 跨类索引)。
  const known = new Set<string>([
    ...index.objects.map((o) => o.slug),
    ...index.scenes.map((s) => s.slug),
    ...index.structure.map((s) => s.slug),
  ]);
  for (const e of index.relations) {
    if (known.has(e.target)) continue;
    const logicalKey = signalLogicalKey("risk", "dangling_relation", e.source, e.target, e.type || "?");
    hits.push({
      id: signalIdFromKey("risk-dangling-", logicalKey),
      logical_key: logicalKey,
      radar: "risk",
      severity: "risk",
      title: `关系边悬空: ${e.source} → ${e.target}`,
      evidence: [`relations 边 source=${e.source} target=${e.target} type=${e.type || "?"}`],
      proposed_action: "修正或删除该关系",
      reversibility: true,
    });
  }

  return hits;
}
