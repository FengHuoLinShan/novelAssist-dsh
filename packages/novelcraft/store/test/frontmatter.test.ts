import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  SCHEMAS,
  normalizeEntityType,
  ENTITY_TYPES,
  normalizeOperation,
  FUSION_OPERATIONS,
  normalizeNarrativeTag,
  narrativeTagFromFm,
  isPlaceholderWord,
  normalizeAliasKey,
  entityKey,
  provenanceKey,
  validateImportFile,
  ALLOWED_IMPORT_EXTENSIONS,
  MAX_IMPORT_FILE_SIZE,
  canTransition,
} from '../src/index';
import { dedupeByEntityKey, findExactEntity, l0ExactGroups, shouldAutoPromote } from '../src/index';
import { filterActive } from '../src/index';

// M12-b/N44(review P1-2): object kind enums 收紧的行为锁定。
describe('object kind enums(N44: 非法 kind 写面 fail-closed)', () => {
  it('非法 kind → INVALID_ENUM 拒写; 合法 20 类通过', () => {
    const bad = validateFrontmatter('object', {
      id: 'obj-x', name: 'x', kind: '大反派', status: 'canonical',
    });
    expect(bad.some((i) => i.path === 'kind' && i.code === 'INVALID_ENUM')).toBe(true);
    const good = validateFrontmatter('object', {
      id: 'obj-x', name: 'x', kind: 'character', status: 'canonical',
    });
    expect(good).toEqual([]);
  });
});

describe('frontmatter parse/serialize', () => {
  it('round-trips a nested frontmatter + body deterministically', () => {
    const fm = {
      id: 'obj_klein',
      aliases: ['周明瑞', '愚者'],
      evidence: [{ source: 'chapters/003.md', quote: '……' }],
      importance: 0.9,
    };
    const body = '# 正文\n\n第一段\n';
    const text = serializeFrontmatter(fm, body);
    const parsed = parseFrontmatter(text);
    expect(parsed.data).toEqual(fm);
    expect(parsed.body).toBe(body);
  });

  it('returns empty frontmatter when no delimiter present', () => {
    const parsed = parseFrontmatter('just prose, no frontmatter');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('just prose, no frontmatter');
  });

  it('只把列 0 的 ---/... 当闭合符: block scalar 中缩进的 `  ---` 不截断 frontmatter', () => {
    const text = [
      '---',
      'id: page-1',
      'description: |',
      '  ---',
      '  ...',
      '  正文示例',
      '---',
      'body-text',
    ].join('\n');
    const parsed = parseFrontmatter(text);
    expect(parsed.body).toBe('body-text');
    expect(parsed.data.id).toBe('page-1');
    expect(parsed.data.description).toBe('---\n...\n正文示例\n'); // block scalar 内容原样保留(含尾换行)
  });

  it('闭合符带尾随空白仍识别(列 0 起始); 前导空白的行不识别为闭合', () => {
    // 列 0 的 `---   `(尾随空白) → 正常闭合。
    expect(parseFrontmatter(['---', 'id: a', '---   ', 'body'].join('\n')).body).toBe('body');
    // 前导空白的 `  ---` 不闭合 → 视为无 frontmatter(data={} body=全文)。
    const t2 = ['---', 'id: b', '  ---', 'body'].join('\n');
    const p2 = parseFrontmatter(t2);
    expect(p2.data).toEqual({});
    expect(p2.body).toBe(t2);
  });

  it('opening 与 closing 同口径: `---not-frontmatter` 首行不算 opening → 无 frontmatter', () => {
    // startsWith('---') 会误认: `---not-frontmatter` 不以换行/EOF 收尾, 必须整个视为正文。
    const t = ['---not-frontmatter', 'some prose', '---', 'more prose'].join('\n');
    const p = parseFrontmatter(t);
    expect(p.data).toEqual({});
    expect(p.body).toBe(t); // 正文原样, 不被截取。
  });

  it('opening 边界: 首行纯 `---`(尾随空白/EOF)仍是合法 opening', () => {
    // 尾随空白 opening。
    expect(parseFrontmatter(['---   ', 'id: a', '---', 'body'].join('\n')).data.id).toBe('a');
    // 首行 `---` 后无换行(EOF 单行): 视为 opening, 无闭合 → body=全文。
    const edge = parseFrontmatter('---');
    expect(edge.data).toEqual({});
    expect(edge.body).toBe('---');
  });

  it('body 原样切片: CRLF 行尾 / 无尾换行逐字节保留, 不归一化', () => {
    // CRLF 全文件: 旧 split/join 会把 body 归一为 LF; 现在必须原样保留 \r\n。
    const crlf = ['---', 'id: obj-crlf', 'name: "旧人"', 'kind: "character"', 'status: "canonical"', '---', '# 正文', '第一行'].join('\r\n');
    const p = parseFrontmatter(crlf);
    expect(p.data.name).toBe('旧人');
    expect(p.data.status).toBe('canonical');
    expect(p.body).toBe('# 正文\r\n第一行'); // 逐字节原样(含结尾无换行)。

    // CRLF closing 后身体原样(含 body 内部 \r\n)。
    const crlf2 = ['---', 'id: a', '---', '# 标题', '第二段'].join('\r\n');
    const p2 = parseFrontmatter(crlf2);
    expect(p2.data.id).toBe('a');
    expect(p2.body).toBe('# 标题\r\n第二段');

    // 闭合 --- 后无 body(EOF, 无尾换行) → body 为空串。
    const empty = ['---', 'id: a', 'status: canonical', '---'].join('\n');
    const p3 = parseFrontmatter(empty);
    expect(p3.data.status).toBe('canonical');
    expect(p3.body).toBe('');
  });
});

