// imports · Phase 1 候选(切分/补全/融合)——纯内存候选 + 阶段函数。
// 候选不落盘(imports.md「Scene 候选 = 工作区临时产物, 仅存 checkpoint/session log」)。
import { existsSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, WorkflowBudget } from "@novelcraft/llm-step";
import { registerImportSpecs } from "./specs-imports.js";

export interface SceneCandidate {
  candidate_id: string;
  source_round: "A" | "B";
  source_chapter_indices: number[];
  source_candidate_ids: string[];
  operation: "kept" | "merged" | "split" | "reordered" | "rewritten";
  quality: "high" | "low" | "failed";
  confidence: number;
  fallback_required: boolean;
  needs_review: boolean;
  review_reason: string;
  phase: string;
  payload: {
    title: string;
    goal?: string;
    core_conflict?: string;
    core_conflict_status?: string;
    emotional_beat?: string;
    must_happen?: string;
    must_not_happen?: string;
    narrative_tag?: string;
    start_chapter?: number;
    end_chapter?: number;
    start_anchor?: string;
    end_anchor?: string;
    boundary_status?: string;
    boundary_basis?: string;
    basis?: string;
    uncertain_fields?: string[];
  };
}

export interface BatchResult<T> {
  items: T[];
  failed_chapters: number[];
}

