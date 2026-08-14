// @novelcraft/dsh — 挂载阶段主入口(Cordis 服务插件)。
// 用法(D21 锁 rc.6):
//   ctx.plugin(NovelCraftService, { llm: { provider: 'deepseek', model: '...' }, vaultsDir: '~/Novels' })
// 或经 profile patch:
//   plugins:
//     novelcraft: { name: '@novelcraft/dsh', config: { ... } }
// seam 见 packages/novelcraft/README.md「DSH 挂载阶段 seam 契约」。
export { NovelCraftService, NovelCraftService as default } from './service.js';
export type { NovelcraftFacades } from './service.js';
export * from './config.js';
export * from './ctx.js';
export * from './llm/preset.js';
export * from './llm/provider.js';
export * from './approval/gate.js';
export * from './storage/domain.js';
export * from './vault/binding.js';
export * from './deep-import.js';
export * from './jobs/radar.js';
export * from './radar-hooks.js';
export * from './tools.js';
