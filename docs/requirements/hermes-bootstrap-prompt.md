# Hermes 自举 Prompt：域名 / 反向代理 / 网关插件 / 连接凭证

> 用途：用户把下方代码块里的整段内容粘给已经在服务器上运行的 Hermes Agent。
> 它会：判断现状 →（必要时）配好域名与反向代理 → 装好 Pi Workbench 网关插件 →
> 管好管理密钥 → 验证 → 交付**一个文件**。
> 支持的形态：**域名 + 反向代理（HTTPS）**。不支持无域名 / 纯 IP 直连。
> 前提：执行者本来就能与 Hermes 对话（控制台登录或 SSH）。
> 应用内入口：Pi Workbench 云端「连接」页 →「复制自举 Prompt」。
> 按钮复制的就是下方代码块（构建时用 vite 的 `?raw` 从本文内联，所以**改这里就是改应用**；
> `tests/hermes-prompt.test.ts` 守住代码块存在与完整性）。
> 状态：**草案，未在干净机器上实跑过**。交付格式 **v2**（单入口：`GATEWAY_URL` + `ADMIN_KEY`，
> 不再有 `API_KEY` / `DASHBOARD_SESSION_TOKEN`；v1 / v1.1 文件应用仍能导入，但没有管理密钥）。
> 代码块里的 `{{PLUGIN_REPO}}` 是**占位符**：由应用在复制时注入
> （`src/utils/hermesPrompt.ts` 的 `PLUGIN_REPO` 常量）。**不写版本号**：引导装的是插件仓库默认分支
> 的最新版，之后用 `hermes plugins update` 跟版 —— 钉 SHA 只属于运维侧（要复现某次部署时才用）。
> `tests/hermes-prompt.test.ts` 守着「复制出来的内容不含 `{{`、也不带 `--ref`」。
> 已登记：[docs/README.md](../README.md) · 待办与范围边界：[BACKLOG §7.3](../progress/BACKLOG.md)。

```text
# 任务：把云端 Hermes 配置到「可被 Pi Workbench 连接」的状态，并交付凭证文件

你是运行在这台服务器上的 Hermes Agent，拥有该机器的 shell 权限（可能通过 sudo）。
请按顺序执行下面六个步骤。不要长篇解释背景；每一步如实报告，做不到就明确说卡在哪一层并停止。

**支持的形态只有一种**：域名 + 反向代理 + HTTPS 证书。
如果这台机器无法达到这个形态（没有域名、或 80/443 无法放行），就按第一步的"阻塞"处理并停止，
不要用 IP 直连、自签证书或明文 HTTP 作为替代。

## 三种域名角色（先记住这个，后面都用得上）

- `hub.<域名>`：**唯一对外入口**。Pi Workbench 桌面端的所有云端请求都打这里，
  由 Pi Workbench 网关插件（Hermes 插件 `pi-workbench`）监听在 127.0.0.1 的端口上，
  反代只做 TLS 终止与转发。SSE 不能被缓冲。
- `dash.<域名>`：控制台（Hermes Dashboard），插件**不代理**它，浏览器/桌面端内嵌视图直接访问。
- `api.<域名>`：**只需要本机可达**。桌面端不再需要它的公网入口。
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
   例如 `zsr****m2Rc`，或"已写入交付文件"。这条没有例外。**唯一的明文出口是第五步的交付文件。**
8. 交付文件不得放在任何 git 仓库或 agent 工作区内，不得被 git 跟踪。
9. **只能安装指定的网关插件**：只允许 `{{PLUGIN_REPO}}`（见第三步）。
   不要从其他来源找插件、不要凭记忆重写一份、不要装别的仓库的同名插件。装不上就报告并停止。

## 第一步：判断现状（只读，不改任何东西）

按顺序判断，命中即停，并把这个结论用作后面步骤的输入：

- **形态 A（齐备）**：已有反向代理，`hub.<域名>` 与 `dash.<域名>` 的 HTTPS 都能从公网访问，
  且 `curl -s https://hub.<域名>/v1/hub/health` 返回 200 → 跳到第四步（只做验证），
  但第三步里"管理密钥是否已配"仍要检查（`adminKeyConfigured` 必须是 true）。
