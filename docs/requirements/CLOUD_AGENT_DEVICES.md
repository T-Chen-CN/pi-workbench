# 云端 Agent 多设备身份与反向派活方案 v2（单缝 · Hermes 插件形态）

> **面向**：要实现「多台本地程序连同一个云端 Agent」「云端 Agent 认得是哪台设备」「云端指挥本地 Agent 干活」的人
> **什么时候读**：动对接层（本地 ↔ 云端）、设备身份、反向任务通道、变更 S-02 之前
> **什么时候要改**：插件形态、设备身份口径、派活权限口径、上游插件 API、验收场景变化时
> **状态**：v2 · 2026-11-06 · **未开工** · D0（设备身份 v0）已落地；H3 需先批准 [ADR-008](../decisions/ADR-008-cloud-single-entry-plugin.md)（S-02 改口径）
> **取代**：v1 的 `pi-hub` 独立服务方案（作废，理由见 §4）

---

## 0. 一句话

**本地与云端之间只留一条缝：一个自写的 Hermes 插件。** 插件在 VPS 上、与 gateway 同进程，负责认设备、限权、审计、代转发，并提供三个派活工具；云端仍然**只能发请求**，能力（写文件 / 跑命令 / 用哪个工作区）永远由**本地**按白名单 + 档位上限 + 逐次审批授予。

---

## 1. 三条需求与落点

| # | 需求 | 落点 | 结论 |
| --- | --- | --- | --- |
| D-01 | 多台本地程序连同一个云端 Agent，云端要能识别是哪台设备 | 设备 token → `deviceId`（插件中间件）；`author` 由插件按 token 覆盖；审计逐条带设备 | 插件 + 本地设备卡 |
| D-02 | 同一云端 Agent 只对应同一用户，多设备只是同一人的不同入口 | 不做账号 / 租户 / 团队；一个 profile、一个用户、多台设备 | 不引入多租户 |
| D-03 | 云端 Agent 要能指挥本地 Agent 工作 | 插件三个工具 → 设备任务邮箱 → 本地执行器（审批/上限/白名单）→ 摘要回传 | 需 S-02 改口径（ADR-008） |

---

## 2. 三条定稿决策（2026-11-06，项目所有者确认）

| # | 决策 | 含义 |
| --- | --- | --- |
| **C-1** | **单缝** | 本地 → 云端只有一条路：`https://hub.tchen-xiaoxiao.com` + 设备 token。除 dashboard 外**全部**经插件（轮次、SSE、审批、会话、任务、配置、媒体） |
| **C-2** | **无直连兜底** | 代码里不保留第二套客户端、不做自动回落。应急只有运维动作（改配置），不是运行时特性 |
| **C-3** | **插件形态** | 弃 `pi-hub` 独立服务；改为 Hermes 插件 `pi-workbench`（`kind: platform`，与 gateway 同进程，随其重启） |

**唯一例外**：dashboard（`dash.tchen-xiaoxiao.com`，WebSocket + 静态资源 + 上游自有前端）继续直连，插件不代理。

---

## 3. 目标架构

```
        ┌──────────── VPS ────────────────────────────────────────────┐
Pi Workbench                          Caddy (TLS)
 (本地)  ──https──▶ hub.tchen-xiaoxiao.com ──▶ 127.0.0.1:8484
                                              │
                                    ┌─────────▼───────────┐
                                    │ 插件 pi-workbench    │ ← 与 agent 同进程
                                    │ token 校验 / scope   │
                                    │ 设备目录 / 心跳       │
                                    │ 任务邮箱 / 三个工具   │
                                    │ 审计 JSONL           │
                                    └─────────┬───────────┘
                                              │ loopback HTTP（带 API_SERVER_KEY）
                                    ┌─────────▼───────────┐
                                    │ api_server (Hermes)  │
                                    └─────────────────────┘

dashboard（dash.*）── 直连，不过插件
```

**一条请求的完整路径**：本地带 `Authorization: Bearer pi_…` → 插件按 sha256 查 token → 查 scope → 注入 `X-Pi-Device`、**覆盖** `author` → loopback 转发 → 原样回传（SSE 流式）。上游签名（`API_SERVER_KEY`）永不出现在本地。

---

## 4. 为什么改成插件（以及代价）

### 4.1 Hermes 插件系统刚好给了我们要的座位

