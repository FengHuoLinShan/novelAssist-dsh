// assistant · 健康信号扫描器(编排层, 确定性, 非 LLM)。
// 把 @novelcraft/outline 的确定性健康命中(Scene 四键 + 结构资产两键)映射为
// 收件箱信号, 经 pushSignal 落 .assistant/signals/*.json(§20.6 / outline.md §535)。
// 幂等: 确定性 id `health-{key}-{ns}-{slug}`; 已存在(含已 accept/reject/defer)
// 即跳过 —— 不复活作者已处理过的信号; v1 不自动清除条件消失的旧 open 信号。
import { listScenes, sceneHealthSignals, structureHealthSignals } from "@novelcraft/outline";
import { loadSignal, pushSignal } from "./inbox.js";
import type { CreateSignalInput, Severity } from "./signals.js";

const RADAR = "writing" as const;

/** 键 → 打扰分级(§11: 未复核/待复核静默堆积; 其余进角标)。 */
const SEVERITY: Record<string, Severity> = {
  scene_unreviewed: "note",
  scene_unassigned_chapter: "risk",
  scene_missing_setup: "risk",
  scene_needs_organize: "risk",
  structure_needs_review: "note",
  structure_unassigned: "risk",
};

/** 结构资产 kind → 作者语言。 */
const KIND_LABEL: Record<string, string> = {
  thread: "剧情线",
  arc: "篇章纲",
  foreshadowing: "伏笔",
  reveal: "回收",
};

/** 整理类 reason 码 → 作者语言(outline.md §547)。 */
const REASON_LABEL: Record<string, string> = {
  duplicate_chapter: "Scene 内章节重复",
  chunk_chapter_mismatch: "章节与正文分段不一致",
};

/** 缺设定字段 → 作者语言。 */
const FIELD_LABEL: Record<string, string> = {
  goal: "目标",
  core_conflict: "核心冲突",
  must_happen: "必发生项",
  must_not_happen: "禁止发生项",
};

const TITLE: Record<string, (name: string) => string> = {
  scene_unreviewed: (n) => `「${n}」尚未复核`,
  scene_unassigned_chapter: (n) => `「${n}」未关联章节`,
  scene_missing_setup: (n) => `「${n}」缺设定`,
  scene_needs_organize: (n) => `「${n}」待整理`,
  structure_needs_review: (n) => `「${n}」待复核`,
  structure_unassigned: (n) => `「${n}」未关联`,
};

const ACTION: Record<string, string> = {
  scene_unreviewed: "复核该 Scene 并标记 reviewed_at",
  scene_unassigned_chapter: "为该 Scene 指定 chapter_ids，或标 planning_state=planned",
  scene_missing_setup: "补齐目标/核心冲突/必发生项/禁止发生项",
  scene_needs_organize: "按证据整理该 Scene 的章节映射",
  structure_needs_review: "复核该结构资产",
  structure_unassigned: "为该结构资产关联剧情线",
};

/** Scene 命中 → 信号输入(作者语言命题 + 证据)。 */
function sceneSignal(
  slug: string,
  title: string,
  detail: { key: string; missing?: string[]; reasons?: string[] },
): CreateSignalInput {
  const name = title || slug;
  let evidence: string[];
  if (detail.key === "scene_missing_setup") {
    evidence = (detail.missing ?? []).map((f) => `缺${FIELD_LABEL[f] ?? f}`);
  } else if (detail.key === "scene_needs_organize") {
    evidence = (detail.reasons ?? []).map((r) => REASON_LABEL[r] ?? r);
  } else if (detail.key === "scene_unassigned_chapter") {
    evidence = ["该 Scene 未关联任何章节(chapter_ids 为空)"];
  } else {
    evidence = ["该 Scene 尚未标记 reviewed_at"];
  }
  return {
    id: `health-${detail.key}-scene-${slug}`,
    radar: RADAR,
    severity: SEVERITY[detail.key] ?? "note",
    title: (TITLE[detail.key] ?? ((n) => `「${n}」有结构问题`))(name),
    evidence,
    proposed_action: ACTION[detail.key] ?? "复核并修正该 Scene",
    reversibility: true,
  };
}

/** 结构资产命中 → 信号输入。 */
function structureSignal(
  kind: string,
  slug: string,
  title: string,
  key: string,
): CreateSignalInput {
  const label = KIND_LABEL[kind] ?? kind;
  const name = title || slug;
  const evidence = key === "structure_needs_review"
    ? [`该${label}资产未标记复核`]
    : [`该${label}资产未关联剧情线`];
  return {
    id: `health-${key}-${kind}-${slug}`,
    radar: RADAR,
    severity: SEVERITY[key] ?? "note",
    title: (TITLE[key] ?? ((n) => `${label}「${n}」有结构问题`))(name),
    evidence,
    proposed_action: ACTION[key] ?? "复核并修正该结构资产",
    reversibility: true,
  };
}

export interface HealthScanResult {
  /** 本次新建的信号数 */
  created: number;
  /** 已存在而跳过的信号数(幂等) */
  skipped: number;
  /** 命中总数(created + skipped) */
  total: number;
}

/**
 * 扫描全 vault 的结构健康信号并落盘收件箱(幂等, 确定性)。
 * Scene 四键经 sceneHealthSignals(listScenes), 结构资产两键经 structureHealthSignals。
 */
export function scanHealthSignals(root: string): HealthScanResult {
  let created = 0;
  let skipped = 0;
  let total = 0;

  for (const s of sceneHealthSignals(listScenes(root))) {
    for (const d of s.details) {
      total += 1;
      const input = sceneSignal(s.slug, s.title, d);
      if (loadSignal(root, input.id!)) {
        skipped += 1;
        continue;
      }
      pushSignal(root, input);
      created += 1;
    }
  }

  for (const st of structureHealthSignals(root)) {
    for (const key of st.keys) {
      total += 1;
      const input = structureSignal(st.kind, st.slug, st.title, key);
      if (loadSignal(root, input.id!)) {
        skipped += 1;
        continue;
      }
      pushSignal(root, input);
      created += 1;
    }
  }

  return { created, skipped, total };
}
