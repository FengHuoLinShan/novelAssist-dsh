// ExecutionProfile seam 行为契约(N34 / ADR-0023 §6 + spec 要求 + 独立审查 P1/P2/P3):
// 白名单类型、严格范围校验、深冻结、稳定 canonical JSON + sha256 fingerprint、
// 未知/secret 字段不进指纹、非法 fail-closed、profile 默认 ← 请求 override 优先、
// runStep 签名不变; P1 白名单运行时不可变(防 push 注入 secret 键)、
// P2 plain data 单次快照(防 getter/Proxy TOCTOU, 异常不泄漏 secret)、
// P3 固定 SHA-256 回归向量(0307f8…)。
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROFILE_WHITELIST,
  applyExecutionProfileToRequest,
  canonicalProfileJson,
  contractVersionsFromSpecs,
  createWorkflowBudget,
  fingerprintExecutionProfile,
  isExecutionProfile,
  parseExecutionProfile,
  validateExecutionProfile,
  ProfileValidationError,
} from "../src/index";
import { MockProvider, runStep } from "../src/index";
import type { ExecutionProfile, Provider } from "../src/index";

// N34: 编排级执行默认(含 timeout/预算); 白名单仅非 secret 键(铁律 6/N5: Key 永不进文件/类型)。
const valid = {
  version: "1.0.0",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  temperature: 0.3,
  maxTokens: 8192,
  timeoutMs: 300_000,
  workflowBudget: 200_000,
  policy: "import-day",
  contractVersions: { "prompt-contracts": "v1", journal: "v2" },
  source: ".assistant/execution-profile.yml",
};

describe("parseExecutionProfile(严格白名单校验 + 深冻结, N34 §6)", () => {
  it("合法对象 → 逐层深冻结的不可变 profile", () => {
    const p = parseExecutionProfile(valid);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.contractVersions)).toBe(true); // 嵌套对象同样冻结
    // 冻结对象赋值在严格模式(ESM)下抛 TypeError, 值保持不变
    expect(() => {
      (p as unknown as Record<string, unknown>).temperature = 0.9;
    }).toThrow();
    expect(p.temperature).toBe(0.3);
  });

  it("parse 重建为纯白名单键对象(结果不含输入多余的自身键)", () => {
    const p = parseExecutionProfile(valid);
    expect(Object.keys(p).sort()).toEqual([
      "contractVersions",
      "maxTokens",
      "model",
      "policy",
      "provider",
      "source",
      "temperature",
      "timeoutMs",
      "version",
      "workflowBudget",
    ]);
  });

  it("非法输入一律抛 ProfileValidationError(fail-closed, 不带半解析配置跑)", () => {
    const invalids: Array<[string, unknown]> = [
      ["非对象(字符串)", "1.0.0"],
      ["数组", [valid]],
      ["null", null],
      ["temperature 越界(负)", { ...valid, temperature: -0.1 }],
      ["temperature 越界(>2)", { ...valid, temperature: 2.1 }],
      ["temperature NaN", { ...valid, temperature: NaN }],
      ["temperature 非数字", { ...valid, temperature: "0.3" }],
      ["maxTokens 0(须省略才不限)", { ...valid, maxTokens: 0 }],
      ["maxTokens 非整数", { ...valid, maxTokens: 8192.5 }],
      ["maxTokens 超出上界", { ...valid, maxTokens: 200_001 }],
      ["timeoutMs 低于 1000", { ...valid, timeoutMs: 999 }],
      ["timeoutMs 超出上界", { ...valid, timeoutMs: 3_600_001 }],
      ["workflowBudget 0", { ...valid, workflowBudget: 0 }],
      ["workflowBudget 非整数", { ...valid, workflowBudget: 12.5 }],
      ["version 缺失", { provider: "deepseek" }],
      ["version 非版本形态", { ...valid, version: "a.b.c" }],
      ["provider 空串", { ...valid, provider: "" }],
      ["provider 含空白", { ...valid, provider: "deep seek" }],
      ["model 空串", { ...valid, model: "" }],
      ["policy 含空白", { ...valid, policy: "import day" }],
      ["contractVersions 值非字符串", { ...valid, contractVersions: { a: 1 } }],
      ["contractVersions 非对象", { ...valid, contractVersions: "v1" }],
      ["source 含控制字符", { ...valid, source: "a\u0000b" }],
    ];
    for (const [label, v] of invalids) {
      expect(validateExecutionProfile(v).length, label).toBeGreaterThan(0);
      expect(() => parseExecutionProfile(v), label).toThrow(ProfileValidationError);
    }
  });

  it("部分合法字段也能通过(最小合法 profile = 仅 version)", () => {
    const p = parseExecutionProfile({ version: "1.0.0" });
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.version).toBe("1.0.0");
    expect(p.temperature).toBeUndefined();
  });
});

