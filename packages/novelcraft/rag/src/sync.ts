// syncRagIndex — 增量索引同步(M6 Track A1, L0): 扫描 vault 三类源
// (chapters/*.md 顶层、world/*.md 顶层、world/objects/*.md), 以源文件为单位
// 与现有 rag-index.json 比对 content_hash, 产出新索引并落盘。
//
// 增量语义:
// - hash 一致 → 保留旧 chunk(对象引用/vector/embedding_status/embedding_model 原样);
// - hash 不一致 → 重新切块(updated);
// - 新文件 → 新增(added);
// - 索引里有但源文件已消失 → 丢弃(removed);
// - 非三类源 chunk(memory/outline 等, 本函数不管理)原样保留, 不计数。
// 确定性: 同输入(含相同 now)恒同输出; now 仅影响 rebuilt_at。
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, parseFrontmatter } from "@novelcraft/store";
import { paths } from "@novelcraft/vault";
import {
  INDEX_VERSION_CN,
  chunkChapterText,
  readRagIndex,
  rebuildRagIndex,
  type RagChunk,
  type RagSourceType,
} from "./rag.js";

export interface RagSyncStats {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

type SourceKind = "chapter" | "character" | "world_entity";

interface SourceFile {
  key: string;
  kind: SourceKind;
  hash: string;
  body: string;
  chapterIndex?: number;
  basename?: string;
}

/** 从旧 chunk 推断其归属源文件键; 非三类源 chunk 返回 undefined(不管理)。 */
function sourceKeyOf(c: RagChunk): string | undefined {
  if (c.source_type === "chapter_text") {
    if (typeof c.chapter_index === "number") return `ch:${c.chapter_index}`;
    const m = /^ch(\d+)-/.exec(c.chunk_id);
    if (m) return `ch:${parseInt(m[1], 10)}`;
    return undefined;
  }
  if (c.source_type === "character") {
    const m = /^char-(.+)$/.exec(c.chunk_id);
    if (m) return `char:${m[1]}`;
    return undefined;
  }
  if (c.source_type === "world_entity") {
    const m = /^obj-(.+)$/.exec(c.chunk_id);
    if (m) return `obj:${m[1]}`;
    return undefined;
  }
  return undefined;
}

/** world 整文件(剥 frontmatter 后)单 chunk; 空 body 返回 []。 */
function worldChunk(src: SourceFile): RagChunk[] {
  const text = src.body.trim();
  if (text.length === 0) return [];
  const sourceType: RagSourceType = src.kind === "character" ? "character" : "world_entity";
  return [
    {
      chunk_id: src.kind === "character" ? `char-${src.basename}` : `obj-${src.basename}`,
      source_type: sourceType,
      source_content_hash: src.hash,
      chunk_index: 0,
      char_count: text.length,
      text,
      visibility: "author_only",
      importance: 0.5,
      index_version: INDEX_VERSION_CN,
      embedding_status: "pending",
    },
  ];
}

/** 确定性排序: 章节(按 index 升序) → world 角色(按 basename) → world 对象(按 basename)。 */
function sortSources(sources: SourceFile[]): void {
  const kindOrder = (k: SourceKind): number => (k === "chapter" ? 0 : k === "character" ? 1 : 2);
  sources.sort((a, b) => {
    const ka = kindOrder(a.kind);
    const kb = kindOrder(b.kind);
    if (ka !== kb) return ka - kb;
    if (a.kind === "chapter") return a.chapterIndex! - b.chapterIndex!;
    const ba = a.basename ?? "";
    const bb = b.basename ?? "";
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });
}

export function syncRagIndex(root: string, now: Date = new Date()): RagSyncStats {
  const p = paths(root);

  // 1. 扫描三类源(仅顶层, 不递归 chapters/pending 等子目录)。
  const sources: SourceFile[] = [];
  if (existsSync(p.chapters.dir)) {
    // R9(目录枚举扫描): withFileTypes 只接收 entry.isFile() 的章节普通文件(*.md);
    // 仓库内 symlink(含指向 vault 外)与子目录(如 pending/)一律忽略, 不跟随。
    for (const entry of readdirSync(p.chapters.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const m = /^(\d+)\.md$/.exec(entry.name);
      if (!m) continue;
      const abs = join(p.chapters.dir, entry.name);
      const { body } = parseFrontmatter(readFileSync(abs, "utf8"));
      const chapterIndex = parseInt(m[1], 10);
      sources.push({
        key: `ch:${chapterIndex}`,
        kind: "chapter",
        chapterIndex,
        hash: contentHash(body),
        body,
      });
    }
  }
  if (existsSync(p.world.dir)) {
    // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)与子目录
    // (world/objects、world/pending 等)一律忽略, 不跟随。
    for (const entry of readdirSync(p.world.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const abs = join(p.world.dir, entry.name);
      const { body } = parseFrontmatter(readFileSync(abs, "utf8"));
      const basename = entry.name.slice(0, -3);
      sources.push({ key: `char:${basename}`, kind: "character", basename, hash: contentHash(body), body });
    }
  }
  if (existsSync(p.world.objects)) {
    // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
    for (const entry of readdirSync(p.world.objects, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const abs = join(p.world.objects, entry.name);
      const { body } = parseFrontmatter(readFileSync(abs, "utf8"));
      const basename = entry.name.slice(0, -3);
      sources.push({ key: `obj:${basename}`, kind: "world_entity", basename, hash: contentHash(body), body });
    }
  }
  sortSources(sources);

  // 2. 读现有索引, 按源文件键分组(未管理 chunk 原样保留)。
  const old = readRagIndex(root);
  const oldChunks = old?.chunks ?? [];
  const oldByKey = new Map<string, RagChunk[]>();
  const unmanaged: RagChunk[] = [];
  for (const c of oldChunks) {
    const key = sourceKeyOf(c);
    if (key === undefined) {
      unmanaged.push(c);
      continue;
    }
    const list = oldByKey.get(key);
    if (list) list.push(c);
    else oldByKey.set(key, [c]);
  }

  // 3. 逐源文件比对 hash, 构建新 chunk 序列。
  const newChunks: RagChunk[] = [];
  let added = 0;
  let updated = 0;
  for (const src of sources) {
    const olds = oldByKey.get(src.key) ?? [];
    const unchanged = olds.length > 0 && olds.every((c) => c.source_content_hash === src.hash);
    if (unchanged) {
      newChunks.push(...olds);
      continue;
    }
    const fresh = src.kind === "chapter"
      ? chunkChapterText(src.body, { chapterIndex: src.chapterIndex!, contentHash: src.hash })
      : worldChunk(src);
    if (fresh.length === 0) continue; // 空内容源不进索引, 不计数。
    if (olds.length === 0) added += 1;
    else updated += 1;
    newChunks.push(...fresh);
  }

  // 4. 旧索引中源文件已消失 → 丢弃(removed); 未管理 chunk 追加保留。
  let removed = 0;
  const liveKeys = new Set(sources.map((s) => s.key));
  for (const key of oldByKey.keys()) {
    if (!liveKeys.has(key)) removed += 1;
  }
  newChunks.push(...unmanaged);

  // 5. 落盘。
  mkdirSync(p.assistant.dir, { recursive: true });
  rebuildRagIndex(root, newChunks, now);
  return { added, updated, removed, total: newChunks.length };
}
