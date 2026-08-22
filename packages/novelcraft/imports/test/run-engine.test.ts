// N33 / ADR-0022 — 通用 run engine 行为契约(in-memory crash injection)。
// 覆盖: 确定性 manifest/batches 与 state transaction 顺序、provider outcome unknown 写状态
// 后停止且绝不自动 retry、resume 严格兼容/校验已完成 artifact hash/receipt/cursor、
// 从首不完整继续、force 新 identity+expected-absent、artifact 损坏 fail-closed、
// apply 状态机(waiting→applying(transactionId durable 先写)→applied(commitEvidence 绑定))
// 与 transaction probe 崩溃恢复(completed 补状态 / none 持久回 waiting 重新审批 / unknown
// 绝不盲重写)、manifest 无 secret、深冻结。
import { describe, expect, it } from 'vitest';
import type { ApprovalDecision } from '@novelcraft/trace';
import {
  ApplyCanonicalError,
  applyIdFor,
  applyTransactionId,
  batchPaths,
  canonicalRunJson,
  createWorkflowIdentity,
  makeBatchPlan,
  planDigestOf,
  runWorkflow,
  workflowSha256,
  type ApplyApprovalRequest,
  type ApplyCanonicalRequest,
  type ApplyProbe,
  type RunApplyPort,
  type RunEnginePorts,
  type RunEngineResult,
  type RunEngineSpec,
  type RunGeneratorInput,
  type RunGeneratorOutput,
  type RunGeneratorPort,
  type RunPersistencePort,
  type RunStateTransaction,
  type RunWorkflowManifest,
  type ReadonlyBytes,
} from '../src/index.js';

const sha = (x: string) => workflowSha256(x);
const EMPTY_HASH = sha('');

class EngineCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineCrash';
  }
}

function bytesEqual(a: ReadonlyBytes, b: ReadonlyBytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// —— in-memory persistence port: 每次 applyState = 一个 state transaction ——
class InMemoryRunStore implements RunPersistencePort {
  files = new Map<string, Uint8Array>();
  runIds = new Set<string>();
  manifests = new Map<string, RunWorkflowManifest>();
  runPlans = new Map<string, ReadonlyBytes>();
  intents = new Map<string, { workflowId: string; txid: string; tx: RunStateTransaction; createdAt: string }>();
  committedTxs = new Set<string>();
  txCalls = 0;
  fileWriteLog: string[] = [];
  stateTxLog: string[] = [];
  crash: { atTx: number; step: 'mid-artifact' | 'mid-receipt' | 'after-commit' } | undefined;

  async hasRun(workflowId: string): Promise<boolean> {
    return this.runIds.has(workflowId);
  }

  async loadRunState(workflowId: string): Promise<{
    manifest?: RunWorkflowManifest;
    runPlan?: ReadonlyBytes;
    intents: ReadonlyArray<{ txid: string; tx: RunStateTransaction; createdAt: string }>;
  }> {
    return {
      manifest: this.manifests.get(workflowId),
      runPlan: this.runPlans.get(workflowId),
      intents: [...this.intents.values()].filter((i) => i.workflowId === workflowId),
    };
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path);
  }

  async applyState(tx: RunStateTransaction): Promise<RunWorkflowManifest> {
    this.txCalls++;
    this.stateTxLog.push(tx.kind);
    if (this.intents.has(tx.txid)) return this.completeIntent(tx); // 补完同一事务
    if (this.committedTxs.has(tx.txid)) return this.manifests.get(tx.workflowId)!; // 幂等去重
    if (this.crash !== undefined && this.txCalls === this.crash.atTx) {
      if (this.crash.step === 'after-commit') {
        this.commitFresh(tx); // 事务完全提交后"进程死亡"(窗口二)
      } else {
        this.persistIntent(tx, this.crash.step); // intent 先耐久化, 再部分写入, 然后"进程死亡"
      }
      throw new EngineCrash(`injected crash at state tx #${this.txCalls}`);
    }
    this.commitFresh(tx);
    return this.manifests.get(tx.workflowId)!;
  }

  /** 崩溃中间态: 先耐久化 intent(含计划输出), 再按 step 写入部分文件。 */
  private persistIntent(tx: RunStateTransaction, step: 'mid-artifact' | 'mid-receipt' | 'after-commit'): void {
    this.intents.set(tx.txid, { workflowId: tx.workflowId, txid: tx.txid, tx, createdAt: new Date().toISOString() });
    if (tx.kind === 'artifact-receipt') {
      this.writeFile(tx.artifactPath, tx.artifactBytes); // 先 artifact
      if (step !== 'mid-artifact') this.writeFile(tx.receiptPath, tx.receiptBytes); // 再 receipt
      // manifest 未更新(batch 仍 planned, 属正常 stale)
    }
    // 其余 kind: 仅 intent(无文件副作用)
  }

  /** 窗口一恢复: BEFORE→OUTPUT / OUTPUT 复用 / CONFLICT 保留现场 fail-closed。 */
  private completeIntent(tx: RunStateTransaction): RunWorkflowManifest {
    const planned: Array<[string, ReadonlyBytes]> = [];
    if (tx.kind === 'batch-plan') planned.push([tx.path, tx.bytes]);
    if (tx.kind === 'artifact-receipt') {
      planned.push([tx.artifactPath, tx.artifactBytes], [tx.receiptPath, tx.receiptBytes]);
    }
    for (const [path, bytes] of planned) {
      const existing = this.files.get(path);
      if (existing === undefined) this.writeFile(path, bytes); // BEFORE → OUTPUT
      else if (!bytesEqual(existing, bytes)) {
        throw new Error(`CONFLICT: ${path} 与 intent 计划输出不符, 保留现场 fail-closed`);
      }
    }
    this.commitCommon(tx);
    return this.manifests.get(tx.workflowId)!;
  }

  private commitFresh(tx: RunStateTransaction): void {
    if (tx.kind === 'batch-plan') this.writeFile(tx.path, tx.bytes);
    if (tx.kind === 'artifact-receipt') {
      this.writeFile(tx.artifactPath, tx.artifactBytes); // 先 artifact
      this.writeFile(tx.receiptPath, tx.receiptBytes); // 后 receipt
    }
    this.commitCommon(tx);
  }

  private commitCommon(tx: RunStateTransaction): void {
    if (tx.kind === 'bootstrap') {
      this.runIds.add(tx.workflowId);
      this.runPlans.set(tx.workflowId, tx.runPlan);
    }
    this.manifests.set(tx.workflowId, tx.manifest);
    this.intents.delete(tx.txid);
    this.committedTxs.add(tx.txid);
  }

  private writeFile(path: string, bytes: ReadonlyBytes): void {
    this.fileWriteLog.push(path);
    this.files.set(path, Uint8Array.from(bytes));
  }
}

