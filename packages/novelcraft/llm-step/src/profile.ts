// llm-step · ExecutionProfile 纯核心 seam(N34 / ADR-0023 §6)。
// 编排(deep_import、多章生成等)启动时解析一次不可变 ExecutionProfile(执行级默认:
// timeout/预算等); 解析失败 → 抛错(fail-closed, 不带半解析配置跑, 不静默用缺省参数继续)。
// 内部所有 llm-step 调用经 applyExecutionProfileToRequest 统一继承 profile 默认,
// 请求级 override 优先(对齐 N20 withResolvedDefaults/mergeStepOverrides 语义)。
//
// 类型面 = 显式非 secret 白名单(11 键: version/provider/model/temperature/top_p/
// maxTokens/timeoutMs/workflowBudget/policy/contractVersions/source); 未知/secret 字段:
//   - 配置面(parse)直接拒绝(白名单外键即非法, fail-closed);
//   - 指纹面(canonicalProfileJson/fingerprint)始终只投影白名单键——即使运行时对象
//     被附加 secret 键, 也绝不进入 canonical JSON 与 sha256 fingerprint。
// 安全加固(独立审查 P1/P2 + 审查项 1):
//   - 白名单数组运行时真正冻结(Object.freeze): 外部 push/splice 等篡改在严格模式抛
//     TypeError、内容不变, secret 键无法混入指纹投影源; 内部成员判断另走模块私有
//     ReadonlySet, 双保险。
//   - 输入严格限于 plain data object(原型 Object.prototype/null、全字段 own data
//     descriptor 无 getter/setter): validate/parse 前先做单次安全快照, 校验与复制
//     只读同一快照 → 消除 validate 后 parse 重复读取的 TOCTOU; contractVersions 内层
//     同样防 accessor/Proxy/环; Proxy trap 抛异常统一转 ProfileValidationError,
//     不把原始异常(可能含 secret 文本)带出。
//   - opaque provenance brand(审查项 1): parseExecutionProfile 产出的冻结对象登记进
//     模块私有 WeakSet, 外部只能经 isExecutionProfile 做布尔判定 —— 拿不到 brand 本身
//     (不导出符号/token/集合), 普通对象(哪怕字段全合法、已冻结)永远无法伪造 provenance;
//     brand 只能由解析器(parseExecutionProfile)产生, DSH 入口据此验证「内部透传可
//     验证」且「外部 plain profile 不得跳过 root 解析」。
// 零 DSH 依赖(纯 node:crypto sha256, 与 store/hash.ts 同口径)。
import { createHash } from "node:crypto";
import type { StepRequest } from "./types.js";
import { isDeniedSecretKey } from "./secret-keys.js";

/**
 * 非 secret 白名单(常量序仅供阅读; canonical 键序由 sort 决定, 与声明序无关)。
 * 运行时不可变(P1): Object.freeze 使外部 push/splice 等篡改失效(严格模式抛 TypeError),
 * 白名单无法被注入 secret 键 → canonical 投影/指纹的键集合固化, secret 决不能借由
 * 「往白名单里 push 一个键名」进入 parse/fingerprint。
 */
export const EXECUTION_PROFILE_WHITELIST = Object.freeze([
  "version",
  "provider",
  "model",
  "temperature",
  "top_p",
  "maxTokens",
  "timeoutMs",
  "workflowBudget",
  "policy",
  "contractVersions",
  "source",
] as const);

/** 内部成员判断集合(模块私有, 外部不可达; 与冻结数组双保险, P1)。 */
const PROFILE_WHITELIST_KEYS: ReadonlySet<string> = new Set(EXECUTION_PROFILE_WHITELIST);

/**
 * opaque provenance brand(审查项 1): 模块私有 WeakSet, 只登记 parseExecutionProfile
 * 产出的深冻结对象。不导出本集合、不导出任何 brand 符号 —— 外部只能经
 * isExecutionProfile(v) 做布尔判定, 无法自行给普通对象盖章。
 */
const PROFILE_BRAND = new WeakSet<object>();

