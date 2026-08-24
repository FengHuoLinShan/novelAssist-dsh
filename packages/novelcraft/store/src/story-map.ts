// store · 剧情地图聚合(storyMap): 纯读结构资产 + Scene/章节覆盖 + 关系边, 供剧情地图 UI 消费。
// 显式 relations 边(N11/N14)已进 VaultIndex.relations(对象缺省 sourceKind=对象, 跨类带 sourceKind);
// 本函数补充 related_*_ids 兼容投影(N17: 展开为等价有向边, 与显式 relations 边并集去重)。
// 依据: 设计文档 §17.5(剧情地图)、ADR-0019(附录 A type 枚举 + N14/N16/N17)、N12(目录化)。
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "./fs.js";
import { rebuildIndexSnapshot } from "./index.js";
import type { RelationEntry, VaultIndexSnapshot } from "./index.js";

export interface StoryMapAsset {
  kind: "thread" | "arc" | "foreshadowing" | "reveal";
  slug: string;
  name: string;
  status: string;
  summary?: string;
  thread_type?: string;
  start_chapter?: number;
  end_chapter?: number;
  chapter_range?: number[];
  planned_payoff_chapter?: number;
  planned_payoff_scene?: string;
  related_thread_ids?: string[];
  target_type?: string;
  target_id?: string;
  secret_summary?: string;
}

export interface StoryMapScene {
  slug: string;
  status: string;
  chapters: string[];
  title?: string;
}

export interface StoryMap {
  book: string;
  chapters: Array<{ index: number; title?: string }>;
  scenes: StoryMapScene[];
  threads: StoryMapAsset[];
  arcs: StoryMapAsset[];
  foreshadowing: StoryMapAsset[];
  reveals: StoryMapAsset[];
  /** 关系边(显式 relations: 对象缺省 sourceKind=对象 + 跨类带 sourceKind; 并 related_*_ids 兼容投影并集去重, N17)。 */
  edges: RelationEntry[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : undefined;
}
function numArr(v: unknown): number[] | undefined {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "number") as number[]) : undefined;
}

/**
 * related_*_ids 兼容投影(N17): 按 ADR-0019 附录 A「对应存量字段」列展开为等价有向边。
 * 身份锚(reveal.target_id / scene.pov_character_id)不进边(N16)。
 */
function expandLegacyEdges(
  kind: string,
  slug: string,
  fm: Record<string, unknown>,
  out: RelationEntry[],
): void {
  const push = (targets: unknown, type: string): void => {
    if (!Array.isArray(targets)) return;
    for (const t of targets) {
      if (typeof t !== "string" || t === "") continue;
      out.push({ source: slug, target: t, type, status: "canonical", sourceKind: kind });
    }
  };
  const meta = (fm.structure_meta ?? {}) as Record<string, unknown>;

  switch (kind) {
    case "thread":
      push(fm.related_character_ids, "references_character");
      push(fm.related_entity_ids, "references_entity");
      push(fm.related_memory_ids, "references_memory");
      break;
    case "arc":
      push(fm.related_thread_ids, "serves_thread");
      push(fm.related_character_ids, "references_character");
      push(fm.related_entity_ids, "references_entity");
      break;
    case "scene":
      push(fm.related_thread_ids ?? meta.related_thread_ids, "serves_thread");
      push(fm.related_character_ids ?? meta.related_character_ids, "references_character");
      push(fm.related_entity_ids ?? meta.related_entity_ids, "references_entity");
      if (typeof meta.parent_outline_arc_id === "string" && meta.parent_outline_arc_id) {
        out.push({
          source: slug,
          target: meta.parent_outline_arc_id,
          type: "belongs_to_arc",
          status: "canonical",
          sourceKind: "scene",
        });
      }
      break;
    case "foreshadowing":
      push(fm.related_thread_ids, "serves_thread");
      push(fm.related_entity_ids, "references_entity");
      if (typeof fm.planned_payoff_scene === "string" && fm.planned_payoff_scene) {
        out.push({
          source: slug,
          target: fm.planned_payoff_scene,
          type: "pays_off_in_scene",
          status: "canonical",
          sourceKind: "foreshadowing",
        });
      }
      break;
    case "reveal":
      push(fm.related_thread_ids, "serves_thread");
      break;
    default:
      break;
  }
}