describe('validateFrontmatter(必填/类型/状态机取值)', () => {
  it('reports missing required fields (object)', () => {
    const issues = validateFrontmatter('object', { name: '克莱恩' });
    expect(issues.some((i) => i.code === 'MISSING_REQUIRED' && i.path === 'id')).toBe(true);
    expect(issues.some((i) => i.code === 'MISSING_REQUIRED' && i.path === 'kind')).toBe(true);
    expect(issues.some((i) => i.code === 'MISSING_REQUIRED' && i.path === 'status')).toBe(true);
  });

  it('accepts a fully-valid object frontmatter', () => {
    const issues = validateFrontmatter('object', {
      id: 'obj_klein',
      kind: 'character',
      name: '克莱恩',
      status: 'canonical',
    });
    expect(issues).toEqual([]);
  });

  it('rejects invalid status enum (R3 state machine values)', () => {
    const issues = validateFrontmatter('object', {
      id: 'obj_klein',
      kind: 'character',
      name: '克莱恩',
      status: 'bogus',
    });
    expect(issues.some((i) => i.code === 'INVALID_STATUS')).toBe(true);
  });

  it('rejects wrong field type (importance must be number)', () => {
    const issues = validateFrontmatter('object', {
      id: 'obj_klein',
      kind: 'character',
      name: '克莱恩',
      status: 'canonical',
      importance: 'high',
    });
    expect(issues.some((i) => i.code === 'INVALID_TYPE' && i.path === 'importance')).toBe(true);
  });

  it('scene requires narrative_tag + source + scene_index (outline 字段表)', () => {
    const bad = validateFrontmatter('scene', { id: 's012', status: 'draft' });
    expect(bad.some((i) => i.path === 'scene_index')).toBe(true);
    expect(bad.some((i) => i.path === 'narrative_tag')).toBe(true);
    expect(bad.some((i) => i.path === 'source')).toBe(true);
    const good = validateFrontmatter('scene', {
      id: 's012',
      status: 'draft',
      scene_index: 12,
      narrative_tag: 'draft',
      source: 'deep_import',
    });
    expect(good).toEqual([]);
  });

  it('结构资产与 Scene 接受 relations 字段(N14), 类型必须为 list', () => {
    const rel = [{ target: '主线', type: 'serves_thread' }];
    expect(validateFrontmatter('reveal', {
      id: '身世', status: 'draft', name: '身世',
      target_type: 'character', target_id: '苏婉', secret_summary: '孤儿',
      related_thread_ids: [],
      relations: rel,
    })).toEqual([]);
    expect(validateFrontmatter('scene', {
      id: 's012', status: 'draft', scene_index: 12, narrative_tag: 'draft', source: 'manual',
      relations: rel,
    })).toEqual([]);

    const badType = validateFrontmatter('thread', {
      id: '主线', status: 'draft', name: '主线', thread_type: 'plot',
      relations: 'not-a-list',
    });
    expect(badType.some((i) => i.code === 'INVALID_TYPE' && i.path === 'relations')).toBe(true);
  });

  it('reveal 不再强制 related_thread_ids(ADR-0019 P3 放宽, 「未归类」=「无边」)', () => {
    const issues = validateFrontmatter('reveal', {
      id: '身世', status: 'draft', name: '身世',
      target_type: 'character', target_id: '苏婉', secret_summary: '孤儿',
      // 无 related_thread_ids: 放宽后不报 MISSING_REQUIRED
    });
    expect(issues.some((i) => i.code === 'MISSING_REQUIRED' && i.path === 'related_thread_ids')).toBe(false);
    expect(issues).toEqual([]);
  });
});

