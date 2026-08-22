// N35/ADR-0021/ADR-0024 · annotation async transactional 写面行为契约(vitest)。
//
// 覆盖(N35 唯一待接线点收敛后):
//   ① intent transaction seam: spy 断言 executeTransaction 请求形态(kind=canonical、
//      单目标 writeSet、expected.sha256 = 整文件字节 sha256、expectedHead = 生成快照、
//      validate = 业务 content_hash 事务内复核), 且事务路径零直接 writeFileSync/
//      gitAdd/gitCommit; gates 崩溃注入 intent-ready → intent 残留 + 恢复收敛回滚;
//   ② pre-staged fail-closed(N32 §2): 共享 index 任何预存 staged → STAGED_CONFLICT 零写;
//   ③ 双 CAS 分别校验(勿混淆): 业务 content_hash(队列 base)缺失/失配 → 零写零事务;
//      生成窗口 expectedHead 失配 → STALE_BASELINE 零写; 计划→执行间文件被并发修改 →
//      STALE_BASELINE 零写(输出不覆盖并发内容);
//   ④ 正文/未知 frontmatter 逐字/语义保留(只覆写 annotations/content_hash);
//   ⑤ commit 树单目标(ADR-0021 §1/§6: writeSet 外 unstaged/untracked 允许且不卷入)。
//
// 实现注: 本文件 mock @novelcraft/store 仅用于包装 executeTransaction/gitAdd/gitCommit
// 为可断言 spy(真实现透传), 其余导出原样; 崩溃收敛走真实 recoverInterruptedTransactions。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import {
  CrashSimulatedError,
  executeTransaction,
  gitAdd,
  gitCommit,
  gitHead,
  parseFrontmatter,
  recoverInterruptedTransactions,
  serializeFrontmatter,
  sha256Hex,
} from "@novelcraft/store";
import {
  addAtlasAnnotationTx,
  applyAtlasAnnotationOpsTx,
  readAtlasTree,
  writeAtlasNode,
  writeAtlasPage,
  type AtlasNode,
  type AtlasPage,
} from "../src/index";