| 我们需要 | 插件提供 | 依据 |
| --- | --- | --- |
| 设备入口（认 token、长轮询） | `kind: platform` 插件 + `ctx.register_platform(name, label, adapter_factory, check_fn, ...)`；适配器 `connect()` 里**可以自己起 aiohttp server** | 《Adding a Platform Adapter》的 webhook/callback 示例 |
| 模型侧三个工具 | `provides_tools` + `tools.py: register_tools(ctx)`，**无需单独 MCP server** | 《Build a Hermes Plugin》 |
| 设备目录 / 邮箱 / 审计 | `plugin_data_dir()` + `plugin_db()`（SQLite WAL），`hermes plugins update` 不丢 | 同上「Store durable state」 |
| 权限声明 / 配置 | `plugin.yaml` 的 `capabilities:`（同意屏）、`requires_env` / `optional_env` | 同上 |
| 生命周期 / 校验 | `hermes plugins install/enable/update/remove` + `plugin doctor` | 同上 |
| 先例 | 内置 **`a2a` 插件**：自带 HTTP 入口（Agent Card + JSON-RPC）**同时**提供客户端工具 —— 与本方案同形 | 插件目录 |

**顺带收益**：`platform_toolsets` 那个显式白名单**不用改了**（原来加 MCP server 必须改它）——回到只用文档化接口。

### 4.2 代价（比独立服务多出来的）

| 代价 | 说明 | 缓解 |
| --- | --- | --- |
| 单点放大 | 插件挂 → 云端全挂（无兜底） | 热路径无 DB 写、限流、超时、`/v1/hub/health` 让 UI 分得清"网关挂了"还是"模型挂了" |
| 同进程 | 插件崩会拖累 gateway；阻塞事件循环会卡住 agent | sqlite 全走异步 + WAL 短事务；禁止同步 HTTP；每条路由超时 |
| 权限半径 | token 库与邮箱在 agent 进程内 | 只存 hash、`capabilities:` 同意屏、审计独立 JSONL、邮箱不存明文命令 |
| 上游耦合 | 插件 API 变更会打断我们 | `shim.py` 只做注册与起停（≤120 行）；`core/` 不 import 任何 Hermes 模块；钉版本区间 + `plugin doctor` |

**为什么不选「插件只做派活、其余直连」**：两条缝会让设备身份只覆盖一半，`approvals.mode` 这类安全写操作仍可被任何持全局钥匙者改；「哪台设备做的」永远说不全。

---

## 5. 接口契约

### 5.1 设备管理（管理密钥，只给运维用）

| 方法 / 路径 | 用途 | 认证 | 备注 |
| --- | --- | --- | --- |
| `POST /v1/devices/register` | 登记设备，返回**一次性明文 token** + deviceId | `X-Pi-Admin-Key` | 服务端只存 sha256 + 前 8 位 |
| `GET /v1/devices` | 设备列表（名字 / 在线 / scope / 最后活跃） | `X-Pi-Admin-Key` 或 `admin` scope | |
| `POST /v1/devices/{id}/revoke` | 撤销（立刻 401） | 同上 | 不删行，写 `revoked_at` |
| `GET /v1/hub/health` | 插件自检（版本 / 上游连通 / 设备数 / 队列深度） | 匿名 | UI 用它区分故障源 |

### 5.2 设备侧（`Authorization: Bearer pi_…`）

| 方法 / 路径 | 用途 | scope |
| --- | --- | --- |
| `GET /v1/devices/me` | 自己的身份与 scope | `chat` |
| `POST /v1/devices/me/heartbeat` | 心跳 30s，返回在线设备列表 | `chat` |
| `GET /v1/devices/me/tasks?wait=25` | 长轮询取派活（**原子 claim**） | `dispatch` |
| `POST /v1/devices/me/tasks/{id}/result` | 回传摘要结果 | `dispatch` |

### 5.3 透明代理（dashboard 除外，全量）

| 上游 | 插件处理 |
| --- | --- |
| `/health` · `/v1/capabilities` · `/v1/{toolsets,skills,models}` | 透明 + 30s 内存缓存 |
| `POST /v1/runs` | 覆盖 `author`（以 token 为准）、幂等键加 `pi:<deviceId>:` 前缀、审计 |
| `GET /v1/runs/{id}` · `/events`(SSE) · `/steer` · `/stop` | 流式透传：不缓冲、不压缩、透 `Last-Event-ID`、客户端断开即断上游 |
| `/v1/runs/{id}/approval` · `/clarify` · `/resolve-unknown` | 透传 + 审计「哪台设备批的、依据哪条规则」 |
| `/api/sessions*` · `/api/jobs*` | 透明 |
| `/api/config` GET | 透明（白名单字段由本地再做一次） |
| `/api/config` PUT | **需 `admin` scope** + 审计（会改 `approvals.mode`，是安全写） |
| `/api/chat/image-upload` | 透明（沿用上游大小上限） |
| `/api/fs/read-data-url` | **收紧**：只允许 `HERMES_HOME/uploads`、`cache/images` 下的文件，越界 `403 path_not_allowed` |

