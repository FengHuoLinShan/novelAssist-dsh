// @novelcraft/dsh · ExecutionProfile 解析与编排接线(N34 / ADR-0023 §6)。
// 断言引: N34(编排启动解析一次不可变 ExecutionProfile; 解析失败 fail-closed, 不带半解析
//         配置跑; 内部 llm-step 统一继承 timeout/预算等默认, 请求级 override 优先)、
//         ADR-0023 §6(启动解析一次、不可变、override 优先; 方案 E 拒绝逐请求动态解析)、
//         N20(预设卡注入链/覆盖链)、N5(Key 永不进文件: llm.yml 只存预设名与参数)。
// 独立审查 P1–P5 + 审查项 1/2/4/7: DSH 只组合 raw 后交 core parse(生产唯一 core
//        ExecutionProfile, version/source/policy/contractVersions 确定性)、strict llm.yml
//        单次快照解析 fail-closed(未知键/secret/非法 preset 类型/非数字/小数/越界/
//        temperature/provider/model)、伪造 profile 参数经 opaque provenance brand 拒绝
//        不可绕过(普通对象无 brand 即 INVALID_PROFILE, 不得跳过 root 解析)、llm.yml
//        单次读(双读 TOCTOU 不存在)、top_p 进 core strict 参数面与指纹(传输契约不支持
//        处明确拒绝)、malformed 行错误不回显 secret、真实 deepImport hanging timeout、
//        长输入 budget provider 前失败、temperature 覆盖 spec、override 0 生效、
//        fingerprint 接入 checkpoint/trace。
// 覆盖: 解析一次并冻结(pass-through 零重解析)、fail-closed(非法 preset/strict llm.yml
//       在 provider 前抛; deepImport 在范围授权前抛, 零审批零 provider 零文件)、
//       timeout/预算继承与请求级 override 优先; 全程不出现任何密钥材料(铁律 6)。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { gitAdd, gitCommit } from '@novelcraft/store';
import { ingestChapter } from '@novelcraft/writing';
import { readCheckpoint, resumeImport } from '@novelcraft/imports';
import { composeSystemPrompt, estimateTokens, fingerprintExecutionProfile, loadSpec, parseExecutionProfile } from '@novelcraft/llm-step';
import { paths as vaultPaths } from '@novelcraft/vault';
import { ExecutionProfileError, type ExecutionProfile } from '../src/llm/execution-profile.js';
import { NovelCraftService } from '../src/index.js';
import { FakeAdapter, makeContext, type HarnessServices } from './helpers.js';

// 审查项 2(双读 TOCTOU)计数断言需要拦截 readFileSync: 只包一层透传 vi.fn(其余 fs
// 原样透传), 计数「resolveExecutionProfile 对 llm.yml 的读取次数」(与 llm-step
// policy-strict.test.ts 同款手法)。透传对文件内其他 fs 用例无影响。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof import('node:fs').readFileSync>) =>
      (actual.readFileSync as (...a: Parameters<typeof import('node:fs').readFileSync>) => ReturnType<typeof import('node:fs').readFileSync>)(...args),
    ),
  };
});

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface Env {
  h: HarnessServices;
  service: NovelCraftService;
  root: string;
  vaultsDir: string;
  cleanup: () => void;
}

/**
 * 挂起适配器: 忽略 queue, stream 只在 req.signal abort 时结束(确定性, 无真实延时 timer)。
 * 用于 timeout 继承断言: ProviderRequest.signal 由 llm-step 每步 timeout controller 驱动,
 * wall-clock 到点即 abort(工作树既有并行修复, step.ts raceWithTimeout)。
 */
