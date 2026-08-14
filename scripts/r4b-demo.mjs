// R4b demo: Phase 2a/2b/3 + 去重 L0–L3 + 恢复(链上已有 r4a 的 Phase 1 产物)
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../packages/novelcraft/vault/dist/index.js";
import { MockProvider } from "../packages/novelcraft/llm-step/dist/index.js";
import { ingestChapter } from "../packages/novelcraft/writing/dist/index.js";
import { gitAdd, gitCommit, serializeFrontmatter } from "../packages/novelcraft/store/dist/index.js";
import { planImport, extractEntityBatch, aliasRelationBatch, analyzeStructure, dedupReport, applyDedup, resumeImport } from "../packages/novelcraft/imports/dist/index.js";
import { writeFileSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "r4b-"));
initVault(root, { title: "诡秘之主", language: "zh" });
ingestChapter(root, { chapterIndex: 1, text: "克莱恩与红衣女子在占卜俱乐部相遇。", source: "paste" });
writeFileSync(join(root, "scenes", "s001.md"), "---\nid: s001\nstatus: draft\nchapter_ids: [1]\ntitle: 相遇\n---\n");
writeFileSync(join(root, "world", "objects", "obj-suwan.md"), serializeFrontmatter({ name: "苏婉", entity_type: "character", status: "canonical" }, ""));
gitAdd(root); gitCommit(root, "setup");

planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });

console.log("① 2a 实体抽取");
const provider = new MockProvider({
  responses: [
    { text: JSON.stringify({ entities: [
      { name: "苏婉", entity_type: "character", evidence: ["q1"], confidence: 0.95 },
      { name: "红衣女子", entity_type: "character", evidence: ["q2"], confidence: 0.7 },
    ]}) },
    { text: JSON.stringify({ aliases: [{ entity_ref: "苏婉", alias: "红衣女子", confidence: 0.7 }], relations: [], uncertain_items: [] }) },
    { text: JSON.stringify({ threads: [{ title: "主线索", summary: "调查占卜俱乐部", confidence: 0.97 }], arcs: [], foreshadowing: [], reveals: [] }) },
  ],
});
const ents = await extractEntityBatch(provider, root, ["s001"]);
console.log(`   复用 ${ents.reused.map((r) => r.target).join(",")}, 新候选 ${ents.created.length}`);

console.log("② 2b 别名/关系");
const ar = await aliasRelationBatch(provider, root, ["s001"]);
console.log(`   别名附着 ${ar.aliases_attached}, 关系 ${ar.relations_written}`);

console.log("③ 结构分析");
const st = await analyzeStructure(provider, root, { workflowId: "w" });
console.log(`   threads ${st.threads.length}, 低置信 ${st.low_confidence}`);

console.log("④ 去重 L0–L3");
const report = await dedupReport(provider, root);
console.log(`   L0 组 ${report.l0_groups.length}, 总候选 ${report.total_candidates}`);
const applied = applyDedup(root, report, { approved: true });
console.log(`   合并 ${applied.merged}`);

console.log("⑤ 恢复检查");
const rs = resumeImport(root);
console.log(`   resumable=${rs.resumable}, ${rs.reason}`);

rmSync(root, { recursive: true, force: true });
console.log("R4b demo 完成 ✅");
