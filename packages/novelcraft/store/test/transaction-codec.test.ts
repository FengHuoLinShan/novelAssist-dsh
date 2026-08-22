// ============================================================================
// ADR-0021(N32) 事务类型/规范化层单元测试(标准收集路径 test/, 零 IO)。
//
// 断言注释引裁定/条款编号: N32(2026-08-15 第八批裁定)、ADR-0021 §1/§2/§4/§5/§6/
// §7/§8; vitest 行为契约(AGENTS.md 测试约定)。
//
// 审计覆盖(transaction types/codec review):
//   - 未知字段 fail-closed: top/expected/target/preSnapshot 嵌套未知字段一律
//     TX_UNKNOWN_FIELD; 未知 target kind 不降级(TX_INVALID_TARGET_KIND);
//   - 拒 accessor/Proxy/non-plain JSON(TX_NON_PLAIN_OBJECT);
//   - 路径拒任意大小写 `.git` 段; ref 必须完整 refs/heads/*(拒 one-level/.lock/dot);
//   - txid = canonical tx-64 小写 hex; Git OID 支持 40(SHA-1)/64(SHA-256);
//   - plan 显式 exactTree + fullWriteSet/actualWriteSet(actual = full 有序子集,
//     空 = no-op), digest 覆盖 base+exactTree+full+actual; preSnapshot 与 full 一致;
//   - bytes 目标 mode/blob 身份(缺省 100644; blob 40/64 hex)。
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  assertTxId,
  buildIntent,
  buildPlan,
  buildResult,
  buildStatus,
  canonicalJson,
  cmpPath,
  computePlanDigest,
  deserializeIntent,
  isIndexEntryState,
  isPlainRecord,
  isRelPath,
  isSha256,
  isTransactionKind,
  isTxId,
  isWorktreeState,
  normalizeExpectedState,
  normalizeFileMode,
  normalizeGitObjectId,
  normalizeHeadRef,
  normalizeIndexEntries,
  normalizePreSnapshot,
  normalizeRef,
  normalizeRelPath,
  normalizeSha256,
  normalizeWorktreeEntries,
  normalizeWriteTarget,
  normalizeWriteTargets,
  serializeIntent,
  verifyIntent,
  verifyPlan,
  verifyPlanDigest,
} from '../src/transaction/codec.js';
import { StoreError, type StoreErrorCode } from '../src/errors.js';
import type { WriteTarget } from '../src/transaction/types.js';
import { sha256Hex } from '../src/hash.js';

const enc = new TextEncoder();

/** 断言 fn 抛出 code 为 expectCode 的 StoreError。 */
function expectCode(fn: () => unknown, expectCode: StoreErrorCode): StoreError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StoreError);
    const e = err as StoreError;
    expect(e.code).toBe(expectCode);
    return e;
  }
  throw new Error(`expected StoreError(${expectCode}) but no error thrown`);
}

// canonical tx-64 小写 hex: `tx-` + 64 位 hex(审计: 统一 txid 形态)。
const TXID = 'tx-' + '6f3a9c1d2b8e4a07'.repeat(4);
const VAULT = '/Users/example/books/my-novel';
const REF = 'refs/heads/main';
const BASE_HEAD = 'a'.repeat(40); // SHA-1 commit
const EXACT_TREE = 'c'.repeat(40); // SHA-1 tree
const BLOB_40 = 'b'.repeat(40); // SHA-1 blob
const BLOB_64 = 'd'.repeat(64); // SHA-256 blob
const CONTENT = 'hello'; // sha256('hello') = 2cf24dba…
const CONTENT_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function bytesTargetInput(
  path: string,
  bytes = CONTENT,
  expected = { kind: 'absent' as const },
  opts: { mode?: string; blob?: string } = {},
) {
  return { kind: 'bytes' as const, path, bytes: enc.encode(bytes), expected, mode: opts.mode, blob: opts.blob ?? BLOB_40 };
}

function snapFor(paths: string[]): Array<{ path: string; state: { kind: 'absent' } }> {
  return paths.map((path) => ({ path, state: { kind: 'absent' } }));
}

/** 已归一 bytes 目标(输出 hash/长度/mode/blob 全部显式)。 */
function normalizedBytesTarget(path: string, blob: string = BLOB_40): Extract<WriteTarget, { kind: 'bytes' }> {
  return {
    kind: 'bytes',
    path,
    expected: { kind: 'absent' },
    outputSha256: CONTENT_SHA,
    outputByteLength: CONTENT.length,
    mode: '100644',
    blob,
  };
}

// ----------------------------------------------------------------------------
// 严格相对 POSIX 路径(ADR-0021 §8/N32; 审计: 任意大小写 .git 段)
// ----------------------------------------------------------------------------

describe('normalizeRelPath (ADR-0021 §8 严格相对 POSIX 路径)', () => {
  it('accepts canonical relative POSIX paths (N32 path allowlist)', () => {
    for (const p of [
      'world/objects/obj_klein.md',
      '.assistant/checkpoint.json', // 隐藏段(非 `.`/`..`/`.git`)合法
      'chapters/001.md',
      'world/pending/我的 笔记.md', // CJK + 空格文件名合法
      'a/b/c.md',
      'structure/threads/t_one.md',
    ]) {
      expect(normalizeRelPath(p)).toBe(p);
      expect(isRelPath(p)).toBe(true);
    }
  });

  it('rejects empty path (TX_PATH_EMPTY)', () => {
    expectCode(() => normalizeRelPath(''), 'TX_PATH_EMPTY');
    expect(isRelPath('')).toBe(false);
  });

  it.each([
    ['/etc/passwd', '绝对路径(首字符 /)'],
    ['//server/share', '绝对路径'],
    ['C:/windows/evil.md', 'Windows 盘符'],
    ['C:\\windows\\evil.md', 'Windows 盘符'],
    ['\\\\server\\share\\evil.md', 'UNC 路径'],
  ])('rejects absolute path %j → TX_PATH_ABSOLUTE (%s)', (p) => {
    expectCode(() => normalizeRelPath(p), 'TX_PATH_ABSOLUTE');
    expect(isRelPath(p)).toBe(false);
  });

  it.each([
    ['../world/objects/evil.md'],
    ['a/../b.md'],
    ['a/..'],
    ['./x.md'],
    ['a/./b.md'],
  ])('rejects traversal segment %j → TX_PATH_TRAVERSAL (N32: 拒绝 .. 逃逸)', (p) => {
    expectCode(() => normalizeRelPath(p), 'TX_PATH_TRAVERSAL');
    expect(isRelPath(p)).toBe(false);
  });

  it.each([
    ['a//b.md', '空段(重复斜杠)'],
    ['a/b/', '尾斜杠 → 空段'],
    ['a\\b.md', '反斜杠非 POSIX'],
    ['a\nb.md', '控制字符'],
    ['a\u0000b.md', 'NUL'],
  ])('rejects malformed segment %j → TX_PATH_SEGMENT (%s)', (p) => {
    expectCode(() => normalizeRelPath(p), 'TX_PATH_SEGMENT');
    expect(isRelPath(p)).toBe(false);
  });

  // 审计: 路径拒任何大小写 .git 段(保留 git 内部区, 大小写不敏感)。
  it.each([
    ['.git/config'],
    ['.GIT/config'],
    ['world/.git/config'],
    ['a/.Git/b.md'],
    ['a/.gIt/x'],
  ])('rejects .git segment in any case %j → TX_PATH_SEGMENT (审计)', (p) => {
    expectCode(() => normalizeRelPath(p), 'TX_PATH_SEGMENT');
    expect(isRelPath(p)).toBe(false);
  });

  it('rejects non-string input → TX_PATH_SEGMENT', () => {
    expectCode(() => normalizeRelPath(42 as unknown as string), 'TX_PATH_SEGMENT');
  });
});

