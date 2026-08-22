// N33/ADR-0022: map-atlas durable production driver 行为契约。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, gitStatusEntries, serializeFrontmatter } from "@novelcraft/store";
import { MockProvider } from "@novelcraft/llm-step";
import type { ApprovalDecision } from "@novelcraft/trace";
import { readAtlasTree, runAtlasWorkflow } from "../src/index.js";

const roots: string[] = [];
function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nc-atlas-wf-"));
  roots.push(root);
  initVault(root, { title: "地图工作流测试", language: "zh" });
  const loc = paths(root).world.objectFile("loc-00");
  writeFileSync(loc, serializeFrontmatter({ id: "loc-00", name: "临水城", kind: "location", status: "canonical", aliases: [], tags: [], evidence: [] }, ""));
  const bible = paths(root).bible.bibleFile("bp-00");
  writeFileSync(bible, serializeFrontmatter({ id: "bp-00", status: "canonical", page_type: "location", page_key: "bp-00", title: "临水城志", version_number: 1 }, "临水城在雾岭南侧。"));
  gitAdd(root, [loc, bible]);
  gitCommit(root, "fixture: atlas sources");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const spatial = JSON.stringify({ locations: [{ location_key: "loc-00", facts: [{ statement: "临水城在雾岭南侧", basis: "explicit", source_keys: ["wiki:bp-00"] }] }] });
const plan = JSON.stringify({
  style_brief: "写实暗色",
  nodes: [
    { plan_key: "root-cover", title: "封面", level: "cover", summary: "总览", visual_brief: "世界封面", prompt: "封面参考", evidence: { supported: [], visual_fill: [], conflicts: [] }, sources: [], annotations: [] },
    { plan_key: "n-city", parent_plan_key: "root-cover", location_ref: "loc-00", title: "临水城", level: "city", summary: "城市", visual_brief: "临水城全景", prompt: "城市参考", evidence: { supported: ["临水城在雾岭南侧"], visual_fill: [], conflicts: [] }, sources: [{ source_type: "bible_page", source_id: "bp-00", open_target: { kind: "bible_page", slug: "bp-00" } }], annotations: [] },
  ],
});
const runtime = (
  provider: MockProvider,
  approve: () => Promise<ApprovalDecision> = async () => "allowed-once",
) => ({
  provider,
  approve,
  profileFingerprint: "a".repeat(64),
  contractVersions: { prompt: "atlas-test/v1" },
});

describe("runAtlasWorkflow durable driver(N33)", () => {
  it("artifact→receipt→cursor 完成；projection/state 与 pending canonical 写均干净", async () => {
    const root = rootFixture();
    const provider = new MockProvider({ responses: [{ text: spatial }, { text: plan }] });
    const result = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-e2e" }, runtime(provider));
    expect(result.outcome).toBe("completed");
    expect(result.run.status).toBe("review_ready");
    expect(provider.calls).toHaveLength(2);
    const runRoot = join(root, ".assistant", "atlas", "runs", result.workflowId);
    expect(existsSync(join(runRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, ".assistant", "atlas", "runs", `${result.workflowId}.json`))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("completed");
    expect(Object.values(manifest.batches).every((batch: any) => batch.state === "completed")).toBe(true);
    expect(readAtlasTree(root).pendingNodes.map((node) => node.id).sort()).toEqual(["n-city", "root-cover"]);
    expect(gitStatusEntries(root)).toEqual([]);
  }, 90_000);

  it("同输入复用 completed immutable run，不重调 provider；force 创建新 identity且旧 run不变", async () => {
    const root = rootFixture();
    const firstProvider = new MockProvider({ responses: [{ text: spatial }, { text: plan }] });
    const first = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-repeat" }, runtime(firstProvider));
    const oldManifest = readFileSync(join(root, ".assistant", "atlas", "runs", first.workflowId, "manifest.json"));
    // latest projection 是可变派生读面；篡改 source_manifest 不得改变 identity/resume 基线。
    const projectionFile = join(root, ".assistant", "atlas", "runs", `${first.workflowId}.json`);
    const projection = JSON.parse(readFileSync(projectionFile, "utf8"));
    projection.source_manifest = [{ source_type: "bible_page", source_id: "rogue", open_target: { kind: "bible_page", slug: "rogue" } }];
    writeFileSync(projectionFile, JSON.stringify(projection, null, 2) + "\n", "utf8");
    const resumeProvider = new MockProvider({ responses: [] });
    const resumed = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-repeat" }, runtime(resumeProvider));
    expect(resumed.workflowId).toBe(first.workflowId);
    expect(resumeProvider.calls).toHaveLength(0);
    const forceProvider = new MockProvider({ responses: [{ text: spatial }, { text: plan }] });
    const forced = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-repeat", force: true }, runtime(forceProvider));
    expect(forced.workflowId).not.toBe(first.workflowId);
    expect(readFileSync(join(root, ".assistant", "atlas", "runs", first.workflowId, "manifest.json"))).toEqual(oldManifest);
  }, 180_000);

  it("provider_outcome_unknown 停止；resume 只在剩余 LLM 批范围重新授权后重试", async () => {
    const root = rootFixture();
    const failing = new MockProvider({ retryable: false, responses: [{ throwError: new Error("provider lost") }] });
    const stopped = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-unknown" }, runtime(failing));
    expect(stopped.outcome).toBe("provider_outcome_unknown");
    expect(stopped.run.status).toBe("planning");
    const resumedProvider = new MockProvider({ responses: [{ text: spatial }, { text: plan }] });
    const auth: Array<{ phases: string[] }> = [];
    const resumed = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-unknown" }, {
      ...runtime(resumedProvider),
      reauthorizeRemaining: async ({ batches }) => {
        auth.push({ phases: batches.map((batch) => batch.phase) });
        return "allowed-once";
      },
    });
    expect(resumed.outcome).toBe("completed");
    expect(auth).toHaveLength(1);
    expect(auth[0].phases.some((phase) => phase.startsWith("spatial-"))).toBe(true);
    expect(auth[0].phases).toContain("plan");
  }, 120_000);

  it("审批窗口目标出现外部编辑时使用 artifact 固定 absent baseline，CAS fail-closed", async () => {
    const root = rootFixture();
    const provider = new MockProvider({ responses: [{ text: spatial }, { text: plan }] });
    let approvals = 0;
    const approve = async () => {
      approvals += 1;
      if (approvals > 1) return "rejected" as const; // probe=none 后必须新审批，不复用旧 allowed-once
      const target = join(root, "world", "atlas", "pending", "nodes", "root-cover.md");
      writeFileSync(target, "external author edit\n", "utf8");
      return "allowed-once" as const;
    };
    const result = await runAtlasWorkflow(root, { run_kind: "initial", runId: "atlas-cas" }, runtime(provider, approve));
    expect(result.run.status).toBe("failed");
    expect(approvals).toBe(2);
    expect(readFileSync(join(root, "world", "atlas", "pending", "nodes", "root-cover.md"), "utf8")).toBe("external author edit\n");
  }, 90_000);
});
