/**
 * @novelcraft/vault 行为契约测试(vitest)。
 *
 * 规则引用:
 * - §22.2 = docs/agent/dsh-rebuild/自主智能式作家助手设计.md 「文件夹真相」目录树。
 * - R#     = specs/rules/store-rules.md 完整性规则编号。
 * - N#     = specs/adjudications.md 裁定编号。
 * - small-modules §1.1 = specs/assets/small-modules.md 「project」节。
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapVaultGitHistory,
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

/** OID 格式: sha1=40-hex / sha256=64-hex(独立审查: 测试支持 40/64 OID)。 */
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function expectOid(s: string): void {
  expect(s).toMatch(OID_RE);
}

/** 测试内 git CLI 薄封装(原始输出, 不 trim; 供字节级比对)。 */
function gitRaw(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** 测试内 git CLI 薄封装(trim 后输出)。 */
function git(root: string, args: string[]): string {
  return gitRaw(root, args).trim();
}

/** HEAD tree 中的相对路径(排序后的纯文件名列表)。 */
function headTreeFiles(root: string): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();
}

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
      '.assistant/proposals', // 下一步提案中心(§17.5.3)
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

describe('initVault · N32 初始 commit(bootstrapVaultGitHistory, ADR-0021 base HEAD)', () => {
  it('新建 vault: 对外返回前已有精确初始 commit, HEAD 可解析(N32/ADR-0021)', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });

    // HEAD 已存在且恰一个 root commit(无父)——ADR-0021 事务的 base HEAD 前置。
    const head = git(root, ['rev-parse', 'HEAD']);
    expectOid(head);
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(root, ['log', '-1', '--format=%s'])).toBe('init: bootstrap vault');
    // root commit: 无 parent(%P 为空)。
    expect(git(root, ['log', '-1', '--format=%P'])).toBe('');
  });

  it('初始 commit tree 精确 = book.yml + .gitignore, 与工作区字节一致, 初始状态工作区干净', () => {
    const root = tmpRoot();
    initVault(root, { title: '诡秘之主' });

    // tree 只含 initVault 实际落盘文件(空目录与派生产物不进 git)。
    expect(headTreeFiles(root)).toEqual(['.gitignore', 'book.yml']);
    // 字节一致(plumbing 精确 stage, 无 clean filter 变换)。
    expect(readFileSync(path.join(root, 'book.yml'), 'utf8')).toBe(
      gitRaw(root, ['show', 'HEAD:book.yml']),
    );
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      gitRaw(root, ['show', 'HEAD:.gitignore']),
    );
    // 共享 index 已同步新 HEAD: 初始状态工作区干净(无书签式 staged 删除, ADR-0021 §2)。
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('commit 身份/日期固定(deterministic author/committer name/email/date, 不受全局 git config 影响)(N32)', () => {
    const root = tmpRoot();
    initVault(root, { title: '书' });
    expect(git(root, ['log', '-1', '--format=%an|%ae|%cn|%ce'])).toBe(
      'novelcraft|novelcraft@example.invalid|novelcraft|novelcraft@example.invalid',
    );
    // 确定性日期(UTC 2026-01-01; %aI/%cI 严格 ISO)。
    expect(git(root, ['log', '-1', '--format=%aI|%cI'])).toBe(
      '2026-01-01T00:00:00Z|2026-01-01T00:00:00Z',
    );
  });

  it('预存外部文件不入初始 commit(禁止 git add -A 卷入), 工作区原样保留', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'notes.txt'), '作者草稿');
    writeFileSync(path.join(root, 'draft.md'), '手稿');
    mkdirSync(path.join(root, 'chapters'), { recursive: true });
    writeFileSync(path.join(root, 'chapters', 'pre.md'), 'x');

    initVault(root, { title: '书' });

    const treeFiles = headTreeFiles(root);
    expect(treeFiles).toEqual(['.gitignore', 'book.yml']);
    for (const rel of ['notes.txt', 'draft.md', 'chapters/pre.md']) {
      expect(treeFiles).not.toContain(rel);
      expect(existsSync(path.join(root, rel))).toBe(true); // 不删除、不迁移
    }
    // 未跟踪状态保留(不 unstage、不 reset)。
    expect(git(root, ['status', '--porcelain'])).toContain('notes.txt');
  });

  it('重复调用/不同 meta 幂等: 不新增 commit、HEAD 不变(已有 vault 契约)', () => {
    const root = tmpRoot();
    const first = initVault(root, { title: 'Book', genre: 'fantasy' });
    const head = git(root, ['rev-parse', 'HEAD']);

    initVault(root, { title: 'DIFFERENT', genre: 'CHANGED' });
    initVault(root, { title: '另一个' });

    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(initVault(root, { title: 'DIFFERENT' }).root).toBe(first.root);
  });

  it('已有历史 vault re-init: 不新增 commit、不捕获工作区外部文件', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' }); // bootstrap commit(#1)
    // 正常提交一个资产(模拟已有历史)。
    writeFileSync(
      path.join(root, 'world', 'objects', 'a.md'),
      '---\nid: a\nkind: character\nname: "A"\nstatus: canonical\n---\n',
    );
    git(root, ['add', '--', 'world/objects/a.md']);
    git(root, [
      '-c', 'user.name=novelcraft', '-c', 'user.email=novelcraft@example.invalid',
      'commit', '-m', 'fixture',
    ]);
    const countBefore = git(root, ['rev-list', '--count', 'HEAD']);
    writeFileSync(path.join(root, 'outside.txt'), '外部文件');

    initVault(root, { title: 'Book' }); // 幂等 re-init

    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe(countBefore);
    expect(headTreeFiles(root)).not.toContain('outside.txt');
  });

  it('预存 staged: 写对象/ref 前 fail-closed, 不入 commit、不清除、零 git 副作用(N32/ADR-0021 §2)', () => {
    const root = tmpRoot();
    git(root, ['init']); // 预置 repo(book.yml 尚不存在 → initVault 走新建分支)。
    writeFileSync(path.join(root, 'notes.txt'), '外部');
    git(root, ['add', '--', 'notes.txt']); // 作者预存 staged。
    const objectsBefore = git(root, ['count-objects']); // 含测试自身 add 的 1 个 blob。

    // 任何预存 staged → 整个 bootstrap fail-closed(不自动清除、不并入), 零对象/ref/index 副作用。
    expect(() => initVault(root, { title: '书' })).toThrow(/预存 staged/);

    // 预存 staged 原样保留(不 unstage、不 reset)。
    const status = git(root, ['status', '--porcelain']).split('\n').filter((l) => l.length > 0);
    expect(status).toContain('A  notes.txt');
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('notes.txt');
    // 零副作用: HEAD 仍 unborn、对象数未增长(bootstrap 未写任何对象)、无临时目录残留。
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toBe(objectsBefore);
    expect(
      readdirSync(path.join(root, '.git')).filter((n) => n.startsWith('novelcraft-bootstrap-')),
    ).toEqual([]);
  });

  it('半初始化修复: book.yml 已写但 HEAD 缺失 → initVault 幂等补 bootstrap commit', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "半初始化"\n', 'utf8');
    git(root, ['init']); // 模拟首次 init 中断于 bootstrap commit 之前。

    initVault(root, { title: 'DIFFERENT' }); // book.yml 已存在 → 只补齐 + bootstrap。

    expectOid(git(root, ['rev-parse', 'HEAD']));
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(headTreeFiles(root)).toEqual(['.gitignore', 'book.yml']);
    // book.yml 不被重写(幂等, 保持旧标题)。
    expect(readFileSync(path.join(root, 'book.yml'), 'utf8')).toContain('title: "半初始化"');
  });

  it('半初始化缺 .git: book.yml 已存在但 .git 缺失 → 安全 git init 后 bootstrap, 绝不返回无 HEAD', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "半初始化"\n', 'utf8');
    expect(existsSync(path.join(root, '.git'))).toBe(false); // 前置: .git 缺失。

    initVault(root, { title: 'DIFFERENT' }); // 必须 git init + bootstrap, 不得返回无 HEAD。

    expectOid(git(root, ['rev-parse', 'HEAD']));
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(headTreeFiles(root)).toEqual(['.gitignore', 'book.yml']);
    expect(git(root, ['status', '--porcelain'])).toBe(''); // 共享 index 已同步, 工作区干净。
    // book.yml 不被重写(幂等, 保持旧标题)。
    expect(readFileSync(path.join(root, 'book.yml'), 'utf8')).toContain('title: "半初始化"');
  });

  it('bootstrapVaultGitHistory 直接调用: 无 HEAD 建 commit, 有 HEAD no-op, 非目录 .git no-op', () => {
    // 直接调用(不经 initVault): 空 repo + book.yml → 建初始 commit。
    const root = tmpRoot();
    git(root, ['init']);
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n', 'utf8');
    bootstrapVaultGitHistory(root);
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(headTreeFiles(root)).toEqual(['book.yml']); // 只含实际存在的声明文件。

    // 再调 → HEAD 已存在 → no-op(不新增 commit)。
    const head = git(root, ['rev-parse', 'HEAD']);
    bootstrapVaultGitHistory(root);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');

    // .git 为 gitfile(非目录)→ no-op 不抛(initVault 的 .git 校验在更早阶段 fail-closed)。
    const fileGit = tmpRoot();
    writeFileSync(path.join(fileGit, '.git'), 'gitdir: /tmp/外部-worktree/.git\n');
    expect(() => bootstrapVaultGitHistory(fileGit)).not.toThrow();
  });
});

