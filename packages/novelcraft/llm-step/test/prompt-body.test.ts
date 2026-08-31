// M10-A2/A3(N38) 行为契约: promptBody 优先组装 + 输出契约文本注入 + journal 指纹。
// 断言依据: 后续开发计划.md §0.6(模型可见⟺可回放)、§2.A-探测(system 槽纯文本透传)、
// 铁律 4(缺 promptBody 的 legacy 路径字节级不变 —— golden 断言锁定)。
import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  legacySystemPrompt,
  MockProvider,
  outputSchemaHash,
  promptHash,
  registerSpec,
  runStep,
} from "../src/index";
import type { LlmStepSpec } from "../src/index";

const JSON_SPEC: LlmStepSpec = {
  specRef: "m10_probe_json",
  description: "测试 json spec。",
  inputNotes: "测试输入。",
  outputSchema: {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
    additionalProperties: false,
  },
  budgetTokens: 1024,
  temperature: 0.1,
  timeoutMs: 5_000,
  degradationNote: "测试降级。",
  contractVersion: "v1",
};

const TEXT_SPEC: LlmStepSpec = {
  ...JSON_SPEC,
  specRef: "m10_probe_text",
  outputFormat: "text",
};

// 全局注册表不允许重复注册: 模块级一次注册全部测试 spec。
registerSpec(JSON_SPEC);
registerSpec(TEXT_SPEC);
registerSpec({ ...JSON_SPEC, specRef: "m10_probe_body", promptBody: "真实 Prompt 正文。\n规则……" });

function systemOf(call: { messages: Array<{ role: string; content: string }> } | undefined): string {
  const sys = call?.messages.find((m) => m.role === "system");
  return sys?.content ?? "";
}

describe("composeSystemPrompt 组装", () => {
  it("缺 promptBody: legacy 摘要 + 输出契约文本注入(json 形态)", () => {
    const composed = composeSystemPrompt(JSON_SPEC);
    expect(composed.source).toBe("legacy-summary");
    expect(composed.schemaInjection).toBe("text-contract");
    // legacy 文本逐字节保留(golden: 与 M10 前路径一致)
    expect(composed.text.startsWith(legacySystemPrompt(JSON_SPEC))).toBe(true);
    // 输出契约注入: JSON Schema 文本进 system(模型可见)
    expect(composed.text).toContain("OUTPUT_CONTRACT");
    expect(composed.text).toContain(JSON.stringify(JSON_SPEC.outputSchema));
  });

  it("promptBody 优先: 以真实正文为主体, 不再出现 legacy 摘要行", () => {
    const spec: LlmStepSpec = {
      ...JSON_SPEC,
      promptBody: "你是测试内容手,按以下规则输出:\n规则一……",
    };
    const composed = composeSystemPrompt(spec);
    expect(composed.source).toBe("promptBody");
    expect(composed.text.startsWith("你是测试内容手,按以下规则输出:\n规则一……")).toBe(true);
    expect(composed.text).not.toContain(`任务: ${spec.description}`);
    // 输出契约与降级条款仍注入
    expect(composed.text).toContain("OUTPUT_CONTRACT");
    expect(composed.text).toContain(`降级条款(供上层决策, 不由你执行): ${spec.degradationNote}`);
  });

  it("text 输出形态: 不注入输出契约(schemaInjection=none)", () => {
    const composed = composeSystemPrompt(TEXT_SPEC);
    expect(composed.schemaInjection).toBe("none");
    expect(composed.text).not.toContain("OUTPUT_CONTRACT");
    expect(composed.text).toBe(legacySystemPrompt(TEXT_SPEC));
  });

  it("promptBody + text 形态: 正文 + 降级条款, 无契约", () => {
    const spec: LlmStepSpec = { ...TEXT_SPEC, promptBody: "正文输出提示。" };
    const composed = composeSystemPrompt(spec);
    expect(composed.text).toBe(`正文输出提示。\n\n降级条款(供上层决策, 不由你执行): ${spec.degradationNote}`);
  });
});

