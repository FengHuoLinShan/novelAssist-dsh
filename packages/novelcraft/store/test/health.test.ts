import { describe, it, expect } from 'vitest';
import { HEALTH_KEYS, computeSceneHealth, computeSceneHealthDetail, missingSetupFields, organizeReasons } from '../src/index';

describe('N1 · 6 键健康词汇表', () => {
  it('exposes exactly the six adjudicated signal keys', () => {
    expect(HEALTH_KEYS).toEqual([
      'scene_unreviewed',
      'scene_unassigned_chapter',
      'scene_missing_setup',
      'scene_needs_organize',
      'structure_needs_review',
      'structure_unassigned',
    ]);
  });
});

describe('computeSceneHealth(确定性字段推导)', () => {
  it('flags unreviewed for deep_import draft without reviewed_at', () => {
    const signals = computeSceneHealth({
      source: 'deep_import',
      status: 'draft',
      chapter_ids: [1],
      goal: '有目标',
    });
    expect(signals).toContain('scene_unreviewed');
  });

  it('flags unassigned when chapter_ids empty and not planned', () => {
    const signals = computeSceneHealth({
      source: 'manual',
      status: 'draft',
      chapter_ids: [],
      goal: '有目标',
    });
    expect(signals).toContain('scene_unassigned_chapter');
  });

  it('flags missing_setup when goal is empty', () => {
    const signals = computeSceneHealth({
      source: 'manual',
      status: 'draft',
      chapter_ids: [1],
      goal: '',
    });
    expect(signals).toContain('scene_missing_setup');
  });

  it('flags needs_organize on duplicate chapter ids', () => {
    const signals = computeSceneHealth({
      source: 'manual',
      status: 'draft',
      chapter_ids: [3, 3],
      goal: '有目标',
      reviewed_at: '2026-08-14T00:00:00Z',
    });
    expect(signals).toContain('scene_needs_organize');
  });

  it('returns empty for a healthy, reviewed scene', () => {
    const signals = computeSceneHealth({
      source: 'manual',
      status: 'canonical',
      chapter_ids: [1, 2],
      goal: '有目标',
      core_conflict: '有冲突',
      must_happen: '有必须',
      must_not_happen: '有禁止',
      reviewed_at: '2026-08-14T00:00:00Z',
    });
    expect(signals).toEqual([]);
  });
});

describe('computeSceneHealthDetail(证据明细)', () => {
  it('missing_setup 带缺失字段名; needs_organize 带 reason 码', () => {
    const details = computeSceneHealthDetail({
      source: 'manual',
      status: 'draft',
      chapter_ids: [3, 3],
      goal: '',
      reviewed_at: '2026-08-14T00:00:00Z',
    });
    const missing = details.find((d) => d.key === 'scene_missing_setup');
    const organize = details.find((d) => d.key === 'scene_needs_organize');
    expect(missing?.missing).toContain('goal');
    expect(missing?.missing).toContain('core_conflict');
    expect(organize?.reasons).toContain('duplicate_chapter');
  });

  it('键列表与明细一致(向后兼容)', () => {
    const fm = { source: 'deep_import', status: 'draft', chapter_ids: [], goal: '' };
    expect(computeSceneHealth(fm)).toEqual(computeSceneHealthDetail(fm).map((d) => d.key));
  });
});

describe('missingSetupFields / organizeReasons(导出 helper)', () => {
  it('present 却无值 → 命中; not_applicable 却有值 → 命中', () => {
    expect(missingSetupFields({
      goal: '有',
      core_conflict: '',
      core_conflict_status: 'present',
    })).toContain('core_conflict');
    expect(missingSetupFields({
      goal: '有',
      must_happen: '有值',
      must_happen_status: 'not_applicable',
    })).toContain('must_happen');
  });

  it('chunk 与 chapter_ids 不一致 → chunk_chapter_mismatch', () => {
    expect(organizeReasons({
      chapter_ids: [1, 2],
      scene_chunks: [{ chapter_index: 1 }],
    })).toContain('chunk_chapter_mismatch');
  });
});