// ----------------------------------------------------------------------------
// git ref(审计: 必须完整 refs/heads/*, check-ref-format 等价规则)
// ----------------------------------------------------------------------------

describe('normalizeRef / normalizeHeadRef (ADR-0021 §1/§8 + 审计 refs/heads/*)', () => {
  it('accepts complete refs/heads/* refs (含子分支与合法特殊字符)', () => {
    expect(normalizeRef('refs/heads/main')).toBe('refs/heads/main');
    expect(normalizeRef('refs/heads/MAIN')).toBe('refs/heads/MAIN'); // check-ref-format 允许大写
    expect(normalizeRef('refs/heads/feature/foo')).toBe('refs/heads/feature/foo');
    expect(normalizeRef('refs/heads/v1.0')).toBe('refs/heads/v1.0');
  });

  // 审计: 拒 one-level / 其它命名空间 / 绝对形态。
  it.each([
    ['main', 'one-level ref'],
    ['refs/tags/v1.0', '非 refs/heads 命名空间'],
    ['refs/remotes/origin/main', '非 refs/heads 命名空间'],
    ['/refs/heads/main', '绝对形态'],
    ['refs/heads/', '分支名为空'],
    ['refs/heads//x', '空段'],
    ['refs/heads/x/', '尾斜杠'],
  ])('rejects non-refs/heads/* ref %j → TX_INVALID_REF (%s)', (r) => {
    expectCode(() => normalizeRef(r), 'TX_INVALID_REF');
  });

  // 审计: check-ref-format 等价规则(禁用字符/.. /@{/点段/.lock)。
  it.each([
    ['refs/heads/a..b', '连续两点 ..'],
    ['refs/heads/..', '.. 段'],
    ['refs/heads/x.lock', '.lock 后缀'],
    ['refs/heads/a/b.lock', '子段 .lock'],
    ['refs/heads/.hidden', 'dot 段'],
    ['refs/heads/a.', '以 . 结尾'],
    ['refs/heads/@{', '@{ 序列'],
    ['@', '裸 @'],
    ['refs/heads/a b', '空格'],
    ['refs/heads/a~b', '~'],
    ['refs/heads/a^b', '^'],
    ['refs/heads/a:b', ':'],
    ['refs/heads/a?b', '?'],
    ['refs/heads/a*b', '*'],
    ['refs/heads/a[b', '['],
    ['refs/heads/a\\b', '反斜杠'],
    ['refs/heads/a\u0000b', 'NUL 控制字符'],
    ['refs/heads/a\nb', '换行控制字符'],
    ['refs/heads/a b', '空格'],
  ])('rejects check-ref-format violation %j → TX_INVALID_REF (%s)', (r) => {
    expectCode(() => normalizeRef(r), 'TX_INVALID_REF');
  });

  it('normalizeHeadRef accepts commit id (40/64) or complete refs/heads/* ref', () => {
    expect(normalizeHeadRef('A'.repeat(40))).toBe('a'.repeat(40));
    expect(normalizeHeadRef('B'.repeat(64).toUpperCase())).toBe('b'.repeat(64));
    expect(normalizeHeadRef('refs/heads/main')).toBe('refs/heads/main');
    // 审计: one-level ref 不再被接受为 HEAD 引用。
    expectCode(() => normalizeHeadRef('main'), 'TX_INVALID_REF');
  });
});

// ----------------------------------------------------------------------------
// 哈希归一(SHA-1/SHA-256 支持; 内容 SHA-256 = 64)
// ----------------------------------------------------------------------------

describe('normalizeSha256 / normalizeGitObjectId / normalizeFileMode (SHA-1/SHA-256, N32)', () => {
  it('normalizes 64-hex to lowercase and strips sha256: prefix', () => {
    expect(normalizeSha256(CONTENT_SHA)).toBe(CONTENT_SHA);
    expect(normalizeSha256(CONTENT_SHA.toUpperCase())).toBe(CONTENT_SHA);
    expect(normalizeSha256(`sha256:${CONTENT_SHA}`)).toBe(CONTENT_SHA);
    expect(isSha256(CONTENT_SHA)).toBe(true);
  });

  it.each([
    ['', '空'],
    [CONTENT_SHA.slice(0, 63), '63 位'],
    ['zz'.repeat(32), '非 hex'],
    [CONTENT_SHA + 'a', '65 位'],
  ])('rejects invalid SHA-256 %j → TX_INVALID_SHA256', (h) => {
    expectCode(() => normalizeSha256(h), 'TX_INVALID_SHA256');
    expect(isSha256(h)).toBe(false);
  });

  it('git object id: 40 (SHA-1) or 64 (SHA-256) hex ok, else TX_INVALID_OBJECT_ID (审计)', () => {
    expect(normalizeGitObjectId(BASE_HEAD)).toBe(BASE_HEAD);
    expect(normalizeGitObjectId(BASE_HEAD.toUpperCase())).toBe(BASE_HEAD);
    expect(normalizeGitObjectId(BLOB_64.toUpperCase())).toBe(BLOB_64);
    expectCode(() => normalizeGitObjectId('zz'), 'TX_INVALID_OBJECT_ID');
    expectCode(() => normalizeGitObjectId('a'.repeat(41)), 'TX_INVALID_OBJECT_ID');
    expectCode(() => normalizeGitObjectId('a'.repeat(63)), 'TX_INVALID_OBJECT_ID');
    expectCode(() => normalizeGitObjectId('a'.repeat(65)), 'TX_INVALID_OBJECT_ID');
  });

  it('file mode: default 100644, allowlist 100644/100755/120000 (审计 mode 身份)', () => {
    expect(normalizeFileMode(undefined)).toBe('100644');
    expect(normalizeFileMode('100755')).toBe('100755');
    expect(normalizeFileMode('120000')).toBe('120000');
    expectCode(() => normalizeFileMode('100777'), 'TX_INVALID_MODE');
    expectCode(() => normalizeFileMode(100644), 'TX_INVALID_MODE');
  });
});

