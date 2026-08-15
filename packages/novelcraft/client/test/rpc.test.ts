// @novelcraft/client 宿主半身 RPC 处理器行为契约。
// 断言引设计文档 §9/§17 + wire 契约: watch/state 四态数据、inbox/list 卡片
// (作者语言)、inbox/act 四动词回 assistant.act(adopt 指引给助手, UI 不写资产);
// 未绑定 → capability 缺省, 不炸通道。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { pushSignal } from '@novelcraft/assistant';
import { writeAtlasNode, writeAtlasPage } from '@novelcraft/world';
import { initVault } from '@novelcraft/vault';
import { describe, expect, it } from 'vitest';
import { createNovelcraftHandlers, type NovelcraftHostService } from '../src/index.js';

interface TestEnv {
  ctx: Context;
  root: string;
  cleanup: () => void;
}

function setup(overrides: {
  service?: Partial<NovelcraftHostService>;
  llm?: { listProviders?: () => string[] };
} = {}): TestEnv {
  const ctx = new Context();
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-client-'));
  initVault(root, { title: '测试书' });
  const service: NovelcraftHostService = {
    vaults: {
      resolve: async (sessionId) => (sessionId === 's1' ? { book: '测试书', root } : undefined),
      resolveFromPath: (p) => (p.startsWith(root) ? { book: '测试书', root } : undefined),
    },
    ...overrides.service,
  };
  ctx.provide('novelcraft', service);
  ctx.provide('jobs', {
    list: () => [{ kind: 'novelcraft-radar', status: 'running' }],
  });
  if (overrides.llm) ctx.provide('llm', overrides.llm);
  return { ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('novelcraft RPC 处理器', () => {
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

  it('watch/state: workspacePath 回退解析(无 sessionId)', async () => {
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
      expect(result.value.bound?.book).toBe('测试书');
      expect(result.value.open).toBe(1);
      expect(result.value.attention).toBe(false); // 1 < 5 → 微光, 不触发待确认
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
    }
    env.cleanup();
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
      expect(result.value.defaultRoute).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
      expect(result.value.availableProviders).toEqual([]);
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
      llm: { listProviders: () => ['deepseek', 'fake'] },
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
      const myCard = result.value.presets.find((p) => p.name === 'my-card');
      expect(myCard).toMatchObject({
        label: '我的卡', provider: 'fake', model: 'fake-x', temperature: 0.33, source: 'stored',
      });
      expect(result.value.presets.find((p) => p.name === 'writing-day')?.source).toBe('seed');
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
      expect(result.value.message).toContain('内容手已切到');
      expect(result.value.message).toContain('写作日');
      expect(result.value.message).toContain('deepseek');
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