- **形态 B（有域名，无反代）**：域名已解析到本机，但没有反向代理或没有证书 → 做第二、三步。
- **形态 C（没有域名 / 尚未解析）**：→ 执行下面的"域名准备"，再回到形态 B。

无论哪种形态，都先记录：

1. Hermes 版本（`hermes --version` 或启动日志）。
2. 本机公网出口 IP（`curl -s https://ifconfig.me` 之类），后面告诉用户 DNS 要指向哪里。
3. 80 / 443 端口当前由谁占用（`ss -ltnp | grep -E ':(80|443)\b'`），以及已有的 Web 服务器。
4. 对外提供 API 的是哪个 profile（结合 `~/.hermes/profiles/`、`systemctl list-units 'hermes*'`、
   反向代理配置里转发到的本地端口）。多个 profile 时选反代指向的那个，并说明判断依据。
5. api_server 的本地端口（默认 8642）与是否启用。
6. 控制台的认证方式：反代层 basic auth 还是页面自带登录表单。
   用 `curl -s -o /dev/null -w '%{http_code}'` 配合页面内容判断，不要猜。
7. **网关插件现状**：profile 的 `plugins/pi-workbench/` 是否存在；
   `ss -ltn | grep 8484` 是否有监听；`curl -s 127.0.0.1:8484/v1/hub/health` 是否 200。
8. **管理密钥现状**：`~/pi-hub-admin-key` 是否存在（只记"有/无"与权限，**不要打印内容**）；
   systemd 服务环境里是否有 `PI_HUB_ADMIN_KEY`（`systemctl show -p Environment <unit>`，
   回显若有明文，只报告"已配置"）。
9. 现有控制台口令：能读到或用户提供了就复用；读不到标记为"不可得"。

需要用户提供信息时，**把所有问题集中成一次提问**，不要反复打断。

## 第一步附：域名准备（仅形态 C）

1. 告诉用户需要**一个域名 + 三条 A 记录**，都指向本机公网 IP（上面查到的）：
   - `hub.<域名>` → Pi Workbench 网关（唯一入口）
   - `dash.<域名>` → 控制台
   - `api.<域名>` → 本机 API（只在你想保留旧入口时才需要；公网可不加）
2. 给出可直接照抄的记录示例（类型 A、主机记录 hub / dash / api、值 = 公网 IP）。
3. 检查 80 / 443 是否已放行。**未放行时不要尝试放行**，而是明确告诉用户：
   「证书申请需要 80 端口可达（HTTP-01），请你在云控制台的安全组里放行 80 和 443，我不会代做。」
   然后停止，等用户回来。
4. 等用户说"域名解析好了"之后，用 `dig +short hub.<域名>` / `dash.<域名>` 验证是否已指向本机公网 IP。
   未生效就报告"还在传播中，未生效"并停止（不要继续配证书）。

## 第二步：反向代理与证书（形态 B / C）

1. 先看 80/443 的占用者：
   - 已有 nginx / apache → 在它上面**新增虚拟主机**，不要卸载、不要换端口。
   - 已有 caddy 在为别的站点服务 → 在现有 Caddyfile 里**追加站点**，不要覆盖整个文件。
   - 都没有 → 安装 Caddy（固定一个明确版本，校验下载来源），先备份 `/etc/caddy/Caddyfile`（若存在）。
2. 配置两个必需站点，要点：
   - `hub.<域名>` → 转发到网关插件的本地端口（默认 8484）。**必须关闭响应缓冲**，
     否则 SSE 会被攒成一坨（Caddy 用 `flush_interval -1`）。
   - `dash.<域名>` → 转发到控制台的本地端口；给它较长的读超时（控制台页面 / 长连接）。
   - 现在就能配：反代先指向网关端口，即使插件还没起来（第三步装好后就通了）；
     装完插件必须重新验证一遍。
3. 应用配置前先做语法校验（`caddy validate --config ...` 或等价命令）。
4. 申请证书（HTTP-01）。**失败就报告失败**：不要退回自签证书，不要退回明文 HTTP。
5. 验证并记录：证书到期时间（`openssl s_client` + `x509 -noout -enddate`）、两个域名各自的 HTTP 状态码。

