# 云端 Agent 多设备身份与反向派活方案 v2（单缝 · Hermes 插件形态）

> **面向**：要实现「多台本地程序连同一个云端 Agent」「云端 Agent 认得是哪台设备」「云端指挥本地 Agent 干活」的人
> **什么时候读**：动对接层（本地 ↔ 云端）、设备身份、反向任务通道、变更 S-02 之前
> **什么时候要改**：插件形态、设备身份口径、派活权限口径、上游插件 API、验收场景变化时
> **状态**：v2.1 · 2026-11-06 · **未开工（预检已完成）** · D0 已落地；[ADR-008](../decisions/ADR-008-cloud-single-entry-plugin.md) 已接受；VPS 9 项预检已跑完（§14）
> **取代**：v1 的 `pi-hub` 独立服务方案（作废，理由见 §4）

---

## 0. 一句话

**本地与云端之间只留一条缝：一个自写的 Hermes 插件。** 插件在 VPS 上、与 gateway 同进程，负责认设备、限权、审计、代转发，并提供派活工具；云端仍然**只能发请求**，能力（写文件 / 跑命令 / 用哪个工作区）永远由**本地**按白名单 + 档位上限 + 逐次审批授予。
**派活单位是「工作区」，不是「设备」** —— 设备只是承载者；云端说「在 project-X 里跑测试」，本地决定用哪个目录、哪个会话、多大权限。

---

## 1. 三条需求与落点

| # | 需求 | 落点 | 结论 |
| --- | --- | --- | --- |
| D-01 | 多台本地程序连同一个云端 Agent，云端要能识别是哪台设备 | 设备 token → `deviceId`（插件中间件）；`author` 由插件按 token 覆盖；审计逐条带设备 | 插件 + 本地设备卡 |
| D-02 | 同一云端 Agent 只对应同一用户，多设备只是同一人的不同入口 | 不做账号 / 租户 / 团队；一个 profile、一个用户、多台设备 | 不引入多租户 |
| D-03 | 云端 Agent 要能指挥本地 Agent 工作（**按工作区**） | 插件四个工具 → 工作区任务邮箱 → 本地执行器（审批/上限/白名单）→ 摘要回传 | 需 S-02 改口径（ADR-008） |

---

## 2. 四条定稿决策（2026-11-06，项目所有者确认 / 授权代定）

| # | 决策 | 含义 |
| --- | --- | --- |
| **C-1** | **单缝** | 本地 → 云端只有一条路：`https://hub.tchen-xiaoxiao.com` + 设备 token。除 dashboard 外**全部**经插件（轮次、SSE、审批、会话、任务、配置、媒体） |
| **C-2** | **无直连兜底** | 代码里不保留第二套客户端、不做自动回落。应急只有运维动作（改配置），不是运行时特性 |
| **C-3** | **插件形态** | 弃 `pi-hub` 独立服务；改为 Hermes 插件 `pi-workbench`（`kind: platform`，与 gateway 同进程，随其重启） |
| **C-4** | **派活是工作区层级** | 派活目标 = **工作区**（受信任目录 + 执行上下文），设备只是承载者。云端看到的是「哪些工作区可用」，不是「哪台机器可用」；一个工作区同一时刻只属于一台设备 |

**唯一例外**：dashboard（`dash.tchen-xiaoxiao.com`，WebSocket + 静态资源 + 上游自有前端）继续直连，插件不代理。

**授权代定的次要项**（所有者：「这个你决定就行」）：

