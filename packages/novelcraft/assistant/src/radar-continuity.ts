// assistant · 连续性雷达(风险面的连续性子集, N54/M13-B 批 2, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 后续开发计划 §4d A2-2.1/A2-2.2 + N54 裁定(gap 8 项中的 7 项归 risk 面;
// scene_index_conflict 归 health 面, 见 health.ts 接线)。信号 id 前缀契约在
// evals/continuity-benchmark/catalog.json 一次定死, 本文件实现使其转 PASS。
// 检测器:
//   1. reveal_before_plant: reveal 最早揭示章早于伏笔埋设章(reveals_foreshadowing 边配对);
//   2. thread_range_invalid: 线程 start/end 倒置、<1 或越出实际最大章;
//   3. arc_thread_range_mismatch: 篇章纲章跨不含其关联线程章跨;
//   4. thread_orphan: 线程无任何 serves_thread 边挂靠(与 structure_unassigned
//      「无 related_thread_ids」语义分离——批 1 评审判别注记);
//   5. reveal_target_dangling: reveal.target_id 悬空(对象或伏笔都不存在);
//   6. payoff_scene_dangling: 伏笔 planned_payoff_scene 悬空(兑现 Scene 不存在);
//   7. legacy_edge_dangling: storyMap edges 全集中的悬空目标(N17 related_*_ids 投影
//      绕过写链校验是主要来源; pays_off_in_scene 边归 6 号检测器归属, 不在本面重复报;
//      references_memory 无文件落点不可解析, 不报)。
// 对账: 全部经 reconcileRadarSignals(§11 静默纪律 + 双向对账); risk 面统一
// "risk-" 前缀, 由 scanRiskContinuityRadar/collectGroup 与 radar-risk 命中合并后
// 一次对账(避免同前缀两次对账互相 resolve/reopen 抖动)。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import {
  parseFrontmatter,
  rebuildIndex,
  rebuildIndexSnapshot,
  storyMap,
  storyMapFromSnapshot,
  type StoryMap,
  type VaultIndex,
} from "@novelcraft/store";
import { collectRiskRadarHits } from "./radar-risk.js";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";
import { signalIdFromKey, signalLogicalKey, type CreateSignalInput } from "./signals.js";

/** 结构资产枚举条目(kind 与 store AssetKind 四值对齐)。 */
interface StructureFm {
  kind: "thread" | "arc" | "foreshadowing" | "reveal";
  slug: string;
  fm: Record<string, unknown>;
}

/** 枚举结构资产 frontmatter(与 outline structureHealthSignals 同款目录枚举纪律:
 * 只接收普通 .md 文件, 不跟随 symlink; deprecated 排除, R20)。 */
