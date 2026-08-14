// 测试助手: 真实 DSH 服务(storage/storage-json/storage-domain/llm)+ 假
// approval/jobs/credentials; 全部经真实 Cordis Context 组装(seam 行为契约)。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { JobDoneListener, JobId, JobRead, JobSnapshot, JobStart, JobsChangedListener } from '@deepseek-ai/dsh-jobs';
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import Storage from '@deepseek-ai/dsh-storage';
import { apply as applyStorageJson, Config as JsonConfig } from '@deepseek-ai/dsh-storage-json';
import { apply as applyStorageDomain, Config as DomainConfig } from '@deepseek-ai/dsh-storage-domain';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';

// ---------------------------------------------------------------------------
// 假 LLM 适配器: 只实现 stream(记录请求, 按队列回放)。
// ---------------------------------------------------------------------------
export interface FakeLlmResponse {
  /** 文本增量序列(逐块 text-delta) */
  deltas?: string[];
  usage?: { inputTokens: number; outputTokens: number };
  /** 终止原因(缺省 stop) */
  finishKind?: 'stop' | 'error' | 'aborted';
  failure?: { code: string; message: string };
}

export class FakeAdapter extends LlmAdapter {
  queue: FakeLlmResponse[] = [];
  requests: GenerateOptions[] = [];

  enqueue(...responses: FakeLlmResponse[]): void {
    this.queue.push(...responses);
  }

  /** 对任意 provider/model 提供有效元数据(避免 INVALID_MODEL_INFO 挡路)。 */
  override async resolveModel(provider: string, model: string): Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const next = this.queue.shift();
    if (!next) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_FAKE_RESPONSE', message: '队列耗尽' } } };
      return;
    }
    for (const text of next.deltas ?? ['']) {
      yield { type: 'text-delta', index: 0, text };
    }
    if (next.usage) {
      yield { type: 'usage', usage: next.usage };
    }
    if (next.finishKind === 'error' || next.finishKind === 'aborted') {
      yield {
        type: 'finish',
        reason: {
          kind: next.finishKind,
          failure: next.failure ?? { code: 'RATE_LIMIT', message: 'fake failure' },
        },
      };
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

// ---------------------------------------------------------------------------
// 假审批服务: 按请求返回固定 outcome; 记录请求。
// ---------------------------------------------------------------------------
export interface FakeApprovalConfig {
  /** 缺省 outcome; 未设置时按 decisions 表, 再缺省 rejected(fail-closed 可测) */
  outcome?: ApprovalOutcome;
  decisions?: Record<string, ApprovalOutcome>;
}

export class FakeApproval extends ApprovalService {
  requests: ApprovalRequest[] = [];
  private readonly config: FakeApprovalConfig;

  constructor(ctx: Context, config: FakeApprovalConfig) {
    super(ctx, {});
    this.config = config;
  }

  override async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(req);
    return this.config.outcome ?? this.config.decisions?.[req.toolName] ?? 'rejected';
  }
}

// ---------------------------------------------------------------------------
// 假 jobs 注册表: 进程内实现 JobRegistry 全抽象面。
// ---------------------------------------------------------------------------
interface FakeJob {
  snapshot: JobSnapshot;
  hooks: ReturnType<JobStart['run']>;
}

export class FakeJobs extends JobRegistry {
  readonly jobs = new Map<string, FakeJob>();
  private counter = 0;
  private doneListeners: JobDoneListener[] = [];
  private changedListeners: JobsChangedListener[] = [];

  start(spec: JobStart): JobId {
    const id = `${spec.kind}-${++this.counter}` as JobId;
    const snapshot: JobSnapshot = {
      id,
      kind: spec.kind,
      label: spec.label,
      status: 'running',
      startedAt: Date.now(),
      reported: false,
    };
    const hooks = spec.run();
    this.jobs.set(id, { snapshot, hooks });
    void hooks.done.then((outcome) => {
      snapshot.status = outcome.status;
      snapshot.detail = outcome.detail;
      snapshot.finishedAt = Date.now();
      for (const listener of this.doneListeners) void listener({ ...snapshot }, spec.owner);
      for (const listener of this.changedListeners) listener(spec.owner);
    });
    for (const listener of this.changedListeners) listener(spec.owner);
    return id;
  }

  list(caller?: import('@deepseek-ai/dsh-agent').Agent): JobSnapshot[] {
    void caller;
    return [...this.jobs.values()].map((j) => ({ ...j.snapshot }));
  }

  get(id: JobId): JobSnapshot {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    return { ...job.snapshot };
  }

  read(id: JobId): JobRead {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    return { text: '', snapshot: { ...job.snapshot } };
  }

  kill(id: JobId, _caller?: import('@deepseek-ai/dsh-agent').Agent, reason?: string): 'requested' | 'already-finished' {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.snapshot.status !== 'running') return 'already-finished';
    job.hooks.cancel(reason);
    return 'requested';
  }

  async wait(id: JobId, timeoutMs: number): Promise<JobSnapshot> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    const deadline = Date.now() + timeoutMs;
    while (job.snapshot.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return { ...job.snapshot };
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.doneListeners.push(listener);
    return () => {
      this.doneListeners = this.doneListeners.filter((l) => l !== listener);
    };
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.push(listener);
    return () => {
      this.changedListeners = this.changedListeners.filter((l) => l !== listener);
    };
  }

  attachController(_name: string): () => void {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// 假凭据服务。
// ---------------------------------------------------------------------------
export class FakeCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>();

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref);
    return value ? { value, source: 'fake' } : undefined;
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true };
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value);
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref);
  }
}

// ---------------------------------------------------------------------------
// 组合工厂: 真实 storage(json backend)+ storage-domain + llm + 假服务。
// ---------------------------------------------------------------------------
export interface HarnessServices {
  ctx: Context;
  adapter: FakeAdapter;
  approval: FakeApproval;
  jobs: FakeJobs;
  credentials: FakeCredentials;
  dataDir: string;
  dispose: () => Promise<void>;
}

export async function makeContext(opts: { approval?: FakeApprovalConfig } = {}): Promise<HarnessServices> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-dsh-'));
  const root = new Context();
  root.plugin(Storage);
  await root.plugin({ name: 'storage-json', inject: ['storage'], Config: JsonConfig, apply: applyStorageJson }, {
    root: path.join(dataDir, 'storage'),
  } satisfies { root: string });
  await root.plugin({ name: 'storage-domain', inject: ['storage'], Config: DomainConfig, apply: applyStorageDomain }, {
    backend: 'json',
  } satisfies { backend: string });
  await root.plugin(LlmRuntime);
  const adapter = new FakeAdapter();
  root.llm.registerAdapter(['fake'], adapter);

  // Service 基类构造即注册服务(Service 构造器内部 ctx.provide), 无需显式 provide。
  const approval = new FakeApproval(root, opts.approval ?? {});
  const jobs = new FakeJobs(root);
  const credentials = new FakeCredentials(root);

  return {
    ctx: root,
    adapter,
    approval,
    jobs,
    credentials,
    dataDir,
    dispose: async () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