// ----------------------------------------------------------------------------
// plain JSON 对象门禁(审计: 拒 accessor/Proxy/non-plain)
// ----------------------------------------------------------------------------

describe('plain JSON 门禁(审计: 拒 accessor/Proxy/non-plain)', () => {
  it('isPlainRecord: plain object true; Proxy/class/accessor false', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord(new Proxy({}, {}))).toBe(false);
    expect(isPlainRecord(Object.create({ kind: 'absent' }))).toBe(false); // 非 Object.prototype 原型
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'absent' });
    expect(isPlainRecord(accessor)).toBe(false);
  });

  it('normalizeExpectedState rejects Proxy/accessor/non-plain → TX_NON_PLAIN_OBJECT', () => {
    const state = { kind: 'absent' };
    expectCode(() => normalizeExpectedState(new Proxy(state, {})), 'TX_NON_PLAIN_OBJECT');
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'absent' });
    expectCode(() => normalizeExpectedState(accessor), 'TX_NON_PLAIN_OBJECT');
    expectCode(() => normalizeExpectedState(Object.create({ kind: 'absent' })), 'TX_NON_PLAIN_OBJECT');
  });

  it('normalizeWriteTarget rejects Proxy target → TX_NON_PLAIN_OBJECT', () => {
    const target = bytesTargetInput('a.md');
    expectCode(() => normalizeWriteTarget(new Proxy(target, {})), 'TX_NON_PLAIN_OBJECT');
  });

  it('verifyPlan / verifyIntent reject Proxy envelope → TX_NON_PLAIN_OBJECT', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan(new Proxy(p, {})), 'TX_NON_PLAIN_OBJECT');
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent(new Proxy(intent, {})), 'TX_NON_PLAIN_OBJECT');
  });
});

// ----------------------------------------------------------------------------
// ExpectedState present/absent(ADR-0021 §1/§4; 审计: 未知字段 fail-closed)
// ----------------------------------------------------------------------------

describe('ExpectedState (ADR-0021 §1/§4)', () => {
  it('normalizes present/absent', () => {
    expect(normalizeExpectedState({ kind: 'absent' })).toEqual({ kind: 'absent' });
    expect(normalizeExpectedState({ kind: 'present', contentSha256: CONTENT_SHA.toUpperCase() })).toEqual({
      kind: 'present',
      contentSha256: CONTENT_SHA,
    });
  });

  it('normalizes optional baseRef/baseBlob on present (ADR-0021 §1 HEAD/blob)', () => {
    expect(
      normalizeExpectedState({
        kind: 'present',
        contentSha256: CONTENT_SHA,
        baseRef: 'A'.repeat(40),
        baseBlob: 'b'.repeat(40).toUpperCase(),
      }),
    ).toEqual({ kind: 'present', contentSha256: CONTENT_SHA, baseRef: 'a'.repeat(40), baseBlob: 'b'.repeat(40) });
  });

  it('rejects unknown kind / missing hash / invalid hash → TX_INVALID_EXPECTED_STATE', () => {
    expectCode(() => normalizeExpectedState({ kind: 'maybe' }), 'TX_INVALID_EXPECTED_STATE');
    expectCode(() => normalizeExpectedState({ kind: 'present' }), 'TX_INVALID_EXPECTED_STATE');
    expectCode(() => normalizeExpectedState({ kind: 'present', contentSha256: 'nope' }), 'TX_INVALID_SHA256');
  });

  it('rejects non-object expected (null/数组) → TX_NON_PLAIN_OBJECT (审计)', () => {
    expectCode(() => normalizeExpectedState(null), 'TX_NON_PLAIN_OBJECT');
    expectCode(() => normalizeExpectedState([{ kind: 'absent' }]), 'TX_NON_PLAIN_OBJECT');
  });

  // 审计: expected 嵌套未知字段严格 fail-closed。
  it('rejects unknown fields in expected state → TX_UNKNOWN_FIELD (审计)', () => {
    expectCode(() => normalizeExpectedState({ kind: 'absent', extra: 1 }), 'TX_UNKNOWN_FIELD');
    expectCode(() => normalizeExpectedState({ kind: 'present', contentSha256: CONTENT_SHA, extra: 1 }), 'TX_UNKNOWN_FIELD');
    expectCode(() => normalizeExpectedState({ kind: 'present', contentSha256: CONTENT_SHA, baseHead: EXACT_TREE }), 'TX_UNKNOWN_FIELD');
  });
});

// ----------------------------------------------------------------------------
// WriteTarget bytes/delete(ADR-0021 §1; 审计: 未知 kind 不降级, mode/blob 身份)
// ----------------------------------------------------------------------------

