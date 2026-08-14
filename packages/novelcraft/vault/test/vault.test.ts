/**
 * @novelcraft/vault 行为契约测试(vitest)。
 *
 * 规则引用:
 * - §22.2 = docs/agent/dsh-rebuild/自主智能式作家助手设计.md 「文件夹真相」目录树。
 * - R#     = specs/rules/store-rules.md 完整性规则编号。
 * - N#     = specs/adjudications.md 裁定编号。
 * - small-modules §1.1 = specs/assets/small-modules.md 「project」节。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initVault,
  paths,
  guardPath,
  readAsset,
  writeAsset,
  resolveVaultRoot,
  slugify,
  SLUG_MAX_LENGTH,
  type BookMeta,
} from '../src/index';

const tmpDirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-vault-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('initVault(§22.2 目录树 + .git init)', () => {
  it('creates the full directory skeleton, book.yml, and .git', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });

    // §22.2 + adjudications #1–#5 + N12 的全部目录。
    const expectedDirs = [
      'chapters',
      'chapters/pending', // adjudication #3 候选正文落点
      'scenes',
      'world',
      'world/objects',
      'world/pending',
      'structure',
      'structure/threads', // N12 目录化
      'structure/arcs', // N12 目录化
      'structure/foreshadowing', // N12 目录化
      'structure/reveal', // N12 目录化
      'memory',
      'bible',
      'imports',
      '.assistant',
      '.assistant/signals',
      '.assistant/reviews', // adjudication #4 派生审查/回执
    ];
    for (const dir of expectedDirs) {
      expect(existsSync(path.join(root, dir)), `missing dir: ${dir}`).toBe(true);
    }

    // book.yml 与 .git(§22.2: 每书一个 git 仓库)。
    expect(existsSync(path.join(root, 'book.yml'))).toBe(true);
    expect(existsSync(path.join(root, '.git'))).toBe(true);
  });

  it('writes book.yml fields with defaults from small-modules §1.1', () => {
    const root = tmpRoot();
    initVault(root, {
      title: '  诡秘之主  ',
      genre: '克苏鲁/蒸汽朋克',
      tone: '悬疑',
      target_length: 'novel',
      current_stage: 'writing',
    });
    const yaml = readFileSync(path.join(root, 'book.yml'), 'utf-8');

    // title 去首尾空白(small-modules §1.1 完整性规则)。
    expect(yaml).toContain('title: "诡秘之主"');
    expect(yaml).toContain('genre: "克苏鲁/蒸汽朋克"');
    expect(yaml).toContain('tone: "悬疑"');
    // language 默认 zh、default_reveal_policy 默认 author_safe(small-modules §1.1)。
    expect(yaml).toContain('language: "zh"');
    // N9: 字段名以 Spec 为权威, 用 target_length / current_stage。
    expect(yaml).toContain('target_length: "novel"');
    expect(yaml).toContain('current_stage: "writing"');
    expect(yaml).toContain('default_reveal_policy: "author_safe"');
  });

  it('rejects target_length / current_stage outside their enums(N9)', () => {
    expect(() =>
      initVault(tmpRoot(), { title: 'Test', target_length: 'epic-poem' }),
    ).toThrow(/target_length/);
    expect(() =>
      initVault(tmpRoot(), { title: 'Test', current_stage: 'drafting' }),
    ).toThrow(/current_stage/);
  });

  it('is idempotent: existing book.yml is never rewritten', () => {
    const root = tmpRoot();
    const first = initVault(root, { title: 'Book', genre: 'fantasy' });
    const before = readFileSync(path.join(root, 'book.yml'), 'utf-8');

    const second = initVault(root, { title: 'DIFFERENT', genre: 'CHANGED' });
    const after = readFileSync(path.join(root, 'book.yml'), 'utf-8');

    expect(second.root).toBe(first.root);
    expect(after).toBe(before);
    expect(after).toContain('title: "Book"');
    expect(after).not.toContain('DIFFERENT');
  });

  it('rejects empty/whitespace/null-byte title(small-modules §1.1)', () => {
    expect(() => initVault(tmpRoot(), { title: '' })).toThrow(/title/i);
    expect(() => initVault(tmpRoot(), { title: '   ' })).toThrow(/title/i);
    expect(() => initVault(tmpRoot(), { title: 'a\0b' })).toThrow(/null byte/i);
  });

  it('rejects default_reveal_policy outside the whitelist(small-modules §1.1)', () => {
    expect(() =>
      initVault(tmpRoot(), { title: 'Test', default_reveal_policy: 'everything' }),
    ).toThrow(/default_reveal_policy/);
  });
});

describe('resolveVaultRoot(R9: 以工作区根为边界)', () => {
  it('finds the root from the root itself', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    expect(resolveVaultRoot(root)).toBe(path.resolve(root));
  });

  it('finds the root from a nested subdirectory', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    const sub = path.join(root, 'world', 'objects');
    expect(resolveVaultRoot(sub)).toBe(path.resolve(root));
  });

  it('finds the root from a file path(可能尚不存在)', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    const file = path.join(root, 'chapters', '003.md');
    expect(resolveVaultRoot(file)).toBe(path.resolve(root));
  });

  it('throws when no book.yml exists up the tree', () => {
    const root = tmpRoot(); // 空目录, 未 init。
    expect(() => resolveVaultRoot(root)).toThrow(/No vault root found/);
  });
});

describe('paths(§22.2 全表 + adjudications #1–#5)', () => {
  it('covers every path constant and join function', () => {
    const root = tmpRoot();
    const p = paths(root);
    const j = path.join;

    expect(p.root).toBe(path.resolve(root));
    expect(p.bookYml).toBe(j(root, 'book.yml'));

    // chapters(§22.2 `chapters/003.md`; adjudication #3 `chapters/pending/`)。
    expect(p.chapters.dir).toBe(j(root, 'chapters'));
    expect(p.chapters.pending).toBe(j(root, 'chapters', 'pending'));
    expect(p.chapters.chapterFile(3)).toBe(j(root, 'chapters', '003.md'));
    expect(p.chapters.chapterFile(12)).toBe(j(root, 'chapters', '012.md'));
    expect(p.chapters.chapterFile(1234)).toBe(j(root, 'chapters', '1234.md'));

    // scenes。
    expect(p.scenes.dir).toBe(j(root, 'scenes'));
    expect(p.scenes.sceneFile('s012')).toBe(j(root, 'scenes', 's012.md'));

    // world。
    expect(p.world.dir).toBe(j(root, 'world'));
    expect(p.world.objects).toBe(j(root, 'world', 'objects'));
    expect(p.world.pending).toBe(j(root, 'world', 'pending'));
    expect(p.world.objectFile('obj_klein')).toBe(
      j(root, 'world', 'objects', 'obj_klein.md'),
    );
    expect(p.world.pendingFile('pend_red')).toBe(
      j(root, 'world', 'pending', 'pend_red.md'),
    );

    // structure(N12 目录化 + adjudication #1; outline 保持单文件)。
    expect(p.structure.dir).toBe(j(root, 'structure'));
    expect(p.structure.outline).toBe(j(root, 'structure', 'outline.md'));
    expect(p.structure.threads).toBe(j(root, 'structure', 'threads'));
    expect(p.structure.arcs).toBe(j(root, 'structure', 'arcs'));
    expect(p.structure.foreshadowing).toBe(j(root, 'structure', 'foreshadowing'));
    expect(p.structure.reveal).toBe(j(root, 'structure', 'reveal'));
    expect(p.structure.threadFile('t001')).toBe(
      j(root, 'structure', 'threads', 't001.md'),
    );
    expect(p.structure.arcFile('a001')).toBe(
      j(root, 'structure', 'arcs', 'a001.md'),
    );
    expect(p.structure.foreshadowingFile('f001')).toBe(
      j(root, 'structure', 'foreshadowing', 'f001.md'),
    );
    expect(p.structure.revealFile('r001')).toBe(
      j(root, 'structure', 'reveal', 'r001.md'),
    );

    // memory。
    expect(p.memory.dir).toBe(j(root, 'memory'));
    expect(p.memory.events).toBe(j(root, 'memory', 'events.jsonl'));

    // bible(§22.2 世界书页面)。
    expect(p.bible.dir).toBe(j(root, 'bible'));
    expect(p.bible.bibleFile('第一章')).toBe(j(root, 'bible', '第一章.md'));

    // imports(§22.2 D9a: 统一 .txt/.md)。
    expect(p.imports.dir).toBe(j(root, 'imports'));
    expect(p.imports.importFile('chapter1.txt')).toBe(
      j(root, 'imports', 'chapter1.txt'),
    );

    // .assistant(§22.2 + adjudications #4/#5)。
    expect(p.assistant.dir).toBe(j(root, '.assistant'));
    expect(p.assistant.policy).toBe(j(root, '.assistant', 'policy.yml'));
    expect(p.assistant.calibration).toBe(j(root, '.assistant', 'calibration.md'));
    expect(p.assistant.checkpoint).toBe(j(root, '.assistant', 'checkpoint.json'));
    expect(p.assistant.signals).toBe(j(root, '.assistant', 'signals'));
    expect(p.assistant.signalFile('watch')).toBe(
      j(root, '.assistant', 'signals', 'watch.json'),
    );
    expect(p.assistant.llm).toBe(j(root, '.assistant', 'llm.yml'));
    expect(p.assistant.reviews).toBe(j(root, '.assistant', 'reviews'));
    expect(p.assistant.reviewFile('conflict')).toBe(
      j(root, '.assistant', 'reviews', 'conflict.json'),
    );
    expect(p.assistant.mergeLog).toBe(j(root, '.assistant', 'merge-log.jsonl'));
  });
});

describe('guardPath(R9: 禁止路径逃逸到书外)', () => {
  it('returns the normalized path for in-root paths', () => {
    const root = tmpRoot();
    expect(guardPath(root, 'world/objects/foo.md')).toBe(
      path.join(root, 'world', 'objects', 'foo.md'),
    );
    // 规范化 ../ 折叠。
    expect(guardPath(root, 'chapters/../world')).toBe(path.join(root, 'world'));
    // root 自身允许。
    expect(guardPath(root, '.')).toBe(path.resolve(root));
  });

  it('rejects ../ traversal', () => {
    const root = tmpRoot();
    expect(() => guardPath(root, '../outside')).toThrow(/escapes vault root/);
    expect(() => guardPath(root, 'world/../../outside')).toThrow(/escapes vault root/);
  });

  it('rejects absolute paths outside root', () => {
    const root = tmpRoot();
    const outside = path.join(root, '..', 'elsewhere');
    expect(() => guardPath(root, outside)).toThrow(/escapes vault root/);
  });
});

describe('readAsset / writeAsset(R12: 文件是唯一真相; R9 门禁)', () => {
  it('writes with parent-dir creation and reads back', () => {
    const root = tmpRoot();
    const rel = 'world/objects/克莱恩-莫雷蒂.md';
    writeAsset(root, rel, '---\nid: obj_klein\n---\n');
    expect(readAsset(root, rel)).toBe('---\nid: obj_klein\n---\n');
  });

  it('rejects write that escapes the root', () => {
    const root = tmpRoot();
    expect(() => writeAsset(root, '../evil.md', 'x')).toThrow(/escapes vault root/);
  });

  it('round-trips structure assets into N12 per-asset directories', () => {
    const root = tmpRoot();
    const p = paths(root);
    // N12: threads/arcs/foreshadowing/reveal 为目录(每资产一文件)。
    const thread = 'structure/threads/克莱恩主线.md';
    writeAsset(root, thread, '---\nid: 克莱恩主线\n---\n');
    expect(readAsset(root, thread)).toBe('---\nid: 克莱恩主线\n---\n');
    expect(p.structure.threadFile('克莱恩主线')).toBe(
      path.join(root, 'structure', 'threads', '克莱恩主线.md'),
    );
    // N12: outline 保持单文件。
    writeAsset(root, 'structure/outline.md', '---\nid: outline\n---\n');
    expect(readAsset(root, 'structure/outline.md')).toBe('---\nid: outline\n---\n');
    expect(p.structure.outline).toBe(path.join(root, 'structure', 'outline.md'));
  });
});

describe('slugify(N10: 保留 CJK; id = 文件名 slug)', () => {
  it('keeps CJK characters(N10)', () => {
    expect(slugify('诡秘之主')).toBe('诡秘之主');
  });

  it('maps path-illegal chars to hyphens(N10 剔除 /\\:*?"<>|)', () => {
    expect(slugify('A/B:C')).toBe('A-B-C');
    expect(slugify('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('preserves case and legal symbols(仅剔除非法字符与控制字符)', () => {
    expect(slugify('The Way of Kings')).toBe('The-Way-of-Kings');
    expect(slugify('A!!B??C')).toBe('A!!B-C'); // ? 非法 → '-'; ! 合法保留
  });

  it('normalizes whitespace runs to a single hyphen', () => {
    expect(slugify('  The  Lord of the Rings  ')).toBe('The-Lord-of-the-Rings');
  });

  it('keeps diacritics(N10 仅剔除非法字符)', () => {
    expect(slugify('Cliché Café')).toBe('Cliché-Café');
  });

  it('strips control characters', () => {
    expect(slugify('a\u0000b')).toBe('ab');
  });

  it('throws on empty / whitespace-only / illegal-only input(N10 空结果抛错)', () => {
    expect(() => slugify('')).toThrow(/non-empty slug/);
    expect(() => slugify('   ')).toThrow(/non-empty slug/);
    expect(() => slugify('/:\\')).toThrow(/non-empty slug/);
  });

  it('limits length to 64 chars(N10 限长 64)', () => {
    expect(slugify('a'.repeat(100))).toBe('a'.repeat(SLUG_MAX_LENGTH));
    expect(slugify('诡'.repeat(100))).toBe('诡'.repeat(SLUG_MAX_LENGTH));
  });

  it('re-trims a trailing hyphen after truncation', () => {
    // 63 个 a + "-b": 截断到 64 后尾部是 "-", 需再被裁掉。
    expect(slugify('a'.repeat(63) + '-b')).toBe('a'.repeat(63));
  });

  it('dedupes by appending -2 on collision(N10 冲突去重)', () => {
    const existing = new Set(['诡秘之主']);
    expect(slugify('诡秘之主', existing)).toBe('诡秘之主-2');
  });

  it('dedupes with the next available suffix(N10 冲突去重)', () => {
    const existing = new Set(['x', 'x-2', 'x-3']);
    expect(slugify('x', existing)).toBe('x-4');
  });

  it('does not mutate the provided existing set', () => {
    const existing = new Set(['诡秘之主']);
    slugify('诡秘之主', existing);
    expect([...existing]).toEqual(['诡秘之主']);
  });
});
