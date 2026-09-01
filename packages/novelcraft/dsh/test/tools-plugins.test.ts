// N48 工具组契约：六组显式归属、完整 Config、Cordis 服务生命周期与稳定全量顺序。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, DEFAULT_CONFIG, NovelCraftService } from '../src/index.js';
import { buildToolSegments } from '../src/internal.js';
import {
  NovelcraftBookToolsPlugin,
  NovelcraftMapAtlasPlugin,
  NovelcraftOutlineToolsPlugin,
  NovelcraftWorkflowToolsPlugin,
  NovelcraftWorldToolsPlugin,
  NovelcraftWritingToolsPlugin,
} from '../src/internal.js';
import { makeContext, type HarnessServices } from './helpers.js';

interface Env {
  h: HarnessServices;
  vaultsDir: string;
  tools: ToolDefinition[];
}

const EXPECTED_TOOL_NAMES = [
  'novelcraft_llm_step',
  'novelcraft_store_index',
  'novelcraft_store_adopt',
  'novelcraft_inbox_view',
  'novelcraft_inbox_act',
  'novelcraft_deep_import',
  'novelcraft_propose_next_chapter',
  'novelcraft_health_scan',
  'novelcraft_generate_next_chapter',
  'novelcraft_ingest_file',
  'novelcraft_chapter_review',
  'novelcraft_chapter_version',
  'novelcraft_radar_sweep',
  'novelcraft_rag_search',
  'novelcraft_rag_embed',
  'novelcraft_map_atlas_plan',
  'novelcraft_map_atlas_view',
  'novelcraft_map_atlas_upload',
  'novelcraft_map_atlas_review',
  'novelcraft_map_atlas_annotation',
  'novelcraft_map_atlas_update_prompt',
  'novelcraft_workflow_inspect',
  'novelcraft_workflow_resume',
  'novelcraft_workflow_start_new',
  'novelcraft_workflow_abandon',
  'novelcraft_book_list',
  'novelcraft_book_create',
  'novelcraft_book_open',
  'novelcraft_world_create',
  'novelcraft_world_update',
  'novelcraft_outline_preview',
  'novelcraft_outline_apply',
  'novelcraft_outline_item_preview',
  'novelcraft_outline_item_apply',
  'novelcraft_world_chat',
  'novelcraft_world_converge',
  'novelcraft_world_explore',
  'novelcraft_world_inspect',
  'novelcraft_world_bible_suggest',
] as const;