describe('WriteTarget bytes/delete (ADR-0021 §1)', () => {
  it('bytes target: computes outputSha256 + outputByteLength, mode default 100644, blob identity kept (审计)', () => {
    const out = normalizeWriteTargets([bytesTargetInput('world/objects/obj_klein.md')]);
    expect(out).toEqual([
      {
        kind: 'bytes',
        path: 'world/objects/obj_klein.md',
        expected: { kind: 'absent' },
        outputSha256: CONTENT_SHA, // sha256('hello') 已知向量
        outputByteLength: 5,
        mode: '100644',
        blob: BLOB_40,
      },
    ]);
  });

  it('explicit mode/blob: 100755 and 64-hex (SHA-256) blob accepted (审计 SHA1/SHA256)', () => {
    const out = normalizeWriteTargets([bytesTargetInput('a.md', CONTENT, { kind: 'absent' }, { mode: '100755', blob: BLOB_64.toUpperCase() })]);
    expect(out[0].mode).toBe('100755');
    expect(out[0].blob).toBe(BLOB_64);
  });

  it('invalid mode → TX_INVALID_MODE; invalid/missing blob → TX_INVALID_OBJECT_ID/TX_INTENT_INVALID (审计)', () => {
    expectCode(() => normalizeWriteTargets([bytesTargetInput('a.md', CONTENT, { kind: 'absent' }, { mode: '100777' })]), 'TX_INVALID_MODE');
    expectCode(() => normalizeWriteTargets([bytesTargetInput('a.md', CONTENT, { kind: 'absent' }, { blob: 'zz' })]), 'TX_INVALID_OBJECT_ID');
    expectCode(
      () => normalizeWriteTargets([{ kind: 'bytes', path: 'a.md', bytes: enc.encode(CONTENT), expected: { kind: 'absent' } }]),
      'TX_INTENT_INVALID',
    );
  });

  it('re-validates already-normalized bytes input (含 mode/blob)', () => {
    const normalized = normalizedBytesTarget('a.md');
    expect(normalizeWriteTargets([normalized])).toEqual([normalized]);
    // 篡改 hash/长度/mode/blob → 拒绝
    expectCode(() => normalizeWriteTargets([{ ...normalized, outputSha256: 'deadbeef' }]), 'TX_INVALID_SHA256');
    expectCode(() => normalizeWriteTargets([{ ...normalized, outputByteLength: -1 }]), 'TX_INVALID_BYTE_LENGTH');
    expectCode(() => normalizeWriteTargets([{ ...normalized, mode: '100777' }]), 'TX_INVALID_MODE');
    expectCode(() => normalizeWriteTargets([{ ...normalized, blob: 'zz' }]), 'TX_INVALID_OBJECT_ID');
  });

  it('delete target keeps expected, path normalized', () => {
    expect(
      normalizeWriteTargets([
        { kind: 'delete', path: 'world/objects/old.md', expected: { kind: 'present', contentSha256: CONTENT_SHA } },
      ]),
    ).toEqual([{ kind: 'delete', path: 'world/objects/old.md', expected: { kind: 'present', contentSha256: CONTENT_SHA } }]);
  });

  // 审计: 未知 target kind 不得降级为 bytes 变体(哪怕携带全套 bytes 字段)。
  it('unknown target kind → TX_INVALID_TARGET_KIND, 不降级 (审计)', () => {
    expectCode(() => normalizeWriteTargets([{ kind: 'bogus', path: 'a.md', expected: { kind: 'absent' } }]), 'TX_INVALID_TARGET_KIND');
    // 携带全套 bytes 字段的未知 kind 也必须拒绝(不得被当作已归一 bytes 目标)。
    expectCode(
      () =>
        normalizeWriteTargets([
          { kind: 'weird', path: 'a.md', expected: { kind: 'absent' }, outputSha256: CONTENT_SHA, outputByteLength: 5, mode: '100644', blob: BLOB_40 },
        ]),
      'TX_INVALID_TARGET_KIND',
    );
    expectCode(() => normalizeWriteTargets([{ kind: 42, path: 'a.md', expected: { kind: 'absent' } }]), 'TX_INVALID_TARGET_KIND');
  });

  // 审计: target 未知字段 fail-closed。
  it('rejects unknown fields in target → TX_UNKNOWN_FIELD (审计)', () => {
    expectCode(() => normalizeWriteTargets([{ ...bytesTargetInput('a.md'), hacker: 1 }]), 'TX_UNKNOWN_FIELD');
    expectCode(
      () =>
        normalizeWriteTargets([{ kind: 'delete', path: 'x.md', expected: { kind: 'absent' }, extra: true }]),
      'TX_UNKNOWN_FIELD',
    );
  });

  it('rejects target with invalid path/hash → TX_PATH_*/TX_INVALID_SHA256', () => {
    expectCode(() => normalizeWriteTargets([bytesTargetInput('../evil.md')]), 'TX_PATH_TRAVERSAL');
    expectCode(
      () => normalizeWriteTargets([{ kind: 'delete', path: 'x.md', expected: { kind: 'present', contentSha256: 'bad' } }]),
      'TX_INVALID_SHA256',
    );
  });
});

