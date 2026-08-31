// N34 工作区隔离(独立审查确认问题修复): 所有带 root/会访问 vault 的 agent 工具
// 统一经 resolveBoundRoot 从 exec.agent.session.id 解析绑定; 无 session/未绑定
// fail-closed; root 的 canonical(realpath)必须与绑定 root 完全一致——绝不信任任意
// root; 只读工具同规则隔离; 路径别名/symlink 指向别的 vault 一律拒绝。
// client loopback RPC 不是 agent 工具, 不在本文件约束内。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { pushSignal } from '@novelcraft/assistant';
import { gitAdd, gitCommit } from '@novelcraft/store';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const agentA = { id: 'a1', session: { id: 'sess-A' } } as never;
const agentUnbound = { id: 'u1', session: { id: 'sess-NO-BINDING' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  rootA: string;
  rootB: string;
  tools: ToolDefinition[];
  cleanup: () => void;
}

async function setup(): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-isolation-'));
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
  // 会话只绑定书 A; 书 B 是「不得被 A 会话触碰」的另一个真实 vault。
  const bindingA = service.vaults.ensureVault('书A');
  service.vaults.ensureVault('书B'); // B 存在但无任何 session 绑定(与 A 会话无关)
  await service.vaults.bindSession('sess-A', bindingA);
  const rootA = bindingA.root;
  const rootB = path.join(vaultsDir, '书B');
  return {
    h,
    service,
    vaultsDir,
    rootA,
    rootB,
    tools,
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

const execOf = (name: string, agent: unknown) => ({
  callId: 'c1',
  name,
  arguments: {},
  agent,
  signal: new AbortController().signal,
});

/** B 的可观察读写快照: 文件相对路径排序列表 + git HEAD(判零读写)。 */
function snapshot(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const relp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relp);
      else files.push(relp);
    }
  };
  if (existsSync(root)) walk(root, '');
  files.sort();
  let head = '(none)';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD', '--'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    head = '(none)';
  }
  return `${head}\n${files.join('\n')}`;
}

