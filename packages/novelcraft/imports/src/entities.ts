// imports · Phase 2a 实体候选(imports.md「实体候选与去重」+ catalog §1.6)。
// 规则: 批内 entity_key 去重(R21)、同名同型 canonical 复用(R23, ≥0.88 高置信)、
// 候选只写 world/pending/、不自动覆盖已采用。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import { dedupeByEntityKey, normalizeEntityType, findExactEntity, gitAdd, gitCommit, parseFrontmatter } from "@novelcraft/store";
import { assertImportWorkspaceClean } from "./workspace.js";
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
  // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
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

/** Phase 2a 实体候选计划文件(N33 durable driver 用; 纯计划, 不落盘)。 */
export interface EntityPlannedFile {
  readonly relativePath: string;
  readonly bytes: string;
}

/** 纯计划 seam(N33/ADR-0022): 只读快照 + LLM + 内存计算候选写集, 零文件写。 */
export interface EntityPlanResult {
  readonly files: readonly EntityPlannedFile[];
  readonly created: string[];
  readonly reused: Array<{ name: string; target: string }>;
  readonly uncertain: number;
}

/**
 * Phase 2a 纯计划(零写入; durable driver 的 generator seam): 逐 Scene 抽取 → 批内去重
 * → 同名同型 canonical 复用 → 在内存生成候选文件字节(world/pending/<slug>.md)。
 * 语义与 extractEntityBatch 完全一致(去重/复用/降级), 只是不落盘、不 git commit。
 * opts.budget(审查项 3, 加法): 工作流累计预算 tracker(见 extractEntityBatch)。
 */
export async function planEntityBatch(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string; minReuseConfidence?: number; budget?: WorkflowBudget; serialStart?: number } = {},
): Promise<EntityPlanResult> {
  // R17: 写前范围外脏工作区拒绝(imports 自身工件除外), 先于任何 LLM 调用。
  assertImportWorkspaceClean(root);
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
    const r = await runStep(provider, { specRef: "entity_extraction", input: `【Scene ${slug}】\n${texts}` }, { budget: opts.budget });
    if (!r.ok) {
      uncertain += 1; // 降级: 不丢对象, 只记失败(上层可重试)
      continue;
    }
    const parsed = r.result as { entities?: Array<Record<string, unknown>> };
    for (const e of parsed.entities ?? []) {
      const draft: EntityDraft = {
        name: String(e.name ?? ""),
        // M12-b review P1-2/N44 追记: object schema kind 已收紧为 ENTITY_TYPES 枚举,
        // LLM 原始类型经 normalizeEntityType 归一(白名单外回落 'object'), 原始值进
        // evidence 注记不丢失 —— 否则 deep-import 候选永远无法通过 adopt 校验。
        ...((): { entity_type: string; kind: string; note?: string } => {
          const raw = String(e.entity_type ?? "object");
          const normalized = normalizeEntityType(raw) ?? "object";
          return normalized === raw
            ? { entity_type: normalized, kind: normalized }
            : { entity_type: normalized, kind: normalized, note: `entity_type 归一: ${raw} → ${normalized}(不在 20 类白名单)` };
        })(),
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
  let serial = opts.serialStart ?? 0;
  const files: EntityPlannedFile[] = [];

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
    files.push({
      relativePath: `world/pending/${slug}.md`,
      bytes: fmLines.join("\n") + `# ${d.name}\n\n${d.description ?? ""}\n`,
    });
    created.push(slug);
  }
  return { files, created, reused, uncertain };
}

/** Phase 2a: 逐 Scene 抽取 → 批内去重 → 同名同型 canonical 复用 → 候选落 pending。
 *  opts.budget(审查项 3, 加法): 工作流累计预算 tracker —— 编排(runDeepImport)启动时
 *  按 ExecutionProfile.workflowBudget 创建一次, 逐 runStep 共享消费; 超支在 provider
 *  前 fail-closed(现有 RunStep budget API)。 */
export async function extractEntityBatch(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string; minReuseConfidence?: number; budget?: WorkflowBudget; serialStart?: number } = {},
): Promise<EntityBatchResult> {
  const plan = await planEntityBatch(provider, root, sceneSlugs, opts);
  const created: string[] = [];
  for (const f of plan.files) {
    writeFileSync(path.join(root, f.relativePath), f.bytes, "utf8");
    created.push(f.relativePath.slice("world/pending/".length, -".md".length));
  }

  if (created.length > 0) {
    // gitAdd 只传本批精确相对 POSIX pathspec(world/pending/<slug>.md, 含新增/覆盖修改),
    // 绝不 -A: 不捕获并发无关改动或用户预 staged 文件(与 commit/structure/alias-relation 同语义)。
    const relPaths = created.map((slug) => `world/pending/${slug}.md`);
    gitAdd(root, relPaths);
    gitCommit(root, `deep-import entities: +${created.length} candidates`);
  }
  return { created, reused: plan.reused, uncertain: plan.uncertain };
}
