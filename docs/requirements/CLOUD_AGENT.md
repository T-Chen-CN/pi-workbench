# 云端 Agent（唯一方案文档）

> **面向**：实现、维护、验收云端 Agent 的人
> **什么时候读**：动 `electron/cloud/*`、云端页面、网关插件、配对、设备身份、审批、部署之前
> **什么时候要改**：协议、插件形态、权限口径、部署拓扑、验收标准变化时
> **状态**：2026-11-08 · 桌面端 + 网关插件主链路已完成并随 0.8.0 发布；G0 / G1 真机全绿；后置项（C-08 ~ C-12 / H3）未排期
> **唯一事实源**：本文。历史方案、历史 ADR、历史研究报告已并入本文并从索引移除。
> **运行期资产**：[hermes-bootstrap-prompt.md](./hermes-bootstrap-prompt.md) 仍单独存在，因为应用用 Vite `?raw` 在构建时内联它。

---

## 0. 当前状态

| 项 | 状态 |
| --- | --- |
| 应用仓库 | `main`，版本 `0.8.0`（2026-11-08 发布） |
| 桌面端配对 | Phase 1 已完成：连接码、`cloud:gateway:pair`、配置收窄、旧入口删除 |
| 桌面端云端功能 | 会话 / SSE / 审批 / 控制台 / 任务（含新建）/ 媒体 / 设备身份 / 心跳 / 耐久性已落地，随 0.8.0 发布 |
| 网关插件 | `pi-workbench-gateway` **0.1.2**：P0–P5 全部落地，已 `hermes plugins install` 装到真机 |
| 真实配对 | 可用：`/v1/devices/pairing` + `/v1/devices/pair` 已上线，连接码真机配对通过 |
| 部署 | 已部署：`hub.` 网关在线（Caddy TLS + `flush_interval -1`），`dash.` 直连控制台；G0 / G1 全绿（§8.2） |
| 测试基线 | `npm test`：153 文件 / 1856 用例全绿；`type-check` / `lint` / `build` 全绿 |
| 待验收 | 无（AC-14 / AC-15 / AC-19 已于 2026-11-08 真机跑完，见 §8.4） |
| 后置 | C-08 ~ C-12 与 H3 未排期（§9.4）；「停止按钮 / 跨重启接回」按 2026-11-08 决定不做真机验收 |

**一句话**：主链路（配对 → 会话 → 审批 → 配置 → 任务 → 媒体 → 断线接回）已随 0.8.0 上线并在真机验收；剩下的只有后置能力（C-08 ~ C-12 / H3）。

---

## 1. 目标与非目标

### 1.1 目标

- 云端跑 Hermes Agent，Pi Workbench 做会话、审批、配置与审计的驾驶舱。
- 本地 Agent 与云端 Agent 并存、互不替代、互不调用。
- 单用户、多设备：一个网关对应一个 Hermes profile；每台设备一个 token。
- 本地与云端只留一条缝：网关插件。除 dashboard 外，所有请求经它转发。
- 配对只用一次性连接码；管理密钥不出服务器，桌面端不保存。
- 设备 token → `deviceId`，请求可归因、可撤销、可限权、可审计。
- 插件零第三方 Python 依赖，异常不拖死 Hermes gateway。

### 1.2 非目标

- 多租户、账号体系、团队共享、计费。
- 重写 Hermes Agent 或 fork Hermes。
- 把云端会话写进本地 JSONL；云端真相源仍是 Hermes 自己的存储。
- 桌面端保存管理密钥 / 控制台口令 / 直连 API Key。
- 直连兜底、第二套客户端、自动降级。
- 控制台 HTML 代理；dashboard 由桌面端直接打开。
- 当前 P0–P5 不做 H3 工作区派活 / `local_*` 工具 / 任务邮箱；该能力保留为后续阶段。
- 预算熔断、用量面板、语义分类器、桌面截图 / Xvfb / VNC。

---

## 2. 总体架构

```text
Pi Workbench（本地）
  │  HTTPS + 设备 token
  ▼
Caddy（TLS 终止）
  │  hub.<domain>
  ▼
pi-workbench-gateway（Hermes kind: platform，127.0.0.1:8484）
  ├─ 配对 / 设备 token / scope / 限流 / 审计
  ├─ /v1/* 反向代理（含 SSE）
  ├─ /api/config 白名单读写
  ├─ /api/chat/image-upload、/api/fs/read-data-url（fsguard）
  └─ loopback + API_SERVER_KEY
        ▼
Hermes api_server（127.0.0.1:8642）

dash.<domain> ── 直连 Hermes dashboard（127.0.0.1:9119），不经过插件
```

### 2.1 三个面

| 面 | 用途 | 谁提供 |
| --- | --- | --- |
| 会话 / 轮次 / 审批 / 任务 | 驾驶舱主通道 | Hermes api_server（Bearer REST + SSE） |
| 配置 / 密钥 / 技能 / MCP / 日志 | 配置面 | Hermes dashboard（WebContentsView 内嵌） |
| 设备身份 / 转发 / 审计 | 唯一入口 | 新网关插件 |

### 2.2 两套真相源

| | 本地 Agent | 云端 Agent |
| --- | --- | --- |
| 真相源 | 本地 `sessions/*.jsonl` + `parentId`（ADR-003，不变） | Hermes 自己的会话存储 |
| 本地留存 | 全量 | 只有可丢弃的 UI 缓存 |
| 禁止 | — | 云端会话不写本地 JSONL；本地分支语义不进云端 |

### 2.3 单入口与唯一例外

- 本地 → 云端只有 `gatewayUrl + deviceToken` 这一条路。
- 没有 token 就是没有凭据，上层明确报错；不做直连回退。
- **唯一例外**：dashboard（`dash.<domain>`）由桌面端 `WebContentsView` 直接打开，手动登录，不经过插件。它只做配置台与只读观察窗，不作为对话入口。

---

## 3. 桌面端实现

### 3.1 页面与入口

- 首页常驻「云端 Hermes」入口，不属于任何 `workspaceDir`。
- `CloudWorkspaceView` 内含四个常驻页签：**会话 / 控制台 / 任务 / 连接**。
- 切走只 `hidden + inert`，不卸载、不 reset。
- 云端前端不复用 `ChatPanel` / `chatStore`；只对齐 parts 类型（`text` / `thinking` / `tool` / `approval` / `clarify`）。

### 3.2 连接与配对

连接页只保留：

1. 网关地址（**必填**，没有内置默认值）：用户填自己的 `https://hub.<域名>`，或直接粘贴完整配对链接
   （`https://hub.<域名>/#pair=CODE`，地址从链接里读）。输入框占位符是 `https://hub.example.com`，
   定义在 `electron/cloud/url.ts` 的 `PLACEHOLDER_CLOUD_GATEWAY_URL`（`src/api/cloud.ts` 的 Web mock
   另有一份同名常量）。
   - 客户端**不内置任何人的域名**：`readCloudConfig().gatewayUrl` 未配置时就是空串，
     `parsePairingInput('CODE', '')` 直接返回 `bad_gateway`（提示"还没有可用的网关地址"）。
   - 控制台地址由配对响应或 `hub.` → `dash.` 推导；推不出来就是空，界面显示「未设置」，
     打开控制台时给可执行的错误而不是空白页。
2. 连接码输入。
3. 「配对并连接」。

支持三种输入：

- 纯码：`XXXXX-XXXXX`
- 完整链接：`https://host/#pair=CODE`
- 查询参数：`https://host/?pair=CODE`

配对流程：

```text
unconfigured
  └─ 输入连接码 → pairing
       ├─ 成功 → 写 connection.json → connect() → heartbeat
       └─ 失败 → 保留输入，显示 pairing_* 错误；不写 token
connected
  ├─ 心跳失败 / 被撤销 → error / 提示重新配对
  └─ 注销 → unconfigured（保留 gatewayUrl）
```

配置 `connection.json` 只有：

```json
{
  "gatewayUrl": "https://hub.example.com",
  "deviceToken": "enc:...",
  "deviceScopes": ["chat", "dispatch"],
  "deviceId": "b8235e0e-a459-4bad-95a2-5d0585a613fc",
  "dashboardUrl": "https://dash.example.com"
}
```

旧字段（`baseUrl` / `apiKey` / `adminKey` / `dashboardToken` / `dashboardUser` / `dashboardPassword` / 旧凭证字段）在 `config:get` 时按白名单清除。

### 3.3 会话与 SSE

- 主进程 `electron/cloud/client.ts` 负责 HTTPS + Bearer。
- `POST /v1/runs` 发起一轮；`GET /v1/runs/{id}/events` 订阅 SSE。
- `electron/cloud/map.ts` 把 SSE 映射为 parts：