describe("opaque provenance brand(审查项 1: 普通对象不可伪造; brand 只能由解析器产生)", () => {
  it("parseExecutionProfile 产出 → isExecutionProfile 为 true; 普通对象/原始值一律 false", () => {
    expect(isExecutionProfile(parseExecutionProfile(valid))).toBe(true);
    expect(isExecutionProfile(parseExecutionProfile({ version: "1.0.0" }))).toBe(true);
    // 普通对象(即使字段全合法)不是解析器产出 → false
    expect(isExecutionProfile(valid)).toBe(false);
    expect(isExecutionProfile({ ...valid })).toBe(false);
    expect(isExecutionProfile(null)).toBe(false);
    expect(isExecutionProfile("1.0.0")).toBe(false);
    expect(isExecutionProfile(undefined)).toBe(false);
    expect(isExecutionProfile(42)).toBe(false);
  });

  it("伪造手法全部失败: 展开副本/Object.create/Proxy/已冻结普通对象都拿不到 brand", () => {
    const p = parseExecutionProfile(valid);
    // 展开副本: 新对象, 不在 WeakSet → false
    expect(isExecutionProfile({ ...p })).toBe(false);
    // Object.create 继承: 同一性不同 → false
    expect(isExecutionProfile(Object.create(p))).toBe(false);
    // 冻结的普通对象: 冻结 ≠ brand → false
    const frozenPlain = Object.freeze({ ...valid });
    expect(Object.isFrozen(frozenPlain)).toBe(true);
    expect(isExecutionProfile(frozenPlain)).toBe(false);
    // Proxy 转发到 brand 对象: 代理对象自身不在 WeakSet → false
    const proxied = new Proxy(p, {});
    expect(isExecutionProfile(proxied)).toBe(false);
    // 数组/函数等非普通对象 → false
    expect(isExecutionProfile([parseExecutionProfile(valid)])).toBe(false);
  });

  it("brand 按对象同一性保持: 同一解析对象多次判定一致(内部透传可验证)", () => {
    const p = parseExecutionProfile(valid);
    expect(isExecutionProfile(p)).toBe(true);
    expect(isExecutionProfile(p)).toBe(true);
  });

  it("canonical/fingerprint 不要求 brand(纯内容投影), 但 brand 对象的值与其一致", () => {
    const p = parseExecutionProfile(valid);
    expect(canonicalProfileJson(p)).toBe(canonicalProfileJson(valid));
    expect(fingerprintExecutionProfile(p)).toBe(fingerprintExecutionProfile(valid));
  });
});

describe("top_p 进入 core strict 参数面与 fingerprint(审查项 4)", () => {
  it("合法 top_p(含零值)解析进 profile", () => {
    const p = parseExecutionProfile({ ...valid, top_p: 0.8 });
    expect(p.top_p).toBe(0.8);
    const zero = parseExecutionProfile({ ...valid, top_p: 0 });
    expect(zero.top_p).toBe(0); // 合法零值不被吞
  });

  it("非法 top_p(越界/非数字/NaN)→ fail-closed 拒绝", () => {
    const invalids: Array<[string, unknown]> = [
      ["top_p 越界(>1)", { ...valid, top_p: 1.01 }],
      ["top_p 越界(负)", { ...valid, top_p: -0.1 }],
      ["top_p NaN", { ...valid, top_p: NaN }],
      ["top_p 非数字", { ...valid, top_p: "0.8" }],
    ];
    for (const [label, v] of invalids) {
      expect(validateExecutionProfile(v).some((s) => s.includes("top_p")), label).toBe(true);
      expect(() => parseExecutionProfile(v), label).toThrow(ProfileValidationError);
    }
  });

  it("top_p 进入 canonical JSON 与 fingerprint(配置身份敏感; 变化即指纹变化)", () => {
    const base = parseExecutionProfile(valid);
    const withTopP = parseExecutionProfile({ ...valid, top_p: 0.8 });
    expect(canonicalProfileJson(withTopP)).toContain('"top_p":0.8');
    expect(canonicalProfileJson(base)).not.toContain("top_p");
    expect(fingerprintExecutionProfile(withTopP)).not.toBe(fingerprintExecutionProfile(base));
    // 同值幂等
    expect(fingerprintExecutionProfile(withTopP)).toBe(
      fingerprintExecutionProfile(parseExecutionProfile({ ...valid, top_p: 0.8 })),
    );
  });

  it("applyExecutionProfileToRequest: top_p 与 temperature 同级继承, 请求 override 优先(含零值)", () => {
    const p = parseExecutionProfile({ ...valid, top_p: 0.9 });
    const req = applyExecutionProfileToRequest(p, { specRef: "x", input: "y" });
    expect(req.overrides?.top_p).toBe(0.9);
    // 请求 override 优先; top_p=0 不被 profile 默认吞掉
    const req0 = applyExecutionProfileToRequest(p, {
      specRef: "x",
      input: "y",
      overrides: { top_p: 0 },
    });
    expect(req0.overrides?.top_p).toBe(0);
    const reqO = applyExecutionProfileToRequest(p, {
      specRef: "x",
      input: "y",
      overrides: { top_p: 0.2 },
    });
    expect(reqO.overrides?.top_p).toBe(0.2);
  });

  it("runStep 贯通: profile.top_p 经 executionDefaults 进入 ProviderRequest(零值不被吞)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider: Provider = {
      executionDefaults: { top_p: 0.8 },
      async complete(req) {
        seen.push({ top_p: req.top_p, temperature: req.temperature });
        return { text: JSON.stringify({ entities: [] }) };
      },
    };
    await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(seen[0].top_p).toBe(0.8);
    // 请求 override top_p=0 优先于 defaults
    await runStep(provider, { specRef: "entity_extraction", input: "x", overrides: { top_p: 0 } });
    expect(seen[1].top_p).toBe(0);
  });
});

