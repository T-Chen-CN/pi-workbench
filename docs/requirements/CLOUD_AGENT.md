# 云端 Agent 方案 v5：以 Hermes API Server 为控制面

> **面向**：实现「云端 Agent（常驻、自主、可观察、可审批）」的人
> **什么时候读**：动云端接入、新增云端相关 IPC / 页面、改审批与审计之前
> **什么时候要改**：后端选型、接入口径、自研范围（§3）、部署拓扑（§5）、权限口径（§6）变化时

**状态**：v5 · **日期**：2026-11-03
**相关**：[ADR-004](../decisions/ADR-004-cloud-agent-backend.md)（后端）· [ADR-005](../decisions/ADR-005-cloud-agent-control-plane.md)（控制面 v3）· [ADR-006](../decisions/ADR-006-cloud-agent-api-control-plane.md)（控制面 v4）· [ADR-007](../decisions/ADR-007-cloud-agent-full-host-access.md)（整机权限 / 云端前端独立）· [选型证据](../reports/research-cloud-agent-2026-11-03.md) · [AGENT_RUNTIME](../agent/agent-runtime.md) · [AGENT_TRACE](../architecture/AGENT_TRACE.md)
**决策依据**不在本文：选型对比见 ADR-004，控制面/传输/配置面见 ADR-006，权限与前端形态见 ADR-007。本文只说**要做什么、边界在哪、怎么验**。

**v5 相对 v4**：①**取消受限 OS 用户与 ssh 终端后端**，Hermes 拿整机权限（含 sudo），隔离只做软限制 → 安全边界重心上移到云控制台；②本地做**两个独立页面**（会话页 / 配置页），首页按钮进入，不共用工作区前端；③云端前端**只对齐 parts 类型、不复用组件**（删掉 transcript 解耦这条）；④**删掉预算熔断**（没有消费上限），用量首期不管。

---

## 0. 一句话

**云端跑 Hermes Agent，Pi Workbench 是它的驾驶舱。**本地 Agent（Pi Agent）与云端 Agent（Hermes）**并存、互不替代、互不调用**；云端 Agent **不需要任何本地能力**。

| 面 | 用谁 | 为什么 |
| --- | --- | --- |
| 对话 / 会话 / 任务 / 审批 | **api_server（`:8642`，Bearer）** | 结构化事件 + 审批端点 + 幂等键，全是现成 |
| 配置 / 密钥 / 技能 / MCP / 日志 / 分析 | **dashboard（`:9119`）** | 只有它有配置面；重写等于重做 150+ 字段 |
| 屏幕 / 接管 | 自研（CDP） | 两个面都不提供 headless 浏览器画面 |

三方分工：**Hermes** 负责运行时（模型循环、工具、终端后端、技能、cron、Kanban、记忆、MCP、配置面）；**Pi Workbench** 负责会话页、配置页、审批队列、审计；**审批执行器**用 Hermes 自带的 `/v1/runs/{id}/approval`。

---

## 1. 边界

### 1.1 明确不动的部分

| 现有铁律 | 态度 |
| --- | --- |
| Pi Agent 只在主进程运行 | **不变**（云端 Agent 是外部进程） |
| 会话记录是唯一真相源（ADR-003） | **本地不变**；云端真相源是 Hermes `state.db`，本地不落副本 |
| 便携式目录、启动顺序、退出收尾、多工作区常驻视图 | **完全不变** |
| 文件写删改只允许在受信任工作区 | **完全不变**（云端页面不碰本地 fs） |
| 权限 fail-closed、审批超时即拒 | 沿用：Hermes 侧超时/桥接失败即 deny；本地侧复用 `electron/approval-broker.ts` |
| IPC 四步（`handleIpc` → preload → 类型 → API） | **不变** |

**单用户前提**：不做账号、不做租户隔离、不做团队共享。

**云端前端独立**：云端是两个**独立页面**，不挂在任何工作区里，**不复用** `ChatPanel` / `chatStore` / 工作区壳。样式受 [DESIGN_SYSTEM](../design/DESIGN_SYSTEM.md) 约束（token 一致），组件各自实现。

### 1.2 Hermes 的四个「面」（必须先分清）

Hermes 本体 = 一套 Python 程序 + 数据目录 `~/.hermes`。它不是「一个服务器」，而是同一份数据的几个前门：

| 前门 | 是什么 | 谁拉起 | 端口 | 给谁 |
| --- | --- | --- | --- | --- |
| **api_server** | gateway 里的一个 platform adapter（与 Telegram 同级） | `hermes gateway` | `127.0.0.1:8642` | **程序**（Pi Workbench 会话页） |
| **dashboard** | 独立进程：FastAPI + SPA + PTY 桥 | `hermes dashboard` | `127.0.0.1:9119` | **人**（Pi Workbench 配置页 / 浏览器） |
| gateway 的 IM 平台 | Telegram / Discord / Slack / 邮件… | `hermes gateway` | 无（出站长连） | 手机 |
| **ACP** | 一次性 stdio 子进程，gateway daemon 的 viewer | 编辑器 spawn | 无 | Zed / VS Code |

三条硬事实：

| 事实 | 影响 |
| --- | --- |
| dashboard 才是「desktop 连的那个后端」，gateway 不是 | 配置页走 dashboard，不是 gateway WS |
| api_server 自带 `run_approval` / `Idempotency-Key` / `tool.started\|completed` | C-E03 / C-B02 不用自研 |
| **会话按 surface 隔离**：API 会话不能绑其他 surface 的会话（`409 permission_denied`） | 会话页与 dashboard 不能轮流聊同一会话 |

**两条安全事实（v5 修订）**：容器后端**跳过审批**（`docker`/`modal`/`daytona`/`vercel_sandbox`/`singularity`）→ 与 S-04 互斥，**不用**；`execute_code` 无整脚本审批 → 必须 `agent.disabled_toolsets: [code_execution]`。审批只覆盖 dangerous shell 命令，`write_file`/`patch` **没有审批路径**——整机权限下这是最需要注意的缺口（见 S-04）。

