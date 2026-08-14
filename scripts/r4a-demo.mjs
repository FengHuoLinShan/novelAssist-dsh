// R4a 手动 demo: 计划→切分→补全→融合→提交(Phase 1 全链)
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../packages/novelcraft/vault/dist/index.js";
import { MockProvider } from "../packages/novelcraft/llm-step/dist/index.js";
import { ingestChapter } from "../packages/novelcraft/writing/dist/index.js";
import { planImport, sliceChapterBatch, enrichSceneBatch, fuseSceneBatch, commitScenes } from "../packages/novelcraft/imports/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "r4a-"));
initVault(root, { title: "诡秘之主", language: "zh" });
ingestChapter(root, { chapterIndex: 1, text: "克莱恩走进占卜俱乐部。", source: "paste" });
ingestChapter(root, { chapterIndex: 2, text: "苏婉在雨夜递来一封信。", source: "paste" });

console.log("① 计划 + 授权");
const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
console.log(`   workflow_id=${plan.workflow_id}, steps=${plan.steps.length}`);

console.log("② 切分(1a)");
const provider = new MockProvider({
  responses: [
    { text: JSON.stringify({ scenes: [{ title: "占卜俱乐部", start_chapter: 1, end_chapter: 1, start_anchor: "A", end_anchor: "A", confidence: 0.9 }] }) },
    { text: JSON.stringify({ scenes: [{ title: "雨夜来信", start_chapter: 2, end_chapter: 2, start_anchor: "B", end_anchor: "B", confidence: 0.9 }] }) },
    { text: JSON.stringify({ emotional_beat: "好奇", narrative_tag: "hook", confidence: 0.8 }) },
    { text: JSON.stringify({ emotional_beat: "悬念", narrative_tag: "rising_action", confidence: 0.8 }) },
    { text: JSON.stringify({ boundaries: [{ left_candidate_id: "ch1-s0", right_candidate_id: "ch2-s0", relation: "separate", fusion_intent: "kept", confidence: 0.9 }] }) },
  ],
});
const sliced = await sliceChapterBatch(provider, root, [1, 2]);
console.log(`   候选 ${sliced.items.length} 个, 失败章 ${sliced.failed_chapters.length}`);

console.log("③ 补全(1b)");
const enriched = await enrichSceneBatch(provider, sliced.items.filter((i) => !i.fallback_required));
console.log(`   narrative_tag=${enriched.map((e) => e.payload.narrative_tag).join(", ")}`);

console.log("④ 融合(1c)");
const pairs = [];
for (let i = 0; i + 1 < enriched.length; i++) pairs.push({ left: enriched[i], right: enriched[i + 1] });
const decisions = await fuseSceneBatch(provider, pairs);
console.log(`   决策 ${decisions.length} 条: ${decisions.map((d) => d.relation).join(", ")}`);

console.log("⑤ 提交");
const r = commitScenes(root, enriched, { workflowId: plan.workflow_id });
console.log(`   创建 ${r.created.join(", ")}, 跳过 ${r.skipped.length}, 冲突 ${r.conflicts.length}`);
const s1 = readFileSync(join(root, "scenes", "s001.md"), "utf8");
console.log(`   s001 含 provenance_key=${s1.includes("provenance_key:")}, narrative_tag draft/hook=${s1.includes("hook") || s1.includes("draft")}`);
rmSync(root, { recursive: true, force: true });
console.log("R4a Phase 1 demo 完成 ✅");