describe('bootstrapVaultGitHistory · 最小安全 env 与 .git 内部安全(独立审查加固 ①)', () => {
  /** 目录 symlink 探测(Windows 上 junction 通常无需特权; 仍失败则整组跳过)。 */
  const symlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-vault-probe-'));
    try {
      const target = path.join(base, 'target');
      mkdirSync(target);
      symlinkSync(
        target,
        path.join(base, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  function makeDirSymlink(target: string, link: string): void {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it('GIT_* 环境攻击(GIT_DIR/OBJECT_DIRECTORY/INDEX_FILE/NAMESPACE/REPLACE/CONFIG/身份/日期)全部被清除', () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(path.join(outside, 'sentinel.txt'), '外部哨兵');

    // 攻击 env: 全部 Git 重定向/配置注入/身份日期变量(实现必须不继承任一)。
    const keys = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_INDEX_FILE',
      'GIT_NAMESPACE',
      'GIT_REPLACE_REF_BASE',
      'GIT_CEILING_DIRECTORIES',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_AUTHOR_DATE',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_COMMITTER_DATE',
    ];
    const saved = new Map<string, string | undefined>();
    for (const k of keys) saved.set(k, process.env[k]);
    try {
      process.env.GIT_DIR = path.join(outside, 'evil.git');
      process.env.GIT_WORK_TREE = outside;
      process.env.GIT_COMMON_DIR = path.join(outside, 'evil-common');
      process.env.GIT_OBJECT_DIRECTORY = path.join(outside, 'evil-objects');
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(outside, 'evil-alternate');
      process.env.GIT_INDEX_FILE = path.join(outside, 'evil-index');
      process.env.GIT_NAMESPACE = 'evil-ns';
      process.env.GIT_REPLACE_REF_BASE = 'refs/replace/evil';
      process.env.GIT_CEILING_DIRECTORIES = outside;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'user.name';
      process.env.GIT_CONFIG_VALUE_0 = 'evil-config';
      process.env.GIT_AUTHOR_NAME = 'evil-author';
      process.env.GIT_AUTHOR_EMAIL = 'evil@author.invalid';
      process.env.GIT_AUTHOR_DATE = '2030-01-01T00:00:00+00:00';
      process.env.GIT_COMMITTER_NAME = 'evil-committer';
      process.env.GIT_COMMITTER_EMAIL = 'evil@committer.invalid';
      process.env.GIT_COMMITTER_DATE = '2031-01-01T00:00:00+00:00';

      initVault(root, { title: '书' });
    } finally {
      for (const k of keys) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // 全部 git 副作用落于 vault 自身 .git: 外部目录零新增(攻击目录未被创建/写入)。
    expect(readdirSync(outside).sort()).toEqual(['sentinel.txt']);
    // HEAD 在 vault 内正常建立, 身份/日期固定(不受攻击 env 影响)。
    expectOid(git(root, ['rev-parse', 'HEAD']));
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(root, ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI|%cI'])).toBe(
      'novelcraft|novelcraft@example.invalid|novelcraft|novelcraft@example.invalid|2026-01-01T00:00:00Z|2026-01-01T00:00:00Z',
    );
  });

  it('确定性: 同内容两 vault → 相同 commit OID(身份/日期/message/tree 全固定, 与 GIT_* 无关)', () => {
    const a = tmpRoot();
    initVault(a, { title: '确定性之书', genre: 'fantasy' });
    const b = tmpRoot();
    initVault(b, { title: '确定性之书', genre: 'fantasy' });
    expect(git(a, ['rev-parse', 'HEAD'])).toBe(git(b, ['rev-parse', 'HEAD']));
  });

  it.skipIf(!symlinksSupported)(
    '.git/objects 内部 symlink→外部: bootstrap fail-closed, 外部零写入(加固 ①)',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
      git(root, ['init']);
      rmSync(path.join(root, '.git', 'objects'), { recursive: true, force: true });
      makeDirSymlink(outside, path.join(root, '.git', 'objects'));

      expect(() => bootstrapVaultGitHistory(root)).toThrow(/\.git 内部路径是 symlink/);
      expect(readdirSync(outside)).toEqual([]); // 外部零写入
      expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
      expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
    },
  );

  it.skipIf(!symlinksSupported)(
    '.git/refs 内部 symlink→外部: bootstrap fail-closed, 外部零写入(加固 ①)',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
      git(root, ['init']);
      rmSync(path.join(root, '.git', 'refs'), { recursive: true, force: true });
      makeDirSymlink(outside, path.join(root, '.git', 'refs'));

      expect(() => bootstrapVaultGitHistory(root)).toThrow(/\.git 内部路径是 symlink/);
      expect(readdirSync(outside)).toEqual([]);
      expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    },
  );
});

describe('bootstrapVaultGitHistory · provenance 状态拒绝(独立审查加固 ②: 禁 replace refs/grafts/shallow)', () => {
  it('info/grafts 存在 → fail-closed, 零对象零 HEAD', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    writeFileSync(path.join(root, '.git', 'info', 'grafts'), 'deadbeef\n');

    expect(() => bootstrapVaultGitHistory(root)).toThrow(/info\/grafts/);
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
  });

  it('shallow 存在 → fail-closed, 零对象零 HEAD', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    writeFileSync(path.join(root, '.git', 'shallow'), 'deadbeef\n');

    expect(() => bootstrapVaultGitHistory(root)).toThrow(/shallow/);
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
  });

  it('refs/replace/* 存在 → fail-closed, 零对象零 HEAD', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    mkdirSync(path.join(root, '.git', 'refs', 'replace'), { recursive: true });
    writeFileSync(
      path.join(root, '.git', 'refs', 'replace', 'a'.repeat(40)),
      'b'.repeat(40) + '\n',
    );

    expect(() => bootstrapVaultGitHistory(root)).toThrow(/replace refs/);
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
  });

  it('packed-refs 含 refs/replace/ → fail-closed, 零对象零 HEAD', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    writeFileSync(
      path.join(root, '.git', 'packed-refs'),
      '# pack-refs with: peeled fully-peeled sorted\n' + 'c'.repeat(40) + ' refs/replace/' + 'd'.repeat(40) + '\n',
    );

    expect(() => bootstrapVaultGitHistory(root)).toThrow(/replace refs/);
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
  });
});

