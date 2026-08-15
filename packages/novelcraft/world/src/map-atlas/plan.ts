// world/map-atlas · AtlasPlan 生成/校验/run 编排(Phase 3; catalog §4.11; 计划 §4 Phase 3; §5 规则 1-3)。
// LLM 仅产出规划 JSON(map_atlas_plan); 8 条结构规则 + 来源白名单 + update 约束全部确定性校验。
// 移植: 旧引擎 workflow.py _plan_prompt(68-110)/_validate_plan_sources(934-981)/_plan_semantic_keys(982-1007)/
//       _validate_update_targets(1008-1046)/_changed_update_targets/_new_source_identities(1047-1106);
//       schemas.py AtlasPlan.validate_hierarchy(182-230)。
import { createHash } from "node:crypto";
import { registerSpec, runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { compileAtlasContext } from "./context.js";
import { readAtlasTree, latestAtlasRun } from "./read.js";
import { extractSpatialFacts, registerMapAtlasSpecsOnce } from "./spatial.js";
import {
  ATLAS_LEVEL_RANK,
  type AtlasContextResult,
  type AtlasLevel,
  type AtlasNode,
  type AtlasPage,
  type AtlasPlan,
  type AtlasPlanNode,
  type AtlasRun,
  type AtlasRunOptions,
  type AtlasTree,
  type RunKind,
  type SourceRef,
  type SpatialEvidence,
} from "./types.js";
import { computeAtlasPageContentHash, writeAtlasCandidates, writeAtlasRun } from "./write.js";

/** 计划/catalog §4.11 上限与口径。 */
export const ATLAS_PLAN_MAX_NODES = 20;
export const ATLAS_PLAN_MAX_ANNOTATIONS_PER_NODE = 100;
export const ATLAS_PLAN_MAX_SOURCES_PER_NODE = 50;
export const ATLAS_PLAN_STYLE_BRIEF_MAX = 4000;
export const ATLAS_PLAN_TITLE_MAX = 255;
export const ATLAS_PLAN_SUMMARY_MAX = 2000;
export const ATLAS_PLAN_VISUAL_BRIEF_MAX = 6000;

/** plan_key 模式(M4 收紧为 [a-z0-9_-]; 旧引擎 `^[a-z0-9][a-z0-9._:-]*$` 另允许 . :——收紧是有意的)。 */
export const ATLAS_PLAN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** M4 正式来源状态(旧 _FORMAL_SOURCE_STATUSES={canonical,confirmed,published}; M4 bible 状态机只有 canonical)。 */
export const ATLAS_FORMAL_SOURCE_STATUSES = new Set(["canonical"]);

let planSpecRegistered = false;

/** AtlasPlan 输出 schema(catalog §4.11 精简 JSON schema; spec 注册与 prompt 注入共享同一对象, M2)。 */
export const ATLAS_PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    style_brief: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          plan_key: { type: "string" },
          parent_plan_key: { type: "string" },
          existing_parent_node_id: { type: "string" },
          location_ref: { type: "string" },
          title: { type: "string" },
          level: { type: "string" },
          summary: { type: "string" },
          visual_brief: { type: "string" },
          prompt: { type: "string" },
          evidence: {
            type: "object",
            properties: {
              supported: { type: "array", items: { type: "string" } },
              visual_fill: { type: "array", items: { type: "string" } },
              conflicts: { type: "array", items: { type: "string" } },
            },
            additionalProperties: true,
          },
          sources: { type: "array", items: { type: "object", additionalProperties: true } },
          annotations: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["plan_key", "title", "level", "summary", "visual_brief", "prompt"],
        additionalProperties: true,
      },
    },
  },
  required: ["style_brief", "nodes"],
  additionalProperties: true,
};

/** map_atlas_plan spec 注册(幂等; catalog §4.11: temp 0 / 输出 max_tokens 4000 / 工具级 timeout 3600s)。
 *  budgetTokens=0(N27 输入主导豁免): llm-step budgetTokens 是输入预算上限(step.ts checkBudget),
 *  本 spec 输入含 ≤20 地点 × ≤8000 字证据, 必超 4000; catalog 的 max_tokens 4000 是输出口径。 */