class MockGenerator implements RunGeneratorPort {
  calls: Array<{ input: RunGeneratorInput; txCalls: number }> = [];
  fail = new Set<string>();

  constructor(private readonly store: InMemoryRunStore) {}

  async generate(input: RunGeneratorInput): Promise<RunGeneratorOutput> {
    this.calls.push({ input, txCalls: this.store.txCalls });
    if (this.fail.has(input.batchId)) throw new Error(`generator failure: ${input.batchId}`);
    const attempt = this.calls.filter((c) => c.input.batchId === input.batchId).length;
    return { payload: { text: `output-${input.batchId}-${attempt}`, attempt } };
  }

  batchIds(): string[] {
    return this.calls.map((c) => c.input.batchId);
  }
}

class MemoryCanonical implements RunApplyPort {
  approvals: ApplyApprovalRequest[] = [];
  executes: ApplyCanonicalRequest[] = [];
  probes: string[] = [];
  workspace = new Map<string, Uint8Array>();
  canonical = new Map<string, ApplyProbe>();
  crashAfterExecute = false;
  private decisions: ApprovalDecision[];

  constructor(decisions: readonly ApprovalDecision[]) {
    this.decisions = [...decisions];
  }

  async requestApproval(input: ApplyApprovalRequest): Promise<ApprovalDecision> {
    this.approvals.push(input);
    return this.decisions.shift() ?? 'unavailable'; // fail-closed
  }

  async execute(input: ApplyCanonicalRequest): Promise<{ commitOid: string }> {
    this.executes.push(input);
    const current = this.workspace.get(input.target) ?? new Uint8Array(0);
    if (workflowSha256(current) !== input.expectedHash) {
      throw new ApplyCanonicalError('cas', `CAS 基线不符: ${input.target}`);
    }
    const bytes = Buffer.from(
      `${canonicalRunJson({ applyId: input.applyId, transactionId: input.transactionId, artifactHash: input.artifactHash })}\n`,
      'utf8',
    );
    this.workspace.set(input.target, bytes);
    const commitOid = workflowSha256(canonicalRunJson({ transactionId: input.transactionId, target: input.target, bytes: bytes.toString('utf8') }));
    this.canonical.set(input.transactionId, { state: 'completed', commitOid });
    if (this.crashAfterExecute) throw new EngineCrash('crash after canonical commit');
    return { commitOid };
  }

