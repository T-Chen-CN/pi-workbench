# ADR-006 云端 Agent 控制面改用 Hermes API Server + 自有域名反代（修订 ADR-005）

> **面向**：实现云端板块、写 `electron/cloud/` 客户端、准备云上部署的人
> **什么时候读**：读 [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md) 之前、动 `electron/cloud/` 之前
> **什么时候要改**：不修改正文；控制面传输、暴露方式或配置面归属再次变化时写新 ADR

- **状态**: 已采纳（2026-11-03）
- **影响范围**: `electron/cloud/`（新增 HTTP 客户端，取消 ssh 隧道与子进程托管）、`electron/ipc/cloud-agent.ts`、`src/store/cloudStore.ts`、`src/store/cloudApprovalStore.ts`、云端板块顶层视图、Hermes profile 的 `config.yaml` / `.env`、云 VPS 的反代与 systemd 单元
- **修订**: [ADR-005](ADR-005-cloud-agent-control-plane.md) 的**控制面传输**（gateway WS + SSH 隧道 → api_server REST+SSE + 域名反代）、**配置面归属**（自研表单 → 内嵌 dashboard）、**自研范围**（8 → 4 核心）
- **⚠ 部分修订**: **探针数量**（5 → 4）与 **`usage`/预算归属**（接现成 usage → 首期不做）已由 [ADR-007](ADR-007-cloud-agent-full-host-access.md) 修订；控制面与配置面结论继续有效
- **相关文档**: [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md)、[ADR-004](ADR-004-cloud-agent-backend.md)、[ADR-005](ADR-005-cloud-agent-control-plane.md)、[AGENT_TRACE](../architecture/AGENT_TRACE.md)、[ipc-and-trust](../agent/ipc-and-trust.md)

## 背景

ADR-005 采纳「gateway 认证 WS 为主通道、经 SSH 隧道连接、ACP 为备通道、自研 8 条」。按官方文档逐条核对后，发现四处偏差，其中两处会直接改变本地实现：

| 待解决的问题 | 核查结论（官方文档） |
| --- | --- |
| 控制面到底是谁 | 「执行器/界面的远程后端」是 **`hermes dashboard`**；**gateway 不是 desktop 连的东西**。ADR-005 把 dashboard 的 WS 能力记在了 gateway 名下 |
| 有没有更适合程序对接的面 | 有：**api_server**（`hermes gateway` 挂载的一个 platform，`127.0.0.1:8642`，Bearer）。自带 `/v1/runs` + SSE 事件流、**审批端点** `/v1/runs/{id}/approval`、`pending_controls`、`Idempotency-Key`、`usage`（含 cache 读写）、`/api/sessions`、`/api/jobs`、`/v1/capabilities` |
| 配置管理要不要自研 | 不必：dashboard 已有 `GET/PUT /api/config` + `/api/config/schema`（schema 自带类型/描述/选项），以及 API Keys、Skills、MCP、Logs、Analytics、备份、doctor。重写等于重做 150+ 字段 |
| SSH 隧道作为产品通道是否合适 | 不合适：加密强度不是问题，**授权粒度**才是——一把 key = 整机 shell，且 `-L` 能打到所有 loopback 端口；撤销影响全部通道；隧道内无 per-request 审计；长连接还依赖本机代理 |

另有一条**实测网络前提**（决定部署方式，不影响选型）：该 VPS 入站对海外可达（12/12 海外节点可连 `:22`，故 ACME 校验可过），但**本地运营商直连被黑洞**（22/80/443 全超时，tracert 死在中国移动骨干）——本地访问必须经代理。证书因此优先 DNS-01。

## 决策

**一、控制面主通道 = api_server（Bearer REST + SSE）。**

| 事项 | 决定 |
| --- | --- |
| 对话 / 会话 / 任务 / 审批 / 用量 | `api_server`（`127.0.0.1:8642`，`Authorization: Bearer $API_SERVER_KEY`） |
| 发起一轮 | `POST /v1/runs`（可选 `Idempotency-Key`）+ `GET /v1/runs/{id}/events`（SSE） |
| 审批 | `GET /v1/runs/{id}` 的 `pending_controls` → `POST /v1/runs/{id}/approval`（必须带 `request_id` + `execution_generation`） |
| 停止 / 澄清 / 未知收尾 | `/stop`、`/clarify`、`/resolve-unknown` |
| **不用** OpenAI 兼容端 | `/v1/chat/completions` 只有 `hermes.tool.progress`（无结果）且**没有审批应答路径** |
| ACP | 降为**迁移路径**，不作主备通道（它是 gateway daemon 的 viewer，且要 spawn 子进程） |

