# Hermes 自举 Prompt：域名 / 反代 / 网关插件 / 一次性连接码

> 把下方整段粘给已经在服务器上运行的 Hermes。它做四件事：判断现状 →（必要时）配域名与反代 → 装
> `pi-workbench-gateway` 并验证 → 返回一次性连接码。只支持「域名 + 反向代理 + HTTPS」。
> 应用入口：云端「连接」页 →「复制自举 Prompt」（构建时 `?raw` 内联，改这里就是改应用）。
> `{{PLUGIN_REPO}}` 由 `src/utils/hermesPrompt.ts` 注入，**不钉版本**；约束见 `tests/hermes-prompt.test.ts`。
> 方案与验收：[CLOUD_AGENT.md](./CLOUD_AGENT.md)。

```text
# 任务：把这台服务器上的 Hermes 配到「可被 Pi Workbench 配对」，并生成一次性连接码

只支持「域名 + 反向代理 + HTTPS」一种形态。做不到就报告并停止，不要用 IP 直连 / 自签证书 / 明文 HTTP 替代。
按顺序执行；每步贴原始输出，失败就停在那一层并说明卡在哪。

## 三个域名

- `hub.<域名>`：唯一对外入口，反代到网关插件（默认 127.0.0.1:8484）。SSE 不能被缓冲。
- `dash.<域名>`：控制台，反代到 dashboard（默认 127.0.0.1:9119）；插件不代理它。
- `api.<域名>`：只需本机可达。已存在就保持原样，不要新建、不要删。

## 铁律

1. 不改防火墙 / 安全组 / DNS。端口只检测并报告；DNS 只在用户给了 API 凭据并确认后新增记录。
2. 已有密钥一律复用，不轮换。改任何文件前备份 `cp -a X X.bak-$(date +%Y%m%d-%H%M)`。
3. **不得在对话里输出任何明文密钥**（管理密钥、API key、控制台口令、session token），只给脱敏形式；不写进 git / 工作区 / config.yaml / shell history / 日志，不 scp，不建凭证文件。
4. 不停用、不卸载已有 Web 服务器，只在其上新增站点；不重启与本次改动无关的服务。
5. 只装 {{PLUGIN_REPO}} 这一个插件，装仓库默认分支最新版，不钉版本号。
6. 验证只用只读请求，不创建真实 run（省 token）。

## 第一步 判断现状（只读）

1. `hermes --version`；公网出口 IP（`curl -s ifconfig.me`）。
2. `ss -ltnp | grep -E ':(80|443)\b'`：谁占着 80/443、已有哪些 Web 服务器。
3. 对外提供 API 的是哪个 profile（`~/.hermes/profiles/`、`systemctl list-units 'hermes*'`、反代指向的本地端口）；多个时说明选择依据。
4. **gateway 形态**：`hermes gateway list`。若这个 profile 显示 "served by the default multiplexer" → **报告并停止**：多路复用进程不读 profile 的 `.env`、也不起 api_server，装上去只是空壳。要装先退回自带单元：`hermes -p <profile> gateway install --force --system --start-now`。
5. api_server（默认 8642）与 dashboard（默认 9119）在不在：`ss -ltn | grep -E ':(8642|9119)\b'`、`systemctl list-units 'hermes*dashboard*'`。
6. 插件现状：`<profile>/plugins/pi-workbench-gateway/` 是否存在、`ss -ltn | grep 8484`、`curl -s 127.0.0.1:8484/v1/hub/health`。
7. 已有密钥只看"键在不在"：`grep -c '^PI_HUB_ADMIN_KEY=' <profile>/.env`；**不要读值**。

按结果定形态：**A** 反代与两个域名 HTTPS 都通 → 跳到第三步只做验证；**B** 有域名无反代 → 做第二步；**C** 没域名 → 先备域名再做第二步。
需要用户提供信息时一次性问完，不要反复打断。

## 第二步 域名与反向代理（形态 A 跳过）

1. 需要两条 A 记录指向本机公网 IP：`hub.<域名>`、`dash.<域名>`；给出可照抄的记录示例（类型 A / 主机 hub、dash / 值 = 公网 IP）。
2. 80/443 未放行时**不要尝试放行**，请用户去云控制台放行，然后停止等用户回来。
3. 用户确认后 `dig +short hub.<域名>` 验证指向；未生效就报"传播中"并停止。
4. 反代：已有 nginx / apache / caddy → 新增虚拟主机，不覆盖、不卸载；都没有 → 装 Caddy（校验下载来源，先备份 Caddyfile）。
   - `hub.<域名>` → 127.0.0.1:8484，**必须关掉响应缓冲**（Caddy 用 `flush_interval -1`），否则 SSE 会被攒成一坨。
   - `dash.<域名>` → 127.0.0.1:9119，读超时放长。
5. 先 `caddy validate` 再 reload；证书走 HTTP-01，失败就报失败，不要退回自签。
6. 记录证书到期时间与两个域名的 HTTP 状态码。

## 第三步 装插件

1. `hermes plugins list` 看有没有 `pi-workbench-gateway`：
   - 已有 → 不重装（覆盖可能丢 git 来源）；跟版用 `hermes plugins update pi-workbench-gateway`。
   - 没有 → 先把管理密钥放进临时变量（不 echo）：
     `  ADMIN_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')`
     再喂给安装提示（`HERMES_HOME` 必须指向 profile 目录，不是 `~/.hermes`）：
     `printf '%s\n' "$ADMIN_KEY" | hermes plugins install {{PLUGIN_REPO}} --yes-deps --enable`
     随后 `unset ADMIN_KEY`。装完记录实际提交：`git -C <profile>/plugins/pi-workbench-gateway rev-parse HEAD`。
     仓库是公开的、不需任何凭据；需要凭据说明地址被改过 → 报告并停止。
2. 校验（两条命令参数不同，别弄反）：
   `hermes plugins validate <profile>/plugins/pi-workbench-gateway`（收**目录**，传名字会报 not a directory）
   `hermes plugins doctor pi-workbench-gateway --ci`（收**名字**）
   有错就贴原始输出并停止。

## 第四步 配置与重启

配置只写 `<profile>/.env`（或 systemd drop-in，**二选一，别两处都放**）：

- `PI_HUB_ADMIN_KEY`：已有复用；缺失由第三步的安装提示写入。
- `PI_HUB_PUBLIC_URL=https://hub.<域名>`、`PI_HUB_PUBLIC_DASHBOARD_URL=https://dash.<域名>`、`HERMES_API_BASE=http://127.0.0.1:<api端口>`、`PI_HUB_PORT=8484`、`PI_HUB_HOST=127.0.0.1`。
- **`HERMES_DASHBOARD_SESSION_TOKEN` 必须配**：缺了它，桌面读审批档位会得到 502/401（控制台能打开不代表这个通，两套凭据）。已有复用，缺失才生成：
  `  printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\n' "$(python3 -c 'import secrets;print(secrets.token_hex(32))')" >> <profile>/.env`
  dashboard 与网关读同一个值，两边才对得上。

改完必须重启该 profile 的 dashboard 与网关，让新变量进进程：
`sudo systemctl restart hermes-dashboard-<profile> hermes-gateway-<profile>`

**别用 `sudo hermes ... gateway restart --system`**：root 跑 hermes 会因安装目录属主不是 root 而拒绝，命令退出但服务仍在跑旧代码，极易误判成"改动没生效"。

## 第五步 验证（全绿才发连接码）

1. 端口：`ss -ltn | grep 8484` 有监听且只绑 127.0.0.1；`ss -ltnp | grep -E ':(80|443|8484)\b'`。
2. 网关：`curl -s 127.0.0.1:8484/v1/hub/health` → `status=ok`、`upstreamOk=true`（瘦身版，没有设备计数与上游版本，别以为缺功能）。
3. 管理面：`curl -s 127.0.0.1:8484/v1/hub/status -H "X-Pi-Admin-Key: $ADMIN_KEY"` → `adminKeyConfigured=true`、`upstreamVersion` 有值（密钥只进临时变量，验证完 unset）。
4. 鉴权：`curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8484/v1/devices/me` → `401`（不要为验证登记假设备）。
5. **dashboard 配置面（最容易漏的一条）**：`curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HERMES_DASHBOARD_SESSION_TOKEN" 127.0.0.1:9119/api/config` → **必须 200**。401 = token 没进 dashboard 进程；502 = dashboard 自己转发上游失败。
6. 公网：`curl -s https://hub.<域名>/v1/hub/health` → 200 且 `upstreamOk=true`；`curl -s -o /dev/null -w '%{http_code}' https://dash.<域名>/` → 200，或被 basic auth 保护时 401（注明即可）。
7. 插件 INFO 日志不进 journalctl，判断存活只看上面 curl。

任一条不绿：报告卡在哪一层（DNS / 证书 / 反代 / 插件 / 网关 / 上游 / dashboard）并停止；不造假设备、不发连接码。

## 第六步：生成一次性连接码并交付

1. 从 `<profile>/.env` 取管理密钥到临时变量（不 echo）：
   `  ADMIN_KEY=$(sed -n 's/^PI_HUB_ADMIN_KEY=//p' <profile>/.env | head -1)`
   若当初写进 systemd drop-in：`systemctl show -p Environment <gateway-unit> --value | tr ' ' '\n' | sed -n 's/^PI_HUB_ADMIN_KEY=//p'`
2. `curl -s -X POST https://hub.<域名>/v1/devices/pairing -H "X-Pi-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{}'`
3. 期望 `201`：`{"code":"ABCDE-FGHJK","expiresAt":1793938800,"pairingUrl":"https://hub.<域名>/#pair=ABCDE-FGHJK"}`
   `503 pairing_disabled` = 密钥没进服务环境（`.env` 缺或服务没重启）→ 回第四步并停止。
4. 立刻 `unset ADMIN_KEY`。
5. 对话里给出可直接粘贴的 `pairingUrl`（没有就用 `https://hub.<域名>/#pair=<code>`），并说明：桌面 → 云端「连接」页 → 粘到「连接码」→「配对并连接」；10 分钟内有效、只能用一次；过期就重跑本步。
6. 只贴连接码，不贴管理密钥 / `Authorization` / 环境变量。

## 收尾

1. 一句话结论（可用 / 有阻塞）+ 形态 A/B/C + 改了哪些文件、备份在哪。
2. 插件实际提交与 `hermes plugins list` 状态；第五步各条的原始状态码 / 关键字段。
3. 配对链接与过期时间；失败时说明卡在哪一层，不要凭猜测给结论。
```
