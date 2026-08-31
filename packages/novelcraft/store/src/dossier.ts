// store · 章节档案(chapterDossier): §17.5.1 每章一整页的纯读组装。
// Scene 分解 / 人物在场 / POV / 伏笔种下-回收对账 / 设定引用清单 / 节奏指标。
// 纯 TS 确定性、零 LLM、零 DSH 依赖; 读面合并在上层做, 本模块不 import
// @novelcraft/writing / @novelcraft/assistant(层纪律: store 是事实层)。
// 字段依据: specs/assets/outline.md「Scene frontmatter 字段表」(goal/core_conflict/
// must_happen/must_not_happen/narrative_tag/pov_character_id/chapter_ids) 与
// specs/assets/writing.md「章节正文字段」(chapter_index/status/content_hash/title)。
// 容错契约(§17.5.1): 任一资产文件缺失/坏 frontmatter → 只跳过该资产, 不炸整体。
// 主组装 = 一次 storyMap(root)(内含 rebuildIndex + related_*_ids 兼容投影并集, N17 口径);
// rebuildIndex 对坏 frontmatter 上抛为既有行为, 故 storyMap 失败时降级为目录级容错自组装。

import path from "node:path";
import { readEvents, projectWorldState } from '@novelcraft/memory';
import { paths } from "@novelcraft/vault";
import { parseFrontmatter } from "./frontmatter.js";
import { exists, listFilesRecursive, readText } from "./fs.js";
import { rebuildIndex } from "./index.js";
import { storyMap } from "./story-map.js";
import type { StoryMap, StoryMapScene, StoryMapAsset } from "./story-map.js";
import type { VaultIndex } from "./index.js";

export interface DossierScene {
  slug: string;
  title: string;
  status: string;
  goal?: string;
  core_conflict?: string;
  must_happen?: string;
  must_not_happen?: string;
  narrative_tag?: string;
  pov_character_id?: string;
}

export interface ChapterDossierMemory {
  events_total: number;
  events_through_chapter: number;
  broken_lines: number;
  entities_tracked: number;
  relations_tracked: number;
  last_event_at?: string;
}

export interface ChapterDossier {
  /** 章不存在 → null(其余字段仍尽力组装, 便于「未导入章」兜底 UI)。 */
  chapter: {
    index: number;
    title?: string;
    status: string;
    contentHash?: string;
    wordCount: number;
  } | null;
  /** chapter_ids 含本章, 按 scene_index 或 slug 排序。 */
  scenes: DossierScene[];
  /** 在场人物(去重): scenes 的 references_character 边 + related_character_ids 投影 + pov_character_id。 */
  characters: Array<{ slug: string; name: string }>;
  /** scene slug → 解析后的人物名(解析不到用 slug)。 */
  pov: Array<{ scene: string; character: string }>;
  foreshadowing: {
    /** start_chapter == N。 */
    planted: Array<{ slug: string; name: string }>;
    /** chapter_range 含 N 且非 planted。 */
    activeThrough: Array<{ slug: string; name: string }>;
    /** planned_payoff_chapter == N。 */
    duePayoff: Array<{ slug: string; name: string }>;
  };
  /** chapter_range 含 N 或 start_chapter == N 的 reveal 资产。 */
  reveals: Array<{ slug: string; name: string }>;
  /** 本章 scenes 的 references_entity 边 + related_entity_ids 投影(去重)。 */
  referencedObjects: Array<{ slug: string; name: string; kind: string }>;
  /** wordCount = 正文去空白字符数; avgSceneLength = wordCount/sceneCount(0 除 → 0, 取整)。 */
  rhythm: { wordCount: number; sceneCount: number; avgSceneLength: number };
  /** 记忆投影读面(M12-c/N46, §6.18.4)。 */
  memory: ChapterDossierMemory;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s !== "") : [];
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 整体容错: storyMap/rebuildIndex 任一楼宇坏 frontmatter 会上抛(既有行为), 档案降级自组装。 */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** 场景候选: 主用 storyMap.scenes; 降级(坏资产令 storyMap 上抛)时目录级容错扫描。 */
function sceneCandidates(root: string, map: StoryMap | null): SceneCandidate[] {
  if (map) {
    return map.scenes.map((s: StoryMapScene) => ({
      slug: s.slug,
      file: `scenes/${s.slug}.md`,
      status: s.status,
      chapters: s.chapters,
    }));
  }
  const dir = paths(root).scenes.dir;
  if (!exists(dir)) return [];
  const out: SceneCandidate[] = [];
  for (const rel of listFilesRecursive(dir)) {
    if (!rel.endsWith(".md")) continue;
    try {
      const data = parseFrontmatter(readText(path.join(dir, rel))).data as Record<string, unknown>;
      out.push({
        slug: path.basename(rel, path.extname(rel)),
        file: `scenes/${rel}`,
        status: str(data.status) ?? "",
        chapters: strArr(data.chapter_ids),
      });
    } catch {
      // 坏 frontmatter: 跳过该场景, 不炸(§17.5.1 容错)
    }
  }
  return out;
}