| SSE | parts |
| --- | --- |
| `message.delta` | `text` 增量 |
| `message.interim` | `thinking` / 进度（`already_streamed` 去重） |
| `tool.started` | `tool` 开始 |
| `tool.completed` / `tool.failed` | `tool` 结束 / 失败 |
| `subagent.start` / `subagent.complete` | 子代理节点 |
| `approval.request` | `approval` 卡片 |
| `clarify.request` | `clarify` 卡片 |
| `run.completed` / `failed` / `cancelled` / `interrupted` | 终态；未闭合工具标失败 |

三条限制：

- 审批回执必须带 `request_id`（= `prompt_id`）+ `execution_generation`；不做批量批。
- 终止态是唯一真相；`message.interim` 不等于成功。
- SSE 必须不缓冲；Caddy `flush_interval -1`，插件加 `X-Accel-Buffering: no`。

### 3.4 审批闭环

- 审批卡三按钮：**一次 / 本会话 / 拒绝**；`always` 在映射层丢弃，永远不渲染。
- 默认拒绝；超时自动拒绝；通道缺失 / 回执失败一律按 fail-closed 呈现。
- 断流后靠 `GET /v1/runs/{id}` 的 `pending_controls` 补卡。
- 审计 `data/cloud-agent/audit.jsonl`：

```jsonc
// 决定
{ "at": 1793874832389, "kind": "approval", "auditId": "ap:...",
  "runId": "run_...", "command": "≤200 字摘要", "patternKeys": ["..."],
  "choice": "deny", "mode": "manual", "toolCallId": "call_..." }

// 真实结果
{ "at": 1793874833861, "kind": "approval_result", "auditId": "ap:...",
  "runId": "run_...", "error": true, "exitCode": -1, "preview": "BLOCKED: ..." }

// 档位变更
{ "at": ..., "kind": "mode", "from": "manual", "to": "off" }
```

- 审计只写命令摘要 + 命中规则，不写全文、不写密钥。
- 结果行按 `toolCallId` 与真实工具结果配对；空预览先挂住，收尾重拉历史后补。

### 3.5 配置面与审批档位

- 配置页用 `WebContentsView` 内嵌 dashboard；独立 partition、无 preload；用户手动登录。
- 这一层的可见性只由控制台页决定：`bounds.visible=false`（切页 / 卸载 / 窗口后台）时视图直接从窗口摘除；托盘唤回、通知点击、第二实例只恢复页面最后要求的状态，不得自行显示（否则会盖住当前页面）。
- 审批档位只用 Hermes 原生三档：`manual` / `smart` / `off`；不自造预设、不切工具集。
- 桌面端通过网关读写策略，不直连 dashboard：

```text
GET  /api/config        → 只返回白名单子集
PUT  /api/config        → 只接受 {"config":{"approvals":{"mode":...}}}
```

白名单子集：

```json
{
  "approvals": { "mode": "manual", "timeout": 300 },
  "agent": { "disabled_toolsets": ["code_execution"] },
  "terminal": { "backend": "local" },
  "policy": { "denyCount": 12 }
}
```

规则：

- 网关持有 dashboard 服务端凭据；设备 token 永远拿不到整份配置与密钥。
- `PUT` 只允许 `approvals.mode` 一个键；写后读回复核；变更写审计。
- 放宽档位（→ `off`）桌面端二次确认；收紧不确认。
- `deny` 只回条数，不回内容。

### 3.6 任务、媒体、耐久性

- 任务页：`/api/jobs` 列表 + 新建 + `run` / `pause` / `resume` + **编辑（`PATCH`）/ 删除（`DELETE`）**（插件 0.1.2 起放行；删除要过一次确认）。
  - 新建表单收「任务名 / 调度 / 提示词 / 最多跑几次（可选）」，调度支持间隔（`30m`、`every 2h`）、
    一次性（`in 30m`、ISO 时间）与 cron 表达式（`0 9 * * *`）。
  - cron 表达式与「每周一 9 点」这类自然语言写法要服务端装了 `croniter`（Hermes 声明为核心依赖，
    部分运行时未预装，缺的时候上游会直接报错）；纯间隔写法不需要它。
- 图片：上传走 `/api/chat/image-upload`，读回走 `/api/fs/read-data-url`，都经网关；渲染层不持凭据。
- 耐久性：`data/cloud-agent/active-run.json` 记**在跑的每一轮**（`{runs:[{runId,sessionId,startedAt}]}`，旧单条形状读取兼容）；重启 / 重连后逐条 `GET /v1/runs/{id}` 探活，还在跑就重订阅（`last_seq` 顶到 int32 上限只收新事件），先铺历史再放增量。
- 并行：不同会话可以同时各跑一轮（上限 2，与网关 SSE 并发一致）。帧带 `sessionId`（`CloudFrameOrigin`），渲染层按会话分账（`sessionRuns`）：别的会话的正文不写进当前时间线，但状态要记在它名下（会话行显示「有轮次在跑」）。同一会话内仍是一次一轮。
- 未结算账本：`data/cloud-agent/pending-writes.json`，只做人工核对，不是云端真相。
- 断线占位：时间线插一条显式断线标记；不把断线当成功。

### 3.7 设备身份与心跳

- `data/cloud-agent/device.json`：
  - `id`：首次启动生成，只读，随每轮 `author.id = pi-workbench/<uuid>` 发给云端。
  - `name`：系统友好名，只探测一次；用户可改，空串恢复默认。
- `author` **只做记忆归属，不注入 prompt**；模型需要识别设备时走后续工具能力，不靠 prompt。
- 心跳：30 秒一拍；90 秒无认证请求判离线；被撤销即停，并推 `cloud:gateway:revoked`。
- 注销：设备可自注销，只切断自己；撤销别的设备需要管理密钥或 `admin`。

### 3.8 落盘文件

| 文件 | 用途 |
| --- | --- |
| `data/cloud-agent/connection.json` | 网关地址、设备 token（`enc:`）、scope、deviceId、dashboardUrl |
| `data/cloud-agent/device.json` | 本机设备身份 |
| `data/cloud-agent/device-sessions.json` | 本机会话归属（UI 用，不是云端真相） |
| `data/cloud-agent/active-run.json` | 在跑的轮次（可多条），用于重启接回 |
| `data/cloud-agent/pending-writes.json` | 未结算对外写 |
| `data/cloud-agent/audit.jsonl` | 审批审计，追加 + fsync，永不改写 |

---

## 4. 配对与设备协议

### 4.1 生成连接码

```http
POST /v1/devices/pairing
X-Pi-Admin-Key: <管理密钥>
Content-Type: application/json

{}
```

成功 `201`：

```json
{
  "code": "ABCDE-FGHJK",
  "expiresAt": 1793938800,
  "pairingUrl": "https://hub.example.com/#pair=ABCDE-FGHJK"
}
```

- 只有服务器调用；管理密钥不出服务器。
- `expiresAt` 为 Unix 秒。
- `pairingUrl` 优先 `PI_HUB_PUBLIC_URL`；否则 `X-Forwarded-Proto` + `X-Forwarded-Host`；再否则请求 `Host`。
- 生成失败不返回部分结果。

### 4.2 消费连接码

```http
POST /v1/devices/pair
Content-Type: application/json

{
  "code": "ABCDE-FGHJK",
  "deviceId": "b8235e0e-a459-4bad-95a2-5d0585a613fc",
  "name": "TChen-Legion"
}
```

成功 `201`：

```json
{
  "token": "pi_...",
  "tokenPrefix": "pi_abcd",
  "deviceId": "b8235e0e-a459-4bad-95a2-5d0585a613fc",
  "name": "TChen-Legion",
  "scopes": ["chat", "dispatch"],
  "dashboardUrl": "https://dash.example.com"
}
```

规则：

- 不需要 header 凭据；码本身就是授权。
- 码 10 位 Crockford Base32，显示 `XXXXX-XXXXX`；服务端只存 `sha256(规范化码)`。
- TTL 600 秒；单次使用；`BEGIN IMMEDIATE` 事务内消费。
- 限流：`/pairing` 5 次/分/IP；`/pair` 10 次/分/IP；失败也计数。
- `scopes` 固定 `chat` + `dispatch`，**永远不返回 `admin`**；忽略客户端传的 scopes。
- 同一 `deviceId` 再配对 = 轮换 token，旧 token 立即失效。
- `dashboardUrl` 可选；能推导就返回；桌面端缺省按 `hub.` → `dash.` 派生。