export function registerAtlasPlanSpecOnce(): void {
  if (planSpecRegistered) return;
  try {
    registerSpec({
      specRef: "map_atlas_plan",
      description: "地图册层级规划(canonical 资料 → ≤20 页 AtlasPlan JSON; catalog §4.11; M4 不生图)",
      inputNotes: "上下文 packets + 空间事实 + 已有地图册 + 来源清单 + 可更新目标 + 风格要求",
      outputSchema: ATLAS_PLAN_OUTPUT_SCHEMA,
      budgetTokens: 0,
      temperature: 0,
      timeoutMs: 3_600_000, // 工具级 3600s(deep_import 同构; catalog §4.11)。
      degradationNote: "校验失败 fail-closed: run=failed + error_code, 不产出 adopted 资产; prompt_only 候选不可 adopt(N28)。",
      contractVersion: "v1",
    });
  } catch {
    // 已注册则忽略(幂等)。
  }
  planSpecRegistered = true;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 旧 _semantic_part 逐字口径: sha256(title 去空白 + 小写)前 20 hex(计划 §2.1 path 段 {hash})。 */
export function semanticPart(value: string): string {
  return sha256Hex(value.replace(/\s+/g, "").toLowerCase()).slice(0, 20);
}

// ============================================================================
// 规划 prompt(旧 _plan_prompt 全文移植, M4 字段名)
// ============================================================================

export interface BuildPlanPromptInput {
  context: string;
  schema: Record<string, unknown>;
  styleNote?: string;
  includeInteriors: boolean;
  priorAtlas: AtlasPriorNode[];
  sourceManifest: SourceRef[];
  runKind: RunKind;
  allowedUpdateTargets?: { missing_locations?: string[]; changed_semantic_keys?: string[] };
}

/** 旧 _plan_prompt 中文化移植(规则 8 条逐字对齐; update 模式换行话术)。 */
export function buildAtlasPlanPrompt(input: BuildPlanPromptInput): string {
  const updateRule =
    input.runKind === "initial" || input.runKind === "rebuild"
      ? "这是完整重做，重新规划全部必要页面。"
      : "这是补全/更新：只规划缺失地点，或资料来源已经变化的地点。";
  return `你是小说作者的地图册规划助手。请只输出符合 JSON Schema 的对象。

目标：规划一套逐页由作者上传本地图片、可从父图进入子图的小说地图册。
规则：
- 最多 20 页，父级必须先于子级；默认最深到街道。
- 更新已有地点的子图时，用 existing_parent_node_id 引用已有父节点。
- 不要为资料没有变化的父图生成新页。
- 室内图：${input.includeInteriors ? "允许" : "不允许"}。
- ${updateRule}
- 每页必须把资料分成 supported、visual_fill、conflicts；视觉补全不是正式设定。
- source_status=working 的工作稿不属于正式设定，不得单独支持 supported。
- 此类内容必须放入 visual_fill 或 conflicts 并明确标注。
- annotations 只用于地点或地标名称；不得生成层级、方向、距离、比例或图例标注。
- 来源必须来自下方资料，不得伪造 open_target。
- open_target 如存在，其资料 ID 必须出现在允许来源清单中。
- 地点完整名称必须出现在 visual_brief 中作为语义锚点。
- prompt 字段是给作者的外部生图参考文本（本系统不生成图片）。

作者风格要求：${input.styleNote || "无额外要求"}
已有地图册：${JSON.stringify(input.priorAtlas)}
服务端判定的可更新目标：${JSON.stringify(input.allowedUpdateTargets ?? {})}
允许来源清单：${JSON.stringify(groupManifest(input.sourceManifest))}
JSON Schema：${JSON.stringify(input.schema)}

作者资料（其中标记 working 的内容仅作非正式参考）：
${input.context}
`;
}

/** manifest 按 source_type 分组(旧 _manifest_lookup 展示形态)。 */
function groupManifest(manifest: SourceRef[]): Record<string, SourceRef[]> {
  const grouped: Record<string, SourceRef[]> = {};
  for (const m of manifest) {
    (grouped[m.source_type ?? "unknown"] ??= []).push(m);
  }
  return grouped;
}

// ============================================================================
// 已有地图册视图(update diff 输入)
// ============================================================================

/** 已有地图册节点视图(update 校验输入; sources 来自该节点已采用页面的合并)。 */
export interface AtlasPriorNode {
  node_id: string;
  semantic_key: string;
  level: AtlasLevel;
  title: string;
  location_ref: string | null;
  sources: SourceRef[];
}

/** 从 atlas 树构建 prior 视图: nodes/ 目录节点(adopted+暂存)+ 其 adopted pages 的 sources 合并。 */
export function buildPriorAtlas(tree: AtlasTree): AtlasPriorNode[] {
  const pagesByNode = new Map<string, SourceRef[]>();
  for (const page of tree.pages) {
    if (page.review_status !== "adopted") continue;
    const list = pagesByNode.get(page.node_ref) ?? [];
    for (const s of page.source_manifest ?? []) list.push(s);
    pagesByNode.set(page.node_ref, list);
  }
  return tree.nodes.map((n) => ({
    node_id: n.id,
    semantic_key: n.semantic_key,
    level: n.level,
    title: n.title,
    location_ref: n.location_ref,
    sources: pagesByNode.get(n.id) ?? [],
  }));
}

// ============================================================================
// 结构校验(旧 AtlasPlan.validate_hierarchy 8 条; ⑦为 M4 翻转口径: 父 rank 严格大于子)
// ============================================================================

/** 结构规则校验(§5 规则 1-3); 返回问题清单(空 = 通过)。 */
export function validateAtlasPlanStructure(plan: AtlasPlan): string[] {
  const issues: string[] = [];
  if (typeof plan.style_brief !== "string" || plan.style_brief.trim().length === 0) {
    issues.push("style_brief 必填");
  } else if (plan.style_brief.length > ATLAS_PLAN_STYLE_BRIEF_MAX) {
    issues.push(`style_brief 超长(>${ATLAS_PLAN_STYLE_BRIEF_MAX})`);
  }
  if (!Array.isArray(plan.nodes)) {
    issues.push("nodes 必须是数组");
    return issues;
  }
  if (plan.nodes.length > ATLAS_PLAN_MAX_NODES) {
    issues.push(`地图册页数超过上限 ${ATLAS_PLAN_MAX_NODES}(规则 1)`);
  }

  // ①location 唯一。
  const locationRefs = plan.nodes.map((n) => n.location_ref).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (new Set(locationRefs).size !== locationRefs.length) {
    issues.push("atlas locations must be unique(规则 2: location 唯一)");
  }
  // ②plan_key 唯一 + 模式。
  const allKeys = plan.nodes.map((n) => n.plan_key);
  if (new Set(allKeys).size !== allKeys.length) {
    issues.push("atlas plan keys must be unique");
  }
  const keySet = new Set(allKeys);
  for (const n of plan.nodes) {
    if (typeof n.plan_key !== "string" || !ATLAS_PLAN_KEY_PATTERN.test(n.plan_key)) {
      issues.push(`plan_key 非法: ${JSON.stringify(n.plan_key)}(模式 ${ATLAS_PLAN_KEY_PATTERN})`);
    }
  }

  const seen = new Set<string>();
  const levels = new Map<string, AtlasLevel>();
  for (const node of plan.nodes) {
    const tag = `节点 ${node.plan_key}`;
    if (typeof node.title !== "string" || node.title.trim().length === 0 || node.title.length > ATLAS_PLAN_TITLE_MAX) {
      issues.push(`${tag}: title 必填且 ≤${ATLAS_PLAN_TITLE_MAX}`);
    }
    if (typeof node.summary !== "string" || node.summary.trim().length === 0 || node.summary.length > ATLAS_PLAN_SUMMARY_MAX) {
      issues.push(`${tag}: summary 必填且 ≤${ATLAS_PLAN_SUMMARY_MAX}`);
    }
    if (typeof node.visual_brief !== "string" || node.visual_brief.trim().length === 0 || node.visual_brief.length > ATLAS_PLAN_VISUAL_BRIEF_MAX) {
      issues.push(`${tag}: visual_brief 必填且 ≤${ATLAS_PLAN_VISUAL_BRIEF_MAX}`);
    }
    if (!(node.level in ATLAS_LEVEL_RANK)) {
      issues.push(`${tag}: level 非法: ${JSON.stringify(node.level)}`);
      seen.add(node.plan_key);
      continue;
    }
    // ③supported 必须有 retained source(结构层; working 不独撑在 validatePlanSources)。
    if ((node.evidence?.supported?.length ?? 0) > 0 && (node.sources?.length ?? 0) === 0) {
      issues.push(`${tag}: supported atlas evidence requires a retained source`);
    }
    // ④双父互斥。
    if (node.parent_plan_key && node.existing_parent_node_id) {
      issues.push(`${tag}: atlas node cannot have both a planned and existing parent`);
    }
    // ⑤cover/world 必根。
    if ((node.level === "cover" || node.level === "world") && (node.parent_plan_key || node.existing_parent_node_id)) {
      issues.push(`${tag}: atlas cover and world nodes must be roots`);
    }
    // ⑥父必须先出现。
    if (node.parent_plan_key != null && !seen.has(node.parent_plan_key)) {
      issues.push(`${tag}: atlas parents must appear before their children(规则 1 父先子)`);
    }
    // ⑦父 rank 严格大于子(M4 翻转: cover=6…interior=0; 计划 §5 规则 1; 勿抄旧引擎方向)。
    if (node.parent_plan_key != null) {
      const parentLevel = levels.get(node.parent_plan_key);
      if (parentLevel && ATLAS_LEVEL_RANK[parentLevel] <= ATLAS_LEVEL_RANK[node.level]) {
        issues.push(`${tag}: atlas parent level must be strictly above its child(父 rank 严格大于子)`);
      }
    }
    // ⑧annotation target 必须在 plan 内。
    for (const ann of node.annotations ?? []) {
      if (ann.target_plan_key != null && !keySet.has(ann.target_plan_key)) {
        issues.push(`${tag}: annotation target is not part of the atlas plan(${ann.target_plan_key})`);
      }
    }
    if ((node.annotations?.length ?? 0) > ATLAS_PLAN_MAX_ANNOTATIONS_PER_NODE) {
      issues.push(`${tag}: annotations 超过 ${ATLAS_PLAN_MAX_ANNOTATIONS_PER_NODE}`);
    }
    if ((node.sources?.length ?? 0) > ATLAS_PLAN_MAX_SOURCES_PER_NODE) {
      issues.push(`${tag}: sources 超过 ${ATLAS_PLAN_MAX_SOURCES_PER_NODE}`);
    }
    seen.add(node.plan_key);
    levels.set(node.plan_key, node.level);
  }
  return issues;
}

// ============================================================================
// 来源校验(旧 _validate_plan_sources; manifest 白名单 + open_target 一致 + working 不独撑)
// ============================================================================

function sourceIdentityOf(s: SourceRef): string {
  return `${s.source_type ?? ""}:${s.source_id ?? ""}`;
}

/** 来源白名单校验; 通过后由 normalizePlanSources 回填 canonical 字段。 */
export function validatePlanSources(plan: AtlasPlan, manifest: SourceRef[]): string[] {
  const issues: string[] = [];
  const allowed = new Map(manifest.map((m) => [sourceIdentityOf(m), m]));
  for (const node of plan.nodes) {
    const tag = `节点 ${node.plan_key}`;
    const sources: SourceRef[] = [
      ...(node.sources ?? []),
      ...(node.annotations ?? [])
        .map((a) => a.source_ref)
        .filter((s): s is SourceRef => s != null),
    ];
    for (const source of sources) {
      if (!source.open_target || Object.keys(source.open_target).length === 0) {
        issues.push(`${tag}: atlas source must include an open target(${sourceIdentityOf(source)})`);
        continue;
      }
      const canonical = allowed.get(sourceIdentityOf(source));
      if (!canonical) {
        issues.push(`${tag}: atlas source reference was not in compiled context(${sourceIdentityOf(source)})`);
        continue;
      }
      const expected = canonical.open_target ?? {};
      const actual = source.open_target;
      const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
      for (const k of keys) {
        if (JSON.stringify(expected[k]) !== JSON.stringify(actual[k])) {
          issues.push(`${tag}: atlas source open target was not canonical(${sourceIdentityOf(source)} 字段 ${k})`);
          break;
        }
      }
    }
    // working 不能单独支撑 supported(M4 formal = canonical)。
    // 状态以 manifest canonical 回填为准(旧引擎先校验回填再判 formal; LLM 输出不带 source_status)。
    const formal = (node.sources ?? []).filter((s) => {
      const canonical = allowed.get(sourceIdentityOf(s));
      const status = String(canonical?.source_status ?? s.source_status ?? "").toLowerCase();
      return ATLAS_FORMAL_SOURCE_STATUSES.has(status);
    });
    if ((node.evidence?.supported?.length ?? 0) > 0 && formal.length === 0) {
      issues.push(`${tag}: working sources cannot be the sole formal support(规则 3)`);
    }
  }
  return issues;
}

/** 校验通过后回填 canonical title/summary/hash/status(旧 _validate_plan_sources 尾部行为)。 */
export function normalizePlanSources(plan: AtlasPlan, manifest: SourceRef[]): void {
  const allowed = new Map(manifest.map((m) => [sourceIdentityOf(m), m]));
  const backfill = (source: SourceRef): void => {
    const canonical = allowed.get(sourceIdentityOf(source));
    if (!canonical) return;
    source.title = canonical.title ?? source.source_id;
    source.summary = canonical.summary ?? "已保留资料";
    source.open_target = { ...(canonical.open_target ?? {}) };
    source.source_hash = canonical.source_hash;
    source.source_status = String(canonical.source_status ?? "").toLowerCase();
  };
  for (const node of plan.nodes) {
    for (const s of node.sources ?? []) backfill(s);
    for (const a of node.annotations ?? []) if (a.source_ref) backfill(a.source_ref);
  }
}

// ============================================================================
// 语义键(旧 _plan_semantic_keys; M4: entity:{location_slug} / path:{父语义}:{slug(title)})
// ============================================================================

export function computePlanSemanticKeys(
  plan: AtlasPlan,
  priorAtlas: AtlasPriorNode[],
): { keys: Record<string, string>; issues: string[] } {
  const issues: string[] = [];
  const existingById = new Map(priorAtlas.map((p) => [p.node_id, p.semantic_key]));
  const byPlanKey: Record<string, string> = {};
  for (const item of plan.nodes) {
    let parentSemantic: string | undefined;
    if (item.existing_parent_node_id) {
      parentSemantic = existingById.get(item.existing_parent_node_id);
      if (!parentSemantic) {
        issues.push(`节点 ${item.plan_key}: atlas existing parent was not in the current atlas(${item.existing_parent_node_id})`);
        continue;
      }
    } else {
      parentSemantic = item.parent_plan_key ? byPlanKey[item.parent_plan_key] : "root";
      if (!parentSemantic) {
        issues.push(`节点 ${item.plan_key}: 父 plan_key 未先于子级出现(${item.parent_plan_key})`);
        continue;
      }
    }
    byPlanKey[item.plan_key] = item.location_ref
      ? `entity:${item.location_ref}`
      : `path:${parentSemantic}:${semanticPart(item.title)}`;
  }
  return { keys: byPlanKey, issues };
}

// ============================================================================
// update 约束(旧 _validate_update_targets/_changed_update_targets/_new_source_identities)
// ============================================================================

/** changed = 来源 hash 变化的 semantic_key(含同 source 牵连节点)。 */
export function changedUpdateTargets(
  priorAtlas: AtlasPriorNode[],
  currentManifest: SourceRef[],
): { changedSemanticKeys: Set<string>; changedSourceIds: Set<string> } {
  const current = new Map(currentManifest.map((m) => [sourceIdentityOf(m), m]));
  const changedSemanticKeys = new Set<string>();
  const changedSourceIds = new Set<string>();
  const changedIdentities = new Set<string>();
  for (const item of priorAtlas) {
    for (const source of item.sources) {
      const identity = sourceIdentityOf(source);
      const cur = current.get(identity);
      if ((cur?.source_hash ?? undefined) !== (source.source_hash ?? undefined)) {
        changedSemanticKeys.add(item.semantic_key);
        if (source.source_id) changedSourceIds.add(source.source_id);
        changedIdentities.add(identity);
      }
    }
  }
  if (changedIdentities.size > 0) {
    for (const item of priorAtlas) {
      for (const source of item.sources) {
        if (changedIdentities.has(sourceIdentityOf(source))) {
          changedSemanticKeys.add(item.semantic_key);
        }
      }
    }
  }
  return { changedSemanticKeys, changedSourceIds };
}

/** new = 当前 manifest 中新增/hash 变/status 变的 formal(canonical) source。 */
export function newSourceIdentities(priorManifest: SourceRef[], currentManifest: SourceRef[]): Set<string> {
  const prior = new Map(priorManifest.map((m) => [sourceIdentityOf(m), m]));
  const out = new Set<string>();
  for (const cur of currentManifest) {
    if (!ATLAS_FORMAL_SOURCE_STATUSES.has(String(cur.source_status ?? "").toLowerCase())) continue;
    const prev = prior.get(sourceIdentityOf(cur));
    if (
      !prev ||
      prev.source_hash !== cur.source_hash ||
      String(prev.source_status ?? "").toLowerCase() !== String(cur.source_status ?? "").toLowerCase()
    ) {
      out.add(sourceIdentityOf(cur));
    }
  }
  return out;
}

export interface UpdateTargets {
  changedSemanticKeys: Set<string>;
  missingLocationSlugs: Set<string>;
  newSources: Set<string>;
}

/** update run 约束: 新 location 必须 missing; 新 path 节点必须有新 formal source; 已存在 semantic 必须 changed。 */
export function validateUpdateTargets(
  plan: AtlasPlan,
  priorAtlas: AtlasPriorNode[],
  targets: UpdateTargets,
): string[] {
  const issues: string[] = [];
  const priorBySemantic = new Map(priorAtlas.map((p) => [p.semantic_key, p]));
  const { keys, issues: keyIssues } = computePlanSemanticKeys(plan, priorAtlas);
  issues.push(...keyIssues);
  for (const item of plan.nodes) {
    const semanticKey = keys[item.plan_key];
    if (!semanticKey) continue; // 语义键问题已记录。
    if (!priorBySemantic.has(semanticKey)) {
      if (item.location_ref && !targets.missingLocationSlugs.has(item.location_ref)) {
        issues.push(`节点 ${item.plan_key}: atlas update attempted to add a non-missing location(${item.location_ref})`);
      }
      if (!item.location_ref) {
        const identities = (item.sources ?? [])
          .filter((s) => ATLAS_FORMAL_SOURCE_STATUSES.has(String(s.source_status ?? "").toLowerCase()))
          .map(sourceIdentityOf);
        if (!identities.some((id) => targets.newSources.has(id))) {
          issues.push(`节点 ${item.plan_key}: atlas update path nodes require a newly retained source`);
        }
      }
      continue;
    }
    if (!targets.changedSemanticKeys.has(semanticKey)) {
      issues.push(`节点 ${item.plan_key}: atlas update attempted to regenerate an unchanged existing node(${semanticKey})`);
    }
  }
  return issues;
}

/** 汇总校验(结构 + 来源 + update 约束); ok = issues 为空。 */
export function validateAtlasPlan(
  plan: AtlasPlan,
  manifest: SourceRef[],
  opts?: { priorAtlas?: AtlasPriorNode[]; updateTargets?: UpdateTargets },
): { ok: boolean; issues: string[] } {
  const issues = [
    ...validateAtlasPlanStructure(plan),
    ...validatePlanSources(plan, manifest),
  ];
  if (issues.length === 0) {
    // 对齐旧引擎顺序: 来源校验通过并回填 canonical 状态后, 再判 update 目标(formal 判定依赖回填)。
    normalizePlanSources(plan, manifest);
    if (opts?.updateTargets) {
      issues.push(...validateUpdateTargets(plan, opts.priorAtlas ?? [], opts.updateTargets));
    }
  }
  return { ok: issues.length === 0, issues };
}

// ============================================================================
// orchestrator(计划 Phase 3 步骤 1-7; deep_import 同步同构)
// ============================================================================

export interface PlanMapAtlasOptions {
  run_kind: RunKind;
  style_note?: string;
  include_working_drafts?: boolean;
  include_interiors?: boolean;
  full_rebuild?: boolean;
  /** 确定性测试注入; 缺省 run-<时间戳>。 */
  runId?: string;
  /** 空间事实续跑游标(默认 0)。 */
  startBatch?: number;
}

export interface PlanMapAtlasResult {
  run: AtlasRun;
  ctx: AtlasContextResult;
  spatial: SpatialEvidence | null;
  plan: AtlasPlan | null;
  issues: string[];
}

function newRun(id: string, opts: PlanMapAtlasOptions): AtlasRun {
  const options: AtlasRunOptions = {
    style_note: opts.style_note ?? "",
    include_working_drafts: opts.include_working_drafts === true,
    include_interiors: opts.include_interiors === true,
    full_rebuild: opts.full_rebuild === true,
  };
  return {
    schema_version: 1,
    id,
    run_kind: opts.run_kind,
    status: "planning",
    options,
    context_hash: "",
    source_manifest: [],
    spatial_evidence: {},
    atlas_plan: { style_brief: "", nodes: [] },
    planned_page_count: 0,
    checkpoint: "planning",
    error_code: null,
    error_message: null,
    journal: [],
    created_at: new Date().toISOString(),
  };
}

function failRun(run: AtlasRun, code: string, message: string, checkpoint: string): void {
  run.status = "failed";
  run.error_code = code;
  run.error_message = message;
  run.checkpoint = checkpoint;
}

// 候选页 content_hash 统一走 write.ts 的 computeAtlasPageContentHash(Phase 3/4 共享口径, 含 image 字段)。

/**
 * 地图册规划编排(计划 Phase 3):
 * planning run → compile context → spatial facts(checkpoint)→ LLM plan → validate →
 * materialize pending 候选(单 commit)→ review_ready run。失败路径 fail-closed, 零 adopted 写入。
 */
export async function planMapAtlas(
  root: string,
  provider: Provider,
  opts: PlanMapAtlasOptions,
): Promise<PlanMapAtlasResult> {
  registerMapAtlasSpecsOnce();
  registerAtlasPlanSpecOnce();
  const run = newRun(opts.runId ?? `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`, opts);
  const issues: string[] = [];
  writeAtlasRun(root, run); // 步骤 1: planning run 落盘(审计起点)。

  // 步骤 2: 上下文编译。
  const ctx = await compileAtlasContext(root, {
    include_working_drafts: opts.include_working_drafts,
    include_interiors: opts.include_interiors,
    style_note: opts.style_note,
  });
  run.context_hash = ctx.context_hash;
  run.source_manifest = ctx.source_manifest;
  if (ctx.insufficient_sources) {
    failRun(run, "insufficient_sources", ctx.message ?? "没有可核对的已采用地点。", "context");
    writeAtlasRun(root, run);
    return { run, ctx, spatial: null, plan: null, issues: [run.error_message ?? "insufficient_sources"] };
  }

  // 步骤 3: 空间事实(可续跑)。
  const spatial = await extractSpatialFacts(root, provider, ctx, {
    startBatch: opts.startBatch,
    excludeRunId: run.id, // 指纹复用跳过本轮 planning run。
  });
  run.spatial_evidence = spatial as unknown as Record<string, unknown>;
  run.journal = [...(spatial.journal ?? [])]; // L1: llm_step journal 落 run(spec map-atlas.md §2.3 必填)。
  run.checkpoint = "spatial";
  writeAtlasRun(root, run);
  if (spatial.all_batches_failed) {
    failRun(run, "all_batches_failed", spatial.message ?? "空间事实提取全部批次失败。", "spatial");
    writeAtlasRun(root, run);
    return { run, ctx, spatial, plan: null, issues: [run.error_message ?? "all_batches_failed"] };
  }

  // 步骤 4 前置: update 短路与可更新目标(规则: 无变化 → review_ready 空 plan, 不调 LLM)。
  const tree = readAtlasTree(root);
  const priorAtlas = buildPriorAtlas(tree);
  const isUpdate = opts.run_kind === "update" && !opts.full_rebuild;
  let updateTargets: UpdateTargets | undefined;
  if (isUpdate) {
    const missing = new Set(
      ctx.packets.map((p) => p.location_key).filter((slug) => !priorAtlas.some((n) => n.location_ref === slug)),
    );
    const { changedSemanticKeys } = changedUpdateTargets(priorAtlas, ctx.source_manifest);
    // H1(review): 排除本轮 planning run——否则 prevManifest 取到自身, newSources 恒空, update「新来源」维度失效。
    const prevManifest = latestAtlasRun(root, { excludeId: run.id })?.source_manifest ?? [];
    const newSources = newSourceIdentities(prevManifest, ctx.source_manifest);
    updateTargets = { changedSemanticKeys, missingLocationSlugs: missing, newSources };
    if (missing.size === 0 && changedSemanticKeys.size === 0 && newSources.size === 0) {
      run.atlas_plan = { style_brief: "无变化", nodes: [] };
      run.planned_page_count = 0;
      run.status = "review_ready";
      run.checkpoint = "review_ready";
      writeAtlasRun(root, run);
      return { run, ctx, spatial, plan: run.atlas_plan, issues: [] };
    }
  }

  // 步骤 4: LLM 规划。
  const spec = ATLAS_PLAN_OUTPUT_SCHEMA;
  const contextJson = JSON.stringify({
    packets: ctx.packets,
    spatial_facts: { supported: spatial.supported, visual_fill: spatial.visual_fill, conflicts: spatial.conflicts },
  });
  const prompt = buildAtlasPlanPrompt({
    context: contextJson,
    schema: spec,
    styleNote: opts.style_note,
    includeInteriors: opts.include_interiors === true,
    priorAtlas,
    sourceManifest: ctx.source_manifest,
    runKind: opts.run_kind,
    allowedUpdateTargets: updateTargets
      ? {
          missing_locations: [...updateTargets.missingLocationSlugs].sort(),
          changed_semantic_keys: [...updateTargets.changedSemanticKeys].sort(),
        }
      : undefined,
  });
  let step;
  try {
    step = await runStep(provider, { specRef: "map_atlas_plan", input: prompt });
  } catch (err) {
    step = null;
    issues.push(`runStep 抛出: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (step) run.journal = [...run.journal, { specRef: "map_atlas_plan", journal: step.journal, usage: step.usage, ok: step.ok }];
  if (!step || !step.ok || typeof step.result !== "object" || step.result === null) {
    failRun(run, "plan_generation_failed", step?.error?.message ?? issues[0] ?? "规划生成失败", "plan");
    writeAtlasRun(root, run);
    return { run, ctx, spatial, plan: null, issues: [...issues, run.error_message ?? "plan_generation_failed"] };
  }
  const plan = step.result as unknown as AtlasPlan;

  // 步骤 5: 校验(结构 8 条 + 来源白名单 + update 约束)——失败 fail-closed。
  const validation = validateAtlasPlan(plan, ctx.source_manifest, {
    priorAtlas,
    ...(isUpdate && updateTargets ? { updateTargets } : {}),
  });
  if (!validation.ok) {
    failRun(run, "plan_validation_failed", validation.issues.join("; "), "validate");
    writeAtlasRun(root, run);
    return { run, ctx, spatial, plan, issues: validation.issues };
  }
  normalizePlanSources(plan, ctx.source_manifest);
  const { keys: semanticKeys, issues: keyIssues } = computePlanSemanticKeys(plan, priorAtlas);
  if (keyIssues.length > 0) {
    failRun(run, "plan_validation_failed", keyIssues.join("; "), "validate");
    writeAtlasRun(root, run);
    return { run, ctx, spatial, plan, issues: keyIssues };
  }

  // 步骤 6: materialize 候选(单 commit; prompt_only 页不可 adopt, N28)。
  // keyIssues 为空保证 semanticKeys 覆盖全部 plan_key; 防御性 filter 兜底。
  const pendingNodes: AtlasNode[] = plan.nodes.flatMap((n, i) => {
    const semanticKey = semanticKeys[n.plan_key];
    if (!semanticKey) return [];
    return [
      {
        id: n.plan_key,
        parent_ref: n.existing_parent_node_id ?? (n.parent_plan_key ? n.parent_plan_key : null),
        location_ref: n.location_ref ?? null,
        semantic_key: semanticKey,
        level: n.level,
        title: n.title,
        summary: n.summary,
        status: "provisional" as const,
        sort_order: i,
      },
    ];
  });
  const pendingPages: AtlasPage[] = plan.nodes.map((n) => {
    const base: Omit<AtlasPage, "content_hash"> = {
      id: `pg-${n.plan_key}`,
      run_ref: run.id,
      node_ref: n.plan_key,
      generation_status: "prompt_only",
      review_status: "candidate",
      title: n.title,
      visual_brief: n.visual_brief,
      prompt: n.prompt,
      evidence: {
        supported: n.evidence?.supported ?? [],
        visual_fill: n.evidence?.visual_fill ?? [],
        conflicts: n.evidence?.conflicts ?? [],
      },
      source_manifest: n.sources ?? [],
      annotations: (n.annotations ?? []).map((a, ai) => ({
        id: `ann-${n.plan_key}-${ai}`,
        label: a.label,
        position_x: a.position_x,
        position_y: a.position_y,
        ...(a.target_plan_key ? { target_node_ref: a.target_plan_key } : {}),
        sort_order: ai,
      })),
      review_note: null,
      adopted_at: null,
      rejected_at: null,
      deprecated_at: null,
    };
    return { ...base, content_hash: computeAtlasPageContentHash(base) };
  });
  writeAtlasCandidates(root, pendingNodes, pendingPages, `atlas: plan ${run.id} candidates`);

  // 步骤 7: run review_ready 落盘。
  run.atlas_plan = plan;
  run.planned_page_count = plan.nodes.length;
  run.status = "review_ready";
  run.checkpoint = "review_ready";
  writeAtlasRun(root, run);
  return { run, ctx, spatial, plan, issues: [] };
}
