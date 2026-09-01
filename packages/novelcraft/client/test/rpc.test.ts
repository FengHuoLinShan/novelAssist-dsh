// @novelcraft/dsh-client 宿主半身 RPC 处理器行为契约。
// 断言引设计文档 §9/§17 + wire 契约: watch/state 四态数据、inbox/list 卡片
// (作者语言)、inbox/act 四动词回 assistant.act(adopt 指引给助手, UI 不写资产);
// 未绑定 → capability 缺省, 不炸通道。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { listSignals, pushSignal } from '@novelcraft/assistant';
import { readAtlasTree, writeAtlasNode, writeAtlasPage } from '@novelcraft/world';
import { initVault } from '@novelcraft/vault';
import { describe, expect, it } from 'vitest';
import {
  apply as applyHostPlugin,
  createNovelcraftHandlers,
  ENDPOINTS,
  RPC_CHANNEL,
  type ChapterWorkspaceValue,
  type NovelcraftHostService,
} from '../src/index.js';
import { makeHostUi } from './host-ui.js';

interface TestEnv {
  ctx: Context;
  root: string;
  cleanup: () => void;
}

function setup(overrides: {
  service?: Partial<NovelcraftHostService>;
  llm?: { listProviders?: () => Array<{ id: string; name?: string }> };
} = {}): TestEnv {
  const ctx = new Context();
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-client-'));
  initVault(root, { title: '测试书' });
  const service: NovelcraftHostService = {
    vaults: {
      resolve: async (sessionId) => (sessionId === 's1' ? { book: '测试书', root } : undefined),
      resolveFromPath: (p) => (p.startsWith(root) ? { book: '测试书', root } : undefined),
    },
    ui: makeHostUi(overrides.service?.presets?.list),
    ...overrides.service,
  };
  ctx.provide('novelcraft', service);
  ctx.provide('jobs', {
    list: () => [{ kind: 'novelcraft-radar', status: 'running' }],
  });
  if (overrides.llm) ctx.provide('llm', overrides.llm);
  return { ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('novelcraft RPC 处理器', () => {
  it('books/list: 未绑定也可发现书，绑定时只投影当前标记而不泄露路径', async () => {
    const base = makeHostUi();
    const env = setup({ service: { ui: {
      ...base,
      read: {
        ...base.read,
        bookList: (currentRoot) => [
          { book: 'alpha', title: '甲', root: '/private/alpha', current: currentRoot === '/private/alpha' },
          { book: '测试书', title: '测试书', root: env.root, current: currentRoot === env.root },
        ],
      },
    } } });
    const h = createNovelcraftHandlers(env.ctx);

    const unbound = await h.booksList({ sessionId: 'unknown' });
    expect(unbound.ok).toBe(true);
    if (unbound.ok) {
      expect(unbound.value.bound).toBeNull();
      expect(unbound.value.books.every((book) => !('root' in book))).toBe(true);
      expect(unbound.value.books.every((book) => !book.current)).toBe(true);
    }

    const bound = await h.booksList({ sessionId: 's1' });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.value.bound).toEqual({ book: '测试书' });
      expect(bound.value.books.find((book) => book.book === '测试书')?.current).toBe(true);
      expect(JSON.stringify(bound.value)).not.toContain(env.root);
    }
    env.cleanup();
  });

  it('workflow/view: 四态作者投影 + 恢复动作资格', async () => {
    const base = makeHostUi();
    const env = setup({ service: { ui: {
      ...base,
      view: {
        ...base.view,
        workflowInspect: () => ({
          runs: [
            { kind: 'deep-import' as const, workflow_id: 'run-a', status: 'running', batches: { total: 4, completed: 1, other: 3 } },
            { kind: 'deep-import' as const, workflow_id: 'run-b', status: 'provider_outcome_unknown', batches: { total: 4, completed: 2, other: 2 } },
            { kind: 'map-atlas' as const, workflow_id: 'run-c', status: 'completed', batches: { total: 2, completed: 2, other: 0 } },
            { kind: 'deep-import' as const, workflow_id: 'run-d', status: 'unreadable', batches: { total: 0, completed: 0, other: 0 }, corrupt: 'raw parser details' },
          ],
          checkpoint: { workflow_id: 'cp', start_chapter: 2, end_chapter: 5 },
        }),
      },
    } } });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.workflowView({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书' });
      expect(JSON.stringify(result.value)).not.toContain(env.root);
      expect(result.value.runs.map((run) => run.state)).toEqual([
        'running', 'needs-attention', 'completed', 'failed',
      ]);
      expect(result.value.runs[0]).toMatchObject({ can_resume: true, can_abandon: false });
      expect(result.value.runs[1]).toMatchObject({ can_resume: true, can_abandon: true });
      expect(result.value.runs[2]).toMatchObject({ can_resume: false, can_abandon: true });
      expect(result.value.runs[3].message).not.toContain('raw parser details');
      expect(result.value.restart_scope).toEqual({ start_chapter: 2, end_chapter: 5 });
    }
    expect((await h.workflowView({ sessionId: 'unknown' })).ok).toBe(true);
    env.cleanup();
  });

  it('intake/stage-text: 会话授权 bytes → 收据 + 导入意图, 零章节资产写入', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const text = Buffer.from('第一章 雨夜\n雨下了一夜。', 'utf8');
    const result = await h.intakeStage({
      sessionId: 's1',
      file_name: '手稿.md',
      bytes_base64: text.toString('base64'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ file_name: '手稿.md', byte_length: text.byteLength });
      expect(result.value.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
      const sessionDirs = readdirSync(path.join(env.root, '.git', 'novelcraft-intake'));
      expect(sessionDirs).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(path.join(
        env.root, '.git', 'novelcraft-intake', sessionDirs[0], `${result.value.receipt_id}.json`,
      ), 'utf8')) as { status: string };
      expect(receipt.status).toBe('ready');
      expect(listSignals(env.root).some((signal) => signal.proposed_action.includes(result.value.receipt_id))).toBe(true);
    }
    expect(existsSync(path.join(env.root, 'chapters', '001.md'))).toBe(false);
    expect(existsSync(path.join(env.root, 'imports', 'import-log.jsonl'))).toBe(false);
    env.cleanup();
  });

  it('intake/stage-text: 未绑定/非 canonical base64/二进制均拒绝且零收据', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    expect((await h.intakeStage({ sessionId: 'unknown', file_name: 'a.txt', bytes_base64: 'YQ==' })).ok).toBe(false);
    expect((await h.intakeStage({ sessionId: 's1', file_name: 'a.txt', bytes_base64: 'not base64' })).ok).toBe(false);
    expect((await h.intakeStage({ sessionId: 's1', file_name: 'a.txt', bytes_base64: Buffer.from([0]).toString('base64') })).ok).toBe(false);
    expect(existsSync(path.join(env.root, '.git', 'novelcraft-intake'))).toBe(false);
    env.cleanup();
  });

  it('intake/stage-atlas-image: 选中节点 + 冻结图片 → 锁定目标的收据, 零地图页写入', async () => {
    const env = setup();
    writeAtlasNode(env.root, {
      id: 'n1', parent_ref: null, location_ref: null, semantic_key: 'entity:n1', level: 'world',
      title: '世界', status: 'provisional', sort_order: 0,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.intakeStageImage({
      sessionId: 's1',
      file_name: 'map.png',
      bytes_base64: pngBytes(128, 96).toString('base64'),
      node_ref: 'n1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.node_ref).toBe('n1');
      expect(listSignals(env.root).some((signal) =>
        signal.proposed_action.includes(result.value.receipt_id) && signal.proposed_action.includes('n1'))).toBe(true);
    }
    expect(readAtlasTree(env.root).pendingPages).toHaveLength(0);
    env.cleanup();
  });

  it('watch/state: 未绑定 → capability 缺省(静默零态)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ sessionId: 'unknown' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ bound: null, open: 0, attention: false, threshold: 5, radarRunning: false });
    }
    env.cleanup();
  });

  it('watch/state: 绑定 + 5 条信号 → attention(N3 阈值 5), radar 运行中可见', async () => {
    const env = setup();
    for (let i = 0; i < 5; i++) {
      pushSignal(env.root, {
        radar: 'dedup',
        severity: 'risk',
        title: `重复信号 ${i}`,
        evidence: ['第1章'],
        proposed_action: '合并',
        reversibility: true,
      });
    }
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书', root: env.root });
      expect(result.value.open).toBe(5);
      expect(result.value.attention).toBe(true);
      expect(result.value.radarRunning).toBe(true);
    }
    env.cleanup();
  });

  it('watch/state: workspacePath 回退已删(M11/N42)——无 sessionId 呈现未绑定态, 不再向上猜路径', async () => {
    const env = setup();
    pushSignal(env.root, {
      radar: 'suggest',
      severity: 'note',
      title: '补设定建议',
      evidence: ['第2章'],
      proposed_action: '生成世界书页',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.watchState({ workspacePath: path.join(env.root, 'chapters') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // N42: 路径不再是绑定权威 → 未绑定(undefined), 由 UI 呈现未绑定态。
      expect(result.value.bound).toBeNull();
      expect(result.value.open).toBe(0);
    }
    env.cleanup();
  });

  it('inbox/list: 卡片作者语言字段 + 阈值', async () => {
    const env = setup();
    pushSignal(env.root, {
      radar: 'plot',
      severity: 'conflict',
      title: '伏笔 A 与第3章冲突',
      evidence: ['伏笔列表 #1', '第3章第2节'],
      proposed_action: '回收伏笔或改写第3章',
      reversibility: false,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxList({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals).toHaveLength(1);
      expect(result.value.signals[0]).toMatchObject({
        radar: 'plot',
        severity: 'conflict',
        title: '伏笔 A 与第3章冲突',
        status: 'open',
      });
      expect(result.value.threshold).toBe(5);
    }
    env.cleanup();
  });

  it('inbox/act: accept → 记录决定 + adopt 指引(资产写入留给助手/approval)', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'dedup',
      severity: 'risk',
      title: '重复对象',
      evidence: ['第1章'],
      proposed_action: '合并',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ sessionId: 's1', signalId: sig.id, action: 'accept' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('adopt');
      expect(result.value.message).toContain('助手');
    }
    // 信号已处理: 列表不再包含
    const list = await h.inboxList({ sessionId: 's1' });
    if (list.ok) expect(list.value.signals).toHaveLength(0);
    env.cleanup();
  });

  it('inbox/act: reject 无理由 → 失败消息(校准原料必填)', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'writing',
      severity: 'note',
      title: '第1章节奏偏慢',
      evidence: ['第1章'],
      proposed_action: '删冗余段',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ sessionId: 's1', signalId: sig.id, action: 'reject' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('理由');
    env.cleanup();
  });

  it('inbox/act: modify(带理由)→ 微工作流路由', async () => {
    const env = setup();
    const sig = pushSignal(env.root, {
      radar: 'dedup',
      severity: 'risk',
      title: '「甲」与「乙」疑似重复',
      evidence: ['第2章'],
      proposed_action: '合并',
      reversibility: true,
    });
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({
      sessionId: 's1',
      signalId: sig.id,
      action: 'modify',
      reason: '不是重复, 是父子关系',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('microflow');
      expect(result.value.microflow).toBe('去重修复');
    }
    env.cleanup();
  });

  it('inbox/act: 未绑定 → 作者语言错误(不炸通道)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.inboxAct({ signalId: 'x', action: 'defer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('未绑定');
    env.cleanup();
  });

  it('story/map: 结构资产 + Scene/章节聚合(剧情地图)', async () => {
    const env = setup();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { serializeFrontmatter } = await import('@novelcraft/store');
    const write = (abs: string, fm: Record<string, unknown>) => {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, serializeFrontmatter(fm, ''), 'utf8');
    };
    write(path.join(env.root, 'chapters', '001.md'), { title: '第一章' });
    write(path.join(env.root, 'scenes', 's001.md'), { id: 's001', status: 'draft', chapter_ids: [1], title: '初遇' });
    write(path.join(env.root, 'structure', 'threads', '主线.md'), { id: '主线', status: 'canonical', name: '主角成长', thread_type: 'plot', start_chapter: 1 });
    write(path.join(env.root, 'structure', 'reveal', '身世.md'), { id: '身世', status: 'canonical', name: '身世揭示', target_type: 'thread', target_id: '主线' });
    write(path.join(env.root, 'world', 'objects', 'city.md'), { id: 'city', kind: 'location', status: 'canonical', name: '雾城' });
    writeFileSync(path.join(env.root, '.assistant', 'proposals', 'outline-p-ui.json'), JSON.stringify({
      kind: 'story_outline', run_id: 'p-ui', generated_at: '2026-09-01T00:00:00Z', input_hash: 'x',
      result: { title: '三幕预览', outline_markdown: '启幕 → 危机 → 结局', internal_secret: 'raw' },
      context_receipt: { source_manifest: [{ source_id: 'vault:scenes/s001.md' }], warnings: [] },
    }), 'utf8');

    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.storyMap({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书', root: env.root });
      expect(result.value.book).toBe('测试书');
      expect(result.value.chapters).toHaveLength(1);
      expect(result.value.scenes[0]).toMatchObject({ slug: 's001', title: '初遇' });
      expect(result.value.threads[0]).toMatchObject({ kind: 'thread', name: '主角成长', thread_type: 'plot' });
      expect(result.value.reveals[0]).toMatchObject({ kind: 'reveal', target_id: '主线' });
      expect(result.value.source_options).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: 'scenes/s001.md', kind: 'scene' }),
        expect.objectContaining({ ref: 'world/objects/city.md', label: expect.stringContaining('雾城') }),
      ]));
      expect(result.value.outline_previews[0]).toMatchObject({
        kind: 'story_outline', title: '三幕预览', summary: '启幕 → 危机 → 结局', source_count: 1, warning_count: 0,
      });
      expect(JSON.stringify(result.value.outline_previews)).not.toContain('internal_secret');
    }
    env.cleanup();
  });

  it('story/map: scenes 根 symlink 不把 Vault 外 Scene 或绝对路径投影到浏览器', async () => {
    const env = setup();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-client-scenes-outside-'));
    try {
      const { serializeFrontmatter } = await import('@novelcraft/store');
      writeFileSync(path.join(outside, 'external.md'), serializeFrontmatter({
        id: 'external', title: 'EXTERNAL-SCENE-MARKER', status: 'canonical', scene_index: 1,
      }, '不得投影'));
      rmSync(path.join(env.root, 'scenes'), { recursive: true, force: true });
      symlinkSync(outside, path.join(env.root, 'scenes'), 'dir');
      const result = await createNovelcraftHandlers(env.ctx).storyMap({ sessionId: 's1' });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('EXTERNAL-SCENE-MARKER');
      expect(JSON.stringify(result)).not.toContain(outside);
    } finally {
      env.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('world/workspace: 对象/世界书作者卡，草稿可发布且不暴露 raw JSON', async () => {
    const env = setup();
    const { serializeFrontmatter } = await import('@novelcraft/store');
    writeFileSync(path.join(env.root, 'world', 'objects', 'obj-secret.md'), serializeFrontmatter({
      id: 'obj-secret', name: '雾城', kind: 'location', status: 'canonical', tags: ['北境'], aliases: ['raw-alias'],
    }, '不应投影的对象正文'), 'utf8');
    writeFileSync(path.join(env.root, 'bible', 'mist.md'), serializeFrontmatter({
      id: 'mist', page_key: 'mist', title: '雾城志', page_type: 'location', status: 'draft', version_number: 0,
      provenance: { raw: 'internal' },
    }, '# 雾城志\n\n冬季只开北闸。'), 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.worldWorkspace({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书' });
      expect(result.value.objects[0]).toMatchObject({ name: '雾城', entity_type: 'location', status: 'canonical', tags: ['北境'] });
      expect(result.value.pages[0]).toMatchObject({
        title: '雾城志', status: 'draft', page_type: 'location', version_number: 0, can_publish: true,
      });
      expect(result.value.pages[0].summary).toContain('冬季只开北闸');
      expect(JSON.stringify(result.value)).not.toContain('raw-alias');
      expect(JSON.stringify(result.value)).not.toContain('internal');
      expect(result.value.pages[0]).not.toHaveProperty('slug');
    }
    const unbound = await h.worldWorkspace({ sessionId: 'unknown' });
    expect(unbound).toMatchObject({ ok: true, value: { bound: null, objects: [], pages: [] } });
    env.cleanup();
  });

  it('world/workspace: bible 根 symlink 不把 Vault 外页面投影到浏览器', async () => {
    const env = setup();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-client-bible-outside-'));
    try {
      const { serializeFrontmatter } = await import('@novelcraft/store');
      writeFileSync(path.join(outside, 'external.md'), serializeFrontmatter({
        id: 'external', page_key: 'external', title: 'EXTERNAL-BIBLE-MARKER',
        page_type: 'setting', status: 'canonical', version_number: 1,
      }, '不得投影'));
      rmSync(path.join(env.root, 'bible'), { recursive: true, force: true });
      symlinkSync(outside, path.join(env.root, 'bible'), 'dir');
      const result = await createNovelcraftHandlers(env.ctx).worldWorkspace({ sessionId: 's1' });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('EXTERNAL-BIBLE-MARKER');
    } finally {
      env.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writing/desk: 四模式数据(守望信号/计划结构/参照对象/评审摘要)', async () => {
    const env = setup();
    pushSignal(env.root, {
      radar: 'plot', severity: 'risk', title: '伏笔未回收', evidence: ['第1章'],
      proposed_action: '回收', reversibility: true,
    });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { serializeFrontmatter } = await import('@novelcraft/store');
    const write = (abs: string, fm: Record<string, unknown>) => {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, serializeFrontmatter(fm, ''), 'utf8');
    };
    write(path.join(env.root, 'chapters', '001.md'), { title: '第一章' });
    write(path.join(env.root, 'structure', 'threads', '主线.md'), { id: '主线', status: 'canonical', name: '主角成长', thread_type: 'plot' });
    write(path.join(env.root, 'world', 'objects', 'obj-a.md'), { id: 'obj-a', kind: 'character', name: '克莱恩', status: 'canonical' });
    mkdirSync(path.join(env.root, '.assistant', 'reviews'), { recursive: true });
    writeFileSync(path.join(env.root, '.assistant', 'reviews', 'semantic-review-001-r1.json'), JSON.stringify({
      review_id: 'r1', chapter_index: 1, verdict: '需修订', findings: [{ category: '设定', severity: 'high', quote: 'x', suggestion: 'y' }], reviewed_at: '2026-08-14T00:00:00Z',
    }), 'utf8');

    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.writingDesk({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound?.book).toBe('测试书');
      // 手工信号 + 健康扫描器落盘的结构 unassigned 信号(§20.6, 打开写作台即刷新)。
      expect(result.value.signals).toHaveLength(2);
      expect(result.value.signals.some((s) => s.radar === 'writing')).toBe(true);
      expect(result.value.threads).toHaveLength(1);
      expect(result.value.objects).toHaveLength(1);
      expect(result.value.reviews[0]).toMatchObject({ chapter_index: 1, finding_count: 1 });
      expect(result.value.proposals).toBeNull();
    }
    env.cleanup();
  });

  // ===========================================================================
  // chapter/dossier(章节档案 §17.5.1): store.chapterDossier 资产面 + .assistant 读面
  // (本章最新审查 / 本章 open 信号 / next_chapter==N 最新提案)合并; 逐层容错, 不炸通道。
  // ===========================================================================

  /** 写 fixture 的小工具: chapters/002 + 1 Scene + 人物/地点 + 审查 + 信号 + 提案。 */
  async function writeDossierFixture(root: string): Promise<{ signalCh2: { id: string } }> {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { serializeFrontmatter } = await import('@novelcraft/store');
    const write = (abs: string, fm: Record<string, unknown>, body = '') => {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, serializeFrontmatter(fm, body), 'utf8');
    };
    write(path.join(root, 'chapters', '001.md'), { chapter_index: 1, title: '第一章', status: 'draft' }, '一。');
    write(path.join(root, 'chapters', '002.md'), { chapter_index: 2, title: '第二章', status: 'draft' }, '二二二。');
    write(path.join(root, 'scenes', 's-a.md'), {
      id: 's-a', status: 'draft', scene_index: 0, title: '图书馆夜访', narrative_tag: 'setup',
      goal: '苏婉发现线索', core_conflict: '守卫逼近', must_happen: '拿到信件', must_not_happen: '被发现',
      chapter_ids: [2], pov_character_id: 'char-a',
      related_character_ids: ['char-a', 'char-b'], related_entity_ids: ['loc-1'],
    });
    write(path.join(root, 'world', 'objects', 'char-a.md'), { id: 'char-a', kind: 'character', name: '苏婉', status: 'canonical' });
    write(path.join(root, 'world', 'objects', 'char-b.md'), { id: 'char-b', kind: 'character', name: '林一', status: 'canonical' });
    write(path.join(root, 'world', 'objects', 'loc-1.md'), { id: 'loc-1', kind: 'location', name: '旧图书馆', status: 'canonical' });

    // 读面: 审查(r1 属第1章, r2a/r2b 属第2章, r2b 最新)
    mkdirSync(path.join(root, '.assistant', 'reviews'), { recursive: true });
    writeFileSync(path.join(root, '.assistant', 'reviews', 'semantic-review-001-r1.json'), JSON.stringify({
      review_id: 'r1', chapter_index: 1, verdict: '需修订', findings: [{}, {}], reviewed_at: '2026-08-14T00:00:00Z',
    }), 'utf8');
    writeFileSync(path.join(root, '.assistant', 'reviews', 'semantic-review-002-r2a.json'), JSON.stringify({
      review_id: 'r2a', chapter_index: 2, verdict: '通过', findings: [{}], reviewed_at: '2026-08-14T01:00:00Z',
    }), 'utf8');
    writeFileSync(path.join(root, '.assistant', 'reviews', 'semantic-review-002-r2b.json'), JSON.stringify({
      review_id: 'r2b', chapter_index: 2, verdict: '需修订', findings: [{}, {}, {}], reviewed_at: '2026-08-14T02:00:00Z',
    }), 'utf8');

    // 信号: 1 条 target 第2章(应出现); 1 条 target 第1章 + 1 条无 target(应排除)
    const signalCh2 = pushSignal(root, {
      radar: 'plot', severity: 'risk', title: '第2章伏笔未回收', evidence: ['第2章'],
      proposed_action: '回收', reversibility: true, target: { chapter_index: 2 },
    });
    pushSignal(root, {
      radar: 'writing', severity: 'note', title: '第1章节奏偏慢', evidence: ['第1章'],
      proposed_action: '删冗余段', reversibility: true, target: { chapter_index: 1 },
    });
    pushSignal(root, {
      radar: 'dedup', severity: 'hint', title: '无目标信号', evidence: ['第3章'],
      proposed_action: '检查', reversibility: true,
    });

    // 提案: 两条 next_chapter==2(文件名序取最后 → p2-new), 一条 next_chapter==3(应排除)
    mkdirSync(path.join(root, '.assistant', 'proposals'), { recursive: true });
    writeFileSync(path.join(root, '.assistant', 'proposals', 'next-001-p1.json'), JSON.stringify({
      run_id: 'p1-old', chapter_index: 1, next_chapter: 2, generated_at: '2026-08-14T00:00:00Z',
      proposals: [{ title: '旧方向', premise: '旧', basis: ['b'], cost: '低', risk: '高' }],
    }), 'utf8');
    writeFileSync(path.join(root, '.assistant', 'proposals', 'next-001-p2.json'), JSON.stringify({
      run_id: 'p2-new', chapter_index: 1, next_chapter: 2, generated_at: '2026-08-14T01:00:00Z',
      proposals: [{ title: '新方向', premise: '新', basis: ['b2'], cost: '中', risk: '低' }],
    }), 'utf8');
    writeFileSync(path.join(root, '.assistant', 'proposals', 'next-002-p3.json'), JSON.stringify({
      run_id: 'p3-other', chapter_index: 2, next_chapter: 3, generated_at: '2026-08-14T02:00:00Z',
      proposals: [{ title: '第三章方向', premise: '…' }],
    }), 'utf8');

    return { signalCh2 };
  }

  it('chapter/dossier: 未绑定 → 缺省档案(review/signals/proposal 全空, 不炸通道)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.chapterDossier({ sessionId: 'unknown', chapterIndex: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toBeNull();
      expect(result.value.dossier).toEqual({
        chapter: null, scenes: [], characters: [], pov: [],
        foreshadowing: { planted: [], activeThrough: [], duePayoff: [] },
        reveals: [], referencedObjects: [],
        rhythm: { wordCount: 0, sceneCount: 0, avgSceneLength: 0 },
      });
      expect(result.value.review).toBeNull();
      expect(result.value.signals).toEqual([]);
      expect(result.value.proposal).toBeNull();
    }
    env.cleanup();
  });

  it('chapter/dossier: 正常章组装(资产面 + 审查/信号/提案按章过滤合并)', async () => {
    const env = setup();
    const { signalCh2 } = await writeDossierFixture(env.root);
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.chapterDossier({ sessionId: 's1', chapterIndex: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toEqual({ book: '测试书', root: env.root });
      // 资产面: 章元 + Scene 分解 + 人物/POV + 节奏
      expect(result.value.dossier.chapter).toMatchObject({ index: 2, title: '第二章', status: 'draft' });
      expect(result.value.dossier.scenes[0]).toMatchObject({
        slug: 's-a', title: '图书馆夜访', narrative_tag: 'setup',
        goal: '苏婉发现线索', core_conflict: '守卫逼近',
        must_happen: '拿到信件', must_not_happen: '被发现',
      });
      expect(result.value.dossier.characters).toEqual([
        { slug: 'char-a', name: '苏婉' },
        { slug: 'char-b', name: '林一' },
      ]);
      expect(result.value.dossier.pov).toEqual([{ scene: 's-a', character: '苏婉' }]);
      expect(result.value.dossier.referencedObjects).toEqual([{ slug: 'loc-1', name: '旧图书馆', kind: 'location' }]);
      expect(result.value.dossier.rhythm.sceneCount).toBe(1);
      // 读面: 审查取本章最新(r2b, 不取第1章的 r1 / 更旧的 r2a)
      expect(result.value.review).toMatchObject({ review_id: 'r2b', verdict: '需修订', finding_count: 3 });
      // 读面: 信号只含 target.chapter_index==2 的 open 信号
      expect(result.value.signals).toHaveLength(1);
      expect(result.value.signals[0]).toMatchObject({ id: signalCh2.id, title: '第2章伏笔未回收' });
      // 读面: 提案取 next_chapter==2 的最新一条(p2-new, 排除 next_chapter==3)
      expect(result.value.proposal).toMatchObject({ run_id: 'p2-new', next_chapter: 2 });
      expect(result.value.proposal!.proposals[0]).toMatchObject({ title: '新方向', premise: '新' });
    }
    env.cleanup();
  });

  it('chapter/dossier: 未导入章(文件不存在)→ chapter=null 兜底, 其余尽力组装不炸', async () => {
    const env = setup();
    await writeDossierFixture(env.root);
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.chapterDossier({ sessionId: 's1', chapterIndex: 9 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dossier.chapter).toBeNull();
      expect(result.value.dossier.scenes).toEqual([]);
      expect(result.value.dossier.rhythm).toEqual({ wordCount: 0, sceneCount: 0, avgSceneLength: 0 });
      expect(result.value.review).toBeNull();
      expect(result.value.signals).toEqual([]);
      expect(result.value.proposal).toBeNull();
    }
    env.cleanup();
  });

  it('chapter/dossier: 坏数据不炸(非有限 chapterIndex → 缺省兜底)', async () => {
    const env = setup();
    await writeDossierFixture(env.root);
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.chapterDossier({ sessionId: 's1', chapterIndex: Number.NaN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dossier.chapter).toBeNull();
      expect(result.value.dossier.scenes).toEqual([]);
      expect(result.value.signals).toEqual([]);
      expect(result.value.proposal).toBeNull();
    }
    env.cleanup();
  });

  // ===========================================================================
  // presets/list + presets/select(模型预设 N20/D13): 注册表 ∪ 种子; active 反映
  // llm.yml 的 preset 键; 写边界 N19 —— 只经 selectPresetInLlmYml 动 preset 单键
  // (配置非资产, 不过 approval); 预设不存在 → 拒绝不写文件。
  // ===========================================================================

  it('presets/list: 未绑定 → 缺省(种子卡 source=seed, active null, 不炸)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsList({ sessionId: 'unknown' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound).toBeNull();
      expect(result.value.active).toBeNull();
      expect(result.value.defaultRoute).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
      expect(result.value.availableProviders).toEqual([]);
      expect(result.value.reasoning).toBeNull();
      // 最小 profile(宿主无 presets 面)→ 种子兜底, 全部 source=seed
      const names = result.value.presets.map((p) => p.name);
      expect(names).toContain('default');
      expect(names).toContain('writing-day');
      expect(names).toContain('polish');
      expect(result.value.presets.every((p) => p.source === 'seed')).toBe(true);
    }
    env.cleanup();
  });

  it('presets/list: 绑定后 active 反映 llm.yml; defaultRoute/availableProviders 来自宿主; 存储卡 source=stored', async () => {
    const { DEFAULT_CONTENT_PRESETS } = await import('@novelcraft/llm-step');
    const env = setup({
      service: {
        config: { llm: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
        presets: {
          list: async () => [
            ...DEFAULT_CONTENT_PRESETS,
            { name: 'my-card', label: '我的卡', provider: 'fake', model: 'fake-x', temperature: 0.33 },
          ],
        },
      },
      llm: { listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'fake', name: 'Fake' },
      ] },
    });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'preset: writing-day\nmodel: old-model\n', 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsList({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bound?.book).toBe('测试书');
      expect(result.value.active).toBe('writing-day'); // llm.yml preset 键反映
      expect(result.value.defaultRoute).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
      expect(result.value.availableProviders).toEqual(['deepseek', 'fake']);
      expect(result.value.reasoning).toMatchObject({
        status: 'ready',
        provider: 'deepseek',
        model: 'old-model',
        selected: null,
        adapter_default: 'high',
        options: [
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
      });
      const myCard = result.value.presets.find((p) => p.name === 'my-card');
      expect(myCard).toMatchObject({
        label: '我的卡', provider: 'fake', model: 'fake-x', temperature: 0.33, source: 'stored',
      });
      expect(result.value.presets.find((p) => p.name === 'writing-day')?.source).toBe('seed');
    }
    env.cleanup();
  });

  it('presets/list: provider 枚举异常时 availableProviders 降级为空数组', async () => {
    const env = setup({
      llm: { listProviders: () => { throw new Error('provider registry unavailable'); } },
    });
    const result = await createNovelcraftHandlers(env.ctx).presetsList({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.availableProviders).toEqual([]);
    env.cleanup();
  });

  it('presets/list: reasoning 查询异常不向浏览器泄露宿主内部消息(RV-03)', async () => {
    const base = makeHostUi();
    const env = setup({ service: { ui: {
      ...base,
      config: {
        ...base.config,
        reasoningOptions: async () => { throw new Error('adapter secret internal detail'); },
      },
    } } });
    const result = await createNovelcraftHandlers(env.ctx).presetsList({ sessionId: 's1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reasoning?.status).toBe('unavailable');
      expect(result.value.reasoning?.message).toBe('思考等级暂时无法读取，请稍后刷新。');
      expect(JSON.stringify(result.value)).not.toContain('adapter secret internal detail');
    }
    env.cleanup();
  });

  it('presets/select: 写入只动 preset 键(先写 model 键再 select, model 原样保留)', async () => {
    const env = setup();
    const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'model: gpt-x\n', 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsSelect({ sessionId: 's1', preset: 'writing-day' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(true);
      expect(result.value.active).toBe('writing-day');
      expect(result.value.message).toContain('内容手已应用预设');
      expect(result.value.message).toContain('写作日');
      expect(result.value.message).toContain('书级直接配置');
    }
    const content = readFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'utf8');
    expect(content).toContain('model: gpt-x'); // N19: 其余键原样保留
    expect(content).toContain('preset: writing-day');
    env.cleanup();
  });

  it('presets/select: 未知预设拒绝且不写文件', async () => {
    const env = setup();
    const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'model: gpt-x\n', 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsSelect({ sessionId: 's1', preset: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('预设不存在');
    }
    const content = readFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'utf8');
    expect(content).not.toContain('preset:');
    expect(content).toContain('model: gpt-x');
    env.cleanup();
  });

  it('presets/select: 卡片 effort 不在宿主 live 列表时零写入', async () => {
    const env = setup({
      service: {
        presets: { list: async () => [
          { name: 'bad-effort', provider: 'deepseek', model: 'm', reasoning_effort: 'low' },
        ] },
      },
    });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    const file = path.join(env.root, '.assistant', 'llm.yml');
    writeFileSync(file, 'model: stable\n', 'utf8');
    const before = readFileSync(file, 'utf8');
    const result = await createNovelcraftHandlers(env.ctx).presetsSelect({ sessionId: 's1', preset: 'bad-effort' });
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    env.cleanup();
  });

  it('presets/effort-select: 只接受宿主 live effort，未知值零写入', async () => {
    const env = setup();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    const file = path.join(env.root, '.assistant', 'llm.yml');
    writeFileSync(file, 'model: stable\n', 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const before = readFileSync(file, 'utf8');
    expect((await h.presetsEffortSelect({ sessionId: 's1', effort: 'low' })).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const selected = await h.presetsEffortSelect({ sessionId: 's1', effort: 'max' });
    expect(selected.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('model: stable\nreasoning_effort: max\n');
    const cleared = await h.presetsEffortSelect({ sessionId: 's1', effort: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.message).toContain('清除书级');
    expect(readFileSync(file, 'utf8')).toBe('model: stable\n');
    env.cleanup();
  });

  it('presets/select: null 清除回退(移除 preset 键, 其余键保留)', async () => {
    const env = setup();
    const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.root, '.assistant'), { recursive: true });
    writeFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'preset: writing-day\nmodel: gpt-x\n', 'utf8');
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsSelect({ sessionId: 's1', preset: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(true);
      expect(result.value.active).toBeNull();
      expect(result.value.message).toContain('默认');
    }
    const content = readFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'utf8');
    expect(content).not.toContain('preset:');
    expect(content).toContain('model: gpt-x');
    env.cleanup();
  });

  it('presets/select: 未绑定 → 作者语言错误(不写文件)', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    const result = await h.presetsSelect({ preset: 'writing-day' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('未绑定');
    env.cleanup();
  });

  it('presets: 服务缺省(无 presets 面)不炸 —— list 种子兜底, select 种子名照常写', async () => {
    const env = setup(); // 基础 service 无 presets 面
    const h = createNovelcraftHandlers(env.ctx);
    const list = await h.presetsList({ sessionId: 's1' });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.bound?.book).toBe('测试书');
      expect(list.value.presets.some((p) => p.name === 'writing-day' && p.source === 'seed')).toBe(true);
      expect(list.value.active).toBeNull();
    }
    // 存在性按种子兜底 → select 照常经 selectPresetInLlmYml 写 llm.yml
    const sel = await h.presetsSelect({ sessionId: 's1', preset: 'polish' });
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.value.active).toBe('polish');
      expect(sel.value.message).toContain('精修校对');
    }
    env.cleanup();
  });
});

