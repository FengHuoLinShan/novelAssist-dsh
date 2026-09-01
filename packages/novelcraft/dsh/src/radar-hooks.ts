// @novelcraft/dsh · 雷达事件触发(设计 §11: 事件驱动, 非定时刷屏; D6 低频巡检默认关)。
// 工具事件 → 确定性雷达对账。
// 钩子为尽力而为的副作用: 任何扫描异常不外抛, 不破坏主工具调用链。
// N34: root 必须是已验证的绑定 vault 根(工具层 resolveBoundRoot 产出); 钩子内再做
// 一次只读 validateInitializedVault 兜底, 非已初始化 vault 直接跳过(绝不扫任意目录)。
import type { Context } from '@deepseek-ai/cordis';
import * as assistant from '@novelcraft/assistant';
import { validateInitializedVault } from '@novelcraft/vault';
import { fireRagHook } from './rag-hooks.js';

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

/** 变更事件键(EVENT_RADAR_MAP 的键)。 */
export type MutationEvent = keyof typeof EVENT_RADAR_MAP;

/** 变更后副作用声明: 传 radars 即雷达对账; rag 同步词法索引。 */
export interface AfterMutationOptions {
  /** 触发哪些变更事件的雷达面(事件键展开为 EVENT_RADAR_MAP 的雷达列表)。 */
  radars?: readonly MutationEvent[];
  /** 同步 RAG 词法派生索引(向量写入仍由显式 novelcraft_rag_embed 独占)。 */
  rag?: boolean;
}

/**
 * 变更后副作用唯一入口(§11 事件驱动): 收敛「雷达对账 + RAG 索引同步」
 * 扇出, 变更类工具不得再各自手调 fireRadarHooks/fireRagHook
 * (漏调一处 = 信号/索引静默过期)。顺序与既有工具一致: 先雷达后 RAG。
 * 全部尽力而为: 任何异常不外抛, 不破坏主工具调用链(同 fireRadarHooks 纪律)。
 */
export async function afterMutation(ctx: Context, root: string | undefined, opts: AfterMutationOptions): Promise<void> {
  if (root === undefined) return; // bindRoot='none' 工具(M11/N42 book 组)无变更副作用入口。
  if (opts.radars !== undefined && opts.radars.length > 0) {
    await fireRadarHooks(ctx, root, opts.radars.flatMap((event) => [...EVENT_RADAR_MAP[event]]));
  }
  if (opts.rag === true) {
    fireRagHook(ctx, root);
  }
}

/** 跑一组雷达。非已初始化 vault 提前返回(fail-closed: 零扫描);
 *  扫描异常时返回 undefined。 */
export async function fireRadarHooks(
  ctx: Context,
  root: string,
  radars: readonly assistant.RadarKind[],
): Promise<assistant.SweepResult | undefined> {
  void ctx; // 保留公开 seam 签名；删除自定义 push 后扫描本身无 ctx 依赖(N50)。
  // N34: root 必须通过只读 validateInitializedVault(工具层已传入绑定 root; 此处
  // 兜底防任意目录误入)——伪 vault/无 git/无 HEAD 一律不跑雷达(fail-closed)。
  if (!validateInitializedVault(root).ok) return undefined;
  let result: assistant.SweepResult | undefined;
  try {
    result = await assistant.runRadarSweepAtomic(root, { radars: [...radars] });
  } catch {
    // 雷达是后台监看(§7), 失败不进主调用链; 作者可经 novelcraft_radar_sweep 手动重扫。
    result = undefined;
  }
  return result;
}