**统一错误码**（插件自己产生；上游 4xx/5xx 原样透传）：

| code | HTTP | 本地 UI 文案方向 |
| --- | --- | --- |
| `unauthorized` | 401 | 设备未登记 / token 无效 |
| `device_revoked` | 401 | 这台设备已被注销 |
| `scope_required` | 403 | 当前设备权限不够（缺 chat/dispatch/admin） |
| `rate_limited` | 429 | 请求太频繁，稍后再试（带 `Retry-After`） |
| `upstream_unavailable` | 502 | 网关正常但 Hermes 异常 |
| `path_not_allowed` | 403 | 该路径不在允许范围 |

---

## 6. 数据模型（`plugin_data_dir("pi-workbench")/hub.db`）

```sql
devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL, scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_seen_at INTEGER,
        revoked_at INTEGER, note TEXT)

tasks(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, project_id TEXT NOT NULL,
      prompt TEXT NOT NULL, mode TEXT NOT NULL,          -- readonly | ask
      status TEXT NOT NULL,                              -- queued|claimed|running|done|failed|expired|refused|cancelled
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      claimed_at INTEGER, finished_at INTEGER,
      result_summary TEXT, exit_code INTEGER, error TEXT,
      origin_run_id TEXT, origin_session_id TEXT)

audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
      device_id TEXT, path TEXT, status INTEGER, detail TEXT, ip TEXT)
```

约定：
- **只存 token 的 sha256**；明文只在登记响应里出现一次。
- `prompt` 全文入库（云端本地库），结果只存摘要（≤2k）；摘要之外的内容不出本机。
- 审计另写 `plugin_data_dir/audit-YYYYMM.jsonl`（与 SQLite 解耦，可直接 `tail`）。
- `tasks` 保留 30 天，过期清理由插件启动时做一次。

---

## 7. 插件工程结构

```
pi-workbench/
  plugin.yaml            # kind: platform / 版本区间 / env / capabilities
  __init__.py            # register(ctx) → 只调 shim.register
  shim.py                # ≤120 行：ctx.register_platform(...) + 起停 aiohttp app
  core/
    app.py               # aiohttp Application：路由表 + 中间件（认证/scope/限流/审计/错误映射）
    auth.py              # token 校验、scope、内存令牌桶
    registry.py          # devices 读写、心跳、撤销
    mailbox.py           # tasks 认领/回传（原子 claim、TTL 过期）
    proxy.py             # 上游转发 + SSE 流式保真 + author 覆盖 + 幂等键前缀
    fsguard.py           # /api/fs 白名单
  tools.py               # register_tools(ctx)：local_devices / local_dispatch / local_task
  tests/                 # pytest + aiohttp test client + 假上游
```

`plugin.yaml`（草案，H0 实测后钉死区间）：

```yaml
name: pi-workbench
kind: platform
version: 0.1.0
hermes: ">=0.22.6,<0.24"        # 已部署版本 0.22.6
python_dependencies: []          # aiohttp 已是上游依赖
requires_env:
  - PI_HUB_ADMIN_KEY             # 登记 / 撤销设备
  - HERMES_API_BASE              # 默认 http://127.0.0.1:<api_server 端口>
  - HERMES_API_SERVER_KEY        # loopback 调上游
optional_env:
  - PI_HUB_PORT                  # 默认 8484
  - PI_HUB_TASK_TTL_SECONDS      # 默认 600
capabilities: [network_ingress, durable_state]   # 走一次同意屏
```

**三层纪律**：
1. `shim.py` 是唯一碰 Hermes 插件 API 的文件 —— 上游改签名只改它；
2. `core/` 不知道 Hermes 存在（输入 HTTP、状态 SQLite），**随时可 5 分钟外提为独立服务**；
3. `tools.py` 只依赖 `ctx.register_tool`，与 `core/mailbox.py` 通过函数调用交互。

---

## 8. 设备身份细则（D0 已落地，此处为最终口径）

