import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  adopt,
  prepareAdopt,
  executePreparedAdopt,
  softDelete,
  confirmSuggestion,
  rejectSuggestion,
  resolveWithin,
  StoreError,
  contentHash,
  gitLogSubjects,
  gitStatusEntries,
  recoverInterruptedTransactions,
  CrashSimulatedError,
  type GatePhase,
} from '../src/index';
import { tmpVault, initRepo, commitAll, writeAsset, readFrontmatter, readBody } from './helpers';

const cleanups: Array<() => void> = [];
let root = '';

// 文件 symlink 探测(Windows 需开发者模式/管理员; 失败则整组跳过)。
const fileSymlinksSupported = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-adopt-linkprobe-'));
  try {
    fs.writeFileSync(path.join(base, 't.txt'), 'x');
    fs.symlinkSync(path.join(base, 't.txt'), path.join(base, 'l.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

function fixture(): string {
  const { root: r, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(r);
  commitAll(r, 'init');
  root = r;
  return r;
}

function crashAt(phase: GatePhase) {
  return {
    gates: async (current: GatePhase) => {
      if (current === phase) throw new CrashSimulatedError(phase);
    },
  };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('adopt(N32 精确 writeSet + R3 状态机)', () => {
  it('允许 writeSet 外无关 unstaged/untracked，且绝不夹带进事务 commit(N32)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' }, '候选');
    commitAll(r);
    const unrelated = path.join(r, 'world', 'objects', 'dirty.md');
    fs.writeFileSync(unrelated, 'uncommitted');
    await expect(adopt(r, 'object', 'pend_red')).resolves.toMatchObject({ toStatus: 'canonical' });
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('uncommitted');
    expect(readFrontmatter(r, 'world/objects/pend_red.md').status).toBe('canonical');
  });

  it('生产 adopt 在 intent-ready 崩溃后 recovery 条件回滚；新调用方可重新审批后重试(N32)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_crash.md', { id: 'pend_crash', kind: 'character', name: '崩溃候选', status: 'candidate' }, '候选');
    commitAll(r);
    await expect(adopt(r, 'object', 'pend_crash', { tx: crashAt('intent-ready') })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(fs.existsSync(path.join(r, 'world/pending/pend_crash.md'))).toBe(true);
    const recovered = await recoverInterruptedTransactions(r, { lockStaleMs: 1 });
    expect(recovered.unresolved).toEqual([]);
    expect(fs.existsSync(path.join(r, 'world/objects/pend_crash.md'))).toBe(false);
    expect(readFrontmatter(r, 'world/pending/pend_crash.md').status).toBe('candidate');
    expect(gitStatusEntries(r)).toEqual([]);
    // recovery 绝不复用 allowed-once；此处显式模拟新的上层审批后重新调用。
    await expect(adopt(r, 'object', 'pend_crash')).resolves.toMatchObject({ toStatus: 'canonical' });
    expect(readFrontmatter(r, 'world/objects/pend_crash.md').status).toBe('canonical');
  });

  it('审批前 prepare 后候选被编辑，execute 使用冻结基线冲突且零覆盖(N32)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/frozen.md', { id: 'frozen', kind: 'character', name: '原候选', status: 'candidate' }, '原正文');
    commitAll(r);
    const prepared = prepareAdopt(r, 'object', 'frozen');
    writeAsset(r, 'world/pending/frozen.md', { id: 'frozen', kind: 'character', name: '审批窗口编辑', status: 'candidate' }, '新正文');
    await expect(executePreparedAdopt(prepared)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readBody(r, 'world/pending/frozen.md')).toBe('新正文');
    expect(fs.existsSync(path.join(r, 'world/objects/frozen.md'))).toBe(false);
  });

  it('object adopt 不覆盖同 slug canonical，要求 merge/attach_alias(N32)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/collision.md', { id: 'collision', kind: 'character', name: '候选', status: 'candidate' }, '候选正文');
    writeAsset(r, 'world/objects/collision.md', { id: 'collision', kind: 'character', name: '既有', status: 'canonical' }, '既有正文');
    commitAll(r);
    await expect(adopt(r, 'object', 'world/pending/collision.md')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readBody(r, 'world/objects/collision.md')).toBe('既有正文');
    expect(readBody(r, 'world/pending/collision.md')).toBe('候选正文');
  });

  it('adopts object: pending → objects, status canonical, content_hash updated (R3)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate' }, '红衣女子正文');
    commitAll(r);
    const res = await adopt(r, 'object', 'pend_red');
    expect(res.toStatus).toBe('canonical');
    expect(res.targetRelPath).toBe('world/objects/pend_red.md');
    expect(fs.existsSync(path.join(r, 'world/objects/pend_red.md'))).toBe(true);
    expect(fs.existsSync(path.join(r, 'world/pending/pend_red.md'))).toBe(false);
    const fm = readFrontmatter(r, 'world/objects/pend_red.md');
    expect(fm.status).toBe('canonical');
    expect(fm.content_hash).toBe(contentHash('红衣女子正文'));
  });

  it('rejects illegal transition: canonical object cannot re-adopt (R3)', async () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_klein.md', { id: 'obj_klein', kind: 'character', name: '克莱恩', status: 'canonical' }, '正文');
    commitAll(r);
    await expect(adopt(r, 'object', 'obj_klein')).rejects.toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });

  it('rejects stale adopt when expectedContentHash mismatches (R8 CAS)', async () => {
    const r = fixture();
    const body = '红衣女子正文';
    writeAsset(r, 'world/pending/pend_red.md', { id: 'pend_red', kind: 'character', name: '红衣女子', status: 'candidate', content_hash: contentHash(body) }, body);
    commitAll(r);
    await expect(adopt(r, 'object', 'pend_red', { expectedContentHash: contentHash('different') })).rejects.toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('expectedContentHash 提供但当前 content_hash 缺失 → CONFLICT fail-closed (R8)', async () => {
    const r = fixture();
    const body = '正文';
    // 无 content_hash 字段的候选: 旧行为 fail-open 放行。
    writeAsset(r, 'world/pending/pend_no_hash.md', { id: 'pend_no_hash', kind: 'character', name: '无哈希', status: 'candidate' }, body);
    commitAll(r);
    await expect(adopt(r, 'object', 'pend_no_hash', { expectedContentHash: contentHash(body) })).rejects.toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    await expect(adopt(r, 'object', 'pend_no_hash', { expectedContentHash: '' })).rejects.toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    // 无 expectedContentHash: 行为不变(不参与 CAS)。
    const res = await adopt(r, 'object', 'pend_no_hash');
    expect(res.toStatus).toBe('canonical');
  });

  it('expectedContentHash 与当前匹配 → 放行(R8 精确匹配)', async () => {
    const r = fixture();
    const body = '正文';
    writeAsset(r, 'world/pending/pend_match.md', { id: 'pend_match', kind: 'character', name: '匹配', status: 'candidate', content_hash: contentHash(body) }, body);
    commitAll(r);
    const res = await adopt(r, 'object', 'pend_match', { expectedContentHash: contentHash(body) });
    expect(res.toStatus).toBe('canonical');
    expect(res.targetRelPath).toBe('world/objects/pend_match.md');
  });
});