describe("runStep 模型可见性与 journal 指纹", () => {
  it("schema 真的发给模型: system 消息含 OUTPUT_CONTRACT 与 schema 文本; journal 每条带指纹", async () => {
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ answer: "ok" }) }] });
    const res = await runStep(provider, { specRef: JSON_SPEC.specRef, input: "问题" });
    expect(res.ok).toBe(true);
    // 模型可见性: 捕获的 system 消息包含契约文本
    const system = systemOf(provider.calls[0]);
    expect(system).toContain("OUTPUT_CONTRACT");
    expect(system).toContain('"answer"');
    // journal 指纹: 每条 attempt 带 promptHash + 注入模式, 与组装 hash 一致
    const composed = composeSystemPrompt(JSON_SPEC);
    for (const entry of res.journal) {
      expect(entry.promptHash).toBe(promptHash(composed.text));
      expect(entry.schemaInjection).toBe("text-contract");
    }
    expect(res.promptFingerprint).toEqual({
      systemPromptHash: promptHash(composed.text),
      schemaInjection: "text-contract",
      outputSchemaHash: outputSchemaHash(JSON_SPEC),
    });
  });

  it("promptBody spec: system 以真实正文开头", async () => {
    const spec: LlmStepSpec = { ...JSON_SPEC, specRef: "m10_probe_body", promptBody: "真实 Prompt 正文。\n规则……" };
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ answer: "ok" }) }] });
    const res = await runStep(provider, { specRef: spec.specRef, input: "问题" });
    expect(res.ok).toBe(true);
    const system = systemOf(provider.calls[0]);
    expect(system.startsWith("真实 Prompt 正文。")).toBe(true);
    expect(res.promptFingerprint?.systemPromptHash).toBe(promptHash(composeSystemPrompt(spec).text));
  });

  it("text 形态: system 无契约, 指纹 schemaInjection=none", async () => {
    const provider = new MockProvider({ responses: [{ text: "正文输出" }] });
    const res = await runStep(provider, { specRef: TEXT_SPEC.specRef, input: "问题" });
    expect(res.ok).toBe(true);
    expect(systemOf(provider.calls[0])).not.toContain("OUTPUT_CONTRACT");
    expect(res.promptFingerprint?.schemaInjection).toBe("none");
  });

  it("fix 重试不改变 system(指纹稳定)且失败结果也携带指纹", async () => {
    // 第一次返回非法 JSON, 第二次返回合法
    const provider = new MockProvider({
      responses: [{ text: "不是 JSON" }, { text: JSON.stringify({ answer: "retry-ok" }) }],
    });
    const res = await runStep(provider, { specRef: JSON_SPEC.specRef, input: "问题", fixAttempts: 1 });
    expect(res.ok).toBe(true);
    expect(res.journal).toHaveLength(2);
    const hashes = new Set(res.journal.map((e) => e.promptHash));
    expect(hashes.size).toBe(1);
    // 两次 provider 调用的 system 相同
    expect(provider.calls[0]?.messages[0]?.content).toBe(provider.calls[1]?.messages[0]?.content);

    // 失败路径也带指纹
    const badProvider = new MockProvider({ responses: [{ text: "永远不是 JSON" }] });
    const failed = await runStep(badProvider, { specRef: JSON_SPEC.specRef, input: "问题", fixAttempts: 0 });
    expect(failed.ok).toBe(false);
    expect(failed.error?.kind).toBe("schema_violation");
    expect(failed.promptFingerprint?.schemaInjection).toBe("text-contract");
    expect(failed.promptFingerprint?.systemPromptHash).toBe(promptHash(composeSystemPrompt(JSON_SPEC).text));
  });

  it("M10-A6: 生效参数回执 = spec < executionDefaults < overrides 合并终值, 成功/失败均携带", async () => {
    // spec: temperature 0.1 / timeoutMs 5000; defaults: temperature 0.7 / maxTokens 512 / model;
    // overrides: temperature 0(合法零值不被吞) + model 覆盖。
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ answer: "ok" }) }] });
    provider.executionDefaults = { temperature: 0.7, maxTokens: 512, model: "default-model" };
    const res = await runStep(provider, {
      specRef: JSON_SPEC.specRef,
      input: "问题",
      overrides: { temperature: 0, model: "req-model" },
    });
    expect(res.ok).toBe(true);
    expect(res.effective).toEqual({
      model: "req-model",
      temperature: 0,
      maxTokens: 512,
      timeoutMs: 5000,
    });
    // provider 实际收到的请求与回执一致(可回放)
    expect(provider.calls[0]?.temperature).toBe(0);
    expect(provider.calls[0]?.model).toBe("req-model");
    expect(provider.calls[0]?.maxTokens).toBe(512);

    // 失败路径也携带
    const bad = new MockProvider({ responses: [{ text: "坏" }] });
    const failed = await runStep(bad, { specRef: JSON_SPEC.specRef, input: "问题", fixAttempts: 0 });
    expect(failed.ok).toBe(false);
    expect(failed.effective?.timeoutMs).toBe(5000);
  });
});