  async probe(transactionId: string): Promise<ApplyProbe> {
    this.probes.push(transactionId);
    return this.canonical.get(transactionId) ?? { state: 'none' };
  }
}

// —— 夹具 ——
function spec(overrides: Partial<RunEngineSpec> = {}): RunEngineSpec {
  return {
    kind: 'deep-import',
    inputFingerprint: sha('input-v1'),
    profileFingerprint: sha('profile-gpt'),
    uniqueRunId: 'run-01',
    batches: [
      { phase: 'slice', ordinal: 0, sourceIds: ['ch-1'], sourceHashes: { 'ch-1': sha('ch1') } },
      { phase: 'entities', ordinal: 1, sourceIds: ['scene-a'], sourceHashes: { 'scene-a': sha('a') } },
    ],
    ...overrides,
  };
}

function specWithApply(overrides: Partial<RunEngineSpec> = {}): RunEngineSpec {
  return spec({
    batches: [
      {
        phase: 'slice', ordinal: 0, sourceIds: ['ch-1'], sourceHashes: { 'ch-1': sha('ch1') },
        apply: { target: 'content/scenes/ch1.md', expectedHash: EMPTY_HASH },
      },
      { phase: 'entities', ordinal: 1, sourceIds: ['scene-a'], sourceHashes: { 'scene-a': sha('a') } },
    ],
    ...overrides,
  });
}

const expectedFor = (s: RunEngineSpec) => ({
  workflowId: workflowIdOf(s),
  kind: s.kind,
  inputFingerprint: s.inputFingerprint,
  profileFingerprint: s.profileFingerprint,
  planDigest: planDigestOf(s),
});

function portsOf(store: InMemoryRunStore, gen: MockGenerator, apply?: MemoryCanonical): RunEnginePorts {
  return { persistence: store, generator: gen, ...(apply !== undefined ? { apply } : {}) };
}

function orderedBatchIds(result: RunEngineResult): string[] {
  return Object.values(result.manifest.batches).sort((a, b) => a.ordinal - b.ordinal).map((b) => b.batchId);
}

function batchIdOf(s: RunEngineSpec, ordinal: number): string {
  const batch = s.batches.find((b) => b.ordinal === ordinal)!;
  const plan = makeBatchPlan({
    workflowId: `imp-${s.inputFingerprint.slice(0, 16)}-${s.uniqueRunId}`,
    phase: batch.phase,
    ordinal: batch.ordinal,
    inputFingerprint: s.inputFingerprint,
    sourceIds: batch.sourceIds,
    sourceHashes: batch.sourceHashes,
  });
  return plan.batchId;
}

function workflowIdOf(s: RunEngineSpec): string {
  return createWorkflowIdentity({
    kind: s.kind,
    inputFingerprint: s.inputFingerprint,
    profileFingerprint: s.profileFingerprint,
    planDigest: planDigestOf(s),
    uniqueRunId: s.uniqueRunId,
  }).workflowId;
}

