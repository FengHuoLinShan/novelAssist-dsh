# novelcraft-dsh

NovelCraft 的 DSH 官方 bundle 形态：单个包同时安装宿主插件、39 个领域工具、loopback RPC 和 Web 写作界面。

首发版本针对 DSH `0.1.2-alpha.4`。

## 安装

```sh
dsh plugin --profile web add novelcraft-dsh
dsh --profile web
```

默认 Vault 目录是 `~/Novels`，默认不启用低频巡检与 BGE 嵌入。模型密钥只通过 DSH credentials 管理，不进入 Vault 或插件配置。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中按 `novelcraft` 行覆盖配置；DSH patch 会整体替换 `config`，因此需完整重述保留的字段。

```yaml
- update:
    - id: novelcraft
      config:
        llm:
          provider: deepseek
          model: deepseek-v4-flash
        vaultsDir: ~/Novels
        watch:
          enabled: false
          intervalMinutes: 60
```

## 卸载

```sh
dsh plugin --profile web remove novelcraft-dsh
```

源码、安全边界和完整文档：<https://github.com/FengHuoLinShan/novelAssist-dsh>