**二、传输 = 自有域名 + TLS 反代；SSH 只做运维。**

| 事项 | 决定 |
| --- | --- |
| 域名 | 腾讯云域名 / DNSPod，两个子域：`api.…` → `:8642`，`dash.…` → `:9119` |
| 证书 | ACME **DNS-01**（DNSPod API token）为主，HTTP-01 备选（LE 校验节点在海外，可达） |
| 反代 | Caddy（或 nginx）：SSE 关闭缓冲（`flush_interval -1` / `proxy_buffering off`）、WS 放长读超时 |
| dashboard | 必须 `dashboard.public_url`（精确主机名）；**非 loopback 的 public_url 会强制开启认证门**，无 provider 则启动 fail-closed；`trusted_proxies` 按需 |
| SSH | 保留为运维入口（唯一能进机器的方式），**不作产品传输层** |
| 安全组 | 只开 443（+ 可选 80 作 ACME 备选）；22 仅限自己的出口 IP |

**三、配置面不自研：内嵌 dashboard（BrowserView）。**

只对 2–3 项做自研增强（`approvals.deny` 的版本化 + diff + 回滚，对应 S-11）。理由：配置是低频动作，但覆盖面（config / .env / skills hub / MCP 目录 / logs / analytics / 备份）巨大，重写必然落后于上游。

**四、会话 surface 隔离作为铁律。**

api_server 不能绑 CLI/TUI/Desktop/ACP/IM 拥有的会话（`409 permission_denied`），反向亦然（dashboard 能看、不能接着聊）。因此 **Pi Workbench 是唯一对话入口**，dashboard 只当配置台与只读观察窗。

## 备选方案

- **v3 方案（gateway WS + SSH 隧道）**：控制面记错了对象（WS 在 dashboard 上）；隧道授权粒度过粗、不可审计、依赖本机代理。**否决**，但 SSH 保留为运维通道。
- **只用 dashboard 面（不用 api_server）**：对话事件流会退化到 PTY/ANSI 或非公开契约的 WS，且 Pi Workbench 要实现 sign-in + 一次性 ticket + Host/Origin 匹配，审批只能靠 PTY 文本。**否决**。
- **Cloudflare Tunnel**：本机域名不在 CF（腾讯云），且不愿迁 NS。保留为**备案**（换线路或换区时可切换，反代侧一处改动）。
- **自研配置表单**：重做 150+ 字段 + skills hub + MCP 目录，且上游升级即落后。**否决**。
- **自建 MCP 执行器门**：命令级审批已有端点，门的价值只剩「对外写的幂等/预算」。**后置到 P3**，只有确实要发信/付款时才做。

## 后果

- **本地实现变简单**：不需要 SSH 隧道与重连状态机、不需要 `child-registry` 托管 ACP 子进程、不需要 ticket 登录流程；一个 HTTPS 客户端 + SSE 解析即可。
- **自研范围 8 → 4 核心**：C-E03（幂等）、C-E04 的触发源（usage）、C-B02（活动流水）改为接现成；C-C01 收窄为「策略 + 审批 UI +（可选）对外写门」。
- **工期重估**：12–17 周 → **10–12 周**。
- **新增门禁**：§9.2 的四个探针，其中**探针②（危险命令在 api 会话是 park 还是 BLOCKED）** 是 P0 的硬门槛——它不通过则 S-04 需要重新设计。
- **新增安全条款**：S-12（两个暴露面分开治理；Basic 认证不裸奔公网）、S-13（`API_SERVER_KEY` / dashboard 口令可轮换并留痕）。
- **新增验收**：AC-19（反代穿透：SSE 不憋流、WS 不断、Host/Origin 通过）、AC-20（surface 隔离：API 会话在 dashboard 可见但接管被拒且不产生重复会话）。
- **风险登记**：本地运营商到该 IP 的直连被黑洞 → 本地访问依赖代理；缓解手段为换区域 / 换 IP / 加中继；需登记到 [STATUS](../progress/STATUS.md) 的已知限制。
- **两进程常驻**：gateway + dashboard，估 500–800 MB；3.6 GB 机器可行，但需给每轮 agent/TUI 子进程留余量。

## 修订记录

| 日期 | 变化 |
| --- | --- |
| 2026-11-03 | 初次采纳（修订 ADR-005 的控制面传输、配置面归属与自研范围） |
| 2026-11-03 | 探针 5 → 4（删「`usage` 含 cache token」）、删预算熔断；云端前端定为两个独立页面、不复用 `ChatPanel`/`chatStore`（[ADR-007](ADR-007-cloud-agent-full-host-access.md)） |
