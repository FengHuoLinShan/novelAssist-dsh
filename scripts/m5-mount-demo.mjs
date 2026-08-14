// M5 挂载阶段集成 demo(ADR-0017 §4 验证方式 2): 真实 DSH 包
// (cordis + storage + storage-json + storage-domain + llm + approval 假实现)
// 进程内组合, 跑通挂载全链:
//   vault 初始化 → 收件箱推信号 → 索引(domain 缓存)→ llm_step(DshProvider
//   → ctx.llm 假适配器)→ 审批门控采用(git commit)→ 雷达 job。
// 运行: node scripts/m5-mount-demo.mjs(纯 node, 无 DSH CLI)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { apply as applyStorageJson, Config as JsonConfig } from "@deepseek-ai/dsh-storage-json";
import { apply as applyStorageDomain, Config as DomainConfig } from "@deepseek-ai/dsh-storage-domain";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { JobRegistry } from "@deepseek-ai/dsh-jobs";
import { gitAdd, gitCommit, serializeFrontmatter } from "../packages/novelcraft/store/dist/index.js";
import { NovelCraftService } from "../packages/novelcraft/dsh/dist/index.js";

// ---- 假 LLM 适配器(演示用; 真实 profile 用 dsh-llm-deepseek 等官方适配器) ----
class DemoAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream() {
    yield { type: "text-delta", index: 0, text: '{"findings":[{"category":"设定","severity":"medium","quote":"示例句","suggestion":"示例改法"}],"verdict":"需修订"}' };
    yield { type: "usage", usage: { inputTokens: 11, outputTokens: 22 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

// ---- 假审批服务(演示用: 全部放行) ----
class DemoApproval extends ApprovalService {
  async request(req) {
    console.log(`   [approval/asked] ${req.reason}`);
    return "allowed-once";
  }
}

// ---- 假 jobs 注册表(演示用: 立即完成) ----
class DemoJobs extends JobRegistry {
  start(spec) {
    const id = `${spec.kind}-1`;
    const hooks = spec.run();
    void hooks.done.then((outcome) => console.log(`   [job ${id}] ${outcome.status}: ${outcome.output ?? outcome.detail ?? ""}`));
    return id;
  }
  list() { return []; }
  get() { throw new Error("demo"); }
  read() { throw new Error("demo"); }
  kill() { return "already-finished"; }
  async wait() { throw new Error("demo"); }
  onJobDone() { return () => {}; }
  onJobsChanged() { return () => {}; }
  attachController() { return () => {}; }
}

// ---- 组装(与 profile 等价的最小进程内组合) ----
const dataDir = mkdtempSync(join(tmpdir(), "nc-m5-demo-"));
const ctx = new Context();
ctx.plugin(Storage);
await ctx.plugin({ name: "storage-json", inject: ["storage"], Config: JsonConfig, apply: applyStorageJson }, { root: join(dataDir, "storage") });
await ctx.plugin({ name: "storage-domain", inject: ["storage"], Config: DomainConfig, apply: applyStorageDomain }, { backend: "json" });
await ctx.plugin(LlmRuntime);
ctx.llm.registerAdapter(["demo"], new DemoAdapter());
new DemoApproval(ctx);
new DemoJobs(ctx);
ctx.provide("tools", { register: (def) => { console.log(`   [tools] 注册工具 ${def.name}`); return () => {}; } });

await ctx.plugin(NovelCraftService, {
  llm: { provider: "demo", model: "demo-model" },
  vaultsDir: join(dataDir, "Novels"),
  watch: { enabled: false, intervalMinutes: 60 },
});
const nc = ctx.novelcraft;
const fakeAgent = { id: "demo-agent", session: { id: "demo-session" } };

console.log("① vault 初始化 + 会话绑定(D17)");
const binding = nc.vaults.ensureVault("演示之书");
await nc.vaults.bindSession("demo-session", binding);
console.log(`   root=${binding.root}`);

console.log("② 待处理对象 + 索引(文件真相 → domain 缓存)");
const pendingAbs = join(binding.root, "world", "pending", "pend_demo.md");
mkdirSync(join(binding.root, "world", "pending"), { recursive: true });
writeFileSync(pendingAbs, serializeFrontmatter({ id: "pend_demo", kind: "character", name: "示例角色", status: "candidate" }, "示例角色正文"), "utf8");
gitAdd(binding.root);
gitCommit(binding.root, "demo fixture");
const index = nc.refreshIndex(binding.root);
console.log(`   对象 ${index.objects.length}, 缓存 indexVersion=${nc.cache.getIndex(binding.root)?.indexVersion}`);

console.log("③ 收件箱: 推信号 → 视图");
nc.facades.assistant.pushSignal(binding.root, {
  radar: "dedup", severity: "risk", title: "「示例角色」疑似与既有对象重复",
  evidence: ["第1章"], proposed_action: "合并保留较早对象", reversibility: true,
});
console.log(`   收件箱 ${nc.inbox(binding.root).length} 条(风险前置: ${nc.inbox(binding.root)[0].severity})`);
// 信号文件也是 vault 真相的一部分, 提交后工作区恢复干净(CAS 语义)。
gitAdd(binding.root);
gitCommit(binding.root, "demo: inbox signal");

console.log("④ llm_step 内容手(DshProvider → ctx.llm)");
const step = await nc.runStep({ specRef: "semantic_review", input: "第一章正文(冻结)" });
console.log(`   ok=${step.ok}, findings=${step.result?.findings?.length ?? 0}, usage=${step.usage.outputTokens} tokens`);

console.log("⑤ 审批门控采用(git commit, 双链审计)");
const adopted = await nc.adoptGuarded(fakeAgent, binding.root, "object", "pend_demo", {}, "演示采用");
console.log(`   → ${adopted.targetRelPath} [${adopted.toStatus}] commit=${adopted.commit.slice(0, 12)}`);
console.log(`   已移入 canonical: ${existsSync(join(binding.root, "world", "objects", "pend_demo.md"))}`);

console.log("⑥ 雷达巡检 job(ctx.jobs)");
const jobId = nc.radars.start({ root: binding.root, radar: "dedup" }, async () => "本轮去重巡检: 0 冲突");
console.log(`   jobId=${jobId}`);

console.log("⑦ 会话绑定回查(ctx.storageDomain)");
const resolved = await nc.vaults.resolve("demo-session");
console.log(`   session demo-session → ${resolved?.book} @ ${resolved?.root}`);

rmSync(dataDir, { recursive: true, force: true });
console.log("M5 挂载 demo 全链完成 ✓");
