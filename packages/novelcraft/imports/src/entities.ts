// imports · Phase 2a 实体候选(imports.md「实体候选与去重」+ catalog §1.6)。
// 规则: 批内 entity_key 去重(R21)、同名同型 canonical 复用(R23, ≥0.88 高置信)、
// 候选只写 world/pending/、不自动覆盖已采用。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { dedupeByEntityKey, findExactEntity, gitAdd, gitCommit, parseFrontmatter } from "@novelcraft/store";
import { registerImportSpecs } from "./specs-imports.js";
import { readChapterText } from "./stages.js";

export interface EntityDraft {
  name: string;
  entity_type: string;
  /** 兼容 store EntityCandidate 的 kind(entity_key 用) */
  kind: string;
  [k: string]: unknown;
  aliases?: string[];
  description?: string;
  evidence: string[];
  confidence: number;
}

export interface EntityBatchResult {
  created: string[];
  reused: Array<{ name: string; target: string }>;
  uncertain: number;
}

/** 读已采用对象索引(world/objects/*.md 的 name/kind/status)。 */
export function listCanonicalObjects(root: string): Array<{ slug: string; name: string; kind: string; status: string }> {
  const dir = paths(root).world.objects;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data } = parseFrontmatter(readFileSync(`${dir}/${f}`, "utf8"));
      return { slug: f.replace(/\.md$/, ""), name: String(data.name ?? ""), kind: String(data.kind ?? data.entity_type ?? ""), status: String(data.status ?? "") };
    });
}

function slugifyName(name: string, i: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `obj-${base || "entity"}-${i}`;
}

/** Phase 2a: 逐 Scene 抽取 → 批内去重 → 同名同型 canonical 复用 → 候选落 pending。 */
export async function extractEntityBatch(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string; minReuseConfidence?: number } = {},
): Promise<EntityBatchResult> {
  registerImportSpecs();
  const existing = listCanonicalObjects(root);
  const drafts: EntityDraft[] = [];
  let uncertain = 0;

  for (const slug of sceneSlugs) {
    const file = paths(root).scenes.sceneFile(slug);
    if (!existsSync(file)) throw new Error(`Scene 不存在: ${slug}`);
    const raw = readFileSync(file, "utf8");
    const { data: fm } = parseFrontmatter(raw);
    const chapters = (fm.chapter_ids as number[]) ?? [];
    const texts = chapters.map((ch) => readChapterText(root, ch)).join("\n\n");
    const r = await runStep(provider, { specRef: "entity_extraction", input: `【Scene ${slug}】\n${texts}` });
    if (!r.ok) {
      uncertain += 1; // 降级: 不丢对象, 只记失败(上层可重试)
      continue;
    }
    const parsed = r.result as { entities?: Array<Record<string, unknown>> };
    for (const e of parsed.entities ?? []) {
      const draft: EntityDraft = {
        name: String(e.name ?? ""),
        entity_type: String(e.entity_type ?? "object"),
        kind: String(e.entity_type ?? "object"),
        aliases: Array.isArray(e.aliases) ? e.aliases.map(String) : undefined,
        description: typeof e.description === "string" ? e.description : undefined,
        evidence: Array.isArray(e.evidence) ? e.evidence.map(String) : [],
        confidence: typeof e.confidence === "number" ? e.confidence : 0,
      };
      if (!draft.name) continue;
      drafts.push(draft);
    }
  }

  const unique = dedupeByEntityKey(drafts); // R21
  const created: string[] = [];
  const reused: EntityBatchResult["reused"] = [];
  let serial = 0;

  for (const d of unique) {
    const exact = findExactEntity(existing, String(d.entity_type), String(d.name));
    const minReuse = opts.minReuseConfidence ?? 0.88; // imports.md 0.88 阈值
    if (exact && d.confidence >= minReuse) {
      reused.push({ name: d.name, target: exact.slug });
      continue;
    }
    const slug = slugifyName(d.name, serial++);
    const fmLines = [
      "---",
      // N23(用户裁定): pending/object schema required 含 id; id=落盘 slug, 与文件名同源确定性(N2)。
      `id: ${JSON.stringify(slug)}`,
      `name: ${JSON.stringify(d.name)}`,
      `kind: ${JSON.stringify(d.kind)}`, // B1(用户裁定): 写面统一 kind, 不再写 entity_type
      "status: candidate",
      `confidence: ${d.confidence}`,
      `evidence: [${d.evidence.map((x) => JSON.stringify(x)).join(", ")}]`,
    ];
    if (d.aliases?.length) fmLines.push(`aliases: [${d.aliases.map((a) => JSON.stringify(a)).join(", ")}]`);
    if (d.description) fmLines.push(`description: ${JSON.stringify(d.description)}`);
    if (opts.workflowId) fmLines.push(`workflow: ${JSON.stringify(opts.workflowId)}`);
    fmLines.push("---", "");
    writeFileSync(paths(root).world.pendingFile(slug), fmLines.join("\n") + `# ${d.name}\n\n${d.description ?? ""}\n`, "utf8");
    created.push(slug);
  }

  if (created.length > 0) {
    gitAdd(root);
    gitCommit(root, `deep-import entities: +${created.length} candidates`);
  }
  return { created, reused, uncertain };
}
