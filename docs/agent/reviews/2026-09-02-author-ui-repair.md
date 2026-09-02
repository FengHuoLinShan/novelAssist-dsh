# 2026-09-02 作者界面与主流程修复记录

## 触发

对当前可操作界面与主要作者流程做真实宿主审查后，发现章节加载循环、草稿丢失、摄入收据断链、书名代替稳定书键、地图多页目标歧义，以及窄窗口入口裁切等问题。

## 本次修复

- 章节页：稳定首次加载和切章；草稿按会话、书、章节隔离；基线漂移保留冲突副本；dirty 状态阻止恢复、审查与采用；空书可用既有 `expectedAbsent` 收据新建第一章。
- 导入：选择文件后显示分章预览；支持 Markdown 章节标题和 100 字内长标题；超过 20,000 字且无标题时写前阻止；同名且原文 hash 相同才幂等。
- 助手交接：生产信号保留机器可执行 receipt，浏览器卡片过滤 receipt/hash；书库打开使用稳定 `book` 键；Inbox 只有真实完成的拒绝会关闭事项。
- 写作：作者章目标冻结进提案 P0 上下文；提案严格为 2–3 条非空且互异方向；已有 active candidate 时不再重复生成；显示来源、遗漏与警告数量。
- World/Atlas：世界来源和发布动作携带精确 source ref；图片收据冻结具体 page ref 与内容 hash；多候选页必须明确选择；标注请求区分“已排队”与“已保存”。
- 长任务：未知/损坏状态 fail-closed；恢复和清理按钮由服务端 `available_actions` 决定；运行中每 3 秒刷新；展示阶段、范围和进度语义。
- 界面：八个平级头部入口收拢为待处理入口和原生 `details` 功能菜单；统一 Modal 焦点进入、Tab 圈定和关闭后焦点恢复；窄窗触控目标、正文/候选字号和三栏档案响应式布局提升。

## 明确未引入

未增加数据库、第二任务中心、富文本编辑器、UI 框架或新依赖。文件、Git、现有 durable manifest、DSH ApprovalGate 与 Connection RPC 仍是唯一事实与权限边界。

## 验证口径

- 定向：chapter draft/state、client RPC/useWatch、assistant inbox、writing import/proposal、world map-atlas、DSH production client-face。
- 集成：client/dsh 全包测试与全仓 `npm test`、`npm run typecheck`。
- 运行：client build 后在真实 DSH 宿主检查 390/520/760/1024/1280/1440px 的入口可达、无横向溢出、Modal 键盘焦点与关键空态。
