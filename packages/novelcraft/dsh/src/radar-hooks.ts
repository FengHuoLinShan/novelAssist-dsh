// @novelcraft/dsh · 雷达事件触发(设计 §11: 事件驱动, 非定时刷屏; D6 低频巡检默认关)。
// 工具事件 → 确定性雷达对账 → pushSignalsChanged(ADR-0018 推送通道)。
// 钩子为尽力而为的副作用: 任何扫描异常不外抛, 不破坏主工具调用链。
import type { Context } from '@deepseek-ai/cordis';
import * as assistant from '@novelcraft/assistant';
import { pushSignalsChanged } from './push.js';

/** 事件→雷达映射(§11 唤醒条件 2: 事件触发)。 */
export const EVENT_RADAR_MAP = {
  /** 文本入库后: 摄入对账(新章覆盖) + 写作健康(新章 Scene 检查) */
  ingest: ['ingest', 'writing'],
  /** 深度导入后: 去重/风险/剧情/写作四面 */
  deepImport: ['dedup', 'risk', 'plot', 'writing'],
  /** adopt 后: 去重 + 风险(章候选采用另加写作面, 见 tools.ts) */
  adopt: ['dedup', 'risk'],
  /** 章候选采用: 写作面(正文变化) */
  adoptChapterCandidate: ['writing'],
  /** 正文候选生成后: 写作面 */
  generate: ['writing'],
} as const satisfies Record<string, readonly assistant.RadarKind[]>;

/** 跑一组雷达并推送信号变化; 扫描异常吞掉(返回 undefined), 推送仍尝试。 */
export function fireRadarHooks(
  ctx: Context,
  root: string,
  radars: readonly assistant.RadarKind[],
): assistant.SweepResult | undefined {
  let result: assistant.SweepResult | undefined;
  try {
    result = assistant.runRadarSweep(root, { radars: [...radars] });
  } catch {
    // 雷达是后台监看(§7), 失败不进主调用链; 作者可经 novelcraft_radar_sweep 手动重扫。
    result = undefined;
  }
  try {
    pushSignalsChanged(ctx, { root, radars });
  } catch {
    // 推送通道缺省(无 client/push 补丁)时静默。
  }
  return result;
}