describe('copy-on-adopt(R34)', () => {
  it('adopting a candidate chapter overwrites same chapter (M4: 版本=git), deprecates candidate', async () => {
    const r = fixture();
    const body = '候选正文内容';
    writeAsset(r, 'chapters/003.md', { chapter_index: 3, status: 'draft', content_hash: contentHash('旧正文') }, '旧正文');
    writeAsset(r, 'chapters/pending/cand_foo.md', {
      id: 'cand_foo',
      chapter_index: 3,
      status: 'candidate',
      source: 'writing_generate',
      content_hash: contentHash(body),
    }, body);
    commitAll(r);
    const res = await adopt(r, 'chapter_candidate', 'cand_foo');
    expect(res.toStatus).toBe('draft');
    expect(res.targetRelPath).toBe('chapters/003.md');
    // 覆盖同章(R34 M4 语义: 旧版由 git 历史保留)
    expect(readBody(r, 'chapters/003.md')).toBe(body);
    expect(readFrontmatter(r, 'chapters/003.md').status).toBe('draft');
    expect(readFrontmatter(r, 'chapters/003.md').content_hash).toBe(contentHash(body));
    // 原 candidate 转 deprecated(R34)
    expect(readFrontmatter(r, 'chapters/pending/cand_foo.md').status).toBe('deprecated');
  });

  it('rejects candidate without chapter_index (M4 语义: 必须指向目标章)', async () => {
    const r = fixture();
    const body = '候选正文内容';
    writeAsset(r, 'chapters/pending/cand_foo.md', { id: 'cand_foo', status: 'candidate', source: 'writing_generate', content_hash: contentHash(body) }, body);
    commitAll(r);
    await expect(adopt(r, 'chapter_candidate', 'cand_foo')).rejects.toThrow(/chapter_index/);
  });
});

