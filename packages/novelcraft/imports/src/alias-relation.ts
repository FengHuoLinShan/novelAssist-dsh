// imports · Phase 2b 别名/关系增量(imports.md「别名候选/关系候选」+ catalog §1.7 + N11/N14)。
// 别名只附着已有对象不建新对象(R1 精神); 关系写宿主对象 frontmatter relations: [] 为源(N11/N14),
// 有向对由 store 索引派生(N14: store/index.ts collectRelations 只索引 Array 形态 → 本文件写 list 形态)。
//
// 写面纪律(用户裁定/复核): 「只读 propose → 汇总实际变更 → approval → apply」。
// - proposeAliasRelations: 只调 provider 返回规范化建议, 不写任何文件;
// - planAliasRelationChanges: 跨批次聚合建议, 基于 canonical 对象快照在内存计算最终文件内容
//   (同对象跨批更新不丢前批、别名/关系去重、全部校验于首个 write 前 fail-closed);
//   复核: propose 的 byName 是 provider 前快照, 慢 LLM 期间 canonical 对象可能被删除/移出
//   canonical —— plan 构建时对每条建议的 alias 目标 + relation source/target 重新验证
//   「存在且 status=canonical」, 任一失效即 VALIDATION_FAILED 且零写(不产出 dangling relation);
// - applyAliasRelationChanges: 工作区 clean + touched 源原文 CAS + 非 touched 关系目标的
//   canonical 复查(approval 后)全部先于首个 write, 任一失败 CONFLICT 零写;
//   gitAdd 只加精确 touched 相对路径(不再 -A, 避免捕获并发用户编辑), 之后单次 commit;
// - aliasRelationBatch: 上述三步组合(公共返回兼容, 核心接口只做加法)。
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter, StoreError, validateFrontmatter } from "@novelcraft/store";
import { executeCanonicalWrite, type TransactionOptions } from "@novelcraft/store";
import { registerImportSpecs } from "./specs-imports.js";
import { listCanonicalObjects } from "./entities.js";
import { readChapterText } from "./stages.js";
import { assertImportWorkspaceClean } from "./workspace.js";

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

/** 规范化的一条别名建议(已解析到 canonical 目标 slug)。 */
export interface AliasSuggestion {
  /** 来源 Scene(审批摘要可溯源) */
  scene: string;
  entity_ref: string;
  alias: string;
  /** 解析到的 canonical 目标 slug(解析失败不进本列表, 计入 skipped) */
  target: string;
  confidence?: number;
}

/** 规范化的一条关系建议(已解析到 source/target canonical slug)。 */
export interface RelationSuggestion {
  scene: string;
  source_ref: string;
  target_ref: string;
  relation_type: string;
  description?: string;
  confidence?: number;
  source: string;
  target: string;
}

/** 一批 Scene 的只读 propose 结果(不写文件)。 */
export interface AliasRelationProposal {
  aliases: AliasSuggestion[];
  relations: RelationSuggestion[];
  /** entity_ref/alias 未命中 canonical 而被跳过的别名数 */
  skipped_aliases: number;
  /** source/target/type 未解析而被跳过的关系数 */
  skipped_relations: number;
  /** provider 调用失败/不可用的 Scene 数(降级进复核, 不丢对象, R53) */
  uncertain: number;
}

/** plan 中一个将被改写的 canonical 对象文件(original/next 为完整字节; CAS 以 original 复核)。 */
export interface AliasRelationFilePlan {
  /** vault 相对路径(gitAdd 精确 pathspec 用, 如 world/objects/obj-a.md) */
  relativePath: string;
  slug: string;
  /** 首个 write 前捕获的原文(apply 时 CAS 比对) */
  original: string;
  /** 内存计算好的最终文件内容(校验已全部通过) */
  next: string;
  /** 本对象将新增的别名(去重后) */
  aliases_added: string[];
  /** 本对象将新增的关系(去重后, `${type}→${target}` 显示形态) */
  relations_added: string[];
}

