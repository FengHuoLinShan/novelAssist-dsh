// imports · 去重 L0–L3(设计文档 §6.1)。
// L0 = store 确定性分组; L1/L2 = dedup_judge; L3 = 报告 + 候选态合并执行。
// 候选态合并 = 免费可逆(设计 §6.1), 与 store 的已采用合并(R36/R37)是两套语义。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { parseFrontmatter, serializeFrontmatter, gitAdd, gitCommit } from "@novelcraft/store";

export interface DedupDecision {
  candidate_ids: string[];
  verdict: "same" | "different" | "uncertain";
  confidence: number;
  reasoning?: string;
}

export interface DedupReport {
  /** L0 确定性合并组(同名同型, 无需 LLM) */
  l0_groups: string[][];
  /** L1/L2 判定结果(分组 → 裁决) */
  decisions: DedupDecision[];
  /** 高置信合并(verdict=same 且 confidence ≥ merge_bias) */
  high_confidence_merges: DedupDecision[];
  /** 不确定组(交作者) */
  uncertain: DedupDecision[];
  total_candidates: number;
}

interface PendingCandidate {
  slug: string;
  name: string;
  kind: string;
  file: string;
}

function listPending(root: string): PendingCandidate[] {
  const dir = paths(root).world.pending;
  if (!existsSync(dir)) return [];
  // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .map((f) => {
      const file = `${dir}/${f}`;
      const { data } = parseFrontmatter(readFileSync(file, "utf8"));
      return {
        slug: f.replace(/\.md$/, ""),
        name: String(data.name ?? ""),
        kind: String(data.entity_type ?? data.kind ?? ""),
        file,
      };
    });
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

/** vault 相对路径(gitAdd 精确 pathspec; 归一为 `/` 分隔, git 全平台接受)。 */
function relativePathOf(root: string, file: string): string {
  return relative(root, file).split("\\").join("/");
}

