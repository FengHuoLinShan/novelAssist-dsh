// @novelcraft/dsh · 可选服务访问器。
// cordis 对插件 fiber 的「未声明 inject 不可访问服务」检查按 fiber 生效;
// 本包的工具执行/适配器可能在别的 fiber 下跑, 且部分 seam 本就可选
// (最小 profile 可无 tools; 无审批时 fail-closed)。统一经 ctx.get()
// 读取, 缺失/异常返回 undefined, 由各适配器做降级或 fail-closed。
import type { Context } from '@deepseek-ai/cordis';

/** 按名读服务; 缺失或访问受限返回 undefined。 */
export function svc<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get(name: string): T }).get(name) as T | undefined;
  } catch {
    return undefined;
  }
}