describe('run engine 全流程与确定性', () => {
  it('确定性 manifest/batches; bootstrap → plan → artifact → receipt → cursor 顺序; artifact 先于 receipt; 深冻结', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const result = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    expect(result.status).toBe('completed');
    const [b1, b2] = orderedBatchIds(result);
    expect(result.completedBatchIds).toEqual([b1, b2]);
    expect(result.remainingBatchIds).toEqual([]);
    expect(result.providerOutcomeUnknown).toEqual([]);
    // 每次持久化调用 = 一个 state transaction, 顺序: plan → artifact(+receipt) → cursor, 逐批
    expect(result.stateTxLog).toEqual([
      'bootstrap',
      `plan:${b1}`, `artifact:${b1}`, `cursor:${b1}`,
      `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`,
      'run-status:completed',
    ]);
    // artifact bytes 与 receipt 分离, 且先 artifact 后 receipt(port 文件写序)
    const entry = result.manifest.batches[b1];
    expect(store.fileWriteLog.indexOf(entry.artifactPath)).toBeLessThan(store.fileWriteLog.indexOf(entry.receiptPath));
    expect(bytesEqual(store.files.get(entry.artifactPath)!, store.files.get(entry.receiptPath)!)).toBe(false);
    // 批次计划先行提交: provider 调用前该批 plan 已提交(此处 = 已 commit 的 state tx)
    expect(gen.calls[0].txCalls).toBe(2); // bootstrap + plan:b1
    expect(gen.calls[1].txCalls).toBe(5); // bootstrap + 3×b1 + plan:b2
    // artifact 自描述且不含自身 hash(无自引用); 对精确字节重算 hash === receipt observed
    const artifact = JSON.parse(Buffer.from(store.files.get(entry.artifactPath)!).toString('utf8'));
    expect(artifact.batchId).toBe(entry.batchId);
    expect(artifact.workflowId).toBe(result.workflowId);
    expect(JSON.stringify(artifact)).not.toContain(entry.resultHash!);
    expect(workflowSha256(store.files.get(entry.artifactPath)!)).toBe(entry.resultHash);
    const receipt = JSON.parse(Buffer.from(store.files.get(entry.receiptPath)!).toString('utf8'));
    expect(receipt.resultHash).toBe(entry.resultHash);
    // cursor = 最后一个已完成批次
    expect(result.manifest.cursor).toEqual({ phase: result.manifest.batches[b2].phase, ordinal: 1 });
    // 深冻结
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.stateTxLog)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.batches)).toBe(true);
    expect(Object.isFrozen(result.manifest.batches[b1])).toBe(true);
    // 确定性: 同 spec 恒同 workflowId/planDigest/batchIds(新 store 新 run, 不覆盖旧 run)
    const store2 = new InMemoryRunStore();
    const gen2 = new MockGenerator(store2);
    const r2 = await runWorkflow(portsOf(store2, gen2), { mode: 'start', spec: s });
    expect(r2.workflowId).toBe(result.workflowId);
    expect(r2.manifest.planDigest).toBe(result.manifest.planDigest);
    expect(Object.keys(r2.manifest.batches).sort()).toEqual(Object.keys(result.manifest.batches).sort());
    expect(orderedBatchIds(r2)).toEqual([b1, b2]);
  });
});

describe('provider outcome unknown: 写状态后停止, 绝不自动 retry', () => {
  it('generator 抛错 → 写 provider_outcome_unknown 后停止; resume 无授权不重调; 授权后才重试', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    gen.fail.add(batchIdOf(s, 0)); // b1 结果未知
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    const [b1, b2] = orderedBatchIds(r1);
    expect(r1.status).toBe('provider_outcome_unknown');
    expect(r1.providerOutcomeUnknown).toEqual([b1]);
    expect(r1.remainingBatchIds).toEqual([b1, b2]);
    expect(r1.manifest.status).toBe('provider_outcome_unknown');
    expect(r1.stateTxLog).toEqual(['bootstrap', `plan:${b1}`, 'run-status:provider_outcome_unknown']);
    // 绝不自动 retry: 即使 provider 已恢复, resume 仍写状态后停止
    gen.fail.clear();
    const r2 = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: r1.workflowId, expected: expectedFor(s) });
    expect(r2.status).toBe('provider_outcome_unknown');
    expect(gen.calls).toHaveLength(1); // 不重调
    expect(r2.stateTxLog).toEqual([]); // 状态已写, 幂等停止
    // 显式重新授权后才重试该批
    const r3 = await runWorkflow(portsOf(store, gen), {
      mode: 'resume', workflowId: r1.workflowId, expected: expectedFor(s), retryOutcomeUnknown: true,
    });
    expect(r3.status).toBe('completed');
    expect(gen.batchIds()).toEqual([b1, b1, b2]);
    expect(r3.completedBatchIds).toEqual([b1, b2]);
  });

  it('窗口〇: plan 提交后崩溃 → resume 判定 provider_outcome_unknown, 不重调; 授权后续跑', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    store.crash = { atTx: 2, step: 'after-commit' }; // bootstrap + plan:b1 后"进程死亡"
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    expect(gen.calls).toHaveLength(0); // provider 从未被调用
    const wfId = workflowIdOf(s);
    const r = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('provider_outcome_unknown');
    expect(r.providerOutcomeUnknown).toEqual([batchIdOf(s, 0)]);
    expect(gen.calls).toHaveLength(0);
    const r2 = await runWorkflow(portsOf(store, gen), {
      mode: 'resume', workflowId: wfId, expected: expectedFor(s), retryOutcomeUnknown: true,
    });
    expect(r2.status).toBe('completed');
    expect(gen.batchIds()).toEqual([batchIdOf(s, 0), batchIdOf(s, 1)]);
  });
});

