// N32 事务化写面行为契约(交接 §7 条目 11 收口):
//   ① commitScenesTx: after_preflight 崩溃注入 → 目标 Scene 文件零残留、HEAD 不变
//      (intent 残留由恢复入口收敛, 此处断言用户可见面零部分写入);
//   ② applyAliasRelationChangesTx: 批内多对象 + 崩溃注入 → 全部对象保持 plan 前字节
//      (关闭登记的「批内部分失败残留」);
//   ③ 深导异常路径 state commit: 2b apply CONFLICT(approval 后目标移出 canonical)→
//      原异常重抛 + checkpoint/trace 进 HEAD(state commit)+ 工作区 clean。
// 断言注释引 N32/ADR-0021/R17。复用 trace-contract.test.ts 的 Mock 协议。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, gitHead, parseFrontmatter } from "@novelcraft/store";
import { initVault, paths } from "@novelcraft/vault";
import { MockApproval, TraceRecorder } from "@novelcraft/trace";
import { registerImportSpecs } from "../src/specs-imports.js";
import { commitScenesTx } from "../src/commit.js";
import { applyAliasRelationChangesTx, planAliasRelationChanges } from "../src/alias-relation.js";
import { runDeepImport } from "../src/orchestrate.js";
import { ingestChapter } from "@novelcraft/writing";
import { planImport } from "../src/plan.js";
import type { DeepImportRuntime } from "../src/orchestrate.js";

