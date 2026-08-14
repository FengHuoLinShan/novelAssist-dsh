// store · 剧情地图聚合(storyMap): 纯读结构资产 + Scene/章节覆盖, 供剧情地图 UI 消费。
// 跨类关系边(thread↔scene↔arc)不在 VaultIndex.relations 里(那只覆盖世界对象),
// 由本函数直读各结构资产 frontmatter 的 related_*_ids / chapter_range 等字段组装。
// 依据: 设计文档 §17.5(剧情地图)、N12(结构资产目录化)、frontmatter STRUCTURE_FIELDS。
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "./frontmatter.js";
import { readText } from "./fs.js";
import { rebuildIndex } from "./index.js";

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

/** 聚合剧情地图: book + chapters + scenes + 四类结构资产(带深字段)。 */
export function storyMap(root: string): StoryMap {
  const index = rebuildIndex(root);

  let book = path.basename(root);
  try {
    // book.yml 是纯 YAML(非 --- frontmatter), 直接 parseYaml 读 title。
    const parsed = parseYaml(readText(path.join(root, "book.yml"))) as Record<string, unknown> | null;
    if (parsed && typeof parsed.title === "string" && parsed.title) book = parsed.title;
  } catch {
    // book.yml 缺失/非法用目录名兜底
  }

  const scenes: StoryMapScene[] = index.scenes.map((s) => {
    let title: string | undefined;
    try {
      const { data } = parseFrontmatter(readText(path.join(root, s.file)));
      title = typeof data.title === "string" ? data.title : undefined;
    } catch {
      title = undefined;
    }
    return { slug: s.slug, status: s.status, chapters: s.chapters, title };
  });

  const asset = (e: { kind: string; slug: string; file: string; status: string; name?: string }): StoryMapAsset => {
    let fm: Record<string, unknown> = {};
    try {
      fm = parseFrontmatter(readText(path.join(root, e.file))).data as Record<string, unknown>;
    } catch {
      fm = {};
    }
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
  };
}
