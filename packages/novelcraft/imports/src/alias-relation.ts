// imports · Phase 2b 别名/关系增量(imports.md「别名候选/关系候选」+ catalog §1.7 + N11/N14)。
// 别名只附着已有对象不建新对象(R1 精神); 关系写宿主对象 frontmatter relations: [] 为源(N11/N14),
// 有向对由 store 索引派生(N14: store/index.ts collectRelations 只索引 Array 形态 → 本文件写 list 形态)。
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

/** 对象 relations 有向对(N14 list 形态; source=宿主对象文件本身, 不落 source 字段)。 */
interface RelationRow {
  target: string;
  type: string;
  status?: string;
  description?: string;
}

/** 关系 create-or-merge(imports.md: 同向同型去重, 已采用边不自动覆盖; N14 去重键 (target,type))。 */
function upsertRelations(existing: RelationRow[], next: RelationRow[]): { rows: RelationRow[]; added: number } {
  const rows = [...existing];
  let added = 0;
  for (const n of next) {
    const dup = rows.some((r) => r.target === n.target && r.type === n.type);
    if (!dup) {
      rows.push(n);
      added += 1;
    }
  }
  return { rows, added };
}

/** 读对象 relations: list 形态为主(N14); legacy 字符串形态(旧 vault "source -> target (type): desc")解析兜底。 */
function readRelations(fm: Record<string, unknown>): RelationRow[] {
  if (Array.isArray(fm.relations)) {
    return (fm.relations as unknown[])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
      .map((r) => ({
        target: String(r.target ?? ""),
        type: String(r.type ?? ""),
        ...(typeof r.status === "string" ? { status: r.status } : {}),
        ...(typeof r.description === "string" ? { description: r.description } : {}),
      }))
      .filter((r) => r.target !== "" && r.type !== "");
  }
  if (typeof fm.relations === "string") {
    const out: RelationRow[] = [];
    for (const line of fm.relations.split("\n")) {
      const m = line.match(/^(.+?) -> (.+?) \((.+?)\)(?:: (.*))?$/);
      if (!m) continue;
      out.push({ target: m[2].trim(), type: m[3].trim(), ...(m[4]?.trim() ? { description: m[4].trim() } : {}) });
    }
    return out;
  }
  return [];
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
      // 铁律5: LLM 产出默认候选(status: candidate), 作者显式确认后才 canonical。
      const { rows, added } = upsertRelations(readRelations(srcFm), [
        {
          target,
          type,
          status: "candidate",
          ...(typeof rel.description === "string" ? { description: rel.description } : {}),
        },
      ]);
      if (added > 0) {
        writeFileSync(
          file,
          serializeFrontmatter({ ...srcFm, relations: rows }, body),
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