---

## 2. 能力覆盖（50 条 ID，v5 删 1 条）

状态：✅ 现成 · 🟡 需配置 / 只差视图 · 🔧 自研 · ⚠ 待验证 · ❌ 砍掉

| 面 | ✅ 现成 | 🟡 配置 / 视图 | 🔧 自研 | 备注 |
| --- | --- | --- | --- | --- |
| A 运行时 | A01 常驻云端机（fs+browser+terminal，宿主级权限） | A02 状态持久化 · A03 休眠唤醒 · A04 多 Agent 各一屏 | — | A05 用户隔离 ❌ |
| B 观察面 | B02 活动流水 · B04 离开后可恢复 | — | B01 屏幕流 · B03 审计三问 | B02 直接接 `/v1/runs/{id}/events` |
| C 介入面 | C03 打断纠偏 · C04 一键停 | — | C01 动作级审批（收窄） · C02 接管 | 命令级审批已现成 |
| D 治理面 | D01 守卫隔离（软） · D04 读写分离 · D05 自定义规则 | D02 出网白名单 · D03 凭据零暴露 · D06 撤销授权 | — | D05 = `approvals.deny` + `command_allowlist` |
| E 耐久性 | E03 幂等（限定） · E05 无人监督即停 · E06 断线重连补齐 | E01 任务是一等对象 | E07 恢复核对（降级） | E02 检查点 ⚠ · **E04 预算熔断 ❌（v5 删）** |
| F 连接面 | F01 MCP 目录 · F05 自装 MCP | F04 浏览器兜底 | — | F02 token 模型可见性 ⚠ · F03 自有邮箱 ❌ |
| G 认知面 | G01 持久记忆 · G02 记忆管理 | G03 主动性研究（只读） · G04 建议机制 | — | G04 接 `clarify` 端点 |
| H 复用 | H01 Skill · H02 Routine（cron + `/api/jobs`） | — | — | H03 Teach a task ❌ · H04 团队共享 ❌ |
| I 协作 | I01 多 Agent 并行 | I02 Agent 间交棒 | — | |
| J 多端 | J02 外部入口（IM / 邮件） | J01 会话多端 · J03 语音 | — | J01 受 surface 隔离约束 |
| K 本地前端 | **K06 配置页（内嵌 dashboard）** | — | K01 首页入口 + 页面骨架 · K02 会话页 · K03 屏幕面板 · K04 审批队列 · K05 身份 | 云端前端独立，不与工作区共用 |

**计数**：✅ 20 · 🟡 12 · 🔧 5 · ⚠ 2 · ❌ 5 · K 6 = 50（ID 空间不变；原 🟡 的 C-E04 预算熔断移入 ❌，有效条目 45）。

**需要一句话解释的 5 条**：

| 编号 | 说明 |
| --- | --- |
| C-C01 | 收窄为三件事：**策略层**（`approvals.deny` / `mode: manual` / `command_allowlist` 做成可编辑、可版本化对象）+ **UI 层**（跨任务聚合队列，三级分类：不可逆 / 跨边界 / 对外副作用）+（P3 可选）**对外写门** |
| C-E03 | `Idempotency-Key` 只覆盖 **API 提交面**（持久 admission、跨重启 replay、改 payload 同 key → 409）；Hermes 原生工具与对外写不承诺 |
| C-E07 | 不承诺自动核对真实世界；恢复后列出「未结算的对外写」**逐条人工确认**，数据来自我们自己的 write-ahead 账本 |
| C-J01 | 同一 surface 内多 viewer 可以；跨 surface 只能靠 gateway WS 的 `prompt.submit` |
| C-K01 | 首页（不属于任何 `workspaceDir`）常驻入口按钮 → 会话页 / 配置页；两页各自 `hidden + inert` 常驻，靠按钮切换，不卸载、不 reset |

---

## 3. 自研范围（4 条核心）

### 3.1 核心 4 件

| 编号 | 做什么 | 为什么不能靠 Hermes |
| --- | --- | --- |
| **C-K01–K05** | 云端前端本体：首页入口、会话页、屏幕面板、审批队列、身份 | Hermes 没有「跟本地工作区同窗」的形态；这部分是纯本地资产 |
| **C-C01** | 见 §2 表：策略层 + 审批 UI（+ P3 可选对外写门） | 命令级审批有端点，但**策略要版本化**；`write_file`/`patch` 无审批路径 |
| **C-B01 / C-C02** | 屏幕流 + 接管：自建 CDP（`Page.startScreencast`、`Input.dispatch*`） | 云端 headless 没有桌面；两个 HTTP 面都不提供画面 |
| **C-B03** | 审计三问：谁批的 / 依据哪条规则 / 真实结果 | Hermes 有日志与 `state.db`，没有归因视图 |

审批三层落地：

```
不可逆 / 对外写  ──▶  Hermes 审批端点（pending_controls → /approval）
                       └─ 缺幂等时才自建 MCP 执行器门（P3 可选）

dangerous shell  ──▶  Hermes approvals（mode: manual + deny 下限 + allowlist）
                       └─ 渲染成同一条审批队列里的卡片

文件写入         ──▶  ❌ 无审批路径：只能靠 write safe root + 保护路径 denylist
                       （整机权限下这是最大的缺口，S-04 记录并接受）
```

### 3.2 降级 / 内嵌（原自研）

| 编号 | 曾经 | 现在 |
| --- | --- | --- |
| C-E03 幂等 | 自研 | 接现成 `Idempotency-Key` |
| C-B02 活动流水 | 自研聚合 | 接现成 `/v1/runs/{id}/events` |
| C-E01 / C-G04 | 视图 | 视图（不变） |
| C-K06 配置页 | 自研表单 | **内嵌 dashboard**（BrowserView）；只对 `approvals.deny` 等 2–3 项做增强（S-11） |
| C-E04 预算熔断 | 客户端闸 | **删除**（v5：没有消费上限；`usage` 首期也不展示） |

