// N33 / ADR-0022 immutable run, deterministic batch, observed artifact hash and apply machine.
// 独立审查修复回归: batchPaths 反序列化重验、apply transactionId 门禁、secret 防护+
// accessor/Proxy、force identity、manifest 严格校验、canonical JSON、artifact 自描述、深冻结。
// run-model 复审修复回归(R1–R6): 公开输入一次 deep snapshot、allowSecretPaths 删除、
// JSON Pointer 路径、expected 精确 workflowId、apply 状态机(未 commit 回退清 tx /
// commitEvidence 证据对象 / unknown 禁止 / 额外字段拒绝)、force 全新 nonce 不依赖
// existingIds、canonical Reflect.ownKeys 严格遍历、artifact bytes 不可变副本。
import { describe, expect, it, vi } from 'vitest';
import {
  advanceApplyState,
  assertExpectedAbsent,
  assertManifestCompatible,
  batchPaths,
  canonicalRunJson,
  createForcedWorkflowIdentity,
  createWorkflowIdentity,
  makeBatchPlan,
  makeBatchReceipt,
  makeWorkflowId,
  serializeBatchArtifact,
  workflowRunRoot,
  workflowSha256,
  ARTIFACT_SCHEMA_VERSION,
  type ApplyCommitEvidence,
  type ApplyRecord,
  type BatchManifestEntry,
  type ReadonlyBytes,
  type WorkflowManifest,
} from '../src/index.js';

const sha = (text: string) => workflowSha256(text);
const workflowId = makeWorkflowId('deep-import', sha('input'), 'run-01');
function plan(sourceIds = ['scene-b', 'scene-a']) {
  return makeBatchPlan({
    workflowId,
    phase: 'entities',
    ordinal: 0,
    inputFingerprint: sha('input'),
    sourceIds,
    sourceHashes: { 'scene-a': sha('a'), 'scene-b': sha('b') },
  });
}

const identity = {
  workflowId,
  kind: 'deep-import' as const,
  inputFingerprint: sha('input'),
  profileFingerprint: sha('profile'),
  planDigest: sha('plan'),
};
const manifest: WorkflowManifest = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...identity,
  status: 'running', cursor: { phase: 'entities', ordinal: 0 }, batches: {},
};
const p = plan();
const planPaths = batchPaths('deep-import', p);
const validBatch: BatchManifestEntry = {
  batchId: p.batchId, phase: 'entities', ordinal: 0, state: 'planned', ...planPaths,
};
const withBatch = (patch: Record<string, unknown> = {}): WorkflowManifest => ({
  ...manifest,
  batches: { [p.batchId]: { ...validBatch, ...patch } },
});
const baseIdentityInput = {
  kind: 'deep-import' as const,
  inputFingerprint: sha('input'),
  profileFingerprint: sha('profile'),
  planDigest: sha('plan'),
};

// —— apply fixtures(复审 R4: ApplyRecord 绑定全部身份字段) ——
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';
const T4 = '2026-01-01T00:04:00.000Z';
const binding = {
  writeSetDigest: sha('writeSet'),
  artifactHash: sha('artifact'),
  batchId: 'batch-abc',
  checkpoint: sha('checkpoint'),
  planDigest: sha('plan'),
  provenance: 'prov-apply-1',
};
function waitingApply(patch: Partial<ApplyRecord> = {}): ApplyRecord {
  return {
    version: 1, applyId: 'apply-01', workflowId, target: 'world/objects/a.md',
    expectedHash: sha('target'), ...binding,
    state: 'waiting_approval', updatedAt: T0, ...patch,
  };
}
function commitEvidence(patch: Partial<ApplyCommitEvidence> = {}): ApplyCommitEvidence {
  return {
    commitOid: sha('commit'), workflowId, batchId: binding.batchId,
    planDigest: binding.planDigest, writeSetDigest: binding.writeSetDigest,
    artifactHash: binding.artifactHash, verifiedAt: T2, ...patch,
  };
}

