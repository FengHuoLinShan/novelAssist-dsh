// NovelcraftCache 行为契约(seam: ctx.storageDomain)。
// 断言引 seam 契约 + 设计文档 §22.2「索引规则」: 派生索引进 domain KV(可选
// 持久化), 文件仍是唯一真相; domain 记录经 zod 边界校验; 关闭后重开从
// 介质恢复(json backend, 内存态重建)。
import { describe, expect, it } from 'vitest';
import { NovelcraftCache, novelcraftDomain } from '../src/index.js';
import { makeContext } from './helpers.js';

describe('NovelcraftCache(真实 storage-domain + json backend)', () => {
  it('putIndex/getIndex: 覆盖写 + 同步读(内存权威态)', async () => {
    const h = await makeContext();
    const cache = new NovelcraftCache(h.ctx);
    await cache.putIndex('/tmp/vault-a', 1, { objects: [{ slug: 'x' }] });
    expect(cache.getIndex('/tmp/vault-a')).toMatchObject({
      vaultRoot: '/tmp/vault-a',
      indexVersion: 1,
      index: { objects: [{ slug: 'x' }] },
    });
    // 覆盖写生效
    await cache.putIndex('/tmp/vault-a', 1, { objects: [] });
    expect(cache.getIndex('/tmp/vault-a')?.index).toEqual({ objects: [] });
    await cache.close();
  });

  it('bindSession/resolveSession: 会话绑定持久化', async () => {
    const h = await makeContext();
    const cache = new NovelcraftCache(h.ctx);
    await cache.bindSession('session-1', '/tmp/vault-a', '测试书');
    await expect(cache.resolveSession('session-1')).resolves.toBe('/tmp/vault-a');
    const all = await cache.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0][1].book).toBe('测试书');
    await cache.close();
  });

  it('close 后重开从介质恢复(json 落盘)', async () => {
    const h = await makeContext();
    const cache1 = new NovelcraftCache(h.ctx);
    await cache1.bindSession('session-1', '/tmp/vault-b', '第二本');
    await cache1.close();

    const cache2 = new NovelcraftCache(h.ctx);
    await expect(cache2.resolveSession('session-1')).resolves.toBe('/tmp/vault-b');
    await cache2.close();
  });

  it('domain 规格自检: 名称/版本/表集(挂载契约)', () => {
    expect(novelcraftDomain.name).toBe('novelcraft');
    expect(novelcraftDomain.version).toBe(1);
    // N20 加法: presets 表(内容手预设卡)进同一 domain, 版本不变(新增表不影响既有表)。
    expect(Object.keys(novelcraftDomain.tables).sort()).toEqual(['indexes', 'presets', 'sessions']);
  });

  it('非法记录被 durable 边界拒绝(zod 校验, 重开时验证)', async () => {
    const h = await makeContext();
    const cache1 = new NovelcraftCache(h.ctx);
    const domain = await cache1.open();
    // 写入非法记录(绕过类型): 边界校验发生在 durable read 边界 = 重开时。
    await domain.table('sessions').put('bad', { vaultRoot: '', book: '', boundAt: '' } as never);
    await cache1.close();

    const cache2 = new NovelcraftCache(h.ctx);
    await expect(cache2.open()).rejects.toThrow();
  });
});
