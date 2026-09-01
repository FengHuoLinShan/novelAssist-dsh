// N20 行为契约: 内容手预设卡(解析/校验/查找)+ provider 覆盖直通 + llm.yml preset 键(N5)。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import {
  DEFAULT_CONTENT_PRESETS,
  MockProvider,
  findPreset,
  parseContentPresets,
  resolvePolicy,
  runStep,
  selectEmbeddingInLlmYml,
  selectPresetInLlmYml,
  selectReasoningEffortInLlmYml,
  validateContentPreset,
} from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncp-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("内容手预设卡(N20)", () => {
  it("种子预设四张: default 继承语义 + 三张命名卡(全部通过校验)", () => {
    // D13: 多模型预设保存; default 无 provider/model = 继承插件 Config.llm。
    expect(DEFAULT_CONTENT_PRESETS.map((p) => p.name)).toEqual([
      "default",
      "writing-day",
      "import-day",
      "polish",
    ]);
    for (const p of DEFAULT_CONTENT_PRESETS) {
      expect(validateContentPreset(p)).toEqual([]);
    }
    expect(DEFAULT_CONTENT_PRESETS[0].provider).toBeUndefined();
    for (const p of DEFAULT_CONTENT_PRESETS.slice(1)) {
      expect(p.reasoning_effort).toBe("high");
      expect(p.temperature).toBeUndefined();
    }
  });

  it("校验: name 规则/参数边界(temperature [0,2], top_p [0,1], timeout 上界)", () => {
    expect(validateContentPreset({})).not.toEqual([]);
    expect(validateContentPreset({ name: "带空格 非法" })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", temperature: 2.5 })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", top_p: 1.5 })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", timeout_ms: 500 })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", max_tokens: 200_001 })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", reasoning_effort: "bad effort" })).not.toEqual([]);
    expect(validateContentPreset({ name: "ok", provider: "deepseek", model: "m", temperature: 0.7 })).toEqual([]);
  });

  it("parseContentPresets 宽容解析: 非法条目与同名重复跳过, 不炸", () => {
    const out = parseContentPresets([
      { name: "a", model: "m1" },
      { name: "非法 name!" },
      { name: "a", model: "m2" }, // 同名: 先见优先
      "junk",
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe("m1");
    expect(parseContentPresets([{ name: "b", reasoning_effort: "vendor-max" }])[0].reasoning_effort).toBe("vendor-max");
    expect(parseContentPresets("not-array")).toEqual([]);
  });

  it("findPreset 按名查找; 无名 → undefined(fail-soft 回退由调用方承接)", () => {
    const p = findPreset(DEFAULT_CONTENT_PRESETS, "import-day");
    expect(p?.model).toBe("deepseek-v4-flash");
    expect(findPreset(DEFAULT_CONTENT_PRESETS, "不存在")).toBeUndefined();
  });
});

describe("provider 覆盖直通(N20 接口加法)", () => {
  it("StepRequest.overrides.provider → ProviderRequest.provider", async () => {
    // 断言注释: N20——内容步可指定 DSH provider 路由; 缺省时字段不出现(行为与加法前一致)。
    const mk = () => new MockProvider({ responses: [{ text: '{"findings":[]}' }] });
    const p1 = mk();
    const r = await runStep(p1, {
      specRef: "semantic_review",
      input: "正文",
      overrides: { provider: "kimi-coding", model: "k3", temperature: 0.1 },
    });
    expect(r.ok).toBe(true);
    expect(p1.calls[0].provider).toBe("kimi-coding");
    expect(p1.calls[0].model).toBe("k3");

    const p2 = mk();
    await runStep(p2, { specRef: "semantic_review", input: "正文" });
    expect(p2.calls[0].provider).toBeUndefined(); // 不带 overrides → 字段缺省
  });
});

