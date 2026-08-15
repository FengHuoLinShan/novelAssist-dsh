// @novelcraft/dsh · map-atlas 工具面端到端(Phase 5; 计划 §4 Phase 5 测试清单)。
// FakeApproval 验证 allowed-once/rejected/unavailable; 上传路径导入不误 git add 图片; annotation 校验失败零残留。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { writeAtlasNode, writeAtlasPage, readAtlasTree } from '@novelcraft/world';
import type { AtlasNode, AtlasPage } from '@novelcraft/world';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
  cleanup: () => void;
}

async function setup(approvalOutcome: 'allowed-once' | 'rejected' | 'unavailable' = 'allowed-once'): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: approvalOutcome } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-atlas-tools-'));
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
  return {
    h,
    service,
    vaultsDir,
    root: binding.root,
    tools,
    exec: {
      callId: 'c1', name: '', arguments: {},
      agent: fakeAgent, signal: new AbortController().signal,
    },
    cleanup: () => rmSync(vaultsDir, { recursive: true, force: true }),
  };
}

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};

async function call(env: TestEnv, name: string, args: Record<string, unknown>) {
  const t = tool(env, name);
  return (await t.execute(args, env.exec as never)) as Record<string, unknown>;
}

function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function node(id: string, overrides?: Partial<AtlasNode>): AtlasNode {
  return {
    id, parent_ref: null, location_ref: null, semantic_key: `entity:${id}`,
    level: 'world', title: id, status: 'provisional', sort_order: 0, ...overrides,
  };
}

function page(id: string, overrides?: Partial<AtlasPage>): AtlasPage {
  return {
    id, run_ref: 'run-t', node_ref: 'n1', generation_status: 'prompt_only',
    review_status: 'candidate', title: id, visual_brief: 'v', prompt: 'p',
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [], annotations: [], review_note: null,
    adopted_at: null, rejected_at: null, deprecated_at: null,
    content_hash: 'h-' + id, ...overrides,
  };
}

/** review_ready 挂图候选页(含真实图片文件)。 */
function readyPage(root: string, id: string, nodeRef = 'n1'): AtlasPage {
  const imgDir = path.join(root, 'world', 'atlas', 'images', id);
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(path.join(imgDir, 'v1.png'), pngBytes(64, 64));
  return page(id, {
    node_ref: nodeRef,
    generation_status: 'review_ready',
    image: { file: `images/${id}/v1.png`, media_type: 'image/png', sha256: 'x'.repeat(64), width: 64, height: 64, byte_size: 24 },
  });
}

