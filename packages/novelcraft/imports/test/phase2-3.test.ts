// imports Phase 2/3 + 去重 L0–L3 + 恢复 行为契约
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
  planImport, resumeImport,
} from "../src/index";
import type { DedupReport } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nci2-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "克莱恩与苏婉同行。", source: "paste" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

describe("analyzeStructure(3, ≥0.96 自动应用)", () => {
  it("高置信落 canonical 文件, 低置信仅计数", async () => {
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
});

describe("resumeImport(幂等续跑)", () => {
  it("无 checkpoint 不可恢复; 有则可恢复且列出幂等重跑面", () => {
    const root = makeRoot();
    expect(resumeImport(root).resumable).toBe(false);
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const r = resumeImport(root);
    expect(r.resumable).toBe(true);
    expect(r.safe_to_rerun.length).toBeGreaterThan(0);
  });
});
