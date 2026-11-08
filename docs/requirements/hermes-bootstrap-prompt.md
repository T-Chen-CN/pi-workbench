# Hermes 自举 Prompt：域名 / 反向代理 / 网关插件 / 一次性连接码

> 用途：用户把下方代码块里的整段内容粘给已经在服务器上运行的 Hermes Agent。
> 它会：判断现状 →（必要时）配好域名与反向代理 → 装好 `pi-workbench-gateway` 插件 →
> 配好管理密钥 → 验证 → **生成一次性连接码**。
> 支持的形态：**域名 + 反向代理（HTTPS）**。不支持无域名 / 纯 IP 直连。
> 前提：执行者本来就能与 Hermes 对话（控制台登录或 SSH）。
> 应用内入口：Pi Workbench 云端「连接」页 →「复制自举 Prompt」。
> 按钮复制的就是下方代码块（构建时用 vite 的 `?raw` 从本文内联，所以**改这里就是改应用**；
> `tests/hermes-prompt.test.ts` 守住代码块存在与完整性）。
> 状态：**已上线**。插件 `pi-workbench-gateway` 已发布（真机线上是 0.1.1），本 Prompt 随 0.8.0 一起发。
> 交付格式：**只在对话里返回连接码与配对链接**，不写文件、不 `scp`、不把管理密钥交给桌面端。
> 代码块里的 `{{PLUGIN_REPO}}` 是**占位符**：由应用在复制时注入
> （`src/utils/hermesPrompt.ts` 的 `PLUGIN_REPO` 常量）。**不写版本号**：引导装的是插件仓库默认分支
> 的最新版，之后用 `hermes plugins update` 跟版 —— 钉 SHA 只属于运维侧（要复现某次部署时才用）。
> `tests/hermes-prompt.test.ts` 守着「复制出来的内容不含 `{{`、也不带 `--ref`」。
> 方案与验收：[CLOUD_AGENT.md](./CLOUD_AGENT.md)。

```text
# 任务：把云端 Hermes 配置到「可被 Pi Workbench 配对」的状态，并生成一次性连接码

你是运行在这台服务器上的 Hermes Agent，拥有该机器的 shell 权限（可能通过 sudo）。
请按顺序执行下面六个步骤。不要长篇解释背景；每一步如实报告，做不到就明确说卡在哪一层并停止。

**支持的形态只有一种**：域名 + 反向代理 + HTTPS 证书。
如果这台机器无法达到这个形态（没有域名、或 80/443 无法放行），就按第二步的"阻塞"处理并停止，
不要用 IP 直连、自签证书或明文 HTTP 作为替代。

## 三种域名角色（先记住这个，后面都用得上）

- `hub.<域名>`：**唯一对外入口**。Pi Workbench 桌面端的所有云端请求都打这里，
  由 `pi-workbench-gateway` 插件监听在 127.0.0.1 的端口上，反代只做 TLS 终止与转发。
  SSE 不能被缓冲。
- `dash.<域名>`：控制台（Hermes Dashboard），插件**不代理**它，桌面端内嵌视图直接访问。
- `api.<域名>`：**只需要本机可达**。桌面端不需要它的公网入口。
  如果它已经存在，保持原样（可能有别的客户端在用），**不要**新建、也不要删。

## 硬性禁止（违反即中止）

1. 不修改防火墙/网络策略：不改 iptables、nftables、ufw、firewalld、云安全组、任何自定义链。
   端口只做**检测并报告**，不放行、不封禁。
2. 不修改 DNS 记录。**除非**用户主动提供了 DNS 服务的 API 凭据，并且在你复述"将新增哪几条记录"后
   明确确认，才可以创建。否则只输出"需要用户手动添加的记录"，然后等用户完成。
3. 不轮换已有的 API 密钥 / 控制台口令。已存在就复用，只有缺失时才生成。
4. **不停用、不卸载、不替换机器上已有的 Web 服务器**（nginx / apache / 已有的 caddy 实例）。
   只能在其上新增站点配置；若无法安全共存，报告并停止。
5. 不删除任何已有会话、配置、日志。修改任何文件前先备份：
   `cp -a <文件> <文件>.bak-$(date +%Y%m%d-%H%M)`
6. 不重启服务，除非本次确实改动了该服务的配置；重启前用一句话说明（会打断进行中的会话）。
7. **不得在对话里输出任何明文密钥**（管理密钥、API 密钥、控制台口令）。只允许脱敏形式，
   例如 `zsr****m2Rc`。这条没有例外。
8. 不把管理密钥写进 git 仓库、agent 工作区、profile 的 `config.yaml`、shell history 或日志。
9. **只能安装指定的网关插件**：只允许 `{{PLUGIN_REPO}}`（见第四步）。
   不要从其他来源找插件、不要凭记忆重写一份、不要装别的仓库的同名插件。装不上就报告并停止。
10. 不创建凭证文件，不 `scp`，不把管理密钥交给用户或桌面端。

## 第一步：判断现状（只读，不改任何东西）

按顺序判断，命中即停，并把这个结论用作后面步骤的输入：

- **形态 A（齐备）**：已有反向代理，`hub.<域名>` 与 `dash.<域名>` 的 HTTPS 都能从公网访问，
  且 `curl -s https://hub.<域名>/v1/hub/health` 返回 200 → 跳到第四步（只做验证），
  但第四步里"管理密钥是否已配"仍要检查（`adminKeyConfigured` 必须是 true）。
