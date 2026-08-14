// assistant · 五面雷达巡检(runRadarSweep, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 六雷达(摄入/去重/建议/剧情/风险/写作)、§11 低频深度巡检(默认关, policy 可开)。
// 默认跑 ingest/dedup/suggest/risk/writing 五面; plot 只出摘要(剧情面 = 摘要数据源)。
import { scanHealthSignals } from "./health.js";
import { scanIngestRadar } from "./radar-ingest.js";
import { scanDedupRadar } from "./radar-dedup.js";
import { scanSuggestRadar } from "./radar-suggest.js";
import { plotSummaryLine, scanPlotRadar } from "./radar-plot.js";
import { scanRiskRadar } from "./radar-risk.js";
import type { RadarKind } from "./signals.js";
import type { RadarReconcileResult } from "./radar-utils.js";

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
