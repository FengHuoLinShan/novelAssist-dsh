// imports · Phase 2b 别名/关系增量(imports.md「别名候选/关系候选」+ catalog §1.7 + N11)。
// 别名只附着已有对象不建新对象(R1 精神); 关系写目标对象 frontmatter relations: []。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter } from "@novelcraft/store";
import { registerImportSpecs } from "./specs-imports.js";
import { listCanonicalObjects } from "./entities.js";
import { readChapterText } from "./stages.js";

export interface AliasRelationResult {
  aliases_attached: number;
  aliases_skipped: number;
  relations_written: number;
  uncertain: number;
}

interface RelRow {
  source: string;
  target: string;
  type: string;
  description?: string;
}

/** 关系 create-or-merge(imports.md: 同向同型去重, 已采用边不自动覆盖)。 */
function upsertRelations(existing: RelRow[], next: RelRow[]): { rows: RelRow[]; added: number } {
  const rows = [...existing];
  let added = 0;
  for (const n of next) {
    const dup = rows.some((r) => r.source === n.source && r.target === n.target && r.type === n.type);
    if (!dup) {
      rows.push(n);
      added += 1;
    }
  }
  return { rows, added };
}

function relLines(rows: RelRow[]): string {
  return rows.map((r) => `${r.source} -> ${r.target} (${r.type})${r.description ? `: ${r.description}` : ""}`).join("\n");
}

function readRelations(fm: Record<string, unknown>): RelRow[] {
  const raw = typeof fm.relations === "string" ? fm.relations : "";
  return relLinesParse(raw);
}

function relLinesParse(text: string): RelRow[] {
  const out: RelRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?) -> (.+?) \((.+?)\)(?:: (.*))?$/);
    if (!m) continue;
    out.push({ source: m[1].trim(), target: m[2].trim(), type: m[3].trim(), description: m[4]?.trim() });
  }
  return out;
}

/** Phase 2b: 别名附着(canonical 目标才落; 否则 skipped 进待复核)+ 关系 create-or-merge。 */
export async function aliasRelationBatch(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string } = {},
): Promise<AliasRelationResult> {
  registerImportSpecs();
  const byName = new Map(listCanonicalObjects(root).map((o) => [o.name, o.slug]));
  const result: AliasRelationResult = { aliases_attached: 0, aliases_skipped: 0, relations_written: 0, uncertain: 0 };
  const touched: Set<string> = new Set();

  for (const slug of sceneSlugs) {
    const sceneFile = paths(root).scenes.sceneFile(slug);
    if (!existsSync(sceneFile)) continue;
    const { data: fm } = parseFrontmatter(readFileSync(sceneFile, "utf8"));
    const texts = ((fm.chapter_ids as number[]) ?? []).map((ch) => readChapterText(root, ch)).join("\n\n");
    const r = await runStep(provider, { specRef: "alias_relation", input: `【Scene ${slug}】\n${texts}` });
    if (!r.ok) {
      result.uncertain += 1;
      continue;
    }
    const parsed = r.result as {
      aliases?: Array<Record<string, unknown>>;
      relations?: Array<Record<string, unknown>>;
    };

    for (const a of parsed.aliases ?? []) {
      const ref = String(a.entity_ref ?? "");
      const alias = String(a.alias ?? "");
      const target = byName.get(ref);
      if (!alias || !target) {
        result.aliases_skipped += 1;
        continue;
      }
      const file = paths(root).world.objectFile(target);
      const { data: tgtFm, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const aliases: string[] = Array.isArray(tgtFm.aliases) ? tgtFm.aliases.map(String) : [];
      if (!aliases.includes(alias)) {
        aliases.push(alias);
        writeFileSync(file, serializeFrontmatter({ ...tgtFm, aliases }, body), "utf8");
        result.aliases_attached += 1;
        touched.add(target);
      }
    }

    for (const rel of parsed.relations ?? []) {
      const source = byName.get(String(rel.source_ref ?? ""));
      const target = byName.get(String(rel.target_ref ?? ""));
      const type = String(rel.relation_type ?? "");
      if (!source || !target || !type) continue;
      const file = paths(root).world.objectFile(source);
      const { data: srcFm, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const { rows, added } = upsertRelations(readRelations(srcFm), [
        { source, target, type, description: typeof rel.description === "string" ? rel.description : undefined },
      ]);
      if (added > 0) {
        writeFileSync(
          file,
          serializeFrontmatter({ ...srcFm, relations: relLines(rows) }, body),
          "utf8",
        );
        result.relations_written += added;
        touched.add(source);
      }
    }
  }

  if (touched.size > 0) {
    gitAdd(root);
    gitCommit(root, `deep-import alias/relation: ${result.aliases_attached} aliases, ${result.relations_written} relations`);
  }
  return result;
}