| 项 | 定义 |
| --- | --- |
| `deviceId` | 本地首次**启动时**生成（`initAppDirectories` 之后），只读、不重置；随每轮 `author.id = pi-workbench/<uuid>` |
| 设备名 | 默认读系统友好名（macOS `scutil --get ComputerName` / Linux `hostnamectl --pretty`，失败回落 hostname），**只探测一次**（`probedAt`），用户可改、改完下一轮生效；跟随系统改名须按「重新读取系统名」 |
| device token | `pi_<base64url(32B)>`；服务端只存 hash + 前 8 位；本地 `safeStorage`（`enc:`）；scopes `['chat','dispatch']`（`admin` 单独签发） |
| 权威来源 | **token → deviceId**。客户端自称的 `author` 会被插件覆盖；`X-Pi-Device` 只允许插件注入（中间件先删客户端传入的） |
| 模型可见性 | **默认不注入 prompt**。模型要确认设备时调 `local_devices()`（按需、可审计、不可伪造）；`author` 只进 memory provider 的 `sync_turn`（已核源码，不进 prompt） |
| 心跳 / 离线 | 30s 心跳；>90s 无任何认证请求判离线（任一请求都会刷 `last_seen_at`） |

---

## 9. 反向派活细则（H3，需 ADR-008）

### 9.1 任务信封

```ts
interface RemoteTask {
  taskId: string          // uuid，幂等键
  deviceId: string
  projectId: string       // 必须是本地已登记并信任的工作区
  prompt: string          // ≤8k
  mode: 'readonly' | 'ask'   // 上限 readonly，云端的 'full' 直接 refused
  timeoutS: number        // ≤3600
  createdAt: number
  expiresAt: number       // 默认 10 分钟
  origin: { runId: string; sessionId: string | null }
}
```

### 9.2 三个工具（`provides_tools`，非 MCP）

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `local_devices()` | — | `[{deviceId, name, online, scopes, lastSeenAt, projects}]` |
| `local_dispatch(deviceId?, projectId, prompt, mode?, timeoutS?)` | 缺省设备 = 最近活跃在线设备 | `{taskId, status: 'queued'}` 或 `refused: <reason>` |
| `local_task(taskId)` | — | `{status, exitCode?, summary?, startedAt?, finishedAt?}` |

拒绝原因固定枚举：`disabled`（总开关关）· `permission_ceiling`（要的档位高于上限）· `unknown_project` · `device_offline` · `device_unknown` · `scope_required` · `queue_full`。

### 9.3 本地执行器（复用既有能力，不新造）

| 门 | 实现 |
| --- | --- |
| 总开关 | 默认**关**；关掉即 `refused: disabled`（插件侧也拒绝入队） |
| 工作区白名单 | 只接受已登记 + 已信任的工作区（`workspace-trust.ts`） |
| 档位上限 | 默认 `readonly`；请求 `ask`/`full` 高于上限 → `refused: permission_ceiling` |
| 逐次审批 | 每个写能力动作走既有 `ApprovalBroker`；超时 / 通道缺失一律拒绝（fail-closed） |
| 执行 | 新建本地会话执行该 prompt，产出摘要（退出码、改动文件数、结果前 N 字） |

### 9.4 结果回传粒度

只回**摘要**（≤2k）：状态、退出码、改动统计、结果前 200 字、错误首行。完整 diff / 日志留在本地可导出，不回云端。

---

## 10. 本地侧改造（H1/H2）

| 项 | 改动 |
| --- | --- |
| 配置 `connection.json` | 增 `gatewayUrl`（默认 hub）、`deviceId`、`deviceToken`（`enc:`）、`scopes`、`hubStatus`；`apiKey` 降级为**仅登记设备时**使用 |
| 客户端 | 所有 cloud 调用收敛到 `cloudFetch()`：带 device token、统一错误码映射；**删除直连分支** |
| 连接页 | 改为「云端网关」：地址 + 管理密钥（登记用）+ 「登记这台设备」+ token 前 8 位 / scope / 在线状态 + 「注销这台设备」 |
| 设备卡（D0 已有） | 增登记状态、scope、在线、注销；本地仍发 `author`（会被插件覆盖，权威在服务端） |
| 错误态 | `unauthorized` / `device_revoked` / `scope_required` / `upstream_unavailable` 四种明确文案 + 各自下一步 |
| 心跳 | 主进程 30s 定时（随窗口生命周期），失败静默重试；>90s 视为离线并在 UI 灰显 |
| 自检 | `CloudDiagnosticsPanel` 增一块「网关」：`/v1/hub/health` 的三项（插件版本 / 上游连通 / 设备在线） |

---

## 11. 安全与失败语义