describe('崩溃窗口恢复: 绝不重跑已产出有效 artifact 的批', () => {
  it('窗口一: artifact-receipt 事务中途崩溃(artifact 已写、receipt/manifest 未写)→ 补完同一事务, 不重调 provider', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    store.crash = { atTx: 3, step: 'mid-artifact' }; // artifact 落盘后、receipt 前崩溃
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const b1 = batchIdOf(s, 0);
    const paths = batchPaths('deep-import', makeBatchPlan({
      workflowId: wfId, phase: 'slice', ordinal: 0, inputFingerprint: s.inputFingerprint,
      sourceIds: ['ch-1'], sourceHashes: { 'ch-1': sha('ch1') },
    }));
    // 现场: artifact 已写、receipt 未写、manifest stale(batch 仍 planned)
    expect(store.files.get(paths.artifactPath)).toBeDefined();
    expect(store.files.get(paths.receiptPath)).toBeUndefined();
    const r = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('completed');
    expect(r.stateTxLog[0]).toBe(`recover:artifact-receipt:${b1}`); // 收敛先于一切
    expect(gen.batchIds()).toEqual([b1, batchIdOf(s, 1)]); // b1 绝不重调
    // receipt 已补写且与 artifact 精确字节 hash 一致
    const receipt = JSON.parse(Buffer.from(store.files.get(paths.receiptPath)!).toString('utf8'));
    expect(receipt.batchId).toBe(b1);
    expect(receipt.resultHash).toBe(workflowSha256(store.files.get(paths.artifactPath)!));
    expect(r.manifest.batches[b1].state).toBe('completed');
    expect(r.manifest.batches[b1].transactionId).toBe(receipt.transactionId);
  });

  it('窗口二: artifact+receipt 已提交、cursor 未推进 → resume 校验后幂等推进 cursor, 不重跑 provider', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    store.crash = { atTx: 3, step: 'after-commit' }; // artifact-receipt 提交后、cursor 前"进程死亡"
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const b1 = batchIdOf(s, 0);
    const loaded = await store.loadRunState(wfId);
    expect(loaded.manifest!.batches[b1].state).toBe('artifact_committed');
    expect(loaded.manifest!.cursor).toEqual({ phase: 'start', ordinal: 0 }); // cursor 未推进
    const r = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('completed');
    const b2 = batchIdOf(s, 1);
    expect(r.stateTxLog).toEqual([`cursor:${b1}`, `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`, 'run-status:completed']);
    expect(gen.batchIds()).toEqual([b1, b2]); // b1 不重调
    expect(r.manifest.batches[b1].state).toBe('completed');
  });

  it('run_bootstrap 事务中途崩溃(无已提交 plan)→ resume 收敛 bootstrap intent 补完同一事务, 不死锁', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    store.crash = { atTx: 1, step: 'mid-artifact' }; // bootstrap 事务中途"进程死亡"
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const loaded = await store.loadRunState(wfId);
    expect(loaded.manifest).toBeUndefined(); // manifest 尚未提交
    expect(loaded.intents).toHaveLength(1); // 仅 bootstrap intent
    const r = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('completed');
    expect(r.stateTxLog[0]).toBe('recover:bootstrap');
    expect(r.manifest.workflowId).toBe(wfId);
  });

  it('从首不完整继续: 已完成批次校验跳过, 续跑剩余批次', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s3 = spec({
      batches: [
        { phase: 'slice', ordinal: 0, sourceIds: ['ch-1'], sourceHashes: { 'ch-1': sha('ch1') } },
        { phase: 'entities', ordinal: 1, sourceIds: ['scene-a'], sourceHashes: { 'scene-a': sha('a') } },
        { phase: 'structure', ordinal: 2, sourceIds: ['outline'], sourceHashes: { outline: sha('o') } },
      ],
    });
    store.crash = { atTx: 4, step: 'after-commit' }; // b1 完成后"进程死亡"
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s3 })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s3);
    const r = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: wfId, expected: expectedFor(s3) });
    expect(r.status).toBe('completed');
    const [b1, b2, b3] = r.completedBatchIds;
    expect(r.completedBatchIds).toEqual([b1, b2, b3]);
    expect(gen.batchIds()).toEqual([b1, b2, b3]); // b1 不重调
    expect(r.stateTxLog).toEqual([
      `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`,
      `plan:${b3}`, `artifact:${b3}`, `cursor:${b3}`,
      'run-status:completed',
    ]);
    expect(r.manifest.batches[b1].state).toBe('completed');
  });

  it('resume 已完成 run → 幂等校验通过, 无额外 state transaction', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    const calls = gen.calls.length;
    const r2 = await runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: r1.workflowId, expected: expectedFor(s) });
    expect(r2.status).toBe('completed');
    expect(r2.stateTxLog).toEqual([]);
    expect(gen.calls).toHaveLength(calls);
    expect(r2.completedBatchIds).toEqual(r1.completedBatchIds);
  });

  it('artifact 损坏 → resume fail-closed, 保留现场绝不盲重写', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    const [b1] = orderedBatchIds(r1);
    const entry = r1.manifest.batches[b1];
    const corrupt = Uint8Array.from(store.files.get(entry.artifactPath)!);
    corrupt[0] ^= 0xff;
    store.files.set(entry.artifactPath, corrupt);
    await expect(runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: r1.workflowId, expected: expectedFor(s) }))
      .rejects.toThrow(/不符/);
    expect(store.files.get(entry.artifactPath)![0]).toBe(corrupt[0]); // 现场保留
    expect(gen.calls).toHaveLength(2); // 不重调 provider
  });

  it('manifest cursor 与已完成批次前缀不符 → fail-closed', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    store.manifests.set(r1.workflowId, { ...r1.manifest, cursor: { phase: 'slice', ordinal: 5 } });
    await expect(runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: r1.workflowId, expected: expectedFor(s) }))
      .rejects.toThrow(/cursor/);
  });
});

