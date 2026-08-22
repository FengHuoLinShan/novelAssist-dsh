// imports Phase 2/3 + 去重 L0–L3 + 恢复 行为契约
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter, validateFrontmatter } from "@novelcraft/store";
import { ingestChapter } from "@novelcraft/writing";
import {
  aliasRelationBatch, analyzeStructure, applyDedup, dedupReport, extractEntityBatch,
  planAliasRelationChanges, planImport, proposeAliasRelations, resumeImport, writeCheckpoint,
} from "../src/index";
import type { DedupReport } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nci2-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "克莱恩与苏婉同行。", source: "paste" });
  // R17: commitScenes/analyzeStructure 写前要求范围外干净工作区 → 夹具先提交初始状态。
  gitAdd(root);
  gitCommit(root, "fixture init");
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 本仓库每书一 git vault; 返回全部 commit message(新→旧)。 */
function gitLog(root: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 造一个已提交 Scene(s001)供 Phase 2 消费 */
function makeScene(root: string) {
  writeFileSync(
    join(root, "scenes", "s001.md"),
    "---\nid: s001\nstatus: draft\nchapter_ids: [1]\ntitle: S1\n---\n",
  );
  gitAdd(root);
  gitCommit(root, "scene s001");
}

describe("extractEntityBatch(2a)", () => {
  it("候选落 world/pending; 批内同名同型去重(R21)", async () => {
    const root = makeRoot();
    makeScene(root);
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          entities: [
            { name: "苏婉", entity_type: "character", evidence: ["q1"], confidence: 0.9 },
            { name: "苏婉", entity_type: "character", evidence: ["q2"], confidence: 0.9 },
            { name: "克莱恩", entity_type: "character", evidence: ["q3"], confidence: 0.95 },
          ],
        }),
      }],
    });
    const r = await extractEntityBatch(provider, root, ["s001"]);
    expect(r.created).toHaveLength(2); // 苏婉 去重后 1 + 克莱恩 1
    expect(existsSync(join(root, "world", "pending", r.created[0] + ".md"))).toBe(true);
    const raw = readFileSync(join(root, "world", "pending", r.created[0] + ".md"), "utf8");
    expect(raw).toContain('kind: "character"'); // B1: 候选落盘写 kind, 不再写 entity_type
    expect(raw).not.toContain("entity_type:");
    // N23(用户裁定): pending/object schema required 含 id; 候选落盘含 id(=落盘 slug)且过 schema。
    const { data } = parseFrontmatter(raw);
    expect(data.id).toBe(r.created[0]);
    expect(validateFrontmatter("pending", data as never)).toEqual([]);
  });
  it("同名同型 canonical 且置信≥0.88 → 复用不建新对象(R23); 旧 entity_type 文件仍可读(B1 legacy)", async () => {
    const root = makeRoot();
    makeScene(root);
      writeFileSync(
      join(root, "world", "objects", "obj-suwan.md"),
      "---\nname: \"苏婉\"\nentity_type: \"character\"\nstatus: canonical\n---\n", // B1: 只含 entity_type 的旧对象文件, 走 listCanonicalObjects 双 fallback
    );
    gitAdd(root); gitCommit(root, "adopt obj-suwan");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({ entities: [{ name: "苏婉", entity_type: "character", evidence: ["q"], confidence: 0.95 }] }),
      }],
    });
    const r = await extractEntityBatch(provider, root, ["s001"]);
    expect(r.created).toHaveLength(0);
    expect(r.reused).toEqual([{ name: "苏婉", target: "obj-suwan" }]);
  });
  it("写前范围外脏工作区 → DIRTY_WORKSPACE, 零写零 commit(R17)", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "untracked-notes.md"), "并发无关未跟踪", "utf8");
    const commitsBefore = gitLog(root).length;
    const provider = new MockProvider({ responses: [] }); // 若被调用会因无响应失败 → 证明未到 LLM
    await expect(extractEntityBatch(provider, root, ["s001"])).rejects.toMatchObject({ code: "DIRTY_WORKSPACE" });
    // 零写零 commit: 无新 pending 文件、无新 commit。
    const pendingDir = join(root, "world", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir).filter((f) => f.endsWith(".md")) : []).toEqual([]);
    expect(gitLog(root).length).toBe(commitsBefore);
  });
  it("范围外预存 staged 文件 → DIRTY_WORKSPACE fail-closed, 绝不捕获用户 staged", async () => {
    const root = makeRoot();
    makeScene(root);
    // 用户预存 staged 外部文件: 普通 `git commit` 会把 index 里已 staged 内容一起提交
    // → 必须前置 R17 门禁 fail-closed, 不能只靠「gitAdd 精确路径」规避。
    writeFileSync(join(root, "user-staged.md"), "用户预 staged", "utf8");
    gitAdd(root, ["user-staged.md"]);
    const commitsBefore = gitLog(root).length;
    const provider = new MockProvider({ responses: [] });
    await expect(extractEntityBatch(provider, root, ["s001"])).rejects.toMatchObject({ code: "DIRTY_WORKSPACE" });
    // 零新 commit; 外部文件仍 staged 未被提交; 无新 pending 文件。
    expect(gitLog(root).length).toBe(commitsBefore);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(status).toContain("user-staged.md");
    const pendingDir = join(root, "world", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir).filter((f) => f.endsWith(".md")) : []).toEqual([]);
  });
  it("gitAdd 只传本批精确相对文件(commit 不含无关路径)", async () => {
    const root = makeRoot();
    makeScene(root);
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          entities: [
            { name: "苏婉", entity_type: "character", evidence: ["q1"], confidence: 0.9 },
            { name: "克莱恩", entity_type: "character", evidence: ["q3"], confidence: 0.95 },
          ],
        }),
      }],
    });
    const r = await extractEntityBatch(provider, root, ["s001"]);
    expect(r.created).toHaveLength(2);
    // -z: NUL 分隔原始路径(避免 core.quotePath 对中文路径加引号/八进制转义)。
    const files = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean).sort();
    expect(files).toEqual([...r.created.map((s) => `world/pending/${s}.md`)].sort());
  });
});

