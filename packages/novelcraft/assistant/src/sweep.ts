// assistant · 五面雷达巡检(runRadarSweep, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 六雷达(摄入/去重/建议/剧情/风险/写作)、§11 低频深度巡检(默认关, policy 可开)。
// 默认跑 ingest/dedup/suggest/risk/writing 五面; plot 只出摘要(剧情面 = 摘要数据源)。
import { rebuildIndexSnapshot, storyMapFromSnapshot, type StoryMap, type VaultIndexSnapshot } from "@novelcraft/store";
import { collectHealthRadarHits, scanHealthSignals } from "./health.js";
import { collectIngestRadarHits, scanIngestRadar } from "./radar-ingest.js";
import { collectDedupRadarHits, scanDedupRadar } from "./radar-dedup.js";
import { collectSuggestRadarHits, scanSuggestRadar } from "./radar-suggest.js";
import { plotSummaryFromStoryMap, plotSummaryLine, scanPlotRadar } from "./radar-plot.js";
import { collectRiskRadarHits, scanRiskRadar } from "./radar-risk.js";
import type { RadarKind } from "./signals.js";
import { reconcileRadarSignalGroupsAtomic, type RadarReconcileResult, type RadarSignalGroup } from "./radar-utils.js";

export interface SweepResult {
  /** 每面雷达对账计数; 键 = radar 名(plot 仅在显式请求时入键)。 */
  results: Partial<Record<RadarKind, RadarReconcileResult>>;
  /** 剧情摘要(总是计算, §7/§11 一句话作者语言)。 */
  plotSummary: string;
}

/** 全量/单面巡检: 默认五面(ingest/dedup/suggest/risk/writing), plot 只出摘要。 */
export function runRadarSweep(
  root: string,
  opts: { radars?: RadarKind[]; now?: Date } = {},
): SweepResult {
  const kinds: RadarKind[] = opts.radars ?? ["ingest", "dedup", "suggest", "risk", "writing"];
  const results: Partial<Record<RadarKind, RadarReconcileResult>> = {};
  for (const kind of kinds) {
    switch (kind) {
      case "ingest":
        results.ingest = scanIngestRadar(root, opts.now);
        break;
      case "dedup":
        results.dedup = scanDedupRadar(root, opts.now);
        break;
      case "suggest":
        results.suggest = scanSuggestRadar(root, opts.now);
        break;
      case "plot":
        results.plot = scanPlotRadar(root, opts.now);
        break;
      case "risk":
        results.risk = scanRiskRadar(root, opts.now);
        break;
      case "writing":
        results.writing = scanHealthSignals(root, opts.now);
        break;
    }
  }
  return { results, plotSummary: plotSummaryLine(root) };
}

interface SweepSnapshot {
  vault: VaultIndexSnapshot;
  map?: StoryMap;
  objects: Array<{ slug: string; name: string; entity_type: string; status: string; aliases: string[]; evidence: string[] }>;
  pending: Array<{ slug: string; name: string; entity_type: string; status: string; aliases: string[]; evidence: string[] }>;
}

function takeSweepSnapshot(root: string, includeMap: boolean): SweepSnapshot {
  const vault = rebuildIndexSnapshot(root);
  const map = includeMap ? storyMapFromSnapshot(root, vault) : undefined;
  const project = (filePrefix: string) => vault.index.objects
    .filter((object) => object.file.startsWith(filePrefix))
    .map((object) => {
      const fm = vault.frontmatterByFile.get(object.file) ?? {};
      return {
        slug: object.slug,
        name: object.name,
        entity_type: object.kind,
        status: object.status,
        aliases: object.aliases,
        evidence: Array.isArray(fm.evidence) ? fm.evidence.map(String) : [],
      };
    });
  return { vault, ...(map ? { map } : {}), objects: project("world/objects/"), pending: project("world/pending/") };
}

function collectGroup(root: string, kind: RadarKind, snapshot?: SweepSnapshot): RadarSignalGroup {
  switch (kind) {
    case "ingest": return { idPrefix: "ingest-", hits: collectIngestRadarHits(root, snapshot?.vault.index) };
    case "dedup": return { idPrefix: "dedup-", hits: collectDedupRadarHits(root, snapshot && { objects: snapshot.objects, pending: snapshot.pending }) };
    case "suggest": return { idPrefix: "suggest-", hits: collectSuggestRadarHits(root, snapshot?.objects) };
    case "plot": return { idPrefix: "plot-", hits: [] };
    case "risk": return {
      idPrefix: "risk-",
      hits: snapshot?.map
        ? collectRiskRadarHits(root, { map: snapshot.map, index: snapshot.vault.index })
        : collectRiskRadarHits(root),
    };
    case "writing": return { idPrefix: "health-", hits: collectHealthRadarHits(root, snapshot?.vault) };
  }
}

/** 生产巡检：统一 scan clock，全部 Signal 变化经一次 state transaction。 */
export async function runRadarSweepAtomic(
  root: string,
  opts: { radars?: RadarKind[]; now?: Date } = {},
): Promise<SweepResult> {
  const kinds: RadarKind[] = opts.radars ?? ["ingest", "dedup", "suggest", "risk", "writing"];
  const now = opts.now ?? new Date();
  const snapshot = takeSweepSnapshot(root, true);
  const reconciled = await reconcileRadarSignalGroupsAtomic(root, kinds.map((kind) => collectGroup(root, kind, snapshot)), now);
  const results: Partial<Record<RadarKind, RadarReconcileResult>> = {};
  kinds.forEach((kind, index) => { results[kind] = reconciled.results[index]; });
  return {
    results,
    plotSummary: plotSummaryFromStoryMap(snapshot.map!, reconciled.signals.filter((signal) => signal.status === "open").length),
  };
}

/** watch 单雷达任务：非 plot 不额外生成 story-map 摘要。 */
export async function runRadarJobAtomic(root: string, radar: RadarKind, now: Date = new Date()): Promise<string> {
  const snapshot = takeSweepSnapshot(root, radar === "risk" || radar === "plot");
  const reconciled = await reconcileRadarSignalGroupsAtomic(root, [collectGroup(root, radar, snapshot)], now);
  const result = reconciled.results[0];
  return JSON.stringify(radar === "plot"
    ? { result, plotSummary: plotSummaryFromStoryMap(snapshot.map!, reconciled.signals.filter((signal) => signal.status === "open").length) }
    : { result });
}
