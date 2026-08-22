// N34 / ADR-0023 — server-side DSH session lifecycle binding.
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { svc } from '../ctx.js';
import type { VaultBinding } from '../vault/binding.js';
import { SessionVaultBinder } from '../vault/binding.js';

export interface SessionLifecycleCallbacks {
  /** 该 vault 从 0 → 1 个服务端 session 引用。 */
  onVaultActivated?(binding: VaultBinding): Promise<void> | void;
  /** 该 vault 从 1 → 0 个服务端 session 引用。 */
  onVaultDeactivated?(binding: VaultBinding): Promise<void> | void;
  onUnboundSession?(sessionId: string, reason: string): Promise<void> | void;
  onError?(operation: 'created' | 'disposed' | 'scan', sessionId: string, error: unknown): void;
}

/**
 * Browser connectivity is deliberately absent: only SessionStore events/list()
 * influence references and Node-hosted scheduling (N34).
 */
export class NovelcraftSessionLifecycle {
  private started = false;
  private stopped = false;
  /** Preserve SessionStore event order across async cache/binder work. */
  private operations: Promise<void> = Promise.resolve();
  private readonly listenerDisposers: Array<() => unknown> = [];

  constructor(
    private readonly ctx: Context,
    private readonly binder: SessionVaultBinder,
    private readonly callbacks: SessionLifecycleCallbacks = {},
  ) {}

  /** Install listeners once and reconcile HMR/plugin-load sessions already live. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const offCreated = this.ctx.on('session/created', (session) =>
      this.enqueue('created', session, () => this.created(session)));
    const offDisposed = this.ctx.on('session/disposed', (session) =>
      this.enqueue('disposed', session, () => this.disposed(session)));
    if (typeof offCreated === 'function') this.listenerDisposers.push(offCreated);
    if (typeof offDisposed === 'function') this.listenerDisposers.push(offDisposed);
    // Event listeners are unconditional, so a SessionStore registered after this service still works.
    // ctx.get() avoids Cordis optional-service property traps during the one-time HMR scan.
    const sessions = svc<{ list(): Session[] }>(this.ctx, 'sessions');
    for (const session of sessions?.list() ?? []) {
      this.enqueue('scan', session, () => this.created(session));
    }
  }

  private enqueue(operation: 'created' | 'disposed' | 'scan', session: Session, task: () => Promise<void>): void {
    const sessionId = String(session.id);
    // After close, queued created/scan must not activate. Disposed cleanup still runs so binder/cache
    // cannot retain stale session ids; stop() drains this queue before HMR teardown completes.
    const guarded = () => this.stopped && operation !== 'disposed' ? Promise.resolve() : task();
    this.operations = this.operations.then(guarded, guarded).catch((error) => {
      this.callbacks.onError?.(operation, sessionId, error);
    });
  }

  /** Permanently close this HMR instance; queued work may no longer activate a vault. */
  async stop(): Promise<void> {
    this.stopped = true;
    // Remove listeners before taking the queue snapshot: no post-stop disposed event can extend the
    // old generation after teardown's drain barrier has been established.
    for (const dispose of this.listenerDisposers.splice(0)) dispose();
    await this.operations;
  }

  /** Public for deterministic tests and explicit HMR reconciliation. */
  async created(session: Session): Promise<void> {
    const sessionId = String(session.id);
    const result = await this.binder.bindByCwd(sessionId, session.header.cwd);
    if (this.stopped) {
      if (result.status === 'bound') await this.binder.unbindSession(sessionId);
      return;
    }
    if (result.status === 'unbound') {
      await this.callbacks.onUnboundSession?.(sessionId, result.reason);
      return;
    }
    if (result.activated) await this.callbacks.onVaultActivated?.(result.binding);
  }

  /** Disposal is idempotent; only the last reference triggers timer/radar cleanup. */
  async disposed(session: Session): Promise<void> {
    const result = await this.binder.unbindSession(String(session.id));
    if (result.lastForVault && result.binding) {
      await this.callbacks.onVaultDeactivated?.(result.binding);
    }
  }
}
