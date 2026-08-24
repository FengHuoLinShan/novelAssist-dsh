// @novelcraft/dsh · map-atlas 工具面端到端(Phase 5; 计划 §4 Phase 5 测试清单)。
// FakeApproval 验证 allowed-once/rejected/unavailable; 会话收据图片导入不误 git add; annotation 校验失败零残留。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { paths } from '@novelcraft/vault';
import {
  applyAtlasAnnotationOps,
  applyAtlasAnnotationOpsTx,
  consumeAtlasAnnotationQueue,
  writeAtlasNode,
  writeAtlasPage,
  readAtlasTree,
  stageAtlasImageIntake,
} from '@novelcraft/world';
import type { AtlasNode, AtlasPage } from '@novelcraft/world';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type FakeApprovalConfig, type HarnessServices } from './helpers.js';

// N35: 包装 world 标注写入口与队列消费入口为可断言 spy(真实现透传)。
// 队列消费已下沉 world.consumeAtlasAnnotationQueue(单一实现, 内部只走
// applyAtlasAnnotationOpsTx 事务面 —— 由 world 包自有测试守护);
// DSH 侧断言: 队列消费必须经该单一实现委托, 旧 sync 写面零调用。
vi.mock('@novelcraft/world', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novelcraft/world')>();
  return {
    ...actual,
    consumeAtlasAnnotationQueue: vi.fn(actual.consumeAtlasAnnotationQueue),
    applyAtlasAnnotationOpsTx: vi.fn(actual.applyAtlasAnnotationOpsTx),
    applyAtlasAnnotationOps: vi.fn(actual.applyAtlasAnnotationOps),
  };
});

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

beforeEach(() => {
  vi.clearAllMocks(); // 只清调用记录; vi.fn(actual) 实现保留。
});

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
  cleanup: () => void;
}

