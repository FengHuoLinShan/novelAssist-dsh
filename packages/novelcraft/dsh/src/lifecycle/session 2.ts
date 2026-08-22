// N34 / ADR-0023 — server-side DSH session lifecycle binding.
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
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

  constructor(
    private readonly ctx: Context,
    private readonly binder: SessionVaultBinder,
    private readonly callbacks: SessionLifecycleCallbacks = {},
  ) {}

  /** Install listeners once and reconcile HMR/plugin-load sessions already live. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.ctx.on('session/created', (session) => {
      void this.created(session).catch((error) => this.callbacks.onError?.('created', String(session.id), error));
    });
    this.ctx.on('session/disposed', (session) => {
      void this.disposed(session).catch((error) => this.callbacks.onError?.('disposed', String(session.id), error));
    });
    // list() is the authoritative HMR/startup repair surface; created() is idempotent.
    for (const session of this.ctx.sessions.list()) {
      void this.created(session).catch((error) => this.callbacks.onError?.('scan', String(session.id), error));
    }
  }

  /** Public for deterministic tests and explicit HMR reconciliation. */
  async created(session: Session): Promise<void> {
    const sessionId = String(session.id);
    const previous = this.binder.listBound().find(([id]) => id === sessionId)?.[1];
    const previousCount = previous ? this.binder.referenceCount(previous.root) : 0;
    const result = await this.binder.bindByCwd(sessionId, session.header.cwd);
    if (result.status === 'unbound') {
      await this.callbacks.onUnboundSession?.(sessionId, result.reason);
      return;
    }
    if (previousCount === 0 && this.binder.referenceCount(result.binding.root) === 1) {
      await this.callbacks.onVaultActivated?.(result.binding);
    }
  }

  /** Disposal is idempotent; only the last reference triggers timer/radar cleanup. */
  async disposed(session: Session): Promise<void> {
    const result = await this.binder.unbindSession(String(session.id));
    if (result.lastForVault && result.binding) {
      await this.callbacks.onVaultDeactivated?.(result.binding);
    }
  }
}