describe("reasoning_effort 不透明传输与真实 prepared receipt(M3a)", () => {
  it("合法 id 进入 profile/fingerprint；请求 override 优先；非法空白 id 拒绝", () => {
    const profile = parseExecutionProfile({ ...valid, reasoning_effort: "adapter-high" });
    expect(profile.reasoning_effort).toBe("adapter-high");
    expect(canonicalProfileJson(profile)).toContain('"reasoning_effort":"adapter-high"');
    expect(fingerprintExecutionProfile(profile)).not.toBe(
      fingerprintExecutionProfile(parseExecutionProfile(valid)),
    );
    expect(applyExecutionProfileToRequest(profile, { specRef: "x", input: "y" }).overrides)
      .toMatchObject({ reasoning_effort: "adapter-high" });
    expect(applyExecutionProfileToRequest(profile, {
      specRef: "x",
      input: "y",
      overrides: { reasoning_effort: "adapter-max" },
    }).overrides?.reasoning_effort).toBe("adapter-max");
    for (const reasoning_effort of ["", "bad effort", "x".repeat(65)]) {
      expect(() => parseExecutionProfile({ ...valid, reasoning_effort })).toThrow(ProfileValidationError);
    }
  });

  it("runStep 分开记录 requested/effective/source/context，journal 保存物理调用回执", async () => {
    const provider: Provider = {
      executionDefaults: { provider: "fake", model: "requested-model", reasoning_effort: "adapter-high" },
      async complete(req) {
        return {
          text: JSON.stringify({ entities: [] }),
          callReceipt: {
            provider: "fake",
            model: "resolved-model",
            requestedEffort: req.reasoning_effort,
            effectiveEffort: "adapter-high",
            effortSource: "request",
            contextWindow: 1_000_000,
            contextWindowKnown: true,
          },
        };
      },
    };
    const result = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(result.effective).toMatchObject({
      provider: "fake",
      model: "resolved-model",
      requested_effort: "adapter-high",
      effective_effort: "adapter-high",
      effort_source: "request",
      context_window: 1_000_000,
      context_window_status: "known",
    });
    expect(result.journal[0].callReceipt).toMatchObject({
      effectiveEffort: "adapter-high",
      contextWindowKnown: true,
    });
  });
});

