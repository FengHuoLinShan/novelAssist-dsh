// imports · Phase 3 结构分析 + 结构去重(imports.md「结构去重建议」+ catalog §1.8)。
// N31(用户裁定): ≥0.96 自动落 draft 待采用(applyThreshold 过滤语义不变, 低置信只报告);
// canonical 升格走 novelcraft_store_adopt 审批门(铁律3, fail-closed), 不再直置 canonical。
// 批量安全(已证实覆盖修复): 整批预计算+frontmatter 校验+冲突检查先于任何 write;
// 同标题 slug 已存在(canonical/draft 等一律)绝不覆盖 —— 同 workflow 内容完全相同
// → 幂等 skip, 否则 fail-closed StoreError; 写前范围外脏工作区 → DIRTY_WORKSPACE(R17);
// gitAdd 只传本批精确相对文件。StructureResult 公共字段不变, skipped 为可选加法。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths, slugify } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import { assertValidRelations, gitAdd, gitCommit, StoreError, validateFrontmatter } from "@novelcraft/store";
import { assertImportWorkspaceClean } from "./workspace.js";

export interface StructureResult {
  threads: string[];
  arcs: string[];
  foreshadowing: string[];
  reveals: string[];
  low_confidence: number;
  /** 幂等 skip 的结构资产 slug(同 workflow 且内容完全相同, 未写文件); 可选加法。 */
  skipped?: string[];
}

interface StructItem {
  title: string;
  summary?: string;
  confidence?: number;
  [k: string]: unknown;
}

/** 目录键(复数)→ 结构资产 kind(ADR-0019 附录 A 源 kind)。 */
const DIR_KEY_TO_KIND: Record<string, "thread" | "arc" | "foreshadowing" | "reveal"> = {
  threads: "thread",
  arcs: "arc",
  foreshadowing: "foreshadowing",
  reveals: "reveal",
};

/** 目录键(复数)→ vault 相对目录(gitAdd 精确 pathspec; reveal 目录为单数)。 */
const REL_PREFIX: Record<string, string> = {
  threads: "structure/threads",
  arcs: "structure/arcs",
  foreshadowing: "structure/foreshadowing",
  reveals: "structure/reveal",
};

function applyThreshold(items: StructItem[], min = 0.96): { keep: StructItem[]; dropped: number } {
  const keep: StructItem[] = [];
  let dropped = 0;
  for (const it of items) {
    if (typeof it.confidence === "number" && it.confidence >= min) keep.push(it);
    else dropped += 1;
  }
  return { keep, dropped };
}

interface PlannedStruct {
  slug: string;
  /** 绝对目录(structure/threads 等) */
  dir: string;
  /** git 相对前缀(structure/threads) */
  relPrefix: string;
  kind: string;
  text: string;
}

/** 纯构建(无 fs 写): 确定性 slug + relations 校验 + final fm 校验(N23), 失败即抛。 */
function buildStructAsset(
  root: string,
  key: string,
  dir: string,
  title: string,
  item: StructItem,
  workflowId: string,
): PlannedStruct {
  // 确定性 slug(不再有 Date.now 兜底); slugify 失败即 fail-closed 抛出。
  const slug = slugify(`${key}-${title}`);
  const assetKind = DIR_KEY_TO_KIND[key] ?? "thread"; // threads→thread / arcs→arc / foreshadowing→foreshadowing / reveals→reveal
  // ADR-0019 P3(用户裁定): relations 写前硬错校验(自环/悬空/type 白名单/端点 kind)。
  if (Array.isArray(item.relations)) {
    assertValidRelations(root, assetKind, slug, item.relations);
  }
  const fm: Record<string, unknown> = {
    id: slug,
    title,
    status: "draft", // N31: ≥0.96 自动落 draft 待采用; canonical 升格走 novelcraft_store_adopt 审批门(铁律3)
    confidence: item.confidence ?? 0,
    workflow: workflowId,
  };
  // B3 必填补齐(frontmatter.ts:491-511): thread=name/thread_type, foreshadowing=name;
  // name 默认取 title, thread_type 自由字符串常见 main(specs/assets/outline.md:148)。
  if (key === "threads" || key === "foreshadowing") {
    fm.name = typeof item.name === "string" && item.name ? item.name : title;
  }
  if (key === "threads") {
    fm.thread_type = typeof item.thread_type === "string" && item.thread_type ? item.thread_type : "main";
  }
  if (item.summary) fm.summary = item.summary;
  // ADR-0019 P3: relations 有向对透传(新工作流写 relations, 不散写 related_*_ids)。
  // name/thread_type 已显式落列(见上), 其余(reveal 的 target_type/target_id/secret_summary 等)原样透传。
  const extra = Object.entries(item).filter(([k]) => !["title", "summary", "confidence", "name", "thread_type"].includes(k));
  for (const [k, v] of extra) {
    fm[k] = v;
  }
  // N23(用户裁定): 落盘前按资产 kind 校验最终 fm(必填/类型/状态机), 失败 fail-closed。
  const issues = validateFrontmatter(assetKind, fm);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `${assetKind} ${slug} frontmatter 校验失败: ${detail}`, issues);
  }
  const text =
    ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""].join("\n") +
    `# ${title}\n\n${item.summary ?? ""}\n`;
  return { slug, dir, relPrefix: REL_PREFIX[key] ?? `structure/${key}`, kind: assetKind, text };
}