/** 聚合全部批次建议后的确定性写入计划(尚未落盘)。 */
export interface AliasRelationPlan {
  files: AliasRelationFilePlan[];
  aliases_attached: number;
  relations_written: number;
  /** 将被改写的 canonical 对象 slug(去重、确定序) */
  touched: string[];
  /** 本批关系写入的非宿主 canonical 目标快照: apply 需在 approval 后复查
   *  (防批准期间目标消失/移出 canonical → 不产出 dangling relation)。 */
  targets: AliasRelationTargetSnapshot[];
  /** 无任何实际变更(全 skip/全不确定/空建议) */
  empty: boolean;
  /** 审批摘要: 总数 + 确定性对象明细(可截断但说明总数) */
  summary: string;
  /** 审批条目: 每对象一行增量明细(确定性; 可截断但带总数行) */
  items: string[];
}

/** 关系目标(非宿主文件)的 canonical 快照(plan 构建时捕获; apply 复查存在性 + canonical)。 */
export interface AliasRelationTargetSnapshot {
  slug: string;
  /** 计划时刻的 status(诊断用; apply 复查要求仍为 canonical) */
  status: string;
}

/** apply 结果(写 + 恰一次 commit 成功后返回; 任一异常即抛, 无部分状态)。 */
export interface AliasRelationApplied {
  aliases_attached: number;
  relations_written: number;
  touched: string[];
  /** commit hash(空 plan 不 commit 时为 null) */
  commit: string | null;
}

/**
 * world/objects 目录快照(R9: 只接收普通 .md 文件, symlink 忽略不跟随)。
 * canonical 判据 = 存在 + status === "canonical"(不以当前 fm 整体 schema 作判据:
 * 旧 vault legacy 字符串 relations 形态 schema 不合但可经合并归一, N23 以最终 fm 门禁)。
 */
interface ObjectSnapshot {
  slug: string;
  file: string;
  relativePath: string;
  raw: string;
  fm: Record<string, unknown>;
  body: string;
  status: string;
  canonical: boolean;
}

function readObjectSnapshots(root: string): Map<string, ObjectSnapshot> {
  const dir = paths(root).world.objects;
  const out = new Map<string, ObjectSnapshot>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue; // R9: 普通文件, 不跟随 symlink
    const slug = entry.name.replace(/\.md$/, "");
    const file = `${dir}/${entry.name}`;
    const raw = readFileSync(file, "utf8");
    const { data: fm, body } = parseFrontmatter(raw);
    const status = String(fm.status ?? "");
    out.set(slug, {
      slug,
      file,
      relativePath: relativePathOf(root, file),
      raw,
      fm,
      body,
      status,
      canonical: status === "canonical",
    });
  }
  return out;
}

const MAX_ITEMS = 40;
const MAX_INLINE = 3;

function objectLine(f: AliasRelationFilePlan): string {
  const parts: string[] = [];
  if (f.aliases_added.length > 0) parts.push(`+别名「${f.aliases_added.join("」「")}」`);
  if (f.relations_added.length > 0) parts.push(`+关系 ${f.relations_added.join("; ")}`);
  return `${f.slug}: ${parts.join("; ")}`;
}

/** 审批条目: 每对象一行; >MAX_ITEMS 截断但保留总数行(确定性)。 */
function buildApprovalItems(files: AliasRelationFilePlan[]): string[] {
  const rows = files.map(objectLine);
  if (rows.length <= MAX_ITEMS) return rows;
  return [...rows.slice(0, MAX_ITEMS - 1), `… 共 ${rows.length} 个对象, 截断显示前 ${MAX_ITEMS - 1} 项`];
}

/** 审批摘要: 总数 + 内联前 MAX_INLINE 对象明细(确定性截断, 说明总数)。
 *  不以动作名开头(ApprovalGate 会拼 action: summary, 避免重复前缀)。 */
function buildSummary(files: AliasRelationFilePlan[], aliases: number, relations: number): string {
  const rows = files.map(objectLine);
  const inline = rows.length <= MAX_INLINE ? rows.join("; ") : `${rows.slice(0, MAX_INLINE).join("; ")}; … 共 ${rows.length} 个对象`;
  return `将改写 ${files.length} 个 canonical 对象(${aliases} 条别名 + ${relations} 条关系候选): ${inline}`;
}