### 4.3 设备侧

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/devices/me` | Device | 身份、scope、`lastSeenAt` / `online` / `onlineWindow` / `serverTime` |
| `POST` | `/v1/devices/me/heartbeat` | Device | 心跳；刷新 `last_seen_at` |
| `POST` | `/v1/devices/{id}/revoke` | Device 自身 / Admin | 自注销只切断自己；撤销别人要 Admin |
| `POST` | `/v1/devices/register` | Admin | 服务器 break-glass；桌面端不调用 |

`onlineWindow` 默认 90 秒。

### 4.4 错误形状

```json
{ "error": { "code": "pairing_expired", "message": "连接码已过期，请在服务器重新生成" } }
```

| code | HTTP | 场景 |
| --- | --- | --- |
| `unauthorized` | 401 | 没有 token / token 不存在 |
| `device_revoked` | 401 | token 已注销 |
| `scope_required` | 403 | scope 不足 |
| `admin_required` | 403 | 管理接口缺少管理密钥 |
| `invalid_params` | 400 | 字段缺失 / 格式错误 |
| `pairing_not_found` | 404 | 码不存在 |
| `pairing_expired` | 410 | 码过期 |
| `pairing_used` | 409 | 码已使用 |
| `pairing_disabled` | 503 | 未配置管理密钥 / 配对关闭 |
| `rate_limited` | 429 | 限流，带 `Retry-After` |
| `path_not_allowed` | 403 | 媒体路径越权 |
| `payload_too_large` | 413 | 请求体过大 |
| `upstream_unavailable` | 502 | api_server 不可用 |
| `upstream_timeout` | 504 | api_server 超时 |
| `not_found` | 404 | 未知路由 / 不在代理白名单 |
| `internal` | 500 | 未预期异常 |

### 4.5 安全参数

| 项 | 值 |
| --- | --- |
| 码熵 | 10 位 Crockford Base32，约 50 bit |
| TTL | 600 秒 |
| 使用次数 | 1 次，事务内消费 |
| 存储 | `sha256(规范化码)`，不存明文 |
| 设备 token | `pi_<base64url(32B)>`；服务端只存 hash + 前缀 |
| scope | `chat` / `dispatch`；`admin` 单独签发，桌面端永远没有 |
| 传输 | HTTPS；loopback 例外 |
| 日志 | 永不记录 code / token / Authorization / 管理密钥 |

---

## 5. 网关插件

### 5.1 仓库与硬约束

```text
仓库：pi-workbench-gateway
物理位置：应用仓库工作区内嵌套的独立 git 仓库 `pi-workbench-gateway/`
         （主仓库 `.gitignore` 排除，不是 submodule；应用侧只依赖 `PLUGIN_REPO` 常量）
插件 id：pi-workbench-gateway
类型：Hermes kind: platform
版本：0.1.2
```

目录：

```text
pi-workbench-gateway/
  plugin.yaml
  __init__.py              # register(ctx) → shim
  shim.py                  # 唯一接触 Hermes 插件 API
  adapter.py               # connect / disconnect
  config.py                # 唯一读取环境变量
  hub/                     # 纯 stdlib，不知道 Hermes 存在
    server.py              # ThreadingHTTPServer + 生命周期
    router.py
    routes/{health,pairing,devices,proxy,policy}.py
    db.py
    auth.py
    pairing.py
    ratelimit.py
    audit.py
    errors.py
    upstream.py
    fsguard.py
  tests/
  .github/workflows/ci.yml
  README.md
  LICENSE
```

硬约束：

- 只有 `shim.py` / `adapter.py` 接触 Hermes 插件 API。
- 只有 `config.py` 读 `os.environ`。
- 只用 Python 标准库：`http.server`、`http.client`、`sqlite3`、`threading`、`secrets`。
- 不引入 FastAPI / aiohttp / uvicorn。
- 服务跑在 daemon 线程；插件异常不能打穿 gateway 主进程。
- SQLite：WAL、`busy_timeout=5000`、每线程独立连接、事务写。
- 不 `import hermes` 内部模块；上游只走 loopback HTTP。

### 5.2 `plugin.yaml`

```yaml
name: pi-workbench-gateway
label: Pi Workbench Gateway
kind: platform
version: 0.1.2
manifest_version: 2
api_version: 1
author: Pi Workbench
license: MIT
description: The only entry between Pi Workbench and this Hermes profile.
requires_hermes: ">=0.22.6"
python_dependencies: []

requires_env:
  - name: PI_HUB_ADMIN_KEY
    description: "Admin key for pairing codes and device management"
    prompt: "Pi Workbench gateway admin key"
    password: true
    secret: true

optional_env:
  - name: PI_HUB_PUBLIC_URL
    description: "Public gateway URL, e.g. https://hub.example.com"
    prompt: "Public gateway URL"
    password: false
  - name: PI_HUB_PUBLIC_DASHBOARD_URL
    description: "Public dashboard URL (default: derived from PI_HUB_PUBLIC_URL)"
    prompt: "Public dashboard URL"
    password: false
  - name: HERMES_API_BASE
    description: "Local api_server base URL (default http://127.0.0.1:8642)"
    prompt: "Hermes api_server base URL"
    password: false
  - name: PI_HUB_DASHBOARD_BASE
    description: "Local dashboard base URL (default http://127.0.0.1:9119)"
    prompt: "Hermes dashboard base URL"
    password: false
  - name: PI_HUB_HOST
    description: "Bind host (default 127.0.0.1; keep loopback)"
    prompt: "Gateway bind host"
    password: false
  - name: PI_HUB_PORT
    description: "Listen port (default 8484)"
    prompt: "Gateway port"
    password: false
  - name: PI_HUB_RATE_LIMIT
    description: "Requests per minute per device (default 60)"
    prompt: "Gateway rate limit"
    password: false
  - name: PI_HUB_FS_ROOTS
    description: "Allowed media roots, ':'-separated"
    prompt: "Allowed media roots"
    password: false
```

- 不声明 `provides_tools`；当前 P0–P5 不做派活。
- `requires_hermes` 不设上界：上游补丁版本不应阻止安装。
- `API_SERVER_KEY` / `HERMES_DASHBOARD_SESSION_TOKEN` / `HERMES_HOME` 由 Hermes 或 systemd 提供，不进 manifest。
- `requires_env` 缺失时的行为已实测（0.22.6）：安装结束时会逐个交互提示，答案由 Hermes 写进
  `<profile>/.env`；进程环境或 `.env` 里已有的变量不再问。`requires_env` 声明成纯字符串时提示读 stdin
  （可管子进去），声明成 `{name, secret: true}` 则走遮罩输入、需要 TTY。源码位置与完整结论见插件仓库
  `docs/HERMES_PLUGIN_API.md` §5.1。

### 5.3 配置

| 变量 | 归属 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PI_HUB_ADMIN_KEY` | `<profile>/.env`（安装时 `requires_env` 提示写入），secret | — | 生成配对码 / 管理设备；缺失 = 配对关闭 |
| `PI_HUB_PUBLIC_URL` | `.env` / 插件 | 由请求推导 | 对外地址；自举时必填 |
| `PI_HUB_PUBLIC_DASHBOARD_URL` | 插件 | 从 public URL 推导 | 桌面端控制台地址 |
| `HERMES_API_BASE` | 插件 | `http://127.0.0.1:8642` | Hermes api_server |
| `PI_HUB_DASHBOARD_BASE` | 插件 | `http://127.0.0.1:9119` | dashboard 侧路 |
| `PI_HUB_HOST` | 插件 | `127.0.0.1` | 只监听 loopback |
| `PI_HUB_PORT` | 插件 | `8484` | |
| `PI_HUB_RATE_LIMIT` | 插件 | `60` | 每设备每分钟 |
| `PI_HUB_FS_ROOTS` | 插件 | profile upload/cache | 媒体白名单，**`os.pathsep` 分隔**（Linux `:` / Windows `;`）。不用 `:`：Windows 盘符自带冒号 |
| `API_SERVER_KEY` | Hermes/systemd | — | 转发 `/v1/*` |
| `HERMES_DASHBOARD_SESSION_TOKEN` | Hermes/systemd | — | 转发 `/api/config` / 图片 |

管理密钥处理：

- **落盘位置就是 `<profile>/.env`**：`hermes plugins install` 的 `requires_env` 提示直接写进去，
  和这台机器上的 `API_SERVER_KEY`、dashboard basic auth 同一处。没有理由再发明一套 drop-in 存放方式。
- gateway 启动时由 `hermes_cli/env_loader.load_hermes_dotenv` 把 `.env` 装进 `os.environ`，插件只读进程环境。
- 启动加载后从 `os.environ` 删除，缩小被子进程顺走的面积；**但这不是保密手段**——Hermes 的子进程会自己
  重载 `.env`。保密靠 `.env` 的文件权限与"永不回显、永不进日志"。
- 热重载（不重启服务）时密钥已被抹除，该次注册视为"未配置"；重启服务即可。
- 比较用常量时间；永不进日志。
- 威胁模型：管理密钥 ≈ 服务器管理员权限；能拿到它就等于能签发设备。

### 5.4 数据模型