describe('normalizeWriteTargets 去重/排序 (ADR-0021 §1/§4)', () => {
  it('sorts writeSet by path (deterministic)', () => {
    const out = normalizeWriteTargets([bytesTargetInput('b.md'), bytesTargetInput('a.md', 'alpha')]);
    expect(out.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    const first = out[0];
    expect(first.kind).toBe('bytes');
    if (first.kind === 'bytes') {
      expect(first.outputSha256).toBe(sha256Hex('alpha'));
    }
    expect(out).toHaveLength(2);
  });

  it('identical duplicate targets are deduped', () => {
    const out = normalizeWriteTargets([bytesTargetInput('a.md'), bytesTargetInput('a.md')]);
    expect(out).toHaveLength(1);
  });

  it('conflicting duplicate targets (same path, different expected/output) → TX_DUPLICATE_TARGET', () => {
    expectCode(
      () =>
        normalizeWriteTargets([
          bytesTargetInput('a.md', 'one'),
          bytesTargetInput('a.md', 'two'), // 同路径不同输出
        ]),
      'TX_DUPLICATE_TARGET',
    );
    expectCode(
      () =>
        normalizeWriteTargets([
          bytesTargetInput('a.md'),
          { kind: 'delete', path: 'a.md', expected: { kind: 'present', contentSha256: CONTENT_SHA } }, // 同路径不同操作
        ]),
      'TX_DUPLICATE_TARGET',
    );
  });

  it('non-array writeSet → TX_INTENT_INVALID', () => {
    expectCode(() => normalizeWriteTargets('not-array' as never), 'TX_INTENT_INVALID');
  });
});

// ----------------------------------------------------------------------------
// 稳定 JSON canonical 序列化(plan/intent digest 的唯一序列化器)
// ----------------------------------------------------------------------------

describe('canonicalJson (稳定 canonical 序列化)', () => {
  it('sorts object keys recursively, keeps array order, omits undefined', () => {
    expect(
      canonicalJson({
        b: 1,
        a: { z: [1, 2], y: undefined, x: null },
        arr: ['b', 'a'],
      }),
    ).toBe('{"a":{"x":null,"z":[1,2]},"arr":["b","a"],"b":1}');
  });

  it('is equal for semantically equal objects with different insertion order', () => {
    const a = normalizedBytesTarget('x.md');
    const b = { ...a, blob: BLOB_40, mode: '100644' };
    const c = { outputByteLength: 5, outputSha256: CONTENT_SHA, expected: { kind: 'absent' }, path: 'x.md', kind: 'bytes', mode: '100644', blob: BLOB_40 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(canonicalJson(c));
  });

  it('excludes bytes variants from serialization (hash-only wire form)', () => {
    // 已归一形态没有 bytes 属性, canonical 输出只含 hash/长度/mode/blob(N32 计划输出 bytes/blob hashes)。
    const json = canonicalJson(normalizedBytesTarget('a.md'));
    expect(json).not.toContain('bytes":{');
    expect(json).toContain(CONTENT_SHA);
  });
});

// ----------------------------------------------------------------------------
// TransactionPlan + plan digest(ADR-0021 §6: 审计 digest 覆盖 base+exactTree+
// full+actual 全部, no-op 可表达)
// ----------------------------------------------------------------------------

function planInput(actualPaths?: readonly string[]) {
  return {
    txid: TXID,
    kind: 'state' as const,
    ref: REF,
    baseHead: BASE_HEAD,
    exactTree: EXACT_TREE,
    fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')],
    ...(actualPaths !== undefined ? { actualPaths } : {}),
  };
}

describe('TransactionPlan + plan digest (ADR-0021 §6)', () => {
  it('buildPlan computes deterministic digest; plan carries exactTree/full/actual (审计)', () => {
    const p1 = buildPlan(planInput());
    const p2 = buildPlan(planInput());
    expect(p1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p2.digest).toBe(p1.digest);
    expect(p1.version).toBe(1);
    expect(p1.exactTree).toBe(EXACT_TREE);
    expect(p1.fullWriteSet.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    // actual 缺省 = 全部 full
    expect(p1.actualWriteSet.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    // payload 重推导等于 digest
    expect(
      computePlanDigest({
        version: 1,
        txid: p1.txid,
        kind: p1.kind,
        ref: p1.ref,
        baseHead: p1.baseHead,
        exactTree: p1.exactTree,
        fullWriteSet: p1.fullWriteSet,
        actualWriteSet: p1.actualWriteSet,
      }),
    ).toBe(p1.digest);
  });

  it('digest is stable across input order (writeSet 已排序去重)', () => {
    const p1 = buildPlan({ ...planInput(), fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')] });
    const p2 = buildPlan({ ...planInput(), fullWriteSet: [bytesTargetInput('b.md'), bytesTargetInput('a.md')] });
    expect(p2.digest).toBe(p1.digest);
  });

  it('verifyPlan accepts a valid plan; verifyPlanDigest true', () => {
    const p = buildPlan(planInput());
    verifyPlan(p);
    expect(verifyPlanDigest(p)).toBe(true);
  });

  // 审计: digest 必须覆盖 baseHead+exactTree+full+actual 全部。
  it('tampered baseHead/exactTree/full/actual/ref/txid → digest 重推导失败 (审计)', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan({ ...p, ref: 'refs/heads/other' }), 'TX_PLAN_DIGEST_MISMATCH');
    expectCode(() => verifyPlan({ ...p, baseHead: 'e'.repeat(40) }), 'TX_PLAN_DIGEST_MISMATCH');
    expectCode(() => verifyPlan({ ...p, exactTree: 'f'.repeat(40) }), 'TX_PLAN_DIGEST_MISMATCH');
    // 篡改 fullWriteSet 用「已归一目标」注入(原始 bytes 形态会因 Uint8Array 非 JSON 安全被
    // canonical 检查以 TX_INTENT_INVALID 先拒, 那是另一层验证)
    // 注意: 子集检查先于 digest 重推导 → full 被换后 actual 越界 → TX_WRITESET_MISMATCH。
    const tamperedTarget = normalizeWriteTargets([bytesTargetInput('c.md')])[0];
    expectCode(() => verifyPlan({ ...p, fullWriteSet: [tamperedTarget] }), 'TX_WRITESET_MISMATCH');
    expectCode(() => verifyPlan({ ...p, actualWriteSet: [normalizedBytesTarget('c.md')] }), 'TX_WRITESET_MISMATCH');
    expectCode(() => verifyPlan({ ...p, txid: 'tx-' + '0'.repeat(64) }), 'TX_PLAN_DIGEST_MISMATCH');
    expectCode(() => verifyPlan({ ...p, digest: '0'.repeat(64) }), 'TX_PLAN_DIGEST_MISMATCH');
    expect(verifyPlanDigest({ ...p, digest: '0'.repeat(64) })).toBe(false);
  });

  it('actual 必须是 full 的有序子集: 逐项一致, 允许真子集与空集(no-op)(审计)', () => {
    // 真子集: actualPaths=['a.md'] → actual ⊊ full
    const sub = buildPlan(planInput(['a.md']));
    expect(sub.actualWriteSet.map((t) => t.path)).toEqual(['a.md']);
    verifyPlan(sub);
    // 空 actual = no-op 可表达
    const noop = buildPlan(planInput([]));
    expect(noop.actualWriteSet).toEqual([]);
    verifyPlan(noop);
    // full 为空且 actual 为空 = 纯 no-op
    const pure = buildPlan({ ...planInput([]), fullWriteSet: [] });
    expect(pure.fullWriteSet).toEqual([]);
    expect(pure.actualWriteSet).toEqual([]);
    verifyPlan(pure);
    // 相同 full 不同 actual → digest 不同(digest 覆盖 actual)
    expect(sub.digest).not.toBe(noop.digest);
    expect(noop.digest).not.toBe(buildPlan(planInput()).digest);
  });

  // 审计: actualPaths 必须 ⊆ full(有序子集), 否则 fail-closed。
  it('actual 含 full 外路径/重复/非数组 → TX_WRITESET_MISMATCH (审计)', () => {
    expectCode(() => buildPlan(planInput(['x.md'])), 'TX_WRITESET_MISMATCH');
    expectCode(() => buildPlan(planInput(['a.md', 'a.md'])), 'TX_WRITESET_MISMATCH');
    expectCode(() => buildPlan({ ...planInput(), actualPaths: 'a.md' as never }), 'TX_WRITESET_MISMATCH');
    // actualPaths 内非法路径仍走路径门禁
    expectCode(() => buildPlan(planInput(['../evil.md'])), 'TX_PATH_TRAVERSAL');
  });

  it('verifyPlan: actual 目标与 full 不一致(篡改 expected/blob)→ TX_WRITESET_MISMATCH', () => {
    const p = buildPlan(planInput(['a.md']));
    const tampered = p.actualWriteSet.map((t) => ({ ...t, blob: 'e'.repeat(40) }));
    expectCode(() => verifyPlan({ ...p, actualWriteSet: tampered }), 'TX_WRITESET_MISMATCH');
  });

  it('unknown version / non-canonical fields → TX_INTENT_INVALID', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan({ ...p, version: 2 }), 'TX_INTENT_INVALID');
    // baseHead/exactTree 未归一小写 → TX_INTENT_INVALID
    expectCode(() => verifyPlan({ ...p, baseHead: BASE_HEAD.toUpperCase() }), 'TX_INTENT_INVALID');
    expectCode(() => verifyPlan({ ...p, exactTree: EXACT_TREE.toUpperCase() }), 'TX_INTENT_INVALID');
    // 未排序 writeSet → 非 canonical 形态
    const shuffled = normalizeWriteTargets([bytesTargetInput('b.md'), bytesTargetInput('a.md')]).reverse();
    expectCode(() => verifyPlan({ ...p, fullWriteSet: shuffled }), 'TX_INTENT_INVALID');
  });

  // 审计: plan 顶层未知字段 fail-closed。
  it('plan 顶层未知字段 → TX_UNKNOWN_FIELD (审计)', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan({ ...p, hacker: 1 }), 'TX_UNKNOWN_FIELD');
    expectCode(() => buildPlan({ ...planInput(), hacker: 1 } as never), 'TX_UNKNOWN_FIELD');
  });

  it('unknown kind → TX_INVALID_KIND; bad txid → TX_INVALID_TXID (审计: kind 裁定 union / txid canonical)', () => {
    expectCode(() => buildPlan({ ...planInput(), kind: 'adopt' as never }), 'TX_INVALID_KIND');
    expectCode(() => buildPlan({ ...planInput(), kind: 'delete' as never }), 'TX_INVALID_KIND');
    expectCode(() => buildPlan({ ...planInput(), txid: 'BAD TXID!!' }), 'TX_INVALID_TXID');
    expectCode(() => buildPlan({ ...planInput(), txid: 'short' }), 'TX_INVALID_TXID');
  });

  it('TransactionKind 封闭注册表(canonical/checkpoint/state/run_bootstrap, ADR-0021 §8)', () => {
    for (const k of ['canonical', 'checkpoint', 'state', 'run_bootstrap']) expect(isTransactionKind(k)).toBe(true);
    for (const k of ['adopt', 'delete', '', 1]) expect(isTransactionKind(k)).toBe(false);
    // 四种 kind 都能构建 plan
    for (const k of ['canonical', 'checkpoint', 'state', 'run_bootstrap'] as const) {
      const p = buildPlan({ ...planInput(), kind: k });
      expect(p.kind).toBe(k);
    }
  });

  // 审计: txid 统一 canonical tx-64 小写 hex。
  it('txid 必须 canonical tx- + 64 位小写 hex (审计)', () => {
    expect(isTxId(TXID)).toBe(true);
    expect(isTxId('tx-' + 'a'.repeat(64))).toBe(true);
    expect(assertTxId('tx-' + 'a'.repeat(64))).toBe('tx-' + 'a'.repeat(64));
    for (const bad of [
      'tx_' + 'a'.repeat(64), // 下划线分隔符(旧形态)
      'tx-' + 'A'.repeat(64), // 大写 hex
      'tx-' + 'a'.repeat(63), // 63 位
      'tx-' + 'a'.repeat(65), // 65 位
      'tx-' + 'z'.repeat(64), // 非 hex
      'a'.repeat(64), // 无 tx- 前缀
      '-abcdefgh', // 短 slug
      'abcdefgh/i',
      '',
      1,
    ]) {
      expect(isTxId(bad)).toBe(false);
      expectCode(() => assertTxId(bad), 'TX_INVALID_TXID');
    }
  });
});