/**
 * Phase 2b 只读 propose: 逐 Scene 调 provider 并归一为建议, 不写任何文件。
 * 批内失败只降级(uncertain 进复核, R53), 不丢对象; 调用方跨批聚合后走 plan→approval→apply。
 * opts.budget(审查项 3, 加法): 工作流累计预算 tracker —— 编排(runDeepImport)启动时
 * 按 ExecutionProfile.workflowBudget 创建一次, 逐 runStep 共享消费; 超支在 provider
 * 前 fail-closed(现有 RunStep budget API)。
 */
export async function proposeAliasRelations(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string; budget?: WorkflowBudget } = {},
): Promise<AliasRelationProposal> {
  registerImportSpecs();
  const byName = new Map(listCanonicalObjects(root).map((o) => [o.name, o.slug]));
  const proposal: AliasRelationProposal = { aliases: [], relations: [], skipped_aliases: 0, skipped_relations: 0, uncertain: 0 };

  for (const slug of sceneSlugs) {
    const sceneFile = paths(root).scenes.sceneFile(slug);
    if (!existsSync(sceneFile)) continue;
    const { data: fm } = parseFrontmatter(readFileSync(sceneFile, "utf8"));
    const texts = ((fm.chapter_ids as number[]) ?? []).map((ch) => readChapterText(root, ch)).join("\n\n");
    const r = await runStep(provider, { specRef: "alias_relation", input: `【Scene ${slug}】\n${texts}` }, { budget: opts.budget });
    if (!r.ok) {
      proposal.uncertain += 1;
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
        proposal.skipped_aliases += 1;
        continue;
      }
      proposal.aliases.push({
        scene: slug,
        entity_ref: ref,
        alias,
        target,
        ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
      });
    }
    for (const rel of parsed.relations ?? []) {
      const source = byName.get(String(rel.source_ref ?? ""));
      const target = byName.get(String(rel.target_ref ?? ""));
      const type = String(rel.relation_type ?? "");
      if (!source || !target || !type) {
        proposal.skipped_relations += 1;
        continue;
      }
      proposal.relations.push({
        scene: slug,
        source_ref: String(rel.source_ref ?? ""),
        target_ref: String(rel.target_ref ?? ""),
        relation_type: type,
        ...(typeof rel.description === "string" ? { description: rel.description } : {}),
        ...(typeof rel.confidence === "number" ? { confidence: rel.confidence } : {}),
        source,
        target,
      });
    }
  }
  return proposal;
}

/**
 * 确定性写入计划: 聚合全部批次建议, 基于 canonical 对象快照在内存计算最终文件内容。
 * - 同一对象跨批多次更新不丢前批(内存累积, 不落地读盘);
 * - 别名/关系去重(别名按对象去重; 关系按 (target,type) 去重, N14; 已有别名/边不重复计);
 * - 复核: propose 的 byName 是 provider 前快照, 慢 LLM 期间 canonical 对象可能被删除/移出
 *   canonical —— 构建时对每条建议(alias 目标 + relation source/target)重新验证
 *   「存在且 status=canonical」(R9 普通文件), 任一失效即 VALIDATION_FAILED 零写,
 *   不产出 dangling relation(悬空目标/关系源);
 * - 所有 target/relations/frontmatter 校验在本批次首个 write 前完成(fail-closed);
 * - 关系目标非宿主且非本批 touched 时捕获 canonical 快照(plan.targets), 供 apply
 *   在 approval 后复查(防批准期间目标消失/换成非 canonical);
 * - 本函数只读不写; 落盘由 applyAliasRelationChanges 在 approval 后执行。
 */