/** Phase 3 结构资产计划文件(N33 durable driver 用; 纯计划, 不落盘)。 */
export interface StructurePlannedFile {
  readonly relativePath: string;
  readonly bytes: string;
}

/** 纯计划 seam(N33/ADR-0022): LLM + 内存计算结构资产写集, 零文件写。 */
export interface StructurePlanResult {
  readonly files: readonly StructurePlannedFile[];
  readonly result: StructureResult;
}

/**
 * Phase 3 纯计划(零写入; durable driver 的 generator seam): 单次结构分析 → 阈值过滤
 * (≥0.96)→ 整批预计算/校验/冲突检查 → 在内存生成结构资产文件字节。语义与
 * analyzeStructure 完全一致(覆盖保护/幂等 skip/fail-closed), 只是不落盘、不 commit。
 * opts.budget(审查项 3, 加法): 工作流累计预算 tracker(见 analyzeStructure)。
 */
export async function planStructureAnalysis(
  provider: Provider,
  root: string,
  opts: { workflowId: string; context?: string; budget?: WorkflowBudget },
): Promise<StructurePlanResult> {
  // R17: 写前范围外脏工作区拒绝(imports 自身工件除外), 先于任何 LLM 调用。
  assertImportWorkspaceClean(root);

  const r = await runStep(
    provider,
    {
      specRef: "structure_analysis",
      input: opts.context ?? "请基于已导入 Scene 与世界对象分析剧情结构。",
    },
    { budget: opts.budget },
  );
  const result: StructureResult = { threads: [], arcs: [], foreshadowing: [], reveals: [], low_confidence: 0, skipped: [] };
  if (!r.ok) return { files: [], result };

  const parsed = r.result as {
    threads?: StructItem[];
    arcs?: StructItem[];
    foreshadowing?: StructItem[];
    reveals?: StructItem[];
  };
  const p = paths(root).structure;
  const planned: PlannedStruct[] = [];
  const seenTargets = new Map<string, string>(); // 目标绝对路径 → 本批计划文本(批内同 slug 冲突检测)

  // === 整批预计算 + 校验 + 冲突检查(全部先于任何 write)。 ===
  for (const [key, dir, out] of [
    ["threads", p.threads, result.threads],
    ["arcs", p.arcs, result.arcs],
    ["foreshadowing", p.foreshadowing, result.foreshadowing],
    ["reveals", p.reveal, result.reveals],
  ] as const) {
    const items = parsed[key] ?? [];
    const { keep, dropped } = applyThreshold(items);
    result.low_confidence += dropped;
    for (const it of keep) {
      const title = String(it.title ?? "未命名");
      const built = buildStructAsset(root, key, dir, title, it, opts.workflowId);
      const target = `${built.dir}/${built.slug}.md`;
      const existingRaw = existsSync(target) ? readFileSync(target, "utf8") : null;
      const batchText = seenTargets.get(target);
      if (existingRaw === built.text || batchText === built.text) {
        // 同 workflow 且内容完全相同 → 幂等 skip(不写文件)。
        result.skipped!.push(built.slug);
        continue;
      }
      if (existingRaw !== null || batchText !== undefined) {
        // 目标已存在(canonical/draft 等一律)且内容不同 → fail-closed, 绝不覆盖。
        throw new StoreError(
          "CONFLICT",
          `结构资产 slug 已存在, 拒绝覆盖: ${built.relPrefix}/${built.slug}.md(同 workflow 且内容完全相同才幂等 skip)`,
        );
      }
      seenTargets.set(target, built.text);
      planned.push(built);
      out.push(built.slug);
    }
  }

  // === 计划输出(预计算/校验/冲突已全部通过; 零文件写)。 ===
  const files: StructurePlannedFile[] = planned.map((b) => ({
    relativePath: `${b.relPrefix}/${b.slug}.md`,
    bytes: b.text,
  }));
  return { files, result };
}

/**
 * Phase 3: 单次结构分析 → 阈值过滤(≥0.96)→ 整批预计算/校验/冲突检查 → 落 structure/ 目录
 * (N12; N31: 落 draft, 升格走 adopt 审批门)。
 * 覆盖保护: 同标题 slug 目标已存在且字节与本次一致(同 workflow 内容完全相同)→ 幂等 skip;
 * 其余一律 fail-closed StoreError, 绝不覆盖 canonical/draft。
 * opts.budget(审查项 3, 加法): 工作流累计预算 tracker —— 编排(runDeepImport)启动时
 * 按 ExecutionProfile.workflowBudget 创建一次, 逐 runStep 共享消费; 超支在 provider
 * 前 fail-closed(现有 RunStep budget API)。
 */
export async function analyzeStructure(
  provider: Provider,
  root: string,
  opts: { workflowId: string; context?: string; budget?: WorkflowBudget },
): Promise<StructureResult> {
  const { files, result } = await planStructureAnalysis(provider, root, opts);

  // === 写(预计算/校验/冲突已全部通过; gitAdd 只传本批精确相对文件)。 ===
  const relPaths: string[] = [];
  for (const f of files) {
    writeFileSync(path.join(root, f.relativePath), f.bytes, "utf8");
    relPaths.push(f.relativePath);
  }

  if (files.length > 0) {
    gitAdd(root, relPaths);
    gitCommit(root, `deep-import structure: ${result.threads.length} threads / ${result.arcs.length} arcs`);
  }
  return result;
}