SQLite 放 `plugin_data_dir('pi-workbench-gateway')`。

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  scopes        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER,
  rotated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash       TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  used_by_device  TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  device_id  TEXT,
  ip         TEXT,
  path       TEXT,
  status     INTEGER,
  detail     TEXT
);
```

- token / 码只存 `sha256`。
- 同 `deviceId` 再配对 = 更新 token + `rotated_at`，旧 token 立即失效。
- 配对码 `BEGIN IMMEDIATE` 消费。
- 启动清理过期码；运行中定期清理。
- 所有时间用 Unix 秒。
- 审计 SQLite + `audit-YYYYMMDD.jsonl` 双写；日志永不记录 code / token / Authorization。

### 5.5 本地路由

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/hub/health` | 无 | 网关活着就 200；**只回** `status` / `upstreamOk` / `hub` / `contractVersion` / `features` |
| `GET` | `/v1/hub/status` | Device 或 Admin | 完整诊断（设备计数、上游版本、dashboard 地址、运行时长） |
| `POST` | `/v1/devices/pairing` | Admin | 生成连接码 |
| `POST` | `/v1/devices/pair` | 无 | 消费连接码，签发 token |
| `GET` | `/v1/devices/me` | Device | 当前身份 |
| `POST` | `/v1/devices/me/heartbeat` | Device | 心跳 |
| `POST` | `/v1/devices/{id}/revoke` | Device 自身 / Admin | 注销 |
| `POST` | `/v1/devices/register` | Admin | break-glass |
| `GET` | `/api/config` | Device | 白名单策略子集 |
| `PUT` | `/api/config` | Device | 只写 `approvals.mode` |

`/v1/hub/health` 成功（**已瘦身**）：

```json
{
  "status": "ok",
  "upstreamOk": true,
  "hub": "0.1.2",
  "contractVersion": 1,
  "features": ["pairing", "heartbeat", "policy", "media"]
}
```

完整诊断在 `GET /v1/hub/status`（设备 token 或管理密钥）：

```json
{
  "status": "ok",
  "hub": "0.1.2",
  "contractVersion": 1,
  "features": ["pairing", "heartbeat", "policy", "media"],
  "upstream": "http://127.0.0.1:8642",
  "upstreamOk": true,
  "upstreamVersion": "0.22.6",
  "dashboard": "https://dash.example.com",
  "devices": { "total": 1, "active": 1, "revoked": 0 },
  "adminKeyConfigured": true,
  "pairingEnabled": true,
  "fsRoots": ["/srv/hermes/uploads"],
  "uptimeSeconds": 12,
  "serverTime": 1793874832
}
```

- 网关进程活着就返回 200；上游挂了用 `upstreamOk:false`，不要用 5xx 表示网关存活。
- `contractVersion` / `features` 供 Phase 3 握手；当前桌面端可忽略。
- **刻意偏离旧版**：旧插件把设备计数、上游版本、内部端口、运行时长全挂在匿名端点上，
  等于给公网扫描器免费送指纹。诊断一律要凭据（`/v1/hub/status`）。

### 5.6 认证

设备 token 处理顺序：

1. 取 `Authorization: Bearer pi_...`；没有 → `401 unauthorized`。
2. `sha256(token)` 查 `devices`；不存在 → `401 unauthorized`。
3. `revoked_at` 非空 → `401 device_revoked`。
4. 检查 scope；不足 → `403 scope_required`。
5. 更新 `last_seen_at`。
6. 注入 `X-Pi-Device: <deviceId>`。

管理密钥只用于：

- `POST /v1/devices/pairing`
- `POST /v1/devices/register`
- `POST /v1/devices/{id}/revoke`（撤销别的设备）

代理上游：

- 删除客户端 `Authorization`、`X-Pi-Admin-Key`、客户端 `X-Pi-Device`。
- 设置 `Authorization: Bearer <API_SERVER_KEY>`。
- 设置 `X-Pi-Device: <deviceId>`。
- `POST /v1/runs` 覆盖 `author` 为 `pi-workbench/<deviceId>`；幂等键加 `pi:<deviceId>:` 前缀。
- 保留方法、query、body、`Content-Type`；过滤 hop-by-hop header。
- 请求体上限 25MB。

### 5.7 代理白名单

**deny-by-default**：只代理下面列出的路径；其余 `/v1/*`、`/api/*` 返回 `404 not_found`，不做通用透传。

api_server：

```text
GET  /v1/capabilities
GET  /health/detailed
GET  /v1/toolsets
GET  /v1/skills
GET  /v1/models
POST /v1/runs
GET  /v1/runs/{id}
GET  /v1/runs/{id}/events        # SSE
POST /v1/runs/{id}/stop
POST /v1/runs/{id}/steer
POST /v1/runs/{id}/approval
POST /v1/runs/{id}/clarify
POST /v1/runs/{id}/resolve-unknown
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/{id}
PATCH /api/sessions/{id}
DELETE /api/sessions/{id}
GET  /api/sessions/{id}/messages
GET  /api/jobs
POST /api/jobs
GET  /api/jobs/{id}
POST /api/jobs/{id}/run
POST /api/jobs/{id}/pause
POST /api/jobs/{id}/resume
```

dashboard 侧路：

| 方法 | 路径 | 处理 |
| --- | --- | --- |
| `GET` | `/api/config` | 只回白名单子集，绝不回整份配置 |
| `PUT` | `/api/config` | 只接受 `approvals.mode` 最小 patch，写后读回复核 |
| `POST` | `/api/chat/image-upload` | 透传，沿用上游大小上限 |
| `GET` | `/api/fs/read-data-url` | `fsguard` 白名单 + `realpath` |

`/api/fs/read-data-url`：

- `realpath` 解析。
- 只允许 `PI_HUB_FS_ROOTS` 下文件。
- 拒绝符号链接逃逸、路径穿越。
- 失败 `403 path_not_allowed`。

### 5.8 SSE

- 不设置 `Content-Length`。
- 每个 chunk 立即 flush。
- 透传 `Last-Event-ID`。
- 响应头 `X-Accel-Buffering: no`。
- `Accept-Encoding: identity`，不压缩。
- 上游断开 / 客户端断开都要正确收尾。
- Caddy `flush_interval -1`。
- SSE 并发上限 2 / 设备；空闲超时 15 分钟。

### 5.9 限流

- 设备 token：默认 60 次/分钟。
- `/pairing`：5 次/分钟/IP。
- `/pair`：10 次/分钟/IP。
- 健康检查不计入。
- 超限 `429 rate_limited` + `Retry-After`。
- Caddy 后取真实 IP：只信本机反代传入的 `X-Forwarded-For` 最后一跳。

### 5.10 审计

事件：

```text
pairing.created
pairing.consumed
pairing.failed
device.registered
device.rotated
device.revoked
auth.failed
config.read
config.write
proxy.completed
proxy.upstream_error
```

每条只记录：时间、事件、`deviceId`、IP、路径、状态码、结果类别。

**永不记录**：code、token、Authorization、请求正文、管理密钥、配置密钥。

落盘：

- SQLite `audit_events`
- `audit-YYYYMMDD.jsonl`
- 日志轮转 / 清理策略在 P4 定稿。

---

## 6. 权限与安全

单用户前提；Hermes 拿整机权限（含 sudo），所以**不防 agent 提权**，只防三件事：

1. **防误操作**：危险动作要人点一下。
2. **防外泄**：密钥不进日志、上下文、公网。
3. **防公网扫描打进控制面**。

| 编号 | 边界 | 落地 |
| --- | --- | --- |
| S-01 | 云端 Agent 在独立 VPS；本地只走协议 | 控制面 loopback + TLS 反代 + 设备 token；安全组只开 443；SSH 只做运维 |
| S-02 | 云端零本地授权 | 云端只能发请求；本地动作必须由本地按白名单 + 档位 + 逐次审批授予；当前 P0–P5 不做派活 |
| S-03 | 凭据不进模型上下文 / 日志 | 设备 token 主进程 safeStorage；管理密钥 systemd；dashboard 凭据只在网关；输出 redactor |
| S-04 | 不可逆操作必须人工批准 | 容器后端与审批互斥，不用；`execute_code` 禁用；`write_file` / `patch` 无审批路径，接受并写进 UI；回执必须带 `request_id` + `execution_generation` |
| S-05 | 审批 fail-closed | 超时 / 通道缺失 / 回执异常一律拒绝，不自动重试 |
| S-08 | 控制台不得成为提权通道 | 不提供 `always`；配置写只允许 `approvals.mode` |
| S-09 | 关键配置变更可发现 | 记录 `approvals.mode` 变更；策略版本化 / 漂移告警后置 |
| S-10 | 遥测默认关闭 | 不装遥测；复核第三方 MCP 出网 |
| S-11 | 审批策略可回滚 | 当前只保证「档位显示 = 服务端真值」；完整版本化 / diff / 一键还原后置 |
| S-12 | 两个暴露面分开治理 | `hub.` = 设备 token + 限流；`dash.` = dashboard 认证 + 建议 IP 白名单 |
| S-13 | 密钥轮换 | `API_SERVER_KEY` / dashboard 凭据可轮换；轮换留审计 |
| S-14 | 硬边界只能在主机外 | 云安全组、快照 + 自动备份、provider 额度告警 |
| S-15 | deny 清单覆盖系统级 | 若启用 `approvals.deny`，至少覆盖 `sudo` / `systemctl` / `crontab` / `authorized_keys` / `iptables` / `ufw` / `useradd` / `chmod 777` |

