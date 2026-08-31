// NovelCraftService.deepImport + novelcraft_deep_import 工具: runDeepImport 的 DSH 挂载。
// 断言: 范围授权(authorize_deep_import, 独立授权, R40 修复)→ planImport(confirmed) →
// provider=DshProvider(经 ctx.llm 假适配器)、approve=ApprovalGate(fail-closed)、
// trace=ImportTraceSink(.assistant/import-trace.jsonl, 事件按序)。
// 三次独立授权不复用: authorize_deep_import(范围)/ commit_scenes(Scene adopt)/
// alias_relation(Phase 2b 别名写入)。
// 依据: 设计文档 §15(trace contract)、§9(adopt 必过 approval)、R40(授权快照 fail-closed)、
// 铁律 3(采用类写入 fail-closed)、seam 契约。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { paths } from '@novelcraft/vault';
import { composeSystemPrompt, estimateTokens, loadSpec } from '@novelcraft/llm-step';
import * as imports from '@novelcraft/imports';
import type { RunStateTransaction } from '@novelcraft/imports';
import { CrashSimulatedError, gitAdd, gitCommit } from '@novelcraft/store';
import { ingestChapter } from '@novelcraft/writing';
import { NovelCraftService } from '../src/index.js';
import { DeepImportDeniedError, ImportTraceSink, importTraceFile } from '../src/internal.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}