describe('bootstrapVaultGitHistory · fail-closed 预检(预存 staged / 共享 index.lock 零副作用)', () => {
  it('预存 .git/index.lock: 写对象/ref 前 fail-closed, lock 原样保留、零对象零 HEAD', () => {
    const root = tmpRoot();
    // 预写全部 initVault 声明文件, 使 fail 前零 fs 写入。
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n', 'utf8');
    writeFileSync(path.join(root, '.gitignore'), '.assistant/rag-index.json\nworld/atlas/images/\n');
    git(root, ['init']);
    const lockPath = path.join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '外部 git 进程占锁');

    expect(() => initVault(root, { title: '书' })).toThrow(/index\.lock/);

    // 零副作用: lock 原样、HEAD unborn、零对象、无 bootstrap 临时目录、声明文件未改写。
    expect(readFileSync(lockPath, 'utf8')).toBe('外部 git 进程占锁');
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['count-objects'])).toMatch(/^0 objects/);
    expect(
      readdirSync(path.join(root, '.git')).filter((n) => n.startsWith('novelcraft-bootstrap-')),
    ).toEqual([]);
    expect(readFileSync(path.join(root, 'book.yml'), 'utf8')).toBe('title: "x"\n');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      '.assistant/rag-index.json\nworld/atlas/images/\n',
    );
  });
});

describe('bootstrapVaultGitHistory · update-ref 三参 CAS(独立审查加固 ③④⑤)', () => {
  it('bootstrap 只更新当前 symbolic HEAD 分支(已存在的其他分支不受影响)', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    const headBranch = git(root, ['symbolic-ref', 'HEAD']); // 当前 unborn 分支。

    // 用私有 index 造一个「其他」commit 并建为另一个分支(共享 index 保持干净)。
    writeFileSync(path.join(root, 'other.txt'), 'other');
    const blob = git(root, ['hash-object', '-w', 'other.txt']);
    const fixtureIndex = path.join(root, '.git', 'fixture-index.tmp');
    const env = { ...process.env, GIT_INDEX_FILE: fixtureIndex };
    try {
      execFileSync(
        'git',
        ['update-index', '--add', '--cacheinfo', `100644,${blob},other.txt`],
        { cwd: root, env, encoding: 'utf8' },
      );
      const tree = execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
      const other = execFileSync(
        'git',
        ['-c', 'user.name=o', '-c', 'user.email=o@e', 'commit-tree', tree, '-m', 'other'],
        { cwd: root, encoding: 'utf8' },
      ).trim();
      git(root, ['branch', 'other', other]);

      bootstrapVaultGitHistory(root);

      // 当前分支被 bootstrap, 其他分支原样未动。
      expect(git(root, ['rev-parse', '--verify', 'refs/heads/other'])).toBe(other);
      expectOid(git(root, ['rev-parse', 'HEAD']));
      expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(git(root, ['rev-parse', 'HEAD'])).not.toBe(other);
      // 共享 index 未被夹具污染(仅 book.yml/.gitignore, 无 other.txt)。
      expect(git(root, ['diff', '--cached', '--name-only'])).toBe('');
      expect(headBranch).toBe(git(root, ['symbolic-ref', 'HEAD']));
    } finally {
      rmSync(fixtureIndex, { force: true });
    }
  });

  it('update-ref CAS 失败且分支仍 unborn(并发 ref lock)→ fail-closed 无法判定归属', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'book.yml'), 'title: "x"\n');
    git(root, ['init']);
    const ref = git(root, ['symbolic-ref', 'HEAD']);
    const refLock = path.join(root, '.git', `${ref}.lock`);
    mkdirSync(path.dirname(refLock), { recursive: true });
    writeFileSync(refLock, '并发进程持 ref lock');

    expect(() => bootstrapVaultGitHistory(root)).toThrow(/无法判定归属/);

    // 不覆盖: 分支仍 unborn、lock 原样、无 bootstrap 临时目录、共享 index 未产生。
    expect(readFileSync(refLock, 'utf8')).toBe('并发进程持 ref lock');
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(existsSync(path.join(root, '.git', 'index'))).toBe(false);
    expect(
      readdirSync(path.join(root, '.git')).filter((n) => n.startsWith('novelcraft-bootstrap-')),
    ).toEqual([]);
  });
});