### 3.3 本地侧必须先做的改造

**顶层入口**：`PanelId` 是固定 union（`files | git | chat | terminal`），`panelStore` 按 `workspaceDir` 索引。云端**不是再加一个 panel**，而是与工作区并列的**独立页面**：

- 首页有常驻入口按钮（首页不属于任何 `workspaceDir`，状态归属要么放独立 store，要么归 `cloudStore`）；
- 会话页与配置页彼此独立，靠按钮切换；切走只 `hidden + inert`，不卸载、不 reset（与多工作区同规则）；
- 拆窗（`auxWindow`）后置到 P4，但入口形态一开始就定。

**前端隔离**：云端不复用 `ChatPanel`（1108 行）/ `chatStore`，`cloudStore` 与 `chatStore` 互不 import。parts **只对齐类型**（`text` / `thinking` / `tool` / `approval` / `clarify`），渲染组件各自实现 —— 这样事件映射表能复用，视觉不必长得一样。

---

## 4. 接口：api_server 为主通道

### 4.1 三条面取舍

| 面 | 给我们什么 | 判定 |
| --- | --- | --- |
| **api_server（`:8642`）** | 对话（`/v1/runs` + SSE）、会话、任务、审批、澄清、幂等、能力自描述 | ✅ **会话页通道** |
| **dashboard（`:9119`）** | 配置（`/api/config` + `/api/config/schema`）、API Keys、Skills、MCP、Logs、Analytics、备份、doctor、PTY | ✅ **配置页通道** |
| **ACP（stdio）** | 事件形状最贴 AGENT_TRACE、`session/request_permission` | 🟡 迁移路径，不作主备通道 |

**不用 OpenAI 兼容端做驾驶舱**（`/v1/chat/completions`、`/v1/responses`）：工具事件只有一个 `hermes.tool.progress`（只有开始没有结果），且**没有审批应答路径**（危险命令只落 `BLOCKED` 文本）。

### 4.2 端点清单

| 用途 | 端点 |
| --- | --- |
| 能力探测 | `GET /v1/capabilities`、`GET /health`、`GET /health/detailed` |
| 发起一轮 | `POST /v1/runs`（body: `input`，可选 `session_id`/`instructions`/`conversation_history`；header: `Idempotency-Key`） |
| 事件流 | `GET /v1/runs/{run_id}/events`（SSE） |
| 状态 | `GET /v1/runs/{run_id}`（`status`、`runtime`、**`pending_controls`**；`usage` 首期不展示） |
| 停止 | `POST /v1/runs/{run_id}/stop`（`stopping → cancelled`） |
| **审批** | `POST /v1/runs/{run_id}/approval`（body: `request_id`=prompt_id、`execution_generation`、`choice`） |
| 澄清 | `POST /v1/runs/{run_id}/clarify`（同上 + `answer`） |
| 未知状态收尾 | `POST /v1/runs/{run_id}/resolve-unknown`（`admission_id`、`execution_generation`） |
| 会话 | `GET/POST /api/sessions`、`GET/PATCH/DELETE /api/sessions/{id}`、`GET …/messages`、`POST …/fork`、`POST …/chat[/stream]` |
| 定时任务 | `/api/jobs` CRUD + `pause`/`resume`/`run` |
| 能力枚举 | `GET /v1/skills`、`GET /v1/toolsets`、`GET /api/model/options` |

### 4.3 事件模型（SSE → parts）

| SSE 事件 | 映射到 |
| --- | --- |
| `message.delta` | `text` part（增量） |
| `message.interim`（`already_streamed`） | `thinking` / 进度 part（去重靠 `already_streamed`） |
| `tool.started`（`tool`、`preview`） | `tool` part 开始（`argsSummary`） |
| `tool.completed`（`duration`、`error`、`preview`） | `tool` part 结束（`resultPreview` 已脱敏、截断 500 字符） |
| `tool.failed` | `tool` part 失败 |
| `subagent.start` / `subagent.complete` | `tool` part 的子节点（委派） |
| `run.completed` / `failed` / `cancelled` / `interrupted` | turn 终态（未闭合的 tool 一律标 `failed`） |
| `approval.request` + `pending_controls` | **`approval` part** |
| `clarify.request` | **`clarify` part**（问信息 ≠ 给权限） |

三条限制：

- **审批身份强绑定**：回执必须带 `request_id`（= `prompt_id`）+ `execution_generation`；陈旧 generation / 别人的 prompt / 已结算的 run 一律 409。**不做「批量批」**。
- **终止态是唯一真相**：`run.completed` 只代表 run 结束；`message.interim` 不等于成功。
- **SSE 有 keepalive**：无事件 10 秒发 `: keepalive`；自建反代必须 `proxy_buffering off`，否则流被憋住。

### 4.4 会话边界

| | 本地 Agent | 云端 Agent |
| --- | --- | --- |
| 真相源 | 本地 `sessions/*.jsonl` + `parentId`（ADR-003，不变） | Hermes `state.db` |
| 本地留存 | 全量 | 只有**可丢弃的 UI 缓存** |
| 跨 surface | — | **禁止**：API 会话不能绑 CLI/TUI/Desktop/ACP/IM 的会话（`409`）；dashboard 能**看**，不能**接着聊** |
| 断线恢复 | — | ①SSE 重连 + `GET /v1/runs/{id}` 轮询对齐 ②拉 `/api/sessions/{id}/messages` ③本地缓存在时间线上插一条**显式断线占位** |
| 禁止 | — | 绝不写成本地 JSONL；绝不把本地 `parentId` 分支语义带进云端；**不自造事件游标** |