## 第三步：网关插件 + 管理密钥（只补缺口）

网关插件是本地与云端之间**唯一**的通道，所以这一步必须做干净。

1. **插件来源**：唯一允许的来源是 `{{PLUGIN_REPO}}`。**装仓库默认分支的最新版，不要钉任何版本号**
   （钉版本是运维的事，不是引导的事：装完就跟版靠 `update`，每次插件发版不该回头改这份 Prompt）。
   先看 `hermes plugins list` 里有没有 `pi-workbench`：
   - **已有** → 不要再装（重装/覆盖可能丢 git 来源），需要跟版就 `hermes plugins update pi-workbench`。
   - **没有** → 在 profile 里装（`HERMES_HOME` 必须指向 profile 目录，不是 `~/.hermes`）：
     `hermes plugins install {{PLUGIN_REPO}} --no-enable`
     - 装完**如实记录实际落到的提交**（交付说明里写一行）：
       `git -C <profile>/plugins/pi-workbench rev-parse HEAD`
     - `--no-enable` 先装不启用：`PI_HUB_ADMIN_KEY` 还没配（第 3 小步配好后在第 2 小步启用）。
     - 仓库是公开的，**不需要任何凭据 / deploy key**；需要凭据才能拉 → 说明地址被改过，报告并停止。
   - **装失败** → 贴原始错误并停止。不要退回手写插件、不要换别的仓库。
2. **让 Hermes 启用它**：在 profile 的 `config.yaml` 里 `plugins.enabled` 下加 `pi-workbench`
   （已有就不要重复加）。改动前备份。插件只依赖 Python 标准库，**不需要装任何 pip 包**；
   清单里的 `requires_env` 会在启用时确认 `PI_HUB_ADMIN_KEY` 已就位（见下一小步）。
3. **管理密钥**（`PI_HUB_ADMIN_KEY`）——它是"签发设备凭证"的钥匙，只在这台机器上：
   - **已存在就复用，绝不轮换**（轮换会让所有已登记设备失效）。
   - 缺失才生成：`python3 -c 'import secrets;print(secrets.token_urlsafe(32))'`。
   - 写到两个地方，值必须一致：
     a) 服务环境（推荐 systemd drop-in，例如
        `/etc/systemd/system/<gateway-unit>.service.d/20-pi-hub.conf`）里
        `Environment="PI_HUB_ADMIN_KEY=<值>"`，同时补 `HERMES_API_BASE=http://127.0.0.1:<api端口>`
        与 `PI_HUB_PORT=8484`、`PI_HUB_HOST=127.0.0.1`；
     b) `~/pi-hub-admin-key`，权限 600（下次要取时用，不用去翻 systemd）。
   - 不要把它写进 profile 的 `config.yaml`、不要写进 shell history、不要回显。
4. **重启**承载该 profile 的 gateway 服务（只重启这一个），然后验证：
   - `ss -ltn | grep 8484` → 有监听，且只绑 `127.0.0.1`
   - `curl -s 127.0.0.1:8484/v1/hub/health` → `{"status":"ok", ... "upstreamOk":true, "adminKeyConfigured":true}`
   - `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8484/v1/devices/me` → `401`
     （没带设备 token 就该拒，说明鉴权在网关这一层）
5. 插件日志：**INFO 级不进 journalctl**（只有 WARNING 及以上进）。
   判断插件活着就看上面两个 curl，不要因为 journalctl 空就以为它挂了。

## 第四步：验证（贴原始输出，不许只说"已确认"）

1. DNS：`dig +short hub.<域名>` / `dash.<域名>` 指向本机公网 IP
2. 证书：`echo | openssl s_client -connect hub.<域名>:443 -servername hub.<域名> 2>/dev/null | openssl x509 -noout -enddate`
3. 网关健康（公网）：`curl -s https://hub.<域名>/v1/hub/health`
   → 200，且 `status=ok`、`upstreamOk=true`、`adminKeyConfigured=true`、`upstreamVersion` 有值
4. 网关鉴权：`curl -s -o /dev/null -w '%{http_code}' https://hub.<域名>/v1/devices/me`
   → `401`（没有设备 token；有 token 才 200。**不要**为了验证去登记假设备）
