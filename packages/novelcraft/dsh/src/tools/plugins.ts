// @novelcraft/dsh · 工具组独立插件(包内插件族, §22.3 service/consumer 模式)。
// 两个工具组各自是真实 cordis 插件类(inject novelcraft, 经 svc 取服务), 供
// 组合式 profile 单独挂载/卸载; 默认组合仍走 registerNovelcraftTools 同步路径
// (fail-closed; rc.8 cordis 嵌套 ctx.plugin 会吞子插件构造器抛错, 故不在此用)。
// 与默认路径共享同一组 build 函数 —— 单独挂载与本包内注册零逻辑分叉。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { svc } from '../ctx.js';
import type { NovelCraftService } from '../service.js';
import { buildTools, isMapAtlasTool } from '../tools.js';
import { buildMapAtlasTools } from './map-atlas.js';

/** 带逆序回滚的批量注册(与 registerNovelcraftTools 同语义, 供插件构造器复用)。 */
export function registerToolList(
  ctx: Context,
  definitions: readonly ToolDefinition[],
): Array<() => void> {
  const registry = svc<{ register(definition: ToolDefinition): () => void }>(ctx, 'tools');
  if (!registry || typeof registry.register !== 'function') return [];
  const disposers: Array<() => void> = [];
  try {
    for (const tool of definitions) disposers.push(registry.register(tool));
    return disposers;
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* preserve the registration failure */ }
    }
    throw error;
  }
}

function resolveService(ctx: Context): NovelCraftService {
  const service = svc<NovelCraftService>(ctx, 'novelcraft');
  if (!service) throw new Error('novelcraft 服务不可用(工具组插件需先挂载 @novelcraft/dsh)');
  return service;
}

/** 写作/存储工具组(15 个: novelcraft_ 前缀非 map_atlas 面)。 */
export class NovelcraftWritingToolsPlugin {
  static name = 'novelcraft-writing-tools';
  static inject = ['novelcraft'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const definitions = buildTools(ctx, service).filter((tool) => !isMapAtlasTool(tool.name));
    const disposers = registerToolList(ctx, definitions);
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}

/** 地图册工具组(6 个: novelcraft_map_atlas_ 前缀)。 */
export class NovelcraftMapAtlasPlugin {
  static name = 'novelcraft-map-atlas';
  static inject = ['novelcraft'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildMapAtlasTools(ctx, service));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}
