// ============================================================================
// ADR-0021(N32) 事务类型/规范化层单元测试(与 codec.ts 同目录, 零 IO)。
//
// 断言注释引裁定/条款编号: N32(2026-08-15 第八批裁定)、ADR-0021 §1/§2/§4/§5/§6/
// §7/§8; vitest 行为契约(AGENTS.md 测试约定)。
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildIntent,
  buildPlan,
  buildResult,
  buildStatus,
  canonicalJson,
  cmpPath,
  computePlanDigest,
  deserializeIntent,
  isIndexEntryState,
  isRelPath,
  isSha256,
  isTransactionKind,
  isTxId,
  isWorktreeState,
  normalizeExpectedState,
  normalizeGitObjectId,
  normalizeHeadRef,
  normalizeIndexEntries,
  normalizePreSnapshot,
  normalizeRef,
  normalizeRelPath,
  normalizeSha256,
  normalizeWorktreeEntries,
  normalizeWriteTargets,
  serializeIntent,
  verifyIntent,
  verifyPlan,
  verifyPlanDigest,
} from './codec.js';
import { StoreError, type StoreErrorCode } from '../errors.js';
import type { WriteTarget } from './types.js';
import { sha256Hex } from '../hash.js';

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

const TXID = 'tx_6f3a9c1d2b8e4a07';
const VAULT = '/Users/example/books/my-novel';
const REF = 'refs/heads/main';
const BASE_HEAD = 'a'.repeat(40);
const EXACT_TREE = 'b'.repeat(40);
const CONTENT = 'hello'; // sha256('hello') = 2cf24dba…
const CONTENT_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const BLOB_FAKE = 'c'.repeat(40);

function bytesTargetInput(path: string, bytes = CONTENT, expected = { kind: 'absent' as const }) {
  return { kind: 'bytes' as const, path, bytes: enc.encode(bytes), expected, blob: BLOB_FAKE };
}

function snapFor(paths: string[]): Array<{ path: string; state: { kind: 'absent' } }> {
  return paths.map((path) => ({ path, state: { kind: 'absent' } }));
}

// ----------------------------------------------------------------------------
// 严格相对 POSIX 路径(ADR-0021 §8/N32: 拒绝绝对路径、`..`、路径穿越)
// ----------------------------------------------------------------------------

describe('normalizeRelPath (ADR-0021 §8 严格相对 POSIX 路径)', () => {
  it('accepts canonical relative POSIX paths (N32 path allowlist)', () => {
    for (const p of [
      'world/objects/obj_klein.md',
      '.assistant/checkpoint.json', // 隐藏段(非 `.`/`..`)合法
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

  it('rejects non-string input → TX_PATH_SEGMENT', () => {
    expectCode(() => normalizeRelPath(42 as unknown as string), 'TX_PATH_SEGMENT');
  });
});

describe('normalizeRef / normalizeHeadRef (ADR-0021 §1/§8)', () => {
  it('accepts relative git refs', () => {
    expect(normalizeRef('refs/heads/main')).toBe('refs/heads/main');
    expect(normalizeRef('main')).toBe('main');
    expect(normalizeRef('refs/tags/v1.0')).toBe('refs/tags/v1.0');
  });

  it.each([
    ['/refs/heads/main'],
    ['refs/.. /heads'],
    ['a..b'],
    ['refs/heads/main '],
    ['refs/heads/ma~in'],
    ['refs/heads/@{'],
    ['refs/heads/x.lock'],
    ['C:refs'],
  ])('rejects invalid ref %j → TX_INVALID_REF', (r) => {
    expectCode(() => normalizeRef(r), 'TX_INVALID_REF');
  });

  it('normalizeHeadRef accepts commit id or ref', () => {
    expect(normalizeHeadRef('A'.repeat(40))).toBe('a'.repeat(40));
    expect(normalizeHeadRef('main')).toBe('main');
  });
});

describe('normalizeSha256 / normalizeGitObjectId (SHA-256, N32)', () => {
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

  it('git object id: 40 or 64 hex ok, else TX_INVALID_OBJECT_ID', () => {
    expect(normalizeGitObjectId(BASE_HEAD)).toBe(BASE_HEAD);
    const h64 = 'b'.repeat(64);
    expect(normalizeGitObjectId(h64.toUpperCase())).toBe(h64);
    expectCode(() => normalizeGitObjectId('zz'), 'TX_INVALID_OBJECT_ID');
    expectCode(() => normalizeGitObjectId('a'.repeat(41)), 'TX_INVALID_OBJECT_ID');
  });
});

// ----------------------------------------------------------------------------
// ExpectedState present/absent(ADR-0021 §1/§4)
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
    expectCode(() => normalizeExpectedState(null), 'TX_INVALID_EXPECTED_STATE');
  });
});

// ----------------------------------------------------------------------------
// WriteTarget bytes/delete + writeSet 去重/排序(ADR-0021 §1/§4)
// ----------------------------------------------------------------------------

