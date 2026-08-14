// world/map-atlas · 来源上下文编译(Phase 2; 计划 §4 Phase 2; 确定性, 无 LLM)。
// 地点选择(≤20)/世界书证据(≤3 页)/RAG 证据(topK=5)/预算截断(8000+40000)/来源 manifest + 指纹输入。
// 依据: map-atlas 实施计划 §2/§4 Phase 2、policy-defaults §9、移植锚点(旧引擎 workflow.py 407-530 行)。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { paths } from "@novelcraft/vault";
import { parseFrontmatter } from "@novelcraft/store";
import { searchRag } from "@novelcraft/rag";
import { readAtlasTree } from "./read.js";
import type {
  AtlasContextOptions,
  AtlasContextPacket,
  AtlasContextResult,
  AtlasEvidenceItem,
  SourceRef,
} from "./types.js";

/** 预算常量(policy-defaults §9)。 */
export const ATLAS_MAX_LOCATIONS = 20;
export const ATLAS_WIKI_PER_LOCATION = 3;
export const ATLAS_CHARS_PER_LOCATION = 8000;
export const ATLAS_CHARS_PER_BATCH = 40000;
export const ATLAS_RAG_TOPK = 5;

/** 确定性空间查询词表(旧引擎 _spatial_query 同语义; 不注入 provider, 仅 L0 BM25)。 */
const SPATIAL_TERMS = "位置 方向 距离 路线 相邻 地标 地形 入口 布局 规模";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface LocationCandidate {
  slug: string;
  name: string;
  aliases: string[];
  importance: number;
  hasAtlasNode: boolean;
  bibleLinked: boolean;
}

interface BiblePageInfo {
  slug: string;
  status: string;
  title: string;
  linkedSlugs: Set<string>;
  text: string;
}

/** canonical location 对象(读面: kind 优先, entity_type fallback —— B1 口径同 objects.ts)。 */
function readCanonicalLocations(
  root: string,
): Array<{ slug: string; name: string; aliases: string[]; importance: number }> {
  const dir = paths(root).world.objects;
  if (!existsSync(dir)) return [];
  const out: Array<{ slug: string; name: string; aliases: string[]; importance: number }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const { data } = parseFrontmatter(readFileSync(path.join(dir, f), "utf8"));
    const kind = String(data.kind ?? data.entity_type ?? "");
    if (kind !== "location" || String(data.status ?? "") !== "canonical") continue;
    out.push({
      slug: f.replace(/\.md$/, ""),
      name: String(data.name ?? ""),
      aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
      importance: typeof data.importance === "number" ? data.importance : 0,
    });
  }
  return out;
}

/** 世界书页(canonical 必选; includeDrafts 时 draft 可选; 文本 = free_text/body 字段 + 正文拼接)。 */
function readBiblePages(root: string, includeDrafts: boolean): BiblePageInfo[] {
  const dir = paths(root).bible.dir;
  if (!existsSync(dir)) return [];
  const pages: BiblePageInfo[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const { data, body } = parseFrontmatter(readFileSync(path.join(dir, f), "utf8"));
    const status = String(data.status ?? "");
    if (status !== "canonical" && !(includeDrafts && status === "draft")) continue;
    const linkedSlugs = new Set<string>();
    if (Array.isArray(data.linked_asset_refs)) {
      for (const ref of data.linked_asset_refs as unknown[]) {
        if (typeof ref === "string") linkedSlugs.add(ref);
        else if (ref && typeof ref === "object" && !Array.isArray(ref)) {
          const r = ref as Record<string, unknown>;
          for (const k of ["slug", "id", "ref", "target"]) {
            if (typeof r[k] === "string") linkedSlugs.add(r[k] as string);
          }
        }
      }
    }
    const text = [String(data.free_text ?? ""), String(data.body ?? ""), body ?? ""]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    pages.push({ slug: f.replace(/\.md$/, ""), status, title: String(data.title ?? ""), linkedSlugs, text });
  }
  return pages;
}