已知弱点（写进 UI，不假装没有）：

- 纯 `sudo <cmd>` 不在 Hermes 危险模式表里，不会弹审批。
- `write_file` / `patch` 没有审批路径；整机权限下可改自己的配置。
- 没有消费上限 / 预算熔断。
- `approvals.deny` 当前保持 Hermes 默认空；是否启用系统级 deny 清单是运维决策。

---

## 7. 部署与自举

### 7.1 拓扑

```text
腾讯云 VPS
├── systemd hermes-gateway     127.0.0.1:8642  api_server
├── systemd hermes-dashboard   127.0.0.1:9119  dashboard（P4 起必须常驻）
├── systemd caddy              0.0.0.0:443      TLS
└── sshd :22                   运维专用

hub.<domain>  → 127.0.0.1:8484  网关插件
dash.<domain> → 127.0.0.1:9119  控制台，直连
api.<domain>  → 可选，仅旧客户端需要；桌面端不需要公网 API
```

**gateway 进程形态（0.23 起）——现状：仍用 per-profile 单元，暂不迁**

上游把「一个 profile 一个 gateway 进程」标成不再支持的拓扑，改成**一个 default gateway 多路复用所有
profile**（`gateway.multiplex_profiles` 默认开，`false` 已退休，`hermes gateway migrate --multiplex` 执行，
**无 rollback 命令**）。2026-11-08 在本机实迁了一次并**回滚**（见 §8.4「gateway 多路复用迁移实测」）：迁完插件本身能加载
（`hub.db` 的 inode 与设备表都没变，`plugin_data_dir()` 按当前 profile 解析），但**两处 per-profile 的东西
不跟着进宿主进程**，云端 Agent 直接不可用：

| 断点 | 表现 | 根因 |
| --- | --- | --- |
| profile 的 `.env` 不注入宿主 gateway | `PI_HUB_ADMIN_KEY is not set`（配对/设备管理全禁用）、`API_SERVER_KEY` 缺失（代理 `/v1/*` 全 401） | 密钥按 profile 放在 `<profile>/.env`，多路复用进程只读宿主 `~/.hermes/.env` |
| profile 的 api_server 不再启动 | `8642` 不监听，`/v1/hub/health` → `upstreamOk:false`，跑不了任何轮次 | `API_SERVER_*` 来自 `hermes-gateway-<profile>.service` 的 drop-in `10-api-server.conf`，宿主单元没有 |

所以结论是**等上游补齐（或我们评估把密钥移到宿主 `.env` 的安全代价）之前不迁**；`hermes update` 收尾
提议迁移时一律拒绝（拒绝即什么都不改）。回滚配方与实测数据见 §7.5、§8.4。

另外记一条与本插件相关、与迁移无关的约束：**端口是全局的**（默认 `8484`）。如果多个 profile 都装了本
插件，后启动的那个会降级成「未连接」（`server.py` 抛 `OSError`，adapter 吞掉，不打穿 gateway）。所以本
插件只装在一个 profile，或给每个 profile 配不同 `PI_HUB_PORT`。

### 7.2 Caddy

```caddy
hub.example.com {
  reverse_proxy 127.0.0.1:8484 {
    flush_interval -1
  }
}

dash.example.com {
  reverse_proxy 127.0.0.1:9119 {
    transport http { read_timeout 300s }
  }
}
```

- 证书优先 DNS-01，不依赖 80 入站。
- 公网 HTTP 不允许；TLS 是设备 token 的底线。
- 没有自有域名时可用 Tailscale / DDNS / SSH 隧道，但不是默认引导路径。

### 7.3 环境变量落在哪

Hermes 的官方约定是 `<profile>/.env`（`hermes plugins install` 的 `requires_env` 提示直接写进去），
gateway 启动时把 `.env` 装载进 `os.environ`。所以：

- **密钥**（`PI_HUB_ADMIN_KEY`）只进 `.env`；不要写 `config.yaml`、shell history、日志。
- **非密钥配置**（`PI_HUB_PUBLIC_URL` / `PI_HUB_PUBLIC_DASHBOARD_URL` / `HERMES_API_BASE` /
  `PI_HUB_PORT` 等）写 `.env` 或 systemd drop-in 都行，**二选一，别两处都放**（两处不一致时排查成本极高）。
- dashboard 凭据由 Hermes 提供；网关只读。
- 插件加载后从 `os.environ` 删除管理密钥（见 §5.3）。

### 7.4 自举 Prompt

[hermes-bootstrap-prompt.md](./hermes-bootstrap-prompt.md) 是运行期资产，应用连接页「复制自举 Prompt」直接内联。

目标流程（Phase 3 完成）：

1. 判断现状：hub / dash / 插件 / 管理密钥 / 端口。
2. 必要时配置域名、Caddy、TLS。
3. 安装 `pi-workbench-gateway`（仓库地址由 `{{PLUGIN_REPO}}` 注入，不钉版本）。
4. 配置 `PI_HUB_ADMIN_KEY`、`PI_HUB_PUBLIC_URL`、`PI_HUB_PUBLIC_DASHBOARD_URL`。
5. 启用插件并验证 health / 401 / dashboard。
6. 调 `/v1/devices/pairing` 生成连接码，返回 `pairingUrl` 和操作提示；**不再写凭证文件、不再 scp**。

### 7.5 回滚

- **0.23.0 起**：`hermes update` 收尾会提议把 per-profile gateway 迁到「default gateway 多路复用多 profile」，需要 root；拒绝即**什么都没改**（2026-11-08 实测）。
- **迁移实测与回滚（2026-11-08）**：`hermes gateway migrate --dry-run` 预检**无 blocker**，`--multiplex -y` 执行成功（default 单元 `hermes-gateway.service` 起，`hermes gateway list` 显示 `pi-cloud — served by the default multiplexer`），但如 §7.1 所述密钥与 api_server 两处断点，云端 Agent 不可用 → 当场回滚。回滚步骤（实测有效，约 1 分钟）：
  1. `sudo hermes gateway uninstall --system`（停并删 default 单元）
  2. 从 `/home/ubuntu/.hermes/config.yaml` 删掉 `gateway.multiplex_profiles: true`（改前备份 `config.yaml.bak-premultiplex`）
  3. `sudo hermes -p pi-cloud gateway install --force --system --start-now` —— **`--force` 不能省**：不加会被拒并提示「default multiplexer already serves this profile」/ `gateway.standalone: true` 的临时兼容路径
  4. 验证：`8484 / 8642 / 9119` 三个端口都在、`/v1/hub/health` → `upstreamOk:true`、设备表与 `hub.db` inode 不变
  - 注意 `hermes gateway uninstall` 只删 default 单元；`hermes-gateway-pi-cloud.service` 与其 drop-in `10-api-server.conf` 在迁移时被删掉了，必须靠第 3 步重装才回来（重装会重建默认的 `API_SERVER_*`）；若当初 drop-in 里有自定义项，从 `/root/hermes-pi-cloud-<stamp>.tgz` 里取回。
- **装完 / 改完插件后的重启**：`sudo systemctl restart hermes-gateway-pi-cloud.service`。**不要**用 `sudo hermes -p pi-cloud gateway restart --system`：root 跑 hermes 会先「准备依赖环境」，发现 `<hermes 安装目录>` 属主是 ubuntu 后拒绝（`owned by uid 1000, not the current uid 0`），命令退出、服务仍是旧代码——2026-11-08 升 0.1.2 时就踩到过（`/v1/hub/health` 一直回 `hub:0.1.1`）。
- 插件目录属主：CLI 用 root 跑过 `plugins update` 会把 `plugins/` 变成 root 所有，之后 ubuntu 身份再跑就会 `Permission denied`（`.install-metadata.json` / `plugin-update-locks/`）。修法：`sudo chown -R ubuntu:ubuntu <profile>/plugins`，然后用**服务同一个用户**跑 CLI。
- 插件坏了：修插件或降级；停用插件 = 云端功能整体不可用，明确报错。
- 代码里没有本地直连回退；这是刻意选择。
- VPS 改动前备份 `config.yaml` / `.env` / `plugins/` / `plugin-data/`；回滚按备份恢复。

---

## 8. 测试与验收

### 8.1 测试层

| 层 | 内容 |
| --- | --- |
| 插件单元 | 配置默认值、码生成、规范化、哈希、消费、过期、重放、并发、token 轮换、撤销、限流、审计脱敏、fsguard |
| 插件集成 | 假 api_server / dashboard：方法、query、body、鉴权头替换、SSE 分块、错误映射、大请求体、路径穿越 |
| 契约 | 配对、me、heartbeat、revoke、health、capabilities、sessions、runs + SSE |
| 桌面端 | `tests/cloud-*.test.ts`；全量 153 文件 / 1856 用例 |

