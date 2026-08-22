// 临时复现: 深导正常完成后 checkpoint/trace 是否永久脏。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { ingestChapter } from "@novelcraft/writing";
import { MockApproval, TraceRecorder } from "@novelcraft/trace";
import { planImport, runDeepImport } from "../src/index";

const dirs: string[] = [];
function makeRoot(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), "ncrepro-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  for (let i = 1; i <= n; i++) ingestChapter(root, { chapterIndex: i, text: "第" + i + "章正文。", source: "paste" });
  gitAdd(root);
  gitCommit(root, "fixture init");
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sceneJson(chapter: number, title: string, anchor: string) {
  return { title, start_chapter: chapter, end_chapter: chapter, start_anchor: anchor, end_anchor: anchor, confidence: 0.9 };
}
function happyResponses(n: number): Array<{ text?: string; throwError?: Error }> {
  const responses: Array<{ text?: string; throwError?: Error }> = [];
  for (let ch = 1; ch <= n; ch++) responses.push({ text: JSON.stringify({ scenes: [sceneJson(ch, "S" + ch, "A" + ch)] }) });
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) });
  for (let i = 0; i < n - 1; i++) {
    responses.push({ text: JSON.stringify({ boundaries: [{ left_candidate_id: "ch" + (i + 1) + "-s0", right_candidate_id: "ch" + (i + 2) + "-s0", relation: "separate", confidence: 0.9 }] }) });
  }
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ entities: [] }) });
  for (let i = 0; i < n; i++) responses.push({ text: JSON.stringify({ aliases: [], relations: [], uncertain_items: [] }) });
  responses.push({ text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) });
  return responses;
}

function gitStatus(root: string): string[] {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("repro", () => {
  it("happy 完成后 git 状态", async () => {
    const root = makeRoot(2);
    const plan = planImport(root, { startChapter: 1, endChapter: 2, confirmed: true });
    const r = await runDeepImport(root, plan, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => new MockApproval({ decisions: ["allowed-once"] }).approve(a, s, items),
      trace: new TraceRecorder(), // 内存 sink: trace 文件不存在
    });
    expect(r.adopted).toBe(2);
    console.log("GIT STATUS (memory sink):", gitStatus(root));

    const root2 = makeRoot(2);
    const plan2 = planImport(root2, { startChapter: 1, endChapter: 2, confirmed: true });
    // 第二轮继续用核心包内存 sink；核心包测试不反向 import DSH 边界。
    await runDeepImport(root2, plan2, {
      provider: new MockProvider({ retryable: false, responses: happyResponses(2) }),
      approve: (a, s, items) => new MockApproval({ decisions: ["allowed-once"] }).approve(a, s, items),
      trace: undefined, // 缺省 TraceRecorder(内存)
    });
    console.log("GIT STATUS (default):", gitStatus(root2));
  });
});