function writeLocation(root: string, slug: string, name: string): void {
  const file = path.join(root, 'world', 'objects', `${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeFrontmatter(
    { id: slug, name, kind: 'location', status: 'canonical', aliases: [], tags: [], evidence: [] }, ''), 'utf8');
  gitAdd(root, [file]);
  gitCommit(root, `fixture location ${slug}`);
}

function writeBible(root: string, slug: string, body: string): void {
  const file = path.join(root, 'bible', `${slug}.md`);
  writeFileSync(file, serializeFrontmatter(
    { id: slug, status: 'canonical', page_type: 'location', page_key: slug, title: '临水城志', version_number: 1 }, body), 'utf8');
  gitAdd(root, [file]);
  gitCommit(root, `fixture bible ${slug}`);
}

const PLAN_JSON = JSON.stringify({
  style_brief: '写实暗色',
  nodes: [
    { plan_key: 'root-cover', title: '封面', level: 'cover', summary: '总览', visual_brief: '封面', prompt: '封面参考',
      evidence: { supported: [], visual_fill: [], conflicts: [] }, sources: [], annotations: [] },
    { plan_key: 'n-city', parent_plan_key: 'root-cover', location_ref: 'loc-00', title: '临水城', level: 'city',
      summary: 's', visual_brief: '临水城 全景', prompt: '参考',
      evidence: { supported: ['在河边'], visual_fill: [], conflicts: [] },
      sources: [{ source_type: 'bible_page', source_id: 'bp-00', open_target: { kind: 'bible_page', slug: 'bp-00' } }],
      annotations: [] },
  ],
});

describe('map-atlas 工具面(Phase 5)', () => {
  it('plan: 端到端(spatial+plan 两步假 LLM) → review_ready 候选; view 读出候选', async () => {
    const env = await setup();
    writeLocation(env.root, 'loc-00', '临水城');
    writeBible(env.root, 'bp-00', '临水城在河边。');
    env.h.adapter.enqueue({ deltas: [JSON.stringify({ locations: [{ location_key: 'loc-00', facts: [{ statement: '在河边', basis: 'explicit', source_keys: ['wiki:bp-00'] }] }] })], usage: { inputTokens: 10, outputTokens: 10 } });
    env.h.adapter.enqueue({ deltas: [PLAN_JSON], usage: { inputTokens: 10, outputTokens: 10 } });
    const r = await call(env, 'novelcraft_map_atlas_plan', { root: env.root, full_rebuild: true });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('review_ready');
    expect(r.planned_page_count).toBe(2);
    const v = await call(env, 'novelcraft_map_atlas_view', { root: env.root });
    expect(v.ok).toBe(true);
    expect(v.pending_nodes).toBe(2);
    expect(v.pending_pages).toBe(2);
    env.cleanup();
  });

  it('upload: 挂 prompt_only 页置 review_ready; 图片不进 git(N29)', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1'));
    const src = path.join(env.vaultsDir, 'src.png');
    writeFileSync(src, pngBytes(128, 96));
    const r = await call(env, 'novelcraft_map_atlas_upload', { root: env.root, file_path: src, node_ref: 'n1' });
    expect(r.ok).toBe(true);
    expect(r.page_id).toBe('pg1');
    expect(r.generation_status).toBe('review_ready');
    expect(existsSync(path.join(env.root, 'world', 'atlas', 'images', 'pg1', 'v1.png'))).toBe(true);
    const tracked = execFileSync('git', ['ls-files'], { cwd: env.root, encoding: 'utf8' });
    expect(tracked).not.toContain('images/');
    env.cleanup();
  });

  it('upload: 无 node_ref 时创建 provisional 节点(附录 A.2)', async () => {
    const env = await setup();
    const src = path.join(env.vaultsDir, 'src.png');
    writeFileSync(src, pngBytes(64, 64));
    const r = await call(env, 'novelcraft_map_atlas_upload', { root: env.root, file_path: src, title: '雾岭', level: 'region' });
    expect(r.ok).toBe(true);
    const tree = readAtlasTree(env.root);
    expect(tree.pendingNodes.some((n) => n.title === '雾岭' && n.status === 'provisional')).toBe(true);
    env.cleanup();
  });

  it('review adopt: allowed-once 通过; rejected/unavailable fail-closed', async () => {
    // allowed-once
    let env = await setup('allowed-once');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    let r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('adopted');
    env.cleanup();

    // rejected
    env = await setup('rejected');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    expect(r.ok).toBe(false);
    expect(String(r.message)).toMatch(/未获批准|fail-closed|rejected|审批/);
    expect(readAtlasTree(env.root).pendingPages.length).toBe(1); // 未动
    env.cleanup();

    // unavailable
    env = await setup('unavailable');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    expect(r.ok).toBe(false);
    expect(readAtlasTree(env.root).pendingPages.length).toBe(1);
    env.cleanup();
  });

  it('review reject/archive/restore 流转; prompt_only 拒 reject; adopt_placeholder', async () => {
    const env = await setup('allowed-once');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    writeAtlasPage(env.root, page('pg-p'));
    // prompt_only 不可驳回
    let r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg-p', action: 'reject' });
    expect(r.ok).toBe(false);
    expect(String(r.message)).toMatch(/prompt_only/);
    // adopt → archive → restore
    await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'archive' });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('deprecated');
    r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'restore' });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('adopted');
    // adopt_placeholder
    writeAtlasNode(env.root, node('n2', { title: '占位' }));
    r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, node_ref: 'n2', action: 'adopt_placeholder' });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).nodes.find((n) => n.id === 'n2')?.status).toBe('adopted');
    env.cleanup();
  });

  it('annotation: ops 模式 + 队列模式(消费后清文件); 校验失败零残留', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1'));
    // ops 模式
    let r = await call(env, 'novelcraft_map_atlas_annotation', {
      root: env.root, page_ref: 'pg1',
      ops: [{ op: 'add', label: '城门', position_x: 0.5, position_y: 0.5 }],
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    const hashAfter = readAtlasTree(env.root).pendingPages[0]?.content_hash ?? '';
    expect(hashAfter).not.toBe('h-pg1');
    // 队列模式: UI 落盘 queue 文件 → 工具消费并清文件
    const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, 'q1.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [{ op: 'add', label: '码头', position_x: 0.2, position_y: 0.8 }],
    }), 'utf8');
    writeFileSync(path.join(queueDir, 'q2-bad.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [{ op: 'add', label: 'x', position_x: 9, position_y: 0 }],
    }), 'utf8');
    r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r.queue_files).toBe(2);
    expect(r.applied).toBe(1);
    expect(r.ok).toBe(false); // q2 失败
    expect(existsSync(path.join(queueDir, 'q1.json'))).toBe(false); // 成功即清
    expect(existsSync(path.join(queueDir, 'q2-bad.json'))).toBe(true); // 失败保留待修
    const pg = readAtlasTree(env.root).pendingPages[0]!;
    expect(pg.annotations.map((a) => a.label).sort()).toEqual(['城门', '码头']); // 失败零残留
    env.cleanup();
  });

  it('annotation 队列: base_content_hash CAS 防 stale + 多 op 单 commit 原子(失败零提交, 重试不重复)', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1')); // content_hash = h-pg1
    const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
    mkdirSync(queueDir, { recursive: true });
    // ① 多 op 文件, 第二条非法 → 整文件零提交(F1 前: 第一条已 commit 且文件保留 → 重试重复)
    writeFileSync(path.join(queueDir, 'atomic.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [
        { op: 'add', label: '合法一', position_x: 0.1, position_y: 0.1 },
        { op: 'add', label: '非法二', position_x: 5, position_y: 0.5 },
      ],
    }), 'utf8');
    let r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(readAtlasTree(env.root).pendingPages[0]?.annotations.length).toBe(0); // 零残留
    expect(existsSync(path.join(queueDir, 'atomic.json'))).toBe(true); // 失败保留
    // 修好文件后重试: 两条都进, 单文件单 commit
    writeFileSync(path.join(queueDir, 'atomic.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [
        { op: 'add', label: '合法一', position_x: 0.1, position_y: 0.1 },
        { op: 'add', label: '合法二', position_x: 0.5, position_y: 0.5 },
      ],
    }), 'utf8');
    const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
    r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(2);
    expect(Number(after) - Number(before)).toBe(1); // 单 commit
    expect(existsSync(path.join(queueDir, 'atomic.json'))).toBe(false); // 成功即清
    const pg = readAtlasTree(env.root).pendingPages[0]!;
    expect(pg.annotations.map((a) => a.label).sort()).toEqual(['合法一', '合法二']); // 无重复
    // ② base_content_hash CAS: 错配 → 拒(防 stale 覆盖)
    writeFileSync(path.join(queueDir, 'stale.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1', // 实际已是新 hash
      ops: [{ op: 'add', label: '过期', position_x: 0, position_y: 0 }],
    }), 'utf8');
    r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(readAtlasTree(env.root).pendingPages[0]?.annotations.length).toBe(2);
    expect(existsSync(path.join(queueDir, 'stale.json'))).toBe(true);
    // 正确 base → 通过
    writeFileSync(path.join(queueDir, 'stale.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: pg.content_hash,
      ops: [{ op: 'add', label: '新鲜', position_x: 0, position_y: 0 }],
    }), 'utf8');
    r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    env.cleanup();
  });

  it('update_prompt: 仅 prompt_only 候选 + CAS', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg2'));
    let r = await call(env, 'novelcraft_map_atlas_update_prompt', {
      root: env.root, page_ref: 'pg1', prompt: '新参考文本', expected_content_hash: 'h-pg1',
    });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).pendingPages.find((p) => p.id === 'pg1')?.prompt).toBe('新参考文本');
    // review_ready 页拒
    r = await call(env, 'novelcraft_map_atlas_update_prompt', { root: env.root, page_ref: 'pg2', prompt: 'x' });
    expect(r.ok).toBe(false);
    env.cleanup();
  });
});