describe('atlas 端点(Phase 6)', () => {
  it('atlas/view: 未绑定 → 空态; 绑定后读树 + run + 队列状态', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    let r = await h.atlasView({ sessionId: 'unknown' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bound).toBeNull();
      expect(r.value.adopted.nodes.length).toBe(0);
    }
    // 候选 + adopted 树投影
    writeAtlasNode(env.root, {
      id: 'n1', parent_ref: null, location_ref: null, semantic_key: 'entity:n1',
      level: 'world', title: '临水城', status: 'provisional', sort_order: 0,
    });
    writeAtlasPage(env.root, {
      id: 'pg1', run_ref: 'run-t', node_ref: 'n1', generation_status: 'prompt_only',
      review_status: 'candidate', title: '临水城', visual_brief: 'v', prompt: 'p',
      evidence: { supported: [], visual_fill: [], conflicts: [] },
      source_manifest: [], annotations: [], review_note: null,
      adopted_at: null, rejected_at: null, deprecated_at: null, content_hash: 'h-pg1',
    });
    r = await h.atlasView({ sessionId: 's1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bound?.book).toBe('测试书');
      expect(r.value.pending.nodes[0]?.title).toBe('临水城');
      expect(r.value.pending.pages[0]?.generation_status).toBe('prompt_only');
      expect(r.value.pending.pages[0]?.image_missing).toBe(false);
    }
    env.cleanup();
  });

  it('atlas/annotation-request: 只落队列 + 信号, 不写 page 资产(铁律 3); 坐标越界拒', async () => {
    const env = setup();
    const h = createNovelcraftHandlers(env.ctx);
    writeAtlasPage(env.root, {
      id: 'pg1', run_ref: 'run-t', node_ref: 'n1', generation_status: 'prompt_only',
      review_status: 'candidate', title: '临水城', visual_brief: 'v', prompt: 'p',
      evidence: { supported: [], visual_fill: [], conflicts: [] },
      source_manifest: [], annotations: [], review_note: null,
      adopted_at: null, rejected_at: null, deprecated_at: null, content_hash: 'h-pg1',
    });
    // 越界坐标拒
    let r = await h.atlasAnnotationRequest({
      sessionId: 's1', page_ref: 'pg1', base_content_hash: 'h-pg1',
      ops: [{ op: 'add', label: 'x', position_x: 1.5, position_y: 0 }],
    });
    expect(r.ok).toBe(false);
    // 合法: 队列文件落盘 + page 文件未变(无 git 提交由本端点产生)
    const { execFileSync } = await import('node:child_process');
    const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
    r = await h.atlasAnnotationRequest({
      sessionId: 's1', page_ref: 'pg1', base_content_hash: 'h-pg1',
      ops: [{ op: 'add', id: 'ann-9', label: '洛阳', position_x: 0.2, position_y: 0.8 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.queued).toBe(1);
      const { existsSync, readFileSync } = await import('node:fs');
      expect(existsSync(r.value.file)).toBe(true);
      const payload = JSON.parse(readFileSync(r.value.file, 'utf8'));
      expect(payload.base_content_hash).toBe('h-pg1');
      expect(payload.ops[0].position_x).toBe(0.2);
    }
    const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
    expect(after).toBe(before); // 队列不 git commit(记录面, 非资产)
    // page 资产未被改(annotations 仍空)
    const tree = (await import('@novelcraft/world')).readAtlasTree(env.root);
    expect(tree.pendingPages[0]?.annotations.length).toBe(0);
    env.cleanup();
  });
});

// ===========================================================================
// apply/connection 真实分发: 走 src/index.ts 的 apply 注册的通道 handler
// (ENDPOINTS 常量 → switch 分发 → 处理器), 而非直调 createNovelcraftHandlers。
// 覆盖 ENDPOINTS.atlasView / atlasAnnotationRequest; 非法 page_ref/runId/signalId/
// action/NaN 坐标拒绝且无越界文件(文件真相 + R9/N19 写边界)。
// ===========================================================================

interface CapturedChannel {
  channel?: string;
  handler?: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{
    ok: boolean;
    value?: unknown;
    error?: { code: string; message: string; details?: unknown };
  }>;
}

type SetupOptions = {
  service?: Partial<NovelcraftHostService>;
  llm?: { listProviders?: () => Array<{ id: string; name?: string }> };
};

/** setup() + 注册假 connection + 跑宿主 apply; 返回可经通道分发的 handler。 */
function setupDispatchApp(overrides: SetupOptions = {}) {
  const env = setup(overrides);
  const captured: CapturedChannel = {};
  env.ctx.provide('connection', {
    rpc: {
      handle: (channel: string, handler: unknown) => {
        captured.channel = channel;
        captured.handler = handler as CapturedChannel['handler'];
        return async () => undefined;
      },
    },
  });
  applyHostPlugin(env.ctx);
  const dispatch = async (endpoint: string, payload: unknown) => {
    if (!captured.handler) throw new Error('apply 未注册 connection handler');
    return captured.handler(endpoint, payload, new AbortController().signal);
  };
  return { ...env, captured, dispatch };
}

/** 拒绝后无越界文件: vault 根(含子目录, 跨目录拼写)下不存在任何同名文件。 */
async function expectNoFileNamed(root: string, name: string): Promise<void> {
  const { existsSync, readdirSync } = await import('node:fs');
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const found: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) found.push(...walk(p));
      else if (ent.name === name) found.push(p);
    }
    return found;
  };
  expect(walk(root)).toEqual([]);
}