- **形态 B（有域名，无反代）**：域名已解析到本机，但没有反向代理或没有证书 → 做第二、三步。
- **形态 C（没有域名 / 尚未解析）**：→ 执行下面的"域名准备"，再回到形态 B。

无论哪种形态，都先记录：

1. Hermes 版本（`hermes --version` 或启动日志）。
2. 本机公网出口 IP（`curl -s https://ifconfig.me` 之类），后面告诉用户 DNS 要指向哪里。
3. 80 / 443 端口当前由谁占用（`ss -ltnp | grep -E ':(80|443)\b'`），以及已有的 Web 服务器。
4. 对外提供 API 的是哪个 profile（结合 `~/.hermes/profiles/`、`systemctl list-units 'hermes*'`、
   反向代理配置里转发到的本地端口）。多个 profile 时选反代指向的那个，并说明判断依据。
   **顺带记下发 gateway 的形态**：`hermes gateway list` —— Hermes 0.23 起默认是「一个 default
   gateway 多路复用所有 profile」，per-profile 的 systemd 单元已被上游标记为不再支持
   （`hermes gateway migrate --dry-run` 能看清差异，不改任何东西）。
   **但如果 `hermes gateway list` 显示这个 profile 是 "served by the default multiplexer"，本 Prompt
   到这里就停下并原样报告**：多路复用进程不读 profile 的 `.env`，也不起 profile 的 api_server，
   装上去只会得到一个「监听 8484 但没有管理密钥、没有上游」的空壳。要装就先把该 profile 退回自带的
   gateway 单元（`hermes -p <profile> gateway install --force --system --start-now`），再继续。
5. api_server 的本地端口（默认 8642）与是否启用；dashboard 的本地端口（默认 9119）与是否常驻。
6. 控制台的认证方式：反代层 basic auth 还是页面自带登录表单。
   用 `curl -s -o /dev/null -w '%{http_code}'` 配合页面内容判断，不要猜。
7. **网关插件现状**：profile 的 `plugins/pi-workbench-gateway/` 是否存在；
   `ss -ltn | grep 8484` 是否有监听；`curl -s 127.0.0.1:8484/v1/hub/health` 是否 200。
8. **管理密钥现状**：`<profile>/.env` 与 systemd 服务环境里是否有 `PI_HUB_ADMIN_KEY`
   （`grep -c '^PI_HUB_ADMIN_KEY=' <profile>/.env` 与 `systemctl show -p Environment <unit>`；
   只报告"键存在"，**不要读值、不要复制到对话、不要写进文件**）。已有就复用，绝不轮换。