describe('SHA256 profile(独立审查加固 ⑤: 40/64 OID, GIT_DEFAULT_HASH=sha256)', () => {
  it('GIT_DEFAULT_HASH=sha256 下 initVault 端到端: 64-hex OID, 半初始化缺 .git 同样补建', () => {
    const prev = process.env.GIT_DEFAULT_HASH;
    process.env.GIT_DEFAULT_HASH = 'sha256';
    try {
      // 全新 initVault(内部 git init 经受控透传得到 sha256 仓库)。
      const root = tmpRoot();
      initVault(root, { title: '书' });
      expect(git(root, ['rev-parse', '--show-object-format'])).toBe('sha256');
      expectOid(git(root, ['rev-parse', 'HEAD']));
      expect(git(root, ['rev-parse', 'HEAD'])).toMatch(/^[0-9a-f]{64}$/);
      expect(headTreeFiles(root)).toEqual(['.gitignore', 'book.yml']);
      expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(git(root, ['status', '--porcelain'])).toBe('');

      // 半初始化修复(.git 已存在, sha256): 幂等补 bootstrap commit。
      const root2 = tmpRoot();
      writeFileSync(path.join(root2, 'book.yml'), 'title: "半"\n');
      git(root2, ['init']);
      initVault(root2, { title: 'DIFFERENT' });
      expectOid(git(root2, ['rev-parse', 'HEAD']));
      expect(git(root2, ['rev-parse', 'HEAD'])).toMatch(/^[0-9a-f]{64}$/);
      expect(git(root2, ['rev-list', '--count', 'HEAD'])).toBe('1');

      // 半初始化缺 .git(sha256): git init 后 bootstrap, 不得返回无 HEAD。
      const root3 = tmpRoot();
      writeFileSync(path.join(root3, 'book.yml'), 'title: "缺git"\n');
      expect(existsSync(path.join(root3, '.git'))).toBe(false);
      initVault(root3, { title: 'X' });
      expect(git(root3, ['rev-parse', 'HEAD'])).toMatch(/^[0-9a-f]{64}$/);
      expect(git(root3, ['rev-list', '--count', 'HEAD'])).toBe('1');

      // 确定性跨进程一致(同一内容 → 同一 64-hex OID)。
      const root4 = tmpRoot();
      initVault(root4, { title: '书' });
      expect(git(root4, ['rev-parse', 'HEAD'])).toBe(git(root, ['rev-parse', 'HEAD']));
    } finally {
      if (prev === undefined) delete process.env.GIT_DEFAULT_HASH;
      else process.env.GIT_DEFAULT_HASH = prev;
    }
  });
});

// ============================================================================
// 跨进程竞争测试: 子进程加载 dist 编译产物(与 src 同源, beforeAll 构建)。
// ============================================================================

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(vaultRoot, '..', '..', '..');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
const distPath = path.join(vaultRoot, 'dist', 'index.js');

/** 子进程脚本: 等 GO 屏障 → 记录启动时 HEAD → bootstrap → 写结果 JSON → 退出。 */
const RACE_SCRIPT = [
  "import { execFileSync } from 'node:child_process';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  'const root = process.env.NC_ROOT;',
  'const go = process.env.NC_GO;',
  'const ready = process.env.NC_READY;',
  'const out = process.env.NC_OUT;',
  'const dist = process.env.NC_DIST;',
  "fs.writeFileSync(path.join(ready, String(process.pid)), 'ready');",
  'const deadline = Date.now() + 30000;',
  'while (!fs.existsSync(go)) {',
  '  if (Date.now() > deadline) { process.exit(2); }',
  '  await new Promise((r) => setTimeout(r, 2));',
  '}',
  'let headBefore = null;',
  'try {',
  "  headBefore = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();",
  '} catch {}',
  'try {',
  '  const mod = await import(pathToFileURL(dist).href);',
  '  mod.bootstrapVaultGitHistory(root);',
  "  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();",
  "  fs.writeFileSync(path.join(out, String(process.pid) + '.json'), JSON.stringify({ ok: true, head, headBefore }));",
  '  process.exit(0);',
  '} catch (err) {',
  '  const msg = err && err.message ? String(err.message) : String(err);',
  "  fs.writeFileSync(path.join(out, String(process.pid) + '.json'), JSON.stringify({ ok: false, error: msg, headBefore }));",
  '  process.exit(1);',
  '}',
].join('\n');

interface RaceOutcome {
  code: number;
  result: { ok: boolean; head?: string; headBefore?: string | null; error?: string };
}