describe('apply/connection 通道分发(真实 handler 走线)', () => {
  it('注册到认证 Connection 通道(RPC_CHANNEL); 未知端点 → 作者语言错误', async () => {
    const env = setupDispatchApp();
    expect(env.captured.channel).toBe(RPC_CHANNEL);
    // N50: DSH 在进入 handler 前完成 Host/Origin 围栏与浏览器会话认证;
    // 本通道自身只读信号/记录决定, 不写 canonical 资产。
    const res = await env.dispatch('atlas/nope', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.message).toContain('unknown endpoint');
    env.cleanup();
  });

  it('ENDPOINTS.presetsEffortSelect 经通道分发到宿主写前校验', async () => {
    const env = setupDispatchApp();
    const rejected = await env.dispatch(ENDPOINTS.presetsEffortSelect, { sessionId: 's1', effort: 'low' });
    expect(rejected.ok).toBe(false);
    const accepted = await env.dispatch(ENDPOINTS.presetsEffortSelect, { sessionId: 's1', effort: 'max' });
    expect(accepted.ok).toBe(true);
    expect(readFileSync(path.join(env.root, '.assistant', 'llm.yml'), 'utf8')).toContain('reasoning_effort: max');
    env.cleanup();
  });

  it('ENDPOINTS.atlasView 经通道分发: 未绑定空态 / 绑定树投影', async () => {
    const env = setupDispatchApp();
    let res = await env.dispatch(ENDPOINTS.atlasView, { sessionId: 'unknown' });
    expect(res.ok).toBe(true);
    const empty = res.value as { bound: { book: string } | null; adopted: { nodes: unknown[] } };
    expect(empty.bound).toBeNull();
    expect(empty.adopted.nodes).toHaveLength(0);

    writeAtlasNode(env.root, {
      id: 'n1', parent_ref: null, location_ref: null, semantic_key: 'entity:n1',
      level: 'world', title: '临水城', status: 'provisional', sort_order: 0,
    });
    writeAtlasPage(env.root, {
      id: 'pg1', run_ref: 'run-t', node_ref: 'n1', generation_status: 'prompt_only',
      review_status: 'candidate', title: '临水城', visual_brief: 'v', prompt: 'p',
      evidence: { supported: [], visual_fill: [], conflicts: [] },
      source_manifest: [], annotations: [], review_note: null,
      adopted_at: null, rejected_at: null, deprecated_at: null, content_hash: 'h-pg1',
    });
    res = await env.dispatch(ENDPOINTS.atlasView, { sessionId: 's1' });
    expect(res.ok).toBe(true);
    const bound = res.value as { bound: { book: string } | null; pending: { nodes: Array<{ title: string }> } };
    expect(bound.bound?.book).toBe('测试书');
    expect(bound.pending.nodes[0]?.title).toBe('临水城');
    env.cleanup();
  });

  it('ENDPOINTS.chapterWorkspace/stageEdit: Git 版本读面 + 会话收据, Connection RPC 零章节写入', async () => {
    const env = setupDispatchApp();
    const { ingestChapter } = await import('@novelcraft/writing');
    const { gitAdd, gitCommit, readCurrentChapter } = await import('@novelcraft/store');
    const { execFileSync } = await import('node:child_process');
    ingestChapter(env.root, { chapterIndex: 1, text: '初稿', source: 'test', title: '第一章' });
    gitAdd(env.root, ['chapters/001.md']);
    const first = gitCommit(env.root, 'chapter v1');
    ingestChapter(env.root, { chapterIndex: 1, text: '第二稿', source: 'test', title: '第一章' });
    gitAdd(env.root, ['chapters/001.md']);
    gitCommit(env.root, 'chapter v2');

    const unknown = await env.dispatch(ENDPOINTS.chapterWorkspace, { sessionId: 'unknown', chapterIndex: 1 });
    expect(unknown.ok && (unknown.value as { bound: unknown }).bound).toBeNull();
    const view = await env.dispatch(ENDPOINTS.chapterWorkspace, {
      sessionId: 's1', chapterIndex: 1, diffFromCommit: first,
    });
    expect(view.ok).toBe(true);
    const value = view.value as {
      chapter: { body: string; content_hash: string };
      history: Array<{ commit: string }>;
      diff: { patch: string };
    };
    expect(value.chapter.body).toBe('第二稿\n');
    expect(value.history).toHaveLength(2);
    expect(value.diff.patch).toContain('-初稿');
    expect(value.diff.patch).toContain('+第二稿');

    const chapterBefore = readFileSync(path.join(env.root, 'chapters', '001.md'), 'utf8');
    const commitCountBefore = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
    const staged = await env.dispatch(ENDPOINTS.chapterStageEdit, {
      sessionId: 's1', chapterIndex: 1, expected_content_hash: value.chapter.content_hash,
      title: '第一章', text: '第三稿（尚未审批）',
    });
    expect(staged.ok).toBe(true);
    const stagedValue = staged.value as { receipt_id: string };
    expect(stagedValue.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path.join(env.root, 'chapters', '001.md'), 'utf8')).toBe(chapterBefore);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim()).toBe(commitCountBefore);
    expect(listSignals(env.root).some((signal) => signal.proposed_action.includes(stagedValue.receipt_id))).toBe(true);
    expect((await env.dispatch(ENDPOINTS.chapterStageEdit, {
      sessionId: 'unknown', chapterIndex: 1, expected_content_hash: value.chapter.content_hash, text: 'x',
    })).ok).toBe(false);
    expect(readCurrentChapter(env.root, 1).body).toBe('第二稿\n');
    env.cleanup();
  });

  it('ENDPOINTS.chapterWorkspace: 下一章 active pending 可从章节列表进入', async () => {
    const env = setupDispatchApp();
    const { contentHash, gitAdd, gitCommit } = await import('@novelcraft/store');
    const { ingestChapter } = await import('@novelcraft/writing');
    ingestChapter(env.root, { chapterIndex: 1, text: '当前章', source: 'test', title: '第一章' });
    gitAdd(env.root, ['chapters/001.md']);
    gitCommit(env.root, 'chapter baseline');
    const body = '候选下一章\n';
    // 与 generateNextChapter 落盘格式一致: frontmatter 以 '---\n' 结束后直接拼 body,
    // 否则 parseFrontmatter 剥离后 body 会多前导空行/丢尾换行, content_hash 校验失败。
    writeFileSync(path.join(env.root, 'chapters', 'pending', '002.md'), [
      '---',
      'chapter_index: 2',
      'status: candidate',
      `content_hash: ${contentHash(body)}`,
      'source: writing_generate',
      '---',
      '',
    ].join('\n') + body);
    gitAdd(env.root, ['chapters/pending/002.md']);
    gitCommit(env.root, 'generate candidate ch2');

    const listed = await env.dispatch(ENDPOINTS.chapterWorkspace, { sessionId: 's1', chapterIndex: 0 });
    expect(listed.ok && (listed.value as ChapterWorkspaceValue).chapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    const pending = await env.dispatch(ENDPOINTS.chapterWorkspace, { sessionId: 's1', chapterIndex: 2 });
    expect(pending.ok).toBe(true);
    expect((pending.value as ChapterWorkspaceValue).chapter).toBeNull();
    expect((pending.value as ChapterWorkspaceValue).candidate?.body).toBe(body);
    env.cleanup();
  });

  it('ENDPOINTS.atlasAnnotationRequest 经通道分发: 合法 op 落队列 + 信号, 不写 page 资产', async () => {
    const env = setupDispatchApp();
    writeAtlasPage(env.root, {
      id: 'pg1', run_ref: 'run-t', node_ref: 'n1', generation_status: 'prompt_only',
      review_status: 'candidate', title: '临水城', visual_brief: 'v', prompt: 'p',
      evidence: { supported: [], visual_fill: [], conflicts: [] },
      source_manifest: [], annotations: [], review_note: null,
      adopted_at: null, rejected_at: null, deprecated_at: null, content_hash: 'h-pg1',
    });
    const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
      sessionId: 's1', page_ref: 'pg1', base_content_hash: 'h-pg1',
      ops: [{ op: 'add', id: 'ann-9', label: '洛阳', position_x: 0.2, position_y: 0.8 }],
    });
    expect(res.ok).toBe(true);
    const value = res.value as { queued: number; file: string };
    expect(value.queued).toBe(1);
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(value.file)).toBe(true);
    const payload = JSON.parse(readFileSync(value.file, 'utf8'));
    expect(payload.ops[0].label).toBe('洛阳');
    // page 资产未被改(annotations 仍空; 队列是记录面, 非资产)。
    expect(readAtlasTree(env.root).pendingPages[0]?.annotations.length).toBe(0);
    env.cleanup();
  });

  it('非法 page_ref 拒绝且无越界文件(跨目录拼写不落盘)', async () => {
    const env = setupDispatchApp();
    for (const pageRef of ['../evil', '..', 'a/b', '']) {
      const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
        sessionId: 's1', page_ref: pageRef, base_content_hash: 'h',
        ops: [{ op: 'add', label: 'x', position_x: 0.5, position_y: 0.5 }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error?.message).toContain('page_ref');
      await expectNoFileNamed(env.root, 'evil.json');
    }
    // 拒绝不是端点全拒: 合法 page_ref 照常入队。
    const ok = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
      sessionId: 's1', page_ref: 'pg-ok', base_content_hash: 'h',
      ops: [{ op: 'add', label: 'x', position_x: 0.5, position_y: 0.5 }],
    });
    expect(ok.ok).toBe(true);
    env.cleanup();
  });

  it('队列目标被预置为内部 symlink(指向 signals 文件)时拒绝: 哨兵不变, ok:false, 无队列 payload', async () => {
    const env = setupDispatchApp();
    const { symlinkSync, readFileSync, readdirSync, lstatSync, writeFileSync } = await import('node:fs');
    // 哨兵: signals 内既有文件(R9 读面会显示它; 写面若跟随内部链接就会改写它)。
    const sentinel = path.join(env.root, '.assistant', 'signals', 'sig-sentinel.json');
    const sentinelBody = JSON.stringify({ id: 'sig-sentinel', status: 'open', title: '哨兵' });
    writeFileSync(sentinel, sentinelBody, 'utf8');
    // 预置内部 symlink: annotation-queue/<page>.json → ../../signals/sig-sentinel.json。
    // guardPath 的 real containment 会放行(指向 vault 内), assertNoSymlinkOnPath 必须拒绝。
    const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
    symlinkSync(path.join('..', '..', 'signals', 'sig-sentinel.json'), path.join(queueDir, 'sig-sentinel.json'));
    const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
      sessionId: 's1', page_ref: 'sig-sentinel', base_content_hash: 'h',
      ops: [{ op: 'add', label: 'x', position_x: 0.5, position_y: 0.5 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.message).toContain('symlink');
    // 哨兵未被跟随改写(链接未被 writeFileSync 穿透)。
    expect(readFileSync(sentinel, 'utf8')).toBe(sentinelBody);
    // 队列目录无真实 payload: 链接原样保留(仍是 symlink), 无任何普通 .json 队列文件。
    const entries = readdirSync(queueDir, { withFileTypes: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(queueDir, 'sig-sentinel.json')).isSymbolicLink()).toBe(true);
    env.cleanup();
  });

  it('队列目标为悬空 / 指向 vault 外 symlink 时同样拒绝, 不写任何队列 payload', async () => {
    const env = setupDispatchApp();
    const { symlinkSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
    // 外部受害者文件(独立临时目录, 在 vault 外): 链接若被跟随, 内容将被改写。
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nc-client-outside-'));
    try {
      const victim = path.join(outside, 'victim.txt');
      writeFileSync(victim, 'victim', 'utf8');
      const queueDir = path.join(env.root, '.assistant', 'atlas', 'annotation-queue');
      symlinkSync('no-such-target.json', path.join(queueDir, 'dangling.json')); // 悬空链接
      symlinkSync(victim, path.join(queueDir, 'outside.json')); // 指向 vault 外
      for (const pageRef of ['dangling', 'outside']) {
        const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
          sessionId: 's1', page_ref: pageRef, base_content_hash: 'h',
          ops: [{ op: 'add', label: 'x', position_x: 0.5, position_y: 0.5 }],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error?.message.length).toBeGreaterThan(0);
      }
      // 两个链接原样保留; 目录内无任何普通 .json 队列文件; 外部目标未被写。
      const entries = readdirSync(queueDir, { withFileTypes: true });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.isSymbolicLink())).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe('victim');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    env.cleanup();
  });

  it('非法 runId 拒绝(atlasView 只读端点); 非法 signalId/action 拒绝且不动信号文件', async () => {
    const env = setupDispatchApp();
    for (const runId of ['..', 'a/b', 'x'.repeat(129)]) {
      const res = await env.dispatch(ENDPOINTS.atlasView, { sessionId: 's1', runId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error?.message).toContain('runId');
    }
    const sig = pushSignal(env.root, {
      radar: 'dedup', severity: 'risk', title: '重复', evidence: ['第1章'],
      proposed_action: '合并', reversibility: true,
    });
    const badRef = await env.dispatch(ENDPOINTS.inboxAct, {
      sessionId: 's1', signalId: '../sig', action: 'accept',
    });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.error?.message).toContain('signalId');
    const badAction = await env.dispatch(ENDPOINTS.inboxAct, {
      sessionId: 's1', signalId: sig.id, action: 'nope',
    });
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) expect(badAction.error?.message).toContain('action');
    // 信号仍 open(记录面未被写坏/越界)。
    const { readFileSync } = await import('node:fs');
    const stored = JSON.parse(readFileSync(path.join(env.root, '.assistant', 'signals', `${sig.id}.json`), 'utf8'));
    expect(stored.status).toBe('open');
    await expectNoFileNamed(env.root, 'sig.json');
    env.cleanup();
  });

  it('非法 op / NaN·Infinity·字符串·越界坐标拒绝, 中途绝无队列文件写坏', async () => {
    const env = setupDispatchApp();
    const badOps: Array<Record<string, unknown>> = [
      { op: 'bogus', label: 'x', position_x: 0.5, position_y: 0.5 },
      { op: 'add', label: 'x', position_x: Number.NaN, position_y: 0.5 },
      { op: 'add', label: 'x', position_x: 0.5, position_y: Infinity },
      { op: 'add', label: 'x', position_x: '0.5', position_y: 0.5 },
      { op: 'add', label: 'x', position_x: 1.5, position_y: 0 },
      { op: 'add', label: 'x', position_x: -0.1, position_y: 0 },
    ];
    for (const op of badOps) {
      const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
        sessionId: 's1', page_ref: 'pg1', base_content_hash: 'h', ops: [op],
      });
      expect(res.ok).toBe(false);
    }
    // 空数组 / 非数组 / 含 null 条目也拒(形状校验)。
    for (const ops of [[], 'nope', null, [null]]) {
      const res = await env.dispatch(ENDPOINTS.atlasAnnotationRequest, {
        sessionId: 's1', page_ref: 'pg1', base_content_hash: 'h', ops,
      } as never);
      expect(res.ok).toBe(false);
    }
    await expectNoFileNamed(env.root, 'pg1.json');
    env.cleanup();
  });

  it('inbox/act modify 经通道分发: 修改文本(modified* wire 字段)落进信号记录', async () => {
    const env = setupDispatchApp();
    const sig = pushSignal(env.root, {
      radar: 'writing', severity: 'note', title: '节奏偏慢', evidence: ['第1章'],
      proposed_action: '删冗余段', reversibility: true,
    });
    const res = await env.dispatch(ENDPOINTS.inboxAct, {
      sessionId: 's1', signalId: sig.id, action: 'modify',
      reason: '改为建议修词',
      modifiedTitle: '节奏偏慢, 建议合并段落',
      modifiedProposedAction: '合并 2–3 段并精简描写',
    });
    expect(res.ok).toBe(true);
    const { readFileSync } = await import('node:fs');
    const stored = JSON.parse(readFileSync(path.join(env.root, '.assistant', 'signals', `${sig.id}.json`), 'utf8'));
    // 修改文本真实发到 wire 并落盘: title/proposed_action 按修改覆盖。
    expect(stored.title).toBe('节奏偏慢, 建议合并段落');
    expect(stored.proposed_action).toBe('合并 2–3 段并精简描写');
    expect(stored.status).toBe('accepted');
    env.cleanup();
  });
});
