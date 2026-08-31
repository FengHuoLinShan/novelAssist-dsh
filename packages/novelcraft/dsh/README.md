# @novelcraft/dsh — 挂载阶段适配包

把 13 个纯 TS 核心包接入 DSH rc.8 插件 seam 的 **Cordis 服务插件**(ADR-0017 §2)。
核心包保持零 DSH 运行时依赖不变; 本包是唯一的 DSH 接触面。

## 组装(profile patch 形式, D21 锁 rc.8)

```yaml
plugins:
  # DSH 官方服务(storage/llm/approval/jobs/credentials 等由 profile bundle 提供)
  novelcraft:
    name: "@novelcraft/dsh"
    config:
      llm: { provider: deepseek, model: deepseek-chat }   # 内容手默认路由(可被 DSH 模型切换覆盖)
      vaultsDir: ~/Novels                                 # 每书一个子文件夹
      watch: { enabled: false, intervalMinutes: 60 }      # 雷达低频巡检(默认关 D6)
```

## seam 适配矩阵

| seam | 适配器 | 关键行为 |
|---|---|---|
| `ctx.llm` | `DshProvider`(llm-step `Provider` 实现) | system→system 槽; 文本增量拼装; usage 透传; error/aborted 终止映射可分类错误(retryable); 无 llm 服务→明确报错 |
| `ctx.approval` | `ApprovalGate` | `request(agent, {action, summary, items})`; 仅 `allowed-once` 放行; 无 agent/服务缺失/异常 → `unavailable`(fail-closed) |
| `ctx.storageDomain` | `NovelcraftCache` + `novelcraftDomain` | domain `novelcraft` v1: `sessions`(会话→vault 绑定)、`indexes`(派生索引缓存, zod 信封校验, 重开验证); 写失败不影响文件真相; pending 同步读面 |
| `ctx.jobs` | `RadarScheduler` | 每雷达一轮 = 一个 job(kind `novelcraft-radar`); work 遵守 AbortSignal; 取消→killed, 异常→failed; `startInterval` 需宿主 `ctx.setInterval` |
| `ctx.credentials` | (消费面) | 内容手 Key 由 DSH credentials/LLM 适配器层解析; `.assistant/llm.yml` 只存模型名与参数(N5), 本包不落 Key |
| 会话↔vault | `SessionVaultBinder` | D17 一书一会话一 vault 根; 内存 + domain 双面绑定; §14 子代理 prompt 注入(书名/路径/纪律条款) |
| `ctx.tools` | `registerNovelcraftTools`(+ 工具组插件) | 39 个领域工具（含单章 Git 版本与审查闭环、长任务恢复面, M10-B1/N40; 书库生命周期, M11/N42; world 对象写, M12-a/N43; outline 生成 preview/apply 与 world 生成中心只读模式 9 个, M12-b/N44），一律经 `novelcraftToolFactory` 定义：schema 推断 args、N34 隔离、`toolError` 单点映射、`afterMutation` 副作用纪律由包装器结构性保证；信号只由确定性 producer 产生，不暴露任意 `signal_push`。成功值使用 required + closed schema；scope/approval/store/LLM/未知失败映射 rc.8 `HarnessError`，由宿主产出 `isError:true`。`config.tools.{writing,mapAtlas,workflow,book}` 可分组开关（缺省全开）；`NovelcraftWritingToolsPlugin`/`NovelcraftMapAtlasPlugin`/`NovelcraftWorkflowToolsPlugin`（internal 面）为可单独挂载的真实 cordis 插件（inject novelcraft）。 |
| client UI 数据面 | `service.ui`(`NovelcraftUiFace`) | loopback RPC 数据源：复用冻结 `read` 命名空间 + `view` 只读聚合 + `stage` 收据暂存（含提示信号与 `pushSignalsChanged` 真实推送）+ `records.actOnSignal` + `config.selectPreset`；零正史写（铁律 3）。client 不再 import 核心包运行时/裸 fs（type-only 例外）。 |
| client-modules | `@novelcraft/dsh-client`（独立 UI 插件） | 本包只提供宿主服务；章节工作区、收件箱和会话页内状态由独立 client 插件通过 loopback RPC 读取，不从浏览器写正史。 |

服务门面: `ctx.novelcraft`(`NovelCraftService`)暴露上述适配器 + 受误用保护的
`read/propose/adoptGuarded` capability + 便捷方法 `runStep` / `adoptGuarded` / `refreshIndex` / `inbox` /
`deepImport`(runDeepImport 挂载: DshProvider + ApprovalGate + ImportTraceSink)。

工具注册入口仍为 `src/tools.ts`；章节工作流与地图册定义分别位于
`src/tools/writing.ts`、`src/tools/map-atlas.ts`，共用的错误映射和 workspace 隔离位于
`src/tools/shared.ts`。注册名称、顺序和公开导入路径不变。

## 工程约定

1. 所有 DSH 服务读取走 `svc(ctx, name)`(ctx.get): cordis 的 inject 门禁按 fiber 生效,
   工具执行可能在别的 fiber 下跑; 缺失服务由各适配器降级或 fail-closed, 不炸插件。
2. 测试 = vitest: 真实 Cordis Context + 真实 storage/storage-json/storage-domain/llm/tools
   + 假 approval/jobs/credentials(test/helpers.ts), 断言注释引 seam 契约。
3. 集成 demo: `node scripts/m5-mount-demo.mjs`(仓库根)纯 node 跑通挂载全链。
4. dist 是 Node 可加载 ESM(相对导入 .js 后缀); 构建 `npm run build`。

## 依赖策略

- `@deepseek-ai/*` 全部锁定 **0.1.0-rc.8 peerDependencies**(cordis ^4.0.1), 由宿主
  profile 提供单实例(避免多份 cordis 破坏 Context 增强); 本包 devDependencies
  自备同版本用于测试。
- `@novelcraft/*` 为 workspace 依赖; zod ^4(schemastery 由 dsh 包带入)。