**产品含义**：Pi Workbench 会话页是**唯一对话入口**；配置页只当配置台与只读观察窗。

---

## 5. 部署（域名 + TLS 反代，无 SSH 隧道）

### 5.1 拓扑

```
腾讯云 VPS（2 vCPU / 3.6 GB / 59 GB）— Hermes 以宿主级权限运行（含 sudo）
├── systemd  hermes-gateway      127.0.0.1:8642   ← platform 只开 api_server
├── systemd  hermes-dashboard    127.0.0.1:9119   ← public_url + 认证门
├── systemd  caddy               0.0.0.0:443      ← TLS 终结 + 双 hostname
└── sshd :22                                      ← 运维专用，不作产品通道

api.example.com   → 127.0.0.1:8642   Bearer（≥32B）
dash.example.com  → 127.0.0.1:9119   dashboard 认证

本机 Pi Workbench
├── 主进程：https://api.example.com   Bearer（safeStorage）
└── 配置页 BrowserView：https://dash.example.com   （登录一次，cookie 持久）

云控制台（主机外的唯一硬边界）：安全组只开 443 / 快照与自动备份 / provider 额度告警
```

### 5.2 两条域名的配置差异（必须配对，否则起不来）

| | `api.` → `:8642` | `dash.` → `:9119` |
| --- | --- | --- |
| 反代 | 普通 HTTP，无 Host 校验 | **必须** `dashboard.public_url: "https://dash.example.com"`（精确主机名，禁通配） |
| 认证 | `API_SERVER_ENABLED=true` + `API_SERVER_KEY`（≥32 字节） | **非 loopback 的 `public_url` 会强制开认证门**；无 provider 则启动即 fail-closed |
| 额外 | `API_SERVER_CORS_ORIGINS` 仅浏览器直连需要（Electron 主进程不需要） | `dashboard.trusted_proxies`（TLS 终结者不在 loopback 时填其 IP/CIDR；拒绝 `*`、`0.0.0.0/0`） |
| 顺序 | 无要求 | **先写 `.env` 认证 → 再写 `public_url` → 最后启服务**（顺序错拒绝启动） |

**用两个子域而不是同域不同路径**：dashboard 只认 `public_url` 里那个精确主机名（挡 `dash.example.com.evil.test`）；路径前缀会给 cookie（`Path=/`）与 WS `Origin` 增加变量。

### 5.3 网络前提（实测）

| 实测 | 结果 | 推论 |
| --- | --- | --- |
| 海外 12 个节点测 `:22` | **12/12 可连** | 入站对海外可达 → LE 的 HTTP-01 / TLS-ALPN-01 能过 |
| 本地运营商直连该 IP（22/80/443/3389） | 全超时；tracert 死在国内骨干 | **本地访问必须经代理**（或换区域 / 换 IP / 加中继） |
| 经代理访问 | 正常 | 开发期可用；**不能假定「忘了开代理」也能用** |

**证书策略**：优先 **DNS-01**（DNSPod API token）——不依赖 80/443 入站、续期稳；HTTP-01 作备选。

### 5.4 反代的 4 个技术暗礁

1. **WS 空闲被掐**：dashboard 的 `/api/pty` 每 20 秒发 resize keepalive；自建反代放长 `proxy_read_timeout`（≥ 300s）。
2. **SSE 被缓冲**：必须 `proxy_buffering off` + `X-Accel-Buffering: no`。
3. **Host / Origin**：dashboard 只认 `public_url` 的精确主机名；两个子域各配各的。
4. **Cookie 的 `Secure`**：靠 `X-Forwarded-Proto: https` 判定；该头只接受 loopback 或 `trusted_proxies` 中的对端（Caddy 在本机时天然满足）。

**为什么不用 SSH 隧道**：一把 key = 整机 shell、撤不干净、隧道内无 per-request 审计、依赖本机代理且断线要自己写状态机。SSH 保留为唯一运维入口，不作产品传输层（论证见 ADR-006）。

---

## 6. 安全边界

**威胁模型（v5 修订）**：单用户 + Hermes 有整机权限，所以**不再防「agent 提权」**，只防三件事：**防误操作**（危险动作要人点一下）、**防外泄**（密钥别进日志/上下文/公网）、**防公网扫描打进控制面**。凡是需要「绝对挡住 agent」的，只能放在**主机之外**（S-14）。