// ----------------------------------------------------------------------------
// TransactionIntent + recovery 验证(ADR-0021 §8; 审计: preSnapshot 与 full 一致)
// ----------------------------------------------------------------------------

function intentInput(actualPaths?: readonly string[]) {
  return {
    txid: TXID,
    vaultRoot: VAULT,
    kind: 'state' as const,
    ref: REF,
    baseHead: BASE_HEAD,
    exactTree: EXACT_TREE,
    fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')],
    ...(actualPaths !== undefined ? { actualPaths } : {}),
    preSnapshot: snapFor(['a.md', 'b.md']),
    createdAt: '2026-08-15T00:00:00.000Z',
  };
}

describe('TransactionIntent (ADR-0021 §8)', () => {
  it('buildIntent embeds verified plan (exactTree/full/actual) + preSnapshot (全目标快照, §4)', () => {
    const intent = buildIntent(intentInput());
    expect(intent.version).toBe(1);
    expect(intent.cleanup).toBe('pending');
    expect(intent.plan.exactTree).toBe(EXACT_TREE);
    expect(intent.plan.fullWriteSet.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    expect(intent.plan.actualWriteSet.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    expect(intent.preSnapshot.map((e) => e.path)).toEqual(['a.md', 'b.md']);
    verifyIntent(intent); // 自举验证
  });

  it('serialize/deserialize roundtrip is exact (canonical JSON 稳定)', () => {
    const intent = buildIntent(intentInput());
    const json = serializeIntent(intent);
    const parsed = deserializeIntent(json);
    expect(parsed).toEqual(intent);
    expect(serializeIntent(parsed)).toBe(json);
  });

  // 审计: preSnapshot 必须与 fullWriteSet 一致(即使 actual 是真子集)。
  it('preSnapshot 路径集合必须与 fullWriteSet 完全一致(§4, 审计: 不是 actual)', () => {
    expectCode(() => buildIntent({ ...intentInput(), preSnapshot: snapFor(['a.md']) }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), preSnapshot: snapFor(['a.md', 'c.md']) }), 'TX_INTENT_INVALID');
    // actual = ['a.md'] 时 preSnapshot 仍须覆盖 full(['a.md','b.md'])。
    const sub = buildIntent(intentInput(['a.md']));
    expect(sub.plan.actualWriteSet.map((t) => t.path)).toEqual(['a.md']);
    expect(sub.preSnapshot.map((e) => e.path)).toEqual(['a.md', 'b.md']);
    verifyIntent(sub);
  });

  it('tampered plan digest inside intent → TX_PLAN_DIGEST_MISMATCH', () => {
    const intent = buildIntent(intentInput());
    const tampered = { ...intent, plan: { ...intent.plan, digest: '0'.repeat(64) } };
    expectCode(() => verifyIntent(tampered), 'TX_PLAN_DIGEST_MISMATCH');
  });

  it('tampered intent digest → TX_INTENT_DIGEST_MISMATCH; 未归一小写 → TX_INTENT_INVALID', () => {
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent({ ...intent, digest: '0'.repeat(64) }), 'TX_INTENT_DIGEST_MISMATCH');
    expectCode(() => verifyIntent({ ...intent, digest: intent.digest.toUpperCase() }), 'TX_INTENT_INVALID');
  });

  it('header/plan 身份不一致(双源分叉) → TX_INTENT_INVALID', () => {
    const intent = buildIntent(intentInput());
    // 只改头部 ref, plan 保持有效 → 身份检查先于 digest 拒绝
    expectCode(() => verifyIntent({ ...intent, ref: 'refs/heads/other' }), 'TX_INTENT_INVALID');
    expectCode(() => verifyIntent({ ...intent, kind: 'checkpoint' }), 'TX_INTENT_INVALID');
  });

  it('tampered preSnapshot order/content → TX_INTENT_INVALID (非 canonical)', () => {
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent({ ...intent, preSnapshot: [...intent.preSnapshot].reverse() }), 'TX_INTENT_INVALID');
    // 状态 hash 未归一小写 → 重归一 ≠ 存储 → TX_INTENT_INVALID
    const swapped = intent.preSnapshot.map((e) =>
      e.path === 'a.md' ? { ...e, state: { kind: 'present', contentSha256: 'a'.repeat(64).toUpperCase() } } : e,
    );
    expectCode(() => verifyIntent({ ...intent, preSnapshot: swapped }), 'TX_INTENT_INVALID');
    // 篡改为合法但不同的状态 → intent digest 重推导不符
    const changed = intent.preSnapshot.map((e) =>
      e.path === 'a.md' ? { ...e, state: { kind: 'present', contentSha256: '0'.repeat(64) } } : e,
    );
    expectCode(() => verifyIntent({ ...intent, preSnapshot: changed }), 'TX_INTENT_DIGEST_MISMATCH');
  });

  // 审计: intent/preSnapshot 嵌套未知字段 fail-closed。
  it('intent 顶层与 preSnapshot 未知字段 → TX_UNKNOWN_FIELD (审计)', () => {
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent({ ...intent, hacker: 1 }), 'TX_UNKNOWN_FIELD');
    expectCode(() => buildIntent({ ...intentInput(), hacker: 1 } as never), 'TX_UNKNOWN_FIELD');
    expectCode(
      () => normalizePreSnapshot([{ path: 'a.md', state: { kind: 'absent' }, extra: 1 }]),
      'TX_UNKNOWN_FIELD',
    );
    expectCode(
      () => normalizePreSnapshot([{ path: 'a.md', state: { kind: 'absent', extra: 1 } }]),
      'TX_UNKNOWN_FIELD',
    );
    expectCode(
      () => normalizePreSnapshot([{ path: 'a.md', state: { kind: 'present', contentSha256: CONTENT_SHA, extra: 1 } }]),
      'TX_UNKNOWN_FIELD',
    );
  });

  it('unknown schema version / 非法 vaultRoot / 非法 createdAt → TX_INTENT_INVALID', () => {
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent({ ...intent, version: 2 }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), vaultRoot: 'relative/book' }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), createdAt: 'not-a-date' }), 'TX_INTENT_INVALID');
  });

  it('deserializeIntent rejects malformed/non-object JSON → fail-closed', () => {
    expectCode(() => deserializeIntent('{not json'), 'TX_INTENT_INVALID'); // JSON 语法错误
    // 非对象(字符串)信封 → plain 门禁先拒(审计: 拒 non-plain JSON)
    expectCode(() => deserializeIntent('"just a string"'), 'TX_NON_PLAIN_OBJECT');
    // 结构残缺对象 → 细分 code(缺 txid → TX_INVALID_TXID, fail-closed)
    expectCode(() => deserializeIntent('{"version":1}'), 'TX_INVALID_TXID');
  });

  it('vaultRoot 是身份字段(绝对形态), 不参与目标路径规则', () => {
    const intent = buildIntent({ ...intentInput(), vaultRoot: '/srv/vaults/深空' });
    verifyIntent(intent);
  });
});

