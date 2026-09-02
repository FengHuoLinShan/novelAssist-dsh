// assistant · 去重雷达(dedup-, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 去重雷达(「『苏婉』与『红衣女子』疑似同一人」)、§11 打扰分级(risk 进角标, hint 静默堆积)。
// 规则:
//   1. world 对象(已采用 + pending 候选)经 store.l0ExactGroups 精确同名同型分组(≥2)→ risk;
//   2. pending 候选归一化名命中 canonical 对象的 aliases(不命中其 name)→ hint(attach_alias 候选, N3 alias 阈值的确定性前置)。
// 对账: 全部经 reconcileRadarSignals(§11 静默纪律 + 双向对账)。
import { listObjects, listPending } from "@novelcraft/world";
import { l0ExactGroups, normalizeAliasKey, normalizeNameForKey } from "@novelcraft/store";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";
import { signalIdFromKey, signalLogicalKey, type CreateSignalInput } from "./signals.js";

export interface DedupRadarObject {
  slug: string;
  name: string;
  entity_type: string;
  status: string;
  aliases: string[];
}

/** 去重雷达全扫: L0 同名同型组 + 别名候选 → 收件箱(幂等, 双向对账)。 */
export function scanDedupRadar(root: string, now?: Date): RadarReconcileResult {
  return reconcileRadarSignals(root, "dedup-", collectDedupRadarHits(root), now);
}

export function collectDedupRadarHits(
  root: string,
  data: { objects: DedupRadarObject[]; pending: DedupRadarObject[] } = {
    objects: listObjects(root),
    pending: listPending(root),
  },
): CreateSignalInput[] {
  const hits: CreateSignalInput[] = [];
  const { objects, pending } = data;

  // 1. L0 精确分组(store-rules R28): 归一化名完全相同且同型。
  const all = [...objects, ...pending].map((o) => ({
    kind: o.entity_type,
    name: o.name,
    slug: o.slug,
    status: o.status,
    aliases: o.aliases,
  }));
  for (const group of l0ExactGroups(all)) {
    const sorted = group.slice().sort((a, b) => a.slug.localeCompare(b.slug));
    const [n1, n2] = [sorted[0].name, sorted[1].name];
    const logicalKey = signalLogicalKey("dedup", "l0", sorted[0].kind, normalizeNameForKey(sorted[0].name));
    hits.push({
      id: signalIdFromKey("dedup-l0-", logicalKey),
      logical_key: logicalKey,
      radar: "dedup",
      severity: "risk",
      title: `『${n1}』『${n2}』疑似同一对象`,
      evidence: sorted.map((item) => item.aliases.length > 0
        ? `『${item.name}』还使用了别名：${item.aliases.join("、")}`
        : `『${item.name}』与另一条记录名称相同`),
      proposed_action: `确认『${n1}』与『${n2}』是否需要合并`,
      reversibility: true,
    });
  }

  // 2. pending 归一化名命中 canonical aliases(不命中 name)→ attach_alias 候选。
  const canonicals = objects.filter((o) => o.status === "canonical");
  for (const p of pending) {
    const pKey = normalizeAliasKey(p.name);
    if (pKey === "") continue;
    const matches = canonicals
      .filter(
        (c) =>
          normalizeAliasKey(c.name) !== pKey &&
          c.aliases.some((a) => normalizeAliasKey(a) === pKey),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));
    if (matches.length === 0) continue;
    const c = matches[0];
    hits.push({
      id: `dedup-alias-${p.slug}`,
      logical_key: signalLogicalKey("dedup", "alias", p.slug, c.slug),
      radar: "dedup",
      severity: "hint",
      title: `『${p.name}』可能是『${c.name}』的别名`,
      evidence: [
        `已采用的『${c.name}』把「${p.name}」记为别名`,
        `待确认内容中又出现了同名记录`,
      ],
      proposed_action: "确认是否将它作为已有设定的别名",
      reversibility: true,
    });
  }

  return hits;
}
