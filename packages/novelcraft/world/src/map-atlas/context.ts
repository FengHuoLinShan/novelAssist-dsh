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

/** 预算常量(policy-defaults §9)。
 *  批预算口径(review F1): 每批 = 5 地点(spatial.ts ATLAS_SPATIAL_BATCH_SIZE),
 *  每地点已限 8000 → 5×8000=40000 结构性满足, 编译侧无需全局二次截断。 */
export const ATLAS_MAX_LOCATIONS = 20;
export const ATLAS_WIKI_PER_LOCATION = 3;
export const ATLAS_CHARS_PER_LOCATION = 8000;
export const ATLAS_CHARS_PER_BATCH = ATLAS_CHARS_PER_LOCATION * 5;
export const ATLAS_RAG_TOPK = 5;

/** 确定性空间查询词表(逐字对齐旧引擎 _SPATIAL_TERMS, workflow.py:60; 不注入 provider, 仅 L0 BM25)。
 *  计划提到的 purpose=map_atlas 为旧引擎口径: M4 searchRag 无 purpose 参数(单索引), 此处留痕。 */
const SPATIAL_TERMS = "方位、距离或行程、邻接、道路、河流、山脉、入口、地标、内部布局";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safePrefix(text: string, maxChars: number): string {
  let end = Math.min(text.length, Math.max(0, maxChars));
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** 空文本不占 selector 槽；同 key 冲突 fail-closed，避免 packet/manifest 身份歧义。 */
function uniqueEvidence(items: AtlasEvidenceItem[]): AtlasEvidenceItem[] {
  const byKey = new Map<string, AtlasEvidenceItem>();
  for (const item of items) {
    if (!item.text) continue;
    if (!item.source_key || !wellFormed(item.source_key) || !wellFormed(item.text)) {
      throw new Error(`atlas evidence 含非法 Unicode/identity: ${item.source_key}`);
    }
    const prior = byKey.get(item.source_key);
    if (prior && prior.text !== item.text) {
      throw new Error(`atlas source_key 内容冲突: ${item.source_key}`);
    }
    if (!prior) byKey.set(item.source_key, item);
  }
  return [...byKey.values()];
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
  // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
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
  // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
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
    const text = safePrefix(item.text, budget);
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
  // "已有 atlas 节点"口径定死: 只算 nodes/(已采用+暂存), 不算 pending 候选(review F5)。
  const atlasLocationRefs = new Set(
    tree.nodes
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
  const sourceByKey = new Map<string, { fullText: string; ref: SourceRef }>();
  const includedByKey = new Map<string, string>();
  const locationSourceHashes: Record<string, string[]> = {};

  for (const loc of selected) {
    const nameKeys = [loc.name, ...loc.aliases].filter(Boolean);
    const wikiPages = biblePages
      .filter(
        (p) => p.linkedSlugs.has(loc.slug) || nameKeys.some((n) => p.title.includes(n)),
      )
      .filter((p) => p.text.length > 0)
      // 显式链接页优先于标题命中页(对齐旧引擎 linked-first; review F4), 组内按 slug 确定性排序。
      .sort((a, b) => Number(b.linkedSlugs.has(loc.slug)) - Number(a.linkedSlugs.has(loc.slug)) || cmpStr(a.slug, b.slug))
      .slice(0, ATLAS_WIKI_PER_LOCATION);
    const wikiFull = uniqueEvidence(wikiPages.map((p) => ({
      source_key: `wiki:${p.slug}`,
      text: p.text,
    })));
    const ragFull = uniqueEvidence(await ragEvidence(root, loc));

    const trimmed = trimLocationEvidence(wikiFull, ragFull);
    const retained = [...trimmed.wiki, ...trimmed.rag];
    // 地点名不是直接证据；无 retained/openable 来源的地点不支付 LLM。
    if (retained.length === 0) continue;
    const fullByKey = new Map([...wikiFull, ...ragFull].map((item) => [item.source_key, item]));
    const wikiByKey = new Map(wikiPages.map((page) => [`wiki:${page.slug}`, page]));
    // A1: 先 trim，再从实际 packet 生成 manifest；原始与实发片段 hash 分列。
    for (const item of retained) {
      const full = fullByKey.get(item.source_key);
      if (!full) throw new Error(`atlas retained source 无原文: ${item.source_key}`);
      const sourceHash = sha256Hex(full.text).slice(0, 16);
      let ref: SourceRef;
      if (item.source_key.startsWith("wiki:")) {
        const page = wikiByKey.get(item.source_key);
        if (!page) throw new Error(`atlas wiki source 无页面: ${item.source_key}`);
        ref = {
          source_id: page.slug,
          source_type: "bible_page",
          title: page.title || page.slug,
          source_hash: sourceHash,
          source_status: page.status,
          open_target: { kind: "bible_page", slug: page.slug },
        };
      } else {
        const chunkId = item.source_key.slice("rag:".length);
        if (!chunkId) throw new Error("atlas rag source 缺 chunk_id");
        ref = {
          source_id: chunkId,
          source_type: "rag_chunk",
          title: safePrefix(full.text, 30),
          source_hash: sourceHash,
          source_status: "canonical",
          open_target: { kind: "rag_chunk", chunk_id: chunkId },
        };
      }
      const prior = sourceByKey.get(item.source_key);
      if (prior && (prior.fullText !== full.text || JSON.stringify(prior.ref) !== JSON.stringify(ref))) {
        throw new Error(`atlas source_key 映射冲突: ${item.source_key}`);
      }
      if (!prior) sourceByKey.set(item.source_key, { fullText: full.text, ref });
      const included = includedByKey.get(item.source_key);
      if (included === undefined || item.text.length < included.length) includedByKey.set(item.source_key, item.text);
    }
    packets.push({
      location_key: loc.slug,
      name: loc.name,
      aliases: loc.aliases,
      importance: loc.importance,
      wiki: trimmed.wiki,
      rag: trimmed.rag,
      source_keys: retained.map((i) => i.source_key),
    });
  }

  // 同一 source 跨地点时统一为各 packet 都能容纳的最短实发前缀：
  // 一个 source_key 始终映射同一文本/一条 manifest，避免 validator Map 歧义。
  for (const packet of packets) {
    const normalize = (item: AtlasEvidenceItem): AtlasEvidenceItem => ({
      ...item,
      text: includedByKey.get(item.source_key) ?? item.text,
    });
    packet.wiki = packet.wiki.map(normalize);
    packet.rag = packet.rag.map(normalize);
    packet.source_keys = [...packet.wiki, ...packet.rag].map((item) => item.source_key);
    locationSourceHashes[packet.location_key] = [...packet.wiki, ...packet.rag]
      .map((item) => sha256Hex(`${item.source_key}\n${item.text}`).slice(0, 16))
      .sort();
  }

  const manifest: SourceRef[] = [...sourceByKey.entries()].map(([key, source]) => {
    const included = includedByKey.get(key);
    if (included === undefined) throw new Error(`atlas source 无实发片段: ${key}`);
    return {
      ...source.ref,
      included_content_hash: sha256Hex(included).slice(0, 16),
      included_range: { start: 0, end: included.length },
      truncated: included.length < source.fullText.length,
    };
  });

  const contextHash = sha256Hex(
    JSON.stringify({
      options: {
        include_working_drafts: includeDrafts,
        include_interiors: opts?.include_interiors === true,
        style_note: opts?.style_note ?? null,
      },
      packets,
      manifest: manifest.map((m) => ({
        source_type: m.source_type,
        source_id: m.source_id,
        title: m.title,
        open_target: m.open_target,
        source_hash: m.source_hash,
        included_content_hash: m.included_content_hash,
        included_range: m.included_range,
        truncated: m.truncated,
        source_status: m.source_status,
      })),
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
      message: selected.length === 0
        ? "没有可核对的已采用地点。"
        : "已采用地点没有可核对的保留证据。",
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