vi.mock("@novelcraft/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@novelcraft/store")>();
  return {
    ...actual,
    executeTransaction: vi.fn(actual.executeTransaction),
    gitAdd: vi.fn(actual.gitAdd),
    gitCommit: vi.fn(actual.gitCommit),
  };
});

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ncma-tx-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
beforeEach(() => {
  vi.clearAllMocks(); // 只清调用记录; vi.fn(actual) 实现保留。
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function node(id: string, overrides?: Partial<AtlasNode>): AtlasNode {
  return {
    id,
    parent_ref: null,
    location_ref: null,
    semantic_key: `entity:${id}`,
    level: "world",
    title: id,
    status: "provisional",
    sort_order: 0,
    ...overrides,
  };
}

function page(id: string, overrides?: Partial<AtlasPage>): AtlasPage {
  return {
    id,
    run_ref: "run-t",
    node_ref: "n1",
    generation_status: "prompt_only",
    review_status: "candidate",
    title: id,
    visual_brief: "v",
    prompt: "p",
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [],
    annotations: [],
    review_note: null,
    adopted_at: null,
    rejected_at: null,
    deprecated_at: null,
    content_hash: "h-" + id,
    ...overrides,
  };
}

function gitRun(root: string, args: string[]): string {
  // 只去尾部换行: porcelain 首列状态(如 " M"/"M ")必须逐字符保留。
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}
function commitCount(root: string): number {
  return Number(gitRun(root, ["rev-list", "--count", "HEAD"]));
}
function pageFile(root: string, pageId: string): string {
  return paths(root).world.atlas.pendingPageFile(pageId);
}

describe("annotation 事务写面(N35/ADR-0021): intent transaction seam", () => {
  it("首写前产出完整 output bytes → executeTransaction(canonical 单目标); 零直接 git 写; 正文/未知 fm 保留", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const file = pageFile(root, "pg1");
    // 手工改写: 未知 frontmatter 字段 + 非空正文(输出必须逐字/语义保留; body 无尾换行)。
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      serializeFrontmatter(
        { ...data, custom_note: "作者自定义", nested: { a: [1, 2] }, tags: ["地图"] },
        "# 临水城\n\n正文第一段。\n\n末尾无换行",
      ),
      "utf8",
    );
    const preBytes = readFileSync(file, "utf8");
    const base = readAtlasTree(root).pendingPages[0]!.content_hash; // 业务 content_hash 基线
    const head = gitHead(root); // 生成快照(事务前 HEAD)
    vi.clearAllMocks(); // 清掉 fixture 提交(writeAtlasNode/writeAtlasPage)的 gitAdd/gitCommit 记录

    const r = await applyAtlasAnnotationOpsTx(root, "pg1", [
      { op: "add", label: "城门", position_x: 0.5, position_y: 0.5 },
      { op: "add", label: "水门", position_x: 0.3, position_y: 0.7 },
    ], { expectedContentHash: base });
    expect(r.applied).toBe(2);
    expect(r.content_hash).not.toBe(base);

    // ① seam: 恰一次 executeTransaction, 请求形态 = canonical 单目标 writeSet。
    const calls = vi.mocked(executeTransaction).mock.calls;
    expect(calls).toHaveLength(1);
    const req = calls[0][1];
    expect(req.kind).toBe("canonical");
    expect(req.purpose).toBe("atlas: apply annotations pg1(2 ops)");
    expect(req.writeSet).toHaveLength(1);
    const spec = req.writeSet[0];
    expect(spec.path).toBe("world/atlas/pending/pages/pg1.md");
    // expected.sha256 = 整文件字节 sha256(内容 CAS 唯一基线); 不是业务 content_hash。
    expect(spec.expected).toEqual({ absent: false, sha256: sha256Hex(preBytes) });
    expect(req.expectedHead).toBe(head); // 生成时刻 HEAD 快照(封闭生成→启动窗口)
    expect(typeof req.validate).toBe("function");
    // output = 完整文件字节: annotations 已应用、content_hash 已重算、正文/未知 fm 保留。
    const out = parseFrontmatter(spec.output!);
    expect(out.body).toBe("# 临水城\n\n正文第一段。\n\n末尾无换行");
    expect(out.data.custom_note).toBe("作者自定义");
    expect(out.data.nested).toEqual({ a: [1, 2] });
    expect(out.data.tags).toEqual(["地图"]);
    expect((out.data.annotations as { label: string }[]).map((a) => a.label).sort()).toEqual(["城门", "水门"]);
    expect(String(out.data.content_hash)).toBe(r.content_hash);
    // 事务路径零直接 writeFileSync/gitAdd/gitCommit(写/提交由执行器 intent/私有 index/commit-tree 完成)。
    expect(vi.mocked(gitAdd).mock.calls).toHaveLength(0);
    expect(vi.mocked(gitCommit).mock.calls).toHaveLength(0);
    // validate = 业务 content_hash 在事务 preflight 内复核: 注入失配字节 → CONFLICT。
    expect(() =>
      req.validate!(spec, { root, currentBytes: preBytes.replace(base, "wrong"), currentHead: head }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => req.validate!(spec, { root, currentBytes: preBytes, currentHead: head })).not.toThrow();
  });

  it("intent 事务 seam: intent-ready 崩溃 → intent 残留 + 零写零提交; 恢复收敛 canonical 回滚(N32 §7/§8)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const file = pageFile(root, "pg1");
    const preBytes = readFileSync(file, "utf8");
    const base = readAtlasTree(root).pendingPages[0]!.content_hash;
    const before = commitCount(root);

    // 模拟 SIGKILL(intent 耐久化完成、工作树/index 零副作用后): 不执行任何收尾。
    await expect(
      applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: base,
        txOptions: {
          gates: async (p) => {
            if (p === "intent-ready") throw new CrashSimulatedError("intent-ready");
          },
        },
      }),
    ).rejects.toBeInstanceOf(CrashSimulatedError);

    // intent 已耐久化(证明首写前建立 intent 事务 seam); 工作树零副作用、零提交。
    const intents = readdirSync(join(root, ".git", "novelcraft-transactions")).filter((n) => n.startsWith("tx-"));
    expect(intents).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(preBytes);
    expect(commitCount(root)).toBe(before);

    // 全新恢复入口收敛: canonical 未 commit → OUTPUT→BEFORE 条件回滚 + intent 清理。
    const report = await recoverInterruptedTransactions(root);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].outcome).toBe("rolled_back");
    expect(report.entries[0].restored).toEqual(["world/atlas/pending/pages/pg1.md"]);
    expect(report.unresolved).toEqual([]);
    expect(readdirSync(join(root, ".git", "novelcraft-transactions")).filter((n) => n.startsWith("tx-"))).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(preBytes);
    expect(commitCount(root)).toBe(before);
  });
});