/** 2 章(每章 1 Scene)全链 happy 响应(严格按调用顺序: slice2 enrich2 fuse1 entity2 alias2 structure1)。 */
function happyResponses(): object[] {
  return [
    { scenes: [sceneJson(1, 'S1', 'A1')] },
    { scenes: [sceneJson(2, 'S2', 'A2')] },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { boundaries: [{ left_candidate_id: 'ch1-s0', right_candidate_id: 'ch2-s0', relation: 'separate', confidence: 0.9 }] },
    { entities: [] },
    { entities: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { threads: [], arcs: [], foreshadowing: [], reveals: [] },
  ];
}

/** 2b 非空响应(每 Scene 1 别名 + 1 关系): 触发 2b 独立审批并改写 canonical 对象。 */
function rich2bResponse(): object {
  return {
    aliases: [{ entity_ref: '人物甲', alias: '红衣女子', confidence: 0.8 }],
    relations: [{ source_ref: '人物乙', target_ref: '人物甲', relation_type: 'associate', confidence: 0.8 }],
    uncertain_items: [],
  };
}

/** 2 章全链响应, 2b 两批均产出实际别名/关系(供「三次独立授权 + 2b 明细摘要」断言)。 */
function richResponses(): object[] {
  return [
    { scenes: [sceneJson(1, 'S1', 'A1')] },
    { scenes: [sceneJson(2, 'S2', 'A2')] },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { boundaries: [{ left_candidate_id: 'ch1-s0', right_candidate_id: 'ch2-s0', relation: 'separate', confidence: 0.9 }] },
    { entities: [] },
    { entities: [] },
    rich2bResponse(),
    rich2bResponse(),
    { threads: [], arcs: [], foreshadowing: [], reveals: [] },
  ];
}

/** 造两个 canonical 对象(2b 的可写目标; N23 必填 id/kind/name/status 齐备), 连同章节一并提交。 */
function seedCanonicalObjects(root: string): void {
  writeFileSync(path.join(root, 'world', 'objects', 'obj-a.md'), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
  writeFileSync(path.join(root, 'world', 'objects', 'obj-b.md'), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
  gitAdd(root);
  gitCommit(root, 'seed objects');
}

interface Env {
  h: HarnessServices;
  service: NovelCraftService;
  root: string;
  vaultsDir: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

/**
 * 组装真实 DSH 服务(假 approval 按 sequence 消费, 耗尽后回落 outcome)。
 * 放行后既有流程测试的 approval 决策序列前置 allowed-once: sequence[0] = 范围授权
 * (authorize_deep_import)决策, 后续(commit_scenes / alias_relation)走 outcome 回落。
 */
async function setup(approvalOutcome: 'allowed-once' | 'rejected' = 'allowed-once', sequence: ApprovalOutcome[] = []): Promise<Env> {
  const h = await makeContext({
    approval: { outcome: approvalOutcome, ...(sequence.length ? { sequence } : {}) },
  });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-deep-'));
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
  const binding = service.vaults.ensureVault('测试书');
  await service.vaults.bindSession('s1', binding);
  const root = binding.root;
  ingestChapter(root, { chapterIndex: 1, text: '第一章正文。', source: 'paste' });
  ingestChapter(root, { chapterIndex: 2, text: '第二章正文。', source: 'paste' });
  // R17: commitScenes/2b apply 写前要求范围外干净工作区 → 夹具提交初始状态
  // (checkpoint 与 import-trace.jsonl 属导入流程工件, 不视为脏)。
  gitAdd(root);
  gitCommit(root, 'fixture init');
  return {
    h,
    service,
    root,
    vaultsDir,
    tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

function readTraceEvents(root: string): Array<{ type: string; phase?: string; decision?: string }> {
  const file = importTraceFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** porcelain 状态行(非空即脏)。 */
function gitStatus(root: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** HEAD 树中是否存在相对路径(深导工件是否已进 git 历史)。 */
function gitHeadHas(root: string, rel: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** HEAD 中相对路径的原始内容(断言 trace 全文进 git, 含 complete_import)。 */
function gitShow(root: string, rel: string): string {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' });
}

describe('deepImport(DSH 挂载)', () => {
  it('公开工具全链: tool→service→provider + 三次独立授权/信号 + durable seam/trace 闭环(R40/N33)', async () => {
    const env = await setup('allowed-once', ['allowed-once']);
    // 2b 需有可写 canonical 目标 + 非空建议才会请求独立审批(复核纪律: 先只读 propose,
    // 有实际变更才审批); 空建议时不再发起第二次审批。
    writeFileSync(paths(env.root).assistant.llm, 'preset: default\n', 'utf8');
    seedCanonicalObjects(env.root);
    for (const r of richResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const tool = env.tools.find((x) => x.name === 'novelcraft_deep_import');
    expect(tool).toBeDefined();
    const controller = new AbortController();
    const profileSpy = vi.spyOn(env.service.presets, 'list');
    const engineSpy = vi.spyOn(imports.deepImportEngineSeam, 'runWorkflow');
    const applySpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'applyState');
    const loadSpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'loadRunState');
    const hasRunSpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'hasRun');
    let out!: {
      ok: boolean;
      workflow_id: string;
      adopted: number;
      committed: number;
      rejected: boolean;
      trace_file: string;
      message: string;
    };
    try {
      out = (await tool!.execute(
        { root: env.root, start_chapter: 1, end_chapter: 2 },
        { callId: 'c1', name: 'novelcraft_deep_import', arguments: {}, agent: fakeAgent, signal: controller.signal },
      )) as typeof out;
      expect(engineSpy).toHaveBeenCalledTimes(1);
      expect(engineSpy.mock.calls[0][1]).toMatchObject({ mode: 'start' });
      expect(hasRunSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
      expect(applySpy.mock.calls.length).toBeGreaterThanOrEqual(20);
      expect(profileSpy).toHaveBeenCalledTimes(1); // profile 只在工具编排入口解析一次
    } finally {
      profileSpy.mockRestore();
      engineSpy.mockRestore();
      applySpy.mockRestore();
      loadSpy.mockRestore();
      hasRunSpy.mockRestore();
    }

    expect(out).toMatchObject({ ok: true, adopted: 2, committed: 2, rejected: false });
    expect(out.workflow_id).toMatch(/^imp-[0-9a-f]{16}-/);
    expect(out.trace_file).toBe(importTraceFile(env.root));
    expect(out.message).toContain('采用 2 个 Scene');
    expect(env.h.adapter.requests).toHaveLength(10);
    expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(true);
    expect(gitShow(env.root, 'world/objects/obj-a.md')).toContain('红衣女子');

    // 三次独立授权, 互不复用: 范围授权先于 planImport; Scene adopt 另行审批; 2b 别名写入另行审批。
    const reqs = env.h.approval.requests;
    expect(reqs).toHaveLength(3);
    expect(reqs[0].reason).toContain('authorize_deep_import'); // 独立范围授权(决策序列前置)
    expect(reqs[0].reason).toContain('第 1-2 章'); // 摘要含章节范围
    expect(reqs[0].reason).toContain('LLM'); // 摘要明确将调用 LLM
    expect(reqs[0].reason).toContain('2 项变更'); // items 每章一条
    expect(reqs[1].reason).toContain('采用章节候选'); // Scene adopt 第二次申请
    // 复核纪律: 2b 第三次申请在只读 propose 之后发起, 摘要/条目列出实际将改写的
    // 目标对象与增量别名/关系(而非只有 Scene slug), 作者据明细决定放行/拒绝。
    expect(reqs[2].reason).toContain('别名/关系写入(2b)'); // 2b 第三次申请
    expect(reqs[2].reason).toContain('红衣女子'); // 实际别名
    expect(reqs[2].reason).toContain('obj-a'); // 目标对象
    expect(reqs[2].reason).toContain('obj-b'); // 目标对象
    expect(reqs[2].reason).toContain('associate'); // 实际关系类型
    expect(reqs[2].reason).toContain('2 项变更'); // items 每对象一条
    for (const req of reqs) expect(req.signal).toBe(controller.signal);

    // trace 事件按序落盘(§15)
    const events = readTraceEvents(env.root);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('begin_import');
    expect(types).toContain('approval');
    expect(types).toContain('adopt');
    expect(types[types.length - 1]).toBe('complete_import');

    // durable 深导状态与 radar Signal 均经 state transaction 进 git，不留部分写。
    expect(gitStatus(env.root)).toEqual([]);
    expect(gitHeadHas(env.root, '.assistant/checkpoint.json')).toBe(true);
    expect(gitHeadHas(env.root, '.assistant/import-trace.jsonl')).toBe(true);
    const runNs = `.assistant/import-runs/${out.workflow_id}`;
    expect(gitHeadHas(env.root, `${runNs}/run-plan.json`)).toBe(true);
    const manifest = JSON.parse(gitShow(env.root, `${runNs}/manifest.json`));
    expect(manifest.status).toBe('completed');
    expect((Object.values(manifest.batches) as Array<{ state: string }>).every((b) => b.state === 'completed')).toBe(true);
    const firstBatch = Object.values(manifest.batches)[0] as { artifactPath: string; receiptPath: string; resultHash: string };
    expect(gitHeadHas(env.root, firstBatch.artifactPath)).toBe(true);
    expect(JSON.parse(gitShow(env.root, firstBatch.receiptPath)).resultHash).toBe(firstBatch.resultHash);
    // HEAD 中的 trace 全文 = 事件流(complete_import 是最后一条), checkpoint 含授权快照
    const headEvents = gitShow(env.root, '.assistant/import-trace.jsonl')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(headEvents[headEvents.length - 1].type).toBe('complete_import');
    expect(gitShow(env.root, '.assistant/checkpoint.json')).toContain('authorization_confirmed');
    env.cleanup();
  });

  it('范围授权拒绝 → 零副作用: 无 provider 调用、无 plan/checkpoint/trace 文件、无 canonical 写(R40 fail-closed)', async () => {
    const env = await setup('rejected', ['rejected']);
    // 不 enqueue 任何响应: 若误走 planImport/runDeepImport 会触发 provider 调用或文件写入。

    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
    ).rejects.toBeInstanceOf(DeepImportDeniedError);

    // 仅一次审批请求 = 范围授权(拒绝先行, 后续阶段零调用)
    expect(env.h.approval.requests).toHaveLength(1);
    expect(env.h.approval.requests[0].reason).toContain('authorize_deep_import');
    expect(env.h.adapter.requests).toHaveLength(0); // 零 provider 调用
    expect(existsSync(paths(env.root).assistant.checkpoint)).toBe(false); // 无 plan/checkpoint
    expect(existsSync(importTraceFile(env.root))).toBe(false); // 无 trace 文件
    expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(false); // 无 canonical 写
    env.cleanup();
  });

  it('章节范围非法(倒序/非整数/<1)→ 直接抛错, 不弹审批、零副作用', async () => {
    const env = await setup('allowed-once');
    // 三类非法范围均在范围授权(authorize_deep_import)之前被拒 —— 不弹审批,
    // 避免 scopeAuthorizationItems/摘要对倒序或非整数生成误导性内容。
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 3, endChapter: 2 }),
    ).rejects.toThrow(/章节范围非法/);
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 1.5, endChapter: 2 }),
    ).rejects.toThrow(/章节范围非法/);
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 0, endChapter: 2 }),
    ).rejects.toThrow(/章节范围非法/);
    expect(env.h.approval.requests).toHaveLength(0); // 未弹任何审批
    expect(env.h.adapter.requests).toHaveLength(0);
    expect(existsSync(paths(env.root).assistant.checkpoint)).toBe(false); // 无 plan/checkpoint
    expect(existsSync(importTraceFile(env.root))).toBe(false); // 无 trace 文件
    env.cleanup();
  });

  it('无 agent(审批不可用)→ unavailable fail-closed, 零副作用', async () => {
    const env = await setup('allowed-once');
    await expect(
      env.service.deepImport(undefined, env.root, { startChapter: 1, endChapter: 2 }),
    ).rejects.toMatchObject({ decision: 'unavailable' });
    expect(env.h.approval.requests).toHaveLength(0); // 无 agent = gate 直接 unavailable, 未经假审批服务
    expect(env.h.adapter.requests).toHaveLength(0);
    expect(existsSync(importTraceFile(env.root))).toBe(false);
    env.cleanup();
  });

  it('公开工具: Scene adopt 审批拒绝 → 宿主失败通道; canonical 零写但 state/trace 洁净闭环(§9)', async () => {
    const env = await setup('rejected', ['allowed-once', 'rejected']); // 范围放行, adopt 拒绝
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const tool = env.tools.find((x) => x.name === 'novelcraft_deep_import');
    expect(tool).toBeDefined();
    await expect(tool!.execute(
      { root: env.root, start_chapter: 1, end_chapter: 2 },
      { callId: 'c1', name: 'novelcraft_deep_import', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(false);

    const events = readTraceEvents(env.root);
    expect(events.map((e) => e.type)).toContain('reject');
    expect(events.map((e) => e.type)).not.toContain('adopt');

    // rejected 闭环同样做 state commit: 工作区洁净, checkpoint/trace(含 reject+complete_import)进 git
    expect(gitStatus(env.root)).toEqual([]);
    expect(gitHeadHas(env.root, '.assistant/checkpoint.json')).toBe(true);
    expect(gitHeadHas(env.root, '.assistant/import-trace.jsonl')).toBe(true);
    const headEvents = gitShow(env.root, '.assistant/import-trace.jsonl')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(headEvents.map((e: { type: string }) => e.type)).toContain('reject');
    expect(headEvents[headEvents.length - 1].type).toBe('complete_import');
    env.cleanup();
  });

  it('工具: 范围授权拒绝 → 宿主失败通道, 零副作用', async () => {
    const env = await setup('rejected', ['rejected']);
    const t = env.tools.find((x) => x.name === 'novelcraft_deep_import');
    expect(t).toBeDefined();

    await expect(t!.execute(
      { root: env.root, start_chapter: 1, end_chapter: 2 },
      { callId: 'c1', name: 'novelcraft_deep_import', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    )).rejects.toMatchObject({
      code: 'APPROVAL_REJECTED',
      message: expect.stringContaining('范围授权'),
    });
    expect(env.h.adapter.requests).toHaveLength(0);
    expect(existsSync(importTraceFile(env.root))).toBe(false);
    env.cleanup();
  });

  it('profile.workflowBudget → 全链共享累计 tracker: 预算只够首个内容步, 后续步骤 provider 前 fail-closed(审查项 3)', async () => {
    const env = await setup('allowed-once', ['allowed-once']);
    // 预算恰好够 1 次 scene_slicing(N39: 估算输入 + system 提示估算 + 输出上限;
    // spec budgetTokens=8192): slice ch1 成功(1 次 provider 调用), 之后所有内容步
    // 累计超支 → 不再调用 provider。
    const sliceSpec = loadSpec('scene_slicing')!;
    const sliceInput = '【第 1 章正文】\n第一章正文。\n';
    const perCall = estimateTokens(sliceInput) + estimateTokens(composeSystemPrompt(sliceSpec).text) + sliceSpec.budgetTokens;
    writeFileSync(paths(env.root).assistant.llm, `workflow_budget: ${perCall}\n`, 'utf8');
    gitAdd(env.root, ['.assistant/llm.yml']);
    gitCommit(env.root, 'test: configure workflow budget');
    const profile = await env.service.resolveProfile(env.root, { specRefs: imports.DEEP_IMPORT_SPEC_REFS });
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const result = await env.service.deepImport(
      fakeAgent,
      env.root,
      { startChapter: 1, endChapter: 2 },
      undefined,
      profile,
    );
    expect(env.h.adapter.requests).toHaveLength(1); // 共享累计: 只首个 slice 到达 provider
    expect(result.adopted).toBe(2); // 超支步骤走降级(1a 整章 fallback 保底), 不整链失败
    env.cleanup();
  });

  it('provider_outcome_unknown 重试前必须经 ApprovalGate 重新授权(authorize_deep_import_resume, N33 §5.0/§8)', async () => {
    const env = await setup();
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const Original = imports.deepImportEngineSeam.GitRunPersistence;
    class Crash2aPlan extends Original {
      private lastPhase = '';
      constructor(root: string) {
        super(root, {
          transactionOptions: {
            gates: async (phase: string) => {
              if (this.lastPhase === '2a' && phase === 'intent-ready') throw new CrashSimulatedError('crash-2a-plan');
            },
          },
        });
      }
      override async applyState(tx: RunStateTransaction) {
        this.lastPhase = (tx as { plan?: { phase?: string } }).plan?.phase ?? '';
        return super.applyState(tx);
      }
    }
    imports.deepImportEngineSeam.GitRunPersistence = Crash2aPlan as unknown as typeof Original;
    try {
      await expect(env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 })).rejects.toThrow(/crash-2a-plan/);
    } finally {
      imports.deepImportEngineSeam.GitRunPersistence = Original;
    }
    expect(env.h.adapter.requests).toHaveLength(5);

    env.h.adapter.enqueue(...happyResponses().slice(5).map((r) => ({ deltas: [JSON.stringify(r)] })));
    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result.adopted).toBe(2);
    expect(env.h.adapter.requests).toHaveLength(10);
    const resumeReqs = env.h.approval.requests.filter((r) => r.reason.includes('authorize_deep_import_resume'));
    expect(resumeReqs).toHaveLength(1);
    expect(resumeReqs[0].reason).toContain('结果未知');
    expect(resumeReqs[0].reason).toContain('2a');
    expect(env.h.approval.requests.map((r) =>
      r.reason.includes('authorize_deep_import_resume') ? 'resume-auth'
        : r.reason.includes('authorize_deep_import') ? 'scope-auth'
        : r.reason.includes('采用章节候选') ? 'commit' : 'other',
    )).toEqual(['scope-auth', 'commit', 'resume-auth']);
    expect(JSON.parse(gitShow(env.root, `.assistant/import-runs/${result.workflow_id}/manifest.json`)).status).toBe('completed');
    env.cleanup();
  });
});