export function readStructureFms(root: string): StructureFm[] {
  const p = paths(root).structure;
  const dirs: Array<[StructureFm["kind"], string]> = [
    ["thread", p.threads],
    ["arc", p.arcs],
    ["foreshadowing", p.foreshadowing],
    ["reveal", p.reveal],
  ];
  const out: StructureFm[] = [];
  for (const [kind, dir] of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const { data } = parseFrontmatter(readFileSync(`${dir}/${entry.name}`, "utf8"));
      if (data.status === "deprecated") continue;
      out.push({ kind, slug: entry.name.replace(/\.md$/, ""), fm: data as Record<string, unknown> });
    }
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function numArr(v: unknown): number[] {
  return Array.isArray(v) ? (v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

/** reveal_stages 的最小章号(chapter_index ≥1 才计入; 坏值忽略)。 */
function revealMinStageChapter(fm: Record<string, unknown>): number | undefined {
  const stages = Array.isArray(fm.reveal_stages) ? fm.reveal_stages : [];
  let min: number | undefined;
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") continue;
    const chapter = num((stage as Record<string, unknown>).chapter_index);
    if (chapter === undefined || chapter < 1) continue;
    min = min === undefined ? chapter : Math.min(min, chapter);
  }
  return min;
}

/** 连续性命中收集(纯读; 供 risk 面合并对账复用)。 */
export function collectContinuityRadarHits(
  root: string,
  data: { map?: StoryMap; index?: VaultIndex } = {},
): CreateSignalInput[] {
  const map = data.map ?? storyMap(root);
  const index = data.index ?? rebuildIndex(root);
  const assets = readStructureFms(root);
  const hits: CreateSignalInput[] = [];

  const threads = assets.filter((a) => a.kind === "thread");
  const arcs = assets.filter((a) => a.kind === "arc");
  const foreshadowing = assets.filter((a) => a.kind === "foreshadowing");
  const reveals = assets.filter((a) => a.kind === "reveal");

  // 存在性口径(悬空判定)用全量 slug(含 deprecated——与 radar-risk known 集同源, 评审 P1-2:
  // 资产被替换/退役为 deprecated 后残留引用不是悬空); 条件评估(各检测器遍历)保持 R20
  // 列表读口径(readStructureFms 已排除 deprecated)。
  const foreshadowingSlugs = new Set(index.structure.filter((e) => e.kind === "foreshadowing").map((e) => e.slug));
  const threadSlugsAll = new Set(index.structure.filter((e) => e.kind === "thread").map((e) => e.slug));
  const arcSlugsAll = new Set(index.structure.filter((e) => e.kind === "arc").map((e) => e.slug));
  const objectSlugs = new Set(index.objects.map((o) => o.slug));
  const sceneSlugs = new Set(map.scenes.map((s) => s.slug));

  // 1+6. 伏笔面: 兑现 Scene 悬空; reveal 提前于埋设(reveals_foreshadowing 边配对)。
  const plantChapterBySlug = new Map<string, number>();
  for (const f of foreshadowing) {
    const name = str(f.fm.name) ?? f.slug;
    const payoffScene = str(f.fm.planned_payoff_scene);
    if (payoffScene !== undefined && !sceneSlugs.has(payoffScene)) {
      hits.push({
        id: `risk-payoff-scene-dangling-${f.slug}`,
        logical_key: signalLogicalKey("risk", "payoff_scene_dangling", f.slug),
        radar: "risk",
        severity: "risk",
        title: `『${name}』计划回收的 Scene 不存在`,
        evidence: [`回收 Scene 引用「${payoffScene}」在本书中找不到`],
        proposed_action: "修正回收 Scene 引用或先建该 Scene",
        reversibility: true,
      });
    }
    const seed = num(f.fm.planned_seed_chapter);
    if (seed !== undefined) plantChapterBySlug.set(f.slug, seed);
  }
  for (const e of map.edges) {
    if (e.type !== "reveals_foreshadowing") continue;
    const reveal = reveals.find((r) => r.slug === e.source);
    const plant = plantChapterBySlug.get(e.target);
    if (reveal === undefined || plant === undefined) continue;
    const minStage = revealMinStageChapter(reveal.fm);
    if (minStage === undefined || minStage >= plant) continue;
    const name = str(reveal.fm.title) ?? reveal.slug;
    hits.push({
      // id 携 (reveal × 伏笔) 双方: 同一 reveal 多条 reveals_foreshadowing 边各自成信号,
      // 只用 reveal.slug 会撞 id 使整轮对账抛错(评审 P1-1)。catalog 契约按前缀匹配不受影响。
      id: `risk-reveal-before-plant-${reveal.slug}-${e.target}`,
      logical_key: signalLogicalKey("risk", "reveal_before_plant", reveal.slug, e.target),
      radar: "risk",
      severity: "risk",
      title: `『${name}』比伏笔埋设更早揭示`,
      evidence: [`最早揭示在第 ${minStage} 章, 但伏笔第 ${plant} 章才埋下`],
      proposed_action: "调整揭示阶段章节或提前埋设",
      reversibility: true,
    });
  }

  // 2. 线程章跨非法: <1 或倒置。end 指向未来规划章不报(评审 P1-3: 与 foreshadow_overdue
  //    「计划点未到不超期」同 vault 口径——进行中的书规划章大于已写最大章是常态, 报了就是
  //    大面积持续误报; 越界判定若未来要收紧须先裁定全书规划上限的真相源)。
  for (const t of threads) {
    const start = num(t.fm.start_chapter);
    const end = num(t.fm.end_chapter);
    const problems: string[] = [];
    if (start !== undefined && start < 1) problems.push("起始章 <1");
    if (end !== undefined && end < 1) problems.push("结束章 <1");
    if (start !== undefined && end !== undefined && start > end) problems.push(`起始章(${start})晚于结束章(${end})`);
    if (problems.length === 0) continue;
    const name = str(t.fm.title) ?? str(t.fm.name) ?? t.slug;
    hits.push({
      id: `risk-thread-range-invalid-${t.slug}`,
      logical_key: signalLogicalKey("risk", "thread_range_invalid", t.slug),
      radar: "risk",
      severity: "risk",
      title: `『${name}』的章节范围不成立`,
      evidence: problems,
      proposed_action: "修正章节范围",
      reversibility: true,
    });
  }

  // 3. 篇章纲章跨不含关联线程章跨。arc 章跨双认(评审 P1-4): chapter_range 数组是
  //    生成管线(llm-step specs/消费侧 story-map/dossier)的事实标准, spec 字段表登记的
  //    start_chapter/end_chapter 也认(dossier.ts 同款双认)。
  const threadSpan = new Map<string, { start?: number; end?: number }>();
  for (const t of threads) {
    threadSpan.set(t.slug, { start: num(t.fm.start_chapter), end: num(t.fm.end_chapter) });
  }
  for (const arc of arcs) {
    const range = numArr(arc.fm.chapter_range);
    const start = num(arc.fm.start_chapter);
    const end = num(arc.fm.end_chapter);
    const bounds = range.length > 0 ? range : [start, end].filter((x): x is number => x !== undefined);
    if (bounds.length === 0) continue;
    const lo = Math.min(...bounds);
    const hi = Math.max(...bounds);
    const arcName = str(arc.fm.title) ?? arc.slug;
    for (const threadSlug of strArr(arc.fm.related_thread_ids)) {
      const span = threadSpan.get(threadSlug);
      if (span === undefined) continue; // 线程不存在 → 5 号/7 号悬空面负责
      if (span.start === undefined || span.end === undefined) continue;
      if (span.start < lo || span.end > hi) {
        hits.push({
          id: `risk-arc-thread-range-mismatch-${arc.slug}-${threadSlug}`,
          logical_key: signalLogicalKey("risk", "arc_thread_range_mismatch", arc.slug, threadSlug),
          radar: "risk",
          severity: "risk",
          title: `『${arcName}』的章跨没有覆盖『${threadSlug}』`,
          evidence: [`篇章纲覆盖第 ${lo}–${hi} 章, 线程占第 ${span.start}–${span.end} 章`],
          proposed_action: "对齐篇章纲与线程的章节范围",
          reversibility: true,
        });
      }
    }
  }

  // 4. 孤儿线程: 无任何 serves_thread 边挂靠(note 级提醒; 与 structure_unassigned 判别)。
  const servedThreadSlugs = new Set(map.edges.filter((e) => e.type === "serves_thread").map((e) => e.target));
  for (const t of threads) {
    if (servedThreadSlugs.has(t.slug)) continue;
    const name = str(t.fm.title) ?? str(t.fm.name) ?? t.slug;
    hits.push({
      id: `risk-thread-orphan-${t.slug}`,
      logical_key: signalLogicalKey("risk", "thread_orphan", t.slug),
      radar: "risk",
      severity: "note",
      title: `『${name}』还没有任何场景或结构挂靠`,
      evidence: ["没有任何 Scene/篇章纲/伏笔通过 serves_thread 关联到这条线"],
      proposed_action: "为场景或结构关联这条剧情线, 或废弃不用",
      reversibility: true,
    });
  }

  // 5. reveal 目标悬空: target_type=foreshadowing 查伏笔, 其余查对象(spec 的 target_type
  //    是自由字符串, 实体类(world_entity/character 等)统一落对象集——出现结构类值时按
  //    对象误判的可能性记为已知边界, 评审 P2-6 注记)。
  for (const r of reveals) {
    const targetType = str(r.fm.target_type);
    const targetId = str(r.fm.target_id);
    if (targetType === undefined || targetId === undefined) continue;
    const exists = targetType === "foreshadowing" ? foreshadowingSlugs.has(targetId) : objectSlugs.has(targetId);
    if (exists) continue;
    const name = str(r.fm.title) ?? r.slug;
    hits.push({
      id: `risk-reveal-target-dangling-${r.slug}`,
      logical_key: signalLogicalKey("risk", "reveal_target_dangling", r.slug),
      radar: "risk",
      severity: "risk",
      title: `『${name}』的揭示目标不存在`,
      evidence: [`target_id「${targetId}」(${targetType})在本书中找不到`],
      proposed_action: "修正揭示目标引用",
      reversibility: true,
    });
  }

  // 7. 悬空边(storyMap edges 全集减去显式 relations 子集: 显式边悬空由 radar-risk
  //    既有 `risk-dangling-` 负责——同问题不双报, 批判别纪律; N17 related_*_ids 投影
  //    绕过写链校验是本检测器的主要来源。pays_off_in_scene 归 6 号归属; references_memory
  //    无文件落点不可解析。已知边界(评审 P2-1): 字段与显式 pays_off_in_scene 边同目标
  //    并存同悬空时 6 号与 risk-dangling- 各报一条, 修一次双向自动结算, 噪声级不强行
  //    去重(去重须改 radar-risk 既有面, 违加法纪律)。排除键分隔符用 NUL(文件名禁 NUL,
  //    绝对不可碰撞——story-map.ts 同款, 评审 P2-4)。)
  const explicitEdgeKeys = new Set(
    index.relations.map((e) => `${e.source}\u0000${e.target}\u0000${e.type}\u0000${e.status}\u0000${e.sourceKind}`),
  );
  for (const e of map.edges) {
    if (explicitEdgeKeys.has(`${e.source}\u0000${e.target}\u0000${e.type}\u0000${e.status}\u0000${e.sourceKind}`)) continue;
    let exists: boolean;
    switch (e.type) {
      case "serves_thread": exists = threadSlugsAll.has(e.target); break;
      case "belongs_to_arc": exists = arcSlugsAll.has(e.target); break;
      case "reveals_foreshadowing": exists = foreshadowingSlugs.has(e.target); break;
      case "pays_off_in_scene": continue; // 归 payoff_scene_dangling 归属
      case "references_character":
      case "references_entity": exists = objectSlugs.has(e.target); break;
      case "references_memory": continue; // 事件 id 无文件落点
      default: continue; // 未知 type 不归本检测器
    }
    if (exists) continue;
    const logicalKey = signalLogicalKey("risk", "legacy_edge_dangling", e.source, e.target, e.type);
    hits.push({
      id: signalIdFromKey("risk-legacy-edge-dangling-", logicalKey),
      logical_key: logicalKey,
      radar: "risk",
      severity: "risk",
      title: `关系边指向不存在的目标`,
      evidence: [`「${e.source}」的 ${e.type} 边指向「${e.target}」, 该目标不存在(N17 兼容投影绕过写链校验的典型来源)`],
      proposed_action: "修正引用或删除这条关系",
      reversibility: true,
    });
  }

  return hits;
}

/** risk 面全扫(radar-risk 命中 + 连续性命中合并后一次对账, N54: 同前缀不得分开对账)。
 * 单快照(评审 P2-5): 一次 rebuildIndexSnapshot 同时供 map 与 index, 与 collectGroup
 * 原子路径口径一致, 消除双扫与快照间 TOCTOU。 */
export function scanRiskContinuityRadar(root: string, now?: Date): RadarReconcileResult {
  const snapshot = rebuildIndexSnapshot(root);
  const map = storyMapFromSnapshot(root, snapshot);
  const hits = [
    ...collectRiskRadarHits(root, { map, index: snapshot.index }),
    ...collectContinuityRadarHits(root, { map, index: snapshot.index }),
  ];
  return reconcileRadarSignals(root, "risk-", hits, now);
}
