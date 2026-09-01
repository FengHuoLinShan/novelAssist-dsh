// R2 行为契约: validator / specs / budget / step / policy
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initVault } from "@novelcraft/vault";
import { estimateTokens, listSpecRefs, loadSpec, registerSpec } from "../src/index";
import type { Provider, ValidatorSchema } from "../src/index";
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
  it("7 个内置 spec 且 outputSchema 可校验", () => {
    expect(listSpecRefs().sort()).toEqual(
      ["dedup_judge", "entity_extraction", "next_chapter_proposal", "rag_rerank", "semantic_review", "structure_analysis", "writing_generate"].sort(),
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
  it("listSpecRefs 含 rag_rerank(M6 N21)", () => {
    expect(listSpecRefs()).toContain("rag_rerank");
  });
  it("loadSpec('rag_rerank') 非空且 outputSchema.required 含 ranked_ids(M6 N21)", () => {
    const spec = loadSpec("rag_rerank");
    expect(spec).toBeDefined();
    expect(spec!.outputSchema.required).toContain("ranked_ids");
    expect(spec!.budgetTokens).toBe(4096); // M7 N24: 2048→4096, 覆盖默认召回集(recall=20 × 200 字)
    expect(spec!.timeoutMs).toBe(120_000);
    expect(spec!.degradationNote).toContain("BM25");
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

  it("repair 多次物理调用的 usage 在顶层累计(RV-12)", async () => {
    const provider = new MockProvider({
      responses: [
        { text: "不是 JSON", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } },
        { text: JSON.stringify({ entities: [] }), usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 5 } },
      ],
    });
    const result = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 6, cacheReadTokens: 8 });
    expect(result.journal.map((entry) => entry.usage)).toEqual([
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
      { inputTokens: 12, outputTokens: 4, cacheReadTokens: 5 },
    ]);
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

  it("AbortError 终态优先于 adapter retryable=true，始终零重试(审查项 6)", async () => {
    let calls = 0;
    const provider: Provider = {
      async complete() {
        calls += 1;
        const err = new Error("调用已被取消(aborted)");
        err.name = "AbortError";
        (err as Error & { retryable: boolean }).retryable = true; // 恶意/错误 adapter 元数据也不得覆盖终态
        throw err;
      },
    };
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("cancelled");
    expect(calls).toBe(1); // 零重试(即使 message 含 "abort", 也不走 retryable 正则)
    expect(r.journal).toHaveLength(1);
  });

  it("retryable provider 错误耗尽尝试 → provider_retryable(非 schema_violation), 保留最后 message", async () => {
    const provider = new MockProvider({
      retryable: true,
      responses: [
        { throwError: new Error("network down") },
        { throwError: new Error("network down") },
      ],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("provider_retryable");
    expect(r.error?.message).toBe("network down");
    expect(r.journal).toHaveLength(2);
    expect(r.journal.every((j) => j.errorKind === "provider_retryable")).toBe(true);
  });

  it("maxTokens 只表示输出预留，不再把较长 raw input 当输出预算拒绝", async () => {
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }) }],
    });
    const r = await runStep(provider, {
      specRef: "entity_extraction",
      input: "正文".repeat(100),
      overrides: { maxTokens: 100 },
    });
    expect(r.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].maxTokens).toBe(100);
  });

  it.each([
    ["max-tokens", "partial", "truncated"],
    ["tool-calls", "", "unexpected_tool_calls"],
    ["stop", "   ", "empty_response"],
    ["missing", "orphan", "protocol_error"],
  ] as const)("finish=%s 不记普通成功", async (finishReason, text, expectedKind) => {
    const provider = new MockProvider({ responses: [{ text, finishReason }] });
    const result = await runStep(provider, {
      specRef: "writing_generate",
      input: "x",
      fixAttempts: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe(expectedKind);
    expect(result.journal[0]).toMatchObject({ finishReason, errorKind: expectedKind });
  });

  it("block 已识别 unexpected_tool_calls 时，即使 finish=stop + text 也不接受 success", async () => {
    const provider = new MockProvider({ responses: [{
      text: "visible but invalid",
      finishReason: "stop",
      textStatus: "present",
      providerOutcome: "unexpected_tool_calls",
    }] });
    const result = await runStep(provider, { specRef: "writing_generate", input: "x", fixAttempts: 0 });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("unexpected_tool_calls");
    expect(result.journal[0]).toMatchObject({
      finishReason: "stop",
      providerOutcome: "unexpected_tool_calls",
      errorKind: "unexpected_tool_calls",
    });
  });

  it("journal 只留输出 hash/长度与完整 usage，不留正文或 reasoning bytes", async () => {
    const provider = new MockProvider({
      responses: [{
        text: "修订后的秘密正文",
        usage: {
          inputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          outputTokens: 9,
          reasoningTokens: 5,
        },
      }],
    });
    const result = await runStep(provider, {
      specRef: "writing_generate",
      input: "x",
      fixAttempts: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputTokens: 9,
      reasoningTokens: 5,
    });
    expect(result.journal[0]).toMatchObject({
      finishReason: "stop",
      textStatus: "present",
      providerOutcome: "success",
      outputChars: 8,
    });
    expect(result.journal[0].outputTextHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.journal[0].providerText).toBeUndefined();
    expect(JSON.stringify(result.journal)).not.toContain("秘密正文");
  });

  it("transport retry 不注入 schema-fix 文案", async () => {
    const provider = new MockProvider({
      retryable: true,
      responses: [
        { throwError: new Error("network down") },
        { text: JSON.stringify({ entities: [] }) },
      ],
    });
    const result = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(result.ok).toBe(true);
    expect(provider.calls[1].messages).toEqual(provider.calls[0].messages);
  });
});

describe("runStep wall-clock 超时兜底(确定性超时契约)", () => {
  it("provider 永不 settle 且忽略 signal → 短 timeout 下按时返回 timeout(真实时钟)", async () => {
    let seenSignal: AbortSignal | undefined;
    const hanging: Provider = {
      complete: (req) => {
        seenSignal = req.signal;
        return new Promise(() => {}); // 永不 settle, 完全忽略 signal
      },
    };
    const t0 = Date.now();
    const r = await runStep(hanging, {
      specRef: "entity_extraction",
      input: "x",
      overrides: { timeoutMs: 50 },
    });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout");
    expect(r.journal[0].errorKind).toBe("timeout");
    expect(seenSignal?.aborted).toBe(true); // 超时同时 abort controller
    expect(elapsed).toBeGreaterThanOrEqual(40); // 确实经过了超时窗口
    expect(elapsed).toBeLessThan(2000); // 合理时间内返回, 而非挂死
  });

  it("快速 provider 不被误判, 且超时 timer 无残留(fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const provider = new MockProvider({
        responses: [{ text: JSON.stringify({ entities: [] }) }],
      });
      const p = runStep(provider, {
        specRef: "entity_extraction",
        input: "x",
        overrides: { timeoutMs: 50 },
      });
      // 不推进 fake timers: 若 runStep 依赖超时 timer 才返回, 此 await 会挂死
      const r = await p;
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0); // 超时 timer 已随竞速结束清理
    } finally {
      vi.useRealTimers();
    }
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