/**
 * 不可变 ExecutionProfile(ADR-0023 §6)。由 parseExecutionProfile 产出:
 * 全部字段经严格范围校验、对象深冻结; 产出对象同时带 opaque provenance brand
 * (模块私有 WeakSet, 见 isExecutionProfile), 普通对象无法伪造。secret(Key 等)绝不落
 * 此类型(铁律 6/N5)。
 */
export interface ExecutionProfile {
  /** Profile 格式版本(必填, 形如 1 / 1.2 / v1.2.3, ≤32 字符) */
  version: string;
  /** DSH provider 路由默认(如 'deepseek'); 请求级 override 优先 */
  provider?: string;
  /** 模型 id 默认; 请求级 override 优先 */
  model?: string;
  /** 单步温度默认, [0,2]; 请求级 override 优先 */
  temperature?: number;
  /** 单步 top_p 默认, [0,1]; 请求级 override 优先(审查项 4: 进入 core strict 参数面) */
  top_p?: number;
  /** 单次调用输出 token 上限默认, 1–200000 整数; 请求级 override 优先 */
  maxTokens?: number;
  /** 单步超时默认毫秒, 1000–3600000 整数; 请求级 override 优先 */
  timeoutMs?: number;
  /** 整条工作流 token 预算(编排级, 非 per-step; ≥1 的整数) */
  workflowBudget?: number;
  /** 执行策略名(slug, 如预设卡名; 编排级引用, 不注入 per-step) */
  policy?: string;
  /** 契约名 → 版本(审计/追踪用, 如 { "prompt-contracts": "v1" }) */
  contractVersions?: Record<string, string>;
  /** 来源(路径/URL/描述; 审计用) */
  source?: string;
}

/**
 * opaque provenance 判定(审查项 1): 仅 parseExecutionProfile 产出的对象为 true。
 * 普通对象(含字段合法/已冻结/展开副本/伪造 getter)一律 false —— brand 不可伪造、
 * 不可复制(WeakSet 按对象同一性), 本函数也不泄露 brand 本体(无符号/无集合可拿)。
 */
export function isExecutionProfile(v: unknown): boolean {
  return typeof v === "object" && v !== null && PROFILE_BRAND.has(v);
}

// —— 严格校验(N34: 解析失败 fail-closed; 上界沿 policy-defaults §2/§3 与 preset 校验口径) ——

const VERSION_RE = /^v?\d+(\.\d+){0,3}$/;
const NO_WS_RE = /^\S+$/;
const POLICY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** contractVersions 键形态(独立审查 P2/R6: 键必须是标识符形态, 且不得是敏感键)。 */
const CONTRACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 安全单次快照(P2): 把未知输入一次性复制为纯数据对象, 消除 validate 后 parse
 * 重复读取源对象导致的 TOCTOU。
 * - 仅接受 plain data object(原型 Object.prototype 或 null): 拒绝 class 实例等
 *   自定义原型(防继承 accessor);
 * - 每个 own 键必须是 data descriptor(拒绝 getter/setter accessor, 顶层与
 *   contractVersions 内层一视同仁);
 * - 每个值只读取一次(取自 getOwnPropertyDescriptor 返回的 desc.value, 绝不二次
 *   索引源对象; any Proxy/getter 无法在两次读取间换值);
 * - 递归快照全部内层, 深度上限 + seen 集合防环(循环引用直接拒绝, 不挂死);
 * - 任何一步抛错(Proxy getPrototypeOf/ownKeys/getOwnPropertyDescriptor trap 抛异常,
 *   如 revoked)或结构不合格 → 返回 SNAPSHOT_REJECTED: 不读值、不把原始异常带出
 *   (原始异常文本可能含 secret, 一律不外泄)。
 */
const SNAPSHOT_REJECTED: unique symbol = Symbol("snapshot-rejected");
const MAX_PLAIN_DEPTH = 16;