// ----------------------------------------------------------------------------
// TransactionStatus / TransactionResult(ADR-0021 §7 状态矩阵)
// ----------------------------------------------------------------------------

describe('TransactionStatus / TransactionResult (ADR-0021 §7)', () => {
  const statusInput = () => ({
    txid: TXID,
    kind: 'state' as const,
    phase: 'intent_persisted' as const,
    worktree: [
      { path: 'b.md', state: 'OUTPUT' as const },
      { path: 'a.md', state: 'BEFORE' as const },
    ],
    index: [{ path: 'world/objects/obj_klein.md', state: 'BASE' as const }],
    planDigest: CONTENT_SHA,
    updatedAt: '2026-08-15T00:00:00.000Z',
  });

  it('buildStatus normalizes worktree/index (排序) and computes digest', () => {
    const s = buildStatus(statusInput());
    expect(s.version).toBe(1);
    expect(s.worktree.map((e) => e.path)).toEqual(['a.md', 'b.md']); // 按路径排序
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(isWorktreeState('BEFORE')).toBe(true);
    expect(isIndexEntryState('BASE')).toBe(true);
  });

  it('invalid phase/entry → VALIDATION_FAILED; invalid planDigest → TX_INVALID_SHA256', () => {
    expectCode(() => buildStatus({ ...statusInput(), phase: 'bogus' as never }), 'VALIDATION_FAILED');
    expectCode(
      () => buildStatus({ ...statusInput(), worktree: [{ path: 'a.md', state: 'MIXED' as never }] }),
      'VALIDATION_FAILED',
    );
    expectCode(() => buildStatus({ ...statusInput(), planDigest: 'zz' }), 'TX_INVALID_SHA256');
  });

  it('worktree/index 路径仍走严格相对 POSIX 门禁(含 .git 段)', () => {
    expectCode(
      () => buildStatus({ ...statusInput(), worktree: [{ path: '../evil.md', state: 'OUTPUT' as const }] }),
      'TX_PATH_TRAVERSAL',
    );
    expectCode(
      () => buildStatus({ ...statusInput(), index: [{ path: 'a/.GIT/x', state: 'BASE' as const }] }),
      'TX_PATH_SEGMENT',
    );
  });

  // 审计: status/result 输入与条目未知字段 fail-closed。
  it('status input 未知字段 → TX_UNKNOWN_FIELD; worktree 条目未知字段 → TX_UNKNOWN_FIELD (审计)', () => {
    expectCode(() => buildStatus({ ...statusInput(), hacker: 1 } as never), 'TX_UNKNOWN_FIELD');
    expectCode(
      () => normalizeWorktreeEntries([{ path: 'a.md', state: 'BEFORE', extra: 1 }]),
      'TX_UNKNOWN_FIELD',
    );
    expectCode(
      () => normalizeIndexEntries([{ path: 'a.md', state: 'BASE', extra: 1 }]),
      'TX_UNKNOWN_FIELD',
    );
  });

  const resultInput = () => ({
    txid: TXID,
    kind: 'canonical' as const,
    outcome: 'committed' as const,
    ref: REF,
    baseHead: BASE_HEAD,
    newHead: 'b'.repeat(40),
    planDigest: CONTENT_SHA,
    worktree: [
      { path: 'world/objects/obj_klein.md', state: 'OUTPUT' as const },
    ],
    index: [{ path: 'world/objects/obj_klein.md', state: 'OUTPUT' as const }],
    createdAt: '2026-08-15T00:01:00.000Z',
  });

  it('buildResult normalizes newHead/ref/baseHead and computes digest', () => {
    const r = buildResult(resultInput());
    expect(r.outcome).toBe('committed');
    expect(r.newHead).toBe('b'.repeat(40));
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    expectCode(() => buildResult({ ...resultInput(), outcome: 'partial' as never }), 'VALIDATION_FAILED');
    expectCode(() => buildResult({ ...resultInput(), newHead: 'zz' }), 'TX_INVALID_OBJECT_ID');
    expectCode(() => buildResult({ ...resultInput(), hacker: 1 } as never), 'TX_UNKNOWN_FIELD');
  });

  it('outcome 封闭枚举(committed/rolled_back/noop/aborted/recovered_*)', () => {
    for (const o of ['committed', 'rolled_back', 'noop', 'aborted', 'recovered_committed', 'recovered_rolled_back']) {
      expect(() => buildResult({ ...resultInput(), outcome: o as never })).not.toThrow();
    }
  });
});