interface SceneCandidate {
  slug: string;
  file: string;
  status: string;
  chapters: string[];
}

interface ChapterScene {
  slug: string;
  /** 已解析的 scene frontmatter(坏文件已被跳过)。 */
  fm: Record<string, unknown>;
  scene_index?: number;
  dossier: DossierScene;
}

/** 逐文件读 Scene 详情(outline.md 字段表); 文件缺失/坏 frontmatter → null 跳过。 */
function readSceneDetail(root: string, c: SceneCandidate): ChapterScene | null {
  try {
    const data = parseFrontmatter(readText(path.join(root, c.file))).data as Record<string, unknown>;
    return {
      slug: c.slug,
      fm: data,
      scene_index: num(data.scene_index),
      dossier: {
        slug: c.slug,
        title: str(data.title) ?? "",
        status: str(data.status) ?? c.status ?? "",
        goal: str(data.goal),
        core_conflict: str(data.core_conflict),
        must_happen: str(data.must_happen),
        must_not_happen: str(data.must_not_happen),
        narrative_tag: str(data.narrative_tag),
        pov_character_id: str(data.pov_character_id),
      },
    };
  } catch {
    return null;
  }
}

/** 章正文与元数据: 文件不存在 → null; 坏 frontmatter → 元数据留空, 正文词数仍尽力统计。 */
function readChapterMeta(
  root: string,
  chapterIndex: number,
): ChapterDossier["chapter"] {
  const file = paths(root).chapters.chapterFile(chapterIndex);
  if (!exists(file)) return null;
  const raw = readText(file);
  // 剥 frontmatter 口径与 imports/stages.ts readChapterText 一致。
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const wordCount = body.replace(/\s/g, "").length;
  let status = "";
  let title: string | undefined;
  let contentHash: string | undefined;
  try {
    const data = parseFrontmatter(raw).data as Record<string, unknown>;
    status = str(data.status) ?? "";
    title = str(data.title);
    contentHash = str(data.content_hash);
  } catch {
    // 坏 frontmatter: 跳过元数据, 不炸(§17.5.1 容错)
  }
  return { index: chapterIndex, title, status, contentHash, wordCount };
}

/** 组装章节档案(§17.5.1)。 */
/** 记忆投影读面(N46): 故事顺序过滤(chapter_index ≤ N) → projectWorldState。 */
function memoryProjection(root: string, chapterIndex: number): {
  events_total: number;
  events_through_chapter: number;
  broken_lines: number;
  entities_tracked: number;
  relations_tracked: number;
  last_event_at?: string;
} {
  try {
    const { events, brokenLines } = readEvents(root);
    const through = events.filter((e) => e.chapter_index <= chapterIndex);
    const projection = projectWorldState(through);
    return {
      events_total: events.length,
      events_through_chapter: through.length,
      broken_lines: brokenLines,
      entities_tracked: projection.entities.size,
      relations_tracked: projection.relations.length,
      ...(projection.lastEventAt !== undefined ? { last_event_at: projection.lastEventAt } : {}),
    };
  } catch {
    // 账本不可读(坏文件/权限) → 空投影, 不阻断 dossier 主读面(容错降级)。
    return { events_total: 0, events_through_chapter: 0, broken_lines: 0, entities_tracked: 0, relations_tracked: 0 };
  }
}