describe('soft delete(R2 · 已采用不硬删)', () => {
  it('soft-deletes canonical object to deprecated without removing the file', async () => {
    const r = fixture();
    writeAsset(r, 'world/objects/obj_klein.md', { id: 'obj_klein', kind: 'character', name: '克莱恩', status: 'canonical' }, '正文');
    commitAll(r);
    const res = await softDelete(r, 'object', 'obj_klein');
    expect(res.status).toBe('deprecated');
    expect(fs.existsSync(path.join(r, 'world/objects/obj_klein.md'))).toBe(true);
    expect(readFrontmatter(r, 'world/objects/obj_klein.md').status).toBe('deprecated');
    // 再删 = no-op(R2)
    expect((await softDelete(r, 'object', 'obj_klein')).status).toBe('noop');
  });
});

describe('建议队列裁决(R4/R32 单赢家)', () => {
  it('confirm then reject → 拒绝(单赢家 CAS claim)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_s.md', { id: 'pend_s', status: 'pending', target_type: 'core_entity' }, 'payload');
    commitAll(r);
    const confirmed = await confirmSuggestion(r, 'pend_s');
    expect(confirmed.toStatus).toBe('accepted');
    expect(readFrontmatter(r, 'world/pending/pend_s.md').status).toBe('accepted');
    await expect(rejectSuggestion(r, 'pend_s')).rejects.toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });
});

describe('R7 · 世界书发布 CAS + version+1', () => {
  it('publishes a bible draft to canonical with version bump', async () => {
    const r = fixture();
    writeAsset(r, 'bible/species_elf.md', {
      id: 'species_elf', status: 'draft', page_type: 'species', page_key: 'species_elf', title: '精灵', version_number: 0,
    }, '精灵设定');
    commitAll(r);
    const res = await adopt(r, 'bible_page', 'species_elf');
    expect(res.toStatus).toBe('canonical');
    expect(readFrontmatter(r, 'bible/species_elf.md').version_number).toBe(1);
  });

  it('rejects publish when base_version mismatches (R7)', async () => {
    const r = fixture();
    writeAsset(r, 'bible/species_elf.md', {
      id: 'species_elf', status: 'draft', page_type: 'species', page_key: 'species_elf', title: '精灵', version_number: 0,
    }, '精灵设定');
    commitAll(r);
    await expect(adopt(r, 'bible_page', 'species_elf', { expectedBaseVersion: 5 })).rejects.toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });
});

describe('R9 · 路径穿越拒绝', () => {
  it('resolveWithin rejects paths escaping the vault root', async () => {
    const r = fixture();
    expect(() => resolveWithin(r, '../evil.md')).toThrowError(
      expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
    );
    await expect(adopt(r, 'object', '../../evil.md')).rejects.toThrowError(StoreError);
  });
});

describe('R9 · chapter_candidate 裸 slug symlink adopt 回归(复现: pending/003 → chapters/007)', () => {
  it.skipIf(!fileSymlinksSupported)(
    'adopt 前解析 fail-closed: PATH_TRAVERSAL, 第 7 章字节与 commit 数不变',
    async () => {
      const r = fixture();
      // 真实第 7 章 + 真实候选(先各自提交), 再把候选替换为指向 chapters/007.md
      // 的 symlink 并提交(复现「已提交 pending/003 symlink→chapters/007」)。
      const chapter7 = path.join(r, 'chapters', '007.md');
      writeAsset(r, 'chapters/007.md', { chapter_index: 7, status: 'published', content_hash: contentHash('七') }, '第七章正文');
      commitAll(r);
      const pendingFile = path.join(r, 'chapters', 'pending', '003.md');
      writeAsset(r, 'chapters/pending/003.md', {
        id: '003', chapter_index: 7, status: 'candidate', source: 'writing_generate', content_hash: contentHash('候选正文'),
      }, '候选正文');
      commitAll(r);
      fs.rmSync(pendingFile, { force: true });
      fs.symlinkSync(chapter7, pendingFile);
      commitAll(r, 'fixture: pending/003 symlink -> chapters/007');

      const before = fs.readFileSync(chapter7, 'utf8');
      const commitsBefore = gitLogSubjects(r).length;
      // 修复前: resolveAsset 放行(real containment 在 vault 内), adopt 会把
      // draft 与 deprecated 两次落盘都经 symlink 写进第 7 章。修复后: 解析即拒绝。
      await expect(adopt(r, 'chapter_candidate', '003')).rejects.toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(fs.readFileSync(chapter7, 'utf8')).toBe(before); // 目标字节不变。
      expect(gitLogSubjects(r).length).toBe(commitsBefore); // 无新 commit。
      // 候选文件仍是 symlink(未被改写/解链)。
      expect(fs.lstatSync(pendingFile).isSymbolicLink()).toBe(true);
    },
  );
});