命令：

```bash
# 插件
python -m unittest discover -s tests -t . -v
hermes plugins validate .
hermes doctor . --ci

# 应用
npm run type-check
npm test
npm run lint
npm run build
```

本机没有 `hermes` 可执行文件；`plugins validate` / `doctor` 需要 VPS 或 Hermes 环境。

### 8.2 Gate

**G0（插件骨架 + 只读代理）**：

```bash
curl -s https://hub.example.com/v1/hub/health
curl -s -o /dev/null -w '%{http_code}' https://hub.example.com/v1/capabilities          # 401
curl -s -H "Authorization: Bearer pi_<token>" https://hub.example.com/v1/capabilities    # 200
curl -s -X POST -H "X-Pi-Admin-Key: <key>" https://hub.example.com/v1/devices/<id>/revoke
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer pi_<token>" https://hub.example.com/v1/capabilities  # 401 device_revoked
```

**G1（桌面端真实联调）**：

- 生成连接码 → 粘贴 → 配对成功 → 心跳正常。
- 对话 / 工具卡 / 审批 / 插话 / 停止 / 跨重启接回 / 会话管理 / 任务页 / 图片 / 注销再配对。
- 停插件 → UI 说「网关不可用」；只停 Hermes → UI 说「Hermes 异常」。
- 审计能对上 `deviceId` / 路径 / 状态 / IP。

**G1 实测结果（2026-11-08，TChen-Legion）**：

| 项 | 结果 |
| --- | --- |
| 配对 / 心跳 / 注销再配对 | ✅ `device.revoked` → `pairing.consumed` → `device.registered`，心跳恢复 |
| 对话 + SSE 逐字 | ✅ `POST /v1/runs` 202 → `GET /events` 200，UI 逐字出字 |
| 工具卡 + 审批回执 | ✅ `POST /runs/<id>/approval` 200；`rm -rf` 真实执行（退出码 0） |
| 插话 steer | ✅ 中途「改成只数到 5」→ run 收尾 `output: 1..5` |
| 断网 / 上游挂着 | ✅ 停 Caddy →「连不上网关：连接被关闭（ERR_CONNECTION_CLOSED）」；上游指向死端口 →「网关在线，但云端的 Hermes 没有响应」+ 网关卡「已配对，但云端 Hermes 没响应」 |
| 审计 | ✅ 每条都带 `deviceId` / 路径 / 状态 / IP，无凭据泄漏 |
| 停止按钮 | ⬜ 未验（下次补） |

> 坑：`approvals.mode: manual` **不是**“每个工具都问”——Hermes 只看 `detect_dangerous_command()`（`rm -rf` / `dd of=/dev/*` / `kill -1` 这类），`seq`/`for` 这类安全命令直接放行。测审批要用会命中危险模式的命令，否则看不到卡。

### 8.3 验收清单

**配对**

| ID | 场景 | 期望 |
| --- | --- | --- |
| AC-P01 | 完整链接 | 自动填网关与码，配对成功 |
| AC-P02 | 纯码 + 默认网关 | 配对成功 |
| AC-P03 | 成功 | token 加密落盘、立即 connected、心跳开始 |
| AC-P04 | 过期 / 已用 / 不存在 | 对应提示，不落 token，保留输入 |
| AC-P05 | 同设备重新配对 | 旧 token 立即失效，新 token 可用 |
| AC-P06 | 桌面端检查 | 无管理密钥 / 旧凭证文件 / 控制台口令 |
| AC-P07 | 注销后重新配对 | 注销只清设备凭据，网关保留 |
| AC-P08 | 管理密钥边界 | 只在服务器；桌面端从未发送 |
| AC-P09 | 自举 Prompt | 输出连接码链接，不写文件、不 scp |
| AC-P10 | 旧凭证导入 | 无导入入口、无解析路径 |

> 网关插件的逐条验收就是 §8.2 的 G0（已在真机全绿）；插件自身的单测在 `pi-workbench-gateway/tests/`。

**桌面端云端功能**

| ID | 场景 | 状态 |
| --- | --- | --- |
| AC-01 | 冷启动列会话 | 已完成 |
| AC-02 | 发指令 + 流式 | 已完成；「停止」按决定不做真机验收 |
| AC-03 | 审批拒绝 | 已完成 |
| AC-04 | 审批超时自动拒绝 | 已完成 |
| AC-05 | CDP 屏幕 / 接管 | 后置 |
| AC-06 | 断线 / 重启状态一致 | 已完成 |
| AC-07 | 断线补齐 + attach | 已完成 |
| AC-08 | 会话 / 配置两页切换 | 已完成 |
| AC-09 | 幂等键 | 已完成 |
| AC-10 | 未结算账本核对 | 已完成 |
| AC-11 | 云端零本地文件能力 | 已完成 |
| AC-12 | 与工作区隔离 | 已完成 |
| AC-13 | 拆窗 | 后置 |
| AC-14 | Hermes 升级保留数据 | 已完成（2026-11-08，v0.22.6 → v0.23.0，见 §8.4） |
| AC-15 | 无遥测 / 出网复核 | 已完成（代码层清单 + 真机采样，见 §8.4） |
| AC-16 | 审批不被后端关闭 | 部分满足（纯 sudo 不问） |
| AC-17 | `execute_code` 禁用 | 已完成 |
| AC-18 | 策略可回滚 | 降级为「档位显示 = 真值」 |
| AC-19 | 反代穿透：SSE / WS / Host | 已完成：公网实测 200 / 401 / 404 / 拒绝 WS 升级 / 308 强制 TLS（§8.4），SSE 随 G1 验证 |
| AC-20 | surface 隔离 | 已完成 |
| AC-21 | 软限制被破坏可发现 | 后置 |
| AC-22 | 整机权限真能用 | 已完成 |

### 8.4 真机验收记录（AC-14 / AC-15 / AC-19 / gateway 迁移）

**AC-19 反代穿透（已完成：真机 + 用例双证）**

2026-11-08 从公网（`https://hub.tchen-xiaoxiao.com`）实测：

| 断言 | 实测 |
| --- | --- |
| `GET /v1/hub/health` | `200`，`{"status":"ok","hub":"0.1.2","upstreamOk":true,...}` |
| 无 token 访问 `/v1/capabilities` | `401`（G0 第一条） |
| 非白名单 `/api/secrets` | `404 not_found`（deny-by-default 穿过了 Caddy） |
| 带 `Upgrade: websocket` 请求 | `401`，**不是** `101` —— 反代没有把它当 WS 升级（桌面端只用 SSE） |
| 纯 HTTP 访问 | `308` → https（TLS 是底线） |

SSE 不缓冲已由 G1 逐字出字（§8.2）在真机证实。代码层：`hub/upstream.py` 的 `HOP_BY_HOP` 含 `upgrade`，`FORWARD_HEADERS` 是 allow-list；回归用例 `tests/test_proxy.py::ForwardingTests::test_websocket_upgrade_is_not_forwarded` 与 `test_host_header_is_rewritten_to_upstream`。

**AC-14 Hermes 升级保留数据**（2026-11-08 真机跑完：v0.22.6 → v0.23.0）

实测（profile `pi-cloud`，git 安装）：

| 项 | 升级前 | 升级后 |
| --- | --- | --- |
| Hermes | v0.22.6 `f0d9488` | v0.23.0 `2bd378e` |
| 插件 | `pi-workbench-gateway 0.1.1` enabled | 不变（0.1.2 之后再升，只加了任务编辑 / 删除的路由） |
| `hub.db` devices / revoked | 2 / 1 | 2 / 1 |
| pairing_codes / audit_events / schema | 13 / 187 / 1 | 13 / 187 / 1 |
| `audit-*.jsonl` | 11-07 / 11-08 两份 | 仍在，之后继续追加 |
| 端口 8484 / 8642 / 9119 | 在 | 在，服务全 `active` |
| 旧会话 | `run_8a987…` / `run_789b7c4…` | 仍可列出 |
| 空跑一轮 | — | `message.delta` → `run.completed`，`output: ok` |

**不需要重新配对**：设备行与 token hash 未变，插件/上游链路照常（验 auth 用的是临时配对的设备，避免轮换掉桌面端 token）。备份 `/root/hermes-pi-cloud-2026-11-08-1422.tgz`，回滚点 `f0d94882`。

复跑方法（再升级时用同一套）：要证明的是升级**不会弄丢设备库、管理密钥和云端会话**，升完不需要重新配对。先搞清两件事：`$HERMES_HOME`（profile 根）和一枚已配对设备 token。