9. 现有控制台口令：能读到或用户提供了就复用；读不到标记为"不可得"。

需要用户提供信息时，**把所有问题集中成一次提问**，不要反复打断。

## 第二步：域名准备（仅形态 C）

1. 告诉用户需要**一个域名 + 两条 A 记录**，都指向本机公网 IP（上面查到的）：
   - `hub.<域名>` → Pi Workbench 网关（唯一入口）
   - `dash.<域名>` → 控制台
   - `api.<域名>` 只在用户想保留旧入口时才需要；公网可不加。
2. 给出可直接照抄的记录示例（类型 A、主机记录 hub / dash、值 = 公网 IP）。
3. 检查 80 / 443 是否已放行。**未放行时不要尝试放行**，而是明确告诉用户：
   「证书申请需要 80 端口可达（HTTP-01），请你在云控制台的安全组里放行 80 和 443，我不会代做。」
   然后停止，等用户回来。
4. 等用户说"域名解析好了"之后，用 `dig +short hub.<域名>` / `dash.<域名>` 验证是否已指向本机公网 IP。
   未生效就报告"还在传播中，未生效"并停止（不要继续配证书）。

## 第三步：反向代理与证书（形态 B / C）

1. 先看 80/443 的占用者：
   - 已有 nginx / apache → 在它上面**新增虚拟主机**，不要卸载、不要换端口。
   - 已有 caddy 在为别的站点服务 → 在现有 Caddyfile 里**追加站点**，不要覆盖整个文件。
   - 都没有 → 安装 Caddy（固定一个明确版本，校验下载来源），先备份 `/etc/caddy/Caddyfile`（若存在）。
2. 配置两个必需站点，要点：
   - `hub.<域名>` → 转发到网关插件的本地端口（默认 8484）。**必须关闭响应缓冲**，
     否则 SSE 会被攒成一坨（Caddy 用 `flush_interval -1`）。
   - `dash.<域名>` → 转发到控制台的本地端口；给它较长的读超时（控制台页面 / 长连接）。
   - 反代可以先指向网关端口，即使插件还没起来（第四步装好后就通了）；
     装完插件必须重新验证一遍。
3. 应用配置前先做语法校验（`caddy validate --config ...` 或等价命令）。
4. 申请证书（HTTP-01）。**失败就报告失败**：不要退回自签证书，不要退回明文 HTTP。
5. 验证并记录：证书到期时间（`openssl s_client` + `x509 -noout -enddate`）、两个域名各自的 HTTP 状态码。

## 第四步：网关插件 + 管理密钥（只补缺口）

网关插件是本地与云端之间**唯一**的通道，所以这一步必须做干净。

1. **插件来源**：唯一允许的来源是 `{{PLUGIN_REPO}}`。**装仓库默认分支的最新版，不要钉任何版本号**
   （钉版本是运维的事，不是引导的事：装完就跟版靠 `update`，每次插件发版不该回头改这份 Prompt）。
   先看 `hermes plugins list` 里有没有 `pi-workbench-gateway`：
   - **已有** → 不要再装（重装/覆盖可能丢 git 来源），需要跟版就
     `hermes plugins update pi-workbench-gateway`。
   - **没有** → 先做第 2 小步（把密钥放进临时 shell 变量），再在 profile 里装
     （`HERMES_HOME` 必须指向 profile 目录，不是 `~/.hermes`）。
     Hermes 的官方安装会克隆到 `<profile>/plugins/pi-workbench-gateway/`（目录名取自仓库名），
     装完提示填写 `PI_HUB_ADMIN_KEY` 并把它写进 `<profile>/.env`。用管子把值喂给提示：

     - 执行（`HERMES_HOME` 指向 profile）：
       `printf '%s\n' "$ADMIN_KEY" | hermes plugins install {{PLUGIN_REPO}} --yes-deps --enable`
     - 随后 `unset ADMIN_KEY`。整条命令一行写完，方便直接粘贴。
     - 清单里 `requires_env` 声明成纯字符串，提示读的是 stdin，所以非交互场景也走得通。
     - `--yes-deps` 省掉 pip 依赖确认；`--enable` 省掉启用确认（插件只依赖标准库，不装任何包）。
     - 装完**如实记录实际落到的提交**（收尾报告里写一行）：
       `git -C <profile>/plugins/pi-workbench-gateway rev-parse HEAD`
     - 仓库是公开的，**不需要任何凭据 / deploy key**；需要凭据才能拉 → 说明地址被改过，报告并停止。
   - **装失败** → 贴原始错误并停止。不要退回手写插件、不要换别的仓库。
