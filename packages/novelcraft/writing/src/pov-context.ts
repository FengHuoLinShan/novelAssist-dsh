import { compileAuditableContext, type AuditableContextSource, type AuditableContextWarning, type AuditableSourceRef } from "@novelcraft/context";
import { projectCharacterKnowledge, readEvents } from "@novelcraft/memory";
import { chapterDossier, StoreError } from "@novelcraft/store";

export type PovContextWarning =
  | { code: "pov_missing" | "pov_ambiguous"; message: string }
  | { code: "knowledge_ledger_corrupt" | "knowledge_event_invalid" | "knowledge_future_excluded"; message: string };

export interface PovKnowledgeResolution {
  target_chapter: number;
  through_chapter: number;
  pov_character_id?: string;
  source?: AuditableContextSource;
  warnings: PovContextWarning[];
}

export interface PovKnowledgeReceipt {
  target_chapter: number;
  through_chapter: number;
  pov_character_id?: string;
  context_hash: string;
  budget_tokens: number;
  total_tokens: number;
  source_manifest: AuditableSourceRef[];
  omitted_source_ids: string[];
  warnings: Array<PovContextWarning | AuditableContextWarning>;
}

export interface CompiledPovKnowledgeContext extends PovKnowledgeReceipt {
  rendered_text: string;
}

/** 只从目标章 Scene + 截止上一章的 knowledge_changed 构建角色可见边界。 */
export function resolvePovKnowledgeContext(root: string, targetChapter: number): PovKnowledgeResolution {
  if (!Number.isSafeInteger(targetChapter) || targetChapter < 1) {
    throw new StoreError("VALIDATION_FAILED", "POV 目标章必须是 >=1 的安全整数");
  }
  const throughChapter = targetChapter - 1;
  const scenes = chapterDossier(root, targetChapter).scenes
    .filter((scene) => !["archived", "deprecated", "rejected"].includes(scene.status));
  const povs = [...new Set(scenes.map((scene) => scene.pov_character_id).filter((id): id is string => Boolean(id)))];
  if (povs.length === 0) {
    return {
      target_chapter: targetChapter,
      through_chapter: throughChapter,
      warnings: [{ code: "pov_missing", message: `第 ${targetChapter} 章 Scene 未绑定唯一 POV，未声称已检查人物知识边界` }],
    };
  }
  if (povs.length !== 1) {
    return {
      target_chapter: targetChapter,
      through_chapter: throughChapter,
      warnings: [{ code: "pov_ambiguous", message: `第 ${targetChapter} 章含 ${povs.length} 个 POV，未将任一人物知识当作全章边界` }],
    };
  }

  const pov = povs[0];
  const ledger = readEvents(root);
  const warnings: PovContextWarning[] = [];
  const projection = ledger.brokenLines === 0
    ? projectCharacterKnowledge(ledger.events, pov, throughChapter)
    : { known: [], excluded: [], invalid_event_count: 0, future_event_count: 0 };
  if (ledger.brokenLines > 0) {
    warnings.push({ code: "knowledge_ledger_corrupt", message: `知识账本有 ${ledger.brokenLines} 行无法解析，已 fail-safe 清空人物已知事实` });
  }
  if (projection.invalid_event_count > 0) {
    warnings.push({ code: "knowledge_event_invalid", message: `${projection.invalid_event_count} 条 knowledge_changed 不符合最小 delta 合同，已排除` });
  }
  if (projection.future_event_count > 0) {
    warnings.push({ code: "knowledge_future_excluded", message: `已排除 ${projection.future_event_count} 条在第 ${targetChapter} 章或之后生效的人物知识` });
  }
  const sceneExclusions = [...new Set(scenes.map((scene) => scene.must_not_happen?.trim()).filter((text): text is string => Boolean(text)))];
  const lines = [
    `目标章节：第 ${targetChapter} 章`,
    `有限视角人物：${pov}`,
    "【禁止越界（不是人物已知事实）】",
    ...(projection.excluded.length > 0
      ? projection.excluded.map((item) => `- ${item.exclusion}`)
      : ["- 不得把未列入“人物已知”的作者信息写成该人物的认知。"]),
    ...(sceneExclusions.length > 0
      ? ["【Scene 导演约束（不是人物已知事实）】", ...sceneExclusions.map((text) => `- ${text}`)]
      : []),
    "【人物已知事实】",
    ...(projection.known.length > 0 ? projection.known.map((item) => `- ${item.text}`) : ["- 暂无显式已知事实。"]),
  ];
  return {
    target_chapter: targetChapter,
    through_chapter: throughChapter,
    pov_character_id: pov,
    warnings,
    source: {
      tier: "P3",
      name: `第 ${targetChapter} 章 POV/知识边界`,
      content: lines.join("\n"),
      source_id: `pov:${pov}:chapter:${targetChapter}`,
      source_type: "pov_knowledge",
      source_status: warnings.some((warning) => warning.code === "knowledge_ledger_corrupt" || warning.code === "knowledge_event_invalid")
        ? "degraded"
        : "resolved",
      open_target: {
        kind: "pov_knowledge",
        target_chapter: targetChapter,
        through_chapter: throughChapter,
        pov_character_id: pov,
        scene_paths: scenes.map((scene) => `scenes/${scene.slug}.md`),
        memory_path: "memory/events.jsonl",
      },
    },
  };
}