describe('resume 严格兼容与 force', () => {
  it('profile/input/planDigest 任一不匹配 → 拒绝续跑(fail-closed)', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    const resume = (patch: Partial<ReturnType<typeof expectedFor>>) =>
      runWorkflow(portsOf(store, gen), { mode: 'resume', workflowId: r1.workflowId, expected: { ...expectedFor(s), ...patch } });
    await expect(resume({ profileFingerprint: sha('other-profile') })).rejects.toThrow(/profileFingerprint 不匹配/);
    await expect(resume({ inputFingerprint: sha('other-input') })).rejects.toThrow(/inputFingerprint 不匹配/);
    await expect(resume({ planDigest: sha('other-plan') })).rejects.toThrow(/planDigest 不匹配/);
    await expect(resume({ workflowId: 'imp-0000000000000000-other' })).rejects.toThrow(/workflowId 不匹配/);
    // 拒绝后原 run 未被触碰
    const loaded = await store.loadRunState(r1.workflowId);
    expect(loaded.manifest!.status).toBe('completed');
  });

  it('force 每次全新 identity 且 expected-absent; 旧 run 不被覆盖', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r1 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    // force 即使同 uniqueRunId 也生成全新 identity(不因 deterministic ID 存在拒新 run)
    const r2 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s, force: true, existingIds: [r1.workflowId] });
    expect(r2.workflowId).not.toBe(r1.workflowId);
    expect(r2.manifest.planDigest).toBe(r1.manifest.planDigest);
    expect(r2.status).toBe('completed');
    // 再次 force → 又一个新的 identity
    const r3 = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s, force: true, existingIds: [r1.workflowId, r2.workflowId] });
    expect(r3.workflowId).not.toBe(r1.workflowId);
    expect(r3.workflowId).not.toBe(r2.workflowId);
    // 旧 run 不被覆盖
    const old = await store.loadRunState(r1.workflowId);
    expect(old.manifest!.workflowId).toBe(r1.workflowId);
    expect(Object.values(old.manifest!.batches).every((b) => b.state === 'completed')).toBe(true);
    // expected-absent: 同 spec 再次 start(确定性 identity 已存在)→ 拒绝
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: s })).rejects.toThrow(/已存在/);
  });
});

