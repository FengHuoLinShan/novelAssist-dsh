// world · 对象/别名/关系/待处理读面与 CRUD(薄封装 store, R5 确定性核心)。
// 依据: specs/assets/world.md + store-rules; 知识标签 = 对象 frontmatter tags 派生(N13)。
// N32/ADR-0021 P1: 写面(createObject/updateObject)不再直接 writeText + gitAdd + gitCommit,
// 而是经 @novelcraft/store.executeCanonicalWrite(kind='canonical', ADR-0021): 首写前
// 产出完整确定性 writeSet(输出字节 + 计划时刻当前字节 expected), 内容 CAS/预存 staged
// fail-closed/崩溃 durable intent 条件回滚由事务层承接; 无关 unstaged/untracked 允许。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assertNoSymlinkOnPath, guardPath, paths, slugify } from "@novelcraft/vault";
import {
  executePreparedCanonicalWrite,
  gitHead,
  parseFrontmatter,
  prepareCanonicalWrite,
  relOf,
  serializeFrontmatter,
  StoreError,
  validateFrontmatter,
  type PreparedCanonicalWrite,
  type TransactionOptions,
} from "@novelcraft/store";

/** 对象 relations 有向对(N11/N14): source=宿主对象文件本身, 不落 source 字段。 */
export interface ObjectRelation {
  target: string;
  type: string;
  status?: string;
  description?: string;
}

export interface WorldObject {
  slug: string;
  name: string;
  entity_type: string;
  status: string;
  aliases: string[];
  tags: string[];
  /** N14 list 形态 → 结构化对象数组; legacy 字符串形态(旧 vault)原样保留。 */
  relations?: ObjectRelation[] | string;
  confidence?: number;
  evidence: string[];
  file: string;
}

/**
 * guardPath 之后对最终目标追加 vault 根级逐段 symlink 检查(R9): guardPath 的
 * real containment 会放行指向 vault 内其他文件的 symlink(同目录 x.md → y.md),
 * 跟随读写会把 x 的内容当 y、把对 x 的写落到 y(审批看到 x 不能改 y);
 * assertNoSymlinkOnPath 从 vault 根逐段 lstat, 任一已存在组件是 symlink 一律
 * fail-closed(目录级 symlink 已由 paths() 构造层拒绝, 此处封住文件级)。
 */
function guardedFile(root: string, dir: string, name: string): string {
  const file = guardPath(dir, name);
  assertNoSymlinkOnPath(root, file);
  return file;
}

export function readObject(root: string, slug: string): WorldObject {
  // R9 containment: 以 world/objects 为限定根(不限于 vault 根)——`../` 穿越、
  // 指向外部的 .md symlink 与 vault 内同目录 symlink 一律拒绝(fail-closed)。
  const file = guardedFile(root, paths(root).world.objects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`对象不存在: ${slug}`);
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  return toWorldObject(slug, data, file);
}

export function readPendingObject(root: string, slug: string): WorldObject {
  const file = guardedFile(root, paths(root).world.pending, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`候选不存在: ${slug}`);
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  return toWorldObject(slug, data, file);
}

function toWorldObject(slug: string, data: Record<string, unknown>, file: string): WorldObject {
  return {
    slug,
    name: String(data.name ?? ""),
    // B1(用户裁定): 写面统一 kind; 读面 kind 优先, entity_type 仅作存量兼容 fallback。
    entity_type: String(data.kind ?? data.entity_type ?? ""),
    status: String(data.status ?? ""),
    aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    // B2/N14: relations list → 结构化对象数组; legacy 字符串形态(旧 vault)保留 fallback。
    relations: Array.isArray(data.relations)
      ? (data.relations as unknown[])
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
          .map((r) => ({
            target: String(r.target ?? ""),
            type: String(r.type ?? ""),
            ...(typeof r.status === "string" ? { status: r.status } : {}),
            ...(typeof r.description === "string" ? { description: r.description } : {}),
          }))
      : typeof data.relations === "string"
        ? data.relations
        : undefined,
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    evidence: Array.isArray(data.evidence) ? data.evidence.map(String) : [],
    file,
  };
}

/** 限定目录内 .md 文件逐个 guardPath + 最终目标 symlink 检查: 指向目录外的
 * symlink(外部)与 vault 内同目录 symlink(内部)一律 fail-closed 抛错。 */
function readDirObjects(root: string, dir: string): WorldObject[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const file = guardedFile(root, dir, f); // R9: 限定目录 containment + symlink 拒绝。
      const { data } = parseFrontmatter(readFileSync(file, "utf8"));
      return toWorldObject(slug, data, file);
    });
}

/** 已采用对象(world/objects/)。 */
export function listObjects(root: string): WorldObject[] {
  return readDirObjects(root, paths(root).world.objects);
}

/** 待处理候选(world/pending/, suggestion queue = pending 目录)。 */
export function listPending(root: string): WorldObject[] {
  return readDirObjects(root, paths(root).world.pending);
}