describe("EXECUTION_PROFILE_WHITELIST 运行时不可变(P1: 防 push 注入 secret 键)", () => {
  it("导出常量是真正冻结的 readonly 数组: push 篡改抛 TypeError 且内容不变", () => {
    expect(Object.isFrozen(EXECUTION_PROFILE_WHITELIST)).toBe(true);
    expect(() => {
      (EXECUTION_PROFILE_WHITELIST as unknown as string[]).push("apiKey");
    }).toThrow(TypeError);
    expect([...EXECUTION_PROFILE_WHITELIST]).toEqual([
      "version",
      "provider",
      "model",
      "reasoning_effort",
      "temperature",
      "top_p",
      "maxTokens",
      "timeoutMs",
      "workflowBudget",
      "policy",
      "contractVersions",
      "source",
    ]);
    expect(EXECUTION_PROFILE_WHITELIST).toHaveLength(12);
    expect(EXECUTION_PROFILE_WHITELIST).not.toContain("apiKey");
  });

  it("splice 等其余可变操作同样失效(不可变契约)", () => {
    expect(() => {
      (EXECUTION_PROFILE_WHITELIST as unknown as string[]).splice(0, 1);
    }).toThrow(TypeError);
    expect(EXECUTION_PROFILE_WHITELIST).toHaveLength(12);
  });

  it("篡改失败后安全语义不变: 投影面仍只 pick 非 secret 白名单键, secret 不进指纹", () => {
    expect(() => {
      (EXECUTION_PROFILE_WHITELIST as unknown as string[]).push("apiKey");
    }).toThrow(TypeError);
    const withSecret = {
      ...valid,
      apiKey: "sk-very-secret-value",
      password: "hunter2",
    } as unknown as ExecutionProfile;
    const cj = canonicalProfileJson(withSecret);
    expect(cj).not.toContain("apiKey");
    expect(cj).not.toContain("sk-very-secret-value");
    expect(cj).not.toContain("password");
    expect(cj).toBe(canonicalProfileJson(parseExecutionProfile(valid)));
    expect(fingerprintExecutionProfile(withSecret)).toBe(fingerprintExecutionProfile(parseExecutionProfile(valid)));
  });
});

