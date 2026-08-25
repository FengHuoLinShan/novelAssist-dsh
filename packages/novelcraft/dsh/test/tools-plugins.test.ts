// 工具组开关与独立插件契约(包内插件族, §22.3 service/consumer 模式):
//   ① config.tools 开关: mapAtlas=false → 15 个写作/存储工具; writing=false → 6 个地图册工具;
//      缺省 → 21 个(与既有全量断言一致)。
//   ② 独立插件: NovelcraftMapAtlasPlugin 经 inject novelcraft 单独挂载 → 只注册 6 个。
//      服务缺失的两条路径都 fail-closed: inject 语义 = 等待不启动(零注册、不炸宿主);
//      构造器直调(服务未就位)= resolveService 抛错, 不静默。
//   ③ 单独挂载与默认路径共享 build 函数: 注册的工具名集合与按开关过滤的默认路径逐名一致。
//   ④ 单独挂载的插件经 fork.dispose() 卸载 → 逐工具注销, 默认路径注册不受影响。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { NovelCraftService } from '../src/index.js';
import {
  NovelcraftMapAtlasPlugin,
  NovelcraftWritingToolsPlugin,
} from '../src/internal.js';
import { makeContext, type HarnessServices } from './helpers.js';

interface Env {
  h: HarnessServices;
  vaultsDir: string;
  tools: ToolDefinition[];
}

const envs: Env[] = [];
async function setup(configExtra: Record<string, unknown> = {}): Promise<Env> {
  const h = await makeContext();
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-plugins-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', {
    register(def: ToolDefinition) {
      tools.push(def);
      // 真实注销(dispose 用例依赖): disposer 把定义从列表移除。
      return () => {
        const i = tools.indexOf(def);
        if (i >= 0) tools.splice(i, 1);
      };
    },
  });
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
    ...configExtra,
  });
  const env: Env = { h, vaultsDir, tools };
  envs.push(env);
  return env;
}

afterEach(() => {
  for (const e of envs.splice(0)) {
    rmSync(e.vaultsDir, { recursive: true, force: true });
  }
});

describe('config.tools 工具组开关(profile 即产品)', () => {
  it('缺省 → 21 个(15 写作/存储 + 6 地图册)', async () => {
    const env = await setup();
    expect(env.tools.length).toBe(21);
    expect(env.tools.filter((t) => t.name.startsWith('novelcraft_map_atlas_')).length).toBe(6);
  });

  it('mapAtlas=false → 只注册 15 个写作/存储工具(零 map_atlas 面)', async () => {
    const env = await setup({ tools: { mapAtlas: false } });
    expect(env.tools.length).toBe(15);
    expect(env.tools.every((t) => !t.name.startsWith('novelcraft_map_atlas_'))).toBe(true);
  });

  it('writing=false → 只注册 6 个地图册工具', async () => {
    const env = await setup({ tools: { writing: false } });
    expect(env.tools.length).toBe(6);
    expect(env.tools.every((t) => t.name.startsWith('novelcraft_map_atlas_'))).toBe(true);
  });
});

describe('工具组独立插件(inject novelcraft; 组合式 profile)', () => {
  it('NovelcraftMapAtlasPlugin 单独挂载 → 只注册 6 个地图册工具(与默认路径逐名一致)', async () => {
    const base = await setup();
    const env = await setup({ tools: { mapAtlas: false } });
    expect(env.tools.length).toBe(15);
    await env.h.ctx.plugin(NovelcraftMapAtlasPlugin);
    expect(env.tools.length).toBe(21);
    expect(env.tools.slice(15).every((t) => t.name.startsWith('novelcraft_map_atlas_'))).toBe(true);
    const atlasNames = (list: ToolDefinition[]) =>
      list.map((t) => t.name).filter((n) => n.startsWith('novelcraft_map_atlas_')).sort();
    expect(atlasNames(env.tools)).toEqual(atlasNames(base.tools));
  });

  it('NovelcraftWritingToolsPlugin 单独挂载 → 15 个写作/存储工具(与默认路径逐名一致)', async () => {
    const base = await setup();
    const env = await setup({ tools: { writing: false } });
    await env.h.ctx.plugin(NovelcraftWritingToolsPlugin);
    const writingNames = (list: ToolDefinition[]) =>
      list.map((t) => t.name).filter((n) => !n.startsWith('novelcraft_map_atlas_')).sort();
    expect(writingNames(env.tools)).toEqual(writingNames(base.tools));
  });

  it('服务缺失 → 插件等待不启动(inject 语义: 零注册、不炸宿主)', async () => {
    const h = await makeContext();
    const tools: ToolDefinition[] = [];
    h.ctx.provide('tools', {
      register(def: ToolDefinition) {
        tools.push(def);
        return () => {};
      },
    });
    await h.ctx.plugin(NovelcraftMapAtlasPlugin);
    expect(tools.length).toBe(0);
  });

  it('服务未就位时构造器直调 → resolveService 抛错(fail-closed, 不静默)', () => {
    const ctx = new Context();
    expect(() => new NovelcraftMapAtlasPlugin(ctx)).toThrow(/novelcraft 服务不可用/);
    expect(() => new NovelcraftWritingToolsPlugin(ctx)).toThrow(/novelcraft 服务不可用/);
  });

  it('MapAtlas 插件 dispose → 6 个地图册工具逐个注销, 默认路径 15 个保留', async () => {
    const env = await setup({ tools: { mapAtlas: false } });
    expect(env.tools.length).toBe(15);
    const fork = await env.h.ctx.plugin(NovelcraftMapAtlasPlugin);
    expect(env.tools.length).toBe(21);
    await fork.dispose();
    expect(env.tools.length).toBe(15);
    expect(env.tools.every((t) => !t.name.startsWith('novelcraft_map_atlas_'))).toBe(true);
  });

  it('Writing 插件 dispose → 15 个写作/存储工具全部注销, 默认路径 6 个保留', async () => {
    const env = await setup({ tools: { writing: false } });
    const fork = await env.h.ctx.plugin(NovelcraftWritingToolsPlugin);
    expect(env.tools.length).toBe(21);
    await fork.dispose();
    expect(env.tools.length).toBe(6);
    expect(env.tools.every((t) => t.name.startsWith('novelcraft_map_atlas_'))).toBe(true);
  });
});
