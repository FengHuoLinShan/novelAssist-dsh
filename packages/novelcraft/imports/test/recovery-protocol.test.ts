// N33 / ADR-0022 crash windows: recovery-before-manifest, no provider replay, cursor repair.
import { describe, expect, it } from 'vitest';
import {
  recoverWorkflowRun,
  workflowSha256,
  type BatchRecoveryObservation,
  type WorkflowManifest,
  type WorkflowRecoveryRuntime,
} from '../src/index.js';

const hash = (x: string) => workflowSha256(x);
const expected = {
  workflowId: `imp-${hash('input').slice(0, 16)}-run-1`,
  kind: 'deep-import' as const,
  inputFingerprint: hash('input'),
  profileFingerprint: hash('profile'),
  planDigest: hash('plan'),
};
const workflowId = expected.workflowId;
const batch = {
  batchId: 'batch-abc', phase: 'entities', ordinal: 0, state: 'planned' as const,
  planPath: `.assistant/import-runs/${workflowId}/batches/entities/batch-abc.plan.json`,
  artifactPath: `.assistant/import-runs/${workflowId}/batches/entities/batch-abc.artifact.json`,
  receiptPath: `.assistant/import-runs/${workflowId}/batches/entities/batch-abc.receipt.json`,
};
const manifest: WorkflowManifest = {
  version: 1, createdAt: '2026-01-01T00:00:00.000Z', ...expected,
  status: 'running', cursor: { phase: 'entities', ordinal: 0 }, batches: { [batch.batchId]: batch },
};

class Runtime implements WorkflowRecoveryRuntime {
  calls: string[] = [];
  remainingIntents = 0;
  observations: BatchRecoveryObservation[] = [];
  async withVaultLock<T>(_root: string, work: () => Promise<T>): Promise<T> { this.calls.push('lock'); return work(); }
  async recoverTransactions(): Promise<{ remainingIntents: number }> { this.calls.push('recover-intents'); return { remainingIntents: this.remainingIntents }; }
  async syncGitState(): Promise<void> { this.calls.push('sync-git'); }
  async loadManifest(): Promise<WorkflowManifest> { this.calls.push('load-manifest'); return manifest; }
  async observeBatch(): Promise<BatchRecoveryObservation> {
    this.calls.push('observe');
    const next = this.observations.shift();
    if (!next) throw new Error('missing observation');
    return next;
  }
  async completeArtifactIntent(): Promise<void> { this.calls.push('complete-intent'); }
  async advanceCursor(): Promise<void> { this.calls.push('advance-cursor'); }
}

const observation = (patch: Partial<BatchRecoveryObservation> = {}): BatchRecoveryObservation => ({
  batchId: batch.batchId, planCommitted: true, artifactIntent: 'none',
  artifactCommitVerified: false, receiptValid: false, cursorCompleted: false, ...patch,
});

describe('recoverWorkflowRun', () => {
  it('固定顺序：lock→recover all intents→sync git→manifest；valid intent 补同事务且不触发provider', async () => {
    const runtime = new Runtime();
    runtime.observations.push(
      observation({ artifactIntent: 'valid' }),
      observation({ artifactIntent: 'none', artifactCommitVerified: true, receiptValid: true }),
    );
    const result = await recoverWorkflowRun(runtime, { root: '/vault', workflowId, expected });
    expect(runtime.calls).toEqual(['lock', 'recover-intents', 'sync-git', 'load-manifest', 'observe', 'complete-intent', 'observe', 'advance-cursor']);
    expect(result.completedFromIntent).toEqual([batch.batchId]);
    expect(result.providerOutcomeUnknown).toEqual([]); // MockProvider seam: recovery runtime根本没有provider方法
  });

  it('有plan但无intent/verified commit → provider_outcome_unknown，绝不自动补artifact', async () => {
    const runtime = new Runtime();
    runtime.observations.push(observation());
    const result = await recoverWorkflowRun(runtime, { root: '/vault', workflowId, expected });
    expect(result.providerOutcomeUnknown).toEqual([batch.batchId]);
    expect(result.remainingBatchIds).toEqual([batch.batchId]);
    expect(runtime.calls).not.toContain('complete-intent');
  });

  it('artifact+receipt commit 已验证但cursor未推进 → 只补cursor', async () => {
    const runtime = new Runtime();
    runtime.observations.push(observation({ artifactCommitVerified: true, receiptValid: true }));
    const result = await recoverWorkflowRun(runtime, { root: '/vault', workflowId, expected });
    expect(result.advancedCursors).toEqual([batch.batchId]);
    expect(runtime.calls).toContain('advance-cursor');
  });

  it('旧intent未收敛时在manifest前fail-closed；force也不得绕过', async () => {
    const runtime = new Runtime();
    runtime.remainingIntents = 1;
    await expect(recoverWorkflowRun(runtime, { root: '/vault', workflowId, expected, forceNewRun: true })).rejects.toThrow(/未收敛/);
    expect(runtime.calls).toEqual(['lock', 'recover-intents']);
  });

  it('force只在收敛并校验旧run后返回，由调用方创建不同workflowId', async () => {
    const runtime = new Runtime();
    const result = await recoverWorkflowRun(runtime, { root: '/vault', workflowId, expected, forceNewRun: true });
    expect(runtime.calls).toEqual(['lock', 'recover-intents', 'sync-git', 'load-manifest']);
    expect(result.remainingBatchIds).toEqual([]);
  });

  it('损坏intent/receipt fail-closed并保留现场', async () => {
    const invalid = new Runtime();
    invalid.observations.push(observation({ artifactIntent: 'invalid' }));
    await expect(recoverWorkflowRun(invalid, { root: '/vault', workflowId, expected })).rejects.toThrow(/intent 无效/);
    const receipt = new Runtime();
    receipt.observations.push(observation({ artifactCommitVerified: true, receiptValid: false }));
    await expect(recoverWorkflowRun(receipt, { root: '/vault', workflowId, expected })).rejects.toThrow(/receipt/);
  });
});
