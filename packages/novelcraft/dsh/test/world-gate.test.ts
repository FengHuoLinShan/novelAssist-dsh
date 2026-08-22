// world 写面审批门收口(N31, M7 Phase F): NovelCraftService.worldCreateGuarded/
// worldUpdateGuarded 经 ApprovalGate(allowed-once 单次放行; rejected/cancelled/
// unavailable 一律拒绝, fail-closed); raw facades 不再由 service/public root 暴露。
// 断言引 N31/N35(审批门旁路收口) + 铁律3(采用类写入必过 approval fail-closed)。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { createObject as createWorldObject, listObjects, readObject } from '@novelcraft/world';
import { GateDeniedError, NovelCraftService } from '../src/index.js';
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
      expect(listObjects(env.root)).toHaveLength(1);
      expect(listObjects(env.root)[0].name).toBe('苏婉');
      env.cleanup();
    });

    it('rejected 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'rejected' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(env.h.approval.requests.length).toBeGreaterThan(0);
      expect(listObjects(env.root)).toHaveLength(0); // 读取面无写入
      env.cleanup();
    });

    it('cancelled 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'cancelled' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(listObjects(env.root)).toHaveLength(0);
      env.cleanup();
    });

    it('unavailable 拒绝(文件未创建)', async () => {
      const env = await setup({ outcome: 'unavailable' });
      await expect(
        env.service.worldCreateGuarded(fakeAgent, env.root, { name: '苏婉', entityType: 'character' }),
      ).rejects.toBeInstanceOf(GateDeniedError);
      expect(listObjects(env.root)).toHaveLength(0);
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

    it('审批窗口外部编辑触发冻结基线冲突，allowed-once 不覆盖新字节(N32)', async () => {
      const env = await setup();
      const slug = await withObject(env);
      const file = path.join(env.root, 'world', 'objects', `${slug}.md`);
      vi.spyOn(env.service.approval, 'request').mockImplementation(async () => {
        writeFileSync(file, readFileSync(file, 'utf8').replace('# 苏婉', '# 外部编辑'), 'utf8');
        return 'allowed-once';
      });
      await expect(
        env.service.worldUpdateGuarded(fakeAgent, env.root, slug, { name: '审批计划改名' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(readFileSync(file, 'utf8')).toContain('# 外部编辑');
      expect(readFileSync(file, 'utf8')).not.toContain('审批计划改名');
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

  it('service 不再暴露 raw facades；world 写入只在 adoptGuarded capability', async () => {
    const env = await setup();
    expect('facades' in env.service).toBe(false);
    expect(Object.keys(env.service.capabilities.adoptGuarded)).toContain('worldCreate');
    expect(Object.keys(env.service.capabilities.adoptGuarded)).toContain('worldUpdate');
    expect('worldCreate' in env.service.capabilities.propose).toBe(false);
    env.cleanup();
  });
});