/** RAG 证据: 失败/无索引只减少证据(degrade, 计划 Phase 2), 绝不抛错。 */
async function ragEvidence(
  root: string,
  loc: { name: string; aliases: string[] },
): Promise<AtlasEvidenceItem[]> {
  try {
    const query = [loc.name, ...loc.aliases, SPATIAL_TERMS].filter(Boolean).join(" ");
    const r = await searchRag(root, query, { topK: ATLAS_RAG_TOPK });
    return r.hits.map((h) => ({ source_key: `rag:${h.chunk_id}`, text: h.text }));
  } catch {
    return [];
  }
}

/**
 * 每地点预算截断(≤8000 字; 移植旧引擎 trim_sources):
 * 两族都存在时各先保 1 条(首条各 ≤cap/2), 余量按 wiki → rag 顺序填充; 一族缺失时另一族独占预算。
 */
function trimLocationEvidence(
  wiki: AtlasEvidenceItem[],
  rag: AtlasEvidenceItem[],
): { wiki: AtlasEvidenceItem[]; rag: AtlasEvidenceItem[] } {
  const cap = ATLAS_CHARS_PER_LOCATION;
  const take = (item: AtlasEvidenceItem, budget: number): AtlasEvidenceItem | null => {
    if (budget <= 0) return null;
    const text = item.text.slice(0, budget);
    return text ? { ...item, text } : null;
  };
  if (wiki.length > 0 && rag.length > 0) {
    const firstBudget = Math.floor(cap / 2);
    const outWiki: AtlasEvidenceItem[] = [];
    const outRag: AtlasEvidenceItem[] = [];
    let used = 0;
    const w0 = take(wiki[0], firstBudget);
    if (w0) {
      outWiki.push(w0);
      used += w0.text.length;
    }
    const r0 = take(rag[0], firstBudget);
    if (r0) {
      outRag.push(r0);
      used += r0.text.length;
    }
    for (const item of [...wiki.slice(1), ...rag.slice(1)]) {
      const t = take(item, cap - used);
      if (!t) break;
      used += t.text.length;
      (item.source_key.startsWith("wiki:") ? outWiki : outRag).push(t);
    }
    return { wiki: outWiki, rag: outRag };
  }
  const single = wiki.length > 0 ? wiki : rag;
  const out: AtlasEvidenceItem[] = [];
  let used = 0;
  for (const item of single) {
    const t = take(item, cap - used);
    if (!t) break;
    used += t.text.length;
    out.push(t);
  }
  return { wiki: wiki.length > 0 ? out : [], rag: rag.length > 0 ? out : [] };
}

/** 整批预算(≤40000 字): 按地点排序顺序累计, 超额的后续证据只截 text(保留 source_keys/manifest)。 */
function enforceBatchBudget(packets: AtlasContextPacket[]): void {
  let used = 0;
  for (const p of packets) {
    for (const item of [...p.wiki, ...p.rag]) {
      const remaining = ATLAS_CHARS_PER_BATCH - used;
      if (remaining <= 0) {
        item.text = "";
        continue;
      }
      if (item.text.length > remaining) item.text = item.text.slice(0, remaining);
      used += item.text.length;
    }
  }
}

/**
 * 地图册来源上下文编译(确定性; 计划 §4 Phase 2 步骤 1-3)。
 * 产出 packets(LLM 输入)/source_manifest(校验白名单)/location_source_hashes + context_hash(指纹输入)。
 */