function snapshotPlain(
  o: unknown,
  depth: number,
  seen: Set<object>,
): unknown | typeof SNAPSHOT_REJECTED {
  if (o === null || typeof o !== "object") return o; // 原始值原样通过(顶层由调用方拒绝非对象)
  if (depth > MAX_PLAIN_DEPTH) return SNAPSHOT_REJECTED;
  try {
    if (Array.isArray(o)) return SNAPSHOT_REJECTED; // Array.isArray 对 revoked Proxy 会抛 → 一并拒绝
  } catch {
    return SNAPSHOT_REJECTED;
  }
  if (seen.has(o)) return SNAPSHOT_REJECTED; // 环 → 非纯数据面
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(o);
  } catch {
    return SNAPSHOT_REJECTED;
  }
  if (proto !== Object.prototype && proto !== null) return SNAPSHOT_REJECTED;
  seen.add(o);
  const out: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(o)) {
      if (typeof key !== "string") continue; // symbol 键不进配置面(parse 也不复制)
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (desc === undefined || "get" in desc || "set" in desc) return SNAPSHOT_REJECTED; // accessor/幽灵键
      const child = snapshotPlain(desc.value, depth + 1, seen);
      if (child === SNAPSHOT_REJECTED) return SNAPSHOT_REJECTED;
      // defineProperty 而非赋值: 自带 "__proto__"/"constructor" 键不得污染快照原型/继承面
      Object.defineProperty(out, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  } catch {
    return SNAPSHOT_REJECTED; // Proxy trap 抛异常(ownKeys/getOwnPropertyDescriptor) → 统一拒绝
  } finally {
    seen.delete(o);
  }
  return out;
}

/** 顶层快照: 结果必须是普通对象(原始值/数组/rejected 一律拒绝)。 */
function snapshotProfileInput(v: unknown): Record<string, unknown> | typeof SNAPSHOT_REJECTED {
  const s = snapshotPlain(v, 0, new Set());
  if (s === SNAPSHOT_REJECTED || s === null || typeof s !== "object") return SNAPSHOT_REJECTED;
  return s as Record<string, unknown>;
}

const NOT_A_PLAIN_OBJECT_ISSUE =
  "ExecutionProfile 必须是纯数据对象(仅 data 属性, 无 getter/setter/Proxy/环)";

