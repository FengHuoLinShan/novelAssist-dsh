import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const skillsRoot = path.join(root, 'skills');
const presetsRoot = path.join(root, 'presets');
const activePresets = ['novelcraft-author', 'novelcraft-import-review', 'novelcraft-worldbuilder'];

describe('NovelCraft DSH 原生 Skill profile', () => {
  it('通过 rc.8 filesystem provider 枚举并加载 9 册 Skill', async () => {
    const ctx = new Context();
    const registry = await ctx.plugin(SkillRegistry);
    const provider = await ctx.plugin(SkillFileSystem, {
      providerName: 'novelcraft',
      includeDefaultRoots: false,
      customSkillDirs: [skillsRoot],
      watch: false,
    });

    const skills = await ctx.skills.list();
    expect(skills.map((skill) => skill.name)).toEqual([
      'novelcraft-core',
      'novelcraft-imports',
      'novelcraft-interaction',
      'novelcraft-map',
      'novelcraft-ops',
      'novelcraft-outline',
      'novelcraft-rag-context',
      'novelcraft-world',
      'novelcraft-writing',
    ]);
    for (const skill of skills) {
      const loaded = await ctx.skills.get(skill.name);
      expect(loaded?.content.length).toBeGreaterThan(20);
      expect(loaded?.invocation.modelInvocable).toBe(true);
    }

    await provider.dispose();
    await registry.dispose();
  });

  it('作者侧 preset 只挂领域工具与原生 Skill，不暴露 Shell/裸文件系统', () => {
    for (const preset of activePresets) {
      const text = readFileSync(path.join(presetsRoot, preset, 'agent.cordis.yml'), 'utf8');
      expect(text).toContain('@deepseek-ai/dsh-skill-filesystem');
      expect(text).toContain('@deepseek-ai/dsh-tool-skill');
      expect(text).toContain("new URL('../../skills/', baseUrl)");
      expect(text).not.toMatch(/dsh-(?:tool-bash|terminal|fs-)/);
    }

    const companion = readFileSync(path.join(presetsRoot, 'novelcraft-companion', 'agent.cordis.yml'), 'utf8');
    expect(companion).toContain('延后至 R6');
    expect(companion).not.toMatch(/dsh-(?:tool-bash|terminal|fs-|tool-skill|skill-filesystem)/);
  });
});

// ---------------------------------------------------------------------------
// 工具名漂移校验: skill/preset 的 prose 会引用 agent 工具名; 工具面演进
// (如 19→21)时这些引用容易腐烂。preset 不依赖 @novelcraft/dsh(发布层零
// DSH 运行时依赖), 故以内联清单比对; 清单与 dsh/src/tools.ts(21 工具,
// 含 tools/writing.ts 与 tools/map-atlas.ts)同步, 由 dsh 侧 21 工具
// 数量/名字断言间接约束不腐烂。
// ---------------------------------------------------------------------------
const TOOL_NAMES = [
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
] as const;

const skillDirs = (): string[] =>
  readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe('Skill/preset 工具名漂移校验', () => {
  it('内联 21 工具名清单自身完整(21 个无重复, 地图册组 6 个)', () => {
    expect(TOOL_NAMES.length).toBe(21);
    expect(new Set(TOOL_NAMES).size).toBe(21);
    expect(TOOL_NAMES.filter((n) => n.startsWith('novelcraft_map_atlas_')).length).toBe(6);
  });

  it('每册 SKILL.md frontmatter: name 与目录一致, description/whenToUse 非空', () => {
    for (const dir of skillDirs()) {
      const text = readFileSync(path.join(skillsRoot, dir, 'SKILL.md'), 'utf8');
      const front = text.split(/^---\s*$/m)[1] ?? '';
      const field = (key: string): string =>
        front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
      expect(field('name'), dir).toBe(dir);
      expect(field('description').length, dir).toBeGreaterThan(0);
      expect(field('whenToUse').length, dir).toBeGreaterThan(0);
    }
  });

  it('skill 与 preset 引用的 novelcraft_* 工具名都在 21 工具面内(无退役/拼写漂移)', () => {
    const sources: Array<{ label: string; text: string }> = skillDirs().map((dir) => ({
      label: `skills/${dir}/SKILL.md`,
      text: readFileSync(path.join(skillsRoot, dir, 'SKILL.md'), 'utf8'),
    }));
    for (const dir of readdirSync(presetsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      sources.push({
        label: `presets/${dir.name}/agent.cordis.yml`,
        text: readFileSync(path.join(presetsRoot, dir.name, 'agent.cordis.yml'), 'utf8'),
      });
    }
    for (const { label, text } of sources) {
      const tokens = new Set(text.match(/novelcraft_[a-z0-9_]+/g) ?? []);
      for (const token of tokens) {
        // 全名命中, 或以 `_` 结尾的通配前缀引用(如 prose 里的 novelcraft_map_atlas_*)。
        const ok = (TOOL_NAMES as readonly string[]).includes(token)
          || (token.endsWith('_') && (TOOL_NAMES as readonly string[]).some((n) => n.startsWith(token)));
        expect(ok, `${label}: ${token}`).toBe(true);
      }
    }
  });
});