export function chapterDossier(root: string, chapterIndex: number): ChapterDossier {
  const want = String(chapterIndex);

  // 一次 storyMap(内含 rebuildIndex + N17 edges 投影并集)拿 chapters/scenes/结构资产/edges。
  const map = safe(() => storyMap(root));
  // 对象表(slug→name/kind)供名称解析; storyMap 成功时此重建必成功, 失败时同因降级为 null。
  const index = safe(() => rebuildIndex(root)) as VaultIndex | null;

  const chapter = readChapterMeta(root, chapterIndex);

  // Scene 分解: chapter_ids 含本章, 按 scene_index(缺省 ∞)或 slug 排序; 坏文件跳过。
  const chapterScenes: ChapterScene[] = [];
  for (const c of sceneCandidates(root, map)) {
    if (!c.chapters.includes(want)) continue;
    const detail = readSceneDetail(root, c);
    if (!detail) continue; // 坏 frontmatter → 跳过该资产
    chapterScenes.push(detail);
  }
  chapterScenes.sort(
    (a, b) =>
      (a.scene_index ?? Number.POSITIVE_INFINITY) - (b.scene_index ?? Number.POSITIVE_INFINITY) ||
      cmpStr(a.slug, b.slug),
  );
  const scenes = chapterScenes.map((s) => s.dossier);

  // 人物/设定引用: 边口径(N17: related_*_ids 已投影进 edges) + pov_character_id(N16 不进边, 从 fm 读)。
  // 降级时无 edges, 直接读 scene fm 的 related_*_ids(与 N17 投影同口径)。
  const nameOf = (slug: string): string => {
    const o = index?.objects.find((x) => x.slug === slug);
    return o && o.name !== "" ? o.name : slug;
  };
  const kindOf = (slug: string): string => {
    const o = index?.objects.find((x) => x.slug === slug);
    return o ? o.kind : "";
  };
  const charSlugs = new Set<string>();
  const entitySlugs = new Set<string>();
  for (const s of chapterScenes) {
    if (map) {
      for (const e of map.edges) {
        if (e.source === s.slug && e.type === "references_character") charSlugs.add(e.target);
        else if (e.source === s.slug && e.type === "references_entity") entitySlugs.add(e.target);
      }
    } else {
      const meta = (s.fm.structure_meta ?? {}) as Record<string, unknown>;
      for (const cid of strArr(s.fm.related_character_ids ?? meta.related_character_ids)) charSlugs.add(cid);
      for (const eid of strArr(s.fm.related_entity_ids ?? meta.related_entity_ids)) entitySlugs.add(eid);
    }
    const pov = str(s.fm.pov_character_id);
    if (pov) charSlugs.add(pov); // N16: pov_character_id 不进边
  }
  const characters = [...charSlugs].sort(cmpStr).map((slug) => ({ slug, name: nameOf(slug) }));
  const referencedObjects = [...entitySlugs].sort(cmpStr).map((slug) => ({ slug, name: nameOf(slug), kind: kindOf(slug) }));
  const pov = chapterScenes.flatMap((s) => {
    const pid = str(s.fm.pov_character_id);
    return pid ? [{ scene: s.slug, character: nameOf(pid) }] : [];
  });

  // 伏笔/揭示(结构资产, 深字段来自 storyMap)。
  const assets = map ? map.foreshadowing : [];
  const reveals = map ? map.reveals : [];
  const toRef = (a: StoryMapAsset): { slug: string; name: string } => ({ slug: a.slug, name: a.name });
  const planted = assets.filter((a) => a.start_chapter === chapterIndex);
  const plantedSlugs = new Set(planted.map((a) => a.slug));
  const activeThrough = assets.filter(
    (a) => !plantedSlugs.has(a.slug) && (a.chapter_range ?? []).includes(chapterIndex),
  );
  const duePayoff = assets.filter((a) => a.planned_payoff_chapter === chapterIndex);
  const revealList = reveals.filter(
    (a) => (a.chapter_range ?? []).includes(chapterIndex) || a.start_chapter === chapterIndex,
  );

  const wordCount = chapter ? chapter.wordCount : 0;
  const sceneCount = scenes.length;
  const avgSceneLength = sceneCount === 0 ? 0 : Math.round(wordCount / sceneCount);

  return {
    chapter,
    scenes,
    characters,
    pov,
    foreshadowing: {
      planted: planted.map(toRef),
      activeThrough: activeThrough.map(toRef),
      duePayoff: duePayoff.map(toRef),
    },
    reveals: revealList.map(toRef),
    referencedObjects,
    rhythm: { wordCount, sceneCount, avgSceneLength },
    // M12-c/N46: 记忆事件账本投影读面(§6.18.4)—— 按故事顺序(chapter_index ≤ 本章)
    // 过滤后投影世界状态; 本章事件数与坏行数供连续性参考。账本不存在时为空投影。
    memory: memoryProjection(root, chapterIndex),
  };
}