class AbortHangingAdapter extends FakeAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      options.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function setup(opts: {
  provider?: string;
  adapter?: FakeAdapter;
  durable?: boolean;
  reasoningEffort?: string;
} = {}): Promise<Env> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const provider = opts.provider ?? 'fake';
  if (opts.adapter) h.ctx.llm.registerAdapter([provider], opts.adapter);
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-prof-'));
  await h.ctx.plugin(NovelCraftService, {
    llm: {
      provider,
      model: 'fake-default',
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  // ponytail: profile/policy 组合不验证 Git，只为两条 durable deep-import 用真实 vault。
  const binding = opts.durable
    ? service.vaults.ensureVault('画像书')
    : (() => {
        const root = path.join(vaultsDir, '画像书');
        mkdirSync(path.join(root, '.assistant'), { recursive: true });
        return { book: '画像书', root, paths: vaultPaths(root) };
      })();
  await service.vaults.bindSession('s1', binding);
  return {
    h,
    service,
    root: binding.root,
    vaultsDir,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

/** 直接写 .assistant/llm.yml(N5: 只存预设名与参数, Key 永不进文件)。 */
function llmYml(root: string, content: string): void {
  writeFileSync(path.join(root, '.assistant', 'llm.yml'), content, 'utf8');
}

/** 2 章(每章 1 Scene)全链 happy 响应(严格按调用顺序: slice2 enrich2 fuse1 entity2 alias2 structure1)。 */
function happyResponses(): object[] {
  const scene = (chapter: number) => ({
    title: `S${chapter}`,
    start_chapter: chapter,
    end_chapter: chapter,
    start_anchor: `A${chapter}`,
    end_anchor: `A${chapter}`,
    confidence: 0.9,
  });
  return [
    { scenes: [scene(1)] },
    { scenes: [scene(2)] },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { emotional_beat: '平', narrative_tag: 'draft', confidence: 0.8 },
    { boundaries: [] },
    { entities: [] },
    { entities: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { aliases: [], relations: [], uncertain_items: [] },
    { threads: [], arcs: [], foreshadowing: [], reveals: [] },
  ];
}

/** 2 章深导前置: 章节落盘 + 初始提交(R17: runDeepImport 写前要求范围外干净工作区;
 *  llm.yml 需先于提交写入, 否则作为未提交文件触发 DIRTY_WORKSPACE)。 */
function seedChapters(root: string, llmYmlContent?: string): void {
  ingestChapter(root, { chapterIndex: 1, text: '第一章正文。', source: 'paste' });
  ingestChapter(root, { chapterIndex: 2, text: '第二章正文。', source: 'paste' });
  if (llmYmlContent !== undefined) llmYml(root, llmYmlContent);
  gitAdd(root);
  gitCommit(root, 'fixture init');
}

describe('解析一次并冻结(N34 §6 / ADR-0023 §6: 启动解析一次, 不可变, 透传零重解析)', () => {
  it('Config reasoningEffort 进入 core ExecutionProfile 与 fingerprint', async () => {
    const env = await setup({ reasoningEffort: 'vendor-high' });
    const withEffort = await env.service.resolveProfile(env.root);
    expect(withEffort.reasoning_effort).toBe('vendor-high');
    const withoutEffort = parseExecutionProfile({
      ...withEffort,
      reasoning_effort: undefined,
    });
    expect(fingerprintExecutionProfile(withEffort)).not.toBe(fingerprintExecutionProfile(withoutEffort));
    env.cleanup();
  });

  it('resolveProfile: 解析结果冻结; 带 profile 的 runStep/contentProviderFor 零重解析(list 只调一次)', async () => {
    const env = await setup();
    // 引用一张卡(种子 default, 无 provider 覆盖 → 仍走 Config.llm), 让「解析」可被计数。
    llmYml(env.root, 'preset: default\n');
    const listSpy = vi.spyOn(env.service.presets, 'list');
    const profile = await env.service.resolveProfile(env.root);
    expect(Object.isFrozen(profile)).toBe(true); // 物理冻结(ADR-0023 §6: 不可变)
    expect(Object.isFrozen(profile.contractVersions)).toBe(true); // 嵌套同样冻结(core parse)
    expect(profile.policy).toBe('default'); // 来源审计(生效预设名, 非 secret)
    expect(profile.source).toBe('dsh:composed:preset:default'); // 来源审计串(确定性)
    expect(profile.version).toBe('1.0.0'); // 格式版本(确定性常量)
    expect(listSpy).toHaveBeenCalledTimes(1); // 入口解析一次
    // 透传: 带 profile 的入口不再触发注册表(零重解析, 方案 E 拒绝逐请求动态解析)。
    await env.service.contentProviderFor(env.root, undefined, profile);
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const r = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文' },
      env.root,
      undefined,
      profile,
    );
    expect(r.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);
    env.cleanup();
  });

  it('组合 config < preset < llm.yml 直键: 一次解析出最终默认; 请求级 override 优先', async () => {
    const env = await setup();
    await env.service.presets.upsert({
      name: 'my-card',
      provider: 'fake',
      model: 'preset-model',
      temperature: 0.33,
      max_tokens: 4000,
      timeout_ms: 2000,
    });
    llmYml(env.root, 'preset: my-card\nmodel: yml-model\n');
    const p: ExecutionProfile = await env.service.resolveProfile(env.root);
    expect(p.provider).toBe('fake'); // 预设 provider(覆盖 Config.llm.provider)
    expect(p.model).toBe('yml-model'); // llm.yml 直键覆盖预设(N5 键划分)
    expect(p.temperature).toBe(0.33); // 预设温度(直键未设 → 预设)
    expect(p.maxTokens).toBe(4000); // 预设预算
    expect(p.timeoutMs).toBe(2000); // 预设超时
    expect(p.policy).toBe('my-card'); // policy = 生效预设名(来源审计)
    // 请求级 override 优先(对齐 N20 mergeStepOverrides): 经 runStep 后 adapter 收到 override。
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    await env.service.runStep(
      {
        specRef: 'semantic_review',
        input: '正文',
        overrides: { model: 'req-model', temperature: 0.9, maxTokens: 999, timeoutMs: 60_000 },
      },
      env.root,
    );
    const req = env.h.adapter.requests[0];
    expect(req).toMatchObject({ model: 'req-model', temperature: 0.9, maxTokens: 999 });
    env.cleanup();
  });
});

describe('fail-closed(N34 §6: 解析失败 → 编排启动失败, 零副作用, 在 provider 前)', () => {
  it('引用预设不存在 → INVALID_PRESET; runStep 在 provider 前抛(adapter 零调用)', async () => {
    const env = await setup();
    llmYml(env.root, 'preset: ghost\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_PRESET' });
    await expect(
      env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root),
    ).rejects.toMatchObject({ code: 'INVALID_PRESET' });
    expect(env.h.adapter.requests).toHaveLength(0); // provider 前抛
    env.cleanup();
  });

  it('storage 层同名覆盖出非法卡(越界 timeout_ms, 模拟旧/损坏数据)→ 引用时 INVALID_PRESET, 不静默回退', async () => {
    const env = await setup();
    // 绕过 upsert 校验直写 domain 缓存(上界 3_600_000 之外), 模拟损坏存储。
    await env.service.cache.putPreset({ name: 'bad-card', timeout_ms: 9_000_000 });
    llmYml(env.root, 'preset: bad-card\n');
    const err = await env.service.resolveProfile(env.root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionProfileError);
    expect((err as ExecutionProfileError).code).toBe('INVALID_PRESET');
    env.cleanup();
  });

  it('llm.yml timeout_ms 越界 → INVALID_LLM_YML(strict 单次快照解析 fail-closed, provider 前)', async () => {
    const env = await setup();
    llmYml(env.root, 'timeout_ms: 500\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_LLM_YML' });
    await expect(
      env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root),
    ).rejects.toMatchObject({ code: 'INVALID_LLM_YML' });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('llm.yml max_tokens 越界 → INVALID_LLM_YML(strict 解析边界校验, provider 前)', async () => {
    const env = await setup();
    llmYml(env.root, 'max_tokens: 999999999\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_LLM_YML' });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('deepImport 入口: 非法 preset 在范围授权前抛(零审批零 provider 零文件)', async () => {
    const env = await setup();
    llmYml(env.root, 'preset: ghost\n');
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_PRESET' });
    expect(env.h.approval.requests).toHaveLength(0); // 范围授权未被申请
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });
});

describe('timeout/预算继承(N34: 内部 llm-step 统一继承 profile 默认, 请求级 override 优先)', () => {
  it('profile.timeout_ms → 内部 step 以该值为 deadline 超时; override 150ms 替换 1000ms', async () => {
    const hang = new AbortHangingAdapter();
    const env = await setup({ provider: 'hang', adapter: hang });
    llmYml(env.root, 'timeout_ms: 1000\n');
    // 继承: 请求不带 override → deadline 来自 profile(1000ms; spec 默认远大于此)。
    const t0 = Date.now();
    const r1 = await env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root);
    const d1 = Date.now() - t0;
    expect(r1.ok).toBe(false);
    expect(r1.error?.kind).toBe('timeout');
    expect(d1).toBeGreaterThanOrEqual(900);
    expect(d1).toBeLessThan(5000);
    // override 优先: 150ms 替代 profile 的 1000ms(更早超时)。
    const t1 = Date.now();
    const r2 = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文', overrides: { timeoutMs: 150 } },
      env.root,
    );
    const d2 = Date.now() - t1;
    expect(r2.ok).toBe(false);
    expect(r2.error?.kind).toBe('timeout');
    expect(d2).toBeLessThan(900);
    env.cleanup();
  });

  it('profile.max_tokens:5 → 长输入 budget_exceeded(在 provider 前); override 200000 → 通过', async () => {
    const env = await setup();
    llmYml(env.root, 'max_tokens: 5\n');
    const longInput = '这是很长的一段中文输入, 用于验证执行画像预算继承是否生效。'.repeat(3);
    const r1 = await env.service.runStep({ specRef: 'semantic_review', input: longInput }, env.root);
    expect(r1.ok).toBe(false);
    expect(r1.error?.kind).toBe('budget_exceeded');
    expect(env.h.adapter.requests).toHaveLength(0); // 预算守卫先于 provider
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const r2 = await env.service.runStep(
      { specRef: 'semantic_review', input: longInput, overrides: { maxTokens: 200_000 } },
      env.root,
    );
    expect(r2.ok).toBe(true);
    expect(env.h.adapter.requests).toHaveLength(1);
    env.cleanup();
  });

  it('profile.workflowBudget → 单步 runStep 继承为累计上限: 超支在 provider 前 budget_exceeded(审查项 3)', async () => {
    const env = await setup();
    // semantic_review spec budgetTokens=0 → 单次占用 = 估算输入; workflowBudget=1 必超支。
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'workflow_budget: 1\n', 'utf8');
    const p1 = await env.service.resolveProfile(env.root);
    const r1 = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文' },
      env.root,
      undefined,
      p1,
    );
    expect(r1.ok).toBe(false);
    expect(r1.error?.kind).toBe('budget_exceeded');
    expect(r1.error?.message).toContain('工作流累计预算不足'); // 工作流级 budget(非 per-step)
    expect(env.h.adapter.requests).toHaveLength(0); // provider 前 fail-closed
    // 预算恰好等于单次占用(N39: 估算输入 + system 提示估算; semantic_review budgetTokens=0)
    // → 相等放行(边界, trySpend 不部分消费)。
    const srSpec = loadSpec('semantic_review')!;
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), `workflow_budget: ${estimateTokens('正文') + estimateTokens(composeSystemPrompt(srSpec).text)}\n`, 'utf8');
    const p2 = await env.service.resolveProfile(env.root);
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const r2 = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文' },
      env.root,
      undefined,
      p2,
    );
    expect(r2.ok).toBe(true);
    expect(env.h.adapter.requests).toHaveLength(1);
    env.cleanup();
  });
});

