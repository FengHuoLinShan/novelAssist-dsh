// M5-Track1 文本入库 + Track2 雷达事件链 demo(纯 node, 无 DSH CLI):
//   手稿 txt → ingestTextFile(章节切分/wiki 化存储)→ 索引重建 → 雷达巡检
//   (摄入对账自动结算 + 剧情一句话摘要)→ 收件箱视图。
// 运行: node scripts/m5-ingest-demo.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { apply as applyStorageJson, Config as JsonConfig } from "@deepseek-ai/dsh-storage-json";
import { apply as applyStorageDomain, Config as DomainConfig } from "@deepseek-ai/dsh-storage-domain";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { JobRegistry } from "@deepseek-ai/dsh-jobs";
import { NovelCraftService } from "../packages/novelcraft/dsh/dist/index.js";
import { stageTextIntake } from "../packages/novelcraft/writing/dist/index.js";

class DemoAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream() {
    yield { type: "text-delta", index: 0, text: "{}" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
class DemoApproval extends ApprovalService { async request() { return "allowed-once"; } }
class DemoJobs extends JobRegistry {
  start(spec) { const id = `${spec.kind}-1`; spec.run(); return id; }
  list() { return []; }
  get() { throw new Error("demo"); }
  read() { throw new Error("demo"); }
  kill() { return "already-finished"; }
  async wait() { throw new Error("demo"); }
  onJobDone() { return () => {}; }
  onJobsChanged() { return () => {}; }
  attachController() { return () => {}; }
}

const dataDir = mkdtempSync(join(tmpdir(), "nc-m5-ingest-"));
const ctx = new Context();
ctx.plugin(Storage);
await ctx.plugin({ name: "storage-json", inject: ["storage"], Config: JsonConfig, apply: applyStorageJson }, { root: join(dataDir, "storage") });
await ctx.plugin({ name: "storage-domain", inject: ["storage"], Config: DomainConfig, apply: applyStorageDomain }, { backend: "json" });
await ctx.plugin(LlmRuntime);
ctx.llm.registerAdapter(["demo"], new DemoAdapter());
new DemoApproval(ctx);
new DemoJobs(ctx);

await ctx.plugin(NovelCraftService, {
  llm: { provider: "demo", model: "demo-model" },
  vaultsDir: join(dataDir, "Novels"),
  watch: { enabled: false, intervalMinutes: 60 },
});
const nc = ctx.novelcraft;

console.log("① vault 初始化(D17)");
const binding = nc.vaults.ensureVault("演示之书");
await nc.vaults.bindSession("demo-session", binding);
console.log(`   root=${binding.root}`);

console.log("② 文本入库(D9a): 手稿 txt → 章节切分 → wiki 化存储");
const manuscript = [
  "序章", "一切从这里开始。", "",
  "第一章 雨夜", "雨下了一夜。林晚推开窗。", "",
  "第二章 对峙", "苏婉站在桥上。", "",
  "第三章 黎明", "天亮了。",
].join("\n");
const receipt = stageTextIntake(binding.root, "demo-session", "手稿.txt", Buffer.from(manuscript)).receiptId;
const report = nc.ingestTextFile(binding.root, { receiptId: receipt, sessionId: "demo-session" });
console.log(`   解析 ${report.total} 章, 入库 ${report.imported} 章(warnings: ${report.warnings.join(",") || "无"})`);
const idx = nc.refreshIndex(binding.root);
console.log(`   索引: 章节 ${idx.chapters.length} / Scene ${idx.scenes.length} / 对象 ${idx.objects.length}`);

console.log("③ 幂等: 同文件二次入库");
const dup = nc.ingestTextFile(binding.root, { receiptId: receipt, sessionId: "demo-session" });
console.log(`   重放报告: 解析 ${dup.total} 章, 入库 ${dup.imported} 章(资产零重写)`);

console.log("④ 雷达巡检(§7/§11): 五面对账 + 剧情一句话");
const sweep = nc.radarSweep(binding.root);
for (const [k, v] of Object.entries(sweep.results)) {
  console.log(`   [${k}] 新${v.created} 结${v.resolved} 复${v.reopened} 计${v.total}`);
}
console.log(`   剧情摘要: ${sweep.plotSummary}`);

console.log("⑤ 收件箱(摄入雷达产出: 章待增量导入)");
for (const s of nc.inbox(binding.root)) {
  console.log(`   [${s.severity}] ${s.title} → ${s.proposed_action}`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log("M5 Track1/2 demo 全链完成 ✓");
