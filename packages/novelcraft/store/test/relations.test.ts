// store · validateRelations(ADR-0019 P0)行为契约。
// 断言注释引 ADR-0019 附录 A / N14-N16 / R26。
import { describe, it, expect, afterEach } from 'vitest';
import { validateRelations, assertValidRelations } from '../src/relations';
import { tmpVault, initRepo, writeAsset, commitAll } from './helpers';

const cleanups: Array<() => void> = [];
let root = '';

function fixture(): string {
  const { root: r, cleanup } = tmpVault();
  cleanups.push(cleanup);
  initRepo(r);
  commitAll(r, 'init');
  root = r;
  return r;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** 建齐 7 类 type 所需的目标资产(附录 A 端点)。 */
function scaffold(r: string): void {
  writeAsset(r, 'structure/threads/主线.md', {
    id: '主线', status: 'canonical', name: '主线', thread_type: 'plot',
  }, '主线');
  writeAsset(r, 'structure/arcs/第一卷.md', {
    id: '第一卷', status: 'canonical', title: '第一卷',
  }, '第一卷');
  writeAsset(r, 'structure/foreshadowing/怀表.md', {
    id: '怀表', status: 'canonical', name: '怀表',
  }, '怀表');
  writeAsset(r, 'structure/reveal/身世.md', {
    id: '身世', status: 'canonical', name: '身世',
    target_type: 'character', target_id: '苏婉', secret_summary: '孤儿',
    related_thread_ids: ['主线'],
  }, '身世');
  writeAsset(r, 'scenes/s012.md', {
    id: 's012', status: 'draft', scene_index: 12, narrative_tag: 'draft', source: 'manual',
    chapter_ids: [7],
  }, 'scene');
  writeAsset(r, 'world/objects/苏婉.md', {
    id: '苏婉', kind: 'character', name: '苏婉', status: 'canonical',
  }, '苏婉');
  writeAsset(r, 'world/objects/霜华剑.md', {
    id: '霜华剑', kind: 'item', name: '霜华剑', status: 'canonical',
  }, '霜华剑');
}

describe('validateRelations(ADR-0019 P0 · N14/N15/N16)', () => {
  it('合法边: reveal → foreshadowing 配对 + serves_thread 归类(N14)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'reveal', '身世', [
      { target: '怀表', type: 'reveals_foreshadowing' },
      { target: '主线', type: 'serves_thread' },
    ]);
    expect(issues).toEqual([]);
  });

  it('合法边: scene → thread/arc/character, foreshadowing → scene/entity(N15 源白名单)', () => {
    const r = fixture();
    scaffold(r);
    const sceneIssues = validateRelations(r, 'scene', 's012', [
      { target: '主线', type: 'serves_thread' },
      { target: '第一卷', type: 'belongs_to_arc' },
      { target: '苏婉', type: 'references_character' },
    ]);
    expect(sceneIssues).toEqual([]);

    const foreIssues = validateRelations(r, 'foreshadowing', '怀表', [
      { target: 's012', type: 'pays_off_in_scene' },
      { target: '霜华剑', type: 'references_entity' },
    ]);
    expect(foreIssues).toEqual([]);
  });

  it('合法边: thread → character/entity/memory; memory 事件 id 仅非空校验', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'thread', '主线', [
      { target: '苏婉', type: 'references_character' },
      { target: '霜华剑', type: 'references_entity' },
      { target: 'ev-3-2', type: 'references_memory' },
    ]);
    expect(issues).toEqual([]);
  });

  it('未知 type → UNKNOWN_RELATION_TYPE(N15 核心枚举 fail-closed)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'reveal', '身世', [
      { target: '主线', type: 'friend_of' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('UNKNOWN_RELATION_TYPE');
  });

  it('源 kind 不在白名单 → RELATION_TYPE_NOT_ALLOWED(thread 不允许 serves_thread)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'thread', '主线', [
      { target: '主线', type: 'serves_thread' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('RELATION_TYPE_NOT_ALLOWED');
  });

  it('悬空 target → RELATION_TARGET_NOT_FOUND(N14 端点存在性)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'reveal', '身世', [
      { target: '不存在的伏笔', type: 'reveals_foreshadowing' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('RELATION_TARGET_NOT_FOUND');
  });

  it('端点 kind 不符 → RELATION_TARGET_KIND_MISMATCH(character 引用指向 item)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'thread', '主线', [
      { target: '霜华剑', type: 'references_character' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('RELATION_TARGET_KIND_MISMATCH');
  });

  it('references_entity 指向 character → KIND_MISMATCH(N16 人物归 references_character)', () => {
    const r = fixture();
    scaffold(r);
    const issues = validateRelations(r, 'thread', '主线', [
      { target: '苏婉', type: 'references_entity' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('RELATION_TARGET_KIND_MISMATCH');
  });

  it('形状错误: 非数组 → INVALID_TYPE; 元素非对象 → INVALID_RELATION_ENTRY; 缺字段 → MISSING_REQUIRED', () => {
    const r = fixture();
    scaffold(r);

    const notArray = validateRelations(r, 'scene', 's012', 'oops');
    expect(notArray.map((i) => i.code)).toEqual(['INVALID_TYPE']);

    const badEntry = validateRelations(r, 'scene', 's012', [null, 42]);
    expect(badEntry.map((i) => i.code)).toEqual(['INVALID_RELATION_ENTRY', 'INVALID_RELATION_ENTRY']);

    const missing = validateRelations(r, 'scene', 's012', [
      { type: 'serves_thread' },
      { target: '主线' },
    ]);
    expect(missing.map((i) => i.code)).toEqual(['MISSING_REQUIRED', 'MISSING_REQUIRED']);
  });

  it('undefined/null relations 直接通过(relations 为可选字段)', () => {
    const r = fixture();
    scaffold(r);
    expect(validateRelations(r, 'scene', 's012', undefined)).toEqual([]);
    expect(validateRelations(r, 'scene', 's012', null)).toEqual([]);
  });

  it('确定性: 同一输入两次校验结果一致(纯函数, R12 精神)', () => {
    const r = fixture();
    scaffold(r);
    const input = [
      { target: '怀表', type: 'reveals_foreshadowing' },
      { target: '主线', type: 'serves_thread' },
    ];
    const a = validateRelations(r, 'reveal', '身世', input);
    const b = validateRelations(r, 'reveal', '身世', input);
    expect(a).toEqual(b);
    expect(a).toEqual([]);
  });

  it('assertValidRelations: 合法静默通过; 非法抛 StoreError(VALIDATION_FAILED, 硬错, ADR-0019 P3)', () => {
    const r = fixture();
    scaffold(r);
    expect(() => assertValidRelations(r, 'reveal', '身世', [
      { target: '怀表', type: 'reveals_foreshadowing' },
    ])).not.toThrow();
    let thrown: unknown;
    try {
      assertValidRelations(r, 'reveal', '身世', [
        { target: '不存在的伏笔', type: 'reveals_foreshadowing' },
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe('VALIDATION_FAILED');
    expect(String((thrown as Error).message)).toContain('relation target 未找到');
    const details = (thrown as { details?: Array<{ code: string }> }).details;
    expect(details?.some((d) => d.code === 'RELATION_TARGET_NOT_FOUND')).toBe(true);
  });
});