async function runRaceChildren(opts: {
  root: string;
  count: number;
}): Promise<RaceOutcome[]> {
  const goDir = tmpRoot();
  const readyDir = tmpRoot();
  const outDir = tmpRoot();
  const go = path.join(goDir, 'go');
  const children: ChildProcess[] = [];
  for (let i = 0; i < opts.count; i++) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NC_ROOT: opts.root,
      NC_GO: go,
      NC_READY: readyDir,
      NC_OUT: outDir,
      NC_DIST: distPath,
    };
    children.push(
      spawn(process.execPath, ['--input-type=module', '-e', RACE_SCRIPT], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  }
  try {
    // 就绪屏障: 全部子进程进入等待后再发 GO, 保证真实同时竞争。
    const readyDeadline = Date.now() + 30000;
    while (readdirSync(readyDir).length < children.length) {
      if (Date.now() > readyDeadline) throw new Error('race children 未全部就绪');
      await new Promise((r) => setTimeout(r, 5));
    }
    writeFileSync(go, 'go');
    const codes = await Promise.all(
      children.map(
        (p) =>
          new Promise<number>((resolve) => {
            const timer = setTimeout(() => {
              p.kill();
              resolve(-1);
            }, 60000);
            p.on('exit', (c) => {
              clearTimeout(timer);
              resolve(c ?? -1);
            });
            p.on('error', () => {
              clearTimeout(timer);
              resolve(-2);
            });
          }),
      ),
    );
    const results = readdirSync(outDir)
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(outDir, f), 'utf8')));
    return children.map((_, i) => ({
      code: codes[i],
      result: (results[i] as RaceOutcome['result']) ?? { ok: false, error: 'no result file' },
    }));
  } finally {
    for (const p of children) {
      if (p.exitCode === null && p.signalCode === null) p.kill();
    }
  }
}