describe('workflow identity and batch plans', () => {
  it('force 可用不同 unique run id 新建目录；同 fingerprint 不覆盖旧 run', () => {
    const a = makeWorkflowId('deep-import', sha('input'), 'run-01');
    const b = makeWorkflowId('deep-import', sha('input'), 'run-02');
    expect(a).not.toBe(b);
    expect(a).toContain(sha('input').slice(0, 16));
    expect(workflowRunRoot('deep-import', a)).toBe(`.assistant/import-runs/${a}`);
  });

  it('batch_id 由规范化输入确定，source 顺序不影响；输入变化敏感', () => {
    const a = plan(['scene-b', 'scene-a']);
    const b = plan(['scene-a', 'scene-b']);
    expect(a.batchId).toBe(b.batchId);
    expect(a.sourceIds).toEqual(['scene-a', 'scene-b']);
    const changed = makeBatchPlan({ ...a, ordinal: 1 });
    expect(changed.batchId).not.toBe(a.batchId);
    expect(batchPaths('deep-import', a)).toEqual({
      planPath: `.assistant/import-runs/${workflowId}/batches/entities/${a.batchId}.plan.json`,
      artifactPath: `.assistant/import-runs/${workflowId}/batches/entities/${a.batchId}.artifact.json`,
      receiptPath: `.assistant/import-runs/${workflowId}/batches/entities/${a.batchId}.receipt.json`,
    });
  });

  it('重复/缺hash/路径型source id fail-closed', () => {
    expect(() => plan(['scene-a', 'scene-a'])).toThrow(/重复/);
    expect(() => makeBatchPlan({
      workflowId, phase: '../x', ordinal: 0, inputFingerprint: sha('input'), sourceIds: [], sourceHashes: {},
    })).toThrow(/phase/);
    expect(() => makeBatchPlan({
      workflowId, phase: 'x', ordinal: 0, inputFingerprint: sha('input'), sourceIds: ['a'], sourceHashes: {},
    })).toThrow(/hash/);
  });

  it('batchPaths 对反序列化 plan 全量重验 identity/path，拒绝 traversal/篡改(审查发现 1)', () => {
    const base = plan();
    expect(() => batchPaths('deep-import', { ...base, phase: '../../evil' })).toThrow(/phase/);
    expect(() => batchPaths('deep-import', { ...base, phase: './x' })).toThrow(/phase/);
    expect(() => batchPaths('deep-import', { ...base, batchId: 'batch-deadbeef' })).toThrow(/不匹配/);
    expect(() => batchPaths('deep-import', { ...base, batchId: '../../etc/passwd' })).toThrow(/batchId/);
    expect(() => batchPaths('deep-import', { ...base, workflowId: `imp-${'0'.repeat(16)}-run-9` })).toThrow(/绑定/);
    expect(() => batchPaths('deep-import', { ...base, workflowId: `atlas-${sha('input').slice(0, 16)}-run-9` })).toThrow(/kind/);
    expect(() => batchPaths('deep-import', { ...base, ordinal: -1 })).toThrow(/ordinal/);
    expect(() => batchPaths('deep-import', { ...base, inputFingerprint: sha('other') })).toThrow(/绑定/);
    expect(() => batchPaths('map-atlas', { ...base, workflowId: `imp-${sha('input').slice(0, 16)}-run-9` })).toThrow(/kind/);
    expect(() => batchPaths('deep-import', { ...base, version: 2 } as never)).toThrow(/version/);
  });

  it('serializeBatchArtifact 同样拒绝篡改 plan(审查发现 1)', () => {
    const base = plan();
    expect(() => serializeBatchArtifact({ ...base, batchId: 'batch-deadbeef' }, { z: 1 })).toThrow(/不匹配/);
    expect(() => serializeBatchArtifact({ ...base, phase: '../../x' }, { z: 1 })).toThrow(/phase/);
  });

  it('公开输入一次 deep snapshot：调用后突变输入不影响已派生的输出(复审 R1)', () => {
    const mutable = { ...p, phase: 'entities' };
    const paths = batchPaths('deep-import', mutable);
    (mutable as { phase: string }).phase = '../../evil';
    (mutable as { batchId: string }).batchId = 'batch-deadbeef';
    expect(paths.planPath).toBe(`${workflowRunRoot('deep-import', workflowId)}/batches/entities/${p.batchId}.plan.json`);

    const payload = { z: 1, nested: { a: 2 } };
    const r = serializeBatchArtifact(p, payload);
    (payload as { z: number }).z = 999;
    expect(Buffer.from(r.bytes).toString('utf8')).toContain('"z":1');
    expect(r.artifact.payload).toEqual({ z: 1, nested: { a: 2 } });

    const cur = waitingApply();
    const applying = advanceApplyState(cur, 'applying', { now: T1, transactionId: 'tx-1' });
    (cur as { target: string }).target = '../evil';
    expect(applying.target).toBe('world/objects/a.md');
    expect(applying.transactionId).toBe('tx-1');
  });

  it('所有公开输入拒绝 Proxy/类实例/accessor(复审 R1)', () => {
    const proxyPlan = new Proxy(plan(), {});
    expect(() => batchPaths('deep-import', proxyPlan)).toThrow(/Proxy/);
    expect(() => serializeBatchArtifact(proxyPlan, { z: 1 })).toThrow(/Proxy/);
    expect(() => makeBatchPlan(new Proxy({ ...p, version: 1, batchId: 'x' } as never, {}))).toThrow(/Proxy/);
    expect(() => makeBatchReceipt(new Proxy({
      workflowId, batchId: p.batchId, resultHash: sha('x'),
      transactionId: 'tx-01', committedAt: T0,
    }, {}))).toThrow(/Proxy/);
    expect(() => advanceApplyState(new Proxy(waitingApply(), {}), 'rejected', { now: T1 })).toThrow(/Proxy/);
    expect(() => advanceApplyState(waitingApply(), 'rejected', new Proxy({ now: T1 }, {}))).toThrow(/Proxy/);
    expect(() => assertManifestCompatible(new Proxy(manifest, {}), identity)).toThrow(/Proxy/);
    expect(() => assertManifestCompatible(manifest, new Proxy(identity, {}))).toThrow(/Proxy/);
    expect(() => createWorkflowIdentity(new Proxy({ ...baseIdentityInput, uniqueRunId: 'run-01' }, {}))).toThrow(/Proxy/);
    expect(() => createForcedWorkflowIdentity(new Proxy({ ...baseIdentityInput }, {}))).toThrow(/Proxy/);
    expect(() => assertExpectedAbsent(workflowId, new Proxy(new Set(), {}))).toThrow(/Proxy/);
    expect(() => assertExpectedAbsent(workflowId, new Proxy(['imp-x'], {}))).toThrow(/Proxy/);
    expect(() => makeBatchPlan({ ...p, sourceHashes: new Map() } as never)).toThrow(/plain/);
  });

  it('structuredClone 缺失也不 fail-open：Proxy 仍被自遍历 + isProxy 拒绝(复审 R1)', () => {
    vi.stubGlobal('structuredClone', undefined);
    try {
      expect(() => serializeBatchArtifact(p, new Proxy({ z: 1 }, {}))).toThrow(/Proxy/);
      expect(() => canonicalRunJson(new Proxy({ a: 1 }, {}))).toThrow(/Proxy/);
      expect(() => batchPaths('deep-import', new Proxy(plan(), {}))).toThrow(/Proxy/);
      expect(() => advanceApplyState(new Proxy(waitingApply(), {}), 'rejected', { now: T1 })).toThrow(/Proxy/);
    } finally {
      vi.unstubAllGlobals();
    }
    // 恢复后 plain payload 仍正常
    expect(serializeBatchArtifact(p, { z: 1 }).resultHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('artifact/receipt', () => {
  it('artifact 最终字节稳定；result_hash observed 且不自嵌', () => {
    const first = serializeBatchArtifact(p, { z: 1, a: ['x'] });
    const second = serializeBatchArtifact(p, { a: ['x'], z: 1 });
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.resultHash).toBe(workflowSha256(first.bytes));
    expect(Buffer.from(first.bytes).toString('utf8')).not.toContain('resultHash');
    expect(Buffer.from(first.bytes).toString('utf8').endsWith('\n')).toBe(true);
    const receipt = makeBatchReceipt({
      workflowId, batchId: p.batchId, resultHash: first.resultHash,
      transactionId: 'tx-01', committedAt: T0,
    });
    expect(receipt.resultHash).toBe(first.resultHash);
  });

  it('artifact 自描述字段 ordinal/artifactSchemaVersion/outputSchemaVersion(审查发现 7)', () => {
    const r = serializeBatchArtifact(p, { z: 1 }, { outputSchemaVersion: '2.1' });
    expect(r.artifact.ordinal).toBe(p.ordinal);
    expect(r.artifact.phase).toBe(p.phase);
    expect(r.artifact.batchId).toBe(p.batchId);
    expect(r.artifact.artifactSchemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(r.artifact.outputSchemaVersion).toBe('2.1');
    const text = Buffer.from(r.bytes).toString('utf8');
    expect(text).toContain('"artifactSchemaVersion":1');
    expect(text).toContain('"outputSchemaVersion":"2.1"');
    expect(text).toContain('"ordinal":0');
    expect(() => serializeBatchArtifact(p, {}, { outputSchemaVersion: '../x' })).toThrow(/Schema/);
    expect(() => serializeBatchArtifact(p, {}, { outputSchemaVersion: '' })).toThrow(/Schema/);
    expect(serializeBatchArtifact(p, {}).artifact.outputSchemaVersion).toBe('1');
  });

  it('payload secret key 禁止进入 artifact/manifest fingerprint 面', () => {
    expect(() => serializeBatchArtifact(p, { apiKey: 'sk-secret' })).toThrow(/secret/);
  });

  it('secret 防护覆盖常见 key 形态(审查发现 3)', () => {
    const cases: Array<[string, unknown]> = [
      ['clientSecret', { clientSecret: 'x' }],
      ['privateKey', { privateKey: 'x' }],
      ['token', { token: 'x' }],
      ['bearer', { bearer: 'Bearer x' }],
      ['Authorization header', { Authorization: 'Bearer x' }],
      ['api_key', { api_key: 'x' }],
      ['API_KEY', { API_KEY: 'x' }],
      ['api.key', { 'api.key': 'x' }],
      ['x-api-key', { 'x-api-key': 'x' }],
      ['nested', { data: { apiKey: 'x' } }],
      ['array nested', { list: [{ accessToken: 'x' }] }],
      ['camel bearerToken', { bearerToken: 'x' }],
      ['suffix apikey2', { apiKey2: 'x' }],
      ['client_secret', { client_secret: 'x' }],
      ['credential', { credential: { user: 'u' } }],
      ['auth token', { auth: { token: 'x' } }],
      ['jwt', { jwt: 'eyJ' }],
      ['cookie', { cookie: 'session=1' }],
      ['access_token', { access_token: 'x' }],
    ];
    for (const [label, payload] of cases) {
      expect(() => serializeBatchArtifact(p, payload), label).toThrow(/secret/);
    }
  });

  it('领域标识 *_key 可持久化，但裸 key/敏感限定 key 仍 fail-closed(N33 map-atlas)', () => {
    expect(() => serializeBatchArtifact(p, {
      location_key: 'loc-a', source_keys: ['wiki:a'], plan_key: 'node-a', semantic_key: 'entity:loc-a',
    })).not.toThrow();
    expect(() => serializeBatchArtifact(p, { key: 'x' })).toThrow(/secret/);
    expect(() => serializeBatchArtifact(p, { private_key: 'x' })).toThrow(/secret/);
  });

  it('allowSecretPaths 已删除：无白名单、无 secret 落盘能力(复审 R2)', () => {
    expect(() => serializeBatchArtifact(p, { token: 'schema-token', note: 'ok' }, {
      allowSecretPaths: new Set(['$.token']),
    } as never)).toThrow(/allowSecretPaths/);
    expect(() => serializeBatchArtifact(p, { token: 'x' })).toThrow(/secret/);
    expect(() => serializeBatchArtifact(p, { data: { token: 'x' } })).toThrow(/secret/);
    expect(() => serializeBatchArtifact(p, { token: 'x' }, { allowSecretPaths: new Set(['$.other']) } as never)).toThrow(/allowSecretPaths/);
    // receipt/manifest/apply 结果同样禁止 secret
    expect(() => makeBatchReceipt({
      workflowId, batchId: p.batchId, resultHash: sha('x'),
      transactionId: 'tx-01', committedAt: T0, apiKey: 'x',
    } as never)).toThrow(/secret/);
    expect(() => assertManifestCompatible({ ...manifest, apiKey: 'secret' } as never, identity)).toThrow(/secret/);
  });

  it('secret 拒绝路径使用 JSON Pointer 安全编码(复审 R2)', () => {
    expect(() => serializeBatchArtifact(p, { data: { apiKey: 'x' } })).toThrow(/\$\/data\/apiKey/);
    expect(() => serializeBatchArtifact(p, { list: [{ clientSecret: 'x' }] })).toThrow(/\$\/list\/0\/clientSecret/);
    // key 含 / 与 ~ 时按 RFC 6901 转义(~0 / ~1), 无点路径歧义
    expect(() => serializeBatchArtifact(p, { 'a/b': { token: 'x' } })).toThrow(/\$\/a~1b\/token/);
    expect(() => serializeBatchArtifact(p, { 'a~b': { secret: 'x' } })).toThrow(/\$\/a~0b\/secret/);
    expect(() => serializeBatchArtifact(p, { 'a.b': { apiKey: 'x' } })).toThrow(/\$\/a\.b\/apiKey/);
  });

  it('secret 防护拒绝 accessor/Proxy 常见绕过(审查发现 3)', () => {
    expect(() => serializeBatchArtifact(p, { get apiKey() { return 'x'; } })).toThrow(/accessor|secret/);
    expect(() => serializeBatchArtifact(p, { get secret() { return 'x'; } })).toThrow(/accessor|secret/);
    expect(() => serializeBatchArtifact(p, new Proxy({ apiKey: 'x' }, {}))).toThrow(/Proxy/);
    expect(() => serializeBatchArtifact(p, new Proxy({ z: 1 }, {}))).toThrow(/Proxy/);
    expect(() => serializeBatchArtifact(p, new Proxy({ z: 1 }, { get(t, k) { return Math.random(); } }))).toThrow(/Proxy/);
    expect(() => serializeBatchArtifact(p, { z: 1, nested: new Proxy({ a: 2 }, {}) })).toThrow(/Proxy/);
    // symbol key / non-enumerable key 在持久化面同样 fail-closed(复审 R1/R6)
    expect(() => serializeBatchArtifact(p, { [Symbol('k')]: 1 })).toThrow(/symbol/);
    const nonEnum: Record<string, unknown> = { z: 1 };
    Object.defineProperty(nonEnum, 'hidden', { value: 2, enumerable: false });
    expect(() => serializeBatchArtifact(p, nonEnum)).toThrow(/non-enumerable/);
    expect(() => makeBatchReceipt({
      workflowId, batchId: p.batchId, resultHash: sha('x'),
      transactionId: 'tx-01', committedAt: T0,
      [Symbol('s')]: 1,
    } as never)).toThrow(/symbol/);
  });

  it('artifact bytes 返回不可变副本；内部 hash 绑定不受外部突变影响(复审 R6)', () => {
    const r = serializeBatchArtifact(p, { z: 1 });
    const first = r.resultHash;
    // 返回的是副本: 强转解包后的突变只作用于副本, 不影响内部绑定字节
    const mutable = r.bytes as unknown as Uint8Array;
    mutable[0] = 0;
    expect(workflowSha256(mutable)).not.toBe(first);
    // 重新序列化 → 相同 hash(内部字节未被外部接触)
    const r2 = serializeBatchArtifact(p, { z: 1 });
    expect(r2.resultHash).toBe(first);
    expect(workflowSha256(r2.bytes)).toBe(first);
    // 输入 payload 事后突变也不影响已派生的字节与 hash
    const payload = { z: 1 };
    const r3 = serializeBatchArtifact(p, payload);
    (payload as { z: number }).z = 999;
    expect(r3.resultHash).toBe(first);
    expect(Buffer.from(r3.bytes).toString('utf8')).toContain('"z":1');
  });
});

describe('canonical JSON 只接受 plain JSON data(审查发现 6)', () => {
  it('固定键序', () => {
    expect(canonicalRunJson({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
    expect(canonicalRunJson({ b: [1, null, 'x'], a: { c: true } })).toBe('{"a":{"c":true},"b":[1,null,"x"]}');
    expect(canonicalRunJson([])).toBe('[]');
    expect(canonicalRunJson('')).toBe('""');
  });

  it('拒绝 Date/Map/类实例/accessor/Proxy', () => {
    expect(() => canonicalRunJson(new Date())).toThrow(/plain|Date/);
    expect(() => canonicalRunJson({ when: new Date() })).toThrow(/Date/);
    expect(() => canonicalRunJson(new Map([['a', 1]]))).toThrow(/plain/);
    expect(() => canonicalRunJson(class X {})).toThrow(/function/);
    expect(() => canonicalRunJson({ get apiKey() { return 'x'; } })).toThrow(/accessor/);
    expect(() => canonicalRunJson(new Proxy({ a: 1 }, {}))).toThrow(/Proxy/);
    expect(() => canonicalRunJson({ a: new Proxy({ b: 1 }, {}) })).toThrow(/Proxy/);
  });

  it('拒绝稀疏数组/undefined/function/bigint/非有限数字', () => {
    const sparse: number[] = [1];
    sparse[2] = 3;
    expect(() => canonicalRunJson(sparse)).toThrow(/稀疏/);
    expect(() => canonicalRunJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalRunJson([1, undefined])).toThrow(/undefined/);
    expect(() => canonicalRunJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalRunJson(() => 1)).toThrow(/function/);
    expect(() => canonicalRunJson({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalRunJson(NaN)).toThrow(/非有限/);
    expect(() => canonicalRunJson({ a: Infinity })).toThrow(/非有限/);
  });

  it('Reflect.ownKeys 严格遍历：symbol/non-enumerable/accessor/数组异常 fail-closed(复审 R6)', () => {
    expect(() => canonicalRunJson({ [Symbol('k')]: 1 })).toThrow(/symbol/);
    expect(() => canonicalRunJson({ [Symbol('k')]: 1, a: 1 })).toThrow(/symbol/);
    const nonEnum: Record<string, unknown> = { a: 1 };
    Object.defineProperty(nonEnum, 'hidden', { value: 2, enumerable: false });
    expect(() => canonicalRunJson(nonEnum)).toThrow(/non-enumerable/);
    // 数组索引 accessor
    const arrAccessor = [1, 2];
    Object.defineProperty(arrAccessor, '0', { get() { return 7; }, enumerable: true });
    expect(() => canonicalRunJson(arrAccessor)).toThrow(/accessor/);
    // 数组额外属性 / 子类(越界索引不可达: defineProperty 自动扩展 length)
    const extraProp: number[] = [1];
    (extraProp as unknown as Record<string, unknown>).foo = 1;
    expect(() => canonicalRunJson(extraProp)).toThrow(/额外属性/);
    class Arr extends Array {}
    const sub = new Arr(1);
    sub[0] = 1;
    expect(() => canonicalRunJson(sub)).toThrow(/子类/);
    // 循环引用 / 过深
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => canonicalRunJson(cyc)).toThrow(/过深|循环/);
    let deep: unknown = 0;
    for (let i = 0; i < 80; i++) deep = { d: deep };
    expect(() => canonicalRunJson(deep)).toThrow(/过深/);
  });
});

describe('resume compatibility and apply state machine', () => {
  it('输入/profile/plan 任一变化禁止续跑，manifest secret key fail-closed', () => {
    expect(() => assertManifestCompatible(manifest, identity)).not.toThrow();
    expect(() => assertManifestCompatible(manifest, { ...identity, profileFingerprint: sha('other') })).toThrow(/profileFingerprint/);
    expect(() => assertManifestCompatible(manifest, { ...identity, inputFingerprint: sha('other') })).toThrow(/inputFingerprint/);
    expect(() => assertManifestCompatible(manifest, { ...identity, planDigest: sha('other') })).toThrow(/planDigest/);
    expect(() => assertManifestCompatible(manifest, { ...identity, kind: 'map-atlas' })).toThrow(/kind/);
  });

  it('assertManifestCompatible expected 强制精确 workflowId 及所有 identity(复审 R3)', () => {
    const other = `imp-${sha('input').slice(0, 16)}-other-run`;
    expect(() => assertManifestCompatible(manifest, { ...identity, workflowId: other })).toThrow(/workflowId 不匹配/);
    // workflowId 缺失 → fail-closed(runtime 强制)
    const { workflowId: _dropped, ...noId } = identity;
    expect(() => assertManifestCompatible(manifest, noId as never)).toThrow(/workflowId/);
    // createdAt 提供则精确匹配
    expect(() => assertManifestCompatible(manifest, { ...identity, createdAt: '2026-02-02T00:00:00.000Z' })).toThrow(/createdAt/);
    expect(() => assertManifestCompatible(manifest, { ...identity, createdAt: manifest.createdAt })).not.toThrow();
  });

  it('assertManifestCompatible 完整严格校验 createdAt/status/cursor(审查发现 5)', () => {
    expect(() => assertManifestCompatible({ ...manifest, createdAt: 'not-a-date' }, identity)).toThrow(/createdAt/);
    expect(() => assertManifestCompatible({ ...manifest, status: 'bogus' } as never, identity)).toThrow(/status/);
    expect(() => assertManifestCompatible({ ...manifest, cursor: { phase: '../x', ordinal: 0 } }, identity)).toThrow(/cursor/);
    expect(() => assertManifestCompatible({ ...manifest, cursor: { phase: 'entities', ordinal: -1 } }, identity)).toThrow(/ordinal/);
  });

  it('assertManifestCompatible 校验 batches 状态/路径/ID 与确定性布局(审查发现 5)', () => {
    expect(() => assertManifestCompatible(withBatch(), identity)).not.toThrow();
    expect(() => assertManifestCompatible(withBatch({ state: 'committed' }), identity)).toThrow(/state/);
    expect(() => assertManifestCompatible(withBatch({ planPath: '.assistant/import-runs/other/batch-x.plan.json' }), identity)).toThrow(/路径/);
    expect(() => assertManifestCompatible(withBatch({ artifactPath: '{../../../outside.md}' }), identity)).toThrow(/路径/);
    expect(() => assertManifestCompatible({ ...manifest, batches: { 'other-id': validBatch } }, identity)).toThrow(/batchId/);
    expect(() => assertManifestCompatible(withBatch({ phase: '../x' }), identity)).toThrow(/phase/);
    expect(() => assertManifestCompatible(withBatch({ ordinal: -1 }), identity)).toThrow(/ordinal/);
    expect(() => assertManifestCompatible(withBatch({ resultHash: 'nope' }), identity)).toThrow(/resultHash/);
    expect(() => assertManifestCompatible(withBatch({ transactionId: '../x' }), identity)).toThrow(/transactionId/);
    expect(() => assertManifestCompatible({ ...manifest, batches: [] } as never, identity)).toThrow(/batches/);
  });

  it('assertManifestCompatible 校验 workflowId 前缀 + input fingerprint 绑定(审查发现 5)', () => {
    const fp16 = sha('input').slice(0, 16);
    expect(() => assertManifestCompatible({ ...manifest, workflowId: `atlas-${fp16}-run-9` }, identity)).toThrow(/前缀/);
    expect(() => assertManifestCompatible({ ...manifest, workflowId: `imp-${sha('other').slice(0, 16)}-run-9` }, identity)).toThrow(/绑定/);
    expect(() => assertManifestCompatible({ ...manifest, workflowId: 'imp-xyz' }, identity)).toThrow(/结构/);
    expect(() => assertManifestCompatible({ ...manifest, workflowId: `imp-${fp16}-..` }, identity)).toThrow(/段/);
    expect(() => assertManifestCompatible({ ...manifest, workflowId: `imp-${fp16}-run 9` }, identity)).toThrow(/workflowId 非法/);
  });

  it('apply 进入 applying 必须新分配 transactionId；已有事务身份禁止重复进入(复审 R4)', () => {
    expect(() => advanceApplyState(waitingApply(), 'applying', { now: T1 })).toThrow(/transactionId/);
    const applying = advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-apply' });
    expect(applying.state).toBe('applying');
    expect(applying.transactionId).toBe('tx-apply');
    // 非 applying 状态携带 transactionId = 损坏记录 fail-closed
    expect(() => advanceApplyState({ ...waitingApply(), transactionId: 'tx-1' }, 'applying', { now: T1, transactionId: 'tx-2' })).toThrow(/transactionId 只允许/);
    // applying 重复进入 applying 不在转换表
    expect(() => advanceApplyState(applying, 'applying', { now: T2, transactionId: 'tx-3' })).toThrow(/非法 apply 转换/);
  });

  it('事务已确认未 commit 可持久回 waiting_approval 并清 tx fields；已 commit 禁止回退(复审 R4)', () => {
    const applying = advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-apply' });
    const back = advanceApplyState(applying, 'waiting_approval', { now: T2 });
    expect(back.state).toBe('waiting_approval');
    expect(back.transactionId).toBeUndefined();
    expect(back.commitOid).toBeUndefined();
    expect(back.failure).toBeUndefined();
    // 回退后可用新事务再次进入 applying(旧 decision/tx 不复用)
    const reApply = advanceApplyState(back, 'applying', { now: T3, transactionId: 'tx-2' });
    expect(reApply.transactionId).toBe('tx-2');
    // 已 commit(applied)的 apply 不得退回 waiting_approval
    const applied = advanceApplyState(reApply, 'applied', { now: T4, commitEvidence: commitEvidence() });
    expect(() => advanceApplyState(applied, 'waiting_approval', { now: T4 })).toThrow(/非法 apply 转换/);
    // 回退不接受事务/证据字段
    expect(() => advanceApplyState(applying, 'waiting_approval', { now: T2, transactionId: 'tx-other' })).toThrow(/额外字段/);
    expect(() => advanceApplyState(applying, 'waiting_approval', { now: T2, commitEvidence: commitEvidence() })).toThrow(/额外字段/);
  });

  it('applied 必须注入 probe 证据对象并逐字段绑定；commitVerified 布尔已移除(复审 R4)', () => {
    const applying = advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-apply' });
    expect(() => advanceApplyState(applying, 'applied', { now: T2 })).toThrow(/commitEvidence/);
    // 旧布尔 commitVerified 一律拒绝
    expect(() => advanceApplyState(applying, 'applied', {
      now: T2, commitVerified: true, transactionId: 'tx-apply', commitOid: sha('c'),
    } as never)).toThrow(/commitVerified/);
    // 证据对象逐字段绑定
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ workflowId: `imp-${'0'.repeat(16)}-x` }) })).toThrow(/workflowId 与 apply 不符/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ batchId: 'batch-zzz' }) })).toThrow(/batchId 与 apply 不符/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ planDigest: sha('other-plan') }) })).toThrow(/planDigest 与 apply 不符/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ writeSetDigest: sha('other-ws') }) })).toThrow(/writeSetDigest 与 apply 不符/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ artifactHash: sha('other-art') }) })).toThrow(/artifactHash 与 apply 不符/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ commitOid: 'nope' }) })).toThrow(/commitOid/);
    expect(() => advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence({ verifiedAt: 'bogus' }) })).toThrow(/verifiedAt/);
    const applied = advanceApplyState(applying, 'applied', { now: T2, commitEvidence: commitEvidence() });
    expect(applied.state).toBe('applied');
    expect(applied.commitOid).toBe(sha('commit'));
    expect(applied.transactionId).toBe('tx-apply');
    // 终态不可再转换
    expect(() => advanceApplyState(applied, 'applying', { now: T3, transactionId: 'tx-9' })).toThrow(/非法/);
    // 未经过 applying 分配 transactionId 的记录不可 applied
    const weird = { ...waitingApply(), state: 'applying' as const, updatedAt: T1 };
    expect(() => advanceApplyState(weird, 'applied', { now: T2, commitEvidence: commitEvidence() })).toThrow(/applying 阶段/);
  });

  it('unknown 状态禁止；非对应转换不接受额外 fields(复审 R4)', () => {
    expect(() => advanceApplyState(waitingApply(), 'bogus' as never, { now: T1 })).toThrow(/未知/);
    expect(() => advanceApplyState({ ...waitingApply(), state: 'bogus' } as never, 'rejected', { now: T1 })).toThrow(/未知/);
    expect(() => advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-1', failure: 'x' })).toThrow(/额外字段/);
    expect(() => advanceApplyState(waitingApply(), 'rejected', { now: T1, transactionId: 'tx-1' })).toThrow(/额外字段/);
    expect(() => advanceApplyState(waitingApply(), 'skipped', { now: T1, failure: 'x' })).toThrow(/额外字段/);
    expect(() => advanceApplyState(waitingApply(), 'applied', { now: T1, commitEvidence: commitEvidence() })).toThrow(/非法 apply 转换/);
    // rejected/skipped/failed 的合法字段
    expect(advanceApplyState(waitingApply(), 'rejected', { now: T1, failure: '用户拒绝' }).state).toBe('rejected');
    expect(advanceApplyState(waitingApply(), 'skipped', { now: T1 }).state).toBe('skipped');
    const applying = advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-1' });
    const failed = advanceApplyState(applying, 'failed', { now: T2, failure: '超时' });
    expect(failed.state).toBe('failed');
    expect(failed.failure).toBe('超时');
    expect(failed.transactionId).toBe('tx-1');
    expect(() => advanceApplyState(failed, 'waiting_approval', { now: T3 })).toThrow(/非法 apply 转换/);
  });

  it('严格验证 current version/identity/target/hash 与绑定字段(复审 R4)', () => {
    expect(() => advanceApplyState({ ...waitingApply(), version: 2 } as never, 'rejected', { now: T1 })).toThrow(/version/);
    expect(() => advanceApplyState({ ...waitingApply(), applyId: '../x' } as never, 'rejected', { now: T1 })).toThrow(/applyId/);
    expect(() => advanceApplyState({ ...waitingApply(), workflowId: 'bogus' } as never, 'rejected', { now: T1 })).toThrow(/workflowId/);
    expect(() => advanceApplyState({ ...waitingApply(), target: '../evil' } as never, 'rejected', { now: T1 })).toThrow(/target/);
    expect(() => advanceApplyState({ ...waitingApply(), target: '/abs/path' } as never, 'rejected', { now: T1 })).toThrow(/target/);
    expect(() => advanceApplyState({ ...waitingApply(), target: 'a\u0000b' } as never, 'rejected', { now: T1 })).toThrow(/target/);
    expect(() => advanceApplyState({ ...waitingApply(), expectedHash: 'zzz' } as never, 'rejected', { now: T1 })).toThrow(/expectedHash/);
    expect(() => advanceApplyState({ ...waitingApply(), writeSetDigest: 'nope' } as never, 'rejected', { now: T1 })).toThrow(/writeSetDigest/);
    expect(() => advanceApplyState({ ...waitingApply(), artifactHash: 'nope' } as never, 'rejected', { now: T1 })).toThrow(/artifactHash/);
    expect(() => advanceApplyState({ ...waitingApply(), checkpoint: 'nope' } as never, 'rejected', { now: T1 })).toThrow(/checkpoint/);
    expect(() => advanceApplyState({ ...waitingApply(), provenance: '../x' } as never, 'rejected', { now: T1 })).toThrow(/provenance/);
    expect(() => advanceApplyState(waitingApply(), 'rejected', { now: 'bogus' })).toThrow(/updatedAt/);
    expect(() => advanceApplyState(waitingApply(), 'rejected', { now: T1, failure: '' })).toThrow(/failure/);
    expect(() => advanceApplyState(waitingApply(), 'rejected', { now: T1, failure: 'x'.repeat(513) })).toThrow(/failure/);
  });
});

