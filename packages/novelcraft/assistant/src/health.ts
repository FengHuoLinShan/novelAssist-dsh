// assistant · 健康信号扫描器(编排层, 确定性, 非 LLM)。
// 把 @novelcraft/outline 的确定性健康命中(Scene 四键 + 结构资产两键)映射为
// 收件箱信号, 经 pushSignal 落 .assistant/signals/*.json(§20.6 / outline.md §535)。
// 幂等 + 双向对账: 确定性 id `health-{key}-{ns}-{slug}`;
//   正向: 无信号 → open; 新观察重新 open; 相同观察保留作者裁决;
//   反向: 条件已消失的 open 健康信号 → resolved(自动结算, outline.md §566)。
import {
  listScenes,
  sceneHealthSignals,
  structureHealthSignals,
  structureHealthSignalsFromEntries,
} from "@novelcraft/outline";
import type { VaultIndexSnapshot } from "@novelcraft/store";
import { reconcileRadarSignals, reconcileRadarSignalsAtomic } from "./radar-utils.js";
import { signalLogicalKey, type CreateSignalInput, type Severity } from "./signals.js";

const RADAR = "writing" as const;

/** 健康信号确定性 id 前缀(扫描器对账时的归属判别)。 */
const HEALTH_ID_PREFIX = "health-";

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
  duplicate_chapter: "场景中出现重复章节",
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
  scene_unreviewed: "检查并确认这个场景",
  scene_unassigned_chapter: "为这个场景指定所属章节",
  scene_missing_setup: "补齐目标/核心冲突/必发生项/禁止发生项",
  scene_needs_organize: "整理这个场景与章节的对应关系",
  structure_needs_review: "检查并确认这项剧情结构",
  structure_unassigned: "为这项剧情结构关联剧情线",
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
    evidence = ["这个场景还没有关联任何章节"];
  } else {
    evidence = ["这个场景还没有完成作者确认"];
  }
  return {
    id: `health-${detail.key}-scene-${slug}`,
    logical_key: signalLogicalKey("health", detail.key, "scene", slug),
    radar: RADAR,
    severity: SEVERITY[detail.key] ?? "note",
    title: (TITLE[detail.key] ?? ((n) => `「${n}」有结构问题`))(name),
    evidence,
    proposed_action: ACTION[detail.key] ?? "检查并修正这个场景",
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
    ? [`这项${label}还没有完成作者确认`]
    : [`这项${label}还没有关联剧情线`];
  return {
    id: `health-${key}-${kind}-${slug}`,
    logical_key: signalLogicalKey("health", key, kind, slug),
    radar: RADAR,
    severity: SEVERITY[key] ?? "note",
    title: (TITLE[key] ?? ((n) => `${label}「${n}」有结构问题`))(name),
    evidence,
    proposed_action: ACTION[key] ?? "检查并修正这项剧情结构",
    reversibility: true,
  };
}

export interface HealthScanResult {
  /** 本次新建的信号数 */
  created: number;
  /** 已存在且状态未变的信号数(幂等) */
  skipped: number;
  /** 本次自动结算(open → resolved)的信号数 */
  resolved: number;
  /** 本次重新开放(resolved → open)的信号数 */
  reopened: number;
  /** 当前命中总数(created + skipped + reopened) */
  total: number;
}

/**
 * 扫描全 vault 的结构健康信号并落盘收件箱(幂等, 确定性, 双向对账)。
 * 正向: Scene 四键经 sceneHealthSignals(listScenes), 结构资产两键经 structureHealthSignals;
 * 反向: 不再命中的 open 健康信号(health- 前缀)自动置 resolved(outline.md §566)。
 */
export function scanHealthSignals(root: string, now: Date = new Date()): HealthScanResult {
  return reconcileRadarSignals(root, HEALTH_ID_PREFIX, collectHealthRadarHits(root), now);
}

/** 生产入口：先完整规划，再经一次 state transaction 写入。 */
export function scanHealthSignalsAtomic(root: string, now: Date = new Date()): Promise<HealthScanResult> {
  return reconcileRadarSignalsAtomic(root, HEALTH_ID_PREFIX, collectHealthRadarHits(root), now);
}

/** 纯命中收集，供一次 sweep 的原子对账复用。 */
export function collectHealthRadarHits(root: string, snapshot?: VaultIndexSnapshot): CreateSignalInput[] {
  const hits: CreateSignalInput[] = [];
  const scenes = snapshot === undefined
    ? listScenes(root)
    : snapshot.index.scenes.map((scene) => {
        const fm = snapshot.frontmatterByFile.get(scene.file) ?? {};
        return {
          slug: scene.slug,
          title: typeof fm.title === "string" ? fm.title : "",
          status: scene.status,
          chapter_ids: scene.chapters.map(Number),
          file: scene.file,
          fm,
        };
      });
  for (const s of sceneHealthSignals(scenes)) {
    for (const d of s.details) hits.push(sceneSignal(s.slug, s.title, d));
  }

  const structures = snapshot === undefined
    ? structureHealthSignals(root)
    : structureHealthSignalsFromEntries(
        snapshot.index.structure
          .filter((entry) => entry.kind !== "outline")
          .map((entry) => {
            const fm = snapshot.frontmatterByFile.get(entry.file) ?? {};
            return {
              kind: entry.kind,
              slug: entry.slug,
              title: typeof fm.title === "string" ? fm.title : String(fm.name ?? ""),
              fm,
            };
          }),
      );
  for (const st of structures) {
    for (const key of st.keys) hits.push(structureSignal(st.kind, st.slug, st.title, key));
  }
  return hits;
}