describe('strict llm.yml 单次快照解析 fail-closed(P3: 未知键/secret/非法类型/非数字/小数/越界/temperature/provider/model)', () => {
  const bad: Array<[string, string]> = [
    ['未知键', 'foo: 1\n'],
    ['secret 键(api_key)', 'api_key: sk-very-secret\n'],
    ['secret 键(token)', 'token: abc123\n'],
    ['preset 非法类型(数字形态)', 'preset: 123\n'],
    ['temperature 非数字', 'temperature: hot\n'],
    ['temperature 非数字形态(.nan)', 'temperature: .nan\n'],
    ['max_tokens 小数', 'max_tokens: 10.5\n'],
    ['max_tokens 小数表示(10.0)', 'max_tokens: 10.0\n'],
    ['temperature 越界(>2)', 'temperature: 3\n'],
    ['temperature 负越界', 'temperature: -0.5\n'],
    ['timeout_ms 越界', 'timeout_ms: 500\n'],
    ['max_tokens 越界', 'max_tokens: 999999999\n'],
    ['provider 空值', 'provider: ""\n'],
    ['model 含空白', 'model: "bad model"\n'],
    ['重复键', 'model: a\nmodel: b\n'],
    ['嵌套节(执行面不允许)', '  model: x\n'],
  ];
  for (const [label, content] of bad) {
    it(`${label} → resolveProfile 抛 INVALID_LLM_YML, provider 零调用`, async () => {
      const env = await setup();
      llmYml(env.root, content);
      const err = await env.service.resolveProfile(env.root).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ExecutionProfileError);
      expect((err as ExecutionProfileError).code, label).toBe('INVALID_LLM_YML');
      // fail-closed: 编排入口(runStep)同样在 provider 前抛。
      await expect(
        env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root),
      ).rejects.toMatchObject({ code: 'INVALID_LLM_YML' });
      expect(env.h.adapter.requests).toHaveLength(0);
      env.cleanup();
    });
  }

  it('合法边界值通过: temperature=0 / max_tokens=1 / timeout_ms=1000 均接受', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: 0\nmax_tokens: 1\ntimeout_ms: 1000\nprovider: fake\nmodel: edge-model\n');
    const p = await env.service.resolveProfile(env.root);
    expect(p.temperature).toBe(0); // 合法零值不丢
    expect(p.maxTokens).toBe(1);
    expect(p.timeoutMs).toBe(1000);
    expect(p.provider).toBe('fake');
    expect(p.model).toBe('edge-model');
    env.cleanup();
  });

  it('secret 键的错误消息不含任何密钥材料(铁律 6/N5)', async () => {
    const env = await setup();
    llmYml(env.root, 'api_key: sk-super-secret-material\n');
    const err = await env.service.resolveProfile(env.root).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).not.toContain('sk-super-secret-material');
    env.cleanup();
  });
});

