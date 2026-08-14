# @novelcraft/preset

NovelCraft 的 **profile bundle 入口**(ADR-0016 §22.3): skills 家族 + agent presets。
安装 DSH 后, 本包把 NovelCraft 的领域知识(9 册 skill)与人设(4 套 preset)带进 profile。

## 组成

- `skills/novelcraft-*`(9 册): core / imports / interaction / map / ops / outline /
  rag-context / world / writing。内容与 specs/ 同步; 是「编排脑纪律」的运行时载体
  (技能零代码, 装进 profile 即生效)。
- `presets/novelcraft-{author,companion,import-review,worldbuilder}`(4 套):
  agent presets(persona + 工具面), 安装到 `$DSH_HOME/.agent-presets/<name>/`。

## 与核心包的分工

- preset 只携带「知识与人设」, 不携带实现;
- 实现逻辑在其余 12 个 `@novelcraft/*` 包(纯 TS 确定性核心, 见 monorepo README);
- skills 已逐册校对为 M4 语义(工作区路径/确定性函数引用/git 与 approval 纪律,
  不再出现 HTTP 端点或 async_tasks 描述; 2026-08-14 校对完成, 9/9)。
