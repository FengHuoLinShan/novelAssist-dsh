// R3 手动闭环 demo: 停靠 → 语义审查 → 定向返修候选 → 采用(PLAN.md 验收)
// 运行: node scripts/r3-demo.mjs(纯 Node, 依赖各包 dist)
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../packages/novelcraft/vault/dist/index.js";
import { MockProvider } from "../packages/novelcraft/llm-step/dist/index.js";
import { ingestChapter } from "../packages/novelcraft/writing/dist/index.js";
import { reviewChapter, applyRevision, adoptChapterCandidate } from "../packages/novelcraft/writing/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "r3-"));
initVault(root, { title: "诡秘之主", language: "zh" });

console.log("① 停靠第 3 章");
const ing = ingestChapter(root, { chapterIndex: 3, text: "克莱恩推开房门，看见红衣女子站在窗边。", source: "word-paste" });
console.log(`   chapters/003.md, hash=${ing.contentHash.slice(0, 12)}…`);

console.log("② 语义审查(semantic_review)");
const provider = new MockProvider({
  responses: [{
    text: JSON.stringify({
      verdict: "1 处可修",
      findings: [{ category: "continuity", severity: "medium", quote: "红衣女子", suggestion: "与已采用实体「苏婉」统一称呼" }],
    }),
  }],
});
const rev = await reviewChapter(provider, root, 3);
console.log(`   review_id=${rev.review?.review_id}, findings=${rev.review?.findings.length}`);

console.log("③ 定向返修(targeted_revision, finding #0)");
provider.responses.push({ text: "克莱恩推开房门，看见苏婉站在窗边。" });
const revised = await applyRevision(provider, root, 3, [0]);
console.log(`   候选: ${revised.file}`);

console.log("④ 采用(copy-on-adopt + git commit)");
adoptChapterCandidate(root);
const final = readFileSync(join(root, "chapters", "003.md"), "utf8");
console.log(`   已采用: chapters/003.md 含「苏婉」=${final.includes("苏婉")}`);
console.log("⑤ git 提交链:");
const { gitLogSubjects } = await import("../packages/novelcraft/store/dist/index.js");
for (const s of gitLogSubjects(root)) console.log(`   - ${s}`);

rmSync(root, { recursive: true, force: true });
console.log("R3 闭环 demo 完成 ✅");
