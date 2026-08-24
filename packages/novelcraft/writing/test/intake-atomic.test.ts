// 素材入库批量原子收口契约(N32 同步面, 交接 §7 条目 11):
//   ① 成功路径: 整批落库 + 「material intake」精确单 commit → 工作区 clean、
//      章节/原文/log 均进 HEAD(commitScenes 的 R17 DIRTY_WORKSPACE 联动自此满足);
//   ② 中途异常: 首写前字节快照补偿回滚 —— imports 原文与已写章节零残留后重抛;
//   ③ 幂等跳过(duplicate_import): 零触碰零 commit。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initVault } from '@novelcraft/vault';
import { importTextChapters } from '../src/import-text.js';

const dirs: string[] = function () { return []; }();
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nc-intake-atomic-'));
  dirs.push(root);
  initVault(root, { title: '入库测试书', language: 'zh' });
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function subjects(root: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}
function statusEmpty(root: string): boolean {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
}

const TEXT = '第一章 起\n正文一。\n第二章 承\n正文二。\n';

describe('importTextChapters 批量原子收口(N32 同步面)', () => {
  it('成功路径: 整批落库 + material intake 精确单 commit → clean + 全部进 HEAD', () => {
    const root = makeRoot();
    const r = importTextChapters(root, { fileName: '手稿.txt', text: TEXT, source: 'test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toBe(2);
    // 「素材先提交」: 精确 pathspec 单 commit, 工作区 clean, 文件在 HEAD。
    const s = subjects(root);
    expect(s[0]).toContain('material intake');
    expect(s.filter((m) => m.includes('material intake'))).toHaveLength(1);
    expect(statusEmpty(root)).toBe(true);
    expect(existsSync(path.join(root, 'chapters', '001.md'))).toBe(true);
    expect(existsSync(path.join(root, 'chapters', '002.md'))).toBe(true);
    expect(existsSync(path.join(root, 'imports', 'import-log.jsonl'))).toBe(true);
  });

  it('中途异常 → 首写前字节快照补偿回滚, imports 原文与已写章节零残留后重抛', async () => {
    const root = makeRoot();
    const ingestModule = await import('../src/ingest.js');
    const real = ingestModule.ingestChapter.bind(ingestModule);
    // 第 1 章真实落盘, 第 2 章 ingest 时模拟中途崩溃 → 补偿回滚必须连第 1 章一起清。
    const spy = vi.spyOn(ingestModule, 'ingestChapter')
      .mockImplementationOnce((...args: Parameters<typeof real>) => real(...args) as ReturnType<typeof real>)
      .mockImplementationOnce(() => {
        throw new Error('模拟第 2 章 ingest 中途崩溃');
      });
    void spy;
    expect(() =>
      importTextChapters(root, { fileName: '手稿.txt', text: TEXT, source: 'test' }),
    ).toThrow('模拟第 2 章 ingest 中途崩溃');
    // 补偿回滚: imports 原文(首写)与已落盘的第 1 章均不存在, HEAD 不变, 工作区 clean。
    expect(existsSync(path.join(root, 'chapters', '001.md'))).toBe(false);
    expect(existsSync(path.join(root, 'chapters', '002.md'))).toBe(false);
    const importFiles = execFileSync('git', ['ls-files', 'imports'], { cwd: root, encoding: 'utf8' }).trim();
    expect(importFiles).toBe('');
    expect(subjects(root).length).toBe(1); // 仅 init: bootstrap vault
    expect(statusEmpty(root)).toBe(true);
  });

  it('duplicate_import 幂等跳过: 零触碰零 commit', () => {
    const root = makeRoot();
    const first = importTextChapters(root, { fileName: '手稿.txt', text: TEXT, source: 'test' });
    expect(first.ok).toBe(true);
    const commits = subjects(root).length;
    const second = importTextChapters(root, { fileName: '手稿.txt', text: TEXT, source: 'test' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.warnings).toContain('duplicate_import');
    expect(subjects(root).length).toBe(commits); // 无新 commit
  });
});