/** 聚合剧情地图: book + chapters + scenes + 四类结构资产(带深字段)+ 跨类边。 */
export function storyMap(root: string): StoryMap {
  return storyMapFromSnapshot(root, rebuildIndexSnapshot(root));
}

/** 复用 rebuildIndexSnapshot 的已解析 frontmatter，不再次读取 Scene/结构文件。 */
export function storyMapFromSnapshot(root: string, snapshot: VaultIndexSnapshot): StoryMap {
  const { index, frontmatterByFile } = snapshot;

  let book = path.basename(root);
  try {
    // book.yml 是纯 YAML(非 --- frontmatter), 直接 parseYaml 读 title。
    const parsed = parseYaml(readText(path.join(root, "book.yml"))) as Record<string, unknown> | null;
    if (parsed && typeof parsed.title === "string" && parsed.title) book = parsed.title;
  } catch {
    // book.yml 缺失/非法用目录名兜底
  }

  const scenes: StoryMapScene[] = index.scenes.map((s) => {
    const data = frontmatterByFile.get(s.file);
    const title = typeof data?.title === "string" ? data.title : undefined;
    return { slug: s.slug, status: s.status, chapters: s.chapters, title };
  });

  // 关系边 = 显式 relations 边(N11/N14: 对象缺省 sourceKind=对象 + 跨类带 sourceKind)
  //           ∪ related_*_ids 兼容投影(N17), 去重。
  const explicit = index.relations;
  const edges: RelationEntry[] = [...explicit];
  const seen = new Set<string>();
  for (const e of explicit) {
    seen.add(`${e.source}\u0000${e.sourceKind ?? ""}\u0000${e.target}\u0000${e.type}`);
  }
  const legacy: RelationEntry[] = [];
  for (const s of index.scenes) {
    const data = frontmatterByFile.get(s.file);
    if (data !== undefined) expandLegacyEdges("scene", s.slug, data, legacy);
  }
  for (const st of index.structure) {
    if (st.kind === "outline") continue;
    const data = frontmatterByFile.get(st.file);
    if (data !== undefined) expandLegacyEdges(st.kind, st.slug, data, legacy);
  }
  for (const e of legacy) {
    const key = `${e.source}\u0000${e.sourceKind ?? ""}\u0000${e.target}\u0000${e.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(e);
    }
  }
  edges.sort((a, b) => {
    const ka = `${a.source}\u0000${a.sourceKind ?? ""}\u0000${a.target}\u0000${a.type}`;
    const kb = `${b.source}\u0000${b.sourceKind ?? ""}\u0000${b.target}\u0000${b.type}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const asset = (e: { kind: string; slug: string; file: string; status: string; name?: string }): StoryMapAsset => {
    const fm = frontmatterByFile.get(e.file) ?? {};
    return {
      kind: e.kind as StoryMapAsset["kind"],
      slug: e.slug,
      name: e.name ?? str(fm.title) ?? str(fm.name) ?? e.slug,
      status: e.status,
      summary: str(fm.summary),
      thread_type: str(fm.thread_type),
      start_chapter: num(fm.start_chapter),
      end_chapter: num(fm.end_chapter),
      chapter_range: numArr(fm.chapter_range),
      planned_payoff_chapter: num(fm.planned_payoff_chapter),
      planned_payoff_scene: str(fm.planned_payoff_scene),
      related_thread_ids: strArr(fm.related_thread_ids),
      target_type: str(fm.target_type),
      target_id: str(fm.target_id),
      secret_summary: str(fm.secret_summary),
    };
  };

  const pick = (kind: string): StoryMapAsset[] =>
    index.structure.filter((s) => s.kind === kind).map(asset);

  return {
    book,
    chapters: index.chapters.map((c) => ({ index: c.index, title: c.title })),
    scenes,
    threads: pick("thread"),
    arcs: pick("arc"),
    foreshadowing: pick("foreshadowing"),
    reveals: pick("reveal"),
    edges,
  };
}