describe('canonical apply 状态机与崩溃恢复', () => {
  it('waiting_approval → applying(transactionId durable 先写)→ applied(commitEvidence 绑定)', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = specWithApply();
    const apply = new MemoryCanonical(['allowed-once']);
    const r = await runWorkflow(portsOf(store, gen, apply), { mode: 'start', spec: s });
    expect(r.status).toBe('completed');
    const [b1, b2] = orderedBatchIds(r);
    const applyId = applyIdFor(r.workflowId, b1);
    const record = r.manifest.applies[applyId];
    expect(record.state).toBe('applied');
    expect(record.transactionId).toBe(applyTransactionId(r.workflowId, applyId)); // 确定性 txid
    expect(record.commitOid).toMatch(/^[0-9a-f]{64}$/);
    expect(record.target).toBe('content/scenes/ch1.md');
    expect(record.batchId).toBe(b1);
    expect(record.planDigest).toBe(r.manifest.planDigest);
    expect(record.writeSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.checkpoint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.provenance).toMatch(/^prov-/);
    expect(Object.isFrozen(record)).toBe(true);
    // 顺序: apply 在 cursor 之后、下一批之前; waiting → applying → applied 各自独立 state transaction
    expect(r.stateTxLog).toEqual([
      'bootstrap',
      `plan:${b1}`, `artifact:${b1}`, `cursor:${b1}`,
      `apply:waiting:${applyId}`, `apply:applying:${applyId}`, `apply:applied:${applyId}`,
      `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`,
      'run-status:completed',
    ]);
    expect(apply.approvals).toHaveLength(1);
    expect(apply.executes).toHaveLength(1);
    expect(apply.workspace.has('content/scenes/ch1.md')).toBe(true); // canonical 已写
    expect(r.manifest.applies[applyIdFor(r.workflowId, b2)]).toBeUndefined(); // 无 apply 的批不建记录
  });

  it('崩溃恢复: applying 后、canonical 未启动 → probe=none → 持久退回 waiting_approval + 重新审批, 旧 decision 不重放', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = specWithApply();
    const apply = new MemoryCanonical(['allowed-once', 'allowed-once']);
    store.crash = { atTx: 6, step: 'after-commit' }; // apply:applying 提交后、execute 前"进程死亡"
    await expect(runWorkflow(portsOf(store, gen, apply), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const b1 = batchIdOf(s, 0);
    const applyId = applyIdFor(wfId, b1);
    expect(apply.approvals).toHaveLength(1); // 首次审批已放行, 但写前崩溃
    const r = await runWorkflow(portsOf(store, gen, apply), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('completed');
    expect(r.reappliedApplyIds).toEqual([applyId]);
    expect(apply.approvals).toHaveLength(2); // 发起新审批, 旧 allowed-once 不重放
    expect(apply.executes).toHaveLength(1); // canonical 只执行一次(首次执行前已崩溃)
    expect(r.manifest.applies[applyId].state).toBe('applied'); // 同一 applyId 回 waiting 后重新审批
    expect(r.manifest.applies[applyId].commitOid).toMatch(/^[0-9a-f]{64}$/);
    expect(apply.workspace.has('content/scenes/ch1.md')).toBe(true);
    // 状态事务顺序: revert(退回 waiting)→ applying(新审批)→ applied, 然后续跑 b2
    const b2 = batchIdOf(s, 1);
    expect(r.stateTxLog).toEqual([
      `apply:revert:${applyId}`,
      `apply:applying:${applyId}`, `apply:applied:${applyId}`,
      `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`,
      'run-status:completed',
    ]);
  });

  it('崩溃恢复: canonical 已 commit、状态未推进 → probe=completed → 只补 applied, 不重复审批/写入', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = specWithApply();
    const apply = new MemoryCanonical(['allowed-once']);
    store.crash = { atTx: 6, step: 'after-commit' }; // applying 提交后崩溃(execute 未运行)
    await expect(runWorkflow(portsOf(store, gen, apply), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const applyId = applyIdFor(wfId, batchIdOf(s, 0));
    // 模拟崩溃现场中 canonical 已 commit(另一进程在状态事务前死亡): probe 显示 completed
    const commitOid = sha('canonical-commit');
    apply.canonical.set(applyTransactionId(wfId, applyId), { state: 'completed', commitOid });
    const approvalsBefore = apply.approvals.length;
    const r = await runWorkflow(portsOf(store, gen, apply), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.manifest.applies[applyId].state).toBe('applied');
    expect(r.manifest.applies[applyId].commitOid).toBe(commitOid); // 同一 commit 验证
    expect(apply.approvals).toHaveLength(approvalsBefore); // 不重复审批
    expect(apply.executes).toHaveLength(0); // 不重复写入
    // 只补 applied 状态, 然后续跑 b2
    const b2 = batchIdOf(s, 1);
    expect(r.stateTxLog).toEqual([
      `apply:applied:${applyId}`,
      `plan:${b2}`, `artifact:${b2}`, `cursor:${b2}`,
      'run-status:completed',
    ]);
  });

  it('崩溃恢复: probe=unknown → 保留 applying 现场 fail-closed, 绝不盲重写', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = specWithApply();
    const apply = new MemoryCanonical(['allowed-once']);
    store.crash = { atTx: 6, step: 'after-commit' }; // apply:applying 提交后崩溃
    await expect(runWorkflow(portsOf(store, gen, apply), { mode: 'start', spec: s })).rejects.toThrow(/injected crash/);
    const wfId = workflowIdOf(s);
    const applyId = applyIdFor(wfId, batchIdOf(s, 0));
    apply.canonical.set(applyTransactionId(wfId, applyId), { state: 'unknown' }); // 探针无法判定归属
    const approvalsBefore = apply.approvals.length;
    const r = await runWorkflow(portsOf(store, gen, apply), { mode: 'resume', workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe('apply_probe_unknown');
    expect(r.applyProbeUnknown).toEqual([applyId]);
    expect(apply.approvals).toHaveLength(approvalsBefore); // 不重审批
    expect(apply.executes).toHaveLength(0); // 不重执行
    expect(apply.workspace.size).toBe(0); // 不写
    expect(r.stateTxLog).toEqual([]); // 现场原样, 无任何 state transaction
    const loaded = await store.loadRunState(wfId);
    expect(loaded.manifest!.applies[applyId].state).toBe('applying'); // 现场保留
  });

  it('审批 rejected → apply rejected, 绝不 apply; unavailable → skipped(onApprovalUnavailable)', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = specWithApply();
    const apply = new MemoryCanonical(['rejected']);
    const r = await runWorkflow(portsOf(store, gen, apply), { mode: 'start', spec: s });
    const applyId = applyIdFor(r.workflowId, batchIdOf(s, 0));
    expect(r.manifest.applies[applyId].state).toBe('rejected');
    expect(apply.workspace.size).toBe(0); // 绝不静默 apply
    expect(r.status).toBe('completed'); // 终态不阻塞 run 完成

    const store2 = new InMemoryRunStore();
    const gen2 = new MockGenerator(store2);
    const s2 = specWithApply({ batches: [{
      phase: 'slice', ordinal: 0, sourceIds: ['ch-1'], sourceHashes: { 'ch-1': sha('ch1') },
      apply: { target: 'content/scenes/ch1.md', expectedHash: EMPTY_HASH, onApprovalUnavailable: 'skipped' },
    }, { phase: 'entities', ordinal: 1, sourceIds: ['scene-a'], sourceHashes: { 'scene-a': sha('a') } }] });
    const apply2 = new MemoryCanonical(['unavailable']);
    const r2 = await runWorkflow(portsOf(store2, gen2, apply2), { mode: 'start', spec: s2 });
    const applyId2 = applyIdFor(r2.workflowId, batchIdOf(s2, 0));
    expect(r2.manifest.applies[applyId2].state).toBe('skipped');
    expect(apply2.workspace.size).toBe(0);
  });
});

describe('secret 防护与冻结', () => {
  it('manifest 不含任何 secret 字段; 接口拒绝 secret 形字段', async () => {
    const store = new InMemoryRunStore();
    const gen = new MockGenerator(store);
    const s = spec();
    const r = await runWorkflow(portsOf(store, gen), { mode: 'start', spec: s });
    expect(JSON.stringify(r.manifest)).not.toMatch(/apikey|token|secret|bearer|authorization|password|credential|jwt|signing/i);
    // 引擎接口拒绝 secret 形字段(铁律 6)
    const bad = {
      ...s,
      batches: [...s.batches, { phase: 'p', ordinal: 9, sourceIds: [], sourceHashes: {}, token: 'abc' }],
    } as unknown as RunEngineSpec;
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: bad })).rejects.toThrow(/secret/);
    const bad2 = { ...s, apiKey: 'sk-abc' } as unknown as RunEngineSpec;
    await expect(runWorkflow(portsOf(store, gen), { mode: 'start', spec: bad2 })).rejects.toThrow(/secret/);
  });
});
