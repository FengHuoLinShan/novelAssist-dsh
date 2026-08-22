/**
 * ADR-0021 §8 / N32 durable transaction intent 存储层的行为契约测试。
 *
 * 覆盖(逐条注释引 N32 / ADR-0021 §8 / R9):
 *   1. 原子 roundtrip: persist → READY 提交点 → 读回规范化 record + 二进制逐字节一致,
 *      无 tmp 残留, list/remove/hasIntent/isIntentReady 一致;
 *   2. tamper: intent.json 篡改(非法 JSON/schema/未知字段/txid 不一致)、目录改名、
 *      blob 字节篡改(哈希核对)、白名单外条目/多余 blob → fail-closed;
 *   3. traversal: 非法 txid(含分隔符/.. /./空/绝对)与越界/非规范化目标路径一律拒绝,
 *      路径拼接前校验;
 *   4. symlink: intent 根/目录/blob/目标路径任一 symlink → INTENT_SYMLINK, 不跟随;
 *   5. 超限: 大小白名单(intent.json / blob / 目标数)经 IntentLimits 覆盖快速触发;
 *   6. 半写: 无 READY 的残留可识别(list valid=false)并被 cleanupIncomplete/removeIntent
 *      安全清理, 已 READY intent 不清理;
 *   7. 字段白名单与内容哈希核对(roundtrip 的失败面)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  persistIntent,
  readIntent,
  readIntentBlob,
  verifyIntentBlobs,
  listIntents,
  cleanupIncomplete,
  removeIntent,
  hasIntent,
  isIntentReady,
  validateTxid,
  validateIntentRecord,
  intentRoot,
  intentDir,
  type IntentRecord,
  type IntentBlobSet,
  type IntentListingEntry,
  INTENT_FILE,
  READY_FILE,
  SNAPSHOTS_DIR,
  OUTPUTS_DIR,
  TRANSACTION_NAMESPACE_DIR,
  INTENT_SCHEMA_VERSION,
  KNOWN_SCHEMA_VERSIONS,
  BLOB_MAX_BYTES,
  MAX_TARGETS,
  TXID_PATTERN,
} from '../src/transaction/intent';
import { sha256Hex } from '../src/hash';
import { tmpVault, initRepo, commitAll } from './helpers';

// 统一 txid 契约(审计): canonical `tx-` + 64 位小写 hex; 测试夹具用可读区分常量。
const TX_A = 'tx-' + 'a'.repeat(64);
const TX_B = 'tx-' + 'b'.repeat(64);
const TX_C = 'tx-' + 'c'.repeat(64);
const TX_D = 'tx-' + 'd'.repeat(64);
const TX_E = 'tx-' + 'e'.repeat(64);
const TX_F = 'tx-' + 'f'.repeat(64);
const TX_W1 = 'tx-' + '1'.repeat(64);
const TX_W2 = 'tx-' + '2'.repeat(64);
const TX_W3 = 'tx-' + '3'.repeat(64);
const TX_OK = 'tx-' + '4'.repeat(64);
const TX_HALF = 'tx-' + '5'.repeat(64);
const TX_ABSENT = 'tx-' + '6'.repeat(64);
const TX_FILE = 'tx-' + '7'.repeat(64);

const cleanups: Array<() => void> = [];

// symlink 探测(Windows 需开发者模式/管理员; 失败则整组跳过, 同 adopt.test.ts)。
const symlinksSupported = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-intent-linkprobe-'));
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
  const { root, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(root); // initVault: 目录树 + book.yml + git init(真实 .git)
  commitAll(root, 'init');
  return root;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeDraft(over: Partial<IntentRecord> = {}): IntentRecord {
  return {
    schema: 1,
    txid: TX_A,
    kind: 'canonical_adopt',
    branch: 'main',
    baseHead: 'a'.repeat(40),
    planDigest: 'b'.repeat(64),
    createdAt: '2026-08-15T00:00:00.000Z',
    targets: [
      { path: 'world/objects/red.md', expected: { kind: 'absent' }, existed: false },
      { path: 'world/objects/blue.md', expected: { kind: 'content', sha256: 'c'.repeat(64) }, existed: true },
    ],
    ...over,
  };
}

function makeBlobs(snaps = ['snap-0', 'snap-1'], outs = ['out-0', 'out-1']): IntentBlobSet {
  return {
    snapshots: snaps.map((s) => Buffer.from(s, 'utf8')),
    outputs: outs.map((s) => Buffer.from(s, 'utf8')),
  };
}

function txDirOf(root: string, txid: string): string {
  return path.join(root, '.git', TRANSACTION_NAMESPACE_DIR, txid);
}

function expectIntentError(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

/** 规范化后的期望 record(persist 写入后应完全一致: 追加计算出的 blob 哈希)。 */
function expectedStoredRecord(blobs: IntentBlobSet, over: Partial<IntentRecord> = {}): IntentRecord {
  const record = makeDraft(over);
  return {
    schema: 1,
    txid: record.txid,
    kind: record.kind,
    baseHead: record.baseHead,
    planDigest: record.planDigest,
    createdAt: record.createdAt,
    branch: record.branch,
    targets: record.targets.map((t, i) => ({
      path: t.path,
      expected: t.expected,
      existed: t.existed,
      snapshotSha256: sha256Hex(blobs.snapshots[i]),
      outputSha256: sha256Hex(blobs.outputs[i]),
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. 原子 roundtrip(N32: intent 耐久化 + READY 提交点 + 读回一致)
// ---------------------------------------------------------------------------

describe('persist/read 原子 roundtrip(ADR-0021 §8 写前耐久化)', () => {
  it('persist 建立 READY 就绪 intent, 读回规范化 record 且二进制逐字节一致', () => {
    const r = fixture();
    const draft = makeDraft();
    const blobs = makeBlobs();
    const txid = persistIntent(r, draft, blobs);

    expect(txid).toBe(TX_A);
    const txDir = txDirOf(r, txid);
    expect(fs.existsSync(txDir)).toBe(true);
    // 布局白名单: 恰好 intent.json / READY / snapshots / outputs, 无 tmp 残留。
    expect(fs.readdirSync(txDir).sort()).toEqual([
      INTENT_FILE,
      READY_FILE,
      OUTPUTS_DIR,
      SNAPSHOTS_DIR,
    ].sort());
    // READY 是提交点标记(普通空文件)。
    expect(fs.lstatSync(path.join(txDir, READY_FILE)).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(txDir, READY_FILE)).length).toBe(0);
    // 二进制按目标下标落盘。
    expect(fs.readFileSync(path.join(txDir, SNAPSHOTS_DIR, '0.bin'), 'utf8')).toBe('snap-0');
    expect(fs.readFileSync(path.join(txDir, OUTPUTS_DIR, '1.bin'), 'utf8')).toBe('out-1');

    // 读回: 规范化 record 与「草案 + persist 计算的 blob 哈希」完全一致。
    const loaded = readIntent(r, txid);
    expect(loaded.record).toEqual(expectedStoredRecord(blobs));
    expect(loaded.dir).toBe(txDir);
    expect(loaded.totalBytes).toBe(Buffer.byteLength('snap-0') * 2 + Buffer.byteLength('out-0') * 2);
    expect(loaded.snapshots.map((e) => e.size)).toEqual(['snap-0', 'snap-1'].map((s) => s.length));
    expect(loaded.outputs.map((e) => e.size)).toEqual(['out-0', 'out-1'].map((s) => s.length));

    // blob 逐字节回读 + 哈希核对。
    expect(readIntentBlob(r, txid, 'snapshots', 0).toString('utf8')).toBe('snap-0');
    expect(readIntentBlob(r, txid, 'outputs', 1).toString('utf8')).toBe('out-1');
    expect(verifyIntentBlobs(r, txid)).toBe(true);

    // 存在性与就绪判定。
    expect(hasIntent(r, txid)).toBe(true);
    expect(isIntentReady(r, txid)).toBe(true);
  });

  it('intent.json 落盘字节是确定性 JSON(schema/字段顺序固定)', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    const json = fs.readFileSync(path.join(txDirOf(r, TX_A), INTENT_FILE), 'utf8');
    expect(JSON.parse(json)).toEqual(expectedStoredRecord(makeBlobs()));
    expect(json).toContain(`"schema":${INTENT_SCHEMA_VERSION}`);
  });

  it('listIntents 只把已 READY 且全量验证通过的条目标 valid=true', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    const entries = listIntents(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: TX_A, validTxid: true, ready: true, valid: true });
  });

  it('同一 txid 重复 persist 一律 INTENT_EXISTS(不覆盖既有/半写, N32 fail-closed)', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    // 既有 READY intent。
    expectIntentError(() => persistIntent(r, makeDraft(), makeBlobs()), 'INTENT_EXISTS');
    expectIntentError(
      () => persistIntent(r, makeDraft({ targets: [] }), { snapshots: [], outputs: [] }),
      'INTENT_EXISTS',
    );
    // 半写残留目录(无 READY)也不覆盖、不隐式清除。
    const stale = path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, TX_B);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'fragment'), 'x');
    expectIntentError(() => persistIntent(r, makeDraft({ txid: TX_B }), makeBlobs()), 'INTENT_EXISTS');
    // 残留原样保留(供恢复路径先收敛)。
    expect(fs.existsSync(path.join(stale, 'fragment'))).toBe(true);
    // 先 cleanup 再 persist 成功。
    expect(cleanupIncomplete(r)).toEqual([TX_B]);
    expect(persistIntent(r, makeDraft({ txid: TX_B }), makeBlobs())).toBe(TX_B);
  });

  it('removeIntent 幂等: 不存在 false, 存在 true 且目录清除', () => {
    const r = fixture();
    expect(removeIntent(r, TX_A)).toBe(false);
    persistIntent(r, makeDraft(), makeBlobs());
    expect(removeIntent(r, TX_A)).toBe(true);
    expect(removeIntent(r, TX_A)).toBe(false);
    expect(hasIntent(r, TX_A)).toBe(false);
    expect(isIntentReady(r, TX_A)).toBe(false);
    expect(listIntents(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. tamper(ADR-0021 §8「恢复验证…先验证, 后动作」——不盲信内容)
// ---------------------------------------------------------------------------

describe('tamper 检测(不盲信 intent 内容)', () => {
  function tamperIntentJson(r: string, mutate: (parsed: Record<string, unknown>) => void): void {
    const f = path.join(txDirOf(r, TX_A), INTENT_FILE);
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
    mutate(parsed);
    fs.writeFileSync(f, JSON.stringify(parsed), 'utf8');
  }

  it('intent.json 非法 JSON → INTENT_BAD_CONTENT', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    fs.writeFileSync(path.join(txDirOf(r, TX_A), INTENT_FILE), '{ not json', 'utf8');
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_BAD_CONTENT');
    expect(listIntents(r)[0]).toMatchObject({ valid: false, ready: true });
  });

  it('未知 schema 版本 → INTENT_INVALID_SCHEMA(版本白名单)', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    tamperIntentJson(r, (p) => {
      p.schema = 99;
    });
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_INVALID_SCHEMA');
  });

  it('未知顶层字段 → INTENT_INVALID_FIELD(字段白名单)', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    tamperIntentJson(r, (p) => {
      (p as Record<string, unknown>).evil = 'payload';
    });
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_INVALID_FIELD');
  });

  it('record.txid 与目录名不一致 → INTENT_INVALID_FIELD', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    tamperIntentJson(r, (p) => {
      p.txid = TX_D;
    });
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_INVALID_FIELD');
  });

  it('intent 目录被改名后按新名读取 → txid 不一致 fail-closed; list 标 invalid', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    fs.renameSync(txDirOf(r, TX_A), txDirOf(r, TX_C));
    expectIntentError(() => readIntent(r, TX_C), 'INTENT_INVALID_FIELD');
    expect(listIntents(r)[0]).toMatchObject({ name: TX_C, valid: false });
  });

  it('blob 字节篡改 → verifyIntentBlobs=false / readIntentBlob 抛 INTENT_BAD_CONTENT', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    const snap0 = path.join(txDirOf(r, TX_A), SNAPSHOTS_DIR, '0.bin');
    fs.writeFileSync(snap0, 'EVIL-BYTES', 'utf8'); // 篡改(同尺寸保护不适用: 内容哈希核对)
    // 元数据层(尺寸/布局)仍通过; 内容层拒绝。
    expect(readIntent(r, TX_A).record.targets[0].snapshotSha256).not.toBe(
      sha256Hex(Buffer.from('EVIL-BYTES', 'utf8')),
    );
    expectIntentError(() => readIntentBlob(r, TX_A, 'snapshots', 0), 'INTENT_BAD_CONTENT');
    expect(verifyIntentBlobs(r, TX_A)).toBe(false);
    // 未篡改的 blob 仍可读。
    expect(readIntentBlob(r, TX_A, 'outputs', 0).toString('utf8')).toBe('out-0');
  });

  it('目录白名单外条目/多余 blob → INTENT_BAD_LAYOUT', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    fs.writeFileSync(path.join(txDirOf(r, TX_A), 'evil'), 'x');
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_BAD_LAYOUT');
    fs.rmSync(path.join(txDirOf(r, TX_A), 'evil'));
    fs.writeFileSync(path.join(txDirOf(r, TX_A), SNAPSHOTS_DIR, '2.bin'), 'x');
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_BAD_LAYOUT');
    fs.rmSync(path.join(txDirOf(r, TX_A), SNAPSHOTS_DIR, '2.bin'));
    fs.rmSync(path.join(txDirOf(r, TX_A), SNAPSHOTS_DIR, '0.bin'));
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_BAD_LAYOUT');
  });

  it('READY 被删 → INTENT_NOT_READY(半写识别); list 标 not-ready', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    fs.rmSync(path.join(txDirOf(r, TX_A), READY_FILE));
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_NOT_READY');
    expect(isIntentReady(r, TX_A)).toBe(false);
    const entry = listIntents(r).find((e) => e.name === TX_A);
    expect(entry).toMatchObject({ ready: false, valid: false });
    expect(entry?.error).toContain('READY');
  });

  it('目标路径被篡改为越界 → INTENT_TRAVERSAL', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    tamperIntentJson(r, (p) => {
      (p.targets as Array<Record<string, unknown>>)[0].path = '../outside.md';
    });
    expectIntentError(() => readIntent(r, TX_A), 'INTENT_TRAVERSAL');
  });
});