describe("aliasRelationBatch(2b)", () => {
  it("别名附着 canonical 对象(R1 不建新对象); 关系 create-or-merge", async () => {
    const root = makeRoot();
    makeScene(root);
      // N23: 改写前按 'object' schema 校验 → fixture 需含必填 id/kind/name/status。
      writeFileSync(join(root, "world", "objects", "obj-suwan.md"), '---\nid: obj-suwan\nkind: "character"\nname: "苏婉"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-klein.md"), '---\nid: obj-klein\nkind: "character"\nname: "克莱恩"\nstatus: canonical\n---\n');
    gitAdd(root); gitCommit(root, "objects");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          aliases: [{ entity_ref: "苏婉", alias: "红衣女子", confidence: 0.8 }],
          relations: [{ source_ref: "克莱恩", target_ref: "苏婉", relation_type: "associate", confidence: 0.8 }],
          uncertain_items: [],
        }),
      }],
    });
    const r = await aliasRelationBatch(provider, root, ["s001"]);
    expect(r.aliases_attached).toBe(1);
    expect(r.relations_written).toBe(1);
    const fm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-suwan.md"), "utf8")).data;
    expect((fm.aliases as string[])).toContain("红衣女子");
    // N14: 关系写宿主对象 frontmatter relations: [] 为源(不落 source 字段), list 形态 + 铁律5 默认候选。
    const srcFm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-klein.md"), "utf8")).data;
    expect(srcFm.relations).toEqual([{ target: "obj-suwan", type: "associate", status: "candidate" }]);
    // 幂等: 重跑同 relation 不再增加(去重键 (target,type), N14)
    provider.responses.push({ text: JSON.stringify({ aliases: [], relations: [{ source_ref: "克莱恩", target_ref: "苏婉", relation_type: "associate", confidence: 0.8 }], uncertain_items: [] }) });
    const r2 = await aliasRelationBatch(provider, root, ["s001"]);
    expect(r2.relations_written).toBe(0);
  });
  it("legacy 字符串 relations 可读并合并(list 形态兜底, 旧 vault 兼容)", async () => {
    const root = makeRoot();
    makeScene(root);
    // N23: 改写前按 'object' schema 校验 → fixture 需含必填 id/kind/name/status。
    writeFileSync(join(root, "world", "objects", "obj-suwan.md"), '---\nid: obj-suwan\nkind: "character"\nname: "苏婉"\nstatus: canonical\n---\n');
    // 旧 vault: 宿主对象用字符串写面 "source -> target (type): desc"。
    writeFileSync(
      join(root, "world", "objects", "obj-klein.md"),
      '---\nid: obj-klein\nkind: "character"\nname: "克莱恩"\nstatus: canonical\nrelations: "obj-klein -> obj-suwan (associate): 旧描述"\n---\n',
    );
    gitAdd(root); gitCommit(root, "objects");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          aliases: [],
          relations: [{ source_ref: "克莱恩", target_ref: "苏婉", relation_type: "ally", confidence: 0.8 }],
          uncertain_items: [],
        }),
      }],
    });
    const r = await aliasRelationBatch(provider, root, ["s001"]);
    expect(r.relations_written).toBe(1);
    const fm = parseFrontmatter(readFileSync(join(root, "world", "objects", "obj-klein.md"), "utf8")).data;
    // 旧字符串边解析为 list 行 + 新边(candidate)合并写回 list 形态(N14)。
    expect(fm.relations).toEqual([
      { target: "obj-suwan", type: "associate", description: "旧描述" },
      { target: "obj-suwan", type: "ally", status: "candidate" },
    ]);
  });
  it("对象缺必填(id/kind)→ 别名改写前校验失败 fail-closed, 文件不变(N23)", async () => {
    const root = makeRoot();
    makeScene(root);
    // 不合规对象: 缺 id/kind(object schema required=id/kind/name/status)。
    writeFileSync(join(root, "world", "objects", "obj-suwan.md"), '---\nname: "苏婉"\nstatus: canonical\n---\n');
    gitAdd(root); gitCommit(root, "objects");
    const before = readFileSync(join(root, "world", "objects", "obj-suwan.md"), "utf8");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          aliases: [{ entity_ref: "苏婉", alias: "红衣女子", confidence: 0.8 }], // alias 项需过 output_schema(required=entity_ref/alias/confidence)
          relations: [],
          uncertain_items: [],
        }),
      }],
    });
    // N23 fail-closed: 别名附着改写前按 'object' schema 校验失败即抛 StoreError, 不写字。
    await expect(aliasRelationBatch(provider, root, ["s001"])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(readFileSync(join(root, "world", "objects", "obj-suwan.md"), "utf8")).toBe(before);
  });
});