| 编号 | 边界 | 落地 |
| --- | --- | --- |
| S-01 | 云端 Agent 在独立 VPS 内，本地只走协议 | 控制面 = 两个 loopback 服务 + TLS 反代 + 身份门；安全组零入站（除 443）；SSH 不作产品通道。**主机内不做用户隔离**（v5） |
| S-02 | 云端 Agent **零本地能力** | Pi Workbench 不实现 ACP，不通告 `fs/*`、`terminal/*` |
| S-03 | 凭据不进模型上下文、不进本地日志 | Bearer / dashboard 会话存 safeStorage、渲染层永不持凭据；**云端 `.env` 对 agent 可读是已知且接受的**（同用户，v5）→ 靠输出 redactor + provider key 可轮换降爆炸半径 |
| S-04 | 不可逆操作必须人工批准 | ①容器后端整层关审批 → **不用**；②`write_file`/`patch` 无审批路径（整机权限下最危险，接受）；③`execute_code` 必须禁用；④回执必须带 `request_id` + `execution_generation`，不做批量批 |
| S-05 | 审批 fail-closed | 超时 / 通道缺失即 deny，同一轮不自动重试 |
| ~~S-07~~ | ~~预算到线即停~~ | **已删（v5）**：没有消费上限，不做预算熔断 |
| S-08 | 控制台不得成为提权通道 | 控制台的「直接操作」也走同一审计流；**不提供 `allow_always`**（会写永久白名单） |
| S-09 | 关键配置变更要被发现 | 钉 `config.yaml` / `SOUL.md` / `approvals` 的哈希，变更即告警 + **一键还原到版本化副本**。强度是「事后发现」，不是「事前拦截」（v5 下调） |
| S-10 | 遥测默认关闭 | 不装遥测插件；复核第三方 MCP 出网 |
| S-11 | 审批策略要版本化 | `approvals.deny` 与允许清单落盘 `cloud/hermes-profile/`，有 diff 与回滚。**agent 与 daemon 同用户，能自己改**（v5 承认）→ 靠 S-09 告警 + 定时核对还原 |
| S-12 | 两个暴露面分开治理 | `api.` = Bearer（≥32B）+ 反代限速；`dash.` = 认证门 + 建议 IP 白名单（Basic 官方明确不适合裸奔公网，需配 OAuth 或前置身份代理） |
| S-13 | 密钥轮换 | `API_SERVER_KEY` 与 dashboard 密码支持热换（改 `.env` → 重启对应服务）；轮换记录进审计 |
| **S-14** | **硬边界只能在主机外** | 腾讯云**安全组**（唯一入站白名单）；**云快照 + 自动备份**（搞坏了能回滚）；**provider 侧额度告警**（删掉预算熔断后唯一的花钱防线）。这三样 agent 触达不到 |
| **S-15** | **deny 清单要覆盖「系统级」而非只覆盖「破坏性」** | `approvals.deny` 必须包含 `*sudo*`、`*systemctl*`、`*crontab*`、`*authorized_keys*`、`*iptables*`、`*ufw*`、`*useradd*`、`*chmod*777*` 等；它们都是 shell 命令，fnmatch 能拦 |

S-06（单用户）已删除。

---

## 7. 最小化配置（可执行清单）

### 7.1 安装与 profile

```bash
# 前置：git / curl / tar / sha256sum；缺 libatomic1 时装上（PM 的 Node 需要）
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/h.sh
bash /tmp/h.sh --skip-browser --skip-computer-use --non-interactive
source ~/.bashrc && hermes doctor

hermes profile create pi-cloud --no-skills     # 同时得到 pi-cloud 命令别名
```

> 落点：程序 `~/.hermes/hermes-agent/`、启动器 `~/.local/bin/hermes`、数据 `~/.hermes/`。`--skip-*` 会被记住，`hermes update` 不会加回来。

### 7.2 `config.yaml` 最小集（`~/.hermes/profiles/pi-cloud/config.yaml`）

```yaml
approvals:
  mode: manual               # 不用 smart：判定不可复现、进不了审计
  timeout: 120
  cron_mode: deny
  single_query_mode: deny
  unattended_mode: deny
  deny:                      # 在 yolo 与 mode off 之前生效；整机权限下要覆盖系统级（S-15）
    - "*git push --force*"
    - "*rm -rf*"
    - "*curl*|*sh*"
    - "dd if=* of=/dev/*"
    - "*sudo*"
    - "*systemctl*"
    - "*crontab*"
    - "*authorized_keys*"
    - "*iptables*"
    - "*ufw*"
    - "*useradd*"
agent:
  disabled_toolsets: [code_execution]
platform_toolsets:
  api_server: [file, web, skills, terminal]   # v5：放开终端（要能接管整机）；审批靠 approvals
terminal:
  backend: local              # v5：不用 ssh 后端，不用容器后端（容器会关掉审批）
skills:
  write_approval: true        # 技能自改要过审批（建议开）
dashboard:
  public_url: "https://dash.example.com"
  trusted_proxies: []         # 反代在本机 loopback 时可留空
```

### 7.3 `.env`（`~/.hermes/profiles/pi-cloud/.env`）

```bash
OPENROUTER_API_KEY=...        # 模型 provider，任选一个（要可轮换）
API_SERVER_ENABLED=true
API_SERVER_KEY=<openssl rand -base64 48>
# dashboard 公网必配，否则 fail-closed
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<强口令>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<openssl rand -base64 32>
```

> 该文件对 agent **可读**（同用户）→ S-03 已接受此风险；只靠「provider key 能轮换 + 输出 redactor」降爆炸半径。权限仍建议 `chmod 600`。

### 7.4 整机权限（v5 取代受限用户）

Hermes 与 daemon 同一用户运行，需要时给无密码 sudo（写入 `/etc/sudoers.d/pi-agent` 并在审计里记一笔）。**不要**再建 `piagent` 之类的隔离用户：

- 好处：agent 真能接管服务器（装包、改服务、查日志），不需要为每个动作开洞。
- 代价：它能改自己的 `approvals.deny` 与 `.env`（`write_file` 无审批路径）——这条已写进 S-03 / S-11 的「已知弱点」，靠 S-09 告警 + 还原、S-14 云侧兜底。

### 7.5 两个 systemd 单元

```ini
# /etc/systemd/system/hermes-gateway.service
[Service]
User=ubuntu
EnvironmentFile=/home/ubuntu/.hermes/profiles/pi-cloud/.env
ExecStart=/home/ubuntu/.local/bin/pi-cloud gateway
Restart=always
RestartSec=5

# /etc/systemd/system/hermes-dashboard.service
[Service]
User=ubuntu
EnvironmentFile=/home/ubuntu/.hermes/profiles/pi-cloud/.env
ExecStart=/home/ubuntu/.local/bin/pi-cloud dashboard --host 127.0.0.1 --port 9119 --no-open
Restart=always
RestartSec=10
RestartPreventExitStatus=78     # 该主机已被别的后端占用时不要空转重启
```