```bash
TOKEN=<已配对设备的 token>
P="$HERMES_HOME"            # profile 根
D="$P/plugin-data/pi-workbench-gateway"   # 插件自己的数据目录（hub.db + audit-*.jsonl）

# ── 0. 基线：升级前这四条必须都是好的，否则本来就不该升 ──
hermes --version
hermes --profile <profile> plugins list               # pi-workbench-gateway 在且 enabled
ls -l "$D"                                           # hub.db + audit-YYYYMMDD.jsonl
sqlite3 "$D/hub.db" 'select count(*) from devices; select count(*) from pairing_codes;'
curl -s https://hub.<domain>/v1/hub/health
curl -s -H "Authorization: Bearer $TOKEN" https://hub.<domain>/v1/devices/me   # 记住 deviceId
curl -s -H "Authorization: Bearer $TOKEN" 'https://hub.<domain>/api/sessions?limit=3'
sudo tar czf /root/hermes-profile-$(date +%F).tgz "$P"   # 回滚就靠这个

# ── 1. 升级 Hermes（命令以官方发布说明为准），不要动 $P ──

# ── 2. 升级后逐项对照 ──
hermes --version                                     # 已升到新版本
hermes --profile <profile> plugins list               # 插件仍在且 enabled（没有被禁用/重装掉）
sqlite3 "$D/hub.db" 'select count(*) from devices; select count(*) from pairing_codes;'
curl -s https://hub.<domain>/v1/hub/health           # status: ok
curl -s -H "Authorization: Bearer $TOKEN" https://hub.<domain>/v1/devices/me   # 200，deviceId 与基线一致
curl -s -H "Authorization: Bearer $TOKEN" 'https://hub.<domain>/api/sessions?limit=3'   # 旧会话还在
ls -l "$D"                                           # 升级后跑一轮，audit 文件 mtime/大小在长
```

判定（五条全过才算过）：

1. 插件仍启用（`hermes plugins list`）。
2. 设备行没少（`devices` 计数不变），且旧 token 仍能 `200` —— **这是「不用重新配对」的硬证据**。
3. `GET /v1/devices/me` 的 `deviceId` 与升级前一致。
4. 旧云端会话能列出来，并且能接着发一句话收到流式回复。
5. 升级后新产生的审批仍写进 `audit-YYYYMMDD.jsonl`（追加没断）。

桌面端补一步：连接页自检四项全绿、打开一个旧会话、发一句话。**不需要重新配对**。

**gateway 多路复用迁移实测**（2026-11-08，执行后当场回滚）

要验的是上游 0.23 的新拓扑（`hermes gateway migrate --multiplex`）能不能承载云端 Agent。结论：**不能**，
按 §7.5 的配方回滚，回滚后逐项与迁移前对齐。

| 阶段 | 观测 |
| --- | --- |
| `migrate --dry-run` | plan = 停 pi-cloud 单元 + 装 default 单元；**无 blocker** |
| `migrate --multiplex -y` | 成功：`hermes gateway list` → `pi-cloud — served by the default multiplexer`，插件加载，`8484` 在听 |
| 插件数据 | `hub.db` inode `1184379` 不变，devices 2 / codes 11 / audit 185 不变 → **数据层不受影响** |
| 密钥 | 日志 `PI_HUB_ADMIN_KEY is not set` + `API_SERVER_KEY is not visible` → 配对禁用、代理全 401 |
| 上游 | `8642` 不监听（profile 的 drop-in `10-api-server.conf` 没跟过去）→ `/v1/hub/health` `upstreamOk:false` |
| 回滚 | `gateway uninstall --system` → 删 `multiplex_profiles` → `hermes -p pi-cloud gateway install --force --system --start-now` |
| 回滚后 | `8484/8642/9119` 三端口齐、`upstreamOk:true`、devices 2、`hub.db` inode 不变 |
| 端到端 | 临时设备配对 → `/v1/capabilities` 200 → `POST /v1/runs` → `message.delta "在线"` → `run.completed`；验完撤销设备并删除临时行 |

复跑前提（将来上游补齐后要再试时）：先用 `/root/hermes-pi-cloud-<stamp>.tgz` 备份，跑完必须核对
**四条**：`PI_HUB_ADMIN_KEY` 是否进了宿主进程、`API_SERVER_KEY` 是否可见、`8642` 是否在听、
`upstreamOk` 是否 `true`。任一条不成立就地回滚，别等用户发现云端不能发指令。

失败与回滚：

- 插件被禁用 / 重装掉 → `hermes plugins enable pi-workbench-gateway`；数据在 `$D`，重装插件不会清它。
- `PI_HUB_ADMIN_KEY` 丢失或被覆盖（升级时重问 `requires_env` 并填了新值）→ 设备 token 仍有效，但生成连接码 / 管理设备会 `pairing_disabled`；把 `$P/.env` 里的值恢复即可（它只影响管理面，不影响已配对设备）。
- `hub.db` 缺表 / 读不出 → 停插件、从 tar 备份恢复 `$D`，再启用。
- 不想在线上试：先在快照 / 克隆 VPS 上跑一遍，全过再上主环境。

**AC-15 无遥测 / 出网复核**（2026-11-08 真机跑完）

真机实测（VPS 上 `ss -tnp` 采样，含一轮真实对话期间）：

| 观察 | 结果 |
| --- | --- |
| 常驻对外连接 | 只有云厂商自带 agent（`tat_agent` → 169.254.0.138、`YDService` → 169.254.0.55），链路本地、非本应用 |
| 轮次进行中新增 | `hermes` → `3.173.21.63:443`，即 `config.yaml` 的 `https://api.deepseek.com`，**仅此一条** |
| 分析 / 遥测域名 | 零 |

代码层复核（同日）：

- 无埋点依赖：`dependencies` 只有 `@earendil-works/pi-coding-agent` / `electron-updater` / `node-pty` / `pdfjs-dist` / `pi-bridge` / `pi-web-access`；全仓 grep `analytics|telemetry|sentry|posthog|mixpanel|umami|gtag|bugsnag` 零命中。
- 主进程出网只有四类，且目标都由用户自己提供：`gatewayUrl`（`electron/cloud/*`）、供应商 `baseUrl`（`ipc/api-config.ts`）、GitHub 固定端点（设备码登录 / PR 状态，`github-auth.ts` / `git-worktrees.ts`）、更新 feed（`updater.ts`）。
- 联网搜索走 `pi-web-access`，供应商由用户在设置里选（`ipc/web-search-providers.ts` 十个），Key 本地加密。
- 网关插件只连 loopback：`hub/upstream.py` 只有 `HTTPConnection` / `HTTPSConnection` 到 `HERMES_API_BASE` / `PI_HUB_DASHBOARD_BASE`。

真机仍要跑一次（代码审无法证明运行时行为）：

```bash
# VPS：配对后、跑一轮、跑一次 jobs、联网搜索，各看一次
sudo ss -tnp state established | grep -v 127.0.0.1
# 桌面端：Windows 资源监视器 / macOS Little Snitch 抓 1 小时内所有出站连接
```

判定：除上表四类目标外没有其它出站连接（尤其没有分析类域名）——2026-11-08 已满足。

---

## 9. 路线与工作量

### 9.1 已完成

- 桌面端页面、连接、SSE、审批、dashboard、任务、媒体、耐久性、设备身份、心跳。
- 云端事件桌面通知：审批 / 澄清 / 终态（§3.9）。
- Phase 1 配对：连接码 UI / IPC / 配置收窄 / 测试。
- 文档收口：云端方案合并为本文。

### 9.2 Phase 2（P0–P5 已落地，2026-11-07 真机上线）

| 阶段 | 内容 | 工期 | Gate |
| --- | --- | --- | --- |
| **P0** | 新仓库、`plugin.yaml`、入口、配置、server 线程、`/v1/hub/health`、CI | 0.5 天 | 插件可安装 / 启用，health 200 |
| **P1** | SQLite、配对码、设备 token、轮换、限流、审计 | 1 天 | curl 生成 → 消费 → 重放失败 → 过期失败 |
| **P2** | Bearer、scope、`/me`、heartbeat、自注销 / 管理员注销、break-glass | 0.5 天 | token 200、无 token 401、撤销后 401 |
| **P3** | `/v1/*` 白名单代理、SSE、错误映射、请求体上限 | 1.5 天 | 真实对话流式正常 |
| **P4** | `/api/config` 白名单、图片、fsguard、审计完善、限流完善 | 1 天 | 档位可读可写；图片可读回；越权拒绝 |
| **P5** | 部署、Caddy、systemd、G0、README、版本 0.1.0 | 0.5–1 天 | 干净 VPS 按 README 部署成功；G0 全绿 |

合计约 **5–6 个工作日**。

### 9.3 Phase 3：应用侧联调

已随文档收口完成：

- `src/utils/hermesPrompt.ts` 的 `PLUGIN_REPO` 指向 `pi-workbench-gateway`（仓库发布后即可安装）。
- 自举 Prompt 改为新插件 + 一次性连接码，不写凭证文件。
- `PROJECT_STRUCTURE` / `paths-and-storage` / `AGENT-TESTING` 的云端段落改为指向本文。

