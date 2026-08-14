# @novelcraft/client(R7 · 未实现)

DSH web client-module 插件: 宠物 / 收件箱 / 写作台四模式 / 剧情地图(设计文档 §9/§17)。

## 阻塞依赖(事实, 勿当作已解决)

- client-modules 构建链需 **DSH 源码 checkout**(dsh-rebuild 最终报告 §2.3 缺口 3
  已记录此依赖); 实现期需实测 `clientModules` seam 的插件装载与 `window.__DSH_BOOT__`
  注入约定(上游文档: docs/agent/dsh-upstream/docs/subsystems/client-modules.md)。

## 规划(设计文档 §17/§9)

- 宠物四态: 静默 / 微光(有新信号) / 忙碌 / 待确认角标
- 收件箱: 卡片 + 四动词(采纳/打回/改一改/先放着)+ 键盘流(j/k, 1/2/3/4, u)
- 写作台四模式: 计划台 / 参照台(半屏, D10) / 评审台 / 守望
- 数据面: 读 `.assistant/signals/*.json` 与 `.assistant/reviews/*.json`(N4);
  动作回调走 assistant 核心包的确定性函数(act 等), 不直写资产

## 当前状态

- 核心逻辑已全部就绪(assistant 包: 信号/收件箱/校准/微工作流, 15 测试);
- UI 本体待 DSH client-modules 构建链实测后实现。