2. **管理密钥**（`PI_HUB_ADMIN_KEY`）——它是"签发设备凭证"的钥匙，只在这台机器上：
   - **已存在就复用，绝不轮换**（轮换会让所有已登记设备失效）。
   - 缺失才生成到临时 shell 变量（**不要 echo**）：
     `ADMIN_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')`
   - 落盘位置是 `<profile>/.env`（Hermes 官方约定，与 `API_SERVER_KEY` 同处），由上一步的安装提示写入；
     **不要**另抄一份到 `config.yaml`、shell history、日志或任何文件，也不要把值交给用户。
   - 非密钥配置（`PI_HUB_PUBLIC_URL=https://hub.<域名>`、
     `PI_HUB_PUBLIC_DASHBOARD_URL=https://dash.<域名>`、
     `HERMES_API_BASE=http://127.0.0.1:<api端口>`、`PI_HUB_PORT=8484`、`PI_HUB_HOST=127.0.0.1`）
     写进 `<profile>/.env` 或 systemd drop-in，**二选一，别两处都放**。
3. **清单自检**（Hermes 的安装命令不会自动校验，要单独跑）：
   `hermes plugins validate <profile>/plugins/pi-workbench-gateway`——注意 `validate` 收的是
   **目录**，传插件名会得到"not a directory / Validation failed"（不是插件有问题）；
   `hermes plugins doctor pi-workbench-gateway --ci` 才收插件名。有错就贴原始输出并停止。
4. **重启**承载该 profile 的 gateway 服务——**必须重启**：装完 Hermes 会打印
   "Gateway reloaded plugins; nothing of this plugin needs a session or restart"，但插件读的是
   **进程环境**，`.env` 里的 `PI_HUB_ADMIN_KEY` 只有新进程才看得见；不重启的表现是 8484 根本不监听、
   日志喊 "PI_HUB_ADMIN_KEY is not set"。重启的是**该 profile 自己的** gateway 单元
   （`sudo systemctl restart hermes-gateway-<profile>.service`）：本插件靠进程环境读
   `PI_HUB_ADMIN_KEY` 与 `API_SERVER_KEY`，而这两样只在该 profile 的单元（`.env` + drop-in
   `10-api-server.conf`）里才存在。
   **别用 `sudo hermes ... gateway restart --system`**：root 跑 hermes 会去「准备依赖环境」，
   发现 `<hermes 安装目录>` 属主是安装用户后直接拒绝（`owned by uid 1000, not the current uid 0`），
   命令退出但服务照旧跑旧代码——排查时极易误判成「改的代码没生效」。重启后验证：
   - `ss -ltn | grep 8484` → 有监听，且只绑 `127.0.0.1`
   - `curl -s 127.0.0.1:8484/v1/hub/health` → `{"status":"ok", "upstreamOk":true, ...}`
     （**瘦身版**：只回 `status` / `upstreamOk` / `hub` / `contractVersion` / `features`，
     没有设备计数与上游版本——别以为插件缺功能）
   - `curl -s 127.0.0.1:8484/v1/hub/status -H "X-Pi-Admin-Key: <密钥>"` → 完整诊断，
     确认 `adminKeyConfigured=true`、`upstreamVersion` 有值
     （密钥按第六步第 1 条从 `.env` 取到临时变量，**不要 echo**）
   - `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8484/v1/devices/me` → `401`
     （没带设备 token 就该拒，说明鉴权在网关这一层）
