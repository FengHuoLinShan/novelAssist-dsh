# dsh-rebuild 状态

## 目标

基于 DeepSeek Harness(DSH) 在独立 worktree 中重构 NovelCraft,完整复刻全部用户可见功能。
内部架构与实现可以不同,用户可见功能、数据语义、使用体验必须等价或更好。
最终报告须明示缺口,存在缺口时不得声称"完整复刻完成"。

- Goal ID: goal-88ace233-ad1b-4366-93aa-253081578593(40 轮预算)

## 环境

| 项 | 值 |
|---|---|
| worktree | /Users/tywww/Desktop/项目/ai-writing-assist-dsh-rebuild |
| 分支 | dsh-rebuild(跟踪 origin/main) |
| 基点 | 5337fbcd3 = origin/main(Merge PR #82, 2026-08-13 17:14 +0800) |
| 主工作区 | 未修改(仍在 main, 未动任何文件) |
| 本机 DSH | @deepseek-ai/dsh 0.1.0-rc.6(npx 缓存) |
| DSH 官方文档 | deepseek-ai/deepseek-harness master 47f9438(2026-08-13), 归档于 docs/agent/dsh-upstream/ |

## 进度

- [x] DSH GitHub 仓库与开发文档确认并归档(README/README.zh/AGENTS.md/docs 全树)
- [x] 既有代码 AI 工作流全量盘点(34 个工作流, 见功能对照清单 §3)
- [x] LLM 基础设施/任务队列/受控编排盘点(见功能对照清单 §3.2)
- [x] 前端工作流交互 UX 盘点(见功能对照清单 §1 依据)
- [x] DSH 扩展点逆向盘点(0.1.0-rc.6 发布产物)
- [x] 前端页面/路由/组件全量清单(14 视图/双路由格式/工作流进度体系/健壮性清单, 见对照清单 §1)
- [x] API 端点全量清单(357 端点/20 队列联动/1 SSE/三鉴权模式, 见对照清单 §2)
- [x] 数据模型/表/迁移清单(90 表/39 迁移/head 20260813_map_prompt_upload, 见对照清单 §4)
- [x] DSH 官方文档系统消化(40+ 子系统逐文件精读, 嵌入路径/持久化/多租户/桥接结论见 ADR-0014 修订段与报告)
- [x] ADR: DSH 边车架构决定(docs/adr/0014-dsh-sidecar-ai-infrastructure.md, 状态 Accepted + 2026-08-14 修订段)
- [x] 架构实施方案与迁移顺序(docs/agent/dsh-rebuild/实施方案.md, Phase A-E)
- [x] Phase A 设计(切入 seam/桥接协议/密钥取舍/验收门禁, docs/agent/dsh-rebuild/PhaseA-设计.md)
- [x] SDK 驱动实测验证: deepseek-harness-sdk + runtime-bin 0.1.0rc6(macos-arm64) venv 安装, start/initialize/session/close 冒烟通过
- [x] Phase A 实现(commit aa7a6de19): bridge(27 测试+ruff) + novelcraft-runtime 插件实机端到端(ok/usage/journal/权限拒绝)
- [x] Phase A 收尾(commit bd72c674c): 池 + harness 分支 + 试点接入 + 41 测试 + 371 回归 + Python 驱动全链路 E2E
- [x] Phase B structured 回调扩展(commit ce6ffaafd): 44 测试 + 双链路 E2E
- [ ] Phase A 尾项: outline_analyze 真实 provider 手动验收(runbook)
- [x] Phase C 通用 seam(commit ad5264649): snapshot ContextVar 双设置点 + 全链集成测试; 34 工作流全量具备 dsh-sdk 通道
- [x] Phase C 逐工作流 dsh 模式等价验收: 5/5 模块(outline/rag/writing/world/imports)
- [x] Phase D skills/presets/workflow 模板 + 双发布物裁决(ADR-0014 修订二)
- [x] 双发布物: dsh-plugin(构建+装载冒烟+集成冒烟 12/12)+ 契约门禁(17 端点×引擎路由)
- [x] 插件鉴权 authMode 三模式 + ADR-0014 修订三提案(commit c5ddf5647)
- [x] 完整验证: 全量单元 4215/93 E2E/docs-check/prompt-contracts 全绿
- [ ] 待用户裁决(阻塞): ① 鉴权方案 A 授权; ② client GUI 插件范围
- [ ] 裁决后: 引擎侧服务令牌实现 + 最终收尾

## 待裁决决策点

1. "基于 DSH 重构"的架构解释(边车嵌入 vs 全量重写 vs 插件化产品)
2. Python(FastAPI 网关) ↔ Node(DSH 运行时) 桥接方式
3. 多租户(novel_id/owner)与 DSH scope/preset 的映射
4. DSH 持久化外部化(session log → PostgreSQL)可行性
5. Key 管理:DSH 侧 LLM 调用如何保持 secret-free 快照语义