export async function compileAtlasContext(
  root: string,
  opts?: AtlasContextOptions,
): Promise<AtlasContextResult> {
  const includeDrafts = opts?.include_working_drafts === true;
  const biblePages = readBiblePages(root, includeDrafts);
  const tree = readAtlasTree(root);
  const atlasLocationRefs = new Set(
    [...tree.nodes, ...tree.pendingNodes]
      .map((n) => n.location_ref)
      .filter((x): x is string => typeof x === "string" && x.length > 0),
  );

  const candidates: LocationCandidate[] = readCanonicalLocations(root).map((loc) => ({
    ...loc,
    hasAtlasNode: atlasLocationRefs.has(loc.slug),
    bibleLinked: biblePages.some((p) => p.linkedSlugs.has(loc.slug)),
  }));
  // 排序(计划 Phase 2): 已有 atlas 节点 > 世界书链接 > importance 降序 > name > slug。
  candidates.sort(
    (a, b) =>
      Number(b.hasAtlasNode) - Number(a.hasAtlasNode) ||
      Number(b.bibleLinked) - Number(a.bibleLinked) ||
      b.importance - a.importance ||
      cmpStr(a.name, b.name) ||
      cmpStr(a.slug, b.slug),
  );
  const selected = candidates.slice(0, ATLAS_MAX_LOCATIONS);

  const packets: AtlasContextPacket[] = [];
  const manifest: SourceRef[] = [];
  const locationSourceHashes: Record<string, string[]> = {};

  for (const loc of selected) {
    const nameKeys = [loc.name, ...loc.aliases].filter(Boolean);
    const wikiPages = biblePages
      .filter(
        (p) => p.linkedSlugs.has(loc.slug) || nameKeys.some((n) => p.title.includes(n)),
      )
      .sort((a, b) => cmpStr(a.slug, b.slug))
      .slice(0, ATLAS_WIKI_PER_LOCATION);
    const wikiFull: AtlasEvidenceItem[] = wikiPages.map((p) => ({
      source_key: `wiki:${p.slug}`,
      text: p.text,
    }));
    const ragFull = await ragEvidence(root, loc);

    // manifest 用未截断文本算 hash(预算无关, 稳定)。
    const hashes: string[] = [];
    for (const p of wikiPages) {
      const h = sha256Hex(p.text).slice(0, 16);
      hashes.push(h);
      manifest.push({
        source_id: p.slug,
        source_type: "bible_page",
        title: p.title || p.slug,
        source_hash: h,
        source_status: p.status,
        open_target: { kind: "bible_page", slug: p.slug },
      });
    }
    for (const item of ragFull) {
      const chunkId = item.source_key.slice("rag:".length);
      const h = sha256Hex(item.text).slice(0, 16);
      hashes.push(h);
      manifest.push({
        source_id: chunkId,
        source_type: "rag_chunk",
        title: item.text.slice(0, 30),
        source_hash: h,
        source_status: "canonical",
        open_target: { kind: "rag_chunk", chunk_id: chunkId },
      });
    }
    hashes.sort();

    const trimmed = trimLocationEvidence(wikiFull, ragFull);
    packets.push({
      location_key: loc.slug,
      name: loc.name,
      aliases: loc.aliases,
      importance: loc.importance,
      wiki: trimmed.wiki,
      rag: trimmed.rag,
      source_keys: [...trimmed.wiki, ...trimmed.rag].map((i) => i.source_key),
    });
    locationSourceHashes[loc.slug] = hashes;
  }

  enforceBatchBudget(packets);

  const contextHash = sha256Hex(
    JSON.stringify({
      options: {
        include_working_drafts: includeDrafts,
        include_interiors: opts?.include_interiors === true,
        style_note: opts?.style_note ?? null,
      },
      manifest: manifest.map((m) => m.source_id).sort(),
      hashes: locationSourceHashes,
    }),
  );

  if (packets.length === 0) {
    return {
      packets,
      source_manifest: manifest,
      location_source_hashes: locationSourceHashes,
      context_hash: contextHash,
      insufficient_sources: true,
      message: "没有可核对的已采用地点。",
    };
  }
  return {
    packets,
    source_manifest: manifest,
    location_source_hashes: locationSourceHashes,
    context_hash: contextHash,
    insufficient_sources: false,
  };
}