| 项 | 约定 |
| --- | --- |
| 身份权威 | token → deviceId；`author` 被插件覆盖；`X-Pi-Device` 先删后注，客户端无法伪造 |
| 注入隔离 | 设备名 / 项目名一律进结构化字段，不进 system prompt；派活 prompt 只在本地审批卡里给人看 |
| fail-closed | token 缺失/无效/撤销 → 401；scope 不足 → 403；上游不通 → 502 `upstream_unavailable`；**永不"放行当默认"** |
| 同进程防护 | sqlite 走 `asyncio.to_thread` + WAL + 短事务；代理超时 120s、SSE 空闲 15min；限流 60 req/min/设备、SSE 并发 2 |
| 审计 | 所有写操作（approval / clarify / config PUT / dispatch / result）一条 JSONL：deviceId、path、状态码、耗时、ip |
| `/api/fs` | 白名单目录 + `realpath` 校验，越界 403 + 审计 |
| 凭据 | 上游 `API_SERVER_KEY` 只在插件进程内；本地永不持有；device token 可单台撤销 |
| 威胁模型补充 | 插件与 agent 同进程 → 若 agent 被注入，它**可能**读到插件数据目录。因此：token 只存 hash、邮箱不存完整命令、审计独立落盘，且**派活的最终闸门始终在本地**（云端被完全接管也拿不到超出 readonly 的能力） |

**没有兜底的代价**：插件必须「挂了就明确报错，不假装成功」。本地 UI 是唯一的故障判断依据。

---

## 12. 分期与工期（≈3 周）

| 阶段 | 内容 | 工期 | 完成标准 |
| --- | --- | --- | --- |
| **H-1 预检** | §14 清单全部通过；QD/QN 全部签字 | 你 30 分钟 + 我 1 小时 | 见 §14 结果栏 |
| **H0 骨架** | 插件目录 + `plugin.yaml` + `shim` + `core/app` + SQLite + admin 登记/撤销 + token 中间件 + `/v1/hub/health` + 只读代理（health/capabilities/toolsets/skills/models）+ Caddy vhost | 3 天 | 带 token 从本机拿到 capabilities；无 token 401；撤销后立刻 401 |
| **H1 全量切换** | `/v1/runs*`（含 SSE 保真）+ sessions/jobs/config/media/fs + 本地改单入口 + 错误码映射 + 全功能回归 | 4 天 | 本地一切照旧：聊天/工具卡/审批/插话/跨重启 attach/会话管理/任务页/自检/图片；断线重连不重复不丢 |
| **H2 设备面** | 心跳/在线/注销 + 本地登记与状态 UI + 审计打通 + 自检网关块 | 2 天 | 两台设备各自 token；拔网 90s 离线；撤销后 UI 提示「设备已注销」 |
| **H3 派活** | 三个工具 + 邮箱 + 本地执行器（开关/白名单/上限/审批/摘要）+ 结果回传 | 5 天 | AC-D05~D13 |
| **H4 收口** | 运维手册（备份/升级/doctor）、威胁模型复核、版本区间钉死、文档定稿 | 2 天 | `hermes plugins update` 后数据不丢；`plugin doctor` 通过 |

**切换点只有一个**：H1 末尾。此后本地不再有第二条路（回滚 = 改配置 + 停用插件，运维动作）。

---

## 13. 验收场景

| 编号 | 场景 | 通过标准 | 阶段 |
| --- | --- | --- | --- |
| AC-D01 | 设备识别（通道层） | 两台设备各发一轮，审计与 `/v1/devices` 都能标出设备；`author` 由插件按 token 填入 | H1/H2 |
| AC-D01b | 设备识别（模型层） | 问「你从哪台设备收到这条消息」→ 它调 `local_devices()`（时间线有工具卡）并答对；不依赖任何 prompt 注入 | H3 |
| AC-D02 | 设备撤销 | 撤销 A → A 立刻 `401 device_revoked`，B 不受影响 | H2 |
| AC-D03 | 在线状态 | 关掉 A → 90s 内显示离线；重连自动恢复 | H2 |
| AC-D04 | 多设备并发 | A、B 同时对同一会话发言 → 后者 `queued`，界面显示排队，两条都不丢 | H1 |
| AC-D05 | 派活闭环 | 云端「在 project-X 跑测试」→ 工具卡带参数 → 本地新会话执行 → 摘要回到云端时间线 | H3 |
| AC-D06 | 双层审批 | 云端工具调用弹一次审批；本地按档位再批；任一处拒绝则中止且审计有记录 | H3 |
| AC-D07 | **不可放大（生死线）** | 云端请求 `mode: 'full'` → `refused: permission_ceiling`，本地不建会话 | H3 |
| AC-D08 | 白名单 | 未登记项目 → `refused: unknown_project` | H3 |
| AC-D09 | 幂等与独占 | 同一 `taskId` 重放只执行一次；两台设备不同时跑同一任务 | H3 |
| AC-D10 | 过期 | 设备离线时派活 → TTL 后 `expired`，设备上线也不执行 | H3 |
| AC-D11 | 总开关 | 关闭 → 立即 `refused: disabled`；重开无需重装 | H3 |
| AC-D12 | 审计三问 | 一条任务链能回答「谁派的 / 哪台设备执行 / 真实结果」 | H3 |
| AC-D13 | **注入演练（生死线）** | 云端读含恶意指令的网页后派活 → 本地仍必须人工批准，且拿不到高于上限的档位 | H3 |
| AC-D14 | 断网恢复 | 本地断网 1 分钟，TTL 内重连后完成；超时后不重复执行 | H3 |
| **AC-D15** | **SSE 保真** | 切换后：工具卡顺序不变、审批卡不重复、重连不重放已收事件、`Last-Event-ID` 生效 | H1 |
| **AC-D16** | **故障可分辨** | 停掉插件 → UI 显示「网关不可用」；只停 Hermes → UI 显示「Hermes 异常」（两者文案不同） | H1 |
| **AC-D17** | **越权阻断** | 只给 `chat` 的 token 调 `local_dispatch` / `config PUT` → 403 `scope_required`；`/api/fs` 越界 → 403 | H1/H3 |