/** 标签派生(N13): 读对象 tags, 无独立标签文件。 */
export function listTags(root: string): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const o of listObjects(root)) {
    for (const t of o.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

export interface PreparedWorldCreate { readonly write: PreparedCanonicalWrite; readonly slug: string }
export interface PreparedWorldUpdate { readonly write: PreparedCanonicalWrite }

/** 审批前冻结创建对象的输出字节、absent baseline 与 HEAD。 */
export function prepareCreateObject(
  root: string,
  input: { name: string; entityType: string; aliases?: string[]; tags?: string[]; description?: string },
  opts: { tx?: TransactionOptions } = {},
): PreparedWorldCreate {
  if (!input.name.trim()) throw new Error("name 必填");
  const slug = slugify(`obj-${input.name}`); // 前缀保证非空; 旧 Date.now() 兜底为不可达死代码已删(M12-a review)
  const file = guardedFile(root, paths(root).world.objects, `${slug}.md`); // R9: 写面与读面同 gate。
  if (existsSync(file)) {
    // 坍缩语义区分(M12-b review P1-1 修复): 比对既有对象的 name —— 同名冲突 vs
    // 不同名字折叠为同一 slug(空白/特殊字符折叠), 报错可分辨(旧实现恒真不可达)。
    const existingName = (() => {
      try {
        return parseFrontmatter(readFileSync(file, "utf8")).data?.name;
      } catch {
        return undefined;
      }
    })();
    const sameName = typeof existingName === "string" && existingName === input.name.trim();
    throw new Error(
      sameName
        ? `对象已存在: ${slug}(同名对象「${input.name}»); 换名或先处理既有对象`
        : `slug 坍缩冲突: 名字「${input.name}」折为 ${slug}, 与既有对象「${String(existingName ?? "?")}»同名; 请换一个名字`,
    );
  }
  const fm: Record<string, unknown> = {
    id: slug, // N23/M7-C: object schema required 含 id(frontmatter.ts:417), 落盘即带
    name: input.name.trim(),
    kind: input.entityType || "object", // B1(用户裁定): 字段表用 kind(specs/assets/world.md)
    status: "canonical",
  };
  if (input.aliases?.length) fm.aliases = input.aliases;
  if (input.tags?.length) fm.tags = input.tags;
  // N23/M7-C: 落盘前 schema 校验, issues 非空 fail-closed 拒写(与 assertValidRelations 同构)。
  const issues = validateFrontmatter("object", fm);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `object frontmatter 校验失败: ${detail}`, issues);
  }
  const lines = [
    "---",
    `id: ${JSON.stringify(fm.id)}`,
    `name: ${JSON.stringify(fm.name)}`,
    `kind: ${JSON.stringify(fm.kind)}`,
    "status: canonical",
  ];
  if (Array.isArray(fm.aliases)) lines.push(`aliases: [${fm.aliases.map((a) => JSON.stringify(a)).join(", ")}]`);
  if (Array.isArray(fm.tags)) lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  lines.push("---", "");
  const output = lines.join("\n") + `# ${input.name}\n\n${input.description ?? ""}\n`;
  return Object.freeze({
    slug,
    write: prepareCanonicalWrite(
      root,
      [{ path: relOf(root, file), current: null, output }],
      { purpose: `world: create ${slug}`, expectedHead: gitHead(root), ...(opts.tx ? { tx: opts.tx } : {}) },
    ),
  });
}

export async function executePreparedCreateObject(prepared: PreparedWorldCreate): Promise<string> {
  await executePreparedCanonicalWrite(prepared.write);
  return prepared.slug;
}

export async function createObject(
  root: string,
  input: { name: string; entityType: string; aliases?: string[]; tags?: string[]; description?: string },
  opts: { tx?: TransactionOptions } = {},
): Promise<string> {
  return executePreparedCreateObject(prepareCreateObject(root, input, opts));
}

/** 审批前冻结对象更新的 current/output/HEAD。 */
export function prepareUpdateObject(
  root: string,
  slug: string,
  patch: { name?: string; description?: string; tags?: string[] },
  opts: { tx?: TransactionOptions } = {},
): PreparedWorldUpdate {
  const obj = readObject(root, slug);
  // 写前对最终目标再显式 symlink 检查(R9): 防 read 之后文件被换成 symlink,
  // 确保对 x 的写不会经链接落到 y(审批看到 x 不能改 y)。
  assertNoSymlinkOnPath(root, obj.file);
  // 正文直接取 parseFrontmatter 的 body(手工 indexOf 提取在闭合 --- 无尾换行/CRLF 等
  // 形态下会损坏正文; parseFrontmatter 按行切分, 各种行尾/无尾换行均稳定)。
  const bytes = readFileSync(obj.file, "utf8");
  const { data, body } = parseFrontmatter(bytes);
  const next = { ...data };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.tags !== undefined) next.tags = patch.tags;
  // N23/M7-C: 合并 patch 后的 fm 落盘前同样校验; 缺 id 等必填 → fail-closed 不写(无部分状态)。
  const issues = validateFrontmatter("object", next);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `object frontmatter 校验失败: ${detail}`, issues);
  }
  const output = serializeFrontmatter(next, patch.description !== undefined ? patch.description : body);
  return Object.freeze({
    write: prepareCanonicalWrite(
      root,
      [{ path: relOf(root, obj.file), current: bytes, output }],
      { purpose: `world: update ${slug}`, expectedHead: gitHead(root), ...(opts.tx ? { tx: opts.tx } : {}) },
    ),
  });
}

export async function executePreparedUpdateObject(prepared: PreparedWorldUpdate): Promise<void> {
  await executePreparedCanonicalWrite(prepared.write);
}

export async function updateObject(
  root: string,
  slug: string,
  patch: { name?: string; description?: string; tags?: string[] },
  opts: { tx?: TransactionOptions } = {},
): Promise<void> {
  return executePreparedUpdateObject(prepareUpdateObject(root, slug, patch, opts));
}
