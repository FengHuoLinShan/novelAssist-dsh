import { readFileSync } from 'node:fs';
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