### 7.6 反代（Caddy 示例）

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:8642 {
        flush_interval -1          # SSE 不缓冲
    }
}
dash.example.com {
    reverse_proxy 127.0.0.1:9119 {
        transport http { read_timeout 300s }   # WS 长连接
    }
}
```

证书：`tls { dns dnspod {env.DNSPOD_API_TOKEN} }`（DNS-01，不依赖 80 入站）。

### 7.7 云控制台兜底（S-14，必做）

| 项 | 配置 |
| --- | --- |
| 安全组 | 入站只开 443（源 0.0.0.0/0）；SSH 22 改为只允许固定运维 IP（平时关闭） |
| 快照 | 开自动快照（日）+ 动手前手动快照；恢复演练一次 |
| provider 额度 | 在 provider 侧设消费告警（删了预算熔断后这是唯一的花钱防线） |

---

## 8. 验收场景

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| AC-01 | 冷启动接通 | 首页 → 点「云端 Hermes」→ **会话页** 3 秒内列出会话（`/api/sessions`） |
| AC-02 | 发一条指令 | `POST /v1/runs` → SSE 流式文本 + 工具卡；停止按钮命中 `/stop` |
| AC-03 | 审批（命令级） | 危险命令 → 本地弹卡片 → **拒绝** → run 继续但不重试 → 审计有记录 |
| AC-04 | 审批超时 | 不响应 → 自动 deny，agent 收到拒绝并停下，审计有记录 |
| AC-05 | 屏幕 | 能持续看到云端**浏览器**画面（CDP screencast），≤ 2 秒延迟（P3） |
| AC-06 | 恢复与状态一致 | 断线/重启控制台后重连 → 用 `GET /v1/runs/{id}` 对齐状态 → 与 Hermes 一致 |
| AC-07 | 断线补齐 | 拔网 1 分钟 → 恢复后 ①无重复渲染 ②时间线有一条显式断线占位 ③进行中的 run 能 attach 回去 |
| AC-08 | **两页切换**（原预算熔断，v5 改用途） | 会话页 ↔ 配置页 经按钮切换：切走只 `hidden + inert`，**不卸载**；会话页带滚动位置与未发送草稿回来；配置页 cookie 不丢 |
| AC-09 | 幂等 | 同一 `Idempotency-Key` 重发 → 外部只执行一次；改 payload 同 key → 409 |
| AC-10 | 恢复核对 | 恢复后列出未结算的对外写并逐条确认（P2） |
| AC-11 | 零本地能力 | 云端 agent 无法读写本地任何路径（不实现 ACP，天然满足） |
| AC-12 | 页面隔离 | 与现有工作区互不影响：切走只 `hidden` + `inert`，不卸载；云端页面不出现文件树/编辑器/终端/Diff |
| AC-13 | 拆分窗口 | 云端页面可单独拆窗（阶段 H） |
| AC-14 | 升级路径 | `hermes update` 后 SOUL / skills 保留、记忆不丢、`approvals` 不被静默重置 |
| AC-15 | 遥测 | 无遥测插件；抓包确认除 LLM provider 与已登记 MCP 外无外发 |
| AC-16 | 审批不被后端关掉 | 当前配置下危险命令**必须**弹审批；`terminal.backend` 被改成容器类则主动告警 |
| AC-17 | `execute_code` 已禁用 | 让 agent 用 `execute_code` 做文件操作 → toolset 层拒绕 |
| AC-18 | 审批策略可回滚 | 改 `approvals.deny` → 有 diff、有审计、可一键回滚 |
| AC-19 | 反代穿透 | 经域名走完一轮：SSE 首字延迟 < 1s 且不「懋流」；`/api/pty` 空闲 5 分钟不断；`Host`/`Origin` 校验通过 |
| AC-20 | surface 隔离 | api_server 建的会话在 dashboard Sessions 页可见，但 Chat 接管被拒（`409`），且不产生重复会话 |
| **AC-21** | **软限制被破坏可发现**（v5） | 手工改 `config.yaml` 的 `approvals`（模似 agent 自行解锁）→ 控制台告警 + 一键还原成功；审计里有记录 |
| **AC-22** | **整机权限可用**（v5） | 让 agent 完成一次需要系统权限的活（如 `systemctl restart` 先被审批拦一下再放行）→ 既有审批记录也真执行成功 |

---

## 9. 环境、闸门与工程序

### 9.1 D0：最小可测实例（半天）

按 §7（1–7.7）顺序做完，确认只监听 loopback、两个 hostname 通、安全组与快照已就位、**不装浏览器**（`--skip-browser` 已生效）。

### 9.2 D1–D2：四个 go/no-go 探针（1 天）

| # | 探针 | 结论（2026-11-05/06 实测，Hermes 0.22.6） |
| --- | --- | --- |
| ① | `GET /v1/capabilities` 有 `run_approval` / `session_*` | ✅ 通过：`/v1/capabilities` 200 且带审批与 `session_*` 端点 |
| ② | 危险命令是 **park**（`pending_controls` 有值）还是直接 `BLOCKED` | ✅ **park**：`approval.request`（`prompt_id` / `execution_generation` / `command` / `description` / `choices`）+ `GET /v1/runs/{id}` 的 `status: waiting_for_approval`，答复后工具才执行 |
| ③ | `GET /api/config/schema` + `PUT /api/config` 回读 + **下个 session 是否生效** | ✅ 通过：`PUT {"config":{...}}` 走 `_deep_merge`（可只发一个键），读回一致，且 `disabled_toolsets` **立即生效**（无需重启 gateway） |
| ④ | 双进程并存：profile 归属、端口、dashboard 能否重启 gateway | ✅ 通过：api_server `:8642` 与 dashboard `:9119` 并存；两域名反代各自可用（`dash.` 走 HTML/配置面，`api.` 走 Bearer REST/SSE） |

> v4 的「`usage` 含 cache token」探针已删（不做预算熔断）。探针是一次性脚本，不入库；原始帧与回执语义见 [CLOUD_AGENT_APPROVAL](./CLOUD_AGENT_APPROVAL.md)。

### 9.3 分期（9–11 周）

| 期 | 目标 | 交付判据 | 工期 |
| --- | --- | --- | --- |
| **P0 接通** ✅ | D0–D2 → 首页入口 + 两个页面骨架 → 传输（Bearer + runs）→ 事件映射 | AC-01 / AC-02 / AC-08 / AC-19 | 2 周 |
| **P1 看得见 + 批得动** ✅（策略版本化 / 告警还原除外，见 §13） | 审批 UI（`pending_controls`）/ 审计三问 / 活动流水（接现成）/ 配置页（内嵌 dashboard） | AC-03 / AC-04 / AC-16~18 / AC-20 / AC-21 / AC-22 | 3 周 |
| **P2 敢放着不管** | 断线占位 / run 重新 attach / 未结算清单 / jobs 视图 | AC-06 / AC-07 / AC-09 / AC-10 | 2 周 |
| **P3 补齐缺口** | CDP 屏幕 + 接管 / Kanban 任务视图 / `clarify` 卡片 /（可选）对外写 MCP 门 | AC-05 | 2 周 |
| **P4 收尾** | 一个 IM 渠道（如需）/ 遥测与出网复核 / 拆窗 | AC-13 / AC-15 | 1 周 |

### 9.4 工程序（双轨）

```
云端轨  D0 环境+反代+云兜底 ─▶ D1-2 四探针 ─┬─▶ P1 策略/配置页
                                            └─▶ P3 CDP / IM 渠道