describe("plain data 快照 + TOCTOU/accessor/Proxy 防御(P2: 独立审查)", () => {
  it("顶层 getter 字段被拒: 快照阶段即拒绝, getter 一次都不会被调用", () => {
    let calls = 0;
    const evil = {
      _version: "1.0.0",
      get version() {
        calls += 1;
        return calls > 1 ? "2.0.0" : this._version; // 旧实现: validate 读 1.0.0、parse 读 2.0.0
      },
    };
    expect(validateExecutionProfile(evil).length).toBeGreaterThan(0);
    expect(() => parseExecutionProfile(evil)).toThrow(ProfileValidationError);
    expect(calls).toBe(0);
  });

  it("getter 抛异常 → ProfileValidationError, 原始异常文本(可能含 secret)不外泄", () => {
    const boom = {
      get version() {
        throw new Error("SECRET-TOKEN-LEAK");
      },
    };
    expect(() => parseExecutionProfile(boom)).toThrow(ProfileValidationError);
    expect(() => parseExecutionProfile(boom)).not.toThrow(/SECRET-TOKEN-LEAK/);
  });

  it("accessor descriptor(get+set)同样被拒(own data descriptor 硬性要求)", () => {
    const o: Record<string, unknown> = { _v: "1.0.0" };
    Object.defineProperty(o, "version", {
      get() {
        return o._v;
      },
      set(x: string) {
        o._v = x;
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateExecutionProfile(o).length).toBeGreaterThan(0);
    expect(() => parseExecutionProfile(o)).toThrow(ProfileValidationError);
  });

  it("contractVersions 内层 accessor 同样被拒(防内层 TOCTOU)", () => {
    const inner: Record<string, unknown> = { _a: "v1" };
    Object.defineProperty(inner, "a", {
      get() {
        inner._a = "v2"; // 每次读都换值
        return inner._a;
      },
      enumerable: true,
      configurable: true,
    });
    const v = { version: "1.0.0", contractVersions: inner };
    expect(validateExecutionProfile(v).length).toBeGreaterThan(0);
    expect(() => parseExecutionProfile(v)).toThrow(ProfileValidationError);
  });

  it("Proxy(转发到 plain target)按单次快照解析, 结果与原文等价(快照不二次索引源对象)", () => {
    const proxied = new Proxy(valid, {
      get: (t, k) => Reflect.get(t, k),
      ownKeys: (t) => Reflect.ownKeys(t),
      getOwnPropertyDescriptor: (t, k) => Reflect.getOwnPropertyDescriptor(t, k),
      getPrototypeOf: (t) => Reflect.getPrototypeOf(t),
    });
    expect(parseExecutionProfile(proxied)).toEqual(parseExecutionProfile(valid));
    expect(fingerprintExecutionProfile(parseExecutionProfile(proxied))).toBe(
      fingerprintExecutionProfile(parseExecutionProfile(valid)),
    );
  });

  it("Proxy trap 抛异常(revoked) → ProfileValidationError, revoked 原始文本不外泄", () => {
    const { proxy, revoke } = Proxy.revocable(valid, {});
    revoke();
    expect(() => parseExecutionProfile(proxy)).toThrow(ProfileValidationError);
    expect(() => parseExecutionProfile(proxy)).not.toThrow(/revoked/i);
  });

  it("非 plain 对象(class 实例 / 自定义原型)被拒; null 原型 plain 对象被接受", () => {
    class ProfileLike {
      version = "1.0.0";
    }
    expect(() => parseExecutionProfile(new ProfileLike())).toThrow(ProfileValidationError);
    const customProto = { inherited: "x" };
    const withProto = Object.create(customProto);
    withProto.version = "1.0.0";
    expect(() => parseExecutionProfile(withProto)).toThrow(ProfileValidationError);
    // null 原型对象仍是合法 plain data
    const nullProto = Object.assign(Object.create(null), valid);
    expect(parseExecutionProfile(nullProto)).toEqual(parseExecutionProfile(valid));
  });

  it("own __proto__ data 键以 defineProperty 落快照键(不污染原型), 按未知字段拒绝", () => {
    const v: Record<string, unknown> = { version: "1.0.0" };
    Object.defineProperty(v, "__proto__", {
      value: "polluted",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(validateExecutionProfile(v).some((s) => s.includes("__proto__"))).toBe(true);
    expect(() => parseExecutionProfile(v)).toThrow(/未知字段: __proto__/);
  });

  it("环引用(contractVersions 自引用)被拒, 不挂死", () => {
    const cv: Record<string, unknown> = {};
    cv.self = cv;
    const v = { version: "1.0.0", contractVersions: cv };
    expect(validateExecutionProfile(v).length).toBeGreaterThan(0);
    expect(() => parseExecutionProfile(v)).toThrow(ProfileValidationError);
  });

  it("TOCTOU 场景不复现: 不可能「校验通过、解析读到另一份数据」", () => {
    // 旧实现: validate 读 version=1.0.0 通过, parse 二次读 getter 变 2.0.0 → 解析结果与校验不一致。
    // 新实现: accessor 输入在单次快照阶段即被拒绝, 校验与复制共用同一快照。
    const evil: Record<string, unknown> = { _v: "1.0.0" };
    Object.defineProperty(evil, "version", {
      get() {
        const cur = evil._v;
        evil._v = "2.0.0";
        return cur;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => parseExecutionProfile(evil)).toThrow(ProfileValidationError);
  });
});

describe("canonical JSON + sha256 fingerprint(稳定/敏感/secret 排除, N34 §4 config fingerprint)", () => {
  it("canonical JSON 为紧凑排序格式(键序与对象字面量键序无关)", () => {
    const json = canonicalProfileJson(parseExecutionProfile(valid));
    expect(json).toBe(
      '{"contractVersions":{"journal":"v2","prompt-contracts":"v1"},"maxTokens":8192,"model":"deepseek-v4-pro","policy":"import-day","provider":"deepseek","source":".assistant/execution-profile.yml","temperature":0.3,"timeoutMs":300000,"version":"1.0.0","workflowBudget":200000}',
    );
    // 同一内容、键插入顺序相反 → 输出逐字节一致(稳定键序)
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(valid).reverse()) reordered[k] = (valid as Record<string, unknown>)[k];
    expect(canonicalProfileJson(parseExecutionProfile(reordered))).toBe(json);
  });

  it("fingerprint 与键序无关(仅内容决定)", () => {
    const a = fingerprintExecutionProfile(parseExecutionProfile(valid));
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(valid).reverse()) reordered[k] = (valid as Record<string, unknown>)[k];
    const b = fingerprintExecutionProfile(parseExecutionProfile(reordered));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("任一字段变化 → fingerprint 变化(变更敏感)", () => {
    const fp = fingerprintExecutionProfile;
    const base = fp(parseExecutionProfile(valid));
    expect(fp(parseExecutionProfile({ ...valid, temperature: 0.7 }))).not.toBe(base);
    expect(fp(parseExecutionProfile({ ...valid, maxTokens: 16_000 }))).not.toBe(base);
    expect(fp(parseExecutionProfile({ ...valid, source: "other.yml" }))).not.toBe(base);
    expect(fp(parseExecutionProfile({ version: "1.0.0" }))).not.toBe(base); // 字段增减也敏感
  });

  it("未知/secret 字段绝不进入指纹与 canonical JSON(投影只取白名单)", () => {
    const clean = parseExecutionProfile(valid);
    // 绕过 parse 直构的运行时对象(模拟被附加 secret 键)
    const withSecret = {
      ...valid,
      apiKey: "sk-very-secret-value",
      password: "hunter2",
    } as unknown as ExecutionProfile;
    const cj = canonicalProfileJson(withSecret);
    expect(cj).not.toContain("sk-very-secret-value");
    expect(cj).not.toContain("apiKey");
    expect(cj).not.toContain("password");
    expect(cj).toBe(canonicalProfileJson(clean));
    expect(fingerprintExecutionProfile(withSecret)).toBe(fingerprintExecutionProfile(clean));
  });

  it("配置面白名单外键被 parse 拒绝(fail-closed, 与指纹排除双保险)", () => {
    const issues = validateExecutionProfile({ ...valid, apiKey: "sk-x" });
    expect(issues.some((s) => s.includes("apiKey"))).toBe(true);
    expect(() => parseExecutionProfile({ ...valid, apiKey: "sk-x" })).toThrow(/未知字段: apiKey/);
  });

  it("fingerprint 纯 hex、同输入幂等", () => {
    const p = parseExecutionProfile(valid);
    expect(fingerprintExecutionProfile(p)).toBe(fingerprintExecutionProfile(parseExecutionProfile(valid)));
  });

  it("固定 SHA-256 回归向量(P3): valid profile 指纹 == 0307f8…(锁定 canonical 序列化)", () => {
    // sha256(canonical 白名单投影) 的确定性回归锚点: 任何 canonical 序列化/键序/转义
    // 改动都会改变此向量 → 立即暴露, 防静默漂移。
    expect(fingerprintExecutionProfile(parseExecutionProfile(valid))).toBe(
      "0307f8212c353996e0055c4a5c4ea1264c3edc99cbf1c6183da2aac2b3c27094",
    );
  });
});

describe("applyExecutionProfileToRequest(profile 默认 ← 请求 override 优先, N34 §6 / N20)", () => {
  const profile = parseExecutionProfile(valid);

  it("profile 填充请求缺失的执行默认(provider/model/temperature/maxTokens/timeoutMs)", () => {
    const req = applyExecutionProfileToRequest(profile, { specRef: "entity_extraction", input: "x" });
    expect(req.overrides).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      temperature: 0.3,
      maxTokens: 8192,
      timeoutMs: 300_000,
    });
  });

  it("请求级 override 优先于 profile 默认", () => {
    const req = applyExecutionProfileToRequest(profile, {
      specRef: "entity_extraction",
      input: "x",
      overrides: { temperature: 0.9, maxTokens: 1 },
    });
    expect(req.overrides?.temperature).toBe(0.9);
    expect(req.overrides?.maxTokens).toBe(1);
    // 未覆盖的仍继承 profile
    expect(req.overrides?.timeoutMs).toBe(300_000);
    expect(req.overrides?.provider).toBe("deepseek");
    expect(req.overrides?.model).toBe("deepseek-v4-pro");
  });

  it("temperature=0 等合法零值不被默认吞掉(显式 undefined 判断, 非 truthiness)", () => {
    const req = applyExecutionProfileToRequest(profile, {
      specRef: "x",
      input: "y",
      overrides: { temperature: 0 },
    });
    expect(req.overrides?.temperature).toBe(0);
  });

  it("非执行字段原样透传; 编排级元数据不外泄到请求", () => {
    const req = applyExecutionProfileToRequest(profile, {
      specRef: "rag_rerank",
      input: "in",
      fixAttempts: 3,
    });
    expect(req.specRef).toBe("rag_rerank");
    expect(req.input).toBe("in");
    expect(req.fixAttempts).toBe(3);
    expect(Object.keys(req.overrides ?? {}).sort()).toEqual([
      "maxTokens",
      "model",
      "provider",
      "temperature",
      "timeoutMs",
    ]);
    expect(JSON.stringify(req.overrides)).not.toContain("workflowBudget");
    expect(JSON.stringify(req.overrides)).not.toContain("contractVersions");
    expect(JSON.stringify(req.overrides)).not.toContain("policy");
    expect(JSON.stringify(req.overrides)).not.toContain("source");
    expect(JSON.stringify(req.overrides)).not.toContain("version");
  });

  it("空 profile + 无请求 override → 空 overrides(不注入任何内容)", () => {
    const empty = parseExecutionProfile({ version: "1.0.0" });
    const req = applyExecutionProfileToRequest(empty, { specRef: "x", input: "y" });
    expect(req.overrides).toEqual({});
  });
});

describe("profile 继承贯通 runStep(签名不变, ADR-0023 §6 编排默认)", () => {
  it("profile.timeoutMs 作为默认超时被 runStep 消费(请求无 override)", async () => {
    const profile = parseExecutionProfile({ version: "1.0.0", timeoutMs: 1000 });
    // provider 永不 settle: 若 profile 默认未被继承, runStep 会按 spec 的 600s 挂死
    const hanging: Provider = { complete: () => new Promise(() => {}) };
    const r = await runStep(
      hanging,
      applyExecutionProfileToRequest(profile, { specRef: "entity_extraction", input: "x" }),
    );
    // 继承 profile 的 1000ms 而非 spec 默认的 600s
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout");
  });

  it("请求级 timeoutMs 覆盖 profile 默认(override 优先贯通到执行)", async () => {
    const profile = parseExecutionProfile({ version: "1.0.0", timeoutMs: 1000 });
    // provider 80ms 返回: 被请求级 50ms override 掐断 → timeout;
    // 若 override 被忽略(profile 1000ms)则会成功返回
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }), delayMs: 80 }],
    });
    const r = await runStep(
      provider,
      applyExecutionProfileToRequest(profile, {
        specRef: "entity_extraction",
        input: "x",
        overrides: { timeoutMs: 50 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout");
  });

  it("profile.model 默认注入 provider 调用(经 overrides 链)", async () => {
    const profile = parseExecutionProfile({ version: "1.0.0", model: "deepseek-v4-flash" });
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }) }],
    });
    // 用不注入的调用做对照: 无 profile 时不带 model
    const naked = new MockProvider({ responses: [{ text: JSON.stringify({ entities: [] }) }] });
    await runStep(provider, applyExecutionProfileToRequest(profile, { specRef: "entity_extraction", input: "x" }));
    await runStep(naked, { specRef: "entity_extraction", input: "x" });
    expect(provider.calls[0].model).toBe("deepseek-v4-flash");
    expect(naked.calls[0].model).toBeUndefined();
  });

  it("runStep 签名不变: 注入后的请求仍可直接传给 runStep(类型层面由编译保证)", () => {
    const profile = parseExecutionProfile(valid);
    const req = applyExecutionProfileToRequest(profile, { specRef: "entity_extraction", input: "x" });
    // 仅类型契约断言: req 是完整 StepRequest, runStep(provider, req) 可编译
    const _check: Parameters<typeof runStep>[1] = req;
    void _check;
  });
});
describe("contractVersions 敏感键/自由 secret 拒绝(R6: 独立审查 P2/R6)", () => {
  it("secret 形态键(api_key/token/password/bearer)→ parse 拒绝(敏感键不进指纹)", () => {
    const secrets = ["api_key", "apiKey", "token", "access_token", "password", "bearer", "client_secret", "privateKey"];
    for (const key of secrets) {
      const v = { version: "1.0.0", contractVersions: { [key]: "v1" } };
      const issues = validateExecutionProfile(v);
      expect(issues.some((s) => s.includes("敏感键")), key).toBe(true);
      expect(() => parseExecutionProfile(v), key).toThrow(ProfileValidationError);
    }
  });

  it("自由 secret 值不进指纹: 敏感键被拒后 canonical/fingerprint 不含其值", () => {
    const v = { version: "1.0.0", contractVersions: { token: "sk-very-secret-value" } };
    expect(() => parseExecutionProfile(v)).toThrow(/敏感键/);
  });

  it("非标识符形态键(含空格/控制符)→ 拒绝", () => {
    const v = { version: "1.0.0", contractVersions: { "bad key": "v1" } };
    expect(validateExecutionProfile(v).length).toBeGreaterThan(0);
    expect(() => parseExecutionProfile(v)).toThrow(ProfileValidationError);
  });

  it("合法契约键(prompt-contracts/entity_extraction/journal)→ 通过并进指纹", () => {
    const v = {
      version: "1.0.0",
      contractVersions: { "prompt-contracts": "v1", entity_extraction: "v1", journal: "v2" },
    };
    const p = parseExecutionProfile(v);
    expect(p.contractVersions).toEqual({
      "prompt-contracts": "v1",
      entity_extraction: "v1",
      journal: "v2",
    });
  });
});