// ----------------------------------------------------------------------------
// preSnapshot 归一 + 细分错误码登记(ADR-0021 §2/§4/§5/§8)
// ----------------------------------------------------------------------------

describe('preSnapshot 归一与细分错误码 (N32)', () => {
  it('normalizePreSnapshot sorts/dedupes and validates states', () => {
    const entries = [
      { path: 'b.md', state: { kind: 'absent' } },
      { path: 'a.md', state: { kind: 'present', contentSha256: CONTENT_SHA.toUpperCase() } },
    ];
    const out = normalizePreSnapshot(entries);
    expect(out.map((e) => e.path)).toEqual(['a.md', 'b.md']);
    expect(out[0].state).toEqual({ kind: 'present', contentSha256: CONTENT_SHA });
  });

  it('conflicting preSnapshot duplicates → TX_DUPLICATE_TARGET', () => {
    expectCode(
      () =>
        normalizePreSnapshot([
          { path: 'a.md', state: { kind: 'absent' } },
          { path: 'a.md', state: { kind: 'present', contentSha256: CONTENT_SHA } },
        ]),
      'TX_DUPLICATE_TARGET',
    );
  });

  it('preSnapshot 未知 state kind → TX_INTENT_INVALID; 非 plain → TX_NON_PLAIN_OBJECT', () => {
    expectCode(
      () => normalizePreSnapshot([{ path: 'a.md', state: { kind: 'weird' } }]),
      'TX_INTENT_INVALID',
    );
    expectCode(
      () => normalizePreSnapshot([{ path: 'a.md', state: new Proxy({ kind: 'absent' }, {}) }]),
      'TX_NON_PLAIN_OBJECT',
    );
  });

  it('ADR-0021 §2/§4/§5 执行层错误码已登记到 StoreErrorCode(N32 细分错误码; 审计新增码)', () => {
    // 编译期已保证成员资格(StoreErrorCode 联合); 此处实例化证明可用。
    for (const code of [
      'TX_PATH_EMPTY',
      'TX_PATH_ABSOLUTE',
      'TX_PATH_TRAVERSAL',
      'TX_PATH_SEGMENT',
      'TX_INVALID_TXID',
      'TX_INVALID_KIND',
      'TX_INVALID_REF',
      'TX_INVALID_SHA256',
      'TX_INVALID_OBJECT_ID',
      'TX_INVALID_EXPECTED_STATE',
      'TX_INVALID_BYTE_LENGTH',
      'TX_DUPLICATE_TARGET',
      'TX_UNKNOWN_FIELD',
      'TX_NON_PLAIN_OBJECT',
      'TX_INVALID_TARGET_KIND',
      'TX_INVALID_MODE',
      'TX_WRITESET_MISMATCH',
      'TX_INTENT_INVALID',
      'TX_PLAN_DIGEST_MISMATCH',
      'TX_INTENT_DIGEST_MISMATCH',
      'STAGED_CONFLICT',
      'STALE_BASELINE',
      'CAS_CONFLICT',
    ] as StoreErrorCode[]) {
      const err = new StoreError(code, 'test');
      expect(err.code).toBe(code);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('cmpPath 字典序确定性', () => {
    expect(cmpPath('a', 'b')).toBeLessThan(0);
    expect(cmpPath('b', 'a')).toBeGreaterThan(0);
    expect(cmpPath('a', 'a')).toBe(0);
  });

  it('normalizeWorktreeEntries / normalizeIndexEntries 排序且拒绝非法枚举', () => {
    expect(
      normalizeWorktreeEntries([
        { path: 'z.md', state: 'BEFORE' },
        { path: 'a.md', state: 'OUTPUT' },
      ]).map((e) => e.path),
    ).toEqual(['a.md', 'z.md']);
    expectCode(() => normalizeIndexEntries([{ path: 'x', state: 'STAGED' as never }]), 'VALIDATION_FAILED');
  });
});