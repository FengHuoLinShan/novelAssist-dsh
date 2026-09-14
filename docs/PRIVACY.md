# 数据与隐私说明(novelcraft-dsh)

本文描述 `novelcraft-dsh` **0.1.3** 的数据存储与网络数据流, 供插件市场条目与使用者查阅。
声明均对应仓库内源码/规格, 标注了出处位置。

## 存储在哪里

- **书库(vault)**: 默认 `~/Novels`, 可在 DSH profile 的 `cordis.patch.yml` 中经
  `vaultsDir` 修改(见 `plugin/README.md`)。每本书是一个独立 git 仓库; 正文与人物/
  设定/大纲等资产为 frontmatter 文本文件 + git commit, 无数据库。
- **工作流留痕**: 深度导入 run 的 manifest/checkpoint、生成提案暂存、llm_step journal
  位于书库内 `.assistant/` 目录, 属派生/留痕数据(部分随 git 提交保留, 供审计与恢复)。
- **配置**: 书级执行配置存于书内 `.assistant/llm.yml`, 只含模型名与参数, 不含密钥
  (铁律 6/N5, `packages/novelcraft/dsh/src/config.ts`); 插件级配置在 DSH profile 的
  `cordis.patch.yml`。

## 密钥

- 模型密钥只通过 DSH credentials 子系统管理, 不进入书库或插件配置文件
  (AGENTS.md 铁律 6; `plugin/README.md`)。
- 插件对配置键做敏感键判定: 归一化后命中 key/token/secret/credential 等即拒绝,
  Key/secret 不进入配置面/指纹面/journal/manifest, 错误消息只报键名不报键值
  (`packages/novelcraft/llm-step/src/secret-keys.ts`, 铁律 6/N5)。
- llm_step journal 不保留模型输出字节, 只记录哈希(promptHash/outputTextHash)、
  用量与状态(`llm-step/src/types.ts` JournalEntry: 「Durable journal must not retain
  model output bytes」; callReceipt「never includes reasoning text or secrets」)。

## 发送出去什么(网络数据流)

- **LLM 内容调用**: 受控生成、深度导入等内容手步骤会把任务相关内容(上下文片段、
  待导入文本、生成中间结果)发送到你在 DSH profile 中配置的模型 provider; 发送范围
  由编排策略(context 编译预算淘汰等)决定。不配置 provider 密钥则内容生成功能不可用。
- **可选 BGE 嵌入(默认关闭)**: 启用后首次嵌入需联网下载开源模型文件
  (Xenova/bge-small-zh-v1.5, 经 `@huggingface/transformers`), 之后本地缓存复用,
  嵌入计算在本机进行(`packages/novelcraft/rag-bge/src/index.ts`)。
- **客户端通道**: Web 写作界面与插件间通信经 DSH 连接认证, 官方默认部署为本机
  loopback; 该通道只读信号与记录决定, 不写创作资产(AGENTS.md 铁律 3)。
- **遥测**: 插件源码不含遥测/统计上报代码。

## 降级行为

默认 `embedding: off`; 可选嵌入包缺失或加载失败时检索降级为文本链并记录
`embedding_failed`, 不会阻断写作(README「源码开发」节)。

## 删除与退出

- **删除某本书**: 删除 `vaultsDir` 下对应书目录即可(含全部资产与 `.assistant/`
  留痕)。如你为书库自行添加了远程仓库, 远端 git 历史需另行处理。
- **卸载插件**: `dsh plugin --profile web remove novelcraft-dsh`; 卸载不删除已生成的
  书库文件。
- **索引/缓存**: 全部派生索引可从文件随时重建(`novelcraft_store_index`), 删除后可重建。
