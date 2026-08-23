// @novelcraft/dsh · 续写提案第二阶段端到端验收(fail-closed)。
// 覆盖: 计划台提案(铁律 5 临时预览)→ 正文候选(writing_generate, 只进 pending)
// → 审批门控采用(铁律 3: allowed-once 放行一次, rejected/cancelled/unavailable 一律拒绝)。
// 断言引 AGENTS.md 铁律 3/5 与规则/裁定编号(R17 干净工作区、R34 copy-on-adopt、
// R3/R19 状态机、N13 hash 格式)。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { gitAdd, gitCommit, gitLogSubjects } from '@novelcraft/store';
import { ingestChapter } from '@novelcraft/writing';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

/** 审批结果四态(与 ApprovalGate.GateDecision 对齐, fail-closed 全链路)。 */
type GateOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
  cleanup: () => void;
}

async function setup(outcome: GateOutcome = 'allowed-once'): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-cont-'));
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
  // N34: agent 工具一律从 exec.agent.session.id 解析绑定; 本套件用 fakeAgent
  // (session s1)调用工具, 因此会话必须先绑定到测试书 vault(未绑定即 fail-closed)。
  const binding = service.vaults.ensureVault('测试书');
  await service.vaults.bindSession('s1', binding);
  const root = binding.root;
  const exec = {
    callId: 'c1',
    name: '',
    arguments: {},
    agent: fakeAgent,
    signal: new AbortController().signal,
  };
  return {
    h,
    service,
    root,
    tools,
    exec,
    cleanup: () => {
      rmSync(vaultsDir, { recursive: true, force: true });
    },
  };
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

async function reviewCandidate(env: TestEnv): Promise<void> {
  env.h.adapter.enqueue({ deltas: [JSON.stringify({ findings: [], verdict: '模型原文不参与机械 pass' })] });
  const review = tool(env, 'novelcraft_chapter_review');
  const result = await review.execute(
    { root: env.root, action: 'review', target: 'candidate', chapter: 2, ref: '002' },
    { ...env.exec, name: 'novelcraft_chapter_review' },
  ) as { verdict: string };
  expect(result.verdict).toBe('pass');
}

/** fixture: 停靠第 1 章 + 提交(为后续 generate/adopt 提供上一章, 并保证 R17 干净工作区)。 */
function seedChapterOne(env: TestEnv): void {
  ingestChapter(env.root, { chapterIndex: 1, text: '第一章正文结尾', source: 'paste' });
  gitAdd(env.root);
  gitCommit(env.root, 'fixture ch1');
}

/** 提案 JSON 输出(next_chapter_proposal spec 要求 proposals 数组, 每项含 title/premise)。 */
const proposalJson = JSON.stringify({
  proposals: [
    {
      title: '雨夜对峙',
      premise: '主角与反派在桥头摊牌',
      basis: ['推进主线'],
      cost: '约 3000 字',
      risk: '需先补「桥」的设定',
    },
    { title: '故人重逢', premise: '主角偶遇旧识, 旧案浮出水面' },
  ],
});