describe('R29 · entity_type 20 枚举校验', () => {
  it('normalizes 20 类之一与中文别名', () => {
    for (const t of ENTITY_TYPES) expect(normalizeEntityType(t)).toBe(t);
    expect(normalizeEntityType('人物')).toBe('character');
    expect(normalizeEntityType('地点')).toBe('location');
    expect(normalizeEntityType('神器')).toBe('artifact');
    expect(normalizeEntityType('CHARACTER')).toBe('character');
  });

  it('rejects out-of-range values', () => {
    expect(normalizeEntityType('')).toBeNull();
    expect(normalizeEntityType('dragon_king')).toBeNull();
  });
});

describe('R60 · fusion operation 归一', () => {
  it('maps Chinese aliases to kept/merged/split/reordered/rewritten', () => {
    expect(normalizeOperation('拆分')).toBe('split');
    expect(normalizeOperation('合并')).toBe('merged');
    expect(normalizeOperation('重写')).toBe('rewritten');
    expect(normalizeOperation('排序')).toBe('reordered');
    expect(normalizeOperation('keep')).toBe('kept');
  });

  it('returns null for unknown values', () => {
    expect(normalizeOperation('teleport')).toBeNull();
  });
});

describe('R61/R64 · narrative_tag 归一与双轨合并', () => {
  it('normalizes imported→draft and truncates to 32', () => {
    expect(normalizeNarrativeTag('imported')).toBe('draft');
    expect(normalizeNarrativeTag('')).toBe('draft');
    expect(normalizeNarrativeTag('a'.repeat(40))).toHaveLength(32);
  });

  it('merges narrative_function into single narrative_tag (R64)', () => {
    expect(narrativeTagFromFm({ narrative_function: 'hook' })).toBe('hook');
    expect(narrativeTagFromFm({ narrative_tag: 'imported', narrative_function: 'hook' })).toBe('draft');
    expect(narrativeTagFromFm({})).toBe('draft');
  });
});

describe('R24 · 别名归一化去重', () => {
  it('casefold + collapse whitespace produce equal keys', () => {
    expect(normalizeAliasKey('Zhou Mingrui')).toBe(normalizeAliasKey('  zhou   mingrui '));
  });
});

describe('R25 · 占位词拒绝', () => {
  it('rejects placeholder words', () => {
    expect(isPlaceholderWord('未知')).toBe(true);
    expect(isPlaceholderWord('UNKNOWN')).toBe(true);
    expect(isPlaceholderWord('某人')).toBe(true);
    expect(isPlaceholderWord('苏婉')).toBe(false);
  });
});

describe('R21 · entity_key 幂等键', () => {
  it('same kind+name collapse to one key; different kind differ', () => {
    expect(entityKey('character', '  苏婉  ')).toBe(entityKey('CHARACTER', '苏婉'));
    expect(entityKey('character', '苏婉')).not.toBe(entityKey('location', '苏婉'));
  });

  it('dedupes a batch by entity_key', () => {
    const items = [
      { kind: 'character', name: '苏婉', id: 'a' },
      { kind: 'character', name: ' 苏婉 ', id: 'b' },
      { kind: 'location', name: '苏婉', id: 'c' },
    ];
    const deduped = dedupeByEntityKey(items);
    expect(deduped).toHaveLength(2);
  });
});