describe('R9 · adopt 落盘目标 symlink 拒绝(审批后不得写穿 calibration/别章)', () => {
  it.skipIf(!fileSymlinksSupported)(
    'copy-on-adopt 目标章 chapters/007.md symlink→calibration: 写前 PATH_TRAVERSAL, 源/错误目标字节与 commit 不变',
    async () => {
      const r = fixture();
      const body = '候选正文内容';
      writeAsset(r, 'chapters/pending/cand_foo.md', {
        id: 'cand_foo', chapter_index: 7, status: 'candidate', source: 'writing_generate', content_hash: contentHash(body),
      }, body);
      // 目标章不存在真实文件, 预置 chapters/007.md symlink → .assistant/calibration.md
      // (vault 内内部 symlink, guardPath 的 real containment 放行)并提交。
      writeAsset(r, '.assistant/calibration.md', { key: 'k', value: 'v' }, '校准哨兵正文');
      commitAll(r);
      const calFile = path.join(r, '.assistant', 'calibration.md');
      const target = path.join(r, 'chapters', '007.md');
      fs.symlinkSync(calFile, target);
      commitAll(r, 'fixture: chapters/007.md symlink -> calibration');

      const calBefore = fs.readFileSync(calFile, 'utf8');
      const srcBefore = fs.readFileSync(path.join(r, 'chapters', 'pending', 'cand_foo.md'), 'utf8');
      const commitsBefore = gitLogSubjects(r).length;
      // 修复前: 目标经 resolveWithin 放行, writeFileSync 跟随 symlink 把 draft 写进
      // calibration。修复后: 任何写前 assertNoInternalSymlink 拒绝。
      await expect(adopt(r, 'chapter_candidate', 'cand_foo')).rejects.toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(fs.readFileSync(calFile, 'utf8')).toBe(calBefore); // 错误目标未写穿。
      expect(fs.readFileSync(path.join(r, 'chapters', 'pending', 'cand_foo.md'), 'utf8')).toBe(srcBefore); // 源候选未改写。
      expect(gitLogSubjects(r).length).toBe(commitsBefore); // 无新 commit。
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    'object adopt 移入目标 world/objects/x.md symlink→bible: 写前 PATH_TRAVERSAL, 源/错误目标字节与 commit 不变',
    async () => {
      const r = fixture();
      // 显式 ref 指定 pending 源; 裸 slug 时 object 分支会在解析期拒绝 objects 内
      // symlink, 显式 ref 的移入目标由 adopt 派生, 必须由写前 gate 兜住。
      writeAsset(r, 'world/pending/pend_t.md', { id: 'pend_t', kind: 'character', name: 'T', status: 'candidate' }, '候选正文');
      writeAsset(r, 'bible/secret.md', { id: 'secret', page_key: 'secret', version_number: 0, status: 'draft' }, 'bible 哨兵正文');
      commitAll(r);
      const target = path.join(r, 'world', 'objects', 'pend_t.md');
      fs.symlinkSync(path.join(r, 'bible', 'secret.md'), target); // 移入目标为内部 symlink。
      commitAll(r, 'fixture: world/objects/pend_t.md symlink -> bible/secret');

      const bibleBefore = fs.readFileSync(path.join(r, 'bible', 'secret.md'), 'utf8');
      const srcBefore = fs.readFileSync(path.join(r, 'world', 'pending', 'pend_t.md'), 'utf8');
      const commitsBefore = gitLogSubjects(r).length;
      await expect(adopt(r, 'object', 'world/pending/pend_t.md')).rejects.toThrowError(
        expect.objectContaining({ code: 'PATH_TRAVERSAL' }),
      );
      expect(fs.readFileSync(path.join(r, 'bible', 'secret.md'), 'utf8')).toBe(bibleBefore); // 错误目标未写穿。
      expect(fs.readFileSync(path.join(r, 'world', 'pending', 'pend_t.md'), 'utf8')).toBe(srcBefore); // 源候选未改写/未删除。
      expect(gitLogSubjects(r).length).toBe(commitsBefore); // 无新 commit。
    },
  );
});

describe('N12 · 结构资产 adopt(draft→canonical, 目录化路径)', () => {
  it('adopts a structure/threads/<slug>.md draft to canonical in place', async () => {
    const r = fixture();
    writeAsset(r, 'structure/threads/t1.md', { id: 't1', status: 'draft', name: '主线', thread_type: 'main' }, '');
    commitAll(r);
    const res = await adopt(r, 'thread', 't1');
    expect(res.toStatus).toBe('canonical');
    expect(res.targetRelPath).toBe('structure/threads/t1.md');
    expect(readFrontmatter(r, 'structure/threads/t1.md').status).toBe('canonical');
  });

  it('soft-deletes a canonical structure asset to deprecated (R2)', async () => {
    const r = fixture();
    writeAsset(r, 'structure/arcs/a1.md', { id: 'a1', status: 'canonical', title: '第一卷' }, '');
    commitAll(r);
    expect((await softDelete(r, 'arc', 'a1')).status).toBe('deprecated');
    expect(readFrontmatter(r, 'structure/arcs/a1.md').status).toBe('deprecated');
  });
});

describe('N23 · validateFrontmatter 接入 adopt 写链(落盘前 fail-closed)', () => {
  it('rejects schema-nonconforming object adopt: VALIDATION_FAILED, 文件未移动、无 commit', async () => {
    const r = fixture();
    // 缺必填 name(object schema: id/kind/name/status), 其余门禁全过
    writeAsset(r, 'world/pending/pend_x.md', { id: 'pend_x', kind: 'character', status: 'candidate' }, '正文');
    commitAll(r);
    const headBefore = gitLogSubjects(r).length;
    let failure: StoreError | null = null;
    try {
      await adopt(r, 'object', 'pend_x');
    } catch (err) {
      failure = err as StoreError;
    }
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe('VALIDATION_FAILED'); // N23
    expect((failure!.details as unknown[]).length).toBeGreaterThan(0); // issues 明细随抛
    // 文件未移动、源文件未被改写、无 commit 产生(无部分状态, N23)
    expect(fs.existsSync(path.join(r, 'world/pending/pend_x.md'))).toBe(true);
    expect(fs.existsSync(path.join(r, 'world/objects/pend_x.md'))).toBe(false);
    expect(readFrontmatter(r, 'world/pending/pend_x.md').status).toBe('candidate');
    expect(gitLogSubjects(r).length).toBe(headBefore);
  });

  it('rejects schema-nonconforming chapter_candidate adopt: 目标章未落盘、无 commit', async () => {
    const r = fixture();
    // chapter_index 为字符串: 通过 BAD_CANDIDATE 数值化, 但 chapter schema 要求 integer
    writeAsset(r, 'chapters/pending/cand_x.md', {
      id: 'cand_x', chapter_index: '3', status: 'candidate', source: 'writing_generate', content_hash: contentHash('正文'),
    }, '正文');
    commitAll(r);
    const headBefore = gitLogSubjects(r).length;
    await expect(adopt(r, 'chapter_candidate', 'cand_x')).rejects.toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }), // N23
    );
    // 无部分状态: 目标章未创建、候选未改写、无 commit
    expect(fs.existsSync(path.join(r, 'chapters/003.md'))).toBe(false);
    expect(readFrontmatter(r, 'chapters/pending/cand_x.md').status).toBe('candidate');
    expect(gitLogSubjects(r).length).toBe(headBefore);
  });

  it('合规 adopt 行为不变; 缺 id 时确定性补 id=目标 slug(N2/B3)', async () => {
    const r = fixture();
    writeAsset(r, 'world/pending/pend_y.md', { kind: 'character', name: '红衣女子', status: 'candidate' }, '正文');
    commitAll(r);
    const res = await adopt(r, 'object', 'pend_y');
    expect(res.toStatus).toBe('canonical');
    const fm = readFrontmatter(r, 'world/objects/pend_y.md');
    expect(fm.id).toBe('pend_y'); // N23: 校验前确定性补 id=slug
    expect(fm.status).toBe('canonical');
    expect(fm.name).toBe('红衣女子');
  });
});