describe("contractVersionsFromSpecs(spec registry 构造, R6/P5 确定性)", () => {
  it("缺省 = 内置注册表(编译期恒定, 不随运行时注册状态漂移)", () => {
    const a = contractVersionsFromSpecs();
    // 覆盖内置 refs: 每个 ref → 其 contractVersion; canonical 指纹按键排序, 内容确定。
    expect(a.entity_extraction).toBe("v1");
    expect(a.semantic_review).toBe("v1");
    expect(Object.keys(a)).toEqual(expect.arrayContaining([
      "entity_extraction",
      "dedup_judge",
      "semantic_review",
      "structure_analysis",
      "next_chapter_proposal",
      "writing_generate",
      "rag_rerank",
    ]));
    // 再调一次结果逐字节一致(确定性)。
    expect(contractVersionsFromSpecs()).toEqual(a);
  });

  it("显式 ref 集: 未注册 ref → 抛错 fail-closed(不带半解析契约集跑)", () => {
    expect(() => contractVersionsFromSpecs(["entity_extraction", "no_such_spec"])).toThrow(
      /spec 未注册/,
    );
  });

  it("显式 ref 集可覆盖包级 spec(如 deep import 固定集)", () => {
    const out = contractVersionsFromSpecs(["entity_extraction", "semantic_review"]);
    expect(out).toEqual({ entity_extraction: "v1", semantic_review: "v1" });
  });
});