describe("planAliasRelationChanges(canonical 端点校验: propose 快照过期 → 零写)", () => {
  /** 两个 canonical 对象 + s001; propose 响应: 别名→obj-a, 关系 obj-a→obj-b(非写目标)。 */
  async function proposeWith(root: string): Promise<ReturnType<typeof proposeAliasRelations>> {
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          aliases: [{ entity_ref: "人物甲", alias: "红衣女子", confidence: 0.8 }],
          relations: [{ source_ref: "人物甲", target_ref: "人物乙", relation_type: "associate", confidence: 0.8 }],
          uncertain_items: [],
        }),
      }],
    });
    return proposeAliasRelations(provider, root, ["s001"]);
  }

  it("关系目标存在但 status 非 canonical(如 pending)→ VALIDATION_FAILED 零写", async () => {
    const root = makeRoot();
    makeScene(root);
    writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
    // obj-b 存在但 status=pending: propose 的 byName 快照含它(建议不 skip), plan 必须拒绝。
    writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: pending\n---\n');
    gitAdd(root); gitCommit(root, "objects");
    const proposal = await proposeWith(root);
    expect(proposal.relations).toHaveLength(1); // propose 阶段解析成功(快照含 obj-b)
    const before = readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8");
    let err: unknown = null;
    try {
      planAliasRelationChanges(root, [proposal]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(String((err as Error).message)).toContain("obj-b"); // 指明失效端点
    // 零写: obj-a 未加别名/关系
    expect(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).toBe(before);
  });

  it("关系目标在 propose 后被删除(文件消失)→ VALIDATION_FAILED 零写", async () => {
    const root = makeRoot();
    makeScene(root);
    writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
    gitAdd(root); gitCommit(root, "objects");
    const proposal = await proposeWith(root);
    expect(proposal.relations).toHaveLength(1);
    // 模拟慢 LLM 期间目标被删除
    rmSync(join(root, "world", "objects", "obj-b.md"));
    const before = readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8");
    let err: unknown = null;
    try {
      planAliasRelationChanges(root, [proposal]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(readFileSync(join(root, "world", "objects", "obj-a.md"), "utf8")).toBe(before);
  });

  it("关系目标非写且 canonical → plan.targets 捕获快照(apply approval 后复查用)", async () => {
    const root = makeRoot();
    makeScene(root);
    writeFileSync(join(root, "world", "objects", "obj-a.md"), '---\nid: obj-a\nkind: "character"\nname: "人物甲"\nstatus: canonical\n---\n');
    writeFileSync(join(root, "world", "objects", "obj-b.md"), '---\nid: obj-b\nkind: "character"\nname: "人物乙"\nstatus: canonical\n---\n');
    gitAdd(root); gitCommit(root, "objects");
    const proposal = await proposeWith(root);
    const plan = planAliasRelationChanges(root, [proposal]);
    expect(plan.files.map((f) => f.slug)).toEqual(["obj-a"]); // 只有 obj-a 被改写
    expect(plan.touched).toEqual(["obj-a"]);
    // obj-b 非写但被引用 → 必须出现在 targets(apply 复查存在/canonical)
    expect(plan.targets).toEqual([{ slug: "obj-b", status: "canonical" }]);
  });
});

describe("analyzeStructure(3, ≥0.96 落 draft 待采用, N31)", () => {
  it("高置信落 draft 文件, 低置信仅计数(N31)", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          threads: [
            { title: "主线", summary: "s", confidence: 0.97 },
            { title: "弱线", summary: "s", confidence: 0.5 },
          ],
          arcs: [], foreshadowing: [], reveals: [],
        }),
      }],
    });
    const r = await analyzeStructure(provider, root, { workflowId: "w" });
    expect(r.threads).toHaveLength(1);
    expect(r.low_confidence).toBe(1);
    expect(existsSync(join(root, "structure", "threads", r.threads[0] + ".md"))).toBe(true);
    // B3 必填补齐: thread 落盘文件 id/name/thread_type 齐备且过 schema(frontmatter.ts:492)
    const raw = readFileSync(join(root, "structure", "threads", r.threads[0] + ".md"), "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data.id).toBe(r.threads[0]);
    expect(data.name).toBe("主线");
    expect(data.thread_type).toBe("main");
    // N31(用户裁定): ≥0.96 结构项落盘 status=draft(不再直置 canonical); canonical 升格经
    // store.adopt(thread/arc/foreshadowing/reveal), 该 adopt 在 dsh 层过 ApprovalGate(铁律3, fail-closed)。
    expect(data.status).toBe("draft");
    expect(validateFrontmatter("thread", data as never)).toEqual([]);
  });
  it("合规 reveal(含 target_type/target_id/secret_summary)→ 正常落盘且过 schema(N23)", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          threads: [], arcs: [], foreshadowing: [],
          reveals: [{ title: "秘密揭示", confidence: 0.98, target_type: "character", target_id: "obj-klein", secret_summary: "他是穿越者" }],
        }),
      }],
    });
    const r = await analyzeStructure(provider, root, { workflowId: "w" });
    expect(r.reveals).toHaveLength(1);
    const raw = readFileSync(join(root, "structure", "reveal", r.reveals[0] + ".md"), "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data.status).toBe("draft"); // N31: ≥0.96 结构项(含 reveal)落 draft 待采用; 升格走 adopt 审批门
    expect(validateFrontmatter("reveal", data as never)).toEqual([]); // N23: reveal 必填齐备(target_type/target_id/secret_summary)
  });
  it("不合规 reveal 项(缺 target_type/target_id/secret_summary)→ 拒写且不产生文件(N23)", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          threads: [], arcs: [], foreshadowing: [],
          reveals: [{ title: "残缺揭示", confidence: 0.98 }], // reveal required=id/status/target_type/target_id/secret_summary
        }),
      }],
    });
    // N23 fail-closed: 落盘前按 'reveal' schema 校验失败即抛 StoreError, 不写字、不进 git commit。
    await expect(analyzeStructure(provider, root, { workflowId: "w" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const dir = join(root, "structure", "reveal");
    const after = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
    expect(after).toEqual([]); // 不产生任何 reveal 文件
  });
  it("同标题 slug 已存在且字节一致(同 workflow)→ 幂等 skip, 不覆盖不新增 commit", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const resp = () =>
      new MockProvider({
        responses: [{
          text: JSON.stringify({ threads: [{ title: "主线", summary: "s", confidence: 0.97 }], arcs: [], foreshadowing: [], reveals: [] }),
        }],
      });
    const first = await analyzeStructure(resp(), root, { workflowId: "w" });
    expect(first.threads).toHaveLength(1);
    const file = join(root, "structure", "threads", first.threads[0] + ".md");
    const before = readFileSync(file, "utf8");
    const commitsBefore = gitLog(root).length;
    const second = await analyzeStructure(resp(), root, { workflowId: "w" });
    expect(second.threads).toHaveLength(0); // 未新建
    expect(second.skipped).toEqual(first.threads); // 幂等 skip(可选加法字段)
    expect(readFileSync(file, "utf8")).toBe(before); // 旧文件未被覆盖
    expect(gitLog(root).length).toBe(commitsBefore); // 不新增 commit
  });
  it("同标题 slug 已存在但内容不同 → fail-closed StoreError CONFLICT, 绝不覆盖 canonical/draft", async () => {
    const root = makeRoot();
    const slug = "threads-主线";
    // 预置 status=canonical 且内容不同的既有线程资产。
    writeFileSync(
      join(root, "structure", "threads", slug + ".md"),
      '---\nid: "threads-主线"\ntitle: "主线"\nstatus: canonical\nconfidence: 0.9\nworkflow: "other"\nname: "主线"\nthread_type: "main"\n---\n# 主线\n\n手改内容\n',
    );
    gitAdd(root); gitCommit(root, "existing thread");
    const before = readFileSync(join(root, "structure", "threads", slug + ".md"), "utf8");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({ threads: [{ title: "主线", summary: "s", confidence: 0.97 }], arcs: [], foreshadowing: [], reveals: [] }),
      }],
    });
    await expect(analyzeStructure(provider, root, { workflowId: "w" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(join(root, "structure", "threads", slug + ".md"), "utf8")).toBe(before); // 旧 canonical 未被覆盖
  });
  it("不同 workflow(即使其余字节一致)→ 不幂等 skip, fail-closed StoreError", async () => {
    const root = makeRoot();
    const slug = "threads-主线";
    // 预置与「同 workflow 完全相同」仅 workflow 不同的既有文件 → 非幂等, 必须 fail-closed。
    writeFileSync(
      join(root, "structure", "threads", slug + ".md"),
      '---\nid: "threads-主线"\ntitle: "主线"\nstatus: "draft"\nconfidence: 0.97\nworkflow: "other"\nname: "主线"\nthread_type: "main"\nsummary: "s"\n---\n# 主线\n\ns\n',
    );
    gitAdd(root); gitCommit(root, "other-wf thread");
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({ threads: [{ title: "主线", summary: "s", confidence: 0.97 }], arcs: [], foreshadowing: [], reveals: [] }),
      }],
    });
    await expect(analyzeStructure(provider, root, { workflowId: "w" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("整批先校验后写: 后项 reveal 校验失败 → 前项 thread 也不落盘(整批原子)", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          threads: [{ title: "主线", summary: "s", confidence: 0.97 }],
          arcs: [], foreshadowing: [],
          reveals: [{ title: "残缺揭示", confidence: 0.98 }], // reveal required 字段缺失
        }),
      }],
    });
    await expect(analyzeStructure(provider, root, { workflowId: "w" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const dir = join(root, "structure", "threads");
    expect(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []).toEqual([]); // 合法 thread 也不写
  });
  it("写前范围外脏工作区 → DIRTY_WORKSPACE(先于 LLM 调用)", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "untracked-notes.md"), "手改未提交", "utf8");
    const provider = new MockProvider({ responses: [] }); // 若被调用会因无响应失败 → 证明未到 LLM
    await expect(analyzeStructure(provider, root, { workflowId: "w" })).rejects.toMatchObject({ code: "DIRTY_WORKSPACE" });
  });
  it("gitAdd 只传本批精确相对文件(commit 不含无关路径)", async () => {
    const root = makeRoot();
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          threads: [{ title: "主线", summary: "s", confidence: 0.97 }],
          arcs: [{ title: "辅线", summary: "s", confidence: 0.97 }],
          foreshadowing: [], reveals: [],
        }),
      }],
    });
    const r = await analyzeStructure(provider, root, { workflowId: "w" });
    expect(r.threads).toEqual(["threads-主线"]);
    expect(r.arcs).toEqual(["arcs-辅线"]);
    // -z: NUL 分隔原始路径(避免 core.quotePath 对中文路径加引号/八进制转义)。
    const files = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean).sort();
    expect(files).toEqual(["structure/arcs/arcs-辅线.md", "structure/threads/threads-主线.md"]);
  });
});