---

## 14. 执行前检查清单（H-1）

### 14.1 本地：已执行并通过（2026-11-06，`main` @ `96f2eaa`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 工作树干净 | `git status --porcelain` | ✅ 无改动 |
| Node 版本（构建脚本 / 主进程约束） | `node -v` | ✅ v24.21.0（≥24） |
| 类型 | `npm run type-check` | ✅ 0 |
| 静态检查 | `npm run lint` | ✅ 0 |
| 全量测试 | `npm test` | ✅ 148 文件 / 1744 用例 |
| 主进程 + preload 构建 | `npm run build:main` | ✅ 0 |
| D0 产物就位 | `data/cloud-agent/device.json` | ✅ `id` + `name = TChen-Legion` |

### 14.2 本地：已核实的外部事实（无需凭证）

| 事实 | 探测方式 | 结果 |
| --- | --- | --- |
| 上游版本 | `GET https://api.tchen-xiaoxiao.com/health` | ✅ `{"status":"ok","platform":"hermes-agent","version":"0.22.6"}` |
| 上游运行时 | 同响应头 | ✅ `Server: Python/3.14 aiohttp/3.14.5` → **aiohttp 已是现成依赖，插件不需要新装包** |
| 反代类型 | 响应头 | ✅ `Via: 1.1 Caddy` → Caddy 已在前，加 vhost 即可 |
| 鉴权失败形状 | `GET /v1/capabilities`（无 token） | ✅ `401 {"error":{"code":"gateway_auth_failed","type":"gateway_auth_error"}}` → 插件错误码要与之区分 |
| `/health` 只接受 GET | `HEAD /health` | ✅ `405 Allow: GET` → 健康检查用 GET |
| `hub` 子域是否已被占用 | `nslookup hub.tchen-xiaoxiao.com` | ✅ 未解析，可新建 |

### 14.3 VPS：待执行（**硬阻塞 H0**，请贴回结果）

```bash
# 1) Hermes 安装位置与 home
echo "$HERMES_HOME"; which hermes; hermes --version

# 2) 插件系统是否存在（本方案的整个前提）
hermes plugins --help | head -30
ls -la "$HERMES_HOME/plugins" 2>/dev/null | head
python - <<'PY'
import importlib, inspect
for mod, names in [("plugins.plugin_storage", ["plugin_data_dir", "plugin_db"]),
                   ("gateway.platforms.base", ["BasePlatformAdapter"])]:
    try:
        m = importlib.import_module(mod)
        print(mod, "->", {n: hasattr(m, n) for n in names})
    except Exception as e:
        print(mod, "-> MISSING:", e)
PY

# 3) 平台适配器注册入口（签名是否与文档一致）
python - <<'PY'
import inspect
try:
    from plugins.api import PluginContext
    print("register_platform:", inspect.signature(PluginContext.register_platform))
    print("register_tool:", inspect.signature(PluginContext.register_tool))
except Exception as e:
    print("PluginContext 探查失败:", e)
PY

# 4) api_server 监听端口（插件要回环调它）
ss -ltnp | grep -E ':(8[0-9]{3}|3[0-9]{4})' || netstat -ltnp | head -20
grep -RIn "api_server" "$HERMES_HOME/config.yaml" 2>/dev/null | head

# 5) API_SERVER_KEY 的读取位置（插件要用同一把）
grep -n "API_SERVER_KEY" "$HERMES_HOME/.env" 2>/dev/null | sed 's/=.*/=<hidden>/'

# 6) gateway 的 systemd 单元（插件随它重启）
systemctl list-units --type=service | grep -i hermes

# 7) Caddy 配置位置与现有 vhost
systemctl status caddy --no-pager | head -5
find /etc/caddy /etc/caddyfile -maxdepth 2 -name "*Caddyfile*" 2>/dev/null

# 8) 端口 8484 是否空闲
ss -ltn | grep ':8484' || echo "8484 free"

# 9) 备份现状（万一要回滚）
tar czf ~/hermes-backup-$(date +%F).tgz "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" 2>/dev/null && ls -lh ~/hermes-backup-*.tgz
```

