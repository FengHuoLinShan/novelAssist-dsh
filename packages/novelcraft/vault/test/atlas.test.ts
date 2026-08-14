/**
 * @novelcraft/vault · map-atlas 路径与 gitignore 加法(N28/N29)。
 * 依据: map-atlas 实施计划 §2/§4 Phase 1/附录 A.2。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initVault, paths } from '../src/index';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-atlas-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const ATLAS_DIRS = [
  'world/atlas',
  'world/atlas/nodes',
  'world/atlas/pages',
  'world/atlas/pending',
  'world/atlas/pending/nodes',
  'world/atlas/pending/pages',
  'world/atlas/images',
  '.assistant/atlas',
  '.assistant/atlas/runs',
  '.assistant/atlas/annotation-queue',
  '.assistant/atlas/decisions',
];

describe('initVault · map-atlas 目录 + gitignore(N28/N29)', () => {
  it('创建全部 atlas 目录(map-atlas 实施计划 §2)', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });
    for (const dir of ATLAS_DIRS) {
      expect(existsSync(path.join(root, dir)), `missing dir: ${dir}`).toBe(true);
    }
  });

  it('幂等: 连调两次不报错、目录仍在', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    expect(() => initVault(root, { title: 'Book' })).not.toThrow();
    for (const dir of ATLAS_DIRS) {
      expect(existsSync(path.join(root, dir)), `missing dir: ${dir}`).toBe(true);
    }
  });

  it('N29: .gitignore 含 world/atlas/images/ 且重复 init 不产生重复行', () => {
    const root = tmpRoot();
    initVault(root, { title: 'B' });
    initVault(root, { title: 'B' });
    const lines = readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
    expect(lines.filter((l) => l === 'world/atlas/images/')).toHaveLength(1); // N29 幂等
    expect(lines.filter((l) => l === '.assistant/rag-index.json')).toHaveLength(1);
  });

  it('旧 vault(无 atlas 目录)再次 initVault 补齐目录与 gitignore 行(幂等迁移)', () => {
    const root = tmpRoot();
    // 手工造一个「旧 vault」: 只有 book.yml + .git, 无 atlas 目录。
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'book.yml'), 'title: "old"\n', 'utf8');
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(path.join(root, 'world', 'atlas'))).toBe(false);

    initVault(root, { title: 'DIFFERENT' }); // book.yml 已存在 → 只补齐, 不重写。

    for (const dir of ATLAS_DIRS) {
      expect(existsSync(path.join(root, dir)), `missing dir: ${dir}`).toBe(true);
    }
    // book.yml 不被重写(保持旧标题)。
    expect(readFileSync(path.join(root, 'book.yml'), 'utf8')).toContain('title: "old"');
    // N29: gitignore 行补齐。
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('world/atlas/images/');
  });
});

describe('paths · world.atlas / assistant.atlas 子路径(N28/N29)', () => {
  it('covers every atlas path constant and join function', () => {
    const root = tmpRoot();
    const p = paths(root);
    const j = path.join;

    expect(p.world.atlas.dir).toBe(j(root, 'world', 'atlas'));
    expect(p.world.atlas.nodes).toBe(j(root, 'world', 'atlas', 'nodes'));
    expect(p.world.atlas.pages).toBe(j(root, 'world', 'atlas', 'pages'));
    expect(p.world.atlas.pendingNodes).toBe(j(root, 'world', 'atlas', 'pending', 'nodes'));
    expect(p.world.atlas.pendingPages).toBe(j(root, 'world', 'atlas', 'pending', 'pages'));
    expect(p.world.atlas.images).toBe(j(root, 'world', 'atlas', 'images'));
    expect(p.world.atlas.nodeFile('cover')).toBe(j(root, 'world', 'atlas', 'nodes', 'cover.md'));
    expect(p.world.atlas.pageFile('page-cover')).toBe(j(root, 'world', 'atlas', 'pages', 'page-cover.md'));
    expect(p.world.atlas.pendingNodeFile('n1')).toBe(j(root, 'world', 'atlas', 'pending', 'nodes', 'n1.md'));
    expect(p.world.atlas.pendingPageFile('p1')).toBe(j(root, 'world', 'atlas', 'pending', 'pages', 'p1.md'));

    expect(p.assistant.atlas.dir).toBe(j(root, '.assistant', 'atlas'));
    expect(p.assistant.atlas.runs).toBe(j(root, '.assistant', 'atlas', 'runs'));
    expect(p.assistant.atlas.annotationQueue).toBe(j(root, '.assistant', 'atlas', 'annotation-queue'));
    expect(p.assistant.atlas.decisions).toBe(j(root, '.assistant', 'atlas', 'decisions'));
    expect(p.assistant.atlas.runFile('atlas-run-1')).toBe(
      j(root, '.assistant', 'atlas', 'runs', 'atlas-run-1.json'),
    );
  });
});
