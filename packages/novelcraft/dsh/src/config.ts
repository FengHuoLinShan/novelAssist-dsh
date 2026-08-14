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
}

export interface WatchConfig {
  /** 雷达守望总开关(默认关, D6: 无每日摘要, 事件/阈值触发) */
  enabled: boolean;
  /** 低频巡检间隔(分钟; 仅 enabled 时生效, 由 ctx.setInterval 驱动) */
  intervalMinutes: number;
}

export interface Config {
  /** 内容手默认路由 */
  llm: LlmRoute;
  /** 每书一个子文件夹的工作区根(默认 ~/Novels; 运行期展开 ~) */
  vaultsDir: string;
  /** 雷达守望 */
  watch: WatchConfig;
}

export const Config: z<Config> = z.object({
  llm: z
    .object({
      provider: z.string().default('deepseek'),
      model: z.string().default('deepseek-chat'),
    })
    .default({ provider: 'deepseek', model: 'deepseek-chat' }),
  vaultsDir: z.string().default('~/Novels'),
  watch: z
    .object({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().min(1).default(60),
    })
    .default({ enabled: false, intervalMinutes: 60 }),
});

export const DEFAULT_CONFIG: Config = {
  llm: { provider: 'deepseek', model: 'deepseek-chat' },
  vaultsDir: '~/Novels',
  watch: { enabled: false, intervalMinutes: 60 },
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