describe('WriteTarget bytes/delete (ADR-0021 §1)', () => {
  it('bytes target: computes outputSha256 + outputByteLength from bytes', () => {
    const out = normalizeWriteTargets([bytesTargetInput('world/objects/obj_klein.md')]);
    expect(out).toEqual([
      {
        kind: 'bytes',
        path: 'world/objects/obj_klein.md',
        expected: { kind: 'absent' },
        outputSha256: CONTENT_SHA, // sha256('hello') 已知向量
        outputByteLength: 5,
      },
    ]);
  });

  it('re-validates already-normalized bytes input', () => {
    const normalized: Extract<WriteTarget, { kind: 'bytes' }> = {
      kind: 'bytes',
      path: 'a.md',
      expected: { kind: 'absent' },
      outputSha256: CONTENT_SHA,
      outputByteLength: 5,
      mode: '100644',
      blob: BLOB_FAKE,
    };
    expect(normalizeWriteTargets([normalized])).toEqual([normalized]);
    // 篡改 hash/长度 → 拒绝
    expectCode(() => normalizeWriteTargets([{ ...normalized, outputSha256: 'deadbeef' }]), 'TX_INVALID_SHA256');
    expectCode(() => normalizeWriteTargets([{ ...normalized, outputByteLength: -1 }]), 'TX_INVALID_BYTE_LENGTH');
  });

  it('delete target keeps expected, path normalized', () => {
    expect(normalizeWriteTargets([{ kind: 'delete', path: 'world/objects/old.md', expected: { kind: 'present', contentSha256: CONTENT_SHA } }]))
      .toEqual([{ kind: 'delete', path: 'world/objects/old.md', expected: { kind: 'present', contentSha256: CONTENT_SHA } }]);
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
    const a = { kind: 'bytes', path: 'x.md', expected: { kind: 'absent' }, outputSha256: CONTENT_SHA, outputByteLength: 5 };
    const b = { outputByteLength: 5, outputSha256: CONTENT_SHA, expected: { kind: 'absent' }, path: 'x.md', kind: 'bytes' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('excludes bytes variants from serialization (hash-only wire form)', () => {
    // 已归一形态没有 bytes 属性, canonical 输出只含 hash/长度(N32 计划输出 bytes/blob hashes)。
    const json = canonicalJson({ kind: 'bytes', path: 'a.md', outputSha256: CONTENT_SHA, outputByteLength: 5, expected: { kind: 'absent' } });
    expect(json).not.toContain('bytes":{');
    expect(json).toContain(CONTENT_SHA);
  });
});

// ----------------------------------------------------------------------------
// TransactionPlan + plan digest(ADR-0021 §6: exact tree + writeSet + 输出 blob
// hashes 共同形成不可变 plan digest)
// ----------------------------------------------------------------------------

describe('TransactionPlan + plan digest (ADR-0021 §6)', () => {
  const planInput = () => ({
    txid: TXID,
    kind: 'state' as const,
    ref: REF,
    baseHead: BASE_HEAD,
    exactTree: EXACT_TREE,
    fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')],
  });

  it('buildPlan computes deterministic digest; same input → same plan', () => {
    const p1 = buildPlan(planInput());
    const p2 = buildPlan(planInput());
    expect(p1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p2.digest).toBe(p1.digest);
    expect(p1.version).toBe(1);
    // payload 重推导等于 digest
    expect(computePlanDigest({ version: 1, txid: p1.txid, kind: p1.kind, ref: p1.ref, baseHead: p1.baseHead, exactTree: p1.exactTree, fullWriteSet: p1.fullWriteSet, actualWriteSet: p1.actualWriteSet }))
      .toBe(p1.digest);
  });

  it('digest is stable across input order (fullWriteSet 已排序去重)', () => {
    const p1 = buildPlan({ ...planInput(), fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')] });
    const p2 = buildPlan({ ...planInput(), fullWriteSet: [bytesTargetInput('b.md'), bytesTargetInput('a.md')] });
    expect(p2.digest).toBe(p1.digest);
  });

  it('verifyPlan accepts a valid plan; verifyPlanDigest true', () => {
    const p = buildPlan(planInput());
    verifyPlan(p);
    expect(verifyPlanDigest(p)).toBe(true);
  });

  it('tampered fullWriteSet/ref/txid → TX_PLAN_DIGEST_MISMATCH', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan({ ...p, ref: 'refs/heads/other' }), 'TX_PLAN_DIGEST_MISMATCH');
    // 篡改 fullWriteSet 用「已归一目标」注入(原始 bytes 形态会因 Uint8Array 非 JSON 安全被
    // canonical 检查以 TX_INTENT_INVALID 先拒, 那是另一层验证)
    const tamperedTarget = normalizeWriteTargets([bytesTargetInput('c.md')])[0];
    expectCode(() => verifyPlan({ ...p, fullWriteSet: [tamperedTarget] }), 'TX_PLAN_DIGEST_MISMATCH');
    expectCode(() => verifyPlan({ ...p, txid: 'tx_0000000000000000' }), 'TX_PLAN_DIGEST_MISMATCH');
    expectCode(() => verifyPlan({ ...p, digest: '0'.repeat(64) }), 'TX_PLAN_DIGEST_MISMATCH');
    expect(verifyPlanDigest({ ...p, digest: '0'.repeat(64) })).toBe(false);
  });

  it('unknown version / non-canonical fields → TX_INTENT_INVALID', () => {
    const p = buildPlan(planInput());
    expectCode(() => verifyPlan({ ...p, version: 2 }), 'TX_INTENT_INVALID');
    // baseHead 未归一小写 → TX_INTENT_INVALID(大写 ref 本身合法, 用 baseHead 演示)
    expectCode(() => verifyPlan({ ...p, baseHead: BASE_HEAD.toUpperCase() }), 'TX_INTENT_INVALID');
    // 未排序 fullWriteSet → 非 canonical 形态
    const shuffled = normalizeWriteTargets([bytesTargetInput('b.md'), bytesTargetInput('a.md')]).reverse();
    expectCode(() => verifyPlan({ ...p, fullWriteSet: shuffled }), 'TX_INTENT_INVALID');
  });

  it('unknown kind → TX_INVALID_KIND; bad txid → TX_INVALID_TXID', () => {
    expectCode(() => buildPlan({ ...planInput(), kind: 'adopt' as never }), 'TX_INVALID_KIND');
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

  it('txid 白名单: 8–64 位 [a-z0-9_-], 首字符字母数字', () => {
    expect(isTxId(TXID)).toBe(true);
    for (const bad of ['a'.repeat(7), 'A' + 'a'.repeat(7), '-abcdefgh', 'abcdefgh/i', 'abcdefgh i']) {
      expect(isTxId(bad)).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// TransactionIntent + recovery 验证(ADR-0021 §8 durable intent)
// ----------------------------------------------------------------------------

describe('TransactionIntent (ADR-0021 §8)', () => {
  const intentInput = () => ({
    txid: TXID,
    vaultRoot: VAULT,
    kind: 'state' as const,
    ref: REF,
    baseHead: BASE_HEAD,
    exactTree: EXACT_TREE,
    fullWriteSet: [bytesTargetInput('a.md'), bytesTargetInput('b.md')],
    preSnapshot: snapFor(['a.md', 'b.md']),
    createdAt: '2026-08-15T00:00:00.000Z',
  });

  it('buildIntent embeds verified plan + preSnapshot (全目标快照, §4)', () => {
    const intent = buildIntent(intentInput());
    expect(intent.version).toBe(1);
    expect(intent.cleanup).toBe('pending');
    expect(intent.plan.fullWriteSet.map((t) => t.path)).toEqual(['a.md', 'b.md']);
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

  it('preSnapshot 路径集合必须与 writeSet 完全一致(§4) → TX_INTENT_INVALID', () => {
    expectCode(() => buildIntent({ ...intentInput(), preSnapshot: snapFor(['a.md']) }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), preSnapshot: snapFor(['a.md', 'c.md']) }), 'TX_INTENT_INVALID');
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

  it('unknown schema version / 非法 vaultRoot / 非法 createdAt → TX_INTENT_INVALID', () => {
    const intent = buildIntent(intentInput());
    expectCode(() => verifyIntent({ ...intent, version: 2 }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), vaultRoot: 'relative/book' }), 'TX_INTENT_INVALID');
    expectCode(() => buildIntent({ ...intentInput(), createdAt: 'not-a-date' }), 'TX_INTENT_INVALID');
  });

  it('deserializeIntent rejects malformed JSON → TX_INTENT_INVALID', () => {
    expectCode(() => deserializeIntent('{not json'), 'TX_INTENT_INVALID'); // JSON 语法错误
    expectCode(() => deserializeIntent('"just a string"'), 'TX_INTENT_INVALID'); // 非对象
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
    index: [{ path: '.git/index.lock', state: 'BASE' as const }],
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

  it('worktree/index 路径仍走严格相对 POSIX 门禁', () => {
    expectCode(
      () => buildStatus({ ...statusInput(), worktree: [{ path: '../evil.md', state: 'OUTPUT' as const }] }),
      'TX_PATH_TRAVERSAL',
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

  it('ADR-0021 §2/§4/§5 执行层错误码已登记到 StoreErrorCode(N32 细分错误码)', () => {
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
    expect(normalizeWorktreeEntries([{ path: 'z.md', state: 'BEFORE' }, { path: 'a.md', state: 'OUTPUT' }]).map((e) => e.path))
      .toEqual(['a.md', 'z.md']);
    expectCode(() => normalizeIndexEntries([{ path: 'x', state: 'STAGED' as never }]), 'VALIDATION_FAILED');
  });
});