describe("annotation 事务写面(N35/ADR-0021): 双 CAS 分别校验(勿混淆)", () => {
  it("业务 content_hash 缺失/失配 → 零写零事务; 生成窗口 expectedHead 失配 → STALE_BASELINE 零写", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const file = pageFile(root, "pg1");
    const preBytes = readFileSync(file, "utf8");
    const base = readAtlasTree(root).pendingPages[0]!.content_hash;
    const before = commitCount(root);

    // ① 缺 expectedContentHash → VALIDATION_FAILED(N35 缺失拒绝零写), 事务未启动。
    await expect(
      applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: undefined,
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(commitCount(root)).toBe(before);
    expect(vi.mocked(executeTransaction).mock.calls).toHaveLength(0);

    // ② 业务 content_hash 失配(stale)→ CONFLICT, 事务未启动(计划时刻拒绝)。
    await expect(
      applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: "stale-hash",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitCount(root)).toBe(before);
    expect(vi.mocked(executeTransaction).mock.calls).toHaveLength(0);

    // ③ 生成→启动窗口: expectedHead 失配 → STALE_BASELINE(执行器 preflight, 零写)。
    await expect(
      applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: base,
        expectedHead: "0".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "STALE_BASELINE" });
    expect(vi.mocked(executeTransaction).mock.calls).toHaveLength(1);
    expect(commitCount(root)).toBe(before);
    expect(readFileSync(file, "utf8")).toBe(preBytes); // 页面原样
    const pg = readAtlasTree(root).pendingPages[0]!;
    expect(pg.annotations).toHaveLength(0);
    expect(pg.content_hash).toBe(base);
  });

  it("字节 CAS: 计划与执行之间文件被并发修改 → STALE_BASELINE 零写零提交(输出不覆盖并发内容)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const file = pageFile(root, "pg1");
    const base = readAtlasTree(root).pendingPages[0]!.content_hash;
    const before = commitCount(root);
    const real = await vi.importActual<typeof import("@novelcraft/store")>("@novelcraft/store");
    const tx = vi.mocked(executeTransaction);
    tx.mockImplementation(async (rootArg, req, opts) => {
      // 模拟竞态: 世界层计划完成后、执行器 preflight 前, 另一进程改写页面文件。
      writeFileSync(file, readFileSync(file, "utf8") + "<!-- 并发修改 -->\n", "utf8");
      return real.executeTransaction(rootArg, req, opts);
    });
    try {
      await expect(
        applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
          expectedContentHash: base,
        }),
      ).rejects.toMatchObject({ code: "STALE_BASELINE" });
    } finally {
      tx.mockImplementation(real.executeTransaction);
    }
    expect(commitCount(root)).toBe(before); // 零提交
    expect(readFileSync(file, "utf8").endsWith("<!-- 并发修改 -->\n")).toBe(true); // 输出未覆盖并发内容
    expect(readAtlasTree(root).pendingPages[0]!.annotations).toHaveLength(0); // 零残留
  });
});

