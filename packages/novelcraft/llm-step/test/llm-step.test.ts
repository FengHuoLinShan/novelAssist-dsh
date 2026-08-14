// R2 行为契约: validator / specs / budget / step / policy
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { estimateTokens, listSpecRefs, loadSpec, registerSpec } from "../src/index";
import type { ValidatorSchema } from "../src/index";
import { MockProvider } from "../src/index";
import { resolvePolicy } from "../src/index";
import { runStep } from "../src/index";
import { validateSchema } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncl-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("validator(自实现 JSON Schema 子集)", () => {
  const schema = {
    type: "object" as const,
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string" as const },
      count: { type: "number" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      mode: { enum: ["a", "b"] },
    },
  };
  it("合法对象通过", () => {
    expect(validateSchema(schema, { name: "x", count: 1, tags: ["t"], mode: "a" })).toEqual([]);
  });
  it("必填缺失 + 类型错 + 多余字段 + 枚举越界全部报出", () => {
    const issues = validateSchema(schema, { count: "1", extra: true, mode: "c" });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("/name");
    expect(paths).toContain("/count");
    expect(paths).toContain("/extra");
    expect(paths).toContain("/mode");
  });
  it("oneOf 恰好一分支", () => {
    const s: ValidatorSchema = { oneOf: [{ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { type: "object", required: ["b"], properties: { b: { type: "string" } } }] };
    expect(validateSchema(s, { a: "1" })).toEqual([]);
    expect(validateSchema(s, { a: "1", b: "2" }).length).toBe(1);
  });
});

describe("specs(内置注册表, catalog 转写)", () => {
  it("4 个内置 spec 且 outputSchema 可校验", () => {
    expect(listSpecRefs().sort()).toEqual(
      ["dedup_judge", "entity_extraction", "semantic_review", "structure_analysis"].sort(),
    );
    for (const ref of listSpecRefs()) {
      const spec = loadSpec(ref)!;
      expect(spec.timeoutMs).toBeGreaterThan(0);
      expect(spec.outputSchema.type).toBe("object");
    }
  });
  it("重复注册拒绝", () => {
    const spec = loadSpec("dedup_judge")!;
    expect(() => registerSpec({ ...spec, specRef: "dedup_judge" })).toThrow(/已注册/);
  });
});

describe("budget(启发式估算, policy-defaults)", () => {
  it("CJK 按 /1.6, 拉丁按 /4", () => {
    expect(estimateTokens("诡秘之主")).toBe(Math.ceil(4 / 1.6));
    expect(estimateTokens("abcd")).toBe(1);
  });
});

describe("runStep(主流程, 设计文档 §12 契约)", () => {
  const spec = () => loadSpec("entity_extraction")!;

  it("正常流: 校验通过返回 result + journal + usage", async () => {
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }), usage: { inputTokens: 10, outputTokens: 2 } }],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "第 1 章正文" });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ entities: [] });
    expect(r.journal).toHaveLength(1);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    // D14: 原文直通 provider
    expect(provider.calls[0].messages[1].content).toBe("第 1 章正文");
  });

  it("spec 缺失 → spec_not_found", async () => {
    const r = await runStep(new MockProvider({ responses: [] }), { specRef: "nope", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("spec_not_found");
  });

  it("输出非法 JSON → 修复重试 1 次后成功", async () => {
    const provider = new MockProvider({
      responses: [
        { text: "不是 JSON" },
        { text: JSON.stringify({ entities: [{ name: "克莱恩", entity_type: "character", evidence: ["q"] }] }) },
      ],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(true);
    expect(r.journal).toHaveLength(2);
    expect(r.journal[0].errorKind).toBe("schema_violation");
  });

  it("schema 违例超过修复预算 → schema_violation 失败", async () => {
    const provider = new MockProvider({
      responses: [
        { text: "{}" },
        { text: "{}" },
      ],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("schema_violation");
    expect(r.journal).toHaveLength(2);
  });

  it("超时 → timeout", async () => {
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }), delayMs: 500 }],
    });
    const r = await runStep(provider, {
      specRef: "entity_extraction",
      input: "x",
      overrides: { timeoutMs: 50 },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout");
  });

  it("retryable 错误重试成功", async () => {
    const provider = new MockProvider({
      retryable: true,
      responses: [
        { throwError: new Error("network down") },
        { text: JSON.stringify({ entities: [] }) },
      ],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(true);
    expect(r.journal.some((j) => j.errorKind === "provider_retryable")).toBe(true);
  });

  it("fatal 错误不重试", async () => {
    const provider = new MockProvider({
      retryable: false,
      responses: [{ throwError: new Error("bad api key") }],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("provider_fatal");
    expect(r.journal).toHaveLength(1);
  });

  it("预算超限 → budget_exceeded", async () => {
    const provider = new MockProvider({ responses: [] });
    const r = await runStep(provider, {
      specRef: "entity_extraction",
      input: "很长的正文".repeat(5000),
      overrides: { maxTokens: 100 },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("budget_exceeded");
  });
});

describe("resolvePolicy(覆盖链, N5)", () => {
  it("空 vault → 默认值(N3)", () => {
    const root = makeRoot();
    const p = resolvePolicy(root);
    expect(p.dedup.l2_threshold).toBe(0.5);
    expect(p.alias.attach_confidence).toBe(0.8);
    expect(p.watch.notify_threshold).toBe(5);
    expect(p.repair.max_rounds).toBe(3);
  });
  it("policy.yml 覆盖 workflow 级键", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".assistant/policy.yml"), "dedup:\n  l2_threshold: 0.7\nwatch:\n  notify_threshold: 9\n");
    const p = resolvePolicy(root);
    expect(p.dedup.l2_threshold).toBe(0.7);
    expect(p.watch.notify_threshold).toBe(9);
    expect(p.alias.attach_confidence).toBe(0.8);
  });
  it("llm.yml 只承载 provider 级键", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".assistant/llm.yml"), "model: deepseek-v4-pro\ntemperature: 0.4\ntimeout_ms: 120000\n");
    const p = resolvePolicy(root);
    expect(p.llm.model).toBe("deepseek-v4-pro");
    expect(p.llm.temperature).toBe(0.4);
    expect(p.llm.timeout_ms).toBe(120000);
  });
  it("calibration.md key: value 显式覆盖进校准表", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".assistant/calibration.md"), "alias_attach_confidence: 0.9\nnote: 此书同名不同人习惯\n");
    const p = resolvePolicy(root);
    expect(p.calibration.alias_attach_confidence).toBe("0.9");
    expect(p.calibration.note).toBe("此书同名不同人习惯");
  });
});

describe("runStep 文本输出(正文类 spec, R3 前置)", () => {
  it("outputFormat=text 跳过 JSON 校验, 结果包 { text }", async () => {
    const { registerSpec } = await import("../src/index");
    registerSpec({
      specRef: "targeted_revision",
      description: "finding-bound 定向返修(catalog §3.4)",
      inputNotes: "冻结正文 + 选定 findings",
      outputSchema: { type: "object" },
      outputFormat: "text",
      budgetTokens: 0,
      temperature: 0.4,
      timeoutMs: 1_800_000,
      degradationNote: "修订只进待审阅候选; 失败不改写正文。",
      contractVersion: "v1",
    });
    const provider = new MockProvider({
      responses: [{ text: "修订后的正文……", usage: { inputTokens: 1, outputTokens: 2 } }],
    });
    const r = await runStep(provider, { specRef: "targeted_revision", input: "原文" });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ text: "修订后的正文……" });
  });
});
