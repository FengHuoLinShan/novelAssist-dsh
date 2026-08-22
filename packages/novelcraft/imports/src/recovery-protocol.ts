// N33 / ADR-0022 — deterministic recovery order and provider replay boundary.
import { assertManifestCompatible, type BatchManifestEntry, type WorkflowIdentity, type WorkflowManifest } from './run-model.js';

export interface BatchRecoveryObservation {
  batchId: string;
  planCommitted: boolean;
  artifactIntent: 'none' | 'valid' | 'invalid';
  artifactCommitVerified: boolean;
  receiptValid: boolean;
  cursorCompleted: boolean;
}

export interface WorkflowRecoveryRuntime {
  withVaultLock<T>(root: string, work: () => Promise<T>): Promise<T>;
  /** Recover every vault transaction before any manifest read/validation. */
  recoverTransactions(root: string): Promise<{ remainingIntents: number }>;
  syncGitState(root: string): Promise<void>;
  loadManifest(root: string, workflowId: string): Promise<WorkflowManifest>;
  observeBatch(root: string, manifest: WorkflowManifest, batch: BatchManifestEntry): Promise<BatchRecoveryObservation>;
  /** Complete the same valid state transaction; never call provider. */
  completeArtifactIntent(root: string, workflowId: string, batchId: string): Promise<void>;
  /** Separate state transaction after artifact commit/receipt are verified. */
  advanceCursor(root: string, workflowId: string, batchId: string): Promise<void>;
}

export interface WorkflowRecoveryResult {
  manifest: WorkflowManifest;
  completedFromIntent: string[];
  advancedCursors: string[];
  providerOutcomeUnknown: string[];
  remainingBatchIds: string[];
}

export interface RecoverWorkflowOptions {
  root: string;
  workflowId: string;
  // run-model 复审 R3: assertManifestCompatible 的 expected 必须精确 workflowId 及全部 identity。
  expected: Pick<WorkflowIdentity, 'workflowId' | 'kind' | 'inputFingerprint' | 'profileFingerprint' | 'planDigest'>;
  /** Force may create a new run only after old intents have converged to zero. */
  forceNewRun?: boolean;
}

/**
 * Order is intentionally encoded rather than left to callers:
 * lock → all intents → Git/index/ref sync → manifest read/validate → logical recovery.
 */
export async function recoverWorkflowRun(
  runtime: WorkflowRecoveryRuntime,
  options: RecoverWorkflowOptions,
): Promise<WorkflowRecoveryResult> {
  return runtime.withVaultLock(options.root, async () => {
    const recovered = await runtime.recoverTransactions(options.root);
    if (!Number.isSafeInteger(recovered.remainingIntents) || recovered.remainingIntents < 0) {
      throw new Error('transaction recovery 返回非法 remainingIntents');
    }
    if (recovered.remainingIntents !== 0) {
      throw new Error(`仍有 ${recovered.remainingIntents} 个 transaction intent 未收敛，禁止读取 manifest/force`);
    }
    await runtime.syncGitState(options.root);
    const manifest = await runtime.loadManifest(options.root, options.workflowId);
    assertManifestCompatible(manifest, options.expected);

    // force does not mutate/overwrite this run. Caller may create a distinct workflowId only after this return.
    if (options.forceNewRun) {
      return { manifest, completedFromIntent: [], advancedCursors: [], providerOutcomeUnknown: [], remainingBatchIds: [] };
    }

    const completedFromIntent: string[] = [];
    const advancedCursors: string[] = [];
    const providerOutcomeUnknown: string[] = [];
    const remainingBatchIds: string[] = [];
    const batches = Object.values(manifest.batches).sort((a, b) => a.ordinal - b.ordinal || a.batchId.localeCompare(b.batchId));

    for (const batch of batches) {
      const observed = await runtime.observeBatch(options.root, manifest, batch);
      if (observed.batchId !== batch.batchId) throw new Error(`batch observation identity mismatch: ${batch.batchId}`);
      if (!observed.planCommitted) throw new Error(`batch ${batch.batchId} 没有已提交 plan，manifest 损坏`);
      if (observed.artifactIntent === 'invalid') throw new Error(`batch ${batch.batchId} artifact intent 无效，fail-closed`);

      if (observed.artifactIntent === 'valid' && !observed.artifactCommitVerified) {
        await runtime.completeArtifactIntent(options.root, manifest.workflowId, batch.batchId);
        completedFromIntent.push(batch.batchId);
        // Re-observation is mandatory: a valid intent may only complete the same transaction.
        const after = await runtime.observeBatch(options.root, manifest, batch);
        if (!after.artifactCommitVerified || !after.receiptValid) {
          throw new Error(`batch ${batch.batchId} intent 补完后仍无已验证 artifact/receipt`);
        }
        if (!after.cursorCompleted) {
          await runtime.advanceCursor(options.root, manifest.workflowId, batch.batchId);
          advancedCursors.push(batch.batchId);
        }
        continue;
      }

      if (observed.artifactCommitVerified) {
        if (!observed.receiptValid) throw new Error(`batch ${batch.batchId} commit 与 receipt 无法对账`);
        if (!observed.cursorCompleted) {
          await runtime.advanceCursor(options.root, manifest.workflowId, batch.batchId);
          advancedCursors.push(batch.batchId);
        }
        continue;
      }

      // A committed plan with neither durable intent nor verified commit is outcome-unknown:
      // provider may have charged/responded. Never retry automatically.
      if (observed.artifactIntent === 'none') {
        providerOutcomeUnknown.push(batch.batchId);
        remainingBatchIds.push(batch.batchId);
        continue;
      }
      throw new Error(`batch ${batch.batchId} recovery state 不可判定`);
    }

    return { manifest, completedFromIntent, advancedCursors, providerOutcomeUnknown, remainingBatchIds };
  });
}