export function planAliasRelationChanges(root: string, proposals: readonly AliasRelationProposal[]): AliasRelationPlan {
  // 内存累积(跨批): target slug → 待加别名(批内/批间去重); source slug → 待加关系行。
  const pendingAliases = new Map<string, string[]>();
  const pendingRelations = new Map<string, RelationRow[]>();
  for (const p of proposals) {
    for (const a of p.aliases) {
      const list = pendingAliases.get(a.target) ?? [];
      if (!list.includes(a.alias)) list.push(a.alias);
      pendingAliases.set(a.target, list);
    }
    for (const rel of p.relations) {
      const row: RelationRow = {
        target: rel.target,
        type: rel.relation_type,
        status: "candidate", // 铁律5: LLM 产出默认候选, 作者显式确认后才 canonical
        ...(rel.description !== undefined ? { description: rel.description } : {}),
      };
      const list = pendingRelations.get(rel.source) ?? [];
      if (!list.some((x) => x.target === row.target && x.type === row.type)) list.push(row);
      pendingRelations.set(rel.source, list);
    }
  }

  // 构建时 canonical 快照(propose 之后的最新磁盘状态; R9 普通 .md 文件)。
  const snapshots = readObjectSnapshots(root);

  // 复核: 每条建议的端点(alias 目标 / relation source / relation target)必须仍是
  // canonical 对象(存在 + status=canonical); 否则 fail-closed 于首个 write 前(零写)。
  const assertCanonical = (slug: string, role: string): ObjectSnapshot => {
    const snap = snapshots.get(slug);
    if (!snap) {
      throw new StoreError(
        "VALIDATION_FAILED",
        `2b ${role} ${slug} 已不存在于 world/objects(propose 后被删除), 拒绝写入(fail-closed)`,
        [`world/objects/${slug}.md`],
      );
    }
    if (!snap.canonical) {
      throw new StoreError(
        "VALIDATION_FAILED",
        `2b ${role} ${slug} 非 canonical 对象(status=${snap.status}), 拒绝写入(fail-closed)`,
        [snap.relativePath],
      );
    }
    return snap;
  };
  const checked = new Set<string>();
  for (const p of proposals) {
    for (const a of p.aliases) {
      if (checked.has(`a:${a.target}`)) continue;
      checked.add(`a:${a.target}`);
      assertCanonical(a.target, "别名目标");
    }
    for (const rel of p.relations) {
      if (!checked.has(`s:${rel.source}`)) {
        checked.add(`s:${rel.source}`);
        assertCanonical(rel.source, "关系源");
      }
      if (!checked.has(`t:${rel.target}`)) {
        checked.add(`t:${rel.target}`);
        assertCanonical(rel.target, "关系目标");
      }
    }
  }

  const files: AliasRelationFilePlan[] = [];
  const touchedSet = new Set<string>();
  let aliasesAttached = 0;
  let relationsWritten = 0;
  const touchedSlugs = [...new Set([...pendingAliases.keys(), ...pendingRelations.keys()])].sort();

  for (const slug of touchedSlugs) {
    const snap = assertCanonical(slug, "宿主对象"); // 存在 + canonical(重复校验便宜, 保持单一拒绝路径)
    const fm = snap.fm;
    const nextFm: Record<string, unknown> = { ...fm };
    let aliasesAdded: string[] = [];
    let relationsAdded: string[] = [];

    const wantAliases = pendingAliases.get(slug);
    if (wantAliases && wantAliases.length > 0) {
      const current: string[] = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
      aliasesAdded = wantAliases.filter((a) => !current.includes(a));
      if (aliasesAdded.length > 0) {
        nextFm.aliases = [...current, ...aliasesAdded];
        aliasesAttached += aliasesAdded.length;
      }
    }
    const wantRelations = pendingRelations.get(slug);
    if (wantRelations && wantRelations.length > 0) {
      const currentRows = readRelations(fm);
      const freshRows = wantRelations.filter((n) => !currentRows.some((r) => r.target === n.target && r.type === n.type));
      if (freshRows.length > 0) {
        nextFm.relations = upsertRelations(currentRows, wantRelations).rows;
        relationsAdded = freshRows.map((r) => `${r.type}→${r.target}`);
        relationsWritten += freshRows.length;
      }
    }
    if (aliasesAdded.length === 0 && relationsAdded.length === 0) continue; // 全部命中既有内容 → 无实际变更

    // N23(用户裁定): 别名/关系合并改写对象文件前, 按 'object' schema 校验最终 fm(required=id/kind/name/status),
    // 失败 fail-closed 不写字、不进 git commit —— 所有校验在本批次首个 write 前完成。
    const issues = validateFrontmatter("object", nextFm);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new StoreError("VALIDATION_FAILED", `object ${slug} frontmatter 校验失败: ${detail}`, issues);
    }
    touchedSet.add(slug);
    files.push({
      relativePath: snap.relativePath,
      slug,
      original: snap.raw,
      next: serializeFrontmatter(nextFm, snap.body),
      aliases_added: aliasesAdded,
      relations_added: relationsAdded,
    });
  }

  // 关系目标(非宿主且非本批 touched)的 canonical 快照: apply 在 approval 后复查。
  // 宿主/已 touched 目标由文件字节 CAS 覆盖; 这里只捕获「未写但被引用」的目标。
  const targetSnapshots = new Map<string, AliasRelationTargetSnapshot>();
  for (const f of files) {
    for (const rel of pendingRelations.get(f.slug) ?? []) {
      if (rel.target === f.slug || touchedSet.has(rel.target)) continue;
      const t = snapshots.get(rel.target);
      if (!t || !t.canonical) continue; // 理论上已由前置 assertCanonical 拦截, 防御性跳过
      targetSnapshots.set(rel.target, { slug: rel.target, status: t.status });
    }
  }

  const empty = files.length === 0;
  return {
    files,
    aliases_attached: aliasesAttached,
    relations_written: relationsWritten,
    touched: files.map((f) => f.slug),
    targets: [...targetSnapshots.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    empty,
    summary: empty ? "别名/关系: 无实际变更" : buildSummary(files, aliasesAttached, relationsWritten),
    items: buildApprovalItems(files),
  };
}