describe('createWorkflowIdentity / createForcedWorkflowIdentity(审查发现 4)', () => {
  it('createWorkflowIdentity 确定性: 同输入同 ID, 与 makeWorkflowId 绑定', () => {
    const a = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: T0 });
    const b = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: T0 });
    expect(a).toEqual(b);
    expect(a.workflowId).toBe(makeWorkflowId('deep-import', sha('input'), 'run-01'));
    expect(a.version).toBe(1);
    expect(() => createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', inputFingerprint: 'zzz' })).toThrow(/inputFingerprint/);
    expect(() => createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: '../x' })).toThrow(/uniqueRunId/);
    expect(() => createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', planDigest: 'nope' })).toThrow(/planDigest/);
  });

  it('force 每次用内部随机/注入 nonce 全新生成不同 ID；同输入递增唯一(复审 R5)', () => {
    let n = 0;
    const uniqueSource = () => `nonce-${++n}`;
    const opts = { ...baseIdentityInput, uniqueRunId: 'run-01', uniqueSource };
    const a = createForcedWorkflowIdentity(opts);
    const b = createForcedWorkflowIdentity(opts);
    expect(a.workflowId).not.toBe(b.workflowId);
    expect(a.workflowId).toContain('run-01-force-nonce-1');
    expect(b.workflowId).toContain('run-01-force-nonce-2');
    // 注入 entropy 可确定验证
    const c = createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', uniqueSource: () => 'n-7' });
    expect(c.workflowId).toBe(makeWorkflowId('deep-import', sha('input'), 'run-01-force-n-7'));
    // 默认 uniqueSource(randomUUID): 两次调用必不同
    const d1 = createForcedWorkflowIdentity(baseIdentityInput);
    const d2 = createForcedWorkflowIdentity(baseIdentityInput);
    expect(d1.workflowId).not.toBe(d2.workflowId);
    expect(() => createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', uniqueSource: () => '../bad' })).toThrow(/nonce/);
    expect(() => createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueSource: 42 } as never)).toThrow(/uniqueSource/);
  });

  it('force 不依赖 existingIds；deterministic ID 存在不拒新 run；expected-absent 唯一权威(复审 R5)', () => {
    const plainId = makeWorkflowId('deep-import', sha('input'), 'run-99');
    let n = 0;
    const f1 = createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-99', uniqueSource: () => `k${++n}` });
    const f2 = createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-99', uniqueSource: () => `k${++n}` });
    // deterministic ID 存在与否都不阻止新 run
    expect(f1.workflowId).not.toBe(plainId);
    expect(f2.workflowId).not.toBe(plainId);
    expect(f1.workflowId).not.toBe(f2.workflowId);
    // expected-absent 是唯一权威
    expect(() => assertExpectedAbsent(f1.workflowId, new Set([f1.workflowId]))).toThrow(/absent/);
    expect(() => assertExpectedAbsent(f1.workflowId, [f1.workflowId])).toThrow(/absent/);
    expect(() => assertExpectedAbsent(f1.workflowId, [])).not.toThrow();
    // 旧选项 existingIds/maxAttempts 一律 fail-closed
    expect(() => createForcedWorkflowIdentity({ ...baseIdentityInput, existingIds: new Set() } as never)).toThrow(/existingIds/);
    expect(() => createForcedWorkflowIdentity({ ...baseIdentityInput, existingIds: [plainId] } as never)).toThrow(/existingIds/);
    expect(() => createForcedWorkflowIdentity({ ...baseIdentityInput, maxAttempts: 16 } as never)).toThrow(/maxAttempts/);
  });

  it('assertExpectedAbsent 门禁', () => {
    const id = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: T0 }).workflowId;
    expect(() => assertExpectedAbsent(id, new Set([id]))).toThrow(/absent/);
    expect(() => assertExpectedAbsent(id, [])).not.toThrow();
  });

  it('记录形 API 输入：可选字段显式 undefined 按缺省处理(加法兼容)；数据面仍拒绝(复审 R1)', () => {
    // identity 可选 createdAt: undefined → 视为缺省
    const a = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: undefined as unknown as string });
    const b = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01' });
    expect(a).toEqual(b);
    const f = createForcedWorkflowIdentity({
      ...baseIdentityInput, uniqueRunId: 'run-01',
      createdAt: undefined as unknown as string, uniqueSource: () => 'n-1',
    });
    expect(f.workflowId).toBe(makeWorkflowId('deep-import', sha('input'), 'run-01-force-n-1'));
    // advanceApplyState 可选 options 字段显式 undefined → 视为未提供
    const applying = advanceApplyState(waitingApply(), 'applying', {
      now: T1, transactionId: 'tx-1', commitEvidence: undefined as unknown as ApplyCommitEvidence,
    });
    expect(applying.transactionId).toBe('tx-1');
    // manifest expected 的 createdAt 显式 undefined → 不要求匹配
    expect(() => assertManifestCompatible(manifest, { ...identity, createdAt: undefined as unknown as string })).not.toThrow();
    // 必需字段 undefined 仍 fail-closed(丢弃后被字段校验拒绝)
    expect(() => createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', kind: undefined as never })).toThrow(/kind/);
    // payload 数据面仍一律拒绝 undefined(不做缺省)
    expect(() => serializeBatchArtifact(p, { a: undefined })).toThrow(/undefined/);
  });
});