describe('R22 · provenance_key sha256(顺序无关)', () => {
  it('is order-independent over sorted components', () => {
    const a = provenanceKey({
      workflowId: 'wf1',
      candidateId: 'c1',
      sourceCandidateIds: ['x', 'y'],
      fusionOperation: 'merged',
      sourceChapterIndices: [3, 1],
    });
    const b = provenanceKey({
      workflowId: 'wf1',
      candidateId: 'c1',
      sourceCandidateIds: ['y', 'x'],
      fusionOperation: 'merged',
      sourceChapterIndices: [1, 3],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R23 · 精确同名同型确定性复用', () => {
  it('reuses an existing working entity regardless of create_new hint', () => {
    const objects = [
      { kind: 'character', name: '苏婉', status: 'canonical', id: 'obj_suwan' },
    ];
    const hit = findExactEntity(objects, 'character', '苏婉');
    expect(hit?.id).toBe('obj_suwan');
    expect(findExactEntity(objects, 'location', '苏婉')).toBeUndefined();
  });
});

describe('R28 · L0 确定性分组', () => {
  it('groups exact same normalized name + type', () => {
    const groups = l0ExactGroups([
      { kind: 'character', name: '苏婉' },
      { kind: 'character', name: '苏婉' },
      { kind: 'location', name: '苏婉' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });
});

describe('R27/R39 · 低置信不自动升 canonical', () => {
  it('below threshold is not auto-promotable', () => {
    expect(shouldAutoPromote({ confidence: 0.5, status: 'candidate' })).toBe(false);
    expect(shouldAutoPromote({ confidence: 0.98, status: 'candidate' })).toBe(true);
    expect(shouldAutoPromote({ confidence: 0.99, status: 'canonical' })).toBe(false);
  });
});

describe('R31 · 导入文件门禁(白名单/50MB/basename)', () => {
  it('rejects non-whitelisted extensions and oversize', () => {
    expect(validateImportFile('a.docx', 100).ok).toBe(false);
    expect(validateImportFile('a.txt', MAX_IMPORT_FILE_SIZE + 1).ok).toBe(false);
    expect(validateImportFile('a.txt', 100).ok).toBe(true);
    expect(validateImportFile('notes.md', 100).ok).toBe(true);
  });

  it('basename-sanitizes a traversal path before extension check', () => {
    expect(validateImportFile('../evil.txt', 100).ok).toBe(true); // 只按 basename 判扩展名
  });
});

describe('R20 · 结构资产列表默认排除 deprecated', () => {
  it('filters out deprecated unless explicitly requested', () => {
    const list = [{ status: 'draft' }, { status: 'deprecated' }, { status: 'canonical' }];
    expect(filterActive(list).map((x) => x.status)).toEqual(['draft', 'canonical']);
  });
});

describe('R3/R18/R19 · 状态机白名单', () => {
  it('only allows legal transitions', () => {
    expect(canTransition('object', 'draft', 'canonical')).toBe(true);
    expect(canTransition('object', 'canonical', 'canonical')).toBe(false);
    expect(canTransition('chapter', 'candidate', 'draft')).toBe(true); // adopt(R19)
    expect(canTransition('chapter', 'candidate', 'deprecated')).toBe(true); // reject(R19)
    expect(canTransition('chapter', 'candidate', 'published')).toBe(false); // 候选只读(R19)
    expect(canTransition('chapter', 'published', 'draft')).toBe(true); // copy-on-write(R18)
    expect(canTransition('chapter', 'published', 'published')).toBe(false); // 禁止原地改(R18)
    expect(canTransition('bible_page', 'draft', 'canonical')).toBe(true);
  });
});

describe('N9 · book.yml 字段名 target_length / current_stage(字符串枚举)', () => {
  it('accepts valid enum values and rejects invalid ones', () => {
    expect(validateFrontmatter('book', {
      title: '诡秘之主',
      target_length: 'epic',
      current_stage: 'writing',
    })).toEqual([]);
    const bad = validateFrontmatter('book', {
      title: '诡秘之主',
      target_length: 'huge', // 非法枚举
      current_stage: 'drafting', // 非法枚举
    });
    expect(bad.some((i) => i.code === 'INVALID_ENUM' && i.path === 'target_length')).toBe(true);
    expect(bad.some((i) => i.code === 'INVALID_ENUM' && i.path === 'current_stage')).toBe(true);
  });

  it('rejects old names target_scale / stage as unknown-type fields', () => {
    // 旧名不再是 book 字段表的一部分(N9)。
    expect(SCHEMAS.book.fields.target_scale).toBeUndefined();
    expect(SCHEMAS.book.fields.stage).toBeUndefined();
    expect(SCHEMAS.book.fields.target_length).toBe('string');
    expect(SCHEMAS.book.fields.current_stage).toBe('string');
  });
});
