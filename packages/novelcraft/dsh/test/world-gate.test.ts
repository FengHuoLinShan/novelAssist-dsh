// world 写面审批门收口(N31, M7 Phase F): NovelCraftService.worldCreateGuarded/
// worldUpdateGuarded 经 ApprovalGate(allowed-once 单次放行; rejected/cancelled/
// unavailable 一律拒绝, fail-closed); facades.world 两写函数为拒绝存根, 读取面透传。
// 断言引 N31(审批门旁路收口) + 铁律3(采用类写入必过 approval fail-closed)。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { createObject as createWorldObject, readObject } from '@novelcraft/world';
import { GateDeniedError, GateRequiredError, NovelCraftService } from '../src/index.js';
import { makeContext, type FakeApprovalConfig, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  root: string;
  cleanup: () => void;
}

async function setup(approval: FakeApprovalConfig = {}): Promise<TestEnv> {
  const h = await makeContext({ approval });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-worldgate-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', {
    register(def: ToolDefinition) {
      tools.push(def);
      return () => {};
    },
  });
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const root = service.vaults.ensureVault('测试书').root;
  return {
    h,
    service,
    root,
    cleanup: () => {
      rmSync(vaultsDir, { recursive: true, force: true });
    },
  };
}

describe('world 写面审批门(N31, 铁律3)', () => {
  describe('worldCreateGuarded', () => {
    it('allowed-once 放行创建且仅一次(二次调用拒绝)', async () => {
      // 顺序审批: 首次 allowed-once 放行, 第二次 rejected → 单次授权不延续, 每次写都要重新申请(N31)。
      const env = await setup({ sequence: ['allowed-once', 'rejected'] });
      const slug = await env.service.worldCreateGuarded(fakeAgent, env.root, {
        name: '苏婉',
        entityType: 'character',
        aliases: ['红衣女子'],
        tags: ['主角团'],
      });
      // 放行: 文件落 world/objects/ 且 git 提交过; 审计面请求带作者语言动作名。
      expect(existsSync(path.join(env.root, 'world', 'objects', slug + '.md'))).toBe(true);
      expect(env.h.approval.requests).toHaveLength(1);
      expect(env.h.approval.requests[0].reason).toContain('创建世界对象');
      // 二次调用: 未经新授权 → 拒绝, 不写第二个文件(fail-closed, 铁律3)。
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '林晚', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.h.approval.requests).toHaveLength(2);
      expect(env.service.facades.world.listObjects(env.root)).toHaveLength(1);
      expect(env.service.facades.world.listObjects(env.root)[0].name).toBe('苏婉');
      env.cleanup();
    });

    it('rejected 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'rejected' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.h.approval.requests.length).toBeGreaterThan(0);
      expect(env.service.facades.world.listObjects(env.root)).toHaveLength(0); // 读取面无写入
      env.cleanup();
    });

    it('cancelled 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'cancelled' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.service.facades.world.listObjects(env.root)).toHaveLength(0);
      env.cleanup();
    });

    it('unavailable 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'unavailable' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.service.facades.world.listObjects(env.root)).toHaveLength(0);
      env.cleanup();
    });
  });

  describe('worldUpdateGuarded', () => {
    // 夹具直接用核心包建对象(world 包自身, 不经 facade 审批面; 本组只测 update 门)。
    async function withObject(env: TestEnv): Promise<string> {
      return createWorldObject(env.root, { name: '苏婉', entityType: 'character' });
    }

    it('allowed-once 放行改写且仅一次(二次调用拒绝)', async () => {
      const env = await setup({ sequence: ['allowed-once', 'rejected'] });
      const slug = await withObject(env);
      await env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '苏婉·改', tags: ['主角'] });
      expect(readObject(env.root, slug).name).toBe('苏婉·改');
      expect(env.h.approval.requests).toHaveLength(1);
      expect(env.h.approval.requests[0].reason).toContain('修改世界对象');
      // 二次改写未经新授权 → 拒绝, 文件不再改写(N31 + 铁律3)。
      await expect(
        env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '再改' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.h.approval.requests).toHaveLength(2);
      expect(readObject(env.root, slug).name).toBe('苏婉·改');
      env.cleanup();
    });

    it('rejected 拒绝(文件未改写)', async () => {
      const env = await setup({ outcome: 'rejected' });
      const slug = await withObject(env);
      await expect(
        env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '苏婉·改' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(readObject(env.root, slug).name).toBe('苏婉');
      env.cleanup();
    });

    it('cancelled 拒绝(文件未改写)', async () => {
      const env = await setup({ outcome: 'cancelled' });
      const slug = await withObject(env);
      await expect(
        env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '苏婉·改' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(readObject(env.root, slug).name).toBe('苏婉');
      env.cleanup();
    });

    it('unavailable 拒绝(文件未改写)', async () => {
      const env = await setup({ outcome: 'unavailable' });
      const slug = await withObject(env);
      await expect(
        env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '苏婉·改' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(readObject(env.root, slug).name).toBe('苏婉');
      env.cleanup();
    });
  });

  describe('facades.world 收口(N31, 铁律3)', () => {
    it('createObject/updateObject 拒绝存根抛错且消息含 N31', async () => {
      const env = await setup();
      const f = env.service.facades.world;
      // 写面不经审批门 → 抛 GateRequiredError, 消息指引 guarded 方法 + N31(铁律3 fail-closed)。
      expect(() => f.createObject(env.root, { name: '苏婉', entityType: 'character' })).toThrow(GateRequiredError);
      expect(() => f.createObject(env.root, { name: '苏婉', entityType: 'character' })).toThrow(/N31/);
      expect(() => f.updateObject(env.root, 'obj-x', { name: '改' })).toThrow(GateRequiredError);
      expect(() => f.updateObject(env.root, 'obj-x', { name: '改' })).toThrow(/N31/);
      // 拒绝存根不产生任何写入
      expect(f.listObjects(env.root)).toHaveLength(0);
      env.cleanup();
    });

    it('读取面原样透传(listObjects/readObject 不受影响)', async () => {
      const env = await setup({ outcome: 'allowed-once' });
      const slug = await env.service.worldCreateGuarded(fakeAgent, env.root, {
        name: '苏婉',
        entityType: 'character',
      });
      const f = env.service.facades.world;
      expect(f.listObjects(env.root)).toHaveLength(1);
      expect(f.readObject(env.root, slug).name).toBe('苏婉');
      expect(f.listTags(env.root)).toEqual([]);
      env.cleanup();
    });
  });
});