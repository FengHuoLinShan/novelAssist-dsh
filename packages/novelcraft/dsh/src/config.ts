// @novelcraft/dsh · 插件 Config(schemastery)+ 默认值。
// 依据: 设计文档 §13/§22.5(Key 不进配置)、N3 裁定(watch.notify_threshold=5)、
// D6(低频巡检默认关)、seam 契约(packages/novelcraft/README.md)。
// 编排脑模型不在此配置 —— 编排脑 = DSH 原生模型切换(flash+high 账户连接);
// 这里只声明内容手(llm_step 内容步)的默认 provider/model 路由, 运行时仍可被
// DSH 模型切换与 .assistant/llm.yml(model 键)覆盖(resolvePolicy 覆盖链)。
import z from '@deepseek-ai/schemastery';

export interface LlmRoute {
  /** ctx.llm 的已注册 provider 路由(如 'deepseek') */
  provider: string;
  /** 内容手默认模型 id; 每次调用可被 policy/调用方覆盖 */
  model: string;
  /** 内容手执行级默认(可选, N34/ADR-0023 §6): ExecutionProfile 覆盖链最低层取值;
   *  该书 preset 卡(llm.yml preset 键)与 llm.yml 直键可覆盖; 请求级 override 优先。
   *  越界值由 resolveExecutionProfile 在 provider 前拒绝(fail-closed)。 */
  timeoutMs?: number;
  /** 内容手预算默认(可选, N34): 单次输出 token 上限 / 输入预算守卫(1–200000 整数)。 */
  maxTokens?: number;
  /** 整个编排共享的累计 token 预算(1–1,000,000,000 整数)。 */
  workflowBudget?: number;
  /** llm_step 工具回执正文上界(2,000–2,000,000; 缺省 65,536)——M10-A review:
   *  去 8000 硬截断后的防失控上限, 超界截断并在尾部注记。 */
  receiptMaxChars?: number;
}

export interface WatchConfig {
  /** 雷达守望总开关(默认关, D6: 无每日摘要, 事件/阈值触发) */
  enabled: boolean;
  /** 低频巡检间隔(分钟; 仅 enabled 时生效, 由 ctx.setInterval 驱动) */
  intervalMinutes: number;
}

export interface ToolsConfig {
  /** 写作/存储工具组(15 个, novelcraft_ 前缀非 map_atlas 面; 默认开) */
  writing?: boolean;
  /** 地图册工具组(6 个, novelcraft_map_atlas_ 前缀; 默认开) */
  mapAtlas?: boolean;
}

export interface Config {
  /** 内容手默认路由 */
  llm: LlmRoute;
  /** 每书一个子文件夹的工作区根(默认 ~/Novels; 运行期展开 ~) */
  vaultsDir: string;
  /** 雷达守望 */
  watch: WatchConfig;
  /** 工具组开关(profile 即产品: 最小面可关掉地图册/写作任一组; 缺省全开) */
  tools?: ToolsConfig;
}

export const Config: z<Config> = z.object({
  llm: z
    .object({
      provider: z.string().default('deepseek'),
      model: z.string().default('deepseek-chat'),
      // N34 执行级默认(可选; 边界与 llm-step validateContentPreset 一致, 解析时再兜底校验)。
      // schemastery 对象归一化会丢弃 undefined 键(实测), 缺省即不出现; 类型经
      // `undefined as unknown as number` 桥接 ObjectT 的「键必填」静态约束。
      timeoutMs: z.number().min(1_000).max(3_600_000),
      maxTokens: z.natural().min(1).max(200_000),
      workflowBudget: z.natural().min(1).max(1_000_000_000),
      // llm_step 工具回执正文上界(M10-A review: 去 8000 硬截断后的防失控上限,
      // 超界截断并在尾部注记; 可调参数走 Config)。
      receiptMaxChars: z.natural().min(2_000).max(2_000_000).default(65_536),
    })
    .default({
      provider: 'deepseek',
      model: 'deepseek-chat',
      timeoutMs: undefined as unknown as number,
      maxTokens: undefined as unknown as number,
      workflowBudget: undefined as unknown as number,
      receiptMaxChars: 65_536,
    }),
  vaultsDir: z.string().default('~/Novels'),
  watch: z
    .object({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().min(1).default(60),
    })
    .default({ enabled: false, intervalMinutes: 60 }),
  tools: z
    .object({
      writing: z.boolean().default(true),
      mapAtlas: z.boolean().default(true),
    })
    .default({ writing: true, mapAtlas: true }),
});

export const DEFAULT_CONFIG: Config = {
  llm: { provider: 'deepseek', model: 'deepseek-chat' },
  vaultsDir: '~/Novels',
  watch: { enabled: false, intervalMinutes: 60 },
  tools: { writing: true, mapAtlas: true },
};

/** 展开 vaultsDir 中的 ~(跨平台, 遵循 $HOME)。 */
export function expandHome(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (dir === '~') return env.HOME ?? env.USERPROFILE ?? dir;
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    const home = env.HOME ?? env.USERPROFILE;
    return home ? dir.replace(/^~[\\/]?/, (m) => (m.endsWith('\\') ? home + '\\' : home + '/')) : dir;
  }
  return dir;
}
