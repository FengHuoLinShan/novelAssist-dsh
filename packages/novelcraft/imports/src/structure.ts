// imports · Phase 3 结构分析 + 结构去重(imports.md「结构去重建议」+ catalog §1.8)。
// 规则: 同 workflow 且置信 ≥0.96 才自动应用(shouldAutoPromote); 低置信只报告。
import { existsSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { assertValidRelations, gitAdd, gitCommit } from "@novelcraft/store";
import { slugify } from "@novelcraft/vault";

export interface StructureResult {
  threads: string[];
  arcs: string[];
  foreshadowing: string[];
  reveals: string[];
  low_confidence: number;
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

function applyThreshold(items: StructItem[], min = 0.96): { keep: StructItem[]; dropped: number } {
  const keep: StructItem[] = [];
  let dropped = 0;
  for (const it of items) {
    if (typeof it.confidence === "number" && it.confidence >= min) keep.push(it);
    else dropped += 1;
  }
  return { keep, dropped };
}

function writeStructFile(root: string, dir: string, title: string, item: StructItem, workflowId: string, kind: string): string {
  const slug = slugify(`${kind}-${title}`) || `item-${Date.now()}`;
  // ADR-0019 P3(用户裁定): relations 写前硬错校验(自环/悬空/type 白名单/端点 kind)。
  if (Array.isArray(item.relations)) {
    const sourceKind = DIR_KEY_TO_KIND[kind] ?? "thread";
    assertValidRelations(root, sourceKind, slug, item.relations);
  }
  const lines = [
    "---",
    `id: ${JSON.stringify(slug)}`,
    `title: ${JSON.stringify(title)}`,
    "status: canonical", // ≥0.96 自动应用(imports.md 结构去重); 审批门 Phase F 另行收口
    `confidence: ${item.confidence ?? 0}`,
    `workflow: ${JSON.stringify(workflowId)}`,
  ];
  // B3 必填补齐(frontmatter.ts:491-511): thread=name/thread_type, foreshadowing=name;
  // name 默认取 title, thread_type 自由字符串常见 main(specs/assets/outline.md:148)。
  if (kind === "threads" || kind === "foreshadowing") {
    lines.push(`name: ${JSON.stringify(typeof item.name === "string" && item.name ? item.name : title)}`);
  }
  if (kind === "threads") {
    lines.push(`thread_type: ${JSON.stringify(typeof item.thread_type === "string" && item.thread_type ? item.thread_type : "main")}`);
  }
  if (item.summary) lines.push(`summary: ${JSON.stringify(item.summary)}`);
  // ADR-0019 P3: relations 有向对透传(新工作流写 relations, 不散写 related_*_ids)。
  // name/thread_type 已显式落列(见上), 其余(reveal 的 target_type/target_id/secret_summary 等)原样透传。
  const extra = Object.entries(item).filter(([k]) => !["title", "summary", "confidence", "name", "thread_type"].includes(k));
  for (const [k, v] of extra) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  writeFileSync(`${dir}/${slug}.md`, lines.join("\n") + `# ${title}\n\n${item.summary ?? ""}\n`, "utf8");
  return slug;
}

/** Phase 3: 单次结构分析 → 阈值过滤(≥0.96)→ 落 structure/ 目录(N12)。 */
export async function analyzeStructure(
  provider: Provider,
  root: string,
  opts: { workflowId: string; context?: string },
): Promise<StructureResult> {
  const r = await runStep(provider, {
    specRef: "structure_analysis",
    input: opts.context ?? "请基于已导入 Scene 与世界对象分析剧情结构。",
  });
  const result: StructureResult = { threads: [], arcs: [], foreshadowing: [], reveals: [], low_confidence: 0 };
  if (!r.ok) return result;

  const parsed = r.result as {
    threads?: StructItem[];
    arcs?: StructItem[];
    foreshadowing?: StructItem[];
    reveals?: StructItem[];
  };
  const p = paths(root).structure;
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
      out.push(writeStructFile(root, dir, String(it.title ?? "未命名"), it, opts.workflowId, key));
    }
  }

  if (result.threads.length + result.arcs.length + result.foreshadowing.length + result.reveals.length > 0) {
    gitAdd(root);
    gitCommit(root, `deep-import structure: ${result.threads.length} threads / ${result.arcs.length} arcs`);
  }
  return result;
}