async function setup(
  approvalOutcome: 'allowed-once' | 'rejected' | 'unavailable' = 'allowed-once',
  approvalConfig?: FakeApprovalConfig,
): Promise<TestEnv> {
  const h = await makeContext({ approval: approvalConfig ?? { outcome: approvalOutcome } });
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
  }, 90_000);

  it('upload: 挂 prompt_only 页置 review_ready; 图片不进 git(N29)', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1'));
    const receipt = stageAtlasImageIntake(env.root, 's1', 'src.png', pngBytes(128, 96), 'n1').receiptId;
    const r = await call(env, 'novelcraft_map_atlas_upload', { root: env.root, receipt_id: receipt });
    expect(r.ok).toBe(true);
    expect(r.page_id).toBe('pg1');
    expect(r.generation_status).toBe('review_ready');
    expect(existsSync(path.join(env.root, 'world', 'atlas', 'images', 'pg1', 'v1.png'))).toBe(true);
    const tracked = execFileSync('git', ['ls-files'], { cwd: env.root, encoding: 'utf8' });
    expect(tracked).not.toContain('images/');
    env.cleanup();
  });

  it('upload: 收据锁定既有 provisional 节点, 无 prompt 页时新建候选页', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n2', { title: '雾岭', level: 'region' }));
    const receipt = stageAtlasImageIntake(env.root, 's1', 'src.png', pngBytes(64, 64), 'n2').receiptId;
    const r = await call(env, 'novelcraft_map_atlas_upload', { root: env.root, receipt_id: receipt });
    expect(r.ok).toBe(true);
    const tree = readAtlasTree(env.root);
    expect(tree.pendingNodes.some((n) => n.title === '雾岭' && n.status === 'provisional')).toBe(true);
    expect(tree.pendingPages.some((page) => page.node_ref === 'n2' && page.generation_status === 'review_ready')).toBe(true);
    env.cleanup();
  });

  it('upload: 主机路径不再是工具能力面', async () => {
    const env = await setup();
    await expect(call(env, 'novelcraft_map_atlas_upload', {
      root: env.root,
      receipt_id: '/tmp/map.png',
    })).rejects.toMatchObject({ code: 'INTAKE_INVALID' });
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
    await expect(call(env, 'novelcraft_map_atlas_review', {
      root: env.root, page_ref: 'pg1', action: 'adopt',
    })).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(readAtlasTree(env.root).pendingPages.length).toBe(1); // 未动
    env.cleanup();

    // unavailable
    env = await setup('unavailable');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    await expect(call(env, 'novelcraft_map_atlas_review', {
      root: env.root, page_ref: 'pg1', action: 'adopt',
    })).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
    expect(readAtlasTree(env.root).pendingPages.length).toBe(1);
    env.cleanup();
  });

  it('review reject/archive/restore 流转; prompt_only 拒 reject; adopt_placeholder', async () => {
    const env = await setup('allowed-once');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    writeAtlasPage(env.root, page('pg-p'));
    // prompt_only 不可驳回
    await expect(call(env, 'novelcraft_map_atlas_review', {
      root: env.root, page_ref: 'pg-p', action: 'reject',
    })).rejects.toMatchObject({ code: 'STORE_VALIDATION_FAILED', message: expect.stringContaining('prompt_only') });
    // adopt → archive → restore
    await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    let r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'archive' });
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

  it('review archive: 必经 ApprovalGate allowed-once; rejected/unavailable fail-closed 零写(N35)', async () => {
    // allowed-once → 归档成功
    let env = await setup('allowed-once');
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    let r = await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'archive' });
    expect(r.ok).toBe(true);
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('deprecated');
    env.cleanup();

    // rejected → fail-closed: 页保持 adopted, 零写(先 adopt 放行一次, archive 再拒绝)
    env = await setup('allowed-once', { sequence: ['allowed-once', 'rejected'] });
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    await expect(call(env, 'novelcraft_map_atlas_review', {
      root: env.root, page_ref: 'pg1', action: 'archive',
    })).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('adopted'); // 未动
    expect(readAtlasTree(env.root).pages[0]?.deprecated_at).toBeNull();
    env.cleanup();

    // unavailable → fail-closed 零写
    env = await setup('allowed-once', { sequence: ['allowed-once', 'unavailable'] });
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, readyPage(env.root, 'pg1'));
    await call(env, 'novelcraft_map_atlas_review', { root: env.root, page_ref: 'pg1', action: 'adopt' });
    await expect(call(env, 'novelcraft_map_atlas_review', {
      root: env.root, page_ref: 'pg1', action: 'archive',
    })).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
    expect(readAtlasTree(env.root).pages[0]?.review_status).toBe('adopted');
    env.cleanup();
  });

  it('annotation: 只消费队列(固定 schema + CAS 必填); 缺 base_content_hash/未知 op/未知字段拒绝零写且文件保留', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1')); // content_hash = h-pg1
    const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
    mkdirSync(queueDir, { recursive: true });
    // ① 好队列: page_ref + base_content_hash + ops 全齐(UI 落盘形态)
    writeFileSync(path.join(queueDir, 'q-good.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1',
      ops: [{ op: 'add', label: '城门', position_x: 0.5, position_y: 0.5 }],
    }), 'utf8');
    // ② 缺 base_content_hash → 拒绝零写(N35 queue/nohash)
    writeFileSync(path.join(queueDir, 'q-nohash.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [{ op: 'add', label: '无哈希', position_x: 0.1, position_y: 0.1 }],
    }), 'utf8');
    // ③ 未知 op 拼写(delet) → 拒绝; 绝不当作 delete 执行
    writeFileSync(path.join(queueDir, 'q-unknownop.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1',
      ops: [{ op: 'delet', id: 'ann-1' }],
    }), 'utf8');
    // ④ 未知顶层字段 → 拒绝(固定 provenance, 不猜测)
    writeFileSync(path.join(queueDir, 'q-extrafield.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1',
      provenance: 'hacker',
      ops: [{ op: 'add', label: 'x', position_x: 0, position_y: 0 }],
    }), 'utf8');
    const r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r.queue_files).toBe(4);
    expect(r.applied).toBe(1);
    expect(r).toMatchObject({ ok: true, status: 'partial' }); // 好文件已完成, 3 个坏文件保留待修
    expect(existsSync(path.join(queueDir, 'q-good.json'))).toBe(false); // 成功即清
    expect(existsSync(path.join(queueDir, 'q-nohash.json'))).toBe(true); // 失败保留待修
    expect(existsSync(path.join(queueDir, 'q-unknownop.json'))).toBe(true);
    expect(existsSync(path.join(queueDir, 'q-extrafield.json'))).toBe(true);
    const pg = readAtlasTree(env.root).pendingPages[0]!;
    expect(pg.annotations.map((a) => a.label)).toEqual(['城门']); // 失败零残留
    const hashAfter = pg.content_hash;
    expect(hashAfter).not.toBe('h-pg1');
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
      base_content_hash: 'h-pg1', // N35: CAS 必填
      ops: [
        { op: 'add', label: '合法一', position_x: 0.1, position_y: 0.1 },
        { op: 'add', label: '非法二', position_x: 5, position_y: 0.5 },
      ],
    }), 'utf8');
    let r = await call(env, 'novelcraft_map_atlas_annotation', { root: env.root });
    expect(r).toMatchObject({ ok: true, status: 'partial' });
    expect(r.applied).toBe(0);
    expect(readAtlasTree(env.root).pendingPages[0]?.annotations.length).toBe(0); // 零残留
    expect(existsSync(path.join(queueDir, 'atomic.json'))).toBe(true); // 失败保留
    // 修好文件后重试: 两条都进, 单文件单 commit
    writeFileSync(path.join(queueDir, 'atomic.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1', // 页面未变(零提交), 基线仍是 h-pg1
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
    expect(r).toMatchObject({ ok: true, status: 'partial' });
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

  it('annotation 队列(service 层): 只消费普通 .json —— symlink(指 vault 外)/目录伪 .json 忽略, 外部 JSON 不被应用/删除', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1')); // content_hash = h-pg1
    const queueDir = paths(env.root).assistant.atlas.annotationQueue;
    mkdirSync(queueDir, { recursive: true });
    // ① 好队列: 普通文件(带 CAS base)
    writeFileSync(path.join(queueDir, 'a-good.json'), JSON.stringify({
      page_ref: 'pg1',
      ops: [{ op: 'add', label: '城门', position_x: 0.5, position_y: 0.5 }],
      base_content_hash: 'h-pg1',
    }), 'utf8');
    // ② 外部 JSON: symlink 指向 vault 外(误解引用/恶意放置)——必须忽略不跟随
    const outside = path.join(env.vaultsDir, 'queue-outside.json');
    writeFileSync(outside, JSON.stringify({
      page_ref: 'pg1',
      ops: [{ op: 'add', label: '外链注入', position_x: 0.1, position_y: 0.1 }],
    }), 'utf8');
    symlinkSync(outside, path.join(queueDir, 'b-symlinked.json'));
    // ③ 目录伪装成 .json——忽略(不读不删)
    mkdirSync(path.join(queueDir, 'c-dir.json'));
    const r = await env.service.applyAtlasAnnotationQueue(env.root);
    expect(r).toMatchObject({ files: 1, applied: 1, failed: 0 });
    expect(existsSync(path.join(queueDir, 'a-good.json'))).toBe(false); // 好文件消费即清
    expect(existsSync(path.join(queueDir, 'b-symlinked.json'))).toBe(true); // symlink 保留
    expect(existsSync(path.join(queueDir, 'c-dir.json'))).toBe(true); // 目录保留
    expect(existsSync(outside)).toBe(true); // 外部文件未被删除
    // 只有好载荷进页面; 外链载荷未应用
    const pg = readAtlasTree(env.root).pendingPages.find((p) => p.id === 'pg1')!;
    expect(pg.annotations.map((a) => a.label)).toEqual(['城门']);
    env.cleanup();
  });

  it('annotation 队列消费委托 world 单一实现(N35/ADR-0021): consumeAtlasAnnotationQueue + 旧 sync 写面零调用', async () => {
    const env = await setup();
    writeAtlasNode(env.root, node('n1'));
    writeAtlasPage(env.root, page('pg1')); // content_hash = h-pg1
    const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, 'q.json'), JSON.stringify({
      page_ref: 'pg1',
      base_content_hash: 'h-pg1',
      ops: [{ op: 'add', label: '城门', position_x: 0.5, position_y: 0.5 }],
    }), 'utf8');
    const r = await env.service.applyAtlasAnnotationQueue(env.root);
    expect(r).toMatchObject({ files: 1, applied: 1, failed: 0 });
    expect(existsSync(path.join(queueDir, 'q.json'))).toBe(false); // 成功即清
    // DSH 侧只经 world 单一实现消费(其内部只走 applyAtlasAnnotationOpsTx 事务面,
    // 由 world/test/map-atlas-annotation-queue.test.ts 行为契约守护);
    // 旧 sync 兼容面在 DSH 全链零调用。
    expect(vi.mocked(consumeAtlasAnnotationQueue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consumeAtlasAnnotationQueue).mock.calls[0][0]).toBe(env.root);
    expect(vi.mocked(applyAtlasAnnotationOps)).not.toHaveBeenCalled(); // sync 兼容面零调用
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
    await expect(call(env, 'novelcraft_map_atlas_update_prompt', {
      root: env.root, page_ref: 'pg2', prompt: 'x',
    })).rejects.toMatchObject({ code: 'STORE_VALIDATION_FAILED' });
    env.cleanup();
  });
});
