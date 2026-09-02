// M10-B1/N40 行为契约: 长任务恢复面(workflow 工具组)。
// 断言依据: 后续开发计划.md §2 Track B(B1/B2)、ADR-0022/N33(不可变 run + 逐批恢复)、
// 铁律 3(abandon 审批 fail-closed)、铁律 2(不动 canonical, git 是回滚面)、
// R12 目录容错(坏 manifest 仍列出)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitAdd, gitCommit } from '@novelcraft/store';
import { NovelCraftService } from '../src/index.js';
import { registerNovelcraftTools, buildTools, isWorkflowTool } from '../src/tools.js';
import { makeContext } from './helpers.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h: any;
  service: NovelCraftService;
  root: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

async function setup(opts: { approval: { outcome: 'allowed-once' | 'rejected' } }): Promise<TestEnv> {
  const h = await makeContext(opts);
  // FakeApproval.config 经基类(schemastery Service)构造链归一化会丢弃 outcome 键;
  // 本文件以实例级 request 覆写固定 outcome(请求记录仍走原 push 逻辑, 断言不受影响)。
  const recorded = h.approval.requests;
  const outcome = opts.approval.outcome;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.approval as any).request = async (req: unknown) => {
    recorded.push(req as never);
    return outcome;
  };
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-wf-'));
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
  const binding = h.ctx.novelcraft.vaults.ensureVault('测试书');
  await h.ctx.novelcraft.vaults.bindSession('s1', binding);
  const root = binding.root;
  return {
    h,
    service: h.ctx.novelcraft,
    root,
    tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

function writeRunManifest(root: string, workflowId: string, doc: Record<string, unknown>): void {
  const dir = path.join(root, '.assistant', 'import-runs', workflowId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(doc), 'utf8');
}

function writeCheckpoint(root: string, planId: string, start: number, end: number): void {
  mkdirSync(path.join(root, '.assistant'), { recursive: true });
  writeFileSync(
    path.join(root, '.assistant', 'checkpoint.json'),
    JSON.stringify({ plan: { workflow_id: planId, authorization: { scope: { start_chapter: start, end_chapter: end } } } }),
    'utf8',
  );
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

const exec = (env: TestEnv, name: string, args: Record<string, unknown>) =>
  tool(env, name).execute(args, { callId: 'c1', name, arguments: args, agent: fakeAgent, signal: new AbortController().signal });

describe('workflow 工具组(M10-B1/N40)', () => {
  it('注册面: workflow 四工具完整; isWorkflowTool 前缀判定', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    expect(env.tools.filter((t) => isWorkflowTool(t.name)).map((t) => t.name)).toEqual([
      'novelcraft_workflow_inspect',
      'novelcraft_workflow_resume',
      'novelcraft_workflow_start_new',
      'novelcraft_workflow_abandon',
    ]);
    // 组开关(workflow:false → 21)在 tools-plugins.test.ts 的组契约中统一断言(此处同 ctx
    // 不可重复 provide tools 服务; buildTools 全量即 25)。
    env.cleanup();
  });

  it('inspect: 空 vault 空表; 有 run 时返回批次进度与指纹; 坏 manifest 容错列出', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    const empty = await exec(env, 'novelcraft_workflow_inspect', { root: env.root }) as { runs: unknown[] };
    expect(empty.runs).toEqual([]);
    expect(empty).toMatchObject({ ok: true, checkpoint_workflow_id: '' });

    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-1-2', {
      status: 'running',
      createdAt: '2026-08-31T00:00:00Z',
      cursor: { phase: 'slice', ordinal: 3 },
      batches: { b1: { state: 'completed' }, b2: { state: 'artifact_committed' }, b3: { state: 'waiting_approval' } },
      inputFingerprint: 'aa'.repeat(32),
      profileFingerprint: 'bb'.repeat(32),
    });
    writeRunManifest(env.root, 'imp-bad', {} as Record<string, unknown>);
    writeFileSync(path.join(env.root, '.assistant', 'import-runs', 'imp-bad', 'manifest.json'), '{ 这不是 JSON', 'utf8');
    mkdirSync(path.join(env.root, '.assistant', 'import-runs', 'imp-empty'), { recursive: true });
    writeCheckpoint(env.root, 'imp-1-2', 1, 2);

    const out = await exec(env, 'novelcraft_workflow_inspect', { root: env.root }) as {
      runs: Array<Record<string, unknown>>; checkpoint_workflow_id: string; checkpoint_scope: string;
    };
    expect(out.runs).toHaveLength(3);
    const good = out.runs.find((r) => r.status === 'running');
    expect(good).toMatchObject({
      kind: 'deep-import',
      run_dir: '.assistant/import-runs/wf-abcdef0123456789-imp-1-2',
      workflow_id: 'wf-abcdef0123456789-imp-1-2',
      cursor: { phase: 'slice', ordinal: 3 },
    });
    expect(good?.batches).toEqual({ total: 3, completed: 2, other: 1 });
    // 坏 manifest(缺 manifest.json)与结构异常 → 容错列出 corrupt
    const bad = out.runs.find((r) => r.workflow_id === 'imp-bad');
    expect(bad?.corrupt).toBeTruthy();
    const empty2 = out.runs.find((r) => r.workflow_id === 'imp-empty');
    expect(empty2?.corrupt).toContain('manifest.json 缺失');
    // checkpoint 概要
    expect(out.checkpoint_workflow_id).toBe('imp-1-2');
    expect(out.checkpoint_scope).toBe('1-2');
    env.cleanup();
  });

  it('inspect: namespace/run/checkpoint symlink 不读取 Vault 外 manifest 或 scope', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-wf-outside-'));
    try {
      const marker = 'EXTERNAL-WORKFLOW-MARKER';
      const externalRun = path.join(outside, 'external-run');
      mkdirSync(externalRun);
      writeFileSync(path.join(externalRun, 'manifest.json'), JSON.stringify({
        status: marker, createdAt: marker, batches: { leaked: { state: 'completed' } },
      }));
      writeFileSync(path.join(outside, 'checkpoint.json'), JSON.stringify({
        plan: { workflow_id: marker, authorization: { scope: { start_chapter: 77, end_chapter: 88 } } },
      }));
      const assistant = path.join(env.root, '.assistant');
      const runsRoot = path.join(assistant, 'import-runs');
      const externalNamespace = path.join(outside, 'runs');
      mkdirSync(externalNamespace);
      symlinkSync(externalRun, path.join(externalNamespace, 'outside-run'), 'dir');
      symlinkSync(externalNamespace, runsRoot, 'dir');
      symlinkSync(path.join(outside, 'checkpoint.json'), path.join(assistant, 'checkpoint.json'));

      const rootLink = await exec(env, 'novelcraft_workflow_inspect', { root: env.root });
      expect(JSON.stringify(rootLink)).not.toContain(marker);
      unlinkSync(runsRoot);
      mkdirSync(runsRoot);
      symlinkSync(externalRun, path.join(runsRoot, 'outside-run'), 'dir');
      const runLink = await exec(env, 'novelcraft_workflow_inspect', { root: env.root });
      expect(JSON.stringify(runLink)).not.toContain(marker);

      unlinkSync(path.join(runsRoot, 'outside-run'));
      const localRun = path.join(runsRoot, 'local-run');
      mkdirSync(localRun);
      symlinkSync(path.join(externalRun, 'manifest.json'), path.join(localRun, 'manifest.json'));
      const manifestLink = await exec(env, 'novelcraft_workflow_inspect', { root: env.root }) as { runs: Array<Record<string, unknown>> };
      expect(JSON.stringify(manifestLink)).not.toContain(marker);
      expect(manifestLink.runs[0]).toMatchObject({ workflow_id: 'local-run', status: 'unreadable' });
    } finally {
      env.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resume fail-closed: 无 checkpoint / workflowId 不绑定 → 拒绝并指引, 零 provider 调用', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-1-2', { status: 'running' });
    // 无 checkpoint
    await expect(exec(env, 'novelcraft_workflow_resume', { root: env.root, workflow_id: 'wf-abcdef0123456789-imp-1-2' }))
      .rejects.toMatchObject({ code: 'WORKFLOW_RESUME_INVALID', message: expect.stringContaining('checkpoint 不可读') });
    // checkpoint 指向别的 plan
    writeCheckpoint(env.root, 'imp-9-9', 9, 9);
    await expect(exec(env, 'novelcraft_workflow_resume', { root: env.root, workflow_id: 'wf-abcdef0123456789-imp-1-2' }))
      .rejects.toMatchObject({ code: 'WORKFLOW_RESUME_INVALID', message: expect.stringContaining('不绑定') });
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });

  it('abandon: 审批拒绝 → 零清理; 放行 → 删 run 目录+绑定 checkpoint 并精确 git 提交', async () => {
    // 拒绝路径
    const rej = await setup({ approval: { outcome: 'rejected' } });
    writeRunManifest(rej.root, 'wf-abcdef0123456789-imp-1-2', { status: 'failed' });
    writeCheckpoint(rej.root, 'imp-1-2', 1, 2);
    // fixture 先提交(洁净门禁在审批之前, 未提交 fixture 会先撞 DIRTY)。
    gitAdd(rej.root, ['.assistant/import-runs/wf-abcdef0123456789-imp-1-2/manifest.json', '.assistant/checkpoint.json']);
    gitCommit(rej.root, 'test: seed');
    let rejErr: unknown;
    try {
      await exec(rej, 'novelcraft_workflow_abandon', {
        root: rej.root, kind: 'deep-import', workflow_id: 'wf-abcdef0123456789-imp-1-2',
      });
    } catch (err) {
      rejErr = err;
    }
    expect((rejErr as { code?: string }).code).toBe('WORKFLOW_ABANDON_REJECTED');
    expect(existsSync(path.join(rej.root, '.assistant', 'import-runs', 'wf-abcdef0123456789-imp-1-2', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(rej.root, '.assistant', 'checkpoint.json'))).toBe(true);
    rej.cleanup();
  });

  it('abandon 放行: 删 run 目录+绑定 checkpoint 并精确 git 提交, 工作树干净', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-1-2', { status: 'failed' });
    writeCheckpoint(env.root, 'imp-1-2', 1, 2);
    // 真实 run/checkpoint 由 persistence 提交入库; fixture 对齐(否则删除无 pathspec 可记)。
    gitAdd(env.root, ['.assistant/import-runs/wf-abcdef0123456789-imp-1-2/manifest.json', '.assistant/checkpoint.json']);
    gitCommit(env.root, 'test: seed run + checkpoint');
    const out = await exec(env, 'novelcraft_workflow_abandon', {
      root: env.root, kind: 'deep-import', workflow_id: 'wf-abcdef0123456789-imp-1-2',
    }) as { abandoned: string[] };
    expect(out.abandoned).toEqual(['.assistant/import-runs/wf-abcdef0123456789-imp-1-2', '.assistant/checkpoint.json']);
    expect(existsSync(path.join(env.root, '.assistant', 'import-runs', 'wf-abcdef0123456789-imp-1-2'))).toBe(false);
    expect(existsSync(path.join(env.root, '.assistant', 'checkpoint.json'))).toBe(false);
    // 精确 git 提交: HEAD message 含 abandon; 工作树干净
    const log = execFileSync('git', ['-C', env.root, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' });
    expect(log).toContain('abandon workflow run wf-abcdef0123456789-imp-1-2');
    const status = execFileSync('git', ['-C', env.root, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.trim()).toBe('');
    env.cleanup();
  });

  it('abandon: 不存在的 run 目录 → 拒绝(零审批零副作用)', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    await expect(exec(env, 'novelcraft_workflow_abandon', {
      root: env.root, kind: 'map-atlas', workflow_id: 'no-such-run',
    })).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_FOUND' });
    expect(env.h.approval.requests).toHaveLength(0);
    env.cleanup();
  });

  it('Track B review 修复: 穿越 workflow_id 与不存在 id 一律零审批零删除(P0)', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-1-2', { status: 'failed' });
    writeCheckpoint(env.root, 'imp-1-2', 1, 2);
    gitAdd(env.root, ['.assistant/import-runs/wf-abcdef0123456789-imp-1-2/manifest.json', '.assistant/checkpoint.json']);
    gitCommit(env.root, 'test: seed');
    const victim = join(env.root, 'chapters');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'victim.txt'), '正文');
    for (const evil of ['../../chapters', '..', '.', 'wf-abcdef0123456789-imp-1-2/../../chapters', 'no-such-run']) {
      let err: unknown;
      try {
        await exec(env, 'novelcraft_workflow_abandon', { root: env.root, kind: 'deep-import', workflow_id: evil });
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string }).code).toBe('WORKFLOW_RUN_NOT_FOUND');
    }
    expect(env.h.approval.requests).toHaveLength(0); // 全部零审批
    expect(existsSync(join(victim, 'victim.txt'))).toBe(true); // 零删除
    env.cleanup();
  });

  it('Track B review 修复: 进行中状态不可 abandon(先 resume 终结)', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-3-4', { status: 'running' });
    gitAdd(env.root, ['.assistant/import-runs/wf-abcdef0123456789-imp-3-4/manifest.json']);
    gitCommit(env.root, 'test: seed running');
    let err: unknown;
    try {
      await exec(env, 'novelcraft_workflow_abandon', { root: env.root, kind: 'deep-import', workflow_id: 'wf-abcdef0123456789-imp-3-4' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('WORKFLOW_ABANDON_NOT_TERMINAL');
    expect(env.h.approval.requests).toHaveLength(0);
    env.cleanup();
  });

  it('Track B review 修复: 预存 staged 外部内容 → R17 洁净门禁拒绝, 零审批零删除', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    writeRunManifest(env.root, 'wf-abcdef0123456789-imp-1-2', { status: 'failed' });
    gitAdd(env.root, ['.assistant/import-runs/wf-abcdef0123456789-imp-1-2/manifest.json']);
    gitCommit(env.root, 'test: seed');
    // 预存 staged 外部文件(模拟崩溃事务残留/手动 stage)
    writeFileSync(join(env.root, 'chapters', 'ch1.md'), '---\ntitle: 外部\n---\n正文');
    mkdirSync(join(env.root, 'chapters'), { recursive: true });
    writeFileSync(join(env.root, 'chapters', 'ch1.md'), '正文');
    gitAdd(env.root, ['chapters/ch1.md']);
    let err: unknown;
    try {
      await exec(env, 'novelcraft_workflow_abandon', { root: env.root, kind: 'deep-import', workflow_id: 'wf-abcdef0123456789-imp-1-2' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('WORKFLOW_DIRTY_WORKSPACE');
    expect(env.h.approval.requests).toHaveLength(0);
    expect(existsSync(join(env.root, '.assistant', 'import-runs', 'wf-abcdef0123456789-imp-1-2'))).toBe(true);
    env.cleanup();
  });

  it('inspect: atlas namespace 目录 run 同样枚举(kind=map-atlas)', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    const dir = join(env.root, '.assistant', 'atlas', 'runs', 'atlas-abcdef0123456789-p1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'completed', batches: { b1: { state: 'completed' } } }));
    const out = await exec(env, 'novelcraft_workflow_inspect', { root: env.root }) as { runs: Array<Record<string, unknown>> };
    const atlas = out.runs.find((r) => r.kind === 'map-atlas');
    expect(atlas).toMatchObject({ workflow_id: 'atlas-abcdef0123456789-p1', status: 'completed' });
    expect(atlas?.batches).toEqual({ total: 1, completed: 1, other: 0 });
    env.cleanup();
  });

  it('start_new 参数面: 非法范围在授权前拒绝(与 deep_import 同口径)', async () => {
    const env = await setup({ approval: { outcome: 'allowed-once' } });
    await expect(exec(env, 'novelcraft_workflow_start_new', {
      root: env.root, start_chapter: 5, end_chapter: 1,
    })).rejects.toMatchObject({ code: 'NOVELCRAFT_TOOL_ERROR' });
    expect(env.h.approval.requests).toHaveLength(0);
    expect(env.h.adapter.requests).toHaveLength(0);
    env.cleanup();
  });
});