describe('续写提案第二阶段端到端(fail-closed 验收)', () => {
  it('提案链: 计划台提案落 .assistant/proposals/(铁律 5 临时预览, 无正文写入)', async () => {
    const env = await setup();
    seedChapterOne(env);
    env.h.adapter.enqueue({ deltas: [proposalJson], usage: { inputTokens: 50, outputTokens: 200 } });
    const t = tool(env, 'novelcraft_propose_next_chapter');
    const out = (await t.execute(
      { root: env.root, chapter: 1 },
      { ...env.exec, name: 'novelcraft_propose_next_chapter' },
    )) as { ok: boolean; next_chapter: number; proposals: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.next_chapter).toBe(2);
    expect(out.proposals).toHaveLength(2);
    // 临时预览落盘(铁律 5): .assistant/proposals/next-001-*.json。
    const dir = path.join(env.root, '.assistant', 'proposals');
    const files = readdirSync(dir).filter((f) => /^next-001-.*\.json$/.test(f));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(dir, files[0]), 'utf8')).toContain('雨夜对峙');
    // 无正文/候选写入(铁律 5): 提案只进临时预览。
    expect(existsSync(path.join(env.root, 'chapters', '002.md'))).toBe(false);
    expect(existsSync(path.join(env.root, 'chapters', 'pending', '002.md'))).toBe(false);
    env.cleanup();
  });

  it('生成候选: writing_generate → chapters/pending/002.md(status=candidate, 不直写正文)', async () => {
    const env = await setup();
    seedChapterOne(env);
    env.h.adapter.enqueue({ deltas: ['第二章正文候选'], usage: { inputTokens: 80, outputTokens: 300 } });
    const t = tool(env, 'novelcraft_generate_next_chapter');
    const out = (await t.execute(
      { root: env.root, chapter: 1, proposal_title: '雨夜对峙', premise: '主角与反派在桥头摊牌' },
      { ...env.exec, name: 'novelcraft_generate_next_chapter' },
    )) as { ok: boolean; file: string };
    expect(out.ok).toBe(true);
    expect(out.file).toContain('chapters/pending/002.md');
    const candidate = path.join(env.root, 'chapters', 'pending', '002.md');
    expect(existsSync(candidate)).toBe(true);
    const raw = readFileSync(candidate, 'utf8');
    expect(raw).toContain('status: candidate');
    expect(raw).toContain('chapter_index: 2');
    expect(raw).toContain('proposal_title: "雨夜对峙"');
    expect(raw).toContain('第二章正文候选');
    // 候选只进 pending, 不直写 canonical 正文(铁律 5)。
    expect(existsSync(path.join(env.root, 'chapters', '002.md'))).toBe(false);
    env.cleanup();
  });

  it('采用放行: allowed-once → chapter_candidate 采用 → draft + commit(铁律 3)', async () => {
    const env = await setup('allowed-once');
    seedChapterOne(env);
    env.h.adapter.enqueue({ deltas: ['第二章正文候选'] });
    const gen = tool(env, 'novelcraft_generate_next_chapter');
    await gen.execute(
      { root: env.root, chapter: 1, proposal_title: '雨夜对峙' },
      { ...env.exec, name: 'novelcraft_generate_next_chapter' },
    );
    const generic = tool(env, 'novelcraft_store_adopt');
    await expect(generic.execute(
      { root: env.root, kind: 'chapter_candidate', ref: '002' },
      { ...env.exec, name: 'novelcraft_store_adopt' },
    )).rejects.toMatchObject({ code: 'STORE_VALIDATION_FAILED' });
    expect(env.h.approval.requests).toHaveLength(0); // 领域门先于 approval, 无审查不弹假确认。
    await reviewCandidate(env);
    const t = tool(env, 'novelcraft_chapter_review');
    const out = (await t.execute(
      { root: env.root, action: 'adopt', target: 'candidate', chapter: 2, ref: '002' },
      { ...env.exec, name: 'novelcraft_chapter_review' },
    )) as { ok: boolean; commit: string; message: string };
    expect(out.ok).toBe(true);
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(path.join(env.root, 'chapters', '002.md'))).toBe(true);
    // copy-on-adopt(R34): canonical 正文为 draft。
    expect(readFileSync(path.join(env.root, 'chapters', '002.md'), 'utf8')).toContain('status: draft');
    // 审批链收到请求(审计) + git 有 adopt commit。
    expect(env.h.approval.requests.length).toBeGreaterThan(0);
    expect(env.h.approval.requests[0]).toMatchObject({ toolName: 'novelcraft' });
    expect(gitLogSubjects(env.root).some((s) => s.startsWith('vault-tx vtx:'))).toBe(true);
    env.cleanup();
  });

  it.each(['rejected', 'cancelled', 'unavailable'] as const)(
    '采用拒绝(%s): fail-closed — 不写正文, pending 候选保留(铁律 3)',
    async (outcome) => {
      const env = await setup(outcome);
      seedChapterOne(env);
      env.h.adapter.enqueue({ deltas: ['第二章正文候选'] });
      const gen = tool(env, 'novelcraft_generate_next_chapter');
      await gen.execute(
        { root: env.root, chapter: 1, proposal_title: '雨夜对峙' },
        { ...env.exec, name: 'novelcraft_generate_next_chapter' },
      );
      await reviewCandidate(env);
      const t = tool(env, 'novelcraft_chapter_review');
      await expect(t.execute(
        { root: env.root, action: 'adopt', target: 'candidate', chapter: 2, ref: '002' },
        { ...env.exec, name: 'novelcraft_chapter_review' },
      )).rejects.toMatchObject({ code: `APPROVAL_${outcome.toUpperCase()}` });
      // fail-closed: 正文未写, 候选仍保留为 candidate。
      expect(existsSync(path.join(env.root, 'chapters', '002.md'))).toBe(false);
      const candidate = path.join(env.root, 'chapters', 'pending', '002.md');
      expect(existsSync(candidate)).toBe(true);
      expect(readFileSync(candidate, 'utf8')).toContain('status: candidate');
      env.cleanup();
    },
  );
});