describe("Provider.executionDefaults 合并链(独立审查 P2: spec < defaults < overrides, 裸 runStep 继承)", () => {
  const hanging: Provider = { complete: () => new Promise(() => {}) };

  it("裸 runStep 经 provider.executionDefaults 继承 timeout(不挂死)", async () => {
    const provider: Provider = {
      executionDefaults: { timeoutMs: 1000 },
      complete: () => new Promise(() => {}),
    };
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout"); // 继承 1000ms 而非 spec 600s
  });

  it("spec 默认 < executionDefaults < 请求 override(逐层优先)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider: Provider = {
      executionDefaults: { temperature: 0.7, maxTokens: 100, timeoutMs: 2000, model: "dflt-model" },
      async complete(req) {
        calls.push({ temperature: req.temperature, maxTokens: req.maxTokens, model: req.model });
        return { text: JSON.stringify({ entities: [] }) };
      },
    };
    // 无请求 override: defaults 生效(覆盖 spec 的 temperature 0.3/budget 32768)
    await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(calls[0]).toEqual({ temperature: 0.7, maxTokens: 100, model: "dflt-model" });
    // 请求 override 优先(含合法零值 temperature=0)
    await runStep(provider, {
      specRef: "entity_extraction",
      input: "x",
      overrides: { temperature: 0, maxTokens: 200, model: "req-model" },
    });
    expect(calls[1]).toEqual({ temperature: 0, maxTokens: 200, model: "req-model" });
    // 部分 override: 未覆盖的仍继承 defaults
    await runStep(provider, { specRef: "entity_extraction", input: "x", overrides: { model: "m2" } });
    expect(calls[2]).toEqual({ temperature: 0.7, maxTokens: 100, model: "m2" });
  });

  it("无 executionDefaults 的裸 provider: 行为与旧版一致(spec 默认)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider: Provider = {
      async complete(req) {
        calls.push({ temperature: req.temperature, maxTokens: req.maxTokens });
        return { text: JSON.stringify({ entities: [] }) };
      },
    };
    await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(calls[0]).toEqual({ temperature: 0.3, maxTokens: 32768 }); // spec 默认
  });
});