5. 控制台：`curl -s -o /dev/null -w '%{http_code}' https://dash.<域名>/`
   200 正常；被 basic auth 保护时未带凭据返回 401 也算正常，注明即可
6. 端口：`ss -ltnp | grep -E ':(80|443|8484)\b'`（8484 只能是 127.0.0.1）

不要为了验证创建一个真实的 run（会产生 token 花费）。最多发只读请求。

## 第五步：交付（只给文件，不给明文）

写文件到 `~/.hermes/handoff/<profile>-<YYYYmmdd-HHMM>.txt`，权限 600，内容严格按下面格式：

# hermes-handoff v2
# 本文件含明文管理密钥，导入后请删除；需要重新生成时重跑本 Prompt。
PROFILE=
GATEWAY_URL=          # 网关地址，形如 https://hub.<域名>（不要带 /v1、不要带结尾斜杠）
ADMIN_KEY=            # 第三步那把 PI_HUB_ADMIN_KEY 的原值
DASHBOARD_URL=        # 形如 https://dash.<域名>
DASHBOARD_USER=
DASHBOARD_PASSWORD=
AUTH_MODE=            # basic | form | none
HERMES_VERSION=
SERVER_HOST=
GENERATED_AT=
# ---- 校验结果 ----
DNS_OK=               # true | false
GATEWAY_HTTP=         # 第四步第 3 条的 HTTP 状态码
UPSTREAM_OK=          # 取自 hub/health 的 upstreamOk
ADMIN_KEY_CONFIGURED= # 取自 hub/health 的 adminKeyConfigured
DASHBOARD_HTTP=       # 第四步第 5 条的状态码
TLS_NOT_AFTER=        # 证书到期时间（openssl 原始值）

写入后回读验证，并记录 `ls -l` 与 `sha256sum` 的输出。

格式版本是 **v2**：桌面端只认 `GATEWAY_URL`（唯一的门）与 `ADMIN_KEY`（登记用）。
`API_KEY` / `DASHBOARD_SESSION_TOKEN` 已不再需要——**不要**在文件里补这两行。
（旧版 v1 / v1.1 文件应用仍能导入，但里面没有管理密钥，用户得自己再填一次。）

交付方式：

- 通道支持发送文件/附件：直接把该文件发给用户。
- 通道不支持：在对话里给出用户在自己电脑上执行的命令（占位符保留，不要带密钥），例如
  `scp -i <你的私钥> ubuntu@<服务器地址>:~/.hermes/handoff/<文件名> .`
- 两种情况都要在对话里给出：文件路径、`ls -l`、`sha256sum`、脱敏预览
  （例如 `GATEWAY_URL=https://hub.<域名>`、`ADMIN_KEY=zsr****m2Rc`、
  `DASHBOARD_USER=<用户名>`、`AUTH_MODE=<basic|form>`）。
- **绝对不要**在对话里出现 `ADMIN_KEY=` 或 `DASHBOARD_PASSWORD=` 的真实值。

## 第六步：收尾报告（简短）

1. 一句话结论：可用 / 有阻塞。
2. 本次属于哪种形态（A / B / C），做了哪些改动，备份在哪。
3. 过程中提出的所有问题（没有就说"无"）。
4. 任何一项验证失败时，说明卡在哪一层（DNS / 证书 / 反代 / 插件 / 网关 / 上游 / 控制台），
   不要凭猜测给结论。
5. 给用户三行操作提示：
   - 把文件导入 Pi Workbench 的「连接」页（支持从文件导入），然后在「云端网关」卡点「登记这台设备」
   - 导入后请删除该文件
   - 管理密钥要作废时**重跑本 Prompt 并说明「请轮换管理密钥」**——
     轮换会让所有已登记设备立刻失效，设备需要重新登记

## 边界

- 本次任务会读取并生成服务器上的密钥，这是用户明确要求的。
- 如果用户说"只是自己用、别重置控制台口令"，以用户的要求为准。
- 只能用域名 + 反向代理 + HTTPS 这一种形态；不提供 IP 直连、自签证书、明文 HTTP 的替代方案。
- 任何一步失败都不要往下猜，报告并停止。
```
