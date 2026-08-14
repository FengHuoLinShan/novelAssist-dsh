// RadarScheduler 行为契约(seam: ctx.jobs)。
// 断言引 seam 契约 + 设计文档 §7/§11: 每雷达一轮 = 一个 job(kind=
// novelcraft-radar); work 观察 signal; 取消 → killed; 异常 → failed。
import { describe, expect, it } from 'vitest';
import { RadarScheduler } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

describe('RadarScheduler', () => {
  it('start: 每轮一个 novelcraft-radar job, 完成带 output', async () => {
    const h: HarnessServices = await makeContext();
    const radars = new RadarScheduler(h.ctx);
    const jobId = radars.start(
      { root: '/tmp/vault-a', radar: 'dedup' },
      async () => '本轮去重: 0 冲突',
    );
    expect(jobId.startsWith('novelcraft-radar-')).toBe(true);
    const snapshot = await h.jobs.wait(jobId, 2000);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.kind).toBe('novelcraft-radar');
    expect(snapshot.label).toContain('去重');
  });

  it('work 抛错 → failed(detail 作者语言可读)', async () => {
    const h = await makeContext();
    const radars = new RadarScheduler(h.ctx);
    const jobId = radars.start({ root: '/tmp/vault-a', radar: 'plot' }, async () => {
      throw new Error('剧情线扫描失败');
    });
    const snapshot = await h.jobs.wait(jobId, 2000);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.detail).toContain('剧情线扫描失败');
  });

  it('kill → work 收到 abort, 结算 killed', async () => {
    const h = await makeContext();
    const radars = new RadarScheduler(h.ctx);
    let aborted = false;
    const jobId = radars.start({ root: '/tmp/vault-a', radar: 'risk' }, async (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(undefined);
        }, { once: true });
      });
      return 'done';
    });
    expect(h.jobs.kill(jobId)).toBe('requested');
    const snapshot = await h.jobs.wait(jobId, 2000);
    expect(aborted).toBe(true);
    expect(snapshot.status).toBe('killed');
  });

  it('startInterval: 无 setInterval 的 context 返回 undefined(不抛)', async () => {
    const h = await makeContext();
    const radars = new RadarScheduler(h.ctx);
    expect(radars.startInterval(60, () => undefined, async () => '')).toBeUndefined();
  });
});