| 项 | 定值 |
| --- | --- |
| 插件端口 | `127.0.0.1:8484`（仅回环） |
| 管理密钥 | systemd drop-in 的 `Environment=`（不进仓库、不进 agent 可读的 `.env`） |
| SSE 空闲超时 | 15 分钟（有心跳注释行维持） |
| 多设备会话 | 默认**每设备一会话**；共享会话作为显式开关 |
| 派活上限 / 总开关 | 上限 `readonly`；总开关**默认关** |
| 结果粒度 | 只回摘要（≤2k） |
| 派活选设备 | 由 **工作区** 反查设备（工作区→唯一设备）；工作区离线即拒 |
| 升级中断 | 允许（开发阶段，无可用性承诺）；升级前先 `plugins disable` |
| 本地 `apiKey` 字段 | 保留到 H4 之后（唯一回滚手段），正常路径不用 |
| 本地会话缓存层 | **不做**（所有者：开发阶段，云端可长期停机） |
| 分期顺序 | H0 → H1（唯一切换点）→ H2 → H3 → H4 |

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
| 设备入口（认 token、长轮询） | `kind: platform` 插件 + `ctx.register_platform(name, label, adapter_factory, check_fn, …)`；`connect()` 里自起 HTTP 服务 | `hermes_cli/plugins.py:779`（已核实签名） |
| 模型侧工具 | `provides_tools` + `tools.py: register_tools(ctx)` → `ctx.register_tool(name, toolset, schema, handler, …)`，**无需单独 MCP server** | `hermes_cli/plugins.py:463`（已核实） |
| 设备目录 / 邮箱 / 审计 | `plugin_data_dir()` + `plugin_db()`（SQLite WAL），`hermes plugins update` 不丢 | 同上「Store durable state」 |
| 权限声明 / 配置 | `plugin.yaml` 的 `capabilities:`（同意屏）、`requires_env` / `optional_env` | 同上 |
| 生命周期 / 校验 | `hermes plugins install/enable/update/remove` + `plugin doctor` | 同上 |
| 先例 | 内置 **`a2a` 插件**：自带 HTTP 入口（Agent Card + JSON-RPC）**同时**提供客户端工具 —— 与本方案同形 | 插件目录 |

**v2 的一个错误已纠正**：v2 曾写「`provides_tools` 免掉改 `platform_toolsets` 白名单」。预检实测（§14.2）证明**仍要改**——`platform_toolsets.api_server` 是显式白名单，我们的工具集必须加进 profile `config.yaml`，否则 api_server 会话看不到插件工具（clarify 踩过同一个坑）。

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
| `POST /v1/devices/me/workspaces` | 上报工作区清单（`workspaceId` + 显示名 + trusted + lastActiveAt，**无路径**） | `chat` |
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

workspaces(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL,
           trusted INTEGER NOT NULL, last_active_at INTEGER,
           UNIQUE(id, device_id))

