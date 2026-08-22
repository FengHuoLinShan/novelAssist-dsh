// N34 / ADR-0023 — server-session references drive Node-hosted vault jobs.
import type { Context } from '@deepseek-ai/cordis';
import type { VaultBinding } from '../vault/binding.js';
import { SessionVaultBinder } from '../vault/binding.js';
import { NovelcraftSessionLifecycle } from './session.js';

export interface ActiveVaultRuntime {
  activate(binding: VaultBinding): Promise<void> | void;
  deactivate(root: string): Promise<void> | void;
  stopAll?(): Promise<void> | void;
}

/**
 * Composition boundary deliberately has no browser/client hooks: DSH session/created and
 * session/disposed are the only reference source. The scheduler owns only jobs it starts.
 */
export class NovelcraftNodeRuntime {
  readonly sessions: NovelcraftSessionLifecycle;

  constructor(
    ctx: Context,
    binder: SessionVaultBinder,
    private readonly runtime: ActiveVaultRuntime,
    onError?: (operation: string, error: unknown) => void,
  ) {
    this.sessions = new NovelcraftSessionLifecycle(ctx, binder, {
      onVaultActivated: (binding) => runtime.activate(binding),
      onVaultDeactivated: (binding) => runtime.deactivate(binding.root),
      onError: (operation, sessionId, error) => onError?.(`${operation}:${sessionId}`, error),
    });
  }

  /** Install real DSH session listeners and reconcile sessions already live after HMR. */
  start(): void {
    this.sessions.start();
  }

  /** HMR/plugin disposal: stop every timer/job owned by this runtime instance. */
  async stop(): Promise<void> {
    const drained = this.sessions.stop(); // closes activation synchronously before its first await
    await this.runtime.stopAll?.();
    await drained;
  }
}
