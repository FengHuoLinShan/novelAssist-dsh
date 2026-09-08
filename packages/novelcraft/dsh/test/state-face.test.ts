// N53 / M13-A 常驻创作状态面行为契约: 真实 dsh-system-prompt 插件 + 真实 NovelCraftService。
// 断言: 官方 seam 注册形态(section + context)、按 agent 会话分支、绑定隔离、
// 指纹漂移自愈、enabled=false 零注册、工具面不受影响(仍 39 工具)。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { createSignal, saveSignal } from '@novelcraft/assistant';
import { estimateContextTokens } from '@novelcraft/context';
import { gitAdd, gitCommit } from '@novelcraft/store';
import { ingestChapter } from '@novelcraft/writing';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const agentBound = { id: 'a1', session: { id: 'sess-state-A' } } as never;
const agentOther = { id: 'a2', session: { id: 'sess-state-B' } } as never;
const agentUnbound = { id: 'u1', session: { id: 'sess-state-NO' } } as never;

let symlinkCapable: boolean | undefined;
function symlinksSupported(): boolean {
  if (symlinkCapable === undefined) {
    const probe = mkdtempSync(path.join(os.tmpdir(), 'nc-state-link-'));
    try {
      const target = path.join(probe, 'target');
      writeFileSync(target, 'x');
      symlinkSync(target, path.join(probe, 'link'));
      symlinkCapable = true;
    } catch {
      symlinkCapable = false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  return symlinkCapable;
}

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  rootA: string;
  rootB: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

async function setup(opts: { promptEnabled?: boolean } = {}): Promise<TestEnv> {
  const h = await makeContext();
  await h.ctx.plugin(SystemPrompt);
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-state-face-'));
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
    ...(opts.promptEnabled === false ? { prompt: { enabled: false } } : {}),
  });
  const service = h.ctx.novelcraft;
  const bindingA = service.vaults.ensureVault('书甲');
  const bindingB = service.vaults.ensureVault('书乙');
  await service.vaults.bindSession('sess-state-A', bindingA);
  await service.vaults.bindSession('sess-state-B', bindingB);
  return {
    h,
    service,
    vaultsDir,
    rootA: bindingA.root,
    rootB: bindingB.root,
    tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

async function assemble(h: HarnessServices, agent?: unknown): Promise<PromptAssembly> {
  return h.ctx.systemPrompt.assemble((agent === undefined ? {} : { agent }) as AssembleContext);
}

/** 我们 context 条目自身的文本(其他 provider 如 approval:policy 的贡献不属于本面)。 */
function ourText(assembly: PromptAssembly): string {
  return assembly.contexts.find((c) => c.name === 'novelcraft:state')?.text ?? '';
}

function seedChapters(root: string, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    ingestChapter(root, { chapterIndex: i, text: `第${i}章正文`, source: 'paste' });
  }
  gitAdd(root);
  gitCommit(root, 'fixture chapters');
}

describe('N53 常驻创作状态面(system-prompt seam)', () => {
  it('注册形态: 静态 usage section + novelcraft:state context; 工具面不变仍 39', async () => {
    const env = await setup();
    expect(env.tools).toHaveLength(39); // 防口径漂移: 状态面零新工具
    const assembly = await assemble(env.h);
    const usage = assembly.sections.find((s) => s.name === 'novelcraft:usage');
    expect(usage).toBeDefined();
    expect(usage?.text).toContain('NovelCraft 常驻状态');
    expect(usage?.text).toContain('若下方出现');
    expect(usage?.text).not.toContain('{{'); // section 文本会被严格变量插值
    expect(assembly.contexts.some((c) => c.name === 'novelcraft:state')).toBe(true);
    env.cleanup();
  });

  it('无 agent → 空贡献(不污染非 agent 装配); 未绑定会话同样空贡献', async () => {
    const env = await setup();
    seedChapters(env.rootA, 2);
    await env.service.residentState!.refreshNow(env.rootA);

    expect(ourText(await assemble(env.h))).toBe('');
    expect(ourText(await assemble(env.h, agentUnbound))).toBe('');
    env.cleanup();
  });

  it('绑定会话: 快照含书名与章游标; 双书互不串书', async () => {
    const env = await setup();
    seedChapters(env.rootA, 3);
    seedChapters(env.rootB, 1);
    await env.service.residentState!.refreshNow(env.rootA);
    await env.service.residentState!.refreshNow(env.rootB);

    const forA = renderContextSnapshot(await assemble(env.h, agentBound));
    expect(forA).toContain('《书甲》');
    expect(forA).toContain('共 3 章, 最新第 3 章');

    const forB = renderContextSnapshot(await assemble(env.h, agentOther));
    expect(forB).toContain('《书乙》');
    expect(forB).toContain('共 1 章');
    expect(forB).not.toContain('书甲');
    env.cleanup();
  });

  it('指纹漂移自愈: 新 commit 后本次返回旧值, assemble 触发的重算收敛后出新值(覆盖 drift 分支)', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    await env.service.residentState!.refreshNow(env.rootA);
    expect(renderContextSnapshot(await assemble(env.h, agentBound))).toContain('共 1 章');

    seedChapters(env.rootA, 2); // 追加第 2 章 + 新 commit → 下一次 assemble 检出指纹漂移
    const stale = renderContextSnapshot(await assemble(env.h, agentBound));
    expect(stale).toContain('共 1 章'); // 漂移当轮仍返回旧值(同步 provider 不阻塞)
    // 不显式 refresh: 依赖 assemble 的 scheduleRefresh('drift') 在 setImmediate 后台
    // 完成(二轮评审 P2: 之前显式 refreshNow 驱动, 漂移检测分支本身零覆盖)。
    let converged = false;
    for (let i = 0; i < 40 && !converged; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      converged = renderContextSnapshot(await assemble(env.h, agentBound)).includes('共 2 章');
    }
    expect(converged).toBe(true);
    env.cleanup();
  });

  it('git 指纹读 OID: ref mtime 被还原仍能检出新 commit', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    await env.service.residentState!.refreshNow(env.rootA);
    const head = readFileSync(path.join(env.rootA, '.git', 'HEAD'), 'utf8').trim();
    const refPath = path.join(env.rootA, '.git', head.slice('ref: '.length));
    const before = statSync(refPath);

    seedChapters(env.rootA, 2);
    utimesSync(refPath, before.atime, before.mtime);
    expect(renderContextSnapshot(await assemble(env.h, agentBound))).toContain('共 1 章');
    let converged = false;
    for (let i = 0; i < 40 && !converged; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      converged = renderContextSnapshot(await assemble(env.h, agentBound)).includes('共 2 章');
    }
    expect(converged).toBe(true);
    env.cleanup();
  });

  it('git 指纹读 packed ref OID: 两次 pack 之间的 commit 仍可检出', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: env.rootA, stdio: 'pipe' });
    await env.service.residentState!.refreshNow(env.rootA);

    seedChapters(env.rootA, 2);
    execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: env.rootA, stdio: 'pipe' });
    expect(renderContextSnapshot(await assemble(env.h, agentBound))).toContain('共 1 章');
    let converged = false;
    for (let i = 0; i < 40 && !converged; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      converged = renderContextSnapshot(await assemble(env.h, agentBound)).includes('共 2 章');
    }
    expect(converged).toBe(true);
    env.cleanup();
  });

  it('信号指纹逐文件聚合: 未来 mtime 不遮蔽其他信号更新', async () => {
    const env = await setup();
    const first = createSignal({
      id: 'sig-first', radar: 'risk', severity: 'risk', title: '一', evidence: ['e'],
      proposed_action: '处理', reversibility: true,
    }, new Date('2026-01-01T00:00:00Z'));
    const future = createSignal({
      id: 'sig-future', radar: 'risk', severity: 'risk', title: '二', evidence: ['e'],
      proposed_action: '处理', reversibility: true,
    }, new Date('2026-01-01T00:00:01Z'));
    saveSignal(env.rootA, first);
    saveSignal(env.rootA, future);
    const futurePath = path.join(env.rootA, '.assistant', 'signals', 'sig-future.json');
    const futureTime = new Date('2030-01-01T00:00:00Z');
    utimesSync(futurePath, futureTime, futureTime);
    await env.service.residentState!.refreshNow(env.rootA);
    expect(ourText(await assemble(env.h, agentBound))).toContain('risk 2');

    saveSignal(env.rootA, { ...first, status: 'rejected' });
    expect(ourText(await assemble(env.h, agentBound))).toContain('risk 2');
    let converged = false;
    for (let i = 0; i < 40 && !converged; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      converged = ourText(await assemble(env.h, agentBound)).includes('risk 1');
    }
    expect(converged).toBe(true);
    env.cleanup();
  });

  it.skipIf(!symlinksSupported())('非 JSON symlink 不参与信号指纹', async () => {
    const env = await setup();
    const outside = path.join(env.vaultsDir, 'outside-signal');
    writeFileSync(outside, 'before');
    symlinkSync(outside, path.join(env.rootA, '.assistant', 'signals', 'fingerprint-link'));
    await env.service.residentState!.refreshNow(env.rootA);

    const schedule = vi.spyOn(env.service.residentState!, 'scheduleRefresh');
    writeFileSync(outside, 'after-and-longer');
    await assemble(env.h, agentBound);
    expect(schedule).not.toHaveBeenCalled();
    env.cleanup();
  });

  it('vault 验证也在让出请求调用栈后执行', async () => {
    const env = await setup();
    let settled = false;
    const refresh = env.service.residentState!.refreshNow(path.join(env.vaultsDir, 'missing'));
    void refresh.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await refresh;
    env.cleanup();
  });

  it('stopAll 后 in-flight 重算不写回缓存(二轮评审 P2): 冷启动调度→停用→settle 后仍空贡献', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    // 调度冷启动重算但不 await: task 已创建、停在 setImmediate 让出点。
    env.service.residentState!.scheduleRefresh(env.rootA, 'cold');
    env.service.residentState!.asVaultRuntime().stopAll?.(); // 停用先于 compute 完成
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ourText(await assemble(env.h, agentBound))).toBe(''); // 缓存未被复活
    env.cleanup();
  });

  it('deactivate 后 in-flight 重算不复活该 vault 缓存', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    await env.service.residentState!.refreshNow(env.rootA);
    seedChapters(env.rootA, 2);
    env.service.residentState!.scheduleRefresh(env.rootA, 'mutation');
    await env.service.residentState!.asVaultRuntime().deactivate(env.rootA);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(env.service.residentState!.textFor(agentBound)).toBe('');
    env.cleanup();
  });

  it('停用清缓存(stopAll)后回到冷路径: 空贡献并重新调度', async () => {
    const env = await setup();
    seedChapters(env.rootA, 1);
    await env.service.residentState!.refreshNow(env.rootA);
    expect(renderContextSnapshot(await assemble(env.h, agentBound))).toContain('《书甲》');

    env.service.residentState!.asVaultRuntime().stopAll?.();
    expect(ourText(await assemble(env.h, agentBound))).toBe('');
    env.cleanup();
  });

  it('config.prompt.enabled=false → 零注册零状态面', async () => {
    const env = await setup({ promptEnabled: false });
    expect(env.service.residentState).toBeUndefined();
    const assembly = await assemble(env.h, agentBound);
    expect(assembly.sections.some((s) => s.name === 'novelcraft:usage')).toBe(false);
    expect(assembly.contexts.some((c) => c.name === 'novelcraft:state')).toBe(false);
    expect(ourText(assembly)).toBe('');
    env.cleanup();
  });

  it('maxTokens 预算真实生效: 超预算 fixture 走降级且渲染不超上界', async () => {
    const h = await makeContext();
    await h.ctx.plugin(SystemPrompt);
    const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-state-face-budget-'));
    h.ctx.provide('tools', { register: () => () => {} });
    await h.ctx.plugin(NovelCraftService, {
      llm: { provider: 'fake', model: 'fake-model' },
      vaultsDir,
      watch: { enabled: false, intervalMinutes: 60 },
      prompt: { enabled: true, maxTokens: 200 },
    });
    const service = h.ctx.novelcraft;
    const binding = service.vaults.ensureVault('预算书');
    await service.vaults.bindSession('sess-budget', binding);
    seedChapters(binding.root, 8);
    // 5 条逾期伏笔(长名)使 full 渲染超过 200 tokens → 降级阶梯必然触发
    // (maxChapter=8 > 计划回收 1..5 且无 reveals 边; 判定 = radar-risk 规则
    // + archived 排除, 与 core resident-state 口径一致)。
    const foreDir = path.join(binding.root, 'structure', 'foreshadowing');
    mkdirSync(foreDir, { recursive: true });
    const longName = '被遗忘的'.repeat(12); // 60 字/条
    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(path.join(foreDir, `f${i}.md`), [
        '---', `title: ${longName}${i}`, 'status: canonical', `planned_payoff_chapter: ${i}`, '---', '',
      ].join('\n'), 'utf8');
    }
    gitAdd(binding.root);
    gitCommit(binding.root, 'fixture foreshadowing');
    await service.residentState!.refreshNow(binding.root);

    const assembly = await assemble(h, { id: 'b1', session: { id: 'sess-budget' } } as never);
    const text = renderContextSnapshot(assembly);
    expect(text).toContain('《预算书》'); // 书名/游标永不降级
    expect(text).toContain('逾期伏笔: 5 条'); // 总数行保留
    expect(estimateContextTokens(text)).toBeLessThanOrEqual(200);
    // 降级特征二择一: 伏笔明细被去掉, 或走到硬截断分支。
    expect(!text.includes('计划第') || text.includes('…(截断)')).toBe(true);
    rmSync(vaultsDir, { recursive: true, force: true });
  });
});
