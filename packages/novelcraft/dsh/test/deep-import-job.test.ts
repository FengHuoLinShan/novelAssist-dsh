// deep_import 后台 job 托管行为契约(N55/M13-C): 句柄即返/防重入/混合通知
// (completed→followup 唤醒, killed→inject 非唤醒, 无 owner→silent)/kill helper
// (none|killed|kill-pending)/trace 生命周期事件与精确补提交。断言引 N55 + ADR-0023 §3。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initVault } from '@novelcraft/vault';
import type { DeepImportResult } from '@novelcraft/imports';
import { importTraceFile } from '../src/deep-import.js';
import { activeDeepImportJobId, killActiveDeepImportJob, startDeepImportJob } from '../src/jobs/deep-import-job.js';
import { makeContext, type HarnessServices } from './helpers.js';

const notifyAgent = vi.hoisted(() => ({ followup: vi.fn(), inject: vi.fn() }));
const fakeAgent = { id: 'a1', session: { id: 's1' }, ...notifyAgent } as never;

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nc-dij-'));
  dirs.push(root);
  initVault(root, { title: 'job 测试书', language: 'zh' });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  notifyAgent.followup.mockClear();
  notifyAgent.inject.mockClear();
});

function gitStatus(root: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

function fakeResult(workflowId: string): DeepImportResult {
  return {
    workflow_id: workflowId,
    input_fingerprint: 'fp',
    committed: ['scenes/s001.md'],
    skipped: [],
    conflicts: [],
    adopted: 1,
    rejected: false,
    entities: { created: [], reused: [], uncertain: 0 },
    aliases: { attached: 0, skipped: 0, relations: 0, uncertain: 0 },
  } as DeepImportResult;
}

function readTrace(root: string): Array<Record<string, unknown>> {
  const file = importTraceFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** waitJob: owned job 必须传 owner caller(FakeJobs fencing= 真实宿主 assertAccess 同语义)。 */
async function waitJob(h: HarnessServices, jobId: string, caller?: unknown, ms = 5_000) {
  return h.jobs.wait(jobId as never, ms, caller as never);
}

describe('startDeepImportJob(N55/M13-C)', () => {
  it('completed → followup 唤醒恰一次(plugin 来源标 + notice form); trace 生命周期包裹 + 工作区洁净', async () => {
    const h = await makeContext();
    const root = makeRoot();
    const handle = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      async () => fakeResult('wf-done'));
    expect(handle).toMatchObject({ mode: 'deep_import', requested_workflow_id: '' });
    expect(handle.label).toContain('第 1-2 章');
    const snapshot = await waitJob(h, handle.jobId, fakeAgent);
    expect(snapshot.status).toBe('completed');
    expect(notifyAgent.followup).toHaveBeenCalledTimes(1);
    expect(notifyAgent.inject).not.toHaveBeenCalled();
    const notified = notifyAgent.followup.mock.calls[0][0] as unknown as {
      role: string;
      source: { kind: string; plugin: string; form: string };
    };
    expect(notified.source).toMatchObject({ kind: 'plugin', plugin: '@novelcraft/dsh', form: 'notice' });
    const types = readTrace(root).map((e) => e.type);
    expect(types).toEqual(['job_started', 'job_finished', 'job_notify']);
    expect(readTrace(root)[2]).toMatchObject({ channel: 'followup', workflow_id: 'wf-done' });
    // trace 补提交: 工作区洁净(「深导后不留脏」不变量)。
    expect(gitStatus(root)).toEqual([]);
    expect(activeDeepImportJobId(root)).toBeUndefined(); // 终态释放防重入席位
  });

  it('killed → inject 非唤醒(记录性通知); kill 经 AbortSignal 观察到取消', async () => {
    const h = await makeContext();
    const root = makeRoot();
    let observedAbort = false;
    const handle = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'resume', workflowId: 'wf-resume' },
      (signal) => new Promise<DeepImportResult>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('导入被停止'));
        }, { once: true });
      }));
    expect(handle.requested_workflow_id).toBe('wf-resume');
    await new Promise((r) => setTimeout(r, 20)); // 等 work 挂上 listener
    expect(h.jobs.kill(handle.jobId as never, fakeAgent as never, '测试停止')).toBe('requested');
    const snapshot = await waitJob(h, handle.jobId, fakeAgent);
    expect(snapshot.status).toBe('killed');
    expect(observedAbort).toBe(true);
    expect(notifyAgent.inject).toHaveBeenCalledTimes(1);
    expect(notifyAgent.followup).not.toHaveBeenCalled();
    const notified = notifyAgent.inject.mock.calls[0][0] as unknown as { content: Array<{ text: string }> };
    expect(notified.content[0].text).toContain('停止');
    expect(readTrace(root)[2]).toMatchObject({ type: 'job_notify', channel: 'inject' });
    expect(gitStatus(root)).toEqual([]);
  });

  it('无 owner → 静默(零通知), trace 记 channel=silent', async () => {
    const h = await makeContext();
    const root = makeRoot();
    const handle = startDeepImportJob(h.ctx, undefined, root, { mode: 'start_new', startChapter: 1, endChapter: 1 },
      async () => fakeResult('wf-unowned'));
    const snapshot = await waitJob(h, handle.jobId);
    expect(snapshot.status).toBe('completed');
    expect(notifyAgent.followup).not.toHaveBeenCalled();
    expect(notifyAgent.inject).not.toHaveBeenCalled();
    expect(readTrace(root)[2]).toMatchObject({ type: 'job_notify', channel: 'silent' });
  });

  it('failed → followup 唤醒(失败也是作者需要接手的事件); detail 有界', async () => {
    const h = await makeContext();
    const root = makeRoot();
    const handle = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      async () => { throw new Error('provider 崩了'); });
    const snapshot = await waitJob(h, handle.jobId, fakeAgent);
    expect(snapshot.status).toBe('failed');
    expect(notifyAgent.followup).toHaveBeenCalledTimes(1);
    const notified = notifyAgent.followup.mock.calls[0][0] as unknown as { content: Array<{ text: string }> };
    expect(notified.content[0].text).toContain('失败');
    expect(readTrace(root)[1]).toMatchObject({ type: 'job_finished', status: 'failed', detail: 'provider 崩了' });
  });

  it('防重入: 同 root 已有活 job → 二次启动 fail-closed 报既有 jobId(N55 ④)', async () => {
    const h = await makeContext();
    const root = makeRoot();
    const first = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      (signal) => new Promise<DeepImportResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(fakeResult('wf-first')), { once: true });
      }));
    expect(activeDeepImportJobId(root)).toBe(first.jobId);
    expect(() => startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'start_new', startChapter: 1, endChapter: 2 },
      async () => fakeResult('wf-second')))
      .toThrowError(/已有进行中的深度导入 job/);
    expect(h.jobs.kill(first.jobId as never, fakeAgent as never)).toBe('requested');
    await waitJob(h, first.jobId, fakeAgent);
    // 终态后席位释放, 新 job 可启动。
    const second = startDeepImportJob(h.ctx, undefined, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      async () => fakeResult('wf-second'));
    await waitJob(h, second.jobId, undefined);
  });

  it('killActiveDeepImportJob: 无活 job→none; kill 后终态→killed(确定性); caller fencing(评审 P0-1)', async () => {
    const h = await makeContext();
    const root = makeRoot();
    expect(await killActiveDeepImportJob(h.ctx, fakeAgent, root, 30)).toBe('none');

    // work 观察 signal 并结算 → kill → 有界 wait 到 killed(确定性 killed 分支)。
    const handle = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      (signal) => new Promise<DeepImportResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(fakeResult('wf-k')), { once: true });
      }));
    await new Promise((r) => setTimeout(r, 20));
    // fencing: caller=undefined 对 owned job → FakeJobs(=真实宿主 assertAccess)拒绝;
    // 该缺陷曾在真实宿主上让 abandon-kill 主线整体断裂(评审 P0-1)。
    await expect(killActiveDeepImportJob(h.ctx, undefined, root, 50)).rejects.toThrow(/another session/);
    expect(await killActiveDeepImportJob(h.ctx, fakeAgent, root, 2_000)).toBe('killed');
    expect(activeDeepImportJobId(root)).toBeUndefined();

    // kill-pending: kill 已请求但 work 未观察 signal, 有界等待窗口内仍 running(不冒充)。
    const stuck = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 2 },
      () => new Promise<DeepImportResult>(() => {
        /* 永不结算: 模拟清理慢 */
      }));
    expect(h.jobs.kill(stuck.jobId as never, fakeAgent as never)).toBe('requested');
    expect(await killActiveDeepImportJob(h.ctx, fakeAgent, root, 30)).toBe('kill-pending');
  });
});

describe('ADR-0023 §3(owner=agent, 不随浏览器/会话断开取消)', () => {
  it('JobStart.owner 透传发起 agent(FakeJobs onJobDone 回传 owner 即通知可达性证明)', async () => {
    const h = await makeContext();
    const root = makeRoot();
    const seen: string[] = [];
    const off = h.jobs.onJobDone((snapshot, owner) => {
      if (snapshot.kind === 'novelcraft-deep-import') seen.push(String((owner as unknown as { id: string })?.id));
    });
    const handle = startDeepImportJob(h.ctx, fakeAgent, root, { mode: 'deep_import', startChapter: 1, endChapter: 1 },
      async () => fakeResult('wf-owner'));
    await waitJob(h, handle.jobId, fakeAgent);
    off();
    expect(seen).toEqual(['a1']); // owner 链可达 → 通知面成立
  });
});