describe("dedupReport / applyDedup(L0–L3)", () => {
  function seedPending(root: string) {
      const mk = (slug: string, name: string, kind: string, evidence: string[]) => {
      const fm = serializeFrontmatter(
        { name, entity_type: kind, status: "candidate", confidence: 0.9, evidence },
        "",
      );
      writeFileSync(join(root, "world", "pending", slug + ".md"), fm, "utf8");
    };
    mk("p-a1", "红衣女子", "character", ["e1"]);
    mk("p-a2", "红衣女子", "character", ["e2"]); // L0 同名同型组
    mk("p-b", "苏婉", "character", ["e3"]);
    gitAdd(root); gitCommit(root, "pending seed");
  }

  it("L0 分组(同名同型)+ 报告; 未批准拒绝执行", async () => {
    const root = makeRoot();
    seedPending(root);
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          decisions: [{ candidate_ids: ["p-b", "p-a1"], verdict: "uncertain", confidence: 0.4 }],
        }),
      }],
    });
    const report = await dedupReport(provider, root);
    expect(report.l0_groups).toHaveLength(1);
    expect(report.total_candidates).toBe(3);
    expect(() => applyDedup(root, report)).toThrow(/approval/);
  });

  it("批准后 L0 合并: 证据并入 target, source 置 merged(可逆)", async () => {
    const root = makeRoot();
    seedPending(root);
    const report: DedupReport = {
      l0_groups: [["p-a1", "p-a2"]],
      decisions: [],
      high_confidence_merges: [],
      uncertain: [],
      total_candidates: 3,
    };
    const r = applyDedup(root, report, { approved: true });
    expect(r.merged).toBe(1);
    const tgt = parseFrontmatter(readFileSync(join(root, "world", "pending", "p-a1.md"), "utf8")).data;
    expect((tgt.evidence as string[])).toHaveLength(2);
    const src = parseFrontmatter(readFileSync(join(root, "world", "pending", "p-a2.md"), "utf8")).data;
    expect(src.status).toBe("merged");
    expect(src.merged_into).toBe("p-a1");
  });
  it("applyDedup 的 gitAdd 只暂存本批精确相对路径(commit 不含并发无关改动)", () => {
    const root = makeRoot();
    seedPending(root);
    // 并发无关改动: 未跟踪文件 + 已跟踪文件未暂存修改 —— 精确 pathspec 不得捕获。
    writeFileSync(join(root, "untracked-notes.md"), "并发无关未跟踪\n", "utf8");
    writeFileSync(
      join(root, "world", "pending", "p-b.md"),
      readFileSync(join(root, "world", "pending", "p-b.md"), "utf8") + "手改\n",
      "utf8",
    );
    const report: DedupReport = {
      l0_groups: [["p-a1", "p-a2"]],
      decisions: [],
      high_confidence_merges: [],
      uncertain: [],
      total_candidates: 3,
    };
    const r = applyDedup(root, report, { approved: true });
    expect(r.merged).toBe(1);
    // commit 只含本批实际触摸文件(相对 POSIX 路径, -z 避免引号/八进制转义)。
    const files = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean).sort();
    expect(files).toEqual(["world/pending/p-a1.md", "world/pending/p-a2.md"]);
    // 无关改动未被提交/暂存, 仍以 未跟踪 + 未暂存修改 形式留在工作区。
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(status).toContain("untracked-notes.md");
    expect(status).toContain("p-b.md");
  });
});

describe("resumeImport(幂等续跑, 审查项 5: 指纹必填且 checkpoint 必须带指纹)", () => {
  it("无 checkpoint 不可恢复; 仅 planImport 无指纹 → 拒绝; 带指纹则可恢复且列出幂等重跑面", () => {
    const root = makeRoot();
    const fp = "a".repeat(64);
    expect(resumeImport(root, { profileFingerprint: fp }).resumable).toBe(false); // 无 checkpoint
    const plan = planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    // 仅 planImport 阶段的 checkpoint 未记录执行画像指纹 → 严格 resume 拒绝(fail-closed,
    // 移除旧 checkpoint fail-open)。
    expect(resumeImport(root, { profileFingerprint: fp }).resumable).toBe(false);
    // 记录指纹后(模拟 runDeepImport 早期写指纹)→ 同指纹可恢复。
    writeCheckpoint(root, { plan, profile_fingerprint: fp, phase_results: {} });
    const r = resumeImport(root, { profileFingerprint: fp });
    expect(r.resumable).toBe(true);
    expect(r.safe_to_rerun.length).toBeGreaterThan(0);
  });
});