/** L0 确定性分组(R28 同名同型, 本地实现避免 store 泛型形状要求)。 */
function l0ExactLocal(candidates: PendingCandidate[]): PendingCandidate[][] {
  const map = new Map<string, PendingCandidate[]>();
  for (const c of candidates) {
    const key = `${c.kind}\u0000${normalizeName(c.name)}`;
    const g = map.get(key) ?? [];
    g.push(c);
    map.set(key, g);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/** L1 分组: 归一化名相同(不区分型)→ 组内判定。 */
function l1Groups(candidates: PendingCandidate[]): PendingCandidate[][] {
  const map = new Map<string, PendingCandidate[]>();
  for (const c of candidates) {
    const key = normalizeName(c.name);
    const g = map.get(key) ?? [];
    g.push(c);
    map.set(key, g);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/** L0–L2: 生成去重报告(§6.1 形态; L2 低置信组由 dedup_judge 二判 = 本函数统一调一次)。 */
export async function dedupReport(
  provider: Provider,
  root: string,
  opts: { mergeBias?: number } = {},
): Promise<DedupReport> {
  const pending = listPending(root);
  const l0 = l0ExactLocal(pending);
  const l1 = l1Groups(pending);
  const l0Keys = new Set(l0.flat().map((c) => c.slug));
  const needJudge = l1.filter((g) => g.some((c) => !l0Keys.has(c.slug)));
  const decisions: DedupDecision[] = [];

  for (const group of needJudge) {
    const groupText = group
      .map((c) => `- ${c.slug}: ${c.name} (${c.kind})`)
      .join("\n");
    const r = await runStep(provider, {
      specRef: "dedup_judge",
      input: `【候选组(归一化名: ${normalizeName(group[0].name)})】\n${groupText}\n请判定组内是否为同一实体。`,
    });
    if (!r.ok) {
      decisions.push({ candidate_ids: group.map((c) => c.slug), verdict: "uncertain", confidence: 0 });
      continue;
    }
    const parsed = r.result as { decisions?: Array<Record<string, unknown>> };
    for (const d of parsed.decisions ?? []) {
      decisions.push({
        candidate_ids: Array.isArray(d.candidate_ids) ? d.candidate_ids.map(String) : [],
        verdict: (d.verdict as DedupDecision["verdict"]) ?? "uncertain",
        confidence: typeof d.confidence === "number" ? d.confidence : 0,
        reasoning: typeof d.reasoning === "string" ? d.reasoning : undefined,
      });
    }
  }

  const bias = opts.mergeBias ?? 0.5;
  const high = decisions.filter((d) => d.verdict === "same" && d.confidence >= bias);
  const uncertain = decisions.filter((d) => !(d.verdict === "same" && d.confidence >= bias));
  return {
    l0_groups: l0.map((g) => g.map((c) => c.slug)),
    decisions,
    high_confidence_merges: high,
    uncertain,
    total_candidates: pending.length,
  };
}

/** L3: 执行候选态合并(免费可逆)——source 置 merged + merged_into, 证据并入 target;
 *  DSH approval 由上层门禁; 本层只做确定性执行 + merge-log 式记录。 */
export function applyDedup(
  root: string,
  report: DedupReport,
  opts: { approved?: boolean; workflowId?: string } = {},
): { merged: number; log: string[] } {
  if (opts.approved !== true) {
    throw new Error("去重合并需上层 approval 确认(fail-closed, 设计 §6.1)");
  }
  const pending = listPending(root);
  const bySlug = new Map(pending.map((c) => [c.slug, c]));
  const merged = 0;
  const log: string[] = [];
  // gitAdd 精确 pathspec 收集: 本操作实际写入的 vault 相对文件; 绝不 -A(避免捕获
  // 并发无关/预存 staged 用户改动, R17 范围语义)。git add <path> 对已删除路径同样
  // 记录删除, 故完整 touched 集合天然含删除路径。
  const touched = new Set<string>();

  // L0: 组内第一个保留, 其余 merged_into 第一个
  for (const group of report.l0_groups) {
    const target = bySlug.get(group[0]);
    if (!target) continue;
    for (const slug of group.slice(1)) {
      const src = bySlug.get(slug);
      if (!src || !existsSync(src.file)) continue;
      const { data: srcFm, body: srcBody } = parseFrontmatter(readFileSync(src.file, "utf8"));
      const { data: tgtFm } = parseFrontmatter(readFileSync(target.file, "utf8"));
      const srcEvidence = Array.isArray(srcFm.evidence) ? srcFm.evidence : [];
      const tgtEvidence = Array.isArray(tgtFm.evidence) ? tgtFm.evidence : [];
      const mergedEvidence = [...new Set([...tgtEvidence, ...srcEvidence])];
      writeFileSync(target.file, serializeFrontmatter({ ...tgtFm, evidence: mergedEvidence }, ""), "utf8");
      writeFileSync(
        src.file,
        serializeFrontmatter(
          { ...srcFm, status: "merged", merged_into: target.slug, merged_at: new Date().toISOString() },
          srcBody,
        ),
        "utf8",
      );
      touched.add(target.file).add(src.file);
      log.push(`L0 merge: ${src.slug} -> ${target.slug}`);
    }
  }

  // L1/L2 高置信: 组内首个为目标
  for (const d of report.high_confidence_merges) {
    if (d.candidate_ids.length < 2) continue;
    const target = bySlug.get(d.candidate_ids[0]);
    if (!target) continue;
    for (const slug of d.candidate_ids.slice(1)) {
      const src = bySlug.get(slug);
      if (!src || !existsSync(src.file)) continue;
      const { data: srcFm, body: srcBody } = parseFrontmatter(readFileSync(src.file, "utf8"));
      const { data: tgtFm } = parseFrontmatter(readFileSync(target.file, "utf8"));
      const mergedEvidence = [
        ...new Set([
          ...((Array.isArray(tgtFm.evidence) ? tgtFm.evidence : []) as string[]),
          ...((Array.isArray(srcFm.evidence) ? srcFm.evidence : []) as string[]),
        ]),
      ];
      writeFileSync(target.file, serializeFrontmatter({ ...tgtFm, evidence: mergedEvidence }, ""), "utf8");
      writeFileSync(
        src.file,
        serializeFrontmatter(
          { ...srcFm, status: "merged", merged_into: target.slug, merged_at: new Date().toISOString() },
          srcBody,
        ),
        "utf8",
      );
      touched.add(target.file).add(src.file);
      log.push(`L1 merge: ${src.slug} -> ${target.slug}`);
    }
  }

  if (log.length > 0) {
    // 只暂存本操作触摸的精确相对路径(含删除路径语义), 绝不 -A。
    gitAdd(root, [...touched].map((f) => relativePathOf(root, f)));
    gitCommit(root, `dedup apply: ${log.length} merges`);
  }
  return { merged: log.length, log };
}
