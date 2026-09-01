// @novelcraft/dsh · 工具组独立插件(包内插件族, §22.3 service/consumer 模式)。
// 六个工具组各自是真实 Cordis 插件类，供包内程序化组合；公开 profile 仍只挂
// @novelcraft/dsh，并通过 Config.tools 开关选择工具组。
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { svc } from '../ctx.js';
import type { NovelCraftService } from '../service.js';
import { buildBookTools } from './book.js';
import { buildWritingCoreTools } from '../tools.js';
import { buildMapAtlasTools } from './map-atlas.js';
import { buildOutlineTools } from './outline.js';
import { buildWorkflowTools } from './workflow.js';
import { buildWorldTools } from './world.js';

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

/** 写作/存储基础工具组(15 个)。 */
export class NovelcraftWritingToolsPlugin {
  static name = 'novelcraft-writing-tools';
  static inject = ['novelcraft', 'tools'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildWritingCoreTools(ctx, service));
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
  static inject = ['novelcraft', 'tools'] as const;

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

/** 长任务恢复工具组(4 个: novelcraft_workflow_ 前缀, M10-B1/N40)。 */
export class NovelcraftWorkflowToolsPlugin {
  static name = 'novelcraft-workflow-tools';
  static inject = ['novelcraft', 'tools'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildWorkflowTools(ctx, service));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}

/** 书库生命周期工具组(3 个: novelcraft_book_ 前缀, M11/N42)。 */
export class NovelcraftBookToolsPlugin {
  static name = 'novelcraft-book-tools';
  static inject = ['novelcraft', 'tools'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildBookTools(ctx, service));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}

/** 世界对象与生成中心工具组(7 个, M12/N48)。 */
export class NovelcraftWorldToolsPlugin {
  static name = 'novelcraft-world-tools';
  static inject = ['novelcraft', 'tools'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildWorldTools(ctx, service));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}

/** 总纲与结构 preview/apply 工具组(4 个, M12/N48)。 */
export class NovelcraftOutlineToolsPlugin {
  static name = 'novelcraft-outline-tools';
  static inject = ['novelcraft', 'tools'] as const;

  constructor(ctx: Context) {
    const service = resolveService(ctx);
    const disposers = registerToolList(ctx, buildOutlineTools(ctx, service));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载尽力而为 */ }
      }
    });
  }
}