// ---------------------------------------------------------------------------
// 3. traversal(N32 / ADR-0021 §8: 拒绝绝对路径、..、路径穿越、非法 txid; R9)
// ---------------------------------------------------------------------------

describe('traversal 白名单(txid + 目标路径)', () => {
  it('非法 txid: 空/./../含分隔符/控制字符/超长/非 canonical → INTENT_INVALID_TXID', () => {
    // fixture() 每次新建完整 git vault: 循环外只建一次(测试只验证 txid 白名单拒绝,
    // vault 根与错误无关; 循环内重建在负载下会超默认 5s 超时)。
    const r = fixture();
    for (const bad of [
      '', '.', '..', '../x', 'a/b', 'a\\b', 'a b', '-tx', '.tx', 'a/b/../../etc', 'x'.repeat(129),
      // 统一契约(审计): 非 canonical tx-64 一律拒绝。
      'tx-0001', 'txn-1', 'a', 'v1.2_x-y', // 旧宽松形态(短/无前缀/._- 组合)
      'tx-' + 'A'.repeat(64), // 大写 hex
      'tx_' + 'a'.repeat(64), // 下划线分隔
      'tx-' + 'z'.repeat(64), // 非 hex
      'tx-' + 'a'.repeat(63), // 63 位
      'tx-' + 'a'.repeat(65), // 65 位
      'a'.repeat(64), // 无 tx- 前缀
    ]) {
      expectIntentError(() => validateTxid(bad), 'INTENT_INVALID_TXID');
      expectIntentError(() => intentDir(r, bad), 'INTENT_INVALID_TXID');
    }
  });

  it('合法 txid(统一契约): canonical tx- + 64 位小写 hex', () => {
    expect(validateTxid(TX_A)).toBe(TX_A);
    expect(validateTxid('tx-' + '0123456789abcdef'.repeat(4))).toBe('tx-' + '0123456789abcdef'.repeat(4));
    expect(TXID_PATTERN.test('tx-' + 'f'.repeat(64))).toBe(true);
  });

  it('persist/remove/read 对非法 txid 在路径拼接前拒绝(无副作用)', () => {
    const r = fixture();
    expectIntentError(() => persistIntent(r, makeDraft({ txid: '../x' }), makeBlobs()), 'INTENT_INVALID_TXID');
    expectIntentError(() => readIntent(r, '../../etc'), 'INTENT_INVALID_TXID');
    expectIntentError(() => removeIntent(r, '/etc/passwd'), 'INTENT_INVALID_TXID');
    // 命名空间未被创建(零副作用)。
    expect(fs.existsSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR))).toBe(false);
  });

  it('目标路径: 绝对路径/../反斜杠/空段/控制字符/超长 → INTENT_TRAVERSAL/TOO_LARGE', () => {
    const r = fixture();
    const badPaths: Array<[string, string]> = [
      ['/etc/passwd', 'INTENT_TRAVERSAL'],
      ['../x.md', 'INTENT_TRAVERSAL'],
      ['a/../b.md', 'INTENT_TRAVERSAL'],
      ['world/objects/./x.md', 'INTENT_TRAVERSAL'],
      ['a//b.md', 'INTENT_TRAVERSAL'],
      ['a\\b.md', 'INTENT_TRAVERSAL'],
      ['a/nul\u0000byte.md', 'INTENT_TRAVERSAL'],
      ['', 'INTENT_TRAVERSAL'],
      ['x'.repeat(1025), 'INTENT_TOO_LARGE'],
    ];
    for (const [p, code] of badPaths) {
      const draft = makeDraft({ targets: [{ path: p, expected: { kind: 'absent' }, existed: false }] });
      expectIntentError(() => persistIntent(r, draft, { snapshots: [Buffer.alloc(0)], outputs: [Buffer.alloc(0)] }), code);
    }
    // 直接 validator 同样拒绝(不依赖 persist)。
    expectIntentError(
      () =>
        validateIntentRecord(makeDraft({ targets: [{ path: '../boss.md', expected: { kind: 'absent' }, existed: false }] })),
      'INTENT_TRAVERSAL',
    );
    // 零副作用: 命名空间下没有可读 intent。
    expect(listIntents(r)).toEqual([]);
  });

  it('合法目标路径(嵌套/中文/CJK 段)正常持久化', () => {
    const r = fixture();
    const draft = makeDraft({
      txid: TX_E,
      targets: [
        { path: 'structure/threads/诡秘之主.md', expected: { kind: 'absent' }, existed: false },
        { path: 'chapters/001.md', expected: { kind: 'content', sha256: 'd'.repeat(64) }, existed: false },
      ],
    });
    persistIntent(r, draft, { snapshots: [Buffer.from('s'), Buffer.from('t')], outputs: [Buffer.from('o'), Buffer.from('p')] });
    const loaded = readIntent(r, TX_E);
    expect(loaded.record.targets.map((t) => t.path)).toEqual(['structure/threads/诡秘之主.md', 'chapters/001.md']);
  });
});