验收已做（2026-11-08，结果见 §8.2）：配对 → 对话 → 审批 → 插话 → 注销 → 再配对 + 两种异常态文案，全部真实跑通。「停止按钮」「跨重启接回」按决定不单独立项验收。

已补：网关只回 `policy.denyCount`（不回 deny 内容），桌面端 `pickApprovalPolicy` 现在两种形态都认（网关的 `policy.denyCount` 优先，直连 dashboard 的 `approvals.deny` 兜底），否则过网关时永远显示 0 条。

### 9.4 后置

| 条目 | 内容 | 原因 |
| --- | --- | --- |
| C-08 | CDP 屏幕 / 接管 | 需要云上常驻浏览器，运维面另算 |
| C-09 | Kanban 投影 / clarify 建议卡片 | 依赖 C-08 |
| C-10 | 云端页面拆窗 | 依赖 C-09 |
| C-11 | IM 渠道 / 语音 / 出网遥测复核 | 一次性验收动作 |
| C-12 | 对外写 MCP 门 + write-ahead 账本 | 账本已有，门是另一个量级 |
| H3 | 工作区派活 / `local_*` 工具 / 任务邮箱 | 当前 P0–P5 明确不做；保留需求，后续单独立项 |

---

## 10. 关键决策摘要

原 ADR 已并入本节，不再单独维护。

| 决策 | 结论 |
| --- | --- |
| 后端 | Hermes Agent，MIT，跑在 VPS；不自研运行时、不 fork |
| 控制面 | api_server 的 `/v1/runs` + SSE；不用 OpenAI 兼容端；ACP 只作迁移路径 |
| 配置面 | 内嵌 dashboard，不重写 150+ 字段 |
| 传输 | 自有域名 + Caddy TLS；SSH 只做运维 |
| 终端 | `terminal.backend: local`；容器后端会关审批，不用 |
| 权限 | Hermes 整机权限 + 软限制；硬边界在云控制台（安全组 / 快照 / 额度） |
| 前端 | 两个独立页面，不复用 `ChatPanel` / `chatStore`；只对齐 parts 类型 |
| 单入口 | 自写 Hermes 插件；不做直连兜底；dashboard 唯一例外 |
| 设备身份 | `token → deviceId`；插件覆盖 `author`；审计带设备 |
| 配对 | 一次性连接码；管理密钥只在服务器；桌面端固定 `chat` + `dispatch` |
| 派活 | 目标单位是工作区，不是设备；当前 P0–P5 不做，保留为后续 |
| 预算 | 不做预算熔断 / 用量面板；只保留 provider 额度告警 |

---

## 11. 文件索引

### 桌面端

```text
electron/cloud/
  client.ts        HTTPS + Bearer + 错误码
  config.ts        connection.json 白名单 / cloudTransport
  gateway.ts       配对 / health / whoami / revoke
  events.ts        SSE 解析
  map.ts           SSE → parts
  runner.ts        run 生命周期 / pollControls / attach
  remote.ts        runs / sessions / jobs / approval / clarify
  policy.ts        /api/config 白名单读写
  audit.ts         audit.jsonl
  active-run.ts    重启接回
  ledger.ts        未结算账本
  media.ts         图片上传 / 读回
  device.ts        device.json / device-sessions.json
  heartbeat.ts     30s 心跳
  dashboard.ts     WebContentsView dashboard
  types.ts         数据模型（主进程副本；与 src/types/cloud.ts 一致，由 tests/cloud-types.test.ts 守）
  url.ts           纯函数地址工具：内置默认地址 / normalizeBaseUrl / deriveDashboardUrl

src/components/
  CloudWorkspaceView.tsx
  CloudSessionView.tsx
  CloudConnectionView.tsx
  CloudConsoleView.tsx
  CloudJobsView.tsx
  CloudApprovalCard.tsx
  CloudModeSwitch.tsx
  CloudTrace.tsx
  CloudToolCard.tsx
  CloudSubagentCard.tsx
  CloudClarifyCard.tsx
  CloudDiagnosticsPanel.tsx
  CloudLedgerDrawer.tsx

src/store/cloudStore.ts
src/api/cloud.ts
src/types/cloud.ts
src/types/electron.d.ts
```

### 插件（本工作区内的嵌套独立仓库）

物理位置 `pi-workbench-gateway/`，有自己的 `.git` / 远端 / CI；主仓库 `.gitignore` 排除它。

```text
pi-workbench-gateway/
  plugin.yaml
  __init__.py
  shim.py
  adapter.py
  config.py
  hub/
  tests/
```

### 文档

```text
docs/requirements/CLOUD_AGENT.md          # 本文，唯一方案
docs/requirements/hermes-bootstrap-prompt.md  # 运行期 Prompt
docs/guides/AGENT-TESTING.md              # 云端 G1 手测入口
docs/agent/paths-and-storage.md            # 落盘清单
docs/architecture/PROJECT_STRUCTURE.md     # 代码结构 / IPC
```

---

## 12. 变更记录

| 日期 | 变化 |
| --- | --- |
| 2026-11-08 | 实迁 0.23 的 gateway 多路复用（`--multiplex`）→ 密钥与 api_server 两处断点 → 按 §7.5 回滚并端到端复验；结论写进 §7.1 / §7.5 / §8.4：**上游补齐前不迁** |
| 2026-11-08 | 文档跟上 0.23 的 gateway 形态：单网关多路复用（§7.1）、迁移与回滚口径（§7.5）、复跑脚本的 `--profile`；自举 Prompt 同步（重启哪台按 `hermes gateway list` 判） |
| 2026-11-08 | 真机结项：AC-14（Hermes v0.22.6 → v0.23.0，设备库 / 配对码 / 审计 / 会话全保留，不用重新配对）、AC-15（运行时唯一对外连接是 `api.deepseek.com:443`，无分析域名）、AC-19（公网实测 200 / 401 / 404 / 拒 WS 升级 / 308 强制 TLS）全部通过 |
| 2026-11-08 | 云端事件接进桌面通知（§3.9）：`approval.request` / `clarify.request` / `run.completed` / `run.failed|interrupted` 各投递一条，按 `requestId` / `runId` 去重，点击切云端页并定位那张卡；文案与本地共用 `notificationCopy`，`app:notify-click` 载荷加 `cloud` / `requestId` |
| 2026-11-08 | AC-19 收口：插件补 WS 升级头不转发 / Host 改写两条回归用例；新增 §8.4 真机验收脚本（AC-14 / AC-15 当天跑完，见上） |
| 2026-11-08 | 插件 0.1.2：代理白名单放行 `PATCH` / `DELETE /api/jobs/{job_id}`（桌面任务页的编辑与删除），`docs/CONTRACT.md` 同步 |
| 2026-11-08 | 插件 0.1.1：代理白名单撤掉 `/api/sessions/{id}/fork`（桌面端不用），`/v1/hub/health` 的 `hub` 字段改为跟 `plugin.yaml` 取版本 |
| 2026-11-08 | 状态刷新：头部与 §0 对齐 0.8.0 现实（插件 0.1.1 真机上线、`hub.` 在线、真实配对可用、G0 / G1 全绿、测试基线 152 文件 / 1809 用例）；AC-19 标注 SSE 已验；待验收项集中到 §0 与 §8.3 |
| 2026-11-07 | 旧网关插件下线：停用 + 删除插件、环境变量与残留明文凭据（备份留在服务器 `/home/ubuntu/pi-hub-cleanup-*`），`hub.` 域名转为 502；插件改为本工作区内嵌套独立仓库从零开发 |
| 2026-11-07 | 新插件 P0–P4 落地（本地仓库 `pi-workbench-gateway/`）：health 瘦身 + `GET /v1/hub/status`、`PI_HUB_FS_ROOTS` 改 `os.pathsep`；桌面端 `cloud:gateway:status` 优先读 status、回退 health |
| 2026-11-07 | 文档校对：§11 文件索引补 `electron/cloud/types.ts` / `url.ts`；§3.2 写明内置默认网关与控制台地址及其副本位置 |
| 2026-11-07 | 云端方案收口：删除旧 ADR、旧需求、旧研究报告、旧迁移手册，合并为本文；桌面端 Phase 1 完成，Phase 2 未开工 |
| 2026-11-06 | 桌面端配对 Phase 1：连接码、`cloud:gateway:pair`、配置白名单、旧入口删除 |
| 2026-11-06 | 云端 Agent C-00–C-06 收口；C-07 跨重启 attach；审批三档与审计真机验收 |
| 2026-11-03 | v5：整机权限、双页面、删预算熔断；api_server 控制面 |
| 2026-11-03 | Hermes 后端选型、api_server 控制面、dashboard 配置面、单入口插件方向确定 |