describe("workflowBudget 累计 guard seam(N34 workflowBudget: 至少提供累计 guard)", () => {
  it("createWorkflowBudget: 总量校验 + trySpend 不部分消费", () => {
    expect(() => createWorkflowBudget(0)).toThrow(/workflowBudget 必须是 ≥1 的整数/);
    expect(() => createWorkflowBudget(1.5)).toThrow();
    const b = createWorkflowBudget(100);
    expect(b.remaining).toBe(100);
    expect(b.trySpend(60)).toBe(true);
    expect(b.spent).toBe(60);
    expect(b.trySpend(50)).toBe(false); // 超支: 不扣减
    expect(b.spent).toBe(60);
    expect(b.remaining).toBe(40);
  });

  it("runStep(budget): 累计超支 → 在 provider 前 budget_exceeded(零新增调用)", async () => {
    let calls = 0;
    const provider: Provider = {
      async complete() {
        calls += 1;
        return { text: JSON.stringify({ entities: [] }) };
      },
    };
    // 每次占用 = 估算输入(≈1) + system 提示估算(N39: entity_extraction 含 schema
    // 文本实测 ≈237) + 输出上限(override 10) ≈ 248; 预算 300 → 首次够(剩 52), 二次超支。
    const budget = createWorkflowBudget(300);
    const r1 = await runStep(
      provider,
      { specRef: "entity_extraction", input: "x", overrides: { maxTokens: 10 } },
      { budget },
    );
    expect(r1.ok).toBe(true);
    expect(calls).toBe(1);
    // 第二次调用: 剩余 52 < 248 → 超支, provider 不被调用(累计 guard 在 provider 前拦截)。
    const r2 = await runStep(
      provider,
      { specRef: "entity_extraction", input: "x", overrides: { maxTokens: 10 } },
      { budget },
    );
    expect(r2.ok).toBe(false);
    expect(r2.error?.kind).toBe("budget_exceeded");
    expect(calls).toBe(1);
  });

  it("不传 budget 的 runStep 行为不变(seam 加法, 零破坏)", async () => {
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ entities: [] }) }],
    });
    const r = await runStep(provider, { specRef: "entity_extraction", input: "x" });
    expect(r.ok).toBe(true);
  });
});