// ---------------------------------------------------------------------------
// 4. symlink(ADR-0021 §8: 拒绝目标或父目录 symlink; R9 不跟随)
// ---------------------------------------------------------------------------

describe('symlink fail-closed(目标或父目录 symlink, 不跟随)', () => {
  const itOrSkip = symlinksSupported ? it : it.skip;

  itOrSkip('intent 根(命名空间)是 symlink → persist/list/remove 一律 INTENT_SYMLINK', () => {
    const r = fixture();
    const ns = path.join(r, '.git', TRANSACTION_NAMESPACE_DIR);
    const outside = path.join(r, '..', `outside-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, ns);
      expectIntentError(() => persistIntent(r, makeDraft(), makeBlobs()), 'INTENT_SYMLINK');
      expectIntentError(() => listIntents(r), 'INTENT_SYMLINK');
      expectIntentError(() => readIntent(r, TX_A), 'INTENT_SYMLINK');
      expectIntentError(() => removeIntent(r, TX_A), 'INTENT_SYMLINK');
      expectIntentError(() => cleanupIncomplete(r), 'INTENT_SYMLINK');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  itOrSkip('intent 目录本身是 symlink(指向外部已 READY 内容) → read/remove 拒绝且不触碰目标', () => {
    const r = fixture();
    fs.mkdirSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR), { recursive: true });
    const outside = path.join(r, '..', `outside-tx-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, READY_FILE), '');
    try {
      fs.symlinkSync(outside, txDirOf(r, TX_A));
      expectIntentError(() => readIntent(r, TX_A), 'INTENT_SYMLINK');
      expectIntentError(() => removeIntent(r, TX_A), 'INTENT_SYMLINK');
      // 链接指向的内容未被删除/未被读取(不跟随)。
      expect(fs.existsSync(path.join(outside, READY_FILE))).toBe(true);
      // list 独立判定: symlink 条目 valid=false 且不删除。
      const entry = listIntents(r).find((e) => e.name === TX_A);
      expect(entry).toMatchObject({ valid: false });
      expect(entry?.error).toContain('symlink');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  itOrSkip('目标文件是 symlink → persist INTENT_SYMLINK(ADR §8 目标 symlink)', () => {
    const r = fixture();
    const real = path.join(r, 'world', 'objects', 'real.md');
    fs.writeFileSync(real, 'real');
    fs.symlinkSync(real, path.join(r, 'world', 'objects', 'red.md'));
    const draft = makeDraft({ targets: [{ path: 'world/objects/red.md', expected: { kind: 'absent' }, existed: false }] });
    expectIntentError(
      () => persistIntent(r, draft, { snapshots: [Buffer.alloc(0)], outputs: [Buffer.alloc(0)] }),
      'INTENT_SYMLINK',
    );
  });

  itOrSkip('blob 目录/文件被替换为 symlink → read INTENT_SYMLINK', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    const txDir = txDirOf(r, TX_A);
    // snapshots/0.bin → 外部普通文件。
    const external = path.join(r, '..', `outside-snap-${Date.now()}`);
    fs.writeFileSync(external, 'x');
    try {
      fs.rmSync(path.join(txDir, SNAPSHOTS_DIR, '0.bin'));
      fs.symlinkSync(external, path.join(txDir, SNAPSHOTS_DIR, '0.bin'));
      expectIntentError(() => readIntent(r, TX_A), 'INTENT_SYMLINK');
      expectIntentError(() => readIntentBlob(r, TX_A, 'snapshots', 0), 'INTENT_SYMLINK');
      // 外部文件未被读取为内容(不跟随)。
      expect(fs.readFileSync(external, 'utf8')).toBe('x');
    } finally {
      fs.rmSync(external, { force: true });
    }
  });

  itOrSkip('.git 本身是 symlink → fail-closed(vault R9 兜底, 不写穿)', () => {
    const r = fixture();
    const outside = path.join(r, '..', `outside-git-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.rmSync(path.join(r, '.git'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(r, '.git'));
      expectIntentError(() => persistIntent(r, makeDraft(), makeBlobs()), 'INTENT_SYMLINK');
      expectIntentError(() => readIntent(r, TX_A), 'INTENT_SYMLINK');
      expectIntentError(() => listIntents(r), 'INTENT_SYMLINK');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 超限(ADR-0021 §8: 字段/大小白名单, 超限 fail-closed)
// ---------------------------------------------------------------------------

describe('大小白名单(超限 fail-closed)', () => {
  it('blob 超过 maxBlobBytes → INTENT_TOO_LARGE', () => {
    const r = fixture();
    const big = Buffer.alloc(9);
    expectIntentError(
      () =>
        persistIntent(
          r,
          makeDraft({ targets: [{ path: 'world/objects/x.md', expected: { kind: 'absent' }, existed: false }] }),
          { snapshots: [big], outputs: [Buffer.alloc(1)] },
          { maxBlobBytes: 8 },
        ),
      'INTENT_TOO_LARGE',
    );
    // 默认上限常量同样生效(16 MiB + 1)。
    const huge = Buffer.alloc(BLOB_MAX_BYTES + 1);
    expectIntentError(
      () =>
        persistIntent(
          r,
          makeDraft({ targets: [{ path: 'world/objects/x.md', expected: { kind: 'absent' }, existed: false }] }),
          { snapshots: [huge], outputs: [Buffer.alloc(1)] },
        ),
      'INTENT_TOO_LARGE',
    );
    // 零副作用(第一个失败后命名空间仍空)。
    expect(listIntents(r)).toEqual([]);
  });

  it('intent.json 超过 maxIntentBytes → INTENT_TOO_LARGE(写入前拒绝)', () => {
    const r = fixture();
    expectIntentError(
      () => persistIntent(r, makeDraft(), makeBlobs(), { maxIntentBytes: 64 }),
      'INTENT_TOO_LARGE',
    );
    expect(listIntents(r)).toEqual([]);
  });

  it('targets 数超过 maxTargets(常量)→ INTENT_TOO_LARGE', () => {
    const r = fixture();
    const many = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => ({
      path: `world/objects/obj-${i}.md`,
      expected: { kind: 'absent' as const },
      existed: false,
    }));
    expectIntentError(() => validateIntentRecord(makeDraft({ targets: many })), 'INTENT_TOO_LARGE');
    // 上限内合法(targets=MAX_TARGETS, 空字节 blob)。
    const cap = MAX_TARGETS;
    const targets = Array.from({ length: cap }, (_, i) => ({
      path: `world/objects/obj-${i}.md`,
      expected: { kind: 'absent' as const },
      existed: false,
    }));
    const record = validateIntentRecord(makeDraft({ targets }));
    expect(record.targets).toHaveLength(cap);
  });

  it('read 侧同样执行大小白名单(覆盖上限 → INTENT_TOO_LARGE)', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    expectIntentError(() => readIntent(r, TX_A, { maxIntentBytes: 64 }), 'INTENT_TOO_LARGE');
    expectIntentError(() => readIntentBlob(r, TX_A, 'snapshots', 0, { maxBlobBytes: 4 }), 'INTENT_TOO_LARGE');
    // 未覆盖时读取正常(上限宽松实例)。
    expect(readIntentBlob(r, TX_A, 'snapshots', 1, { maxBlobBytes: BLOB_MAX_BYTES }).toString('utf8')).toBe('snap-1');
  });
});

// ---------------------------------------------------------------------------
// 6. 半写(ADR-0021 §8: 无就绪标记 = 半写残留, 恢复时忽略并清理, 视为未开始)
// ---------------------------------------------------------------------------

describe('半写无 READY 可识别清理', () => {
  it('cleanupIncomplete 清理无 READY 残留; 已 READY intent 原样保留', () => {
    const r = fixture();
    persistIntent(r, makeDraft({ txid: TX_F }), makeBlobs());
    // 半写残留: 无 READY(模拟崩溃于 intent 写入之中)。
    const wrecks = [TX_W1, TX_W2];
    for (const w of wrecks) {
      const dir = txDirOf(r, w);
      fs.mkdirSync(path.join(dir, SNAPSHOTS_DIR), { recursive: true });
      fs.writeFileSync(path.join(dir, SNAPSHOTS_DIR, '0.bin.tmp-abc'), 'half');
      fs.writeFileSync(path.join(dir, 'intent.json.tmp-def'), 'half-json');
    }
    // 白名单外条目(非法目录名/普通文件)不识别、不清理。
    fs.mkdirSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, 'evil!name'));
    fs.writeFileSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, 'notes.txt'), 'x');

    const removed = cleanupIncomplete(r);
    expect(removed.sort()).toEqual(wrecks.sort());
    for (const w of wrecks) expect(fs.existsSync(txDirOf(r, w))).toBe(false);
    // 已 READY 的 intent 与白名单外条目未被触碰。
    expect(fs.existsSync(txDirOf(r, TX_F))).toBe(true);
    expect(isIntentReady(r, TX_F)).toBe(true);
    expect(fs.existsSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, 'evil!name'))).toBe(true);
    expect(fs.existsSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, 'notes.txt'))).toBe(true);
  });

  it('removeIntent 可直接移除半写残留(先验证 txid/目录类型, 再删除)', () => {
    const r = fixture();
    const dir = txDirOf(r, TX_W3);
    fs.mkdirSync(path.join(dir, OUTPUTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, OUTPUTS_DIR, '0.bin.tmp-1'), 'half');
    expect(removeIntent(r, TX_W3)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('无命名空间/清空后 cleanupIncomplete 幂等返回空', () => {
    const r = fixture();
    expect(cleanupIncomplete(r)).toEqual([]);
    expect(listIntents(r)).toEqual([]);
  });

  it('半写残留被 list 标 invalid(not-ready), 恢复入口可据此先收敛再开新事务', () => {
    const r = fixture();
    persistIntent(r, makeDraft({ txid: TX_OK }), makeBlobs());
    const dir = txDirOf(r, TX_HALF);
    fs.mkdirSync(dir, { recursive: true });
    const entries: IntentListingEntry[] = listIntents(r);
    expect(entries.find((e) => e.name === TX_HALF)).toMatchObject({ ready: false, valid: false });
    expect(entries.find((e) => e.name === TX_OK)).toMatchObject({ ready: true, valid: true });
  });
});

// ---------------------------------------------------------------------------
// 7. 字段白名单与内容哈希核对(roundtrip 的失败面; N32 结构可信)
// ---------------------------------------------------------------------------

describe('字段白名单与内容哈希', () => {
  it('顶层/目标/期望未知字段或错误类型 → INTENT_INVALID_FIELD', () => {
    const r = fixture();
    const cases: Array<{ name: string; draft: IntentRecord }> = [];
    // 未知顶层字段: 构造一个带额外键的对象。
    const extraTop = { ...makeDraft(), zzz: 1 } as unknown as IntentRecord;
    cases.push({ name: '未知顶层字段', draft: extraTop });
    const extraTarget = makeDraft({
      targets: [
        { path: 'world/objects/a.md', expected: { kind: 'absent' }, existed: false, evil: 1 } as never,
      ],
    });
    cases.push({ name: '未知 target 字段', draft: extraTarget });
    const badExpected = makeDraft({
      targets: [{ path: 'world/objects/a.md', expected: { kind: 'maybe' } as never, existed: false }],
    });
    cases.push({ name: '未知 expected.kind', draft: badExpected });
    const badType = makeDraft({
      targets: [{ path: 'world/objects/a.md', expected: { kind: 'content', sha256: 'not-hex' }, existed: true }],
    });
    cases.push({ name: 'sha256 非 hex', draft: badType });
    const badExisted = makeDraft({
      targets: [{ path: 'world/objects/a.md', expected: { kind: 'absent' }, existed: 1 } as never],
    });
    cases.push({ name: 'existed 非布尔', draft: badExisted });
    const badBase = makeDraft({ baseHead: 'abc' });
    cases.push({ name: 'baseHead 非 40-hex', draft: badBase });
    const badDigest = makeDraft({ planDigest: 'z'.repeat(64) });
    cases.push({ name: 'planDigest 非 hex', draft: badDigest });
    const badKind = makeDraft({ kind: 'Canonical' });
    cases.push({ name: 'kind 白名单外', draft: badKind });
    const badBranch = makeDraft({ branch: '-force' });
    cases.push({ name: 'branch 形态非法', draft: badBranch });
    const badCreated = makeDraft({ createdAt: 'not-a-date' });
    cases.push({ name: 'createdAt 不可解析', draft: badCreated });
    const nonObject = { ...makeDraft(), targets: 'x' } as unknown as IntentRecord;
    cases.push({ name: 'targets 非数组', draft: nonObject });

    for (const c of cases) {
      expectIntentError(() => validateIntentRecord(c.draft), 'INTENT_INVALID_FIELD',);
    }
    // persist 侧(含路径校验)同样 fail-closed。
    expectIntentError(() => persistIntent(r, badExpected, makeBlobs()), 'INTENT_INVALID_FIELD');
    // schema 类型非法 → INTENT_INVALID_SCHEMA。
    const badSchema = { ...makeDraft(), schema: '1' } as unknown as IntentRecord;
    expectIntentError(() => validateIntentRecord(badSchema), 'INTENT_INVALID_SCHEMA');
    expect(KNOWN_SCHEMA_VERSIONS).toContain(INTENT_SCHEMA_VERSION);
  });

  it('blob 数量与 targets 不对齐 → INTENT_INVALID_FIELD', () => {
    const r = fixture();
    expectIntentError(
      () => persistIntent(r, makeDraft(), { snapshots: [Buffer.from('a')], outputs: [] }),
      'INTENT_INVALID_FIELD',
    );
    expectIntentError(
      () => persistIntent(r, makeDraft(), { snapshots: [], outputs: [Buffer.from('a'), Buffer.from('b')] }),
      'INTENT_INVALID_FIELD',
    );
  });

  it('调用方自带 blob 哈希与实际字节不符 → INTENT_BAD_CONTENT(不盲信声明)', () => {
    const r = fixture();
    const wrongHash = makeDraft({
      targets: [
        { path: 'world/objects/a.md', expected: { kind: 'absent' }, existed: false, snapshotSha256: 'f'.repeat(64) },
        { path: 'world/objects/b.md', expected: { kind: 'content', sha256: 'c'.repeat(64) }, existed: true },
      ],
    });
    expectIntentError(() => persistIntent(r, wrongHash, makeBlobs()), 'INTENT_BAD_CONTENT');
    // 自带正确哈希 → 通过与计算值一致。
    const blobs = makeBlobs();
    const correctHash = makeDraft({
      targets: [
        {
          path: 'world/objects/a.md',
          expected: { kind: 'absent' },
          existed: false,
          snapshotSha256: sha256Hex(blobs.snapshots[0]),
          outputSha256: sha256Hex(blobs.outputs[0]),
        },
        {
          path: 'world/objects/b.md',
          expected: { kind: 'content', sha256: 'c'.repeat(64) },
          existed: true,
          snapshotSha256: sha256Hex(blobs.snapshots[1]),
          outputSha256: sha256Hex(blobs.outputs[1]),
        },
      ],
    });
    persistIntent(r, correctHash, blobs);
    expect(verifyIntentBlobs(r, TX_A)).toBe(true);
  });

  it('blob 下标越界/非法 → INTENT_BAD_LAYOUT', () => {
    const r = fixture();
    persistIntent(r, makeDraft(), makeBlobs());
    expectIntentError(() => readIntentBlob(r, TX_A, 'snapshots', 2), 'INTENT_BAD_LAYOUT');
    expectIntentError(() => readIntentBlob(r, TX_A, 'outputs', -1), 'INTENT_BAD_LAYOUT');
    expectIntentError(() => readIntentBlob(r, TX_A, 'outputs', 1.5), 'INTENT_BAD_LAYOUT');
  });

  it('非仓库根(缺 .git)→ INTENT_NOT_REPO; 空根 namespace 不存在时 list 返回空', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-intent-bare-'));
    cleanups.push(() => fs.rmSync(bare, { recursive: true, force: true }));
    expectIntentError(() => persistIntent(bare, makeDraft(), makeBlobs()), 'INTENT_NOT_REPO');
    expectIntentError(() => readIntent(bare, TX_A), 'INTENT_NOT_REPO');
    // list: 非仓库且无 .git = 无 intent 命名空间(返回空, 不抛)。
    expect(listIntents(bare)).toEqual([]);
  });

  it('intentRoot/intentDir 布局常量一致(.git/novelcraft-transactions/<txid>)', () => {
    const r = fixture();
    expect(intentRoot(r)).toBe(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR));
    expect(intentDir(r, TX_A)).toBe(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, TX_A));
  });
});

describe('非仓库根(缺 .git)→ intent 根判定', () => {
  it('readIntent 对不存在 intent → INTENT_NOT_FOUND; 对非法布局(txid 是文件)拒绝', () => {
    const r = fixture();
    expectIntentError(() => readIntent(r, TX_ABSENT), 'INTENT_NOT_FOUND');
    // txid 名被普通文件占用 → BAD_LAYOUT(不盲信)。
    fs.mkdirSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR), { recursive: true });
    fs.writeFileSync(path.join(r, '.git', TRANSACTION_NAMESPACE_DIR, TX_FILE), 'x');
    expectIntentError(() => readIntent(r, TX_FILE), 'INTENT_BAD_LAYOUT');
    expect(listIntents(r)[0]).toMatchObject({ name: TX_FILE, valid: false });
  });
});
// ---------------------------------------------------------------------------
// 13. intent 生产链 plain-data 门禁(复审 Blocker: 拒 Proxy/accessor/class)
// ---------------------------------------------------------------------------

describe('intent 生产链 plain-data 门禁(复审 Blocker: Proxy/accessor/class fail-closed)', () => {
  it('persistIntent 拒 Proxy draft: 任何 getter 都不被触发(INTENT_INVALID_FIELD)', () => {
    const r = fixture();
    const draft = makeDraft();
    let gets = 0;
    const proxyDraft = new Proxy(draft, {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        gets += 1;
        return Reflect.ownKeys(target);
      },
    });
    expectIntentError(() => persistIntent(r, proxyDraft as IntentRecord, makeBlobs()), 'INTENT_INVALID_FIELD');
    expect(gets).toBe(0); // isProxy 在一切属性访问之前判定
    expectIntentError(() => persistIntent(r, proxyDraft as IntentRecord, makeBlobs()), 'INTENT_INVALID_FIELD');
    // 无 READY、无 intent 目录残留(零副作用)。
    expect(listIntents(r)).toEqual([]);
  });

  it('persistIntent 拒 accessor draft 与类实例 draft(非 plain JSON)', () => {
    const r = fixture();
    let touched = false;
    const accessorDraft: IntentRecord = {
      schema: 1,
      txid: TX_A,
      kind: 'canonical_adopt',
      baseHead: 'a'.repeat(40),
      planDigest: 'b'.repeat(64),
      createdAt: '2026-08-15T00:00:00.000Z',
      targets: [
        { path: 'world/objects/red.md', expected: { kind: 'absent' }, existed: false },
      ],
    };
    Object.defineProperty(accessorDraft, 'targets', {
      get() {
        touched = true;
        return [{ path: 'world/objects/red.md', expected: { kind: 'absent' }, existed: false }];
      },
      enumerable: true,
      configurable: true,
    });
    expectIntentError(() => persistIntent(r, accessorDraft, makeBlobs(['s'], ['o'])), 'INTENT_INVALID_FIELD');
    expect(touched).toBe(false); // accessor 描述符在读取前被拒

    class DraftLike {
      schema = 1;
      txid = TX_A;
      kind = 'canonical_adopt';
      baseHead = 'a'.repeat(40);
      planDigest = 'b'.repeat(64);
      createdAt = '2026-08-15T00:00:00.000Z';
      targets = [{ path: 'world/objects/red.md', expected: { kind: 'absent' }, existed: false }];
    }
    expectIntentError(() => persistIntent(r, new DraftLike() as unknown as IntentRecord, makeBlobs(['s'], ['o'])), 'INTENT_INVALID_FIELD');
    expect(listIntents(r)).toEqual([]);
  });
});