registerImportSpecs();

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nc-tx-atomic-"));
  dirs.push(root);
  initVault(root, { title: "事务测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitSubjects(root: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}
function gitStatusEmpty(root: string): boolean {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "";
}

/** ç´ æç« è½åºå¹¶æäº¤(R17: commitScenesTx ååè¦æ±èå´å¤å¹²å)ã */
function ingestChapterFixture(root: string, chapterIndex: number): void {
  ingestChapter(root, { chapterIndex, text: `ç¬¬${chapterIndex}ç« æ­£æã`, source: "paste" });
  gitAdd(root);
  gitCommit(root, `fixture chapter ${chapterIndex}`);
}

function sceneCandidate(chapterIndex: number, anchor: string) {
  return {
    candidate_id: `ch${chapterIndex}-s0`,
    source_round: "A" as const,
    source_chapter_indices: [chapterIndex],
    source_candidate_ids: [`raw-${chapterIndex}`],
    operation: "kept" as const,
    quality: "high" as const,
    confidence: 0.9,
    fallback_required: false,
    needs_review: false,
    review_reason: "",
    phase: "1b",
    payload: {
      title: `S${chapterIndex}`,
      start_chapter: chapterIndex,
      end_chapter: chapterIndex,
      start_anchor: anchor,
      end_anchor: anchor,
    },
  };
}

describe("commitScenesTx(N32: 整批单事务原子)", () => {
  it("after_preflight 崩溃注入 → Scene 文件零残留、HEAD 不变(部分写入零残留)", async () => {
    const root = makeRoot();
    const headBefore = gitHead(root);
    await expect(commitScenesTx(root, [sceneCandidate(1, "A1"), sceneCandidate(2, "A2")], {
      workflowId: "wf-crash",
      tx: { faults: { after_preflight: "crash" } },
    })).rejects.toThrow();
    expect(existsSync(paths(root).chapters.chapterFile(1))).toBe(false);
    expect(existsSync(paths(root).chapters.chapterFile(2))).toBe(false);
    expect(gitHead(root)).toBe(headBefore);
    // 恢复入口跑完后工作区回到 clean(崩溃残留只存在于 durable intent, 已收敛)。
    expect(gitStatusEmpty(root)).toBe(true);
  });

  it("正常路径: 整批落盘 + 单事务提交(vault-tx 机器戳)", async () => {
    const root = makeRoot();
    ingestChapterFixture(root, 1);
    const r = await commitScenesTx(root, [sceneCandidate(1, "A1")], { workflowId: "wf-ok" });
    expect(r.created).toHaveLength(1);
    expect(existsSync(paths(root).chapters.chapterFile(1))).toBe(true);
    const subjects = gitSubjects(root);
    expect(subjects[0]).toContain("vault-tx");
    expect(subjects.filter((m) => m.includes("vault-tx"))).toHaveLength(1);
    expect(gitStatusEmpty(root)).toBe(true);
  });
});

describe("applyAliasRelationChangesTx(N32: 批内多对象原子)", () => {
  function seedObjects(root: string): void {
    writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-c.md"), '---\nid: obj-c\nkind: "character"\nname: "人物丙"\nstatus: canonical\n---\n');
    gitAdd(root);
    gitCommit(root, "seed objects");
  }

  it("崩溃注入 → 全部对象保持 plan 前字节(零批内残留)", async () => {
    const root = makeRoot();
    seedObjects(root);
    const beforeA = readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8");
    const beforeB = readFileSync(join(root, "world", "objects", "obj-b.md"), "utf8");
    const proposal = {
      aliases: [{ scene: "ch1-s0", entity_ref: "人物甲", alias: "红衣女子", target: "obj-a", confidence: 0.99 }],
      relations: [{ scene: "ch1-s0", source_ref: "人物乙", target_ref: "人物丙", relation_type: "associate", source: "obj-b", target: "obj-c", confidence: 0.99 }],
      skipped_aliases: 0,
      skipped_relations: 0,
      uncertain: 0,
    };
    const plan = planAliasRelationChanges(root, [proposal]);
    expect(plan.files.length).toBeGreaterThan(0);
    await expect(applyAliasRelationChangesTx(root, plan, { faults: { after_preflight: "crash" } })).rejects.toThrow();
    expect(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).toBe(beforeA);
    expect(readFileSync(join(root, "world", "objects", "obj-b.md"), "utf8")).toBe(beforeB);
    expect(gitStatusEmpty(root)).toBe(true);
  });
});

describe("runDeepImport 异常路径 state commit(交接 §7 条目 11)", () => {
  it("2b apply CONFLICT(approval 后目标移出 canonical)→ 原异常重抛 + state commit 收口 + 工作区 clean", async () => {
    const root = makeRoot();
    ingestChapterFixture(root, 1);
    writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-c.md"), '---\nid: obj-c\nkind: "character"\nname: "人物丙"\nstatus: canonical\n---\n');
    gitAdd(root);
    gitCommit(root, "seed objects");

    const approval = new MockApproval({ decisions: ["allowed-once", "allowed-once"] });
    // 审批放行后把非写目标 obj-c 移出 canonical(同 trace-contract 的 CONFLICT 场景):
    // apply 的写前目标复查失败 → 异常路径收口生效。
    const approve = async (action: string, summary: string, items: string[]) => {
      const d = await approval.approve(action, summary, items);
      if (action === "别名/关系写入(2b)" && d === "allowed-once") {
        writeFileSync(join(root, "world", "objects", "obj-c.md"), '---\nid: obj-c\nkind: "character"\nname: "人物丙"\nstatus: deprecated\n---\n');
        gitAdd(root);
        gitCommit(root, "deprecate obj-c");
      }
      return d;
    };
    const runtime: DeepImportRuntime = {
      provider: new MockProvider({ retryable: false, responses: [
        { text: JSON.stringify({ scenes: [{ title: "S1", start_chapter: 1, end_chapter: 1, start_anchor: "A1", end_anchor: "A1", confidence: 0.9 }] }) },
        { text: JSON.stringify({ emotional_beat: "平", narrative_tag: "draft", confidence: 0.8 }) },
        { text: JSON.stringify({ entities: [] }) },
        { text: JSON.stringify({
          aliases: [{ entity_ref: "人物甲", alias: "红衣女子", confidence: 0.8 }],
          relations: [{ source_ref: "人物乙", target_ref: "人物丙", relation_type: "associate", confidence: 0.8 }],
          uncertain_items: [],
        }) },
        { text: JSON.stringify({ threads: [], arcs: [], foreshadowing: [], reveals: [] }) },
      ] }),
      approve,
      trace: new TraceRecorder(),
    };

    await expect(
      runDeepImport(root, planImport(root, { startChapter: 1, endChapter: 1, confirmed: true }), runtime),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 零写保持: obj-a 未被改写。
    const aFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).data;
    expect(aFm.aliases).toBeUndefined();
    // 异常路径收口(N32/交接 §7 条目 11): checkpoint/trace 已 state commit 进 HEAD。
    const subjects = gitSubjects(root);
    expect(subjects.some((m) => m.includes("deep-import state"))).toBe(true);
    expect(gitStatusEmpty(root)).toBe(true);
  });
});