### 14.4 VPS：待确认（不阻塞 H0，阻塞 H1/H3）

| 项 | 为什么 | 检查方式 |
| --- | --- | --- |
| `plugins update` 是否保留 `plugin_data_dir` | 决定备份策略 | 用一次性测试插件跑一次 install→update→remove |
| `provides_tools` + `tools.py::register_tools` 在 0.22.6 是否存在 | H3 的前提（否则退回 MCP + `platform_toolsets`） | `grep -rn "register_tools" "$HERMES_HOME"/plugins \| head` |
| `kind: platform` 插件是否在 gateway 启动时自动 `connect()` | 决定设备入口何时起来 | 用最小 adapter 打印日志验证 |
| SSE 是否被 Caddy 缓冲 | AC-D15 的前提 | `curl -N` 通过 hub 域名看首字节延迟 |
| `/api/fs/read-data-url` 实际可读目录 | 白名单要按真实路径写 | `grep -rn "read-data-url" "$HERMES_HOME"` |

### 14.5 硬阻塞项（不过就不开工）

1. 插件系统在 0.22.6 里存在（14.3 第 2 项）
2. `API_SERVER_KEY` 可被插件进程读到（14.3 第 5 项）
3. api_server 端口可回环访问（14.3 第 4 项）
4. `hub` 子域可解析 + Caddy 可加 vhost（14.3 第 7、8 项）
5. §17 的 QD/QN 全部签字

---

## 15. 运维

| 项 | 做法 |
| --- | --- |
| 部署 | `hermes plugins install <git url>`（开发期用 `$HERMES_HOME/plugins/pi-workbench` 直放），`hermes plugins enable pi-workbench` |
| 暴露 | Caddy：`hub.tchen-xiaoxiao.com { reverse_proxy 127.0.0.1:8484 { flush_interval -1 } }` + 关闭压缩 |
| 随启 | 由 gateway 拉起（`kind: platform` 在配置启用后 `connect()`）；systemd 仍是原 gateway 单元 |
| 数据 | `plugin_data_dir("pi-workbench")`：`hub.db` + `audit-YYYYMM.jsonl`。备份 = 拷整个目录 |
| 升级 | `hermes plugins update pi-workbench`（数据不受影响）；升 Hermes 前跑 `hermes plugins doctor` |
| 观测 | `/v1/hub/health`（匿名）、audit JSONL、gateway 日志（插件用同一 logger） |
| 限流默认 | 60 req/min/设备；SSE 并发 2；单设备任务队列 8 |
| 撤销设备 | `POST /v1/devices/{id}/revoke` + 本地连接页「注销这台设备」 |

---

## 16. 风险与回滚

| 风险 | 严重度 | 缓解 |
| --- | --- | --- |
| 插件挂 = 云端全挂（无兜底） | 高 | 热路径无 DB 写、限流、超时；`/v1/hub/health` 让 UI 一眼分辨故障源（AC-D16） |
| SSE 保真（缓冲/压缩/分块/断连） | 高 | 契约测试专项 + Caddy `flush_interval -1` + 不压缩 + AC-D15 |
| 同进程阻塞事件循环 | 高 | sqlite 全异步 + WAL 短事务；禁止同步 HTTP；每路由超时 |
| 上游插件 API 变更 | 中 | `shim.py` ≤120 行 + 版本区间 + `plugin doctor`；`core/` 不依赖 Hermes |
| `/api/fs` 越界读 | 高 | 白名单 + realpath + 403 + 审计（AC-D17） |
| 迁移期 `author` 双写混乱 | 低 | 插件覆盖；本地值只进日志 |
| 插件数据丢失 | 中 | `plugin_data_dir` 每日备份；设备可重新登记（token 重签即可） |

**回滚**（运维动作，代码里不实现）：`connection.json` 的 `gatewayUrl` 指回 `https://api.tchen-xiaoxiao.com` + 用回 `apiKey`；`hermes plugins disable pi-workbench`。前提是 `apiKey` 字段保留到 H4 之后。