describe("policy preset 键(N5: llm.yml 只存预设名与参数)", () => {
  it("llm.yml 的 preset 键进 ResolvedPolicy.llm.preset; 缺省 undefined", () => {
    const root = makeRoot();
    expect(resolvePolicy(root).llm.preset).toBeUndefined();
    writeFileSync(paths(root).assistant.llm, 'preset: writing-day\nmodel: deepseek-v4-pro\n', "utf8");
    const p = resolvePolicy(root);
    expect(p.llm.preset).toBe("writing-day");
    expect(p.llm.model).toBe("deepseek-v4-pro");
    expect(p.llm.reasoning_effort).toBeUndefined();
  });

  it("selectPresetInLlmYml 只动 preset 一键(N19): 其余键保留, null 移除, 非法名抛错", () => {
    const root = makeRoot();
    writeFileSync(paths(root).assistant.llm, 'model: m1\ntemperature: 0.5\n', "utf8");
    selectPresetInLlmYml(root, "polish");
    let text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).toContain("preset: polish");
    expect(text).toContain("model: m1");
    expect(text).toContain("temperature: 0.5");
    // 覆盖写(替换而非追加)
    selectPresetInLlmYml(root, "import-day");
    text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).toContain("preset: import-day");
    expect(text).not.toContain("polish");
    // null 移除
    selectPresetInLlmYml(root, null);
    text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).not.toContain("preset:");
    expect(text).toContain("model: m1");
    // 非法名(NAME_RE 防 YAML 注入)
    expect(() => selectPresetInLlmYml(root, "坏: 名字")).toThrow();
  });

  it("selectReasoningEffortInLlmYml 只动 reasoning_effort；非法值零写入", () => {
    const root = makeRoot();
    writeFileSync(paths(root).assistant.llm, 'preset: writing-day\nmodel: m1\n', "utf8");
    selectReasoningEffortInLlmYml(root, "vendor-max");
    let text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).toContain("reasoning_effort: vendor-max");
    expect(text).toContain("preset: writing-day");
    expect(text).toContain("model: m1");
    const before = text;
    expect(() => selectReasoningEffortInLlmYml(root, "bad effort")).toThrow();
    expect(readFileSync(paths(root).assistant.llm, "utf8")).toBe(before);
    selectReasoningEffortInLlmYml(root, null);
    text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).not.toContain("reasoning_effort:");
    expect(text).toContain("model: m1");
  });
});
describe("policy embedding 键 + selectEmbeddingInLlmYml(M6 Track B, L2)", () => {
  it("llm.yml 的 embedding 键进 ResolvedPolicy.llm.embedding; 缺省 undefined", () => {
    const root = makeRoot();
    expect(resolvePolicy(root).llm.embedding).toBeUndefined();
    writeFileSync(paths(root).assistant.llm, 'embedding: bge-local-v1\nmodel: m1\n', "utf8");
    const p = resolvePolicy(root);
    expect(p.llm.embedding).toBe("bge-local-v1");
    expect(p.llm.model).toBe("m1"); // 其他键不受影响
    writeFileSync(paths(root).assistant.llm, 'embedding: off\n', "utf8");
    expect(resolvePolicy(root).llm.embedding).toBe("off");
  });

  it("selectEmbeddingInLlmYml 写/覆盖/null 删除: 只动 embedding 一键", () => {
    const root = makeRoot();
    writeFileSync(paths(root).assistant.llm, 'model: m1\ntemperature: 0.5\n', "utf8");
    selectEmbeddingInLlmYml(root, "bge-local-v1");
    let text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).toContain("embedding: bge-local-v1");
    expect(text).toContain("model: m1");
    expect(text).toContain("temperature: 0.5");
    // 覆盖写(替换而非追加)
    selectEmbeddingInLlmYml(root, "off");
    text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).toContain("embedding: off");
    expect(text).not.toContain("bge-local-v1");
    // null 删除该键
    selectEmbeddingInLlmYml(root, null);
    text = readFileSync(paths(root).assistant.llm, "utf8");
    expect(text).not.toContain("embedding:");
    expect(text).toContain("model: m1");
  });

  it("非法值拒写: 抛错且文件内容不变", () => {
    const root = makeRoot();
    writeFileSync(paths(root).assistant.llm, 'model: m1\n', "utf8");
    const before = readFileSync(paths(root).assistant.llm, "utf8");
    expect(() => selectEmbeddingInLlmYml(root, "bad-value" as never)).toThrow();
    expect(readFileSync(paths(root).assistant.llm, "utf8")).toBe(before); // 未写
  });
});
