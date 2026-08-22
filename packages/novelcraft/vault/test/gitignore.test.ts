/**
 * ensureVaultGitignore 行为契约(M6 Track A1: 派生索引不提交 git)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('ensureVaultGitignore 自身 fail-closed(helper 内 guard + symlink 检查, 所有调用面生效)', () => {
  // 文件 symlink 探测(Windows 需特权; 失败则整组跳过)。
  const fileSymlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'nvc-gi-linkprobe-'));
    try {
      writeFileSync(path.join(base, 't.txt'), 'x');
      symlinkSync(path.join(base, 't.txt'), path.join(base, 'l.txt'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  it.skipIf(!fileSymlinksSupported)(
    '有效外部 .gitignore symlink: 直接调用即拒, 外部哨兵零修改(不经 init 调用面)',
    () => {
      const root = tmpRoot();
      const outside = path.join(os.tmpdir(), `ncvl-gi-direct-${Date.now()}.gitignore`);
      writeFileSync(outside, '外部哨兵, 不得被改写\n');
      try {
        symlinkSync(outside, path.join(root, '.gitignore'));
        expect(() => ensureVaultGitignore(root, ['world/atlas/images/'])).toThrow(
          /escapes vault root/,
        );
        expect(readFileSync(outside, 'utf8')).toBe('外部哨兵, 不得被改写\n');
      } finally {
        rmSync(outside, { force: true });
      }
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    'dangling 外部 .gitignore symlink: 直接调用即拒, 外部目标零创建',
    () => {
      const root = tmpRoot();
      const outside = path.join(os.tmpdir(), `ncvl-gi-direct-dangle-${Date.now()}.gitignore`);
      symlinkSync(outside, path.join(root, '.gitignore')); // 目标不存在 → dangling。
      expect(() => ensureVaultGitignore(root, ['world/atlas/images/'])).toThrow(
        /Cannot resolve real path|escapes vault root/,
      );
      expect(existsSync(outside)).toBe(false); // writeFileSync 未被跟随执行。
      rmSync(outside, { force: true });
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    'vault 内 .gitignore symlink→其他文件: 直接调用即拒, 目标哨兵零修改',
    () => {
      const root = tmpRoot();
      writeFileSync(path.join(root, 'bible.md'), '哨兵, 不得被改写');
      symlinkSync(path.join(root, 'bible.md'), path.join(root, '.gitignore'));
      expect(() => ensureVaultGitignore(root, ['world/atlas/images/'])).toThrow(
        /crosses a symlink/,
      );
      expect(readFileSync(path.join(root, 'bible.md'), 'utf8')).toBe('哨兵, 不得被改写');
    },
  );

  it('root 自身为 symlink 时仍允许(helper 以真实位置为 canonical root)', () => {
    const real = tmpRoot();
    const alias = path.join(tmpRoot(), 'alias');
    try {
      symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 平台不支持, 跳过。
    }
    expect(ensureVaultGitignore(alias, ['x'])).toEqual(['x']);
    expect(existsSync(path.join(real, '.gitignore'))).toBe(true);
  });
});
