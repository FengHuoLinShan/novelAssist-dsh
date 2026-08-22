// N33 / ADR-0022 — 生产入口(service.deepImport)消费 durable driver 的行为契约。
// 真实临时 vault + 真实 DSH 服务(假 LLM/假审批)+ imports.runDeepImportWorkflow
// (runWorkflow + GitRunPersistence)生产面:
//  - spy 证明生产入口消费 runDeepImportWorkflow / deepImportEngineSeam.runWorkflow /
//    GitRunPersistence(原型方法); run 状态(manifest/run-plan/receipt)进 git 历史;
//  - 崩溃(resume)不重复 provider / 不重复 apply: 1a artifact-receipt 事务中断 →
//    resume 补完同一事务, 已完成批不重跑、commit_scenes 审批只发生一次;
//  - provider_outcome_unknown 重试前必须经 ApprovalGate 重新授权
//    (authorize_deep_import_resume 范围/成本授权, 不是裸 boolean)。
// 断言注释引规则/裁定编号(N33 / ADR-0022 §4/§5/§6/§8 / 铁律3)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { paths } from '@novelcraft/vault';
import { CrashSimulatedError, gitAdd, gitCommit } from '@novelcraft/store';
import * as imports from '@novelcraft/imports';
import type { RunStateTransaction } from '@novelcraft/imports';
import { ingestChapter } from '@novelcraft/writing';
import { NovelCraftService } from '../src/index.js';
import { importTraceFile } from '../src/internal.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}

/** 2 章全链 happy 响应(顺序: 1a×2, 1b×2, 1c×1, 2a×2, 2b×2, 3×1 = 10 次 provider 调用)。 */
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

function rich2bResponse() {
  return {
    aliases: [{ entity_ref: '人物甲', alias: '红衣女子', confidence: 0.8 }],
    relations: [{ source_ref: '人物乙', target_ref: '人物甲', relation_type: 'associate', confidence: 0.8 }],
    uncertain_items: [],
  };
}

function richResponses(): object[] {
  const r = happyResponses();
  r[7] = rich2bResponse();
  r[8] = rich2bResponse();
  return r;
}

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
  cleanup: () => void;
}

async function setup(): Promise<Env> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-diw-'));
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
  gitAdd(root);
  gitCommit(root, 'fixture init');
  return { h, service, root, cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }) };
}

function gitShow(root: string, rel: string): string {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' });
}

function gitHeadHas(root: string, rel: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readTraceEvents(root: string): Array<{ type: string; action?: string }> {
  return readFileSync(importTraceFile(root), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}


/** 本组测试走真实 git 事务, 单测可达数十秒; 显式放宽默认超时。 */
function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 180_000);
}