export function compilePovKnowledgeContext(root: string, targetChapter: number): CompiledPovKnowledgeContext {
  const resolved = resolvePovKnowledgeContext(root, targetChapter);
  const compiled = compileAuditableContext(
    { task: `审查第 ${targetChapter} 章 POV/知识边界`, scope: "chapter" },
    { sources: resolved.source ? [resolved.source] : [] },
  );
  if (resolved.source) {
    const retained = compiled.source_manifest.find((source) => source.source_id === resolved.source!.source_id);
    if (!retained || retained.truncated) {
      throw new StoreError("VALIDATION_FAILED", `第 ${targetChapter} 章 POV/知识边界无法完整进入审查上下文`);
    }
  }
  return {
    target_chapter: targetChapter,
    through_chapter: resolved.through_chapter,
    ...(resolved.pov_character_id ? { pov_character_id: resolved.pov_character_id } : {}),
    context_hash: compiled.context_hash,
    budget_tokens: compiled.budget_tokens,
    total_tokens: compiled.total_tokens,
    source_manifest: compiled.source_manifest,
    omitted_source_ids: compiled.omitted_source_ids,
    warnings: [...resolved.warnings, ...compiled.warnings],
    rendered_text: compiled.rendered_text,
  };
}

export function povKnowledgeReceipt(context: CompiledPovKnowledgeContext): PovKnowledgeReceipt {
  const { rendered_text: _rendered, ...receipt } = context;
  return receipt;
}

export function assertResolvedPovKnowledgeSource(
  manifest: readonly AuditableSourceRef[],
  targetChapter: number,
): void {
  const source = manifest.find((item) => item.source_type === "pov_knowledge");
  if (!source || source.truncated || source.open_target?.target_chapter !== targetChapter ||
      typeof source.open_target?.pov_character_id !== "string") {
    throw new StoreError(
      "VALIDATION_FAILED",
      `第 ${targetChapter} 章未解析出唯一且完整的 POV/知识边界，安全续写已停止`,
    );
  }
}

export function assertPovKnowledgeReceiptCurrent(root: string, receipt: PovKnowledgeReceipt): void {
  const current = povKnowledgeReceipt(compilePovKnowledgeContext(root, receipt.target_chapter));
  if (JSON.stringify(current) !== JSON.stringify(receipt)) {
    throw new StoreError("CONFLICT", `第 ${receipt.target_chapter} 章 POV/知识边界已变化，请重新生成并独立审查`);
  }
}