/** vault 相对路径(gitAdd 精确 pathspec; 归一为 `/` 分隔, git 全平台接受)。 */
function relativePathOf(root: string, file: string): string {
  return relative(root, file).split("\\").join("/");
}

/**
 * 确定性 apply: approval 放行后执行写 + 恰一次 commit。
 * - 首个 write 前完成: 工作区 clean(imports 自身工件除外)+ touched 源原文字节 CAS
 *   + 非 touched 关系目标的 canonical 复查(存在 + 普通文件 + status=canonical);
 *   任一失败抛 StoreError(CONFLICT)且零写入(不产出 dangling relation);
 * - gitAdd 传精确 touched 相对路径(不再 -A, 避免捕获并发用户编辑);
 * - commit 成功后返回结果; 写/commit 任何异常向上抛(调用方据此不 emit adopt)。
 */
export function applyAliasRelationChanges(root: string, plan: AliasRelationPlan): AliasRelationApplied {
  if (plan.files.length === 0) {
    return { aliases_attached: 0, relations_written: 0, touched: [], commit: null };
  }
  // R17/CAS: 首个 write 前完成工作区 clean(imports 自身工件除外, 语义与 commit/structure 一致)
  // + touched 原文复查(与 plan 时快照逐字节比对); 任一失败零写入。
  assertImportWorkspaceClean(root);
  for (const f of plan.files) {
    const file = paths(root).world.objectFile(f.slug);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== f.original) {
      throw new StoreError("CONFLICT", `2b 目标 ${f.slug} 在计划与 approval 之间被外部改动, 拒绝写入(fail-closed)`, [f.slug]);
    }
  }
  // 非 touched 关系目标复查(approval 可能耗时; 目标在批准期间消失/换成非 canonical → 零写)。
  for (const t of plan.targets) {
    const file = paths(root).world.objectFile(t.slug);
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      // R9: 必须仍是普通文件(消失或换成 symlink 一律拒绝, 不跟随)。
      throw new StoreError("CONFLICT", `2b 关系目标 ${t.slug} 在批准期间消失, 拒绝写入(fail-closed, 防 dangling relation)`, [t.slug]);
    }
    const { data: fm } = parseFrontmatter(readFileSync(file, "utf8"));
    const status = String(fm.status ?? "");
    if (status !== "canonical") {
      throw new StoreError(
        "CONFLICT",
        `2b 关系目标 ${t.slug} 在批准期间移出 canonical(status=${status}, 计划时=${t.status}), 拒绝写入(fail-closed, 防 dangling relation)`,
        [t.slug],
      );
    }
  }
  for (const f of plan.files) {
    writeFileSync(paths(root).world.objectFile(f.slug), f.next, "utf8");
  }
  gitAdd(root, plan.files.map((f) => f.relativePath));
  const commit = gitCommit(root, `deep-import alias/relation: ${plan.aliases_attached} aliases, ${plan.relations_written} relations`);
  return {
    aliases_attached: plan.aliases_attached,
    relations_written: plan.relations_written,
    touched: plan.touched,
    commit,
  };
}

