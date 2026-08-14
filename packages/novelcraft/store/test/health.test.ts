import { describe, it, expect } from 'vitest';
import { HEALTH_KEYS, computeSceneHealth } from '../src/index';

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