describe('readonly 接口与深冻结(审查发现 8)', () => {
  it('构造结果深冻结: plan/receipt/artifact/apply/identity/path/bytes', () => {
    const b = plan();
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.sourceIds)).toBe(true);
    expect(Object.isFrozen(b.sourceHashes)).toBe(true);
    expect(Object.isFrozen(batchPaths('deep-import', b))).toBe(true);

    const receipt = makeBatchReceipt({
      workflowId, batchId: b.batchId, resultHash: sha('x'),
      transactionId: 'tx-01', committedAt: T0,
    });
    expect(Object.isFrozen(receipt)).toBe(true);

    const r = serializeBatchArtifact(b, { list: [{ a: 1 }] });
    expect(Object.isFrozen(r.artifact)).toBe(true);
    expect(Object.isFrozen(r.artifact.payload)).toBe(true);
    const list = (r.artifact.payload as { list: Array<{ a: number }> }).list;
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);

    const applying = advanceApplyState(waitingApply(), 'applying', { now: T1, transactionId: 'tx-apply' });
    expect(Object.isFrozen(applying)).toBe(true);

    const id = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: T0 });
    expect(Object.isFrozen(id)).toBe(true);
    const forced = createForcedWorkflowIdentity({ ...baseIdentityInput, uniqueSource: () => 'f1' });
    expect(Object.isFrozen(forced)).toBe(true);
  });

  it('identity/manifest/bytes 接口 readonly(编译期断言, 运行时不执行)', () => {
    const typeOnly = (): void => {
      const m: WorkflowManifest = manifest;
      // @ts-expect-error readonly
      m.status = 'completed';
      // @ts-expect-error readonly
      m.workflowId = 'x';
      const b = plan();
      // @ts-expect-error readonly
      b.ordinal = 1;
      // @ts-expect-error readonly
      b.sourceIds.push('scene-c');
      const id = createWorkflowIdentity({ ...baseIdentityInput, uniqueRunId: 'run-01', createdAt: T0 });
      // @ts-expect-error readonly
      id.workflowId = 'x';
      const r = serializeBatchArtifact(plan(), { a: 1 });
      const bytes: ReadonlyBytes = r.bytes;
      // @ts-expect-error ReadonlyBytes 无 set/fill 等可变方法
      bytes.set([1]);
      // @ts-expect-error ReadonlyBytes 只读索引
      bytes[0] = 2;
      void m;
      void b;
      void id;
      void bytes;
    };
    expect(typeof typeOnly).toBe('function');
  });
});