/** 校验一个已快照的纯数据 profile(只读快照, 无 accessor/Proxy 二次读取, P2)。 */
function validatePlainProfile(o: Record<string, unknown>): string[] {
  const issues: string[] = [];
  // 白名单外字段(含 secret/笔误)一律拒绝: 配置面 fail-closed, 宁缺毋滥。
  for (const key of Object.keys(o)) {
    if (!PROFILE_WHITELIST_KEYS.has(key)) {
      issues.push(`未知字段: ${key}(不在白名单, 不得进入指纹)`);
    }
  }
  if (typeof o.version !== "string" || !VERSION_RE.test(o.version) || o.version.length > 32) {
    issues.push("version 必填, 形如 1 / 1.2 / v1.2.3(≤32 字符)");
  }
  if (o.provider !== undefined && (typeof o.provider !== "string" || !NO_WS_RE.test(o.provider) || o.provider.length > 64)) {
    issues.push("provider 必须是非空无空白字符串(≤64)");
  }
  if (o.model !== undefined && (typeof o.model !== "string" || !NO_WS_RE.test(o.model) || o.model.length > 128)) {
    issues.push("model 必须是非空无空白字符串(≤128)");
  }
  if (o.temperature !== undefined && (typeof o.temperature !== "number" || !Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) {
    issues.push("temperature 必须在 [0,2] 的有限数字");
  }
  if (o.top_p !== undefined && (typeof o.top_p !== "number" || !Number.isFinite(o.top_p) || o.top_p < 0 || o.top_p > 1)) {
    issues.push("top_p 必须在 [0,1] 的有限数字(审查项 4: 合法值进参数面/指纹, 非法值 fail-closed)");
  }
  if (o.maxTokens !== undefined && (typeof o.maxTokens !== "number" || !Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > 200_000)) {
    issues.push("maxTokens 必须是 1–200000 的整数(0 = 不限不在 profile 面, 省略即可)");
  }
  if (o.timeoutMs !== undefined && (typeof o.timeoutMs !== "number" || !Number.isInteger(o.timeoutMs) || o.timeoutMs < 1_000 || o.timeoutMs > 3_600_000)) {
    issues.push("timeoutMs 必须是 1000–3600000 的整数");
  }
  if (o.workflowBudget !== undefined && (typeof o.workflowBudget !== "number" || !Number.isInteger(o.workflowBudget) || o.workflowBudget < 1 || o.workflowBudget > 1_000_000_000)) {
    issues.push("workflowBudget 必须是 1–1000000000 的整数");
  }
  if (o.policy !== undefined && (typeof o.policy !== "string" || !POLICY_RE.test(o.policy))) {
    issues.push("policy 必须是非空 slug(字母数字起头, 可含 - 与 _, ≤49 字)");
  }
  if (o.contractVersions !== undefined) {
    // 快照已保证 contractVersions 是纯数据对象(或原始值); 此处再做语义校验。
    // 独立审查 P2/R6: 拒绝敏感键(secret 绝不借 contractVersions 进指纹)与
    // 自由 secret 值; 键形态白名单(CONTRACT_NAME_RE)。「从 spec registry 构造」
    // 见 specs.ts contractVersionsFromSpecs —— 编排侧首选该构造器, 此处是通用面校验。
    const cv = o.contractVersions;
    if (typeof cv !== "object" || cv === null || Array.isArray(cv)) {
      issues.push("contractVersions 必须是 { 契约名: 版本 } 对象");
    } else {
      for (const [k, val] of Object.entries(cv)) {
        if (k === "" || k.length > 64) issues.push(`contractVersions 键非法: ${k}`);
        if (isDeniedSecretKey(k)) {
          issues.push(`contractVersions 键是敏感键, 拒绝进入指纹: ${k}(N5)`);
          continue;
        }
        if (!CONTRACT_NAME_RE.test(k)) {
          issues.push(`contractVersions 键必须是标识符形态(字母数字起头, 可含 ._- , ≤64 字): ${k}`);
        }
        if (typeof val !== "string" || val === "" || val.length > 64) {
          issues.push(`contractVersions[${k}] 值必须是非空字符串(≤64)`);
        }
      }
    }
  }
  if (o.source !== undefined && (typeof o.source !== "string" || o.source === "" || o.source.length > 256 || CONTROL_RE.test(o.source))) {
    issues.push("source 必须是非空字符串(≤256, 无控制字符)");
  }
  return issues;
}

/**
 * 校验一个输入是否为合法 ExecutionProfile; 返回问题列表(空 = 合法)。
 * 只接受 plain data object(见 snapshotPlain): accessor/Proxy/环/非纯对象一律视为非法,
 * 不读取其值(防 TOCTOU, 不泄漏 secret)。本函数自身不抛异常。
 */
export function validateExecutionProfile(v: unknown): string[] {
  const snapshot = snapshotProfileInput(v);
  if (snapshot === SNAPSHOT_REJECTED) return [NOT_A_PLAIN_OBJECT_ISSUE];
  return validatePlainProfile(snapshot);
}

/** 解析失败错误(fail-closed 的承载: 编排捕获即启动失败, 不静默降级)。 */
export class ProfileValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`ExecutionProfile 校验失败: ${issues.join("; ")}`);
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

/** 深冻结: 递归冻结全部对象层(不可变契约, N34 §6 的「解析一次不可变」)。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * 严格解析一次 ExecutionProfile(N34 / ADR-0023 §6):
 * 校验失败 → 抛 ProfileValidationError(fail-closed, 不带半解析配置跑);
 * 成功 → 重建成只含白名单键的干净对象并深冻结(不可变, 防运行时篡改), 并把该对象
 * 登记进模块私有 provenance brand(审查项 1: brand 只能由本解析器产生, 普通对象
 * 无法伪造; isExecutionProfile 是唯一判定面)。
 * Key/secret 绝不入参本函数(铁律 6/N5); 白名单外键在此时即被拒绝。
 * P2: 先做单次安全快照, 校验与复制共用同一快照 → 不存在「validate 读 A、parse 读 B」
 * 的 TOCTOU; Proxy trap 抛异常统一转 ProfileValidationError, 原始异常不外泄。
 */