describe('bootstrap 跨进程竞争(独立审查: update-ref 三参 CAS, 跨进程最多一赢家)', () => {
  let distMod: {
    initVault: (root: string, meta: BookMeta) => unknown;
    bootstrapVaultGitHistory: (root: string) => void;
  };

  beforeAll(() => {
    // 子进程加载编译产物(dist): 以本仓库 typescript 构建, 保证与 src 同源。
    execFileSync(tscBin, ['-p', 'tsconfig.build.json'], { cwd: vaultRoot, stdio: 'pipe' });
  }, 120_000);

  beforeAll(async () => {
    distMod = await import(pathToFileURL(distPath).href);
  });

  it(
    '8 进程同内容并发 bootstrap: 全部成功、恰一个 commit、OID 与单进程确定性控制完全一致',
    { timeout: 120_000 },
    async () => {
      // 确定性控制: 相同 title → 相同 book.yml 字节 → 相同确定性 commit OID。
      const ctrl = tmpRoot();
      distMod.initVault(ctrl, { title: '竞争之书' });
      const expected = git(ctrl, ['rev-parse', 'HEAD']);

      // 共享 unborn 仓库(内容与控制完全同字节)。
      const root = tmpRoot();
      git(root, ['init']);
      writeFileSync(path.join(root, 'book.yml'), readFileSync(path.join(ctrl, 'book.yml')));
      writeFileSync(
        path.join(root, '.gitignore'),
        readFileSync(path.join(ctrl, '.gitignore')),
      );

      const outcomes = await runRaceChildren({ root, count: 8 });

      const failed = outcomes.filter((o) => o.code !== 0);
      expect(
        failed.length === 0,
        `失败的子进程: ${JSON.stringify(failed.map((o) => o.result))}`,
      ).toBe(true);
      // 恰一个 commit, 与确定性控制同 OID(跨进程确定性)。
      expectOid(git(root, ['rev-parse', 'HEAD']));
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(expected);
      expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(git(root, ['status', '--porcelain'])).toBe('');
      // 至少 3 个进程在 HEAD 未生时进入 CAS 路径(真实竞争窗口), 且全部安全收敛
      // (loser 识别同一确定性 commit → no-op, 不冲突、不重复 commit)。
      const casPath = outcomes.filter((o) => o.result.ok && o.result.headBefore === null).length;
      expect(casPath, `casPath=${casPath}`).toBeGreaterThanOrEqual(3);
      expect(
        readdirSync(path.join(root, '.git')).filter((n) => n.startsWith('novelcraft-bootstrap-')),
      ).toEqual([]);
    },
  );
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
    // adjudication #3: chapters/pending/{slug}.md(候选 slug 任意单文件段)。
    expect(p.chapters.pendingFile('cand_foo')).toBe(j(root, 'chapters', 'pending', 'cand_foo.md'));
    expect(p.chapters.pendingFile('003')).toBe(j(root, 'chapters', 'pending', '003.md'));

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
    expect(p.assistant.proposals).toBe(j(root, '.assistant', 'proposals'));
    expect(p.assistant.proposalFile('next-002')).toBe(
      j(root, '.assistant', 'proposals', 'next-002.json'),
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

describe('guardPath/readAsset/writeAsset: symlink 真实路径检查(R9)', () => {
  // 目录 symlink 探测: Windows 上 junction 通常无需特权; 仍失败则整组跳过
  // (跨平台稳健, 见修复要求 2)。
  const symlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-symlink-probe-'));
    try {
      const target = path.join(base, 'target');
      mkdirSync(target);
      symlinkSync(
        target,
        path.join(base, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  // 文件 symlink 探测: Windows 上创建文件 symlink 需开发者模式/管理员特权;
  // 失败则文件 symlink 用例整组跳过(跨平台稳健, 见修复要求 2)。
  const fileSymlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-filelink-probe-'));
    try {
      const target = path.join(base, 'target.txt');
      writeFileSync(target, 'x');
      symlinkSync(target, path.join(base, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  function dirSymlink(target: string, link: string): void {
    symlinkSync(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  it.skipIf(!symlinksSupported)(
    'vault 内 symlink→外部目录时 writeAsset 被拒且外部文件不生成(R9)',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      dirSymlink(outside, path.join(root, 'link'));
      // 复现路径: vault/link → vault 外目录; writeAsset(root,'link/escaped.txt')
      // 必须被拒, 外部不得出现文件。
      expect(() => writeAsset(root, 'link/escaped.txt', 'pwned')).toThrow(
        /escapes vault root/,
      );
      expect(existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    'vault 内文件 symlink→外部尚不存在文件: writeAsset 抛错且外部文件不产生(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      const outside = tmpRoot();
      const externalTarget = path.join(outside, 'new-file.md');
      // 目标尚不存在 → dangling symlink。旧实现用 existsSync 找最深存在祖先,
      // 会对悬空链接返回 false, 把它当不存在的普通路径放行, 随后 writeFileSync
      // 跟随该链接在 vault 外创建文件。修复后必须 fail-closed 抛错。
      symlinkSync(externalTarget, path.join(root, 'filelink'));
      expect(existsSync(externalTarget)).toBe(false); // 前置: 链接悬空
      expect(() => writeAsset(root, 'filelink', 'pwned')).toThrow(
        /Cannot resolve real path|escapes vault root/,
      );
      expect(existsSync(externalTarget)).toBe(false); // 外部文件不得产生
    },
  );

  it.skipIf(!symlinksSupported)(
    'dangling 目录 symlink→外部尚不存在目录: writeAsset 抛错且外部目录/文件不产生(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      const outside = tmpRoot();
      const externalDir = path.join(outside, 'sub'); // 尚不存在
      dirSymlink(externalDir, path.join(root, 'dangling-link'));
      // 旧实现会放行并在 mkdirSync 时跟随悬空目录链接在 vault 外建目录建文件。
      expect(() => writeAsset(root, 'dangling-link/escaped.txt', 'x')).toThrow(
        /Cannot resolve real path|escapes vault root/,
      );
      expect(existsSync(externalDir)).toBe(false);
      expect(existsSync(path.join(externalDir, 'escaped.txt'))).toBe(false);
    },
  );

  it.skipIf(!symlinksSupported)(
    'vault 内 symlink→外部目录时 guardPath/readAsset 同样拒绝(R9)',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      writeFileSync(path.join(outside, 'secret.txt'), 'secret');
      dirSymlink(outside, path.join(root, 'link'));
      expect(() => guardPath(root, 'link/secret.txt')).toThrow(
        /escapes vault root/,
      );
      expect(() => readAsset(root, 'link/secret.txt')).toThrow(
        /escapes vault root/,
      );
    },
  );

  it.skipIf(!symlinksSupported)(
    '指向 root 内部的 symlink 放行(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      dirSymlink(path.join(root, 'world', 'objects'), path.join(root, 'inner-link'));
      writeAsset(root, 'inner-link/obj_klein.md', '---\nid: obj_klein\n---\n');
      expect(
        existsSync(path.join(root, 'world', 'objects', 'obj_klein.md')),
      ).toBe(true);
    },
  );

  it.skipIf(!symlinksSupported)(
    'root 自身为 symlink 时以其真实位置为 canonical root(R9)',
    () => {
      const real = tmpRoot();
      initVault(real, { title: 'Book' });
      const aliasRoot = path.join(tmpRoot(), 'alias');
      dirSymlink(real, aliasRoot);
      // 经别名 root 的读写落在真实位置内。
      writeAsset(aliasRoot, 'chapters/001.md', 'x');
      expect(readFileSync(path.join(real, 'chapters', '001.md'), 'utf-8')).toBe(
        'x',
      );
      // 别名 root 下的 symlink 逃逸仍被拒, 外部不生成文件。
      const outside = tmpRoot();
      dirSymlink(outside, path.join(aliasRoot, 'link'));
      expect(() => writeAsset(aliasRoot, 'link/escaped.txt', 'x')).toThrow(
        /escapes vault root/,
      );
      expect(existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    },
  );

  it('普通不存在的子路径仍允许(创建前 guard 通过)(R9)', () => {
    const root = tmpRoot();
    const p = guardPath(root, 'chapters/999.md');
    expect(p).toBe(path.join(root, 'chapters', '999.md'));
    expect(() => writeAsset(root, 'chapters/999.md', 'x')).not.toThrow();
    expect(readFileSync(path.join(root, 'chapters', '999.md'), 'utf-8')).toBe(
      'x',
    );
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

describe('paths() 整目录 symlink→外部 fail-closed(R9 路径构造缺口修复)', () => {
  // 目录 symlink 探测(与上方 guardPath symlink 组同款; Windows 不支持则整组跳过)。
  const symlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-paths-probe-'));
    try {
      const target = path.join(base, 'target');
      mkdirSync(target);
      symlinkSync(target, path.join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  function dirSymlink(target: string, link: string): void {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it.skipIf(!symlinksSupported)(
    'world/objects 整目录 symlink→外部: paths() 拒绝, 写读拒绝, 外部零文件(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      const outside = tmpRoot();
      // initVault 已创建真实 world/objects, 先移除再替换为指向外部的 symlink。
      rmSync(path.join(root, 'world', 'objects'), { recursive: true, force: true });
      dirSymlink(outside, path.join(root, 'world', 'objects'));
      // 任一固定子目录 symlink 出 vault → paths() 整体 fail-closed。
      expect(() => paths(root)).toThrow(/escapes vault root/);
      // 读写同样拒绝, 外部不产生文件。
      expect(() => writeAsset(root, 'world/objects/evil.md', 'x')).toThrow(/escapes vault root/);
      expect(() => readAsset(root, 'world/objects/evil.md')).toThrow(/escapes vault root/);
      expect(existsSync(path.join(outside, 'evil.md'))).toBe(false);
    },
  );

  it.skipIf(!symlinksSupported)(
    '.assistant/atlas/runs 整目录 symlink→外部: paths() 拒绝, runFile 构造拒绝(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      const outside = tmpRoot();
      rmSync(path.join(root, '.assistant', 'atlas', 'runs'), { recursive: true, force: true });
      dirSymlink(outside, path.join(root, '.assistant', 'atlas', 'runs'));
      expect(() => paths(root)).toThrow(/escapes vault root/);
      expect(() => writeAsset(root, '.assistant/atlas/runs/r1.json', '{}')).toThrow(/escapes vault root/);
      expect(existsSync(path.join(outside, 'r1.json'))).toBe(false);
    },
  );

  it.skipIf(!symlinksSupported)(
    'world/objects 整目录 symlink→vault 内 bible: paths() 拒绝(kind 边界, 不只 external escape)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      // guardPath 的 real containment 会放行 root 内 symlink; paths 构造层必须
      // 额外逐段 lstat 拒绝 vault 内 symlink——否则 object 写面会落进 bible。
      rmSync(path.join(root, 'world', 'objects'), { recursive: true, force: true });
      dirSymlink(path.join(root, 'bible'), path.join(root, 'world', 'objects'));
      expect(() => paths(root)).toThrow(/crosses a symlink/);
      // 动态构造器同样 fail-closed。
      expect(() => paths(root).world.objectFile('evil')).toThrow(/crosses a symlink/);
    },
  );

  it.skipIf(!symlinksSupported)(
    '父链 static dir 也被封: world 整目录 symlink→bible, paths() 拒绝(R9 parent 链)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      rmSync(path.join(root, 'world'), { recursive: true, force: true });
      dirSymlink(path.join(root, 'bible'), path.join(root, 'world'));
      expect(() => paths(root)).toThrow(/crosses a symlink/);
    },
  );

  it.skipIf(!symlinksSupported)(
    '动态目标文件 symlink→vault 内别类文件(objectFile→bible 文件): 构造器拒绝(R9)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' });
      // 文件 symlink 探测(Windows 需特权; 失败跳过)。
      let fileLinks = false;
      try {
        symlinkSync(path.join(root, 'bible', 'secret.md'), path.join(root, 'bible', 'probe.md'));
        rmSync(path.join(root, 'bible', 'probe.md'), { force: true });
        fileLinks = true;
      } catch {
        fileLinks = false;
      }
      if (!fileLinks) return; // 本机不支持文件 symlink, 跳过。
      writeAsset(root, 'bible/secret.md', 'secret');
      // world/objects/foo.md 是 symlink → vault 内 bible 文件: guardPath 放行,
      // paths 构造层必须拒绝(否则 objectFile 读/写会命中 bible 资产)。
      symlinkSync(path.join(root, 'bible', 'secret.md'), path.join(root, 'world', 'objects', 'foo.md'));
      expect(() => paths(root).world.objectFile('foo')).toThrow(/crosses a symlink/);
    },
  );

  it.skipIf(!symlinksSupported)(
    'initVault 预置 internal symlink(world/objects→bible): 目录循环即拒, book.yml 写前失败',
    () => {
      const root = tmpRoot();
      // 不调 initVault, 预置: root 骨架 + world/objects → vault 内 bible 的 symlink。
      mkdirSync(path.join(root, 'bible'), { recursive: true });
      mkdirSync(path.join(root, 'world'), { recursive: true });
      dirSymlink(path.join(root, 'bible'), path.join(root, 'world', 'objects'));
      // VAULT_DIRS 目录循环(book.yml 写入之前)复用同一 reject-symlink helper,
      // 第一处 vault 内 symlink 即 fail-closed。
      expect(() => initVault(root, { title: 'Book' })).toThrow(/crosses a symlink/);
      // book.yml 尚未落盘(失败早于写入); bible 未被 mkdir 跟随污染。
      expect(existsSync(path.join(root, 'book.yml'))).toBe(false);
      expect(readdirSync(path.join(root, 'bible'))).toEqual([]);
    },
  );

  it.skipIf(!symlinksSupported)(
    'initVault 预置 parent 链 symlink(world→bible): 目录循环即拒, book.yml 写前失败',
    () => {
      const root = tmpRoot();
      mkdirSync(path.join(root, 'bible'), { recursive: true });
      dirSymlink(path.join(root, 'bible'), path.join(root, 'world'));
      expect(() => initVault(root, { title: 'Book' })).toThrow(/crosses a symlink/);
      expect(existsSync(path.join(root, 'book.yml'))).toBe(false);
      expect(readdirSync(path.join(root, 'bible'))).toEqual([]);
    },
  );

  // 文件 symlink 探测(book.yml 是文件; Windows 需特权, 失败则相关用例跳过)。
  const fileSymlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-bookyml-probe-'));
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
    'initVault 预置 dangling internal book.yml symlink→bible/ghost.md: existsSync 前即拒, 零错误目标写',
    () => {
      const root = tmpRoot();
      mkdirSync(path.join(root, 'bible'), { recursive: true });
      const ghost = path.join(root, 'bible', 'ghost.md'); // 目标尚不存在 → dangling。
      symlinkSync(ghost, path.join(root, 'book.yml'));
      expect(() => initVault(root, { title: 'Book' })).toThrow(/crosses a symlink/);
      // 零错误目标写: 链接未被跟随在 vault 内创建 ghost.md。
      expect(existsSync(ghost)).toBe(false);
      // book.yml 仍是原 symlink 条目(未变成普通文件)。
      expect(readdirSync(root)).toContain('book.yml');
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    'initVault 预置 valid internal book.yml symlink→bible 文件: existsSync 前即拒, 目标未被改写',
    () => {
      const root = tmpRoot();
      mkdirSync(path.join(root, 'bible'), { recursive: true });
      const target = path.join(root, 'bible', 'secret.md');
      writeFileSync(target, '哨兵, 不得被改写');
      symlinkSync(target, path.join(root, 'book.yml'));
      expect(() => initVault(root, { title: 'Book' })).toThrow(/crosses a symlink/);
      // 目标文件原样(未被写入/覆盖)。
      expect(readFileSync(target, 'utf8')).toBe('哨兵, 不得被改写');
      expect(readdirSync(root)).toContain('book.yml');
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '.gitignore 有效外部 symlink: initVault fail-closed, 外部哨兵零修改',
    () => {
      const root = tmpRoot();
      const outside = path.join(os.tmpdir(), `ncvl-gi-out-${Date.now()}.gitignore`);
      writeFileSync(outside, '外部哨兵, 不得被改写\n');
      try {
        symlinkSync(outside, path.join(root, '.gitignore'));
        // ensureVaultGitignore 读写前 guard: real containment 拒绝外部 symlink。
        expect(() => initVault(root, { title: 'Book' })).toThrow(/escapes vault root/);
        expect(readFileSync(outside, 'utf8')).toBe('外部哨兵, 不得被改写\n');
      } finally {
        rmSync(outside, { force: true });
      }
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '.gitignore dangling 外部 symlink: initVault fail-closed, 外部目标零创建',
    () => {
      const root = tmpRoot();
      const outside = path.join(os.tmpdir(), `ncvl-gi-dangle-${Date.now()}.gitignore`);
      symlinkSync(outside, path.join(root, '.gitignore')); // dangling: 目标不存在。
      // guardPath 的 real 检查对 dangling symlink fail-closed(绝不回退父目录
      // 跟随创建), ensureVaultGitignore 的 writeFileSync 不会执行。
      expect(() => initVault(root, { title: 'Book' })).toThrow(
        /Cannot resolve real path|escapes vault root/,
      );
      expect(existsSync(outside)).toBe(false); // 外部目标零创建。
      rmSync(outside, { force: true });
    },
  );

  it.skipIf(!symlinksSupported)(
    '.git 有效外部 symlink: book 写前 fail-closed, 外部哨兵零触碰',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot(); // 外部目录(可被 git init 污染)。
      writeFileSync(path.join(outside, '哨兵.txt'), '外部哨兵');
      dirSymlink(outside, path.join(root, '.git'));
      expect(() => initVault(root, { title: 'Book' })).toThrow(/\.git.*symlink/);
      // 检查在 book 分支之前: book.yml 不落盘。
      expect(existsSync(path.join(root, 'book.yml'))).toBe(false);
      // 外部目录未被 git init(无新增条目)、哨兵原样。
      expect(readdirSync(outside)).toEqual(['哨兵.txt']);
      expect(readFileSync(path.join(outside, '哨兵.txt'), 'utf8')).toBe('外部哨兵');
    },
  );

  it.skipIf(!symlinksSupported)(
    '.git dangling 外部 symlink: book 写前 fail-closed, 外部目标零创建',
    () => {
      const root = tmpRoot();
      const outside = tmpRoot();
      rmSync(outside, { recursive: true, force: true }); // 目标不存在 → dangling。
      try {
        dirSymlink(outside, path.join(root, '.git'));
      } catch {
        return; // 平台不支持 dangling 目录链接, 跳过。
      }
      expect(() => initVault(root, { title: 'Book' })).toThrow(/\.git.*symlink/);
      expect(existsSync(path.join(root, 'book.yml'))).toBe(false);
      expect(existsSync(outside)).toBe(false); // 外部目标未被 git init 跟随创建。
    },
  );

  it('预置 .git gitfile(gitdir: 外部 worktree): book 写前 fail-closed(每书独立 repo 契约)', () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, '.git'), 'gitdir: /tmp/外部-worktree/.git\n');
    expect(() => initVault(root, { title: 'Book' })).toThrow(/\.git.*gitfile|not a directory/);
    expect(existsSync(path.join(root, 'book.yml'))).toBe(false);
  });

  it.skipIf(!symlinksSupported)(
    '已有 book 的 re-init 也拒 .git symlink(检查无条件, 幂等路径同样 fail-closed)',
    () => {
      const root = tmpRoot();
      initVault(root, { title: 'Book' }); // 正常 init, .git 为目录。
      const outside = tmpRoot();
      writeFileSync(path.join(outside, '哨兵.txt'), '外部哨兵');
      rmSync(path.join(root, '.git'), { recursive: true, force: true });
      dirSymlink(outside, path.join(root, '.git'));
      // book 已存在 → 旧实现完全跳过 .git 校验; 现在 book 分支前无条件检查。
      expect(() => initVault(root, { title: 'Book' })).toThrow(/\.git.*symlink/);
      expect(readdirSync(outside)).toEqual(['哨兵.txt']); // 外部未被 git 操作。
      expect(readFileSync(path.join(outside, '哨兵.txt'), 'utf8')).toBe('外部哨兵');
    },
  );

  it('已有 book 的 re-init 也拒 .git gitfile(幂等路径同样 fail-closed)', () => {
    const root = tmpRoot();
    initVault(root, { title: 'Book' });
    rmSync(path.join(root, '.git'), { recursive: true, force: true });
    writeFileSync(path.join(root, '.git'), 'gitdir: /tmp/外部-worktree/.git\n');
    expect(() => initVault(root, { title: 'Book' })).toThrow(/\.git.*gitfile|not a directory/);
  });

  it('init 前(目录尚不存在)paths() 仍工作: 待创建路径落在 canonical root 内放行', () => {
    const parent = tmpRoot(); // 存在
    const root = path.join(parent, 'not-yet-created'); // 不存在
    const p = paths(root);
    expect(p.world.objects).toBe(path.join(root, 'world', 'objects'));
    expect(p.chapters.chapterFile(3)).toBe(path.join(root, 'chapters', '003.md'));
    expect(p.assistant.atlas.runFile('run-1')).toBe(path.join(root, '.assistant', 'atlas', 'runs', 'run-1.json'));
  });
});

describe('动态文件构造器单路径段校验(assertSafePathSegment, R9)', () => {
  it('../、反斜杠、`.`、`..`、控制字符 一律拒绝', () => {
    const root = tmpRoot();
    const p = paths(root);
    expect(() => p.world.objectFile('../evil')).toThrow(/非法路径段/);
    expect(() => p.world.objectFile('a\\b')).toThrow(/非法路径段/);
    expect(() => p.scenes.sceneFile('..')).toThrow(/非法路径段/);
    expect(() => p.bible.bibleFile('.')).toThrow(/非法路径段/);
    expect(() => p.imports.importFile('dir/file.txt')).toThrow(/非法路径段/);
    expect(() => p.imports.importFile('a\u0000b.txt')).toThrow(/非法路径段/);
    expect(() => p.assistant.signalFile('sig/../x')).toThrow(/非法路径段/);
    expect(() => p.assistant.atlas.runFile('run\\id')).toThrow(/非法路径段/);
    expect(() => p.structure.threadFile('thread/../x')).toThrow(/非法路径段/);
  });

  it('importFile 可带扩展名但不可带目录; 合法名字放行', () => {
    const root = tmpRoot();
    const p = paths(root);
    expect(p.imports.importFile('chapter1.txt')).toBe(path.join(root, 'imports', 'chapter1.txt'));
    expect(p.imports.importFile('a.b.c.md')).toBe(path.join(root, 'imports', 'a.b.c.md'));
    expect(() => p.imports.importFile('')).toThrow(/非法路径段/);
    expect(() => p.imports.importFile('sub/file.txt')).toThrow(/非法路径段/);
  });

  it('chapterFile 只接受正整数(§22.2 NNN 约定)', () => {
    const root = tmpRoot();
    const p = paths(root);
    expect(p.chapters.chapterFile(3)).toBe(path.join(root, 'chapters', '003.md'));
    expect(p.chapters.chapterFile(1234)).toBe(path.join(root, 'chapters', '1234.md'));
    expect(() => p.chapters.chapterFile(0)).toThrow(/正整数/);
    expect(() => p.chapters.chapterFile(-1)).toThrow(/正整数/);
    expect(() => p.chapters.chapterFile(1.5)).toThrow(/正整数/);
    expect(() => p.chapters.chapterFile(Number.NaN)).toThrow(/正整数/);
  });

  it('合法中文 slug 与含空格 id 不受影响(N10 保留 CJK)', () => {
    const root = tmpRoot();
    const p = paths(root);
    expect(p.world.objectFile('诡秘之主')).toBe(path.join(root, 'world', 'objects', '诡秘之主.md'));
    expect(p.bible.bibleFile('第一章')).toBe(path.join(root, 'bible', '第一章.md'));
    expect(p.assistant.signalFile('dedup-l0-苏 婉')).toBe(
      path.join(root, '.assistant', 'signals', 'dedup-l0-苏 婉.json'),
    );
  });
});
