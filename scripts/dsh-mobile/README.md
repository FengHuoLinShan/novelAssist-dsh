# dsh-mobile:移动端远程访问 DSH + DeepSeek App 风格移动界面

让手机在**局域网**或**任意网络(Tailscale)**上访问本机 `dsh web` 服务并完整交互,
窄屏(<720px)呈现 DeepSeek App 式布局;桌面端(127.0.0.1)体验不变。

## 改了什么

| 层 | 内容 |
|---|---|
| 宿主(全局安装的 `@deepseek-ai/dsh`) | 解锁 `dsh web --host 0.0.0.0`;新增 `--pair-pin`;`/api/pair` PIN 配对端点;非 loopback 请求必须持配对 Cookie(401 + `WWW-Authenticate: DSH-Pair`),loopback 直通;错 PIN 限速 5 次/分钟;`settings/credentials` 等特权方法仍锁本机 |
| 前端(harness 源码构建) | 窄屏移动布局:顶栏(菜单+模型胶囊)、抽屉式会话列表、底部停靠输入条(安全区)、全屏配对页;PWA manifest 增强;桌面布局不动 |

安全模型:Host 围栏(防 DNS rebinding/跨站)只判「来源是不是可信地址」,**不判人**;
PIN 配对补上「这个设备是不是被授权」这一层。PIN 与配对 token 仅存内存,服务重启后
终端会打印新 PIN,手机需重新配对。

## 目录与脚本

```sh
node scripts/dsh-mobile/build-frontend.mjs   # 在 harness 源码克隆构建前端 -> stage/frontend-dist
node scripts/dsh-mobile/apply.mjs            # 部署宿主补丁 + 前端 dist 到全局 dsh(幂等, 带备份与防呆)
node scripts/dsh-mobile/revert.mjs           # 从 .novelcraft-orig 备份还原
```

- `apply.mjs` 会在目标内容与「备份」「stage」都不一致时 **fail-loud**(典型场景:升级 dsh
  后被新版本覆盖)→ 此时 review 补丁、重新基线化 `stage/` 后再重放。
- 环境变量:`DSH_GLOBAL_ROOT`(全局 dsh 包根)、`DSH_HARNESS_CHECKOUT`(harness 克隆路径)。
- `stage/` 是补丁唯一真源;harness 源码改动记录在该克隆的 `mobile-lan` 分支。

## 使用

### 1. 局域网访问

```sh
dsh --profile web --host 0.0.0.0          # 从本机正常启动(工作目录不变)
# 终端会打印:
#   dsh web: http://127.0.0.1:3080 (LAN: http://192.168.0.108:3080, …)
#   dsh web: pairing PIN for non-local clients: 483920
```

手机连同一 Wi-Fi,打开 `http://192.168.0.108:3080` → 配对页输入 PIN → 正常聊天。
本机浏览器访问 `127.0.0.1:3080` 不需要 PIN。

- 固定 PIN:`--pair-pin 483920`(4–8 位数字)。
- 首次监听 0.0.0.0 时 macOS 防火墙若弹窗,允许 node 接受入站连接。

### 2. 外网访问(Tailscale 私有组网,已选型)

1. Mac 与手机都安装 [Tailscale](https://tailscale.com/download) 并登录同一账号。
2. 保持上一步的启动方式(`--host 0.0.0.0` 已覆盖 Tailscale 接口)。
3. 手机(即使在外网/移动数据)打开 `http://<本机 100.x Tailscale IP>:3080`,
   输入 PIN 配对即可。全程 WireGuard 端到端加密,无需公网端口/域名/TLS。

注意:用 Tailscale **MagicDNS 域名**访问时需追加 `--trusted-host <机器名>.<tailnet>.ts.net`
(域名 Host 不在自动信任的 IP 字面量列表内);直接用 100.x IP 则无需任何额外参数。

### 3. 后续可选:Cloudflare Tunnel(有域名时)

```sh
dsh --profile web --host 127.0.0.1 --trusted-host <public.example.com> --pair-pin 483920
# 反代(cloudflared/Caddy)连 127.0.0.1:3080 且【保留原始 Host 头】;TLS 由隧道/反代终结
```

### 升级 dsh 后

`npm i -g @deepseek-ai/dsh@latest` 会覆盖补丁与前端 → 重新 `node scripts/dsh-mobile/apply.mjs`
(若 fail-loud 说明补丁需要随新版 review 重基线)。前端一般也需要重新
`build-frontend.mjs` 以匹配新版宿主协议。

## 验证清单

- [ ] 本机 `curl http://127.0.0.1:3080/api/pair` → `{"paired":true}`(无需 PIN)
- [ ] LAN 侧 `curl -H 'Host: 192.168.0.108:3080' http://127.0.0.1:3080/api/pair` → `{"paired":false}`
- [ ] 未配对调业务接口 → 401 `pairing-required`
- [ ] 错 PIN 5 次 → 429 限速;正确 PIN → 200 + Set-Cookie,后续请求放行
- [ ] 手机持配对 Cookie 调 `settings.describe` → 仍 403(特权锁本机)
- [ ] 手机:配对页 → 聊天/流式/工具卡片;断 Wi-Fi 走 Tailscale 复测;桌面 UI 回归

## 回退

```sh
node scripts/dsh-mobile/revert.mjs   # 还原宿主文件与前端 dist
dsh --profile web --host 127.0.0.1   # 回到纯本机模式
```
