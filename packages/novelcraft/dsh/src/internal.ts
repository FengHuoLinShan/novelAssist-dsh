// @novelcraft/dsh/internal — host composition internals, not a plugin capability surface.
// N35 / ADR-0024: raw tool registration and deep-import adapter stay inaccessible from '.'.
// 工具组独立插件(写作/地图册)也在此面: 组合式 profile 用, 非能力面。
export * from './deep-import.js';
export * from './tools.js';
export * from './tools/plugins.js';