---

## 17. 待确认（开工前需签字）

### 17.1 已定（项目所有者 2026-11-06 确认）

| 编号 | 事项 | 结论 |
| --- | --- | --- |
| C-1 | 单缝：除 dashboard 外全部经插件 | ✅ 已定 |
| C-2 | 不做直连兜底 | ✅ 已定 |
| C-3 | 插件形态取代 `pi-hub` | ✅ 已定 |

### 17.2 仍需签（QD，与 v1 一致）

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| QD-1 | 接受「自写 Hermes 插件 + 一条 Caddy vhost + 与 agent 同进程」的风险吗？ | 接受（独立服务已作废） |
| QD-2 | 分期顺序 H0→H1→H2→H3→H4 认可吗？ | 认可；H3 前必须先批 ADR-008 |
| QD-3 | 多设备默认「每设备一会话」还是「共享一会话」？ | 默认分开（同会话并发会排队），共享作为显式开关 |
| QD-4 | 派活权限上限默认档？总开关默认？ | 上限 `readonly`；总开关**默认关** |
| QD-5 | 结果只回摘要？ | 只回摘要（≤2k），完整内容留在本地导出 |
| QD-6 | 谁决定派给哪台设备？ | 模型可指定；缺省「最近活跃且在线」；冲突排队不并行 |

### 17.3 新增待确认（QN，插件形态带来的）

| 编号 | 问题 | 为什么必须问 | 我的建议 |
| --- | --- | --- | --- |
| QN-1 | `hub.tchen-xiaoxiao.com` 这个子域可以用吗？ | 要新建 DNS + Caddy vhost | 用它；备选 `gw.` |
| QN-2 | 插件端口用 `127.0.0.1:8484`？ | 要避开上游已占用端口 | 8484，仅监听回环 |
| QN-3 | 管理密钥（登记/撤销设备用）放在哪？ | 它等于「签发票的能力」，比 device token 更敏感 | VPS 的 systemd `Environment=` 里（不进仓库、不进 `.env` 共享给 agent） |
| QN-4 | 升级 Hermes 时允许插件短暂中断吗？ | 无兜底意味着升级 = 云端不可用若干秒 | 允许；升级前先 `plugins disable`，避免半加载状态 |
| QN-5 | 本地 `apiKey` 字段保留到 H4 之后（应急用）可以吗？ | 无兜底时它是唯一回滚手段 | 保留但不在正常路径使用 |
| QN-6 | VPS 操作由谁执行？ | 我需要 `hermes plugins`、Caddy、systemd 权限 | 你执行 + 贴结果（我给出逐条命令），或临时给我 SSH |
| QN-7 | SSE 空闲超时 15 分钟够吗？（长任务可能静默很久） | 太短会掐掉长任务 | 15 分钟空闲；有心跳注释行维持连接 |

---

## 18. 非目标

- 不做账号 / 租户 / 团队共享（单用户多入口）
- 不把 dashboard 纳入插件（WebSocket + 上游前端）
- 不做自动兜底 / 多路复用 / 主备切换
- 不做云端到本地的直连（本地不开入站端口，铁律 S-01 不变）
- 不做预算熔断（S-07 已删）
- 不把完整 diff / 日志 / 绝对路径送回云端

---

## 19. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| **v2** | 2026-11-06 | **改单缝 + 插件形态**：`pi-hub` 独立服务作废，改为 Hermes 插件 `pi-workbench`（`kind: platform`，与 gateway 同进程）；除 dashboard 外**全部对接**经插件；**不做直连兜底**；接口契约按「设备管理 / 设备侧 / 透明代理」三类重写；派活工具由 MCP 改为 `provides_tools`（不再改 `platform_toolsets`）；新增 AC-D15~D17；新增 §14 执行前检查（本地 7 项已通过、VPS 9 项待执行）与 QN-1~QN-7 |
| v1.5 | 2026-11-06 | 身份时机定稿（A+B）：启动即建 id；友好名只探测一次 + `cloud:device:reprobe` |
| v1.4 | 2026-11-06 | D0 已实现 |
| v1.3 | 2026-11-06 | D0 口径定稿：不做换机器检测；设备名可自定义并即时生效 |
| v1.2 | 2026-11-06 | 设备名默认读系统友好名；D0 去掉重置按钮 |
| v1.1 | 2026-11-06 | 设备身份改「通道强制 + 工具按需」，取消每轮注入 |
| v1 | 2026-11-06 | 初稿（`pi-hub` 独立服务方案） |