const envs: Env[] = [];
async function setup(configExtra: Record<string, unknown> = {}): Promise<Env> {
  const h = await makeContext();
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-plugins-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', {
    register(def: ToolDefinition) {
      tools.push(def);
      return () => {
        const index = tools.indexOf(def);
        if (index >= 0) tools.splice(index, 1);
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
  for (const env of envs.splice(0)) rmSync(env.vaultsDir, { recursive: true, force: true });
});

describe('config.tools 六组开关(profile 即产品)', () => {
  it('Schemastery 暴露六键、补齐默认值并拒绝错误类型', () => {
    expect(String(Config)).toContain(
      'tools?: { writing?: boolean, mapAtlas?: boolean, workflow?: boolean, book?: boolean, world?: boolean, outline?: boolean }',
    );
    expect(Config({}).tools).toEqual({
      writing: true, mapAtlas: true, workflow: true, book: true, world: true, outline: true,
    });
    expect(Config({}).llm).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(DEFAULT_CONFIG.llm).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(Config({ llm: { provider: 'custom', model: 'user-explicit-model' } }).llm)
      .toMatchObject({ provider: 'custom', model: 'user-explicit-model' });
    expect(Config({ llm: { provider: 'custom', model: 'm', reasoningEffort: 'vendor-max' } }).llm)
      .toMatchObject({ reasoningEffort: 'vendor-max' });
    expect(readFileSync(new URL('../../../../starter/dev-profile/cordis.patch.yml', import.meta.url), 'utf8'))
      .toContain('model: deepseek-v4-flash');
    expect(() => Config({ tools: { world: 'false' as unknown as boolean } })).toThrow();
  });

  it('缺省 39 个；关闭任一组只移除该组', async () => {
    const expectedCounts = {
      writing: 15,
      mapAtlas: 6,
      workflow: 4,
      book: 3,
      world: 7,
      outline: 4,
    } as const;
    const base = await setup();
    expect(base.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    for (const [group, count] of Object.entries(expectedCounts)) {
      const env = await setup({ tools: { [group]: false } });
      expect(env.tools).toHaveLength(39 - count);
      const disabledNames = new Set(
        buildToolSegments(env.h.ctx, env.h.ctx.novelcraft)
          .filter((segment) => segment.group === group)
          .flatMap((segment) => segment.tools.map((tool) => tool.name)),
      );
      expect(env.tools.every((tool) => !disabledNames.has(tool.name)), group).toBe(true);
    }
  });

  it('39 个工具恰属一个显式组，顺序与既有注册面一致', async () => {
    const env = await setup();
    const segments = buildToolSegments(env.h.ctx, env.h.ctx.novelcraft);
    const names = segments.flatMap((segment) => segment.tools.map((tool) => tool.name));
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(names).size).toBe(names.length);
    expect(segments.reduce<Record<string, number>>((counts, segment) => {
      counts[segment.group] = (counts[segment.group] ?? 0) + segment.tools.length;
      return counts;
    }, {})).toEqual({ writing: 15, mapAtlas: 6, workflow: 4, book: 3, world: 7, outline: 4 });
  });
});

describe('内部工具组 Cordis 插件', () => {
  const plugins = [
    NovelcraftWritingToolsPlugin,
    NovelcraftMapAtlasPlugin,
    NovelcraftWorkflowToolsPlugin,
    NovelcraftBookToolsPlugin,
    NovelcraftWorldToolsPlugin,
    NovelcraftOutlineToolsPlugin,
  ] as const;

  it('六组都硬依赖 novelcraft + tools', () => {
    for (const plugin of plugins) expect(plugin.inject).toEqual(['novelcraft', 'tools']);
  });

  it('根服务先挂、tools 后到会注册 39 个；provider 卸载时全部撤销', async () => {
    const h = await makeContext();
    const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-tools-late-'));
    const tools: ToolDefinition[] = [];
    const service = await h.ctx.plugin(NovelCraftService, {
      llm: { provider: 'fake', model: 'fake-model' },
      vaultsDir,
      watch: { enabled: false, intervalMinutes: 60 },
    });
    expect(tools).toHaveLength(0);
    const provider = await h.ctx.plugin((ctx) => {
      ctx.provide('tools', {
        register(def: ToolDefinition) {
          tools.push(def);
          return () => {
            const index = tools.indexOf(def);
            if (index >= 0) tools.splice(index, 1);
          };
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    await provider.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools).toHaveLength(0);
    await service.dispose();
    rmSync(vaultsDir, { recursive: true, force: true });
  });

  it('六个独立插件分别补回关闭的工具组，dispose 后只撤销本组', async () => {
    const cases = [
      ['writing', NovelcraftWritingToolsPlugin, 15],
      ['mapAtlas', NovelcraftMapAtlasPlugin, 6],
      ['workflow', NovelcraftWorkflowToolsPlugin, 4],
      ['book', NovelcraftBookToolsPlugin, 3],
      ['world', NovelcraftWorldToolsPlugin, 7],
      ['outline', NovelcraftOutlineToolsPlugin, 4],
    ] as const;
    for (const [group, plugin, count] of cases) {
      const env = await setup({ tools: { [group]: false } });
      expect(env.tools).toHaveLength(39 - count);
      const fork = await env.h.ctx.plugin(plugin);
      expect(env.tools).toHaveLength(39);
      await fork.dispose();
      expect(env.tools).toHaveLength(39 - count);
    }
  });

  it('缺服务保持 PENDING；构造器直调缺 novelcraft 时响亮失败', async () => {
    const h = await makeContext();
    const pending = h.ctx.plugin(NovelcraftBookToolsPlugin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.status).toBeUndefined();
    await pending.dispose();

    const ctx = new Context();
    for (const plugin of plugins) expect(() => new plugin(ctx)).toThrow(/novelcraft 服务不可用/);
  });
});