/** 读章节正文(去 frontmatter)。 */
export function readChapterText(root: string, chapterIndex: number): string {
  const file = paths(root).chapters.chapterFile(chapterIndex);
  if (!existsSync(file)) throw new Error(`章节不存在: ${chapterIndex}`);
  const raw = readFileSync(file, "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Phase 1a: 逐章切分。单章失败 → 该章整章 fallback(降级条款: 不部分采用),
 *  不影响他章; fallback 候选 quality=failed + fallback_required。
 *  opts.budget(审查项 3, 加法): 工作流累计预算 tracker —— 编排(runDeepImport)启动时
 *  按 ExecutionProfile.workflowBudget 创建一次, 逐 runStep 共享消费; 超支在 provider
 *  前 fail-closed(现有 RunStep budget API: runStep(provider, req, { budget }))。 */
export async function sliceChapterBatch(
  provider: Provider,
  root: string,
  chapterIndices: number[],
  opts: { phase1aContext?: string; budget?: WorkflowBudget } = {},
): Promise<BatchResult<SceneCandidate>> {
  registerImportSpecs();
  const items: SceneCandidate[] = [];
  const failed: number[] = [];
  for (const ch of chapterIndices) {
    const text = readChapterText(root, ch);
    const r = await runStep(
      provider,
      {
        specRef: "scene_slicing",
        input: `【第 ${ch} 章正文】\n${text}\n${opts.phase1aContext ? `【Phase1a 上下文】\n${opts.phase1aContext}` : ""}`,
      },
      { budget: opts.budget },
    );
    if (!r.ok) {
      failed.push(ch);
      items.push({
        candidate_id: `ch${ch}-fallback`,
        source_round: "A",
        source_chapter_indices: [ch],
        source_candidate_ids: [],
        operation: "kept",
        quality: "failed",
        confidence: 0,
        fallback_required: true,
        needs_review: true,
        review_reason: `切分失败(${r.error?.kind}), 整章 fallback`,
        phase: "phase1a_fallback",
        payload: { title: `第 ${ch} 章(整章保底)` },
      });
      continue;
    }
    const scenes = (r.result as { scenes?: Array<Record<string, unknown>> }).scenes ?? [];
    scenes.forEach((s, i) => {
      items.push({
        candidate_id: `ch${ch}-s${i}`,
        source_round: "A",
        source_chapter_indices: [ch],
        source_candidate_ids: [],
        operation: "kept",
        quality: "high",
        confidence: typeof s.confidence === "number" ? s.confidence : 0,
        fallback_required: false,
        needs_review: false,
        review_reason: "",
        phase: "phase1a_slicing",
        payload: {
          title: String(s.title ?? `第 ${ch} 章 Scene ${i + 1}`),
          goal: s.goal as string | undefined,
          core_conflict: s.core_conflict as string | undefined,
          core_conflict_status: s.core_conflict_status as string | undefined,
          start_chapter: typeof s.start_chapter === "number" ? s.start_chapter : ch,
          end_chapter: typeof s.end_chapter === "number" ? s.end_chapter : ch,
          start_anchor: s.start_anchor as string | undefined,
          end_anchor: s.end_anchor as string | undefined,
          boundary_status: s.boundary_status as string | undefined,
          boundary_basis: s.boundary_basis as string | undefined,
        },
      });
    });
    if (scenes.length === 0) {
      failed.push(ch);
      items.push({
        candidate_id: `ch${ch}-empty`,
        source_round: "A",
        source_chapter_indices: [ch],
        source_candidate_ids: [],
        operation: "kept",
        quality: "failed",
        confidence: 0,
        fallback_required: true,
        needs_review: true,
        review_reason: "切分返回空, 整章 fallback",
        phase: "phase1a_fallback",
        payload: { title: `第 ${ch} 章(整章保底)` },
      });
    }
  }
  return { items, failed_chapters: failed };
}

/** Phase 1b: 逐 Scene 补全。provider 失败 → 空语义进复核(降级条款)。
 *  opts.budget(审查项 3, 加法): 工作流累计预算 tracker, 见 sliceChapterBatch。 */
export async function enrichSceneBatch(
  provider: Provider,
  scenes: SceneCandidate[],
  opts: { budget?: WorkflowBudget } = {},
): Promise<SceneCandidate[]> {
  registerImportSpecs();
  const out: SceneCandidate[] = [];
  for (const sc of scenes) {
    if (sc.quality === "failed") {
      out.push(sc);
      continue;
    }
    const r = await runStep(
      provider,
      {
        specRef: "scene_enrichment",
        input: `【Scene 卡】\n${JSON.stringify(sc.payload)}\n`,
      },
      { budget: opts.budget },
    );
    if (!r.ok) {
      out.push({
        ...sc,
        quality: "low",
        needs_review: true,
        review_reason: `${sc.review_reason} 补全失败(${r.error?.kind}), 空语义进复核`.trim(),
        payload: { ...sc.payload, narrative_tag: "draft" },
      });
      continue;
    }
    const p = r.result as Record<string, unknown>;
    out.push({
      ...sc,
      payload: {
        ...sc.payload,
        emotional_beat: p.emotional_beat as string | undefined,
        must_happen: p.must_happen as string | undefined,
        must_not_happen: p.must_not_happen as string | undefined,
        narrative_tag: (p.narrative_tag as string) ?? sc.payload.narrative_tag ?? "draft",
        basis: p.basis as string | undefined,
        uncertain_fields: p.uncertain_fields as string[] | undefined,
      },
    });
  }
  return out;
}

export interface FusionDecision {
  left_candidate_id: string;
  right_candidate_id: string;
  relation: "same_scene" | "duplicate" | "overlap" | "separate" | "uncertain";
  fusion_intent?: "kept" | "merged" | "split" | "reordered" | "rewritten";
  confidence: number;
}

/** Phase 1c: 成对边界复核。operation 归一(R60): 非法值拒绝该条。
 *  opts.budget(审查项 3, 加法): 工作流累计预算 tracker, 见 sliceChapterBatch。 */
export async function fuseSceneBatch(
  provider: Provider,
  pairs: Array<{ left: SceneCandidate; right: SceneCandidate }>,
  opts: { budget?: WorkflowBudget } = {},
): Promise<FusionDecision[]> {
  registerImportSpecs();
  const decisions: FusionDecision[] = [];
  const VALID: FusionDecision["relation"][] = ["same_scene", "duplicate", "overlap", "separate", "uncertain"];
  for (const pair of pairs) {
    const r = await runStep(
      provider,
      {
        specRef: "scene_fusion",
        input: `【左候选】\n${JSON.stringify(pair.left.payload)}\n【右候选】\n${JSON.stringify(pair.right.payload)}\n`,
      },
      { budget: opts.budget },
    );
    if (!r.ok) {
      decisions.push({
        left_candidate_id: pair.left.candidate_id,
        right_candidate_id: pair.right.candidate_id,
        relation: "uncertain",
        confidence: 0,
      });
      continue;
    }
    const boundaries = (r.result as { boundaries?: Array<Record<string, unknown>> }).boundaries ?? [];
    for (const b of boundaries) {
      const rel = String(b.relation ?? "uncertain");
      if (!VALID.includes(rel as FusionDecision["relation"])) continue; // R60: 未知值拒绝该条
      const intent = b.fusion_intent as string | undefined;
      const intentOk = intent === undefined || ["kept", "merged", "split", "reordered", "rewritten"].includes(intent);
      decisions.push({
        left_candidate_id: String(b.left_candidate_id ?? pair.left.candidate_id),
        right_candidate_id: String(b.right_candidate_id ?? pair.right.candidate_id),
        relation: rel as FusionDecision["relation"],
        fusion_intent: intentOk ? (intent as FusionDecision["fusion_intent"]) : undefined,
        confidence: typeof b.confidence === "number" ? b.confidence : 0,
      });
    }
  }
  return decisions;
}
