// @novelcraft/dsh · 通用 client→浏览器推送通道(ADR-0018 §1 窄缝补丁打通的 seam)。
//
// 运行时: scripts/apply-dsh-patches.mjs 给 @deepseek-ai/dsh-api-remotes 的
// API_REMOTE_FORWARDED_EVENTS 加 `client/push`, 使 host 的 api-proxy 转发循环把它
// 打包成 host/remote-event 帧, 由 client runtime 扇出到 ctx.remote.$on。
// 本文件只负责类型声明(声明合并进 cordis Events)+ 便捷 emit; 运行时零依赖。
import type { Context } from '@deepseek-ai/cordis';

/** 信号变化频道名(@novelcraft/dsh-client 据此刷新宠物/收件箱)。 */
export const SIGNALS_CHANGED = 'novelcraft/signals-changed';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 通用插件→浏览器推送: channel 区分业务频道, payload 必须 JSON-safe(api-proxy
     * 的 assertJsonArgs 会在转发前校验)。
     * @mode emit
     */
    'client/push'(channel: string, payload: unknown): void;
  }
}

/** 宿主侧推送一条「信号变化」事件(经 api-proxy 转发到浏览器 ctx.remote.$on)。 */
export function pushSignalsChanged(ctx: Context, payload: unknown): void {
  ctx.emit('client/push', SIGNALS_CHANGED, payload);
}
