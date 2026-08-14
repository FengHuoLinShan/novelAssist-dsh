// world · 对象/别名/关系/待处理读面与 CRUD(薄封装 store, R5 确定性核心)。
// 依据: specs/assets/world.md + store-rules; 知识标签 = 对象 frontmatter tags 派生(N13)。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths, slugify } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter } from "@novelcraft/store";

export interface WorldObject {
  slug: string;
  name: string;
  entity_type: string;
  status: string;
  aliases: string[];
  tags: string[];
  relations?: string;
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
    entity_type: String(data.entity_type ?? data.kind ?? ""),
    status: String(data.status ?? ""),
    aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    relations: typeof data.relations === "string" ? data.relations : undefined,
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
  const lines = [
    "---",
    `name: ${JSON.stringify(input.name.trim())}`,
    `entity_type: ${JSON.stringify(input.entityType || "object")}`,
    "status: canonical",
  ];
  if (input.aliases?.length) lines.push(`aliases: [${input.aliases.map((a) => JSON.stringify(a)).join(", ")}]`);
  if (input.tags?.length) lines.push(`tags: [${input.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
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
  writeFileSync(obj.file, serializeFrontmatter(next, patch.description !== undefined ? patch.description : body), "utf8");
  gitAdd(root);
  gitCommit(root, `world: update ${slug}`);
}