export function parseExecutionProfile(v: unknown): ExecutionProfile {
  const snapshot = snapshotProfileInput(v);
  if (snapshot === SNAPSHOT_REJECTED) throw new ProfileValidationError([NOT_A_PLAIN_OBJECT_ISSUE]);
  const issues = validatePlainProfile(snapshot);
  if (issues.length > 0) throw new ProfileValidationError(issues);
  const o = snapshot;
  const profile: ExecutionProfile = { version: o.version as string };
  if (o.provider !== undefined) profile.provider = o.provider as string;
  if (o.model !== undefined) profile.model = o.model as string;
  if (o.temperature !== undefined) profile.temperature = o.temperature as number;
  if (o.top_p !== undefined) profile.top_p = o.top_p as number;
  if (o.maxTokens !== undefined) profile.maxTokens = o.maxTokens as number;
  if (o.timeoutMs !== undefined) profile.timeoutMs = o.timeoutMs as number;
  if (o.workflowBudget !== undefined) profile.workflowBudget = o.workflowBudget as number;
  if (o.policy !== undefined) profile.policy = o.policy as string;
  if (o.contractVersions !== undefined) {
    profile.contractVersions = { ...(o.contractVersions as Record<string, string>) };
  }
  if (o.source !== undefined) profile.source = o.source as string;
  const frozen = deepFreeze(profile);
  PROFILE_BRAND.add(frozen);
  return frozen;
}

// —— 稳定 canonical JSON + sha256 fingerprint ——

/** 稳定 canonical 序列化: 对象键按 UTF-16 码元排序、紧凑无空白、确定性转义。 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("canonical JSON 不支持非有限数字(profile 已校验, 不该出现)");
      }
      return JSON.stringify(value);
    }
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((x) => canonicalJson(x)).join(",")}]`;
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const body = keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
        .join(",");
      return `{${body}}`;
    }
    default:
      throw new Error(`canonical JSON 不支持类型: ${typeof value}`);
  }
}

/**
 * 白名单投影的 canonical JSON(键序稳定, 与对象字面量键序无关)。
 * 只 pick 白名单键: 即使对象被附加 secret/未知键(绕过 parse 的运行时对象),
 * 也绝不进入输出 —— secret 排除在此投影面兜底。白名单数组已冻结(P1), 外部无法
 * 往投影键集合里注入 secret 键名。
 */
export function canonicalProfileJson(profile: ExecutionProfile): string {
  const picked: Record<string, unknown> = {};
  const view = profile as unknown as Record<string, unknown>;
  for (const key of EXECUTION_PROFILE_WHITELIST) {
    const val = view[key];
    if (val !== undefined) picked[key] = val;
  }
  return canonicalJson(picked);
}

/** sha256(canonical 白名单投影) 纯 hex。配置指纹语义(N34 §4: config fingerprint)。 */
export function fingerprintExecutionProfile(profile: ExecutionProfile): string {
  return createHash("sha256").update(canonicalProfileJson(profile), "utf8").digest("hex");
}

// —— 注入链: profile 默认 ← 请求 override 优先(保持 runStep 签名) ——

/**
 * 把 profile 执行级默认并入 StepRequest.overrides(请求级字段优先, N20 对齐)。
 * 只处理六个 per-step 执行面字段(provider/model/temperature/top_p/maxTokens/timeoutMs);
 * workflowBudget/policy/contractVersions/version/source 是编排级元数据, 不外泄到请求。
 * 返回的仍是完整 StepRequest → runStep 签名不变: runStep(provider, applyExecutionProfileToRequest(p, req))。
 */
export function applyExecutionProfileToRequest(profile: ExecutionProfile, req: StepRequest): StepRequest {
  const o = req.overrides ?? {};
  const out: NonNullable<StepRequest["overrides"]> = {};
  // 显式 != undefined 判断(而非 truthiness): temperature=0 / top_p=0 等合法零值不被默认吞掉。
  const provider = o.provider ?? profile.provider;
  if (provider !== undefined) out.provider = provider;
  const model = o.model ?? profile.model;
  if (model !== undefined) out.model = model;
  const temperature = o.temperature ?? profile.temperature;
  if (temperature !== undefined) out.temperature = temperature;
  const top_p = o.top_p ?? profile.top_p;
  if (top_p !== undefined) out.top_p = top_p;
  const maxTokens = o.maxTokens ?? profile.maxTokens;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const timeoutMs = o.timeoutMs ?? profile.timeoutMs;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return { ...req, overrides: out };
}