describe('importTraceFile/ImportTraceSink: 预置 trace symlink 逃逸 fail-closed(R9)', () => {
  // 文件 symlink 探测(与 vault 测试同款; Windows 上创建文件 symlink 需开发者模式/
  // 管理员特权, 失败则整组跳过, 跨平台稳健)。
  const fileSymlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'nc-trace-filelink-probe-'));
    try {
      const target = path.join(base, 'target.txt');
      writeFileSync(target, 'x');
      symlinkSync(target, path.join(base, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  const tracePath = (root: string) => path.join(root, '.assistant', 'import-trace.jsonl');

  it.skipIf(!fileSymlinksSupported)(
    '预置 import-trace.jsonl→外部有效文件: 范围授权后首次 trace 前拒绝, 外部哨兵不被追加、无 canonical 写',
    async () => {
      const env = await setup('allowed-once', ['allowed-once']);
      const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-trace-outside-'));
      try {
        const sentinel = path.join(outside, 'sentinel.jsonl');
        writeFileSync(sentinel, 'PRESERVED\n');
        // 复现: 旧实现直接 path.join 拼路径, appendFileSync 跟随链接把 trace 事件
        // 追加到 vault 外哨兵, 绕过 guardPath。修复后 importTraceFile 必须 fail-closed。
        symlinkSync(sentinel, tracePath(env.root));
        for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

        await expect(
          env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
        ).rejects.toThrow(/escapes vault root/);

        expect(env.h.approval.requests).toHaveLength(1); // 范围授权已放行, 拒绝发生在首次 trace 前
        expect(env.h.adapter.requests).toHaveLength(0); // 零 provider 调用
        expect(readFileSync(sentinel, 'utf8')).toBe('PRESERVED\n'); // 外部哨兵不变
        expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(false); // 无 canonical 写
        expect(existsSync(paths(env.root).assistant.checkpoint)).toBe(false); // 无 plan/checkpoint
      } finally {
        rmSync(outside, { recursive: true, force: true });
        env.cleanup();
      }
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '预置 import-trace.jsonl→外部悬空目标: 拒绝且外部文件不创建(guardPath dangling fail-closed)',
    async () => {
      const env = await setup('allowed-once', ['allowed-once']);
      const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-trace-outside-'));
      try {
        const externalTarget = path.join(outside, 'never-created.jsonl');
        symlinkSync(externalTarget, tracePath(env.root));
        expect(existsSync(externalTarget)).toBe(false); // 前置: 链接悬空
        for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

        await expect(
          env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
        ).rejects.toThrow(/Cannot resolve real path|escapes vault root/);

        expect(env.h.approval.requests).toHaveLength(1);
        expect(env.h.adapter.requests).toHaveLength(0);
        expect(existsSync(externalTarget)).toBe(false); // 外部文件不得被创建
        expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        env.cleanup();
      }
    },
  );

  it.skipIf(!fileSymlinksSupported)(
    '预置 import-trace.jsonl→vault 内文件(merge-log): 仍拒绝(目标条目 symlink 一律 fail-closed, 与 typed paths 同口径)',
    async () => {
      const env = await setup('allowed-once', ['allowed-once']);
      const mergeLog = path.join(env.root, '.assistant', 'merge-log.jsonl');
      writeFileSync(mergeLog, 'KEEP\n');
      // guardPath 的 real containment 会放行 root 内 symlink; importTraceFile 必须
      // 额外拒绝目标条目本身是 symlink —— 否则 trace 事件会追加进 merge-log 资产。
      symlinkSync(mergeLog, tracePath(env.root));
      for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

      await expect(
        env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
      ).rejects.toThrow(/is a symlink/);

      expect(env.h.approval.requests).toHaveLength(1);
      expect(env.h.adapter.requests).toHaveLength(0);
      expect(readFileSync(mergeLog, 'utf8')).toBe('KEEP\n'); // 别类资产不被追加
      env.cleanup();
    },
  );
});

describe('ImportTraceSink 构造: 旧签名(file)回归 + 任意路径 fail-closed(R9)', () => {
  // 文件 symlink 探测(与上方同款; Windows 需特权, 失败跳过)。
  const fileSymlinksSupported = (() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'nc-sink-filelink-probe-'));
    try {
      const target = path.join(base, 'target.txt');
      writeFileSync(target, 'x');
      symlinkSync(target, path.join(base, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();

  it('旧签名回归: new ImportTraceSink(importTraceFile(root)) 可用, record 按序落盘', async () => {
    const env = await setup('allowed-once');
    const file = importTraceFile(env.root); // 旧外部调用形态: 合法 file 直接传入
    const sink = new ImportTraceSink(file);
    expect(sink.file).toBe(file);
    const base = {
      type: 'begin_import' as const,
      workflow_id: 'w1',
      start_chapter: 1,
      end_chapter: 2,
      authorization_confirmed: true,
    };
    const e0 = sink.record({ ...base, input_fingerprint: 'f0' });
    const e1 = sink.record({ ...base, input_fingerprint: 'f1' });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).input_fingerprint).toBe('f0');
    expect(JSON.parse(lines[1]).input_fingerprint).toBe('f1');
    env.cleanup();
  });

  it('任意路径拒绝: basename/parent 结构不符一律构造即抛(旧签名不再接受任意 file)', async () => {
    const env = await setup('allowed-once');
    // basename 不符(别类资产)
    expect(() => new ImportTraceSink(path.join(env.root, '.assistant', 'merge-log.jsonl'))).toThrow(
      /import-trace\.jsonl/,
    );
    // parent 不符(不在 .assistant 内)
    expect(() => new ImportTraceSink(path.join(env.root, 'imports', 'import-trace.jsonl'))).toThrow(
      /\.assistant/,
    );
    // 越界路径规范化后结构不符
    expect(() => new ImportTraceSink(path.join(env.root, '.assistant', '..', 'imports', 'import-trace.jsonl'))).toThrow(
      /\.assistant/,
    );
    // 空路径
    expect(() => new ImportTraceSink('')).toThrow();
    env.cleanup();
  });

  it.skipIf(!fileSymlinksSupported)(
    'symlink 落点构造即拒: 外部有效/悬空/指向 vault 内文件(ctor 内 importTraceFile 校验, 不经 deepImport)',
    async () => {
      // 1) 外部有效文件: 外部哨兵不变
      {
        const env = await setup('allowed-once');
        const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-sink-outside-'));
        try {
          const sentinel = path.join(outside, 'sentinel.jsonl');
          writeFileSync(sentinel, 'PRESERVED\n');
          symlinkSync(sentinel, path.join(env.root, '.assistant', 'import-trace.jsonl'));
          // 手工拼接路径直接构造(不先经 importTraceFile), 验证 ctor 自身 fail-closed。
          expect(() => new ImportTraceSink(path.join(env.root, '.assistant', 'import-trace.jsonl'))).toThrow(
            /escapes vault root/,
          );
          expect(readFileSync(sentinel, 'utf8')).toBe('PRESERVED\n'); // 外部哨兵不被追加
        } finally {
          rmSync(outside, { recursive: true, force: true });
          env.cleanup();
        }
      }
      // 2) 悬空目标: 外部文件不创建
      {
        const env = await setup('allowed-once');
        const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-sink-outside-'));
        try {
          const externalTarget = path.join(outside, 'never.jsonl');
          symlinkSync(externalTarget, path.join(env.root, '.assistant', 'import-trace.jsonl'));
          expect(existsSync(externalTarget)).toBe(false); // 前置: 链接悬空
          expect(() => new ImportTraceSink(path.join(env.root, '.assistant', 'import-trace.jsonl'))).toThrow(
            /Cannot resolve real path|escapes vault root/,
          );
          expect(existsSync(externalTarget)).toBe(false); // 外部文件不得创建
        } finally {
          rmSync(outside, { recursive: true, force: true });
          env.cleanup();
        }
      }
      // 3) 指向 vault 内别类文件(merge-log): 目标条目 symlink 一律拒绝
      {
        const env = await setup('allowed-once');
        const mergeLog = path.join(env.root, '.assistant', 'merge-log.jsonl');
        writeFileSync(mergeLog, 'KEEP\n');
        symlinkSync(mergeLog, path.join(env.root, '.assistant', 'import-trace.jsonl'));
        expect(() => new ImportTraceSink(path.join(env.root, '.assistant', 'import-trace.jsonl'))).toThrow(
          /is a symlink/,
        );
        expect(readFileSync(mergeLog, 'utf8')).toBe('KEEP\n'); // 别类资产不被追加
        env.cleanup();
      }
    },
  );
});