tasks(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
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
- `workspaces` 是缓存镜像（真相源在本地）；设备离线时 `online=0` 推导得出，不落盘。
- **两张表都没有路径列** —— 路径永不出本机（AC-D18）。

---

## 7. 插件工程结构

```
pi-workbench/
  plugin.yaml            # kind: platform / 版本区间 / env / capabilities / provides_tools
  __init__.py            # register(ctx) → 只调 shim.register
  shim.py                # ≤120 行：BasePlatformAdapter 子类 + ctx.register_platform + 起停服务线程
  adapter.py             # 极薄的 BasePlatformAdapter 实现（connect/disconnect/send 转发到 core）
  core/                  # ← 纯 stdlib，不知道 Hermes 存在
    __init__.py
    server.py            # ThreadingHTTPServer + 路由表 + 中间件（认证/scope/限流/审计/错误映射）
    auth.py              # token 校验（sha256）、scope、内存令牌桶
    registry.py          # devices / workspaces 读写、心跳、撤销
    mailbox.py           # tasks 认领/回传（原子 claim、TTL 过期）
    proxy.py             # 上游转发（urllib）+ SSE 逐块透传 + author 覆盖 + 幂等键前缀
    fsguard.py           # /api/fs 白名单
    db.py                # sqlite3（WAL）连接与 schema 迁移
  tools.py               # register_tools(ctx)：local_workspaces / local_devices / local_dispatch / local_task
  tests/                 # pytest（纯 stdlib，不需要装任何东西）
```

**传输选型：stdlib（`http.server` + `urllib`），不用 aiohttp。**

| 理由 | 说明 |
| --- | --- |
| 零依赖 | 上游进程里 aiohttp 虽有（`Server: aiohttp/3.14.5`），但依赖在 uv 缓存层，单测要复刻 sys.path 才跑得起来（预检实测） |
| 失败隔离 | 服务跑在**独立线程**里，异常打不死 gateway 的 asyncio 事件循环 |
| 有先例 | 内置 `a2a` 插件就是 "Pure stdlib transport (http.server + urllib) — no a2a-sdk dependency required" |
| SSE 可控 | `text/event-stream` + 逐块 `write`/`flush`，比框架更不容易被缓冲 |

**三层纪律**：
1. `shim.py` + `adapter.py` 是唯一碰 Hermes 插件 API 的文件（`BasePlatformAdapter` / `register_platform`）——上游改签名只改这两个；
2. `core/` 不知道 Hermes 存在（HTTP 进、SQLite 出），**随时可 5 分钟外提为独立服务**；
3. `tools.py` 只依赖 `ctx.register_tool`，通过函数调用进 `core/mailbox.py`。

`plugin.yaml`（H0 实测后钉死区间；`requires_env` 支持 `{name, description, prompt, password}` 形式，见内置 a2a）：

```yaml
name: pi-workbench
label: Pi Workbench
kind: platform
version: 0.1.0
hermes: ">=0.22.6,<0.24"
description: >
  本地 Pi Workbench ↔ 云端 Hermes 的唯一入口：设备 token 鉴权、scope 限权、
  设备/工作区目录与心跳、透明代理（含 SSE 保真）、工作区级派活工具。
provides_tools:            # 不在 CLI/TUI 进程里延迟加载工具的关键
  - local_workspaces
  - local_devices
  - local_dispatch
  - local_task
requires_env:
  - name: PI_HUB_ADMIN_KEY
    description: 登记/撤销设备的管理密钥
    prompt: Pi Workbench hub admin key
    password: true
  - name: HERMES_API_BASE
    description: 本机 api_server 地址（默认 http://127.0.0.1:8642）
    prompt: Hermes api_server base URL
    password: false
optional_env:
  - name: PI_HUB_PORT
    description: 插件监听端口（默认 8484，仅回环）
    prompt: Pi Workbench hub port
    password: false
  - name: PI_HUB_TASK_TTL_SECONDS
    description: 派活默认 TTL（默认 600）
    prompt: Task TTL seconds
    password: false
capabilities: [network_ingress, durable_state]
```

**必须同时改的一行配置**（预检发现，别忘）：

```yaml
# /home/ubuntu/.hermes/profiles/pi-cloud/config.yaml
platform_toolsets:
  api_server:
    - web
    - browser
    - terminal
    - file
    - code_execution
    - vision
    - image_gen
    - pi_workbench      # ← 新增：否则 api_server 会话看不到插件工具
```

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

## 9. 派活细则（工作区层级，H3）

### 9.1 为什么是工作区而不是设备

设备回答「在哪台机器上」；**工作区**才回答「在哪个目录、哪个仓库、哪个分支、以什么权限」。真正的执行上下文是工作区：目录决定了能改哪些文件，工作树决定了能不能并行，登记状态决定了能不能信任。

所以：

| 云端看到的 | 能做的 |
| --- | --- |
| `local_workspaces()` → 工作区清单（名字 + 设备 + 在线 + 信任） | 挑一个工作区派活 |
| 工作区 `workspaceId` | **不透明 id**（`ws_<uuid>`），**不含任何绝对路径**；路径永不出本机 |
| 工作区 ↔ 设备 | **多对一**：一个工作区只属于一台设备；一台设备可有多个工作区 |

同名项目在两台设备各有一份 clone 时 = **两个工作区**（不同 id、显示名带设备后缀），不自动合并——云端说「在 project-X 跑测试」时必须明确是哪一个；选错机器的代价是本地白名单直接拒。

### 9.2 任务信封

```ts
interface RemoteTask {
  taskId: string          // uuid，幂等键
  workspaceId: string     // ws_<uuid>，不含路径
  // deviceId 由插件按 workspaceId 反查填入，客户端/云端不能指定
  prompt: string          // ≤8k
  mode: 'readonly' | 'ask'   // 上限 readonly；云端 'full' → refused
  timeoutS: number        // ≤3600
  createdAt: number
  expiresAt: number       // 默认 10 分钟
  origin: { runId: string; sessionId: string | null }
}
```

### 9.3 四个工具（`provides_tools`，非 MCP）

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `local_workspaces()` | — | `[{workspaceId, name, deviceId, deviceName, online, trusted, lastActiveAt}]` |
| `local_devices()` | — | `[{deviceId, name, online, scopes, lastSeenAt, workspaceCount}]` |
| `local_dispatch(workspaceId, prompt, mode?, timeoutS?)` | 也可用工作区**显示名**（唯一时）；不唯一则 `ambiguous_workspace` | `{taskId, status:'queued'}` 或 `refused: <reason>` |
| `local_task(taskId)` | — | `{status, exitCode?, summary?, startedAt?, finishedAt?}` |

拒绝原因固定枚举：`disabled` · `permission_ceiling` · `unknown_workspace` · `ambiguous_workspace` · `workspace_untrusted` · `workspace_offline` · `scope_required` · `queue_full`。

### 9.4 本地执行器（复用既有能力，不新造）

| 门 | 实现 |
| --- | --- |
| 总开关 | 默认**关**；关掉即 `refused: disabled`（插件侧也拒入队） |
| 工作区白名单 | 只接受已登记 + 已信任工作区（`workspace-trust.ts`）；请求里没有路径可绕 |
| 档位上限 | 默认 `readonly`；`ask`/`full` 高于上限 → `refused: permission_ceiling` |
| 逐次审批 | 每个写能力动作走既有 `ApprovalBroker`；超时 / 通道缺失一律拒绝 |
| 执行上下文 | 在该工作区**新建会话**（不动用户当前会话）；可选工作树会话以并行 |
| 结果 | 只回摘要（≤2k）：状态、退出码、改动统计、结果前 200 字、错误首行 |

### 9.5 工作区登记（本地 → 云端）

| 项 | 约定 |
| --- | --- |
| 登记时机 | 设备登记时上报一次；之后工作区打开/关闭时增量同步（`POST /v1/devices/me/workspaces`） |
| 上报内容 | `workspaceId`、显示名（目录名，可改）、`trusted`、`lastActiveAt`；**绝不上报绝对路径** |
| 上限 | 20 个（超出只保留最近活跃） |
| 撤销 | 关闭工作区即从清单移除；设备注销连带清空 |

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
| 工作区登记 | 打开/关闭工作区时增量同步 `workspaceId`（本地持久化的 `ws_<uuid>`，存 `data/cloud-agent/workspaces.json`）；**路径不出本机** |
| 派活接收 | 主进程长轮询（`wait=25`）+ 执行器；UI 上「云端派来的任务」有独立列表与中断按钮 |

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
| **H3 工作区派活** | 四个工具 + 工作区登记 + 邮箱 + 本地执行器（开关/白名单/上限/审批/摘要）+ 结果回传 | 5 天 | AC-D05/D05b/D06~D14/D18/D19 |
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
| AC-D05 | **工作区派活闭环** | 云端「在 project-X 跑测试」→ 调 `local_workspaces()` → 挑工作区 → 工具卡带 `workspaceId` → 本地在**该工作区新建会话**执行 → 摘要回云端时间线 | H3 |
| AC-D05b | **工作区歧义** | 两台设备各有同名项目 → 按名字派活返回 `ambiguous_workspace`；按 `workspaceId` 派活只落到那一台 | H3 |
| AC-D06 | 双层审批 | 云端工具调用弹一次审批；本地按档位再批；任一处拒绝则中止且审计有记录 | H3 |
| AC-D07 | **不可放大（生死线）** | 云端请求 `mode:'full'` → `refused: permission_ceiling`，本地不建会话 | H3 |
| AC-D08 | 白名单 | 未登记工作区 → `refused: unknown_workspace`；已登记未信任 → `workspace_untrusted` | H3 |
| AC-D09 | 幂等与独占 | 同一 `taskId` 重放只执行一次；一个工作区不同时跑两个任务 | H3 |
| AC-D10 | 过期 | 设备离线时派活 → TTL 后 `expired`，设备上线也不执行 | H3 |
| AC-D11 | 总开关 | 关闭 → 立即 `refused: disabled`；重开无需重装 | H3 |
| AC-D12 | 审计三问 | 一条任务链能回答「谁派的 / 哪个工作区执行 / 真实结果」 | H3 |
| AC-D13 | **注入演练（生死线）** | 云端读含恶意指令的网页后派活 → 本地仍必须人工批准，且拿不到高于上限的档位 | H3 |
| AC-D14 | 断网恢复 | 本地断网 1 分钟，TTL 内重连后完成；超时后不重复执行 | H3 |
| AC-D15 | SSE 保真 | 切换后工具卡顺序不变、审批卡不重复、重连不重放已收事件、`Last-Event-ID` 生效 | H1 |
| AC-D16 | 故障可分辨 | 停插件 → UI「网关不可用」；只停 Hermes → UI「Hermes 异常」（文案不同） | H1 |
| AC-D17 | 越权阻断 | 只给 `chat` 的 token 调 `local_dispatch` / `config PUT` → 403 `scope_required`；`/api/fs` 越界 → 403 | H1/H3 |
| AC-D18 | **路径不外泄** | 抓插件出站/审计/工具返回：只有 `workspaceId` 与显示名，**没有任何绝对路径**（含审计日志） | H3 |
| AC-D19 | 工具可见性 | `platform_toolsets.api_server` 加 `pi_workbench` 后，云端会话时间线能看到四个工具卡；删掉那行即消失（回归防线） | H3 |

---

## 14. 执行前检查（H-1）— 已完成

### 14.1 本地（2026-11-06，`main` @ `48efe9a`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 工作树干净 | `git status --porcelain` | ✅ 无改动 |
| Node（构建约束） | `node -v` | ✅ v24.21.0 |
| 类型 / 静态 / 构建 | `npm run type-check` · `lint` · `build:main` | ✅ 全 0 |
| 全量测试 | `npm test` | ✅ 148 文件 / 1744 用例 |
| D0 产物 | `data/cloud-agent/device.json` | ✅ `id` + `name = TChen-Legion` |
| hub DNS | `nslookup hub.tchen-xiaoxiao.com` | ✅ → `43.160.243.96`（所有者已解析） |

### 14.2 VPS 实测（`ubuntu@43.160.243.96`）

| # | 预检项 | 结果 |
| --- | --- | --- |
| 1 | 主机 / 系统 | `VM-4-11-ubuntu`，OpenSSH `10.2p1 Ubuntu-2ubuntu3.8`，`sudo -n` 可用 |
| 2 | Hermes 版本与安装 | **v0.22.6**（2026.9.24 stable，`local f0d94882e89a`），git 装于 `/home/ubuntu/.hermes/hermes-agent` |
| 3 | 服务 | `hermes-gateway-pi-cloud.service`（`User=ubuntu`，`hermes --profile pi-cloud gateway run`）、`hermes-dashboard-pi-cloud.service`（127.0.0.1:9119）、`caddy.service` |
| 4 | **api_server** | drop-in 里 `API_SERVER_ENABLED=true` / `HOST=127.0.0.1` / **`PORT=8642`**（`ss` 确认在听） |
| 5 | **HERMES_HOME** | 服务用的不是 `~/.hermes`，而是 **`/home/ubuntu/.hermes/profiles/pi-cloud`** |
| 6 | **插件系统** | `hermes plugins` 子命令齐全（`install/update/adopt/validate/pack/doctor/list/enable/disable/capabilities/…`），`plugins list` 可正常输出；profile 下尚无 `plugins/` 目录 |
| 7 | **`register_platform`** | 存在（`hermes_cli/plugins.py:779`）：`(name, label, adapter_factory, check_fn, validate_config=None, required_env=None, install_hint="", **entry_kwargs)` |
| 8 | **`register_tool`** | 存在（`hermes_cli/plugins.py:463`）：`(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False)`；`override=True` 需 config 显式允许 |
| 9 | 先例插件 | `plugins/platforms/a2a/`（`plugin.yaml` + `adapter.py` + `tools.py:register_tools(ctx)`；**纯 stdlib 传输**） |
| 10 | 数据目录 | `plugin_data_dir(name)` → `<HERMES_HOME>/plugin-data/<name>/`（profile 级，`plugins update` 保留；`plugin_db` 用 WAL） |
| 11 | **工具白名单** | `platform_toolsets.api_server` 现有 7 项（web/browser/terminal/file/code_execution/vision/image_gen）→ **必须加 `pi_workbench`**，否则工具对 api_server 会话不可见 |
| 12 | Caddy | `/etc/caddy/Caddyfile` 已有 `api.`（`flush_interval -1`）与 `dash.` 两个 vhost；vhost 写法可直接照抄 |
| 13 | 端口 | 8642 / 9119 在听（均 127.0.0.1）；**8484 空闲**；80/443 由 Caddy |
| 14 | Python 环境 | 运行时是 `/home/ubuntu/.hermes/tools/python-3.14.9+.../bin/python3` + uv overlay 依赖（直接 `python3 -c "import ruamel"` 会失败）→ **插件必须 stdlib-only**，单测用系统 python 即可跑 |
| 15 | 备份 | 插件安装前打 `config.yaml` + `.env` + `plugins/` + `plugin-data/` 的 tgz |

### 14.3 连服务器的方式（运维记录）

```bash
# 端口 22 在本机直连超时，必须走本地 7890 的 HTTP 代理 CONNECT；
# 代理偶发返回 "Not allowed at this time"，需要重试。
ssh -i "F:/SSH KEY/SG_001.pem"     -o "ProxyCommand=<HTTP CONNECT 隧道脚本> 127.0.0.1:7890 %h %p"     ubuntu@43.160.243.96
```

其它两把 `SG_002.pem` / `SSH_KEY_001.pem` 对该机无效；`root` 不接受直登（用 `sudo`）。

### 14.4 硬阻塞：全部解除 ✅

插件系统存在 · `API_SERVER_KEY` 可读 · api_server 回环可达 · hub DNS + Caddy 可加 vhost · 8484 空闲。开工只差最后一步：**所有者把 ADR-008 视为已批准**（本次会话中已授权代定）。

### 14.5 H0 第一小时要实测的两件事（不阻塞，但决定写法）

1. `kind: platform` 插件在 gateway 启动时是否**自动** `connect()`，还是要 `config.yaml` 显式启用（决定设备入口何时起来、D1 验收怎么做）。
2. 经 Caddy + `hub.` 转发后 SSE 是否被缓冲（AC-D15 的前提；`flush_interval -1` 已有先例）。

---

## 15. 运维（已按实测路径写）

| 项 | 做法 |
| --- | --- |
| 插件放置 | 开发期：`/home/ubuntu/.hermes/profiles/pi-cloud/plugins/pi-workbench/`（含 `__init__.py`）；发布期：`hermes plugins install` + `adopt` |
| 启用 | `HERMES_HOME=/home/ubuntu/.hermes/profiles/pi-cloud hermes plugins enable pi-workbench` |
| 环境变量 | systemd drop-in（与 api_server 同一个）：`PI_HUB_ADMIN_KEY`、`HERMES_API_BASE=http://127.0.0.1:8642`、`PI_HUB_PORT=8484`。**不进 `.env`**（agent 读得到） |
| 工具可见性 | profile `config.yaml` 的 `platform_toolsets.api_server` 加 `pi_workbench` |
| 暴露 | `/etc/caddy/Caddyfile` 加：`hub.tchen-xiaoxiao.com { reverse_proxy 127.0.0.1:8484 { flush_interval -1 } }`，`sudo systemctl reload caddy` |
| 重启 | `sudo systemctl restart hermes-gateway-pi-cloud.service`（插件随 gateway 起停） |
| 数据 | `/home/ubuntu/.hermes/profiles/pi-cloud/plugin-data/pi-workbench/`（`hub.db` + `audit-YYYYMM.jsonl`）；备份 = 拷这个目录 |
| 升级 | `hermes plugins update pi-workbench`（数据不动）；升 Hermes 前 `plugins disable` → 升级 → 启用 → `hermes plugins doctor` |
| 观测 | `curl https://hub.tchen-xiaoxiao.com/v1/hub/health`、`tail -f .../plugin-data/pi-workbench/audit-*.jsonl`、`journalctl -u hermes-gateway-pi-cloud -f` |
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

## 17. 决策状态

### 17.1 已定（2026-11-06，所有者确认或授权代定）

| 编号 | 事项 | 结论 |
| --- | --- | --- |
| C-1 | 单缝：除 dashboard 外全部经插件 | ✅ |
| C-2 | 不做直连兜底 | ✅ |
| C-3 | 插件形态取代 `pi-hub` | ✅ |
| C-4 | 派活是**工作区**层级 | ✅ |
| QD-1 | 接受自写插件 + 一条 vhost + 与 agent 同进程 | ✅ |
| QD-2 | 分期 H0→H1→H2→H3→H4 | ✅ |
| QD-3 | 默认每设备一会话，共享会话为显式开关 | ✅ |
| QD-4 | 上限 `readonly`，总开关默认关 | ✅ |
| QD-5 | 只回摘要（≤2k） | ✅ |
| QD-6 | 由工作区反查设备，工作区离线即拒 | ✅ |
| QD-7 | `author` 不进 prompt（源码已证） | ✅ |
| QN-1 | 子域 `hub.tchen-xiaoxiao.com` | ✅ 已解析到 43.160.243.96 |
| QN-2 | 端口 127.0.0.1:8484 | ✅ |
| QN-3 | 管理密钥放 systemd `Environment=` | ✅ |
| QN-4 | 升级允许短暂中断 | ✅ |
| QN-5 | 保留 `apiKey` 到 H4 之后（回滚用） | ✅ |
| QN-6 | VPS 操作由我执行 | ✅ 已连通并跑完预检 |
| QN-7 | SSE 空闲 15 分钟 | ✅ |
| — | 本地缓存层 | ❌ 不做（开发阶段无可用性承诺） |

### 17.2 仍想听你意见的 2 件事（不阻塞 H0，可随时改）

| # | 问题 | 我的默认 |
| --- | --- | --- |
| 1 | **同名工作区怎么显示给云端**：两台设备各有一份 `project-X` 的 clone 时，云端看到两个名字一样的条目，容易选错。要不要自动加设备后缀（`project-X (TChen-Legion)`）？ | 加后缀（云端不误选；`workspaceId` 仍是权威） |
| 2 | **派活是否要能指定分支/工作树**（例如「在 `feat/x` 工作树里跑」） | H3 先不做；只按工作区，分支由本地当前工作树决定。后续按需加 |

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
| **v2.1** | 2026-11-06 | **两处关键修正**：① **派活改为工作区层级**（所有者指出；设备只是承载者，`workspaceId` 不透明、路径永不出本机，`local_workspaces()` 成为主入口，新增 `ambiguous_workspace` / `workspace_untrusted` / `workspace_offline`）；② **传输改 stdlib**（`http.server` + `urllib` + 独立线程，不用 aiohttp —— 上游依赖在 uv overlay 里，单测跑不动；且线程内失败打不死 gateway 循环；与内置 a2a 同款）。另：**纠正 v2 的错误** —— `platform_toolsets.api_server` 白名单**仍要加 `pi_workbench`**（预检实测）；VPS 预检 15 项全部跑完（§14.2）；决策全部锁定（§17.1）；新增 AC-D05b/D18/D19 |
| **v2** | 2026-11-06 | **改单缝 + 插件形态**：`pi-hub` 独立服务作废，改为 Hermes 插件 `pi-workbench`（`kind: platform`，与 gateway 同进程）；除 dashboard 外**全部对接**经插件；**不做直连兜底**；接口契约按「设备管理 / 设备侧 / 透明代理」三类重写；派活工具由 MCP 改为 `provides_tools`（不再改 `platform_toolsets`）；新增 AC-D15~D17；新增 §14 执行前检查（本地 7 项已通过、VPS 9 项待执行）与 QN-1~QN-7 |
| v1.5 | 2026-11-06 | 身份时机定稿（A+B）：启动即建 id；友好名只探测一次 + `cloud:device:reprobe` |
| v1.4 | 2026-11-06 | D0 已实现 |
| v1.3 | 2026-11-06 | D0 口径定稿：不做换机器检测；设备名可自定义并即时生效 |
| v1.2 | 2026-11-06 | 设备名默认读系统友好名；D0 去掉重置按钮 |
| v1.1 | 2026-11-06 | 设备身份改「通道强制 + 工具按需」，取消每轮注入 |
| v1 | 2026-11-06 | 初稿（`pi-hub` 独立服务方案） |