/**
 * N32 事务版 apply(加法导出; 深导编排的主路径): 同三重写前校验, 写入走
 * @novelcraft/store `executeCanonicalWrite`(kind=canonical)—— 多对象 writeSet
 * 单事务原子提交, 批内中途异常/崩溃零部分写入残留(durable intent 收敛回滚),
 * 关闭交接 §7 条目 11 登记的「批内部分失败残留」。同步版保留为兼容面。
 */
export async function applyAliasRelationChangesTx(
  root: string,
  plan: AliasRelationPlan,
  tx?: TransactionOptions,
): Promise<AliasRelationApplied> {
  if (plan.files.length === 0) {
    return { aliases_attached: 0, relations_written: 0, touched: [], commit: null };
  }
  // 与同步版一致的三重写前门禁(R17 clean + touched 字节 CAS + 非 touched 目标复查);
  // 事务 preflight 会再按 writeSet expected 复核字节(双保险, 审批窗口竞争 fail-closed)。
  assertImportWorkspaceClean(root);
  for (const f of plan.files) {
    const file = paths(root).world.objectFile(f.slug);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== f.original) {
      throw new StoreError("CONFLICT", `2b 目标 ${f.slug} 在计划与 approval 之间被外部改动, 拒绝写入(fail-closed)`, [f.slug]);
    }
  }
  for (const t of plan.targets) {
    const file = paths(root).world.objectFile(t.slug);
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw new StoreError("CONFLICT", `2b 关系目标 ${t.slug} 在批准期间消失, 拒绝写入(fail-closed, 防 dangling relation)`, [t.slug]);
    }
    const { data: fm } = parseFrontmatter(readFileSync(file, "utf8"));
    const status = String(fm.status ?? "");
    if (status !== "canonical") {
      throw new StoreError(
        "CONFLICT",
        `2b 关系目标 ${t.slug} 在批准期间移出 canonical(status=${status}, 计划时=${t.status}), 拒绝写入(fail-closed, 防 dangling relation)`,
        [t.slug],
      );
    }
  }
  const applied = await executeCanonicalWrite(
    root,
    plan.files.map((f) => ({ path: f.relativePath, current: f.original, output: f.next })),
    {
      purpose: `deep-import alias/relation: ${plan.aliases_attached} aliases, ${plan.relations_written} relations`,
      ...(tx !== undefined ? { tx } : {}),
    },
  );
  return {
    aliases_attached: plan.aliases_attached,
    relations_written: plan.relations_written,
    touched: plan.touched,
    commit: applied.commit,
  };
}

/**
 * Phase 2b: 别名附着(canonical 目标才落; 否则 skipped 进待复核)+ 关系 create-or-merge。
 * 兼容面 = propose + plan + apply 组合: 先只读收集建议, 聚合后在内存算最终内容并全量校验,
 * 任一校验失败于首个 write 前抛 StoreError(零文件写入), 通过后单次 commit。
 */
export async function aliasRelationBatch(
  provider: Provider,
  root: string,
  sceneSlugs: string[],
  opts: { workflowId?: string } = {},
): Promise<AliasRelationResult> {
  const proposal = await proposeAliasRelations(provider, root, sceneSlugs, opts);
  const plan = planAliasRelationChanges(root, [proposal]);
  applyAliasRelationChanges(root, plan);
  return {
    aliases_attached: plan.aliases_attached,
    aliases_skipped: proposal.skipped_aliases,
    relations_written: plan.relations_written,
    uncertain: proposal.uncertain,
  };
}