5. 插件日志：**INFO 级不进 journalctl**（只有 WARNING 及以上进）。
   判断插件活着就看上面两个 curl，不要因为 journalctl 空就以为它挂了。

## 第五步：验证（贴原始输出，不许只说"已确认"）

1. DNS：`dig +short hub.<域名>` / `dash.<域名>` 指向本机公网 IP
2. 证书：`echo | openssl s_client -connect hub.<域名>:443 -servername hub.<域名> 2>/dev/null | openssl x509 -noout -enddate`
3. 网关健康（公网）：`curl -s https://hub.<域名>/v1/hub/health`
   → 200，且 `status=ok`、`upstreamOk=true`
   （health 已是瘦身版；`adminKeyConfigured`、`upstreamVersion`、设备计数要到需凭据的
   `/v1/hub/status` 才有——公网匿名面上不该出现这些）
4. 网关鉴权：`curl -s -o /dev/null -w '%{http_code}' https://hub.<域名>/v1/devices/me`
   → `401`（没有设备 token；有 token 才 200。**不要**为了验证去登记假设备）
5. 控制台：`curl -s -o /dev/null -w '%{http_code}' https://dash.<域名>/`
   200 正常；被 basic auth 保护时未带凭据返回 401 也算正常，注明即可
6. 端口：`ss -ltnp | grep -E ':(80|443|8484)\b'`（8484 只能是 127.0.0.1）

不要为了验证创建一个真实的 run（会产生 token 花费）。最多发只读请求。

## 第六步：生成一次性连接码并交付

1. 从 `<profile>/.env` 取管理密钥到临时 shell 变量，**不要 echo、不要写文件**：
   `ADMIN_KEY=$(sed -n 's/^PI_HUB_ADMIN_KEY=//p' <profile>/.env | head -1)`
   （若当初把密钥放进了 systemd drop-in，则改用
   `systemctl show -p Environment <gateway-unit> --value | tr ' ' '\n' | sed -n 's/^PI_HUB_ADMIN_KEY=//p'`）
2. 调网关生成连接码：
   `curl -s -X POST https://hub.<域名>/v1/devices/pairing -H "X-Pi-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{}'`
3. 期望返回 `201`，形如：
   `{"code":"ABCDE-FGHJK","expiresAt":1793938800,"pairingUrl":"https://hub.<域名>/#pair=ABCDE-FGHJK"}`
   如果返回 `503 pairing_disabled`，说明密钥没进服务环境（`.env` 里缺，或服务没重启加载）；
   回第四步检查并停止。
4. 立即 `unset ADMIN_KEY`。
5. 在对话里给用户**可直接粘贴的 `pairingUrl`**（没有 `pairingUrl` 就用
   `https://hub.<域名>/#pair=<code>`），并说明：
   - 打开 Pi Workbench → 云端「连接」页 → 粘贴到「连接码」→「配对并连接」
   - 连接码 10 分钟内有效，只能使用一次
   - 过期就在服务器重跑本步骤，生成新码
6. **不要**把管理密钥、`Authorization`、完整环境变量贴进对话；连接码本身可以贴，但不要写进日志或文件。

## 收尾报告（简短）

1. 一句话结论：可用 / 有阻塞。
2. 本次属于哪种形态（A / B / C），做了哪些改动，备份在哪。
3. 插件实际安装的提交（`git rev-parse HEAD`）与 `hermes plugins list` 里的状态。
4. 第五步四项验证的原始状态码 / 关键字段。
5. 给用户的配对链接与过期时间。
6. 任何一项验证失败时，说明卡在哪一层（DNS / 证书 / 反代 / 插件 / 网关 / 上游 / 控制台），
   不要凭猜测给结论。

## 边界

- 本次任务会读取并生成服务器上的密钥，这是用户明确要求的。
- 如果用户说"只是自己用、别重置控制台口令"，以用户的要求为准。
- 只能用域名 + 反向代理 + HTTPS 这一种形态；不提供 IP 直连、自签证书、明文 HTTP 的替代方案。
- 任何一步失败都不要往下猜，报告并停止。
```
