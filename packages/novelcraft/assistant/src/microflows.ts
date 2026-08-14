// assistant · 自然语言微工作流目录(D7 首批 6 条, R6 确定性骨架)。
// 每个 microflow = 参数 schema + 阶段函数引用; 实际执行委托既有包的确定性函数。
// 意图路由 = 关键词匹配(确定性兜底; 编排脑可覆盖); 不确定 → 反问(§10)。
import { validateSchema } from "@novelcraft/llm-step";
import type { ValidatorSchema } from "@novelcraft/llm-step";

export interface MicroflowStep {
  /** 目标包 */
  pkg: "imports" | "world" | "writing" | "outline";
  /** 目标函数名(阶段函数引用; 编排层据此调用) */
  fn: string;
  /** 参数模板说明(作者语言) */
  args: string;
}

export interface MicroflowDef {
  name: string;
  description: string;
  /** 触发关键词(确定性路由) */
  keywords: string[];
  paramsSchema: ValidatorSchema;
  steps: MicroflowStep[];
}

export const MICROFLOWS: MicroflowDef[] = [
  {
    name: "去重修复",
    description: "用户指出误合/漏合, 针对特定对象组重新判定并合并/拆分",
    keywords: ["重复", "合并错", "同一个", "不是同一", "去重"],
    paramsSchema: {
      type: "object",
      required: ["targets"],
      properties: { targets: { type: "array", items: { type: "string" } } },
    },
    steps: [
      { pkg: "imports", fn: "dedupReport", args: "针对 targets 组重新判定" },
      { pkg: "imports", fn: "applyDedup", args: "报告 + approved=true" },
    ],
  },
  {
    name: "Scene 重切",
    description: "用户要求重切某章 Scene(一等操作, §6)",
    keywords: ["重切", "拆太细", "切分", "场景切"],
    paramsSchema: {
      type: "object",
      required: ["chapters"],
      properties: { chapters: { type: "array", items: { type: "number" } } },
    },
    steps: [{ pkg: "imports", fn: "sliceChapterBatch", args: "chapterIndices=chapters" }],
  },
  {
    name: "补设定",
    description: "针对设定缺口生成世界对象/页面建议(生成中心映射 §19)",
    keywords: ["补设定", "补一下", "设定补全", "世界观"],
    paramsSchema: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string" } },
    },
    steps: [{ pkg: "world", fn: "suggestEntity", args: "input=topic" }],
  },
  {
    name: "审章",
    description: "对某章跑语义审查(写作后评审台, §17.4)",
    keywords: ["审章", "审查", "看看这章", "review"],
    paramsSchema: {
      type: "object",
      required: ["chapter"],
      properties: { chapter: { type: "number" } },
    },
    steps: [{ pkg: "writing", fn: "reviewChapter", args: "chapterIndex=chapter" }],
  },
  {
    name: "改对象名",
    description: "修改世界对象名称(确定性 rename)",
    keywords: ["改名", "更名", "名字改"],
    paramsSchema: {
      type: "object",
      required: ["slug", "name"],
      properties: { slug: { type: "string" }, name: { type: "string" } },
    },
    steps: [{ pkg: "world", fn: "updateObject", args: "slug, {name}" }],
  },
  {
    name: "续写提案",
    description: "生成下一章 2–3 个续写方案(下一步提案中心, §17.5)",
    keywords: ["续写", "下一章", "接下来写", "提案"],
    paramsSchema: {
      type: "object",
      required: ["chapter"],
      properties: { chapter: { type: "number" } },
    },
    steps: [{ pkg: "writing", fn: "proposeNextChapter", args: "chapterIndex=chapter" }],
  },
];

/** 确定性意图路由: 关键词命中 → microflow 名; 无命中 → null(编排脑反问)。 */
export function routeMicroflow(userText: string): string | null {
  const t = userText.toLowerCase();
  for (const mf of MICROFLOWS) {
    if (mf.keywords.some((k) => t.includes(k.toLowerCase()))) return mf.name;
  }
  return null;
}

/** 参数校验(违反即拒绝, 返回问题列表)。 */
export function validateMicroflowArgs(name: string, args: unknown): string[] {
  const mf = MICROFLOWS.find((m) => m.name === name);
  if (!mf) return [`microflow 不存在: ${name}`];
  return validateSchema(mf.paramsSchema, args).map((i) => `${i.path}: ${i.message}`);
}

/** 编排计划: 给定 microflow + 参数 → 阶段步骤表(供 DSH 编排层执行)。 */
export function buildMicroflowPlan(
  name: string,
  args: Record<string, unknown>,
): { ok: boolean; issues: string[]; steps: MicroflowStep[] } {
  const issues = validateMicroflowArgs(name, args);
  if (issues.length > 0) return { ok: false, issues, steps: [] };
  const mf = MICROFLOWS.find((m) => m.name === name)!;
  return { ok: true, issues: [], steps: mf.steps };
}

export function listMicroflows(): string[] {
  return MICROFLOWS.map((m) => m.name);
}
