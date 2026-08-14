/**
 * ensureVaultGitignore 行为契约(M6 Track A1: 派生索引不提交 git)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureVaultGitignore, initVault } from '../src/index';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-gitignore-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ensureVaultGitignore(幂等追加)', () => {
  it('.gitignore 不存在则创建, 返回实际新追加的行', () => {
    const root = tmpRoot();
    const added = ensureVaultGitignore(root, ['.assistant/rag-index.json']);
    expect(added).toEqual(['.assistant/rag-index.json']);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      '.assistant/rag-index.json\n',
    );
  });

  it('已存在的行不重复追加; 多条目只追加缺失项', () => {
    const root = tmpRoot();
    expect(ensureVaultGitignore(root, ['a', 'b'])).toEqual(['a', 'b']);
    expect(ensureVaultGitignore(root, ['a', 'b', 'c'])).toEqual(['c']);
    expect(ensureVaultGitignore(root, ['a', 'c'])).toEqual([]);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('a\nb\nc\n');
  });

  it('向无尾换行的既有 .gitignore 干净追加', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, '.gitignore'), 'node_modules', 'utf8');
    const added = ensureVaultGitignore(root, ['dist']);
    expect(added).toEqual(['dist']);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules\ndist\n',
    );
  });

  it('幂等: 连调两次第二次返回 []', () => {
    const root = tmpRoot();
    ensureVaultGitignore(root, ['x']);
    expect(ensureVaultGitignore(root, ['x'])).toEqual([]);
  });
});

describe('initVault(M6: 派生索引 .gitignore 行)', () => {
  it('新 vault 的 .gitignore 含 .assistant/rag-index.json', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });
    expect(existsSync(path.join(root, '.gitignore'))).toBe(true);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain(
      '.assistant/rag-index.json',
    );
  });

  it('重复 init(幂等)不产生重复行', () => {
    const root = tmpRoot();
    initVault(root, { title: 'B' });
    initVault(root, { title: 'B' }); // book.yml 已存在 → 提前返回, 不重写。
    const lines = readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
    expect(lines.filter((l) => l === '.assistant/rag-index.json')).toHaveLength(1);
  });
});
