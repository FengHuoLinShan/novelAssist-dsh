// world · 对象/别名/关系/待处理读面与 CRUD(薄封装 store, R5 确定性核心)。
// 依据: specs/assets/world.md + store-rules; 知识标签 = 对象 frontmatter tags 派生(N13)。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths, slugify } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter, StoreError, validateFrontmatter } from "@novelcraft/store";

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

export function readObject(root: string, slug: string): WorldObject {
  const file = paths(root).world.objectFile(slug);
  if (!existsSync(file)) throw new Error(`对象不存在: ${slug}`);
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  return toWorldObject(slug, data, file);
}

export function readPendingObject(root: string, slug: string): WorldObject {
  const file = paths(root).world.pendingFile(slug);
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

function readDirObjects(dir: string): WorldObject[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const { data } = parseFrontmatter(readFileSync(`${dir}/${f}`, "utf8"));
      return toWorldObject(slug, data, `${dir}/${f}`);
    });
}

/** 已采用对象(world/objects/)。 */
export function listObjects(root: string): WorldObject[] {
  return readDirObjects(paths(root).world.objects);
}

/** 待处理候选(world/pending/, suggestion queue = pending 目录)。 */
export function listPending(root: string): WorldObject[] {
  return readDirObjects(paths(root).world.pending);
}

/** 标签派生(N13): 读对象 tags, 无独立标签文件。 */
export function listTags(root: string): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const o of listObjects(root)) {
    for (const t of o.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

/** 创建对象(已采用, status canonical 由作者显式; 文件即提交)。 */
export function createObject(
  root: string,
  input: { name: string; entityType: string; aliases?: string[]; tags?: string[]; description?: string },
): string {
  if (!input.name.trim()) throw new Error("name 必填");
  const slug = slugify(`obj-${input.name}`) || `obj-${Date.now()}`;
  const file = paths(root).world.objectFile(slug);
  if (existsSync(file)) throw new Error(`对象已存在: ${slug}`);
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
  writeFileSync(file, lines.join("\n") + `# ${input.name}\n\n${input.description ?? ""}\n`, "utf8");
  gitAdd(root);
  gitCommit(root, `world: create ${slug}`);
  return slug;
}

/** 更新对象 frontmatter(仅允许确定性字段; status 迁移走 store adopt, 不经此函数)。 */
export function updateObject(
  root: string,
  slug: string,
  patch: { name?: string; description?: string; tags?: string[] },
): void {
  const obj = readObject(root, slug);
  const { data, body } = (() => {
    const raw = readFileSync(obj.file, "utf8");
    const parsed = parseFrontmatter(raw);
    return { data: parsed.data, body: raw.slice(raw.indexOf("\n---\n", raw.indexOf("---\n") + 4) + 5) };
  })();
  const next = { ...data };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.tags !== undefined) next.tags = patch.tags;
  // N23/M7-C: 合并 patch 后的 fm 落盘前同样校验; 缺 id 等必填 → fail-closed 不写(无部分状态)。
  const issues = validateFrontmatter("object", next);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `object frontmatter 校验失败: ${detail}`, issues);
  }
  writeFileSync(obj.file, serializeFrontmatter(next, patch.description !== undefined ? patch.description : body), "utf8");
  gitAdd(root);
  gitCommit(root, `world: update ${slug}`);
}