describe('伪造 profile 拒绝(审查项 1: opaque provenance brand; 普通对象不可绕过 root 解析)', () => {
  it('越界伪造值(手构 timeoutMs: 1)→ 无 brand → INVALID_PROFILE, provider 前拒绝', async () => {
    const env = await setup();
    const forged = { version: '1.0.0', timeoutMs: 1 } as unknown as ExecutionProfile;
    await expect(
      env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root, undefined, forged),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE', kind: 'ExecutionProfileError' });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('未知/secret 键伪造值(apiKey: sk-x)→ 无 brand 即拒绝, 且消息不回显 secret 值', async () => {
    const env = await setup();
    const forged = { version: '1.0.0', apiKey: 'sk-x' } as unknown as ExecutionProfile;
    const err = await env.service
      .runStep({ specRef: 'semantic_review', input: '正文' }, env.root, undefined, forged)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_PROFILE' });
    expect(String((err as Error)?.message)).not.toContain('sk-x');
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('contentProviderFor/deepImport 同样拒绝无 brand 的伪造值(零审批零 provider 零文件)', async () => {
    const env = await setup();
    const forged = { version: '1.0.0', temperature: 9 } as unknown as ExecutionProfile;
    await expect(
      env.service.contentProviderFor(env.root, undefined, forged),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    // deepImport: 伪造 profile 在范围授权请求之前拒绝(零审批零 provider 零文件)。
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }, undefined, forged),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    expect(env.h.approval.requests).toHaveLength(0);
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('字段全合法的普通对象同样拒绝(即使已冻结/展开副本)—— 不得跳过 root 解析', async () => {
    const env = await setup();
    // 字段合法、深冻结的普通对象: 冻结 ≠ brand, 仍然拒绝。
    const frozenPlain = Object.freeze({ version: '1.0.0', model: 'evil-model' });
    await expect(
      env.service.runStep(
        { specRef: 'semantic_review', input: '正文' },
        env.root,
        undefined,
        frozenPlain as unknown as ExecutionProfile,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    // resolveProfile 产出(brand 对象)的展开副本: 同一性不同 → 同样拒绝。
    const real = await env.service.resolveProfile(env.root);
    await expect(
      env.service.runStep(
        { specRef: 'semantic_review', input: '正文' },
        env.root,
        undefined,
        { ...real } as unknown as ExecutionProfile,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    // 伪造值绝不能替换 root 解析结果: root 的 llm.yml 直键仍应生效(防「带 profile 跳过 root」)。
    llmYml(env.root, 'model: root-model\n');
    const viaRoot = await env.service.resolveProfile(env.root);
    expect(viaRoot.model).toBe('root-model');
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('公开 core parse 不能铸造 DSH provenance，且 profile 绑定当前 vault', async () => {
    const first = await setup();
    const coreOnly = parseExecutionProfile({ version: '1.0.0', model: 'core-only' });
    await expect(first.service.runStep(
      { specRef: 'semantic_review', input: '正文' }, first.root, undefined, coreOnly,
    )).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    const trusted = await first.service.resolveProfile(first.root);
    const second = await setup();
    await expect(second.service.runStep(
      { specRef: 'semantic_review', input: '正文' }, second.root, undefined, trusted,
    )).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    expect(first.h.adapter.requests).toHaveLength(0);
    expect(second.h.adapter.requests).toHaveLength(0);
    first.cleanup();
    second.cleanup();
  });

  it('内部透传可验证: resolveProfile 产出(brand)经 runStep 零重解析、零注册表读取', async () => {
    const env = await setup();
    llmYml(env.root, 'preset: default\n');
    const listSpy = vi.spyOn(env.service.presets, 'list');
    const profile = await env.service.resolveProfile(env.root);
    expect(listSpy).toHaveBeenCalledTimes(1); // 入口解析一次
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const r = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文' },
      env.root,
      undefined,
      profile,
    );
    expect(r.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1); // brand 验证零重解析(方案 E 拒绝逐请求解析)
    env.cleanup();
  });
});

describe('temperature 覆盖链(R2/P2: spec 默认 < profile 默认 < 请求 override; temperature=0 生效)', () => {
  it('profile.temperature 覆盖 spec 默认(semantic_review spec=0.1, profile=0.7 → adapter 收到 0.7)', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: 0.7\n');
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    await env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root);
    expect(env.h.adapter.requests[0].temperature).toBe(0.7);
    env.cleanup();
  });

  it('override temperature=0 不被 profile 默认吞掉(显式 undefined 判断, 非 truthiness)', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: 0.7\n');
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    await env.service.runStep(
      { specRef: 'semantic_review', input: '正文', overrides: { temperature: 0 } },
      env.root,
    );
    expect(env.h.adapter.requests[0].temperature).toBe(0);
    env.cleanup();
  });

  it('裸 runStep(provider, req) 经 provider.executionDefaults 继承 profile(不逐调用点散写)', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: 0.6\nmax_tokens: 500\ntimeout_ms: 3000\nmodel: inherit-model\n');
    const provider = await env.service.contentProviderFor(env.root);
    expect(provider.executionDefaults).toMatchObject({
      temperature: 0.6,
      maxTokens: 500,
      timeoutMs: 3000,
      model: 'inherit-model',
    });
    // 直接经「裸 runStep(provider, req)」(imports/writing/world/rag 的形态, 不经
    // service.runStep): adapter 收到 executionDefaults 继承的 temperature/maxTokens/
    // model —— 证明 bridge 使内部裸调用真正继承执行画像。
    const { runStep } = await import('@novelcraft/llm-step');
    env.h.adapter.enqueue({ deltas: ['{"findings":[],"verdict":"通过"}'] });
    const r = await runStep(provider, { specRef: 'semantic_review', input: '正文' });
    expect(r.ok).toBe(true);
    expect(env.h.adapter.requests[0]).toMatchObject({
      temperature: 0.6,
      maxTokens: 500,
      model: 'inherit-model',
    });
    env.cleanup();
  });
});

describe('真实 deepImport 挂起超时(P2: 每步 wall-clock timeout 生效, 不整链挂死)', () => {
  it('单章 hanging adapter + timeout_ms: 1000 → deepImport 有界完成, 全部 llm_step ok:false', async () => {
    const hang = new AbortHangingAdapter();
    const env = await setup({ provider: 'hang', adapter: hang, durable: true });
    seedChapters(env.root, 'timeout_ms: 1000\n');
    const t0 = Date.now();
    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 1 });
    const elapsed = Date.now() - t0;
    // 单章多阶段挂起调用 × 1000ms，外加七批 ADR-0021 Git durable commits：仍须有界完成。
    // LLM deadline 由下限与实际 request 数证明；上限包含低速 CI 的真实 Git 开销。
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(90_000);
    expect(hang.requests.length).toBeGreaterThan(0); // 确实验证过挂起调用(非零步)
    // 全部内容步超时 → 1a 整章 fallback 保底, 无任何 llm_step ok:true。
    const traceLines = readFileSync(path.join(env.root, '.assistant', 'import-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const llmSteps = traceLines.filter((e) => e.type === 'llm_step');
    expect(llmSteps.length).toBeGreaterThan(0);
    expect(llmSteps.every((e) => e.ok === false)).toBe(true);
    expect(traceLines.some((e) => e.type === 'complete_import')).toBe(true);
    expect(traceLines.filter((e) => e.type === 'checkpoint').length).toBeGreaterThanOrEqual(6);
    env.cleanup();
  });

});

describe('fingerprint 接入 deep import run/checkpoint identity(P5: 执行画像变化拒绝旧 run)', () => {
  it('checkpoint/trace 落执行指纹；画像变化后同 scope 拒绝旧 run(provider 零新增调用)', async () => {
    const env = await setup({ durable: true });
    seedChapters(env.root, 'preset: default\n');
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const first = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(first.adopted).toBe(2);
    const callsAfterFirst = env.h.adapter.requests.length;
    const cp = readCheckpoint(env.root);
    expect(cp?.profile_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(cp?.contract_versions ?? {}).sort()).toEqual(
      [
        'alias_relation', 'entity_extraction', 'scene_anchor_repair', 'scene_enrichment',
        'scene_fusion', 'scene_gap_recovery', 'scene_slicing', 'structure_analysis',
      ].sort(),
    );
    const begin = readFileSync(path.join(env.root, '.assistant', 'import-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.type === 'begin_import');
    expect(begin?.profile_fingerprint).toBe(cp?.profile_fingerprint);
    expect(begin?.contract_versions).toEqual(cp?.contract_versions);
    // 换执行画像(加 llm.yml 直键 model)→ 指纹变化 → 拒绝沿用旧 checkpoint。
    llmYml(env.root, 'preset: default\nmodel: other-model\n');
    gitAdd(env.root);
    gitCommit(env.root, 'change llm.yml');
    await expect(
      env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
    ).rejects.toThrow(/执行画像指纹变化/);
    expect(env.h.adapter.requests.length).toBe(callsAfterFirst); // 零新增 provider 调用
    // resume 同样拒绝(profileFingerprint mismatch: checkpoint 旧指纹 ≠ 当前新指纹)。
    const profile = await env.service.resolveProfile(env.root, {
      specRefs: (await import('@novelcraft/imports')).DEEP_IMPORT_SPEC_REFS,
    });
    const status = resumeImport(env.root, { profileFingerprint: fingerprintExecutionProfile(profile) });
    expect(status.resumable).toBe(false);
    expect(status.reason).toContain('执行画像指纹变化');
    env.cleanup();
  });
});

describe('审查项 2: llm.yml 单次快照组合(preset 名与直键同一文档, 双读 TOCTOU 不存在)', () => {
  it('resolveProfile 对 llm.yml 恰好一次读(preset 解析与直键解析共用同一快照)', async () => {
    const env = await setup();
    await env.service.presets.upsert({
      name: 'card-x',
      provider: 'fake',
      model: 'preset-model',
      temperature: 0.33,
      timeout_ms: 2500,
    });
    llmYml(env.root, 'preset: card-x\nmodel: yml-model\n');
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    const p = await env.service.resolveProfile(env.root);
    // 旧实现: resolveForBook(strict) 读一次 + 直键再读一次 = 2 次; 修复后 = 1 次。
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('llm.yml'))).toHaveLength(1);
    // 同一快照的结果: preset 卡字段 + 直键覆盖都生效(混合配置不可能出现)。
    expect(p.policy).toBe('card-x');
    expect(p.model).toBe('yml-model'); // 直键覆盖预设
    expect(p.temperature).toBe(0.33); // 预设温度(直键未设)
    expect(p.timeoutMs).toBe(2500); // 预设超时
    env.cleanup();
  });

  it('双读对抗: 快照时刻的 preset 与直键一致 —— 解析后改写文件不影响已组合结果', async () => {
    const env = await setup();
    await env.service.presets.upsert({ name: 'card-a', provider: 'fake', model: 'preset-a' });
    const file = path.join(env.root, '.assistant', 'llm.yml');
    writeFileSync(file, 'preset: card-a\nmodel: from-a\n', 'utf8');
    // 组合入口读取前文件是版本 A; 读取后、组合完成前改写成版本 B ——
    // 单次快照保证 preset 与直键都来自版本 A(旧双读实现可能 preset=A、model=B)。
    const snapshot = readFileSync(file, 'utf8');
    writeFileSync(file, 'preset: card-a\nmodel: from-b\n', 'utf8');
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    spy.mockImplementationOnce(() => snapshot); // 只对第一次读注入版本 A 快照
    const p = await env.service.resolveProfile(env.root);
    expect(p.model).toBe('from-a'); // 直键来自同一快照(版本 A), 绝无 B 混入
    expect(p.policy).toBe('card-a');
    env.cleanup();
  });
});

describe('审查项 4: top_p 进入 core strict 参数面与 fingerprint; 传输契约不支持处明确拒绝', () => {
  it('llm.yml top_p 在 profile resolution 阶段即拒绝，workflow fallback 不得掩盖', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: 0.4\ntop_p: 0.8\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('自定义 preset 的 top_p 同样在编排启动时拒绝', async () => {
    const env = await setup();
    await env.service.presets.upsert({
      name: 'card-tp',
      provider: 'fake',
      model: 'm1',
      top_p: 0.7,
    });
    llmYml(env.root, 'preset: card-tp\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    env.cleanup();
  });

  it('top_p 越界在组合前 fail-closed(parseLlmYmlStrict [0,1]), provider 零调用', async () => {
    const env = await setup();
    llmYml(env.root, 'top_p: 1.5\n');
    await expect(env.service.resolveProfile(env.root)).rejects.toMatchObject({ code: 'INVALID_LLM_YML' });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('传输契约(GenerateOptions 无 top_p): 请求携带 top_p → DshProvider 明确拒绝, 不静默丢弃', async () => {
    const env = await setup();
    // llm.yml 配置在编排 profile resolution 前置拒绝；请求级 override 则由 provider
    // transport guard 拒绝。两路都在 adapter/llm.stream 前 fail-closed。
    llmYml(env.root, 'top_p: 0.8\n');
    await expect(
      env.service.runStep({ specRef: 'semantic_review', input: '正文' }, env.root),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    expect(env.h.adapter.requests).toHaveLength(0);
    llmYml(env.root, '');
    // 请求级 override top_p 同样拒绝(显式路径也 fail-closed)。
    const r2 = await env.service.runStep(
      { specRef: 'semantic_review', input: '正文', overrides: { top_p: 0.2 } },
      env.root,
    );
    expect(r2.ok).toBe(false);
    expect(r2.error?.kind).toBe('provider_fatal');
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });
});

describe('审查项 7: malformed 行错误不回显原文 secret(只报行号/通用原因)', () => {
  it('llm.yml `api_key = sk-...`(无冒号)→ INVALID_LLM_YML, 消息含行号但绝不含 secret', async () => {
    const env = await setup();
    llmYml(env.root, 'api_key = sk-super-secret-material-xyz\n');
    const err = await env.service.resolveProfile(env.root).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_LLM_YML' });
    const msg = String((err as Error)?.message);
    expect(msg).toContain('第 1 行'); // 行号
    expect(msg).toContain('格式无法解析'); // 通用原因
    expect(msg).not.toContain('sk-super-secret-material-xyz'); // secret 原文不回显
    expect(msg).not.toContain('api_key ='); // 行原文不回显
    env.cleanup();
  });

  it('数字键值疑似 secret(`temperature: sk-...`)→ 只报键名/行号, 不回显值', async () => {
    const env = await setup();
    llmYml(env.root, 'temperature: sk-super-secret-material\n');
    const err = await env.service.resolveProfile(env.root).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_LLM_YML' });
    const msg = String((err as Error)?.message);
    expect(msg).toContain('temperature');
    expect(msg).toContain('第 1 行');
    expect(msg).not.toContain('sk-super-secret-material');
    env.cleanup();
  });
});