describe("annotation 事务写面(N35/ADR-0021): fail-closed 与提交隔离", () => {
  it("pre-staged fail-closed: 共享 index 任何预存 staged → STAGED_CONFLICT 零写零提交; 解除后可重试(N32 §2)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    const file = pageFile(root, "pg1");
    const preBytes = readFileSync(file, "utf8");
    const base = readAtlasTree(root).pendingPages[0]!.content_hash;
    // 预存 staged: 无关文件进共享 index(§2 任何预存 staged → 整个事务拒绝)。
    writeFileSync(join(root, "staged.txt"), "staged\n", "utf8");
    gitAdd(root, [join(root, "staged.txt")]);
    const before = commitCount(root);

    await expect(
      applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
        expectedContentHash: base,
      }),
    ).rejects.toMatchObject({ code: "STAGED_CONFLICT" });
    expect(commitCount(root)).toBe(before); // 零提交
    expect(readFileSync(file, "utf8")).toBe(preBytes); // 零写
    expect(readAtlasTree(root).pendingPages[0]!.annotations).toHaveLength(0); // 零残留

    // 解除 staged 后重试成功(恰一次提交)。
    gitRun(root, ["reset", "-q"]);
    const r = await applyAtlasAnnotationOpsTx(root, "pg1", [{ op: "add", label: "x", position_x: 0, position_y: 0 }], {
      expectedContentHash: base,
    });
    expect(r.applied).toBe(1);
    expect(commitCount(root)).toBe(before + 1);
  });

  it("commit 树单目标 + 正文/未知 fm 保留; writeSet 外 unstaged/untracked 不卷入(ADR-0021 §1/§6)", async () => {
    const root = makeRoot();
    writeAtlasNode(root, node("n1"));
    writeAtlasPage(root, page("pg1"));
    // 无关改动: 未跟踪杂散文件 + 已跟踪节点文件的手改(皆不得进事务 commit)。
    writeFileSync(join(root, "stray.txt"), "stray\n", "utf8");
    const nodeFile = paths(root).world.atlas.pendingNodeFile("n1");
    writeFileSync(nodeFile, readFileSync(nodeFile, "utf8") + "<!-- 作者手改 -->\n", "utf8");
    // 手工改写页面: 未知 frontmatter + 非空正文(逐字保留目标; body 无尾换行)。
    const file = pageFile(root, "pg1");
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      serializeFrontmatter(
        { ...data, custom_note: "作者自定义字段", nested: { a: [1, 2], b: "中文" }, tags: ["地图", "城"] },
        "# 临水城\n\n这是正文第一段。\n\n- 列表项\n\n末尾无换行",
      ),
      "utf8",
    );
    const base = readAtlasTree(root).pendingPages[0]!.content_hash;
    const before = gitRun(root, ["rev-parse", "HEAD"]);
    vi.clearAllMocks(); // 清掉 fixture 提交(gitAdd/gitCommit)记录, 只统计事务调用

    const id = await addAtlasAnnotationTx(root, "pg1", { label: "城门", position_x: 0.5, position_y: 0.5 }, { expectedContentHash: base });
    expect(id).toMatch(/^ann-/);

    // ⑤ commit 树单目标(事务 commit 只含本页文件)。
    const changed = gitRun(root, ["diff-tree", "-r", "--name-only", before, "HEAD"]).split(/\r?\n/).filter(Boolean);
    expect(changed).toEqual(["world/atlas/pending/pages/pg1.md"]);
    // ④ 正文逐字保留(含无尾换行); 未知 frontmatter 语义保留。
    const after = parseFrontmatter(readFileSync(file, "utf8"));
    expect(after.body).toBe("# 临水城\n\n这是正文第一段。\n\n- 列表项\n\n末尾无换行");
    expect(after.data.custom_note).toBe("作者自定义字段");
    expect(after.data.nested).toEqual({ a: [1, 2], b: "中文" });
    expect(after.data.tags).toEqual(["地图", "城"]);
    expect((after.data.annotations as { label: string }[]).map((a) => a.label)).toEqual(["城门"]);
    expect(String(after.data.content_hash)).not.toBe(base);
    // writeSet 外改动原样未提交(§1: 允许存在, 不检查、不提交、不迁移)。
    const dirty = gitRun(root, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).sort();
    expect(dirty).toEqual([" M world/atlas/pending/nodes/n1.md", "?? stray.txt"]);
    // 事务路径不直接 gitAdd/gitCommit(与 seam 测试一致; 本测试走 addAtlasAnnotationTx 共享写面)。
    expect(vi.mocked(gitAdd).mock.calls).toHaveLength(0);
    expect(vi.mocked(gitCommit).mock.calls).toHaveLength(0);
    expect(vi.mocked(executeTransaction).mock.calls).toHaveLength(1);
  });
});