describe('N34 工具工作区隔离(fail-closed)', () => {
  it('无 agent session → 读写工具均拒绝, 零服务/零 fs 访问', async () => {
    const env = await setup();
    const write = tool(env, 'novelcraft_store_adopt');
    const read = tool(env, 'novelcraft_store_index');
    await expect(write.execute(
      { root: env.rootA, kind: 'object', ref: 'x' },
      execOf('novelcraft_store_adopt', undefined),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    await expect(read.execute(
      { root: env.rootA },
      execOf('novelcraft_store_index', undefined),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    expect(env.h.approval.requests).toHaveLength(0);
    env.cleanup();
  });

  it('session 未绑定(有 id 但无绑定)→ 读写工具 fail-closed', async () => {
    const env = await setup();
    const write = tool(env, 'novelcraft_inbox_act');
    await expect(write.execute(
      {
        root: env.rootA,
        signal_id: 'missing',
        action: 'defer',
      },
      execOf('novelcraft_inbox_act', agentUnbound),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    env.cleanup();
  });

  it('绑定 A 传 B root: 写工具拒绝且 B 零写入(文件树+HEAD 不变)', async () => {
    const env = await setup();
    const before = snapshot(env.rootB);
    const write = tool(env, 'novelcraft_store_adopt');
    await expect(write.execute(
      { root: env.rootB, kind: 'object', ref: '不存在' },
      execOf('novelcraft_store_adopt', agentA),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    // 拒绝发生在审批之前(审批零请求)与任何 B 的 fs 访问之前
    expect(env.h.approval.requests).toHaveLength(0);
    expect(snapshot(env.rootB)).toBe(before);
    env.cleanup();
  });

  it('绑定 A 传 B root: 读工具拒绝且不泄漏 B 数据、B 零变化', async () => {
    const env = await setup();
    // B 里放一条只属于 B 的信号: 若读工具泄漏 B, 返回值会带上它。
    const signalDir = path.join(env.rootB, '.assistant', 'signals');
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      path.join(signalDir, 'secret-b.json'),
      JSON.stringify({
        id: 'secret-b',
        radar: 'risk',
        severity: 'risk',
        title: 'B 专用信号(不该被读面返回)',
        status: 'open',
        proposed_action: 'x',
        reversibility: false,
      }),
      'utf8',
    );
    gitAdd(env.rootB);
    gitCommit(env.rootB, 'b fixture');
    const before = snapshot(env.rootB);

    const read = tool(env, 'novelcraft_inbox_view');
    await expect(read.execute(
      { root: env.rootB },
      execOf('novelcraft_inbox_view', agentA),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    // 拒绝: 不返回 B 的信号(零读泄漏), 也不写 B(零写)。
    expect(snapshot(env.rootB)).toBe(before);
    env.cleanup();
  });

  it('匹配 root(绑定 A 传 A)正常: 读/写工具均按绑定 root 执行', async () => {
    const env = await setup();
    // 读: 索引重建(快路径, 无需审批)。
    const read = tool(env, 'novelcraft_store_index');
    const outR = (await read.execute(
      { root: env.rootA },
      execOf('novelcraft_store_index', agentA),
    )) as { objects?: number; ok?: boolean };
    expect(outR.ok ?? outR.objects !== undefined).toBe(true);

    // 写: 领域 producer 先在 A 产生信号，模型只可提交确定性决定。
    const signal = pushSignal(env.rootA, {
      radar: 'dedup',
      severity: 'hint',
      title: 'A 的信号',
      evidence: ['e'],
      proposed_action: 'p',
      reversibility: true,
    });
    const write = tool(env, 'novelcraft_inbox_act');
    const outW = (await write.execute(
      {
        root: env.rootA,
        signal_id: signal.id,
        action: 'defer',
      },
      execOf('novelcraft_inbox_act', agentA),
    )) as { ok?: boolean };
    expect(outW.ok).toBe(true);
    expect(existsSync(path.join(env.rootA, '.assistant', 'signals', `${signal.id}.json`))).toBe(true);
    expect(readdirSync(path.join(env.rootB, '.assistant', 'signals')).filter((name) => name.endsWith('.json'))).toEqual([]);
    env.cleanup();
  });

  it('realpath 别名 = 绑定 A(同一 canonical vault)→ 匹配放行, 仍以绑定 root 执行', async () => {
    const env = await setup();
    const read = tool(env, 'novelcraft_store_index');
    // 传 realpath(A): canonical 与绑定 realpath 逐字节相等 → 放行。
    const real = realpathSync(env.rootA);
    const out = (await read.execute(
      { root: real },
      execOf('novelcraft_store_index', agentA),
    )) as { ok?: boolean; objects?: number };
    expect(out.ok ?? out.objects !== undefined).toBe(true);
    // 也接受带尾部分隔符/相对规范的同一目录(realpath 归一后相同)。
    const withSlash = env.rootA + path.sep;
    const out2 = (await read.execute(
      { root: withSlash },
      execOf('novelcraft_store_index', agentA),
    )) as { ok?: boolean; objects?: number };
    expect(out2.ok ?? out2.objects !== undefined).toBe(true);
    env.cleanup();
  });

  it.skipIf(
    (() => {
      try {
        const base = mkdtempSync(path.join(os.tmpdir(), 'nc-isolation-probe-'));
        try {
          const t = path.join(base, 't');
          mkdirSync(t);
          symlinkSync(t, path.join(base, 'l'), process.platform === 'win32' ? 'junction' : 'dir');
          return false;
        } catch {
          return true;
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      } catch {
        return true;
      }
    })(),
  )('symlink 别名指向别的 vault B → 拒绝不绕过(session 仍只触 A)', async () => {
    const env = await setup();
    const linkB = path.join(env.vaultsDir, 'link-to-B');
    symlinkSync(env.rootB, linkB, process.platform === 'win32' ? 'junction' : 'dir');
    const beforeB = snapshot(env.rootB);
    const read = tool(env, 'novelcraft_store_index');
    await expect(read.execute(
      { root: linkB },
      execOf('novelcraft_store_index', agentA),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    // 读拒绝 + B 零变化。
    expect(snapshot(env.rootB)).toBe(beforeB);

    const write = tool(env, 'novelcraft_inbox_act');
    await expect(write.execute(
      {
        root: linkB,
        signal_id: 'missing',
        action: 'defer',
      },
      execOf('novelcraft_inbox_act', agentA),
    )).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    expect(snapshot(env.rootB)).toBe(beforeB);
    expect(env.h.approval.requests).toHaveLength(0);
    rmSync(linkB, { recursive: true, force: true });
    env.cleanup();
  });

  it('绑定 A 后全部工具仍可从 A 正常读(read 不因隔离被误伤)', async () => {
    const env = await setup();
    // 写一个 pending 资产进 A, 经 store_index 读面可见。
    mkdirSync(path.join(env.rootA, 'world', 'pending'), { recursive: true });
    writeFileSync(
      path.join(env.rootA, 'world', 'pending', 'pend_red.md'),
      '---\nid: pend_red\nkind: character\nname: "红衣女子"\nstatus: candidate\n---\n',
      'utf8',
    );
    gitAdd(env.rootA);
    gitCommit(env.rootA, 'a fixture');
    const read = tool(env, 'novelcraft_store_index');
    const out = (await read.execute(
      { root: env.rootA },
      execOf('novelcraft_store_index', agentA),
    )) as { objects?: number };
    expect(out.objects).toBe(1);
    // statSync 无异常 = 文件落在 A(未被隔离破坏)。
    expect(statSync(path.join(env.rootA, 'world', 'pending', 'pend_red.md')).isFile()).toBe(true);
    env.cleanup();
  });
});

// ---------------------------------------------------------------------------
// N34 全量工具矩阵: 上面的详测只抽查了 4 个工具; 这里对 25 个工具逐一验证
// 「隔离先于一切服务调用」(define.ts 的 resolveBoundRoot 在 execute 之前),
// 因此参数都是 schema 合法的哑值, 永远到达不了工具逻辑。
// ---------------------------------------------------------------------------
type MatrixEntry = { name: string; args: (root: string) => Record<string, unknown> };

const MATRIX: readonly MatrixEntry[] = [
  { name: 'novelcraft_llm_step', args: () => ({ spec: 'semantic_review', input: 'x' }) },
  { name: 'novelcraft_store_index', args: (root) => ({ root }) },
  { name: 'novelcraft_store_adopt', args: (root) => ({ root, kind: 'object', ref: 'x' }) },
  { name: 'novelcraft_inbox_view', args: (root) => ({ root }) },
  { name: 'novelcraft_inbox_act', args: (root) => ({ root, signal_id: 'missing', action: 'defer' }) },
  { name: 'novelcraft_deep_import', args: (root) => ({ root, start_chapter: 1, end_chapter: 1 }) },
  { name: 'novelcraft_propose_next_chapter', args: (root) => ({ root, chapter: 1 }) },
  { name: 'novelcraft_health_scan', args: (root) => ({ root }) },
  { name: 'novelcraft_generate_next_chapter', args: (root) => ({ root, chapter: 1, proposal_title: 't' }) },
  { name: 'novelcraft_ingest_file', args: (root) => ({ root, receipt_id: 'r' }) },
  { name: 'novelcraft_chapter_review', args: (root) => ({ root, action: 'inspect', target: 'current', chapter: 1 }) },
  { name: 'novelcraft_chapter_version', args: (root) => ({ root, action: 'inspect', chapter: 1 }) },
  { name: 'novelcraft_radar_sweep', args: (root) => ({ root }) },
  { name: 'novelcraft_rag_search', args: (root) => ({ root, query: 'q' }) },
  { name: 'novelcraft_rag_embed', args: (root) => ({ root }) },
  { name: 'novelcraft_map_atlas_plan', args: (root) => ({ root }) },
  { name: 'novelcraft_map_atlas_view', args: (root) => ({ root }) },
  { name: 'novelcraft_map_atlas_upload', args: (root) => ({ root, receipt_id: 'r' }) },
  { name: 'novelcraft_map_atlas_review', args: (root) => ({ root, action: 'adopt' }) },
  { name: 'novelcraft_map_atlas_annotation', args: (root) => ({ root }) },
  { name: 'novelcraft_map_atlas_update_prompt', args: (root) => ({ root, page_ref: 'p', prompt: 'x' }) },
  { name: 'novelcraft_workflow_inspect', args: (root) => ({ root }) },
  { name: 'novelcraft_workflow_resume', args: (root) => ({ root, workflow_id: 'w' }) },
  { name: 'novelcraft_workflow_start_new', args: (root) => ({ root, start_chapter: 1, end_chapter: 1 }) },
  { name: 'novelcraft_workflow_abandon', args: (root) => ({ root, kind: 'deep-import', workflow_id: 'w' }) },
  { name: 'novelcraft_book_list', args: () => ({}) },
  { name: 'novelcraft_book_create', args: () => ({ book: '新书' }) },
  { name: 'novelcraft_book_open', args: () => ({ book: '某书' }) },
  { name: 'novelcraft_world_create', args: (root) => ({ root, name: 'x' }) },
  { name: 'novelcraft_world_update', args: (root) => ({ root, slug: 'obj-x' }) },
  { name: 'novelcraft_outline_preview', args: (root) => ({ root, input: 'x' }) },
  { name: 'novelcraft_outline_apply', args: (root) => ({ root, run_id: 'p1' }) },
  { name: 'novelcraft_outline_item_preview', args: (root) => ({ root, target: 'plot_thread', input: 'x' }) },
  { name: 'novelcraft_outline_item_apply', args: (root) => ({ root, run_id: 'p1' }) },
  { name: 'novelcraft_world_chat', args: (root) => ({ root, input: 'x' }) },
  { name: 'novelcraft_world_converge', args: (root) => ({ root, input: 'x' }) },
  { name: 'novelcraft_world_explore', args: (root) => ({ root, input: 'x' }) },
  { name: 'novelcraft_world_inspect', args: (root) => ({ root, input: 'x' }) },
  { name: 'novelcraft_world_bible_suggest', args: (root) => ({ root, input: 'x' }) },
];

describe('N34 全量工具矩阵(39 工具逐一 fail-closed)', () => {
  it('矩阵覆盖全部注册工具(数量与名字一一对应, 新工具不得逃逸矩阵)', async () => {
    const env = await setup();
    expect(env.tools.length).toBe(39);
    expect(MATRIX.map((e) => e.name).sort()).toEqual(env.tools.map((t) => t.name).sort());
    env.cleanup();
  });

  it('无 agent → 39 工具全部拒绝, 零审批/零 provider/零 vault 访问', async () => {
    const env = await setup();
    const beforeA = snapshot(env.rootA);
    for (const entry of MATRIX) {
      const t = tool(env, entry.name);
      await expect(
        t.execute(entry.args(env.rootA), execOf(entry.name, undefined)),
        entry.name,
      ).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    }
    expect(env.h.approval.requests).toHaveLength(0);
    expect(env.h.adapter.requests).toHaveLength(0);
    expect(snapshot(env.rootA)).toBe(beforeA);
    env.cleanup();
  });

  it('session 未绑定(有 id 无绑定)→ 36 工具拒绝; book 组 3 工具例外(发现/创建/首绑入口, M11/N42)', async () => {
    const env = await setup();
    for (const entry of MATRIX) {
      // book 组(bindRoot='none', M11/N42)是「未绑定也可用」的发现/创建/首绑入口——
      // 工厂不解析 root, 未绑定会话不在本例拦截范围(正例见 book-tools.test.ts)。
      if (entry.name.startsWith('novelcraft_book_')) continue;
      const t = tool(env, entry.name);
      await expect(
        t.execute(entry.args(env.rootA), execOf(entry.name, agentUnbound)),
        entry.name,
      ).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    }
    expect(env.h.approval.requests).toHaveLength(0);
    env.cleanup();
  });

  it('绑定 A 传 B root → 带 root 参数的工具全部拒绝, B 零读写', async () => {
    const env = await setup();
    const before = snapshot(env.rootB);
    for (const entry of MATRIX) {
      // 无 root 参数的工具不适用本例: llm_step(bindRoot='session')与 book 组(bindRoot='none')。
      if (entry.name === 'novelcraft_llm_step' || entry.name.startsWith('novelcraft_book_')) continue;
      const t = tool(env, entry.name);
      await expect(
        t.execute(entry.args(env.rootB), execOf(entry.name, agentA)),
        entry.name,
      ).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION' });
    }
    expect(env.h.approval.requests).toHaveLength(0);
    expect(env.h.adapter.requests).toHaveLength(0);
    expect(snapshot(env.rootB)).toBe(before);
    env.cleanup();
  });
});