本地轨  A 入口与两页 ─▶ B 传输 ─▶ C 事件流 ─▶ D 审批 ─▶ E 配置页接入 ─▶ F 耐久 ─▶ G 屏幕 ─▶ H 收尾
```

| 阶段 | 做什么 | DoD |
| --- | --- | --- |
| **A 入口与两页** | 首页入口按钮（不属于任何 `workspaceDir`）；`src/components/cloud/{CloudSessionView,CloudConfigView}.tsx`；`src/store/cloudStore.ts`；两页 `hidden + inert` 切换 | 无云端也能开两页（会话页显示「未连接」、配置页显示「未配置」）；`npm test` + `lint` + design-system 绿；**可单独合入 main** |
| **B 传输** | `electron/cloud/{http,client,config}.ts`、`electron/ipc/cloud-agent.ts`（`connect`/`disconnect`/`status`/`sessions:list`/`run:start`/`run:stop`）、preload + `types/electron.d.ts` + `src/api/cloud.ts`（含 Web mock）；连接页从交接文件导入（`handoff v1.1`：`pick → 脱敏预览 → apply`，明文只留主进程） | 能列会话、能发一轮；Bearer 存 safeStorage，渲染层无凭据 |
| **C 事件流** | `electron/cloud/events.ts` → 对齐 parts **类型**（不复用组件）；含 `approval` / `clarify` | AC-01 / AC-02 / AC-19 |
| **D 审批** | `electron/cloud/approval.ts`（复用 `approval-broker.ts` 语义）、`src/store/cloudApprovalStore.ts`、`data/cloud-agent/audit.jsonl`；`cloud/hermes-profile/`（config 版本化 + 哈希告警 + 还原） | AC-03 / AC-04 / AC-16~18 / AC-21 / AC-22 |
| **E 配置页接入** | BrowserView 承载 dashboard（独立页面，非 tab）；凭据与会话隔离 | 能在配置页改配置/密钥/技能，改动可回读 |
| **F 耐久** | run 重新 attach、断线占位、未结算清单、jobs 视图 | AC-06 / AC-07 / AC-09 / AC-10 |
| **G 屏幕** | 帧 IPC + 面板；`Input.*` 接管 | AC-05 |
| **H 收尾** | Kanban 视图、`clarify` 卡片、**此时才动** `PanelId` / `panelStore` 做拆窗 | AC-13 / AC-15 |

**横切（每阶段都做）**：IPC 四步含 Web mock；i18n 中英双语；`design-system.test.ts`；JSON 落盘走 `atomic-json`（审计 JSONL 例外：追加 + fsync）；**不碰** `sessions/*.jsonl` 与 `session-git.json`；同步更新本文与 STATUS。

**提交节奏**：`feat/cloud-agent-{scaffold,transport,trace,approval,config,durability}`，每段一个可独立 review 的 PR。

**先不做（防范围蔓延）**：多 profile / 多 agent 并行（单 agent 闭环跑通后）· 拆窗（阶段 H）· 自建 MCP 执行器（只有确实要发信/付款时）· IM 渠道与语音（P4）· **用量展示与预算熔断（首期不管，以后再说）** · 语义分类器 / 桌面截图 / Xvfb / VNC（**永远不做**）· 重写 dashboard 配置表单（**不做**，只增强 `approvals.deny` 等 2–3 项）。

---

## 10. 待确认

| 编号 | 问题 | 现状 |
| --- | --- | --- |
| Q4 | 凭据是否真不进模型上下文 | ⚠ 待验证（`mcp-tokens/` 的模型可见性；S-03 已接受 `.env` 可读） |
| Q5 | 步骤级检查点 | 🟠 无；run 是会话级 |
| Q6 | 子代理互通 | ⚠ 待验证 |
| Q8 | NemoClaw | 🟡 暂不引入 |
| Q12 | 与官方 Hermes Desktop 的差异化 | 🟠 假设：同窗并列 + 本地/云端并存 + 统一审批与审计；**P0 后复核** |
| ~~Q13~~ | 危险命令在 api 会话里是 park 还是 BLOCKED | **已回答（探针②）**：park —— 挂成待批、答复后才执行 |

已答：Q1 ACP → 不作主通道；Q2 控制面 → api_server REST+SSE；Q3 多 agent → 隔离模型 + `multiplex_profiles`（P3 后）；Q7 容器后端 → 已否决；Q9 屏幕流 → CDP screencast；Q10 F03/H03 → 砍掉；Q11 用量 → v5 首期不做（也不做预算闸）；Q14 证书 → DNSPod + DNS-01，本地访问需代理。

---

## 10.5 实施现状（2026-11-06 收口）

**已交付**（[BACKLOG](../progress/BACKLOG.md) 的 C-00 – C-06，全部在 `main`）：

| 分期 | 交付物 | 对应代码 |
| --- | --- | --- |
| 入口与页面 | 首页「云端 Hermes」入口 + 会话 / 控制台 / 任务 / 连接 四个常驻页签（切走只 `hidden` + `inert`） | `src/components/CloudWorkspaceView.tsx` |
| 控制面 | 连接配置（`safeStorage`）、`/v1/runs` + SSE 事件映射、停止 / 插话 / clarify / 审批四个回执通道 | `electron/cloud/{config,client,events,map,remote,runner}.ts`、`electron/ipc/cloud-agent.ts` |
| 会话与时间线 | 会话 CRUD、历史映射、工具卡 / 子代理卡 / 思考块 / 图片 / 未结算账本抽屉 | `src/components/Cloud{SessionView,Trace,ToolCard,SubagentCard,LedgerDrawer}.tsx` |
| 审批闭环 | 审批卡（once / session / deny）+ 倒计时 + 断流补卡；审计 `data/cloud-agent/audit.jsonl`；原生档位三档切换 | [CLOUD_AGENT_APPROVAL](./CLOUD_AGENT_APPROVAL.md) |
| 配置面 | `WebContentsView` 嵌 dashboard（独立 partition、无 preload）+ 连接页策略卡与自检面板 | `electron/cloud/{dash,dashboard}.ts`、`CloudConnectionView.tsx` |
| 任务与导入 | 定时任务列表 / 三个动作、`hermes-handoff` 文件导入 | `CloudJobsView.tsx`、`electron/cloud/handoff.ts` |

**明确后置**（不是遗漏，是排期决定；C-07 已于 2026-11-06 补齐，见下表首行）：

| 条目 | 内容 | 为什么后置 |
| --- | --- | --- |
| ~~C-07~~ ✅ | 耐久性：run 重新 attach / 断线占位 / 未结算清单补录 | AC-06 / AC-07 / AC-09 / AC-10；**2026-11-06 补齐跨重启 attach**（`electron/cloud/active-run.ts` 记最近一轮，接回时先铺历史再放增量、只订阅新事件） |
| C-08 | CDP 屏幕与接管（AC-05） | 需要云上常驻浏览器，运维面另算 |
| C-09 / C-10 | Kanban 投影、云端页面拆窗 | 依赖 C-08 |
| C-11 | IM 渠道 / 语音 / 出网遥测复核 | 一次性验收动作，不是功能 |
| C-12 | 对外写 MCP 门 + write-ahead 账本 | 账本已能记与人工核对，门是另一个量级 |

**已知盲区**（写进 UI，不假装没有）：纯 `sudo <cmd>` 与 `write_file` / `patch` 没有审批路径（Hermes 只对危险 shell 模式问）；没有消费上限；`approvals.deny` 保持 Hermes 默认空。

---

## 11. 非目标

❌ 自研云端 Agent 运行时 · ❌ fork Hermes · ❌ 把云端会话写进本地 JSONL · ❌ 多租户 / 账号体系 / 团队协作 · ❌ 把本地 Agent 迁移到云上 · ❌ 云端页面里放文件树 / 编辑器 / 终端 / Diff / 工作树切换 · ❌ 云端复用本地 `ChatPanel` / `chatStore`（只对齐 parts 类型） · ❌ 重写 dashboard 配置表单 / 技能广场 / MCP 目录 · ❌ 给 Hermes 原生工具层加幂等 · ❌ 自动核对真实世界状态 · ❌ 用 SSH 隧道作为产品传输层 · ❌ 用容器后端换取「审批 + 隔离」两全 · ❌ **主机内 OS 用户隔离**（v5：改软限制 + 云侧兜底） · ❌ **预算熔断与用量面板**（v5）。

---

## 12. 变更记录

| 版本 | 日期 | 变化 |
| --- | --- | --- |
| **C-07 补齐** | 2026-11-06 | 不回改正文：§10.5 的 C-07 由「明确后置」改为已交付（跨重启 attach：`active-run.json` + `run:attach` + 先铺历史再放增量）。剩余后置项收窄为 C-08 – C-12。 |
| **收口** | 2026-11-06 | 不回改方案正文：新增 §10.5「实施现状」（C-00–C-06 已交付、C-07–C-12 明确后置、三条已知盲区），四个 go/no-go 探针与 Q13 回填实测结论。 |
| **v5** | 2026-11-03 | ①删掉受限 OS 用户 `piagent` 与 `terminal.backend: ssh`，Hermes 改整机权限（含 sudo），`api_server` toolset 放开 `terminal`；隔离降为软限制 → 新增 S-14（硬边界只能在主机外）/ S-15（deny 覆盖系统级）、S-03/S-09/S-11 强度下调；②本地改**两个独立页面**（会话页 / 配置页，首页按钮进入），顶层入口提到 P0；③云端前端**不复用** `ChatPanel`/`chatStore`，只对齐 parts 类型（删掉 transcript 解耦）；④**删掉预算熔断**（C-E04 / S-07 / AC-08）与用量展示，探针 5 → 4，工期 10–12 → **9–11 周**。 |
| v4 | 2026-11-03 | 控制面改 api_server（Bearer REST + SSE）；传输改域名 + TLS 反代（弃 SSH 隧道）；配置面改内嵌 dashboard；自研 8 → 4；surface 隔离升为铁律；补网络前提。同日精简：删选型论证（归 ADR）。 |

v1–v3 的演进过程见 Git 历史与 [ADR-005](../decisions/ADR-005-cloud-agent-control-plane.md) / [ADR-006](../decisions/ADR-006-cloud-agent-api-control-plane.md) / [ADR-007](../decisions/ADR-007-cloud-agent-full-host-access.md)。