describe('deepImport 生产 entry(durable driver, N33/ADR-0022)', () => {
  itSlow('消费 runDeepImportWorkflow + runWorkflow + GitRunPersistence(spy); run 状态进 git; 完成闭环工作区干净', async () => {
    const env = await setup();
    seedCanonicalObjects(env.root);
    for (const r of richResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

    // spy: 通用引擎(deepImportEngineSeam.runWorkflow 同一对象属性)+ Git 持久化适配器
    // (原型方法)——证明生产入口消费 runWorkflow 与 GitRunPersistence。
    const engineSpy = vi.spyOn(imports.deepImportEngineSeam, 'runWorkflow');
    const applySpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'applyState');
    const loadSpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'loadRunState');
    const hasRunSpy = vi.spyOn(imports.deepImportEngineSeam.GitRunPersistence.prototype, 'hasRun');
    let result: imports.DeepImportResult;
    try {
      result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });

      // 行为与 legacy 一致(六阶段 trace/adopt 语义保持)
      expect(result.adopted).toBe(2);
      expect(result.committed).toHaveLength(2);
      expect(result.aliases.approved).toBe(true);
      expect(existsSync(path.join(env.root, 'scenes', 's001.md'))).toBe(true);

      // 生产面确实消费: 内部经 deepImportEngineSeam.runWorkflow(通用引擎被调用);
      // GitRunPersistence 原型方法被消费(expected-absent 门禁 + 逐批 state 事务)
      expect(engineSpy).toHaveBeenCalledTimes(1);
      expect(engineSpy.mock.calls[0][1]).toMatchObject({ mode: 'start' });
      expect(hasRunSpy).toHaveBeenCalled();
      expect(applySpy.mock.calls.length).toBeGreaterThanOrEqual(20);
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      engineSpy.mockRestore();
      applySpy.mockRestore();
      loadSpy.mockRestore();
      hasRunSpy.mockRestore();
    }

    // run 状态(Git 持久化): manifest 7 批 completed + run-plan + receipt 进 git 历史
    const runNs = `.assistant/import-runs/${result.workflow_id}`;
    expect(gitHeadHas(env.root, `${runNs}/run-plan.json`)).toBe(true);
    expect(gitHeadHas(env.root, `${runNs}/manifest.json`)).toBe(true);
    const manifest = JSON.parse(gitShow(env.root, `${runNs}/manifest.json`));
    expect((Object.values(manifest.batches) as Array<{ state: string }>).every((b) => b.state === 'completed')).toBe(true);
    expect(manifest.status).toBe('completed');
    const entry0 = Object.values(manifest.batches)[0] as { artifactPath: string; receiptPath: string; resultHash: string };
    expect(gitHeadHas(env.root, entry0.artifactPath)).toBe(true);
    expect(gitHeadHas(env.root, entry0.receiptPath)).toBe(true);
    const receipt = JSON.parse(gitShow(env.root, entry0.receiptPath));
    expect(receipt.resultHash).toBe(entry0.resultHash);

    // 完成闭环: checkpoint(含授权快照)与 trace(complete_import 末条)进 git
    expect(gitHeadHas(env.root, '.assistant/checkpoint.json')).toBe(true);
    expect(gitHeadHas(env.root, '.assistant/import-trace.jsonl')).toBe(true);
    const headTrace = readFileSync(importTraceFile(env.root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(headTrace[headTrace.length - 1].type).toBe('complete_import');
    expect(gitShow(env.root, '.assistant/checkpoint.json')).toContain('authorization_confirmed');
    const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: env.root, encoding: 'utf8' }).trim();
    expect(gitStatus).toBe('');
    env.cleanup();
  });

  itSlow('崩溃 resume 不重复 provider/apply: 1a artifact-receipt 事务中断 → 补完同一事务, commit_scenes 审批只一次(N33 §5.1/§6)', async () => {
    const env = await setup();
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

    // 崩溃门控: 第 3 个事务(1a artifact-receipt)commit-object 阶段模拟 SIGKILL
    const Original = imports.deepImportEngineSeam.GitRunPersistence;
    class Crash1aArtifact extends Original {
      private txN = 0;
      armed = true;
      constructor(root: string) {
        super(root, {
          transactionOptions: {
            gates: async (phase: string) => {
              if (phase === 'intent-ready') this.txN += 1;
              if (this.armed && this.txN === 3 && phase === 'commit-object') {
                throw new CrashSimulatedError('crash-1a-artifact');
              }
            },
          },
        });
      }
    }
    imports.deepImportEngineSeam.GitRunPersistence = Crash1aArtifact as unknown as typeof Original;
    try {
      await expect(
        env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
      ).rejects.toThrow(/crash-1a-artifact/);
    } finally {
      imports.deepImportEngineSeam.GitRunPersistence = Original;
    }
    expect(env.h.adapter.requests).toHaveLength(2); // 仅 1a 两章 slice
    expect(env.h.approval.requests).toHaveLength(1); // 仅范围授权(commit 审批未到达)

    // resume: 同一输入重新调用 → 补完 1a 事务后继续; 已完成批不重跑、apply 不重复
    env.h.adapter.enqueue(...happyResponses().slice(2).map((r) => ({ deltas: [JSON.stringify(r)] })));
    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result.adopted).toBe(2);
    // provider 不重复: 总 10 = run1 2 + run2 8(1a 两章未重调)
    expect(env.h.adapter.requests).toHaveLength(10);
    // apply 不重复: commit_scenes 审批只发生一次(run2); 范围授权每次调用各一次
    const commitReqs = env.h.approval.requests.filter((r) => r.reason.includes('采用章节候选'));
    expect(commitReqs).toHaveLength(1);
    expect(env.h.approval.requests.filter((r) => r.reason.includes('authorize_deep_import'))).toHaveLength(2);
    const manifest = JSON.parse(gitShow(env.root, `.assistant/import-runs/${result.workflow_id}/manifest.json`));
    expect(manifest.status).toBe('completed');
    expect(gitHeadHas(env.root, 'scenes/s001.md')).toBe(true);
    const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: env.root, encoding: 'utf8' }).trim();
    expect(gitStatus).toBe('');
    env.cleanup();
  });

  itSlow('provider_outcome_unknown 重试前必须经 ApprovalGate 重新授权(authorize_deep_import_resume), 不裸 boolean 自动重试(N33 §5.0/§8)', async () => {
    const env = await setup();
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });

    // 2a batch-plan 事务 intent-ready 后崩溃 → resume 收敛后 2a = 计划已提交、无 artifact
    // = provider_outcome_unknown(输入不变 → 同一 workflowId)。
    const Original = imports.deepImportEngineSeam.GitRunPersistence;
    class Crash2aPlan extends Original {
      private lastPhase = '';
      armed = true;
      constructor(root: string) {
        super(root, {
          transactionOptions: {
            gates: async (phase: string) => {
              if (this.armed && this.lastPhase === '2a' && phase === 'intent-ready') {
                throw new CrashSimulatedError('crash-2a-plan');
              }
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
      await expect(
        env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 }),
      ).rejects.toThrow(/crash-2a-plan/);
    } finally {
      imports.deepImportEngineSeam.GitRunPersistence = Original;
    }
    expect(env.h.adapter.requests).toHaveLength(5); // 1a×2 + 1b×2 + 1c×1; 2a generator 未运行

    // resume: 命中 provider_outcome_unknown → 经 ApprovalGate 重新授权(范围/成本)后重试
    env.h.adapter.enqueue(...happyResponses().slice(5).map((r) => ({ deltas: [JSON.stringify(r)] })));
    const result = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result.adopted).toBe(2);
    expect(env.h.adapter.requests).toHaveLength(10); // 已完成批(1a/1b/1c/commit)不重跑
    // 重新授权请求: authorize_deep_import_resume(ApprovalGate), 摘要/条目列出剩余批次
    const resumeReqs = env.h.approval.requests.filter((r) => r.reason.includes('authorize_deep_import_resume'));
    expect(resumeReqs).toHaveLength(1);
    expect(resumeReqs[0].reason).toContain('结果未知');
    // 摘要/估算含剩余批次阶段(批准原因不含 items 明细, 只含项数)
    expect(resumeReqs[0].reason).toContain('2a');
    // N33 P2: 新 run 仅一次全范围授权；恢复只弹一次剩余批授权，不重复全 scope/已完成 apply。
    const actions = env.h.approval.requests.map((r) =>
      r.reason.includes('authorize_deep_import_resume') ? 'resume-auth'
        : r.reason.includes('authorize_deep_import') ? 'scope-auth'
        : r.reason.includes('采用章节候选') ? 'commit' : 'other');
    expect(actions).toEqual(['scope-auth', 'commit', 'resume-auth']);
    const manifest = JSON.parse(gitShow(env.root, `.assistant/import-runs/${result.workflow_id}/manifest.json`));
    expect(manifest.status).toBe('completed');
    env.cleanup();
  });

  itSlow('章节内容变化→新 immutable run identity，绝不续跑或覆盖旧 run(N33)', async () => {
    const env = await setup();
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const result1 = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result1.adopted).toBe(2);

    // 作者提交新源字节后重新调用：content hash 进入 inputFingerprint，产生新 workflowId；
    // 旧 run 仍保留且绝不被当作 resume。
    const ch1 = path.join(env.root, 'chapters', '001.md');
    writeFileSync(ch1, readFileSync(ch1, 'utf8') + '\n# 追加\n\n作者补充。\n');
    gitAdd(env.root);
    gitCommit(env.root, 'author: update import source');
    for (const r of happyResponses()) env.h.adapter.enqueue({ deltas: [JSON.stringify(r)] });
    const result2 = await env.service.deepImport(fakeAgent, env.root, { startChapter: 1, endChapter: 2 });
    expect(result2.workflow_id).not.toBe(result1.workflow_id);
    expect(gitHeadHas(env.root, `.assistant/import-runs/${result1.workflow_id}/manifest.json`)).toBe(true);
    expect(gitHeadHas(env.root, `.assistant/import-runs/${result2.workflow_id}/manifest.json`)).toBe(true);
    env.cleanup();
  });
});
