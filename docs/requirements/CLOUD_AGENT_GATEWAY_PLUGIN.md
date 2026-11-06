# 云端 Agent 网关插件开发方案（全新实现）

> **面向**：在新仓库 `pi-workbench-gateway` 里实现云端网关插件的人
> **什么时候读**：新建插件仓库、改设备身份 / 配对 / 反向代理 / 审计 / 部署之前
> **状态**：v1 · 2026-11-06 · **待开工**
> **前置契约**：[CLOUD_AGENT_PAIRING](./CLOUD_AGENT_PAIRING.md) §4（桌面端已按此实现）
> **应用侧现状**：桌面端 Phase 1 已完成，只认一次性连接码配对

---

## 0. 一句话

新建一个 Hermes `kind: platform` 插件 `pi-workbench-gateway`，作为桌面端连接云端 Hermes 的唯一入口：

```text
Desktop → Caddy (HTTPS) → gateway 127.0.0.1:8484 → Hermes api_server
                                      ├─ 配对 / 设备 token / scope / 限流 / 审计
                                      ├─ /v1/*、/api/* 反向代理（含 SSE）
                                      └─ /api/config、图片接口 → Hermes dashboard
```

**不重写 Hermes Agent。** 会话、轮次、审批、任务、模型、工具仍由 Hermes 提供；插件只负责安全入口与设备身份。

---

## 1. 设计前提

- 单用户、多设备：一个网关对应一个 Hermes profile
- 每台设备一个设备 token；服务端只存哈希
- 配对使用一次性连接码，管理密钥只留在服务器
- 域名 + Caddy HTTPS 为默认部署方式
- 插件只监听 loopback，公网入口由 Caddy 终止 TLS
- 桌面端通过 `https://hub.<domain>` 连接，不直连 Hermes 端口
- 不实现多租户、账号体系、计费
- 不实现 Hermes Agent 本身的 run / tool / approval 逻辑

---

## 2. 目标与非目标

### 2.1 目标

- 一次性连接码配对
- 设备 token 签发、轮换、撤销
- 设备 token 鉴权、scope、限流、审计
- `/v1/*`、`/api/*` 反向代理，SSE 不缓冲
- 控制台配置与图片接口受控转发
- 零第三方 Python 依赖
- 单进程内稳定运行，插件异常不拖死 Hermes gateway
- 支持 `PI_HUB_PUBLIC_URL`：域名、子域名、隧道、内网地址均可

### 2.2 非目标

- 多租户、账号体系、计费
- 重写 Hermes Agent
- 桌面端保存管理密钥
- 控制台 HTML 代理
- H3 任务邮箱 / `local_*` 派活能力
- 在插件内做 TLS
- 公网 HTTP

---

## 3. 新仓库

```text
仓库：pi-workbench-gateway
插件 id：pi-workbench-gateway
插件类型：Hermes kind: platform
版本：0.1.0
```

### 3.1 目录结构

```text
pi-workbench-gateway/
  plugin.yaml
  __init__.py              # register(ctx)，只转发到 shim
  shim.py                  # 唯一接触 Hermes 插件 API 的文件
  adapter.py               # 生命周期：connect 起服务，disconnect 停
  config.py                # 唯一读取环境变量处
  gateway/
    __init__.py
    server.py              # ThreadingHTTPServer + 生命周期
    router.py              # 路由表与匹配
    routes/
      __init__.py
      health.py
      pairing.py
      devices.py
      proxy.py
    db.py                  # SQLite schema / 事务
    auth.py                # 设备 token / 管理密钥 / scope
    pairing.py             # 码生成、规范化、哈希、消费
    ratelimit.py
    audit.py
    errors.py
    upstream.py            # api_server / dashboard 客户端
    fsguard.py             # 媒体路径白名单
  tests/
    __init__.py
    fake_upstream.py
    test_config.py
    test_db.py
    test_pairing.py
    test_devices.py
    test_auth.py
    test_proxy.py
    test_sse.py
    test_audit_redaction.py
  .github/workflows/ci.yml
  README.md
  LICENSE
```

### 3.2 硬约束

- `gateway/` 不 `import plugins` / `gateway`，不知道 Hermes 存在
- 只有 `shim.py` / `adapter.py` 接触 Hermes 插件 API
- 只有 `config.py` 读 `os.environ`
- 只用 Python 标准库：`http.server`、`http.client`、`sqlite3`、`threading`
- 不引入 FastAPI / aiohttp / uvicorn
- 服务器跑在 daemon 线程里；插件异常不能打穿 gateway 主进程
- 状态写 SQLite 使用事务；不直接覆盖文件
- SQLite 连接按线程隔离（每请求新连接或 thread-local），不共享 cursor；WAL + `busy_timeout=5000`

---

## 4. Hermes 插件接入

### 4.1 `plugin.yaml`

```yaml
name: pi-workbench-gateway
label: Pi Workbench Gateway
kind: platform
version: 0.1.0
manifest_version: 2
api_version: 1
author: Pi Workbench
license: MIT
description: The only entry between Pi Workbench and this Hermes profile.
requires_hermes: ">=0.22.6,<0.25"
python_dependencies: []

requires_env:
  - name: PI_HUB_ADMIN_KEY
    description: "Admin key for pairing codes and device management"
    prompt: "Pi Workbench gateway admin key"
    password: true
    secret: true

optional_env:
  - name: PI_HUB_PUBLIC_URL
    description: "Public gateway URL (default: derived from the request host)"
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

不声明 `capabilities`，不声明 `provides_tools`，因为只使用 `ctx.register_platform`。

`API_SERVER_KEY` / `HERMES_DASHBOARD_SESSION_TOKEN` / `HERMES_HOME` 由 Hermes 或 systemd 提供，不进 manifest。

### 4.2 入口

`__init__.py` 只做：

```python
from .shim import register
__all__ = ["register"]
```

`shim.py`：

- `_deps_ok()`：只探测 stdlib 是否可用，不安装任何东西
- `_data_dir()`：通过 `plugins.plugin_storage.plugin_data_dir(PLUGIN_ID)` 取数据目录
- `_make_adapter(platform_config)`：构造 adapter
- `register(ctx)`：调用 `ctx.register_platform(...)`

`adapter.py`：

- 继承 `BasePlatformAdapter`
- `connect()` 启动 `gateway.server`
- `disconnect()` 停止服务、关闭 SQLite 连接
- 顶层异常只记日志，不抛出到 Hermes 主循环

### 4.3 启动顺序

1. 读配置（缺管理密钥只禁用配对，不阻止启动）
2. 打开 SQLite、建表、清理过期码
3. 启动 HTTP 服务线程
4. health 可访问
5. 失败时记录明确日志，插件状态显示不可用

---

## 5. 配置

只有 `config.py` 读取环境变量。

| 变量 | 归属 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PI_HUB_ADMIN_KEY` | 插件，secret | — | 生成配对码 / 管理设备；缺失 = 配对关闭 |
| `PI_HUB_PUBLIC_URL` | 插件 | 由请求推导 | 对外地址，如 `https://hub.example.com` |
| `PI_HUB_PUBLIC_DASHBOARD_URL` | 插件 | 从 public URL 推导 | 桌面端打开的控制台地址 |
| `HERMES_API_BASE` | 插件 | `http://127.0.0.1:8642` | Hermes api_server |
| `PI_HUB_DASHBOARD_BASE` | 插件 | `http://127.0.0.1:9119` | 控制台侧路 |
| `PI_HUB_HOST` | 插件 | `127.0.0.1` | 只监听 loopback |
| `PI_HUB_PORT` | 插件 | `8484` | |
| `PI_HUB_RATE_LIMIT` | 插件 | `60` | 每设备每分钟 |
| `PI_HUB_FS_ROOTS` | 插件 | profile upload/cache | 媒体读回白名单，`:` 分隔 |
| `API_SERVER_KEY` | Hermes/systemd | — | 转发 `/v1/*` 时使用 |
| `HERMES_DASHBOARD_SESSION_TOKEN` | Hermes/systemd | — | 转发控制台侧路时使用 |

规则：

- 管理密钥只放 gateway 的 systemd drop-in，不写 `.env`
- 非法端口 / 非法 URL 降级为默认并打 WARNING，不阻止启动
- `PI_HUB_PUBLIC_URL` 必须是 `http(s)`；公网部署只接受 HTTPS
- `PI_HUB_HOST` 默认 loopback；不要直接监听 `0.0.0.0`

---

## 6. 数据模型

SQLite 放在 `plugin_data_dir('pi-workbench-gateway')` 下。

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
  scopes        TEXT NOT NULL,          -- JSON: ["chat","dispatch"]
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

设计点：

- token / 配对码只存 `sha256`
- 同一 `deviceId` 再配对 = 更新 token、`rotated_at`，旧 token 立即失效
- 配对码消费用 `BEGIN IMMEDIATE` 事务
- 启动时清理过期码；运行中定期清理
- 所有时间用 Unix 秒
- 审计 JSONL 与 SQLite 双写；日志永不记录 code / token / Authorization

---

## 7. HTTP 契约

### 7.1 本地实现

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/hub/health` | 无 | 版本、上游状态、设备计数、配对开关 |
| `POST` | `/v1/devices/pairing` | Admin | 生成一次性连接码 |
| `POST` | `/v1/devices/pair` | 无 | 消费连接码，签发设备 token |
| `GET` | `/v1/devices/me` | Device | 当前设备身份 |
| `POST` | `/v1/devices/me/heartbeat` | Device | 心跳 |
| `POST` | `/v1/devices/{id}/revoke` | Device 自身或 Admin | 注销 |
| `POST` | `/v1/devices/register` | Admin | 服务器 break-glass |

### 7.1.1 固定响应字段

`GET /v1/hub/health`：

```json
{
  "status": "ok",
  "hub": "0.1.0",
  "upstream": "http://127.0.0.1:8642",
  "upstreamOk": true,
  "upstreamVersion": "0.22.6",
  "dashboard": "https://dash.example.com",
  "devices": { "total": 1, "active": 1, "revoked": 0 },
  "adminKeyConfigured": true,
  "uptimeSeconds": 12
}
```

`GET /v1/devices/me`：

```json
{
  "deviceId": "b8235e0e-...",
  "name": "TChen-Legion",
  "scopes": ["chat", "dispatch"],
  "hub": "0.1.0",
  "lastSeenAt": 1793938800,
  "online": true,
  "onlineWindow": 90,
  "serverTime": 1793938800
}
```

`POST /v1/devices/me/heartbeat`：

```json
{
  "ok": true,
  "deviceId": "b8235e0e-...",
  "serverTime": 1793938800,
  "onlineWindow": 90
}
```

`onlineWindow` 建议 90 秒；桌面端按 `onlineWindow / 3` 调整心跳节奏。

### 7.2 代理到 Hermes api_server

桌面端实际使用的路径（以真实上游为准，用集成测试锁定）：

- `GET /v1/capabilities`
- `POST /v1/runs`
- `GET /v1/runs/{id}`
- `GET /v1/runs/{id}/events`（SSE）
- `POST /v1/runs/{id}/stop`
- `POST /v1/runs/{id}/steer`
- `POST /v1/runs/{id}/approval`
- `POST /v1/runs/{id}/clarify`
- `POST /v1/runs/{id}/resolve-unknown`
- `GET /health/detailed`
- `GET /v1/toolsets`
- `GET /v1/skills`
- `GET /v1/models`
- `GET /api/sessions*`
- `PATCH/DELETE /api/sessions/{id}`
- `GET /api/sessions/{id}/messages`
- `GET /api/jobs*`
- `POST /api/jobs/{id}/run|pause|resume`

其余 `/v1/*`、`/api/*` 默认代理，但必须先匹配本地路由与 dashboard 白名单。

### 7.3 控制台侧路

只允许明确路径：

| 方法 | 路径 | 目标 |
| --- | --- | --- |
| `GET` | `/api/config` | dashboard |
| `PUT` | `/api/config` | dashboard |
| `POST` | `/api/chat/image-upload` | dashboard |
| `GET` | `/api/fs/read-data-url` | dashboard + `fsguard` |

`/api/fs/read-data-url` 必须：

- `realpath` 解析
- 只允许 `PI_HUB_FS_ROOTS` 下的文件
- 拒绝符号链接逃逸、路径穿越
- 失败返回 `403 path_not_allowed`

### 7.4 错误形状

```json
{
  "error": {
    "code": "pairing_expired",
    "message": "连接码已过期，请在服务器重新生成"
  }
}
```

错误目录：

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
| `rate_limited` | 429 | 限流 |
| `path_not_allowed` | 403 | 媒体路径越权 |
| `payload_too_large` | 413 | 请求体过大 |
| `upstream_unavailable` | 502 | api_server 不可用 |
| `upstream_timeout` | 504 | api_server 超时 |
| `not_found` | 404 | 未知路由 |
| `internal` | 500 | 未预期异常 |

---

## 8. 配对协议

### 8.1 生成

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

规则：

- 只有服务器调用
- `pairingUrl` 优先用 `PI_HUB_PUBLIC_URL`，否则用 `X-Forwarded-Proto` + `X-Forwarded-Host`，再否则用请求 `Host`
- 码在 URL fragment，不进入访问日志
- 生成失败不能返回部分结果

### 8.2 消费

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

- 请求不带任何 header 凭据；码本身就是授权
- 码 10 位 Crockford Base32，显示 `XXXXX-XXXXX`
- TTL 600 秒
- 单次使用；`BEGIN IMMEDIATE` 事务消费
- 限流：`/pairing` 每 IP 5 次/分钟；`/pair` 每 IP 10 次/分钟
- `scopes` 固定 `chat` + `dispatch`，**永不返回 `admin`**
- 同 `deviceId` 再配对 = 轮换 token，旧 token 立即失效
- `dashboardUrl` 可选；插件能推导就返回

### 8.3 码生成

- 字符集：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`（去掉 `I` `L` `O` `U`）
- 10 位，`secrets.choice`
- 显示格式 `XXXXX-XXXXX`
- 规范化：大写、去空格 / 连字符
- 存储：`sha256(规范化码)`
- 不记录明文码

---

## 9. 认证与代理

### 9.1 设备 token

```http
Authorization: Bearer pi_...
```

处理顺序：

1. 取 token；没有 → `401 unauthorized`
2. 算 `sha256(token)`，查 `devices`
3. 不存在 → `401 unauthorized`
4. `revoked_at` 非空 → `401 device_revoked`
5. 检查 scope → `403 scope_required`
6. 更新 `last_seen_at`
7. 注入 `X-Pi-Device: <deviceId>`

### 9.2 管理密钥

只用于：

- `POST /v1/devices/pairing`
- `POST /v1/devices/register`
- `POST /v1/devices/{id}/revoke`（管理员撤销别的设备）

比较使用常量时间函数；不记录密钥。

### 9.3 上游请求

- 删除客户端 `Authorization`
- 删除 `X-Pi-Admin-Key`
- 删除客户端 `X-Pi-Device`
- 设置 `Authorization: Bearer <API_SERVER_KEY>`
- 设置 `X-Pi-Device: <deviceId>`
- 保留方法、query、body、`Content-Type`
- 过滤 hop-by-hop header
- 请求体上限 25MB

### 9.4 SSE

- 不设置 `Content-Length`
- 每个 chunk 立即 flush
- 透传 `Last-Event-ID`
- 响应头加 `X-Accel-Buffering: no`
- 上游断开 / 客户端断开都要正确收尾
- Caddy 必须 `flush_interval -1`

### 9.5 限流

- 设备 token：默认 60 次/分钟
- 配对生成 / 消费：独立 IP 桶
- 健康检查不计入
- 超限返回 `429 rate_limited` + `Retry-After`

---

## 10. 审计

记录事件：

- `pairing.created`
- `pairing.consumed`
- `pairing.failed`
- `device.registered`
- `device.rotated`
- `device.revoked`
- `auth.failed`
- `proxy.completed`
- `proxy.upstream_error`

每条只记录：

- 时间
- 事件
- `deviceId`
- IP
- 路径
- 状态码
- 结果类别

**永不记录**：code、token、Authorization、请求正文、管理密钥。

落盘：

- SQLite `audit_events`
- `audit-YYYYMMDD.jsonl`

---

## 11. 域名与 TLS

每个用户各自部署自己的网关。域名按网关部署配置，不按人配置。

### 11.1 默认方案：域名 + Caddy

```text
DNS: hub.example.com → VPS IP
Caddy: hub.example.com → 127.0.0.1:8484
```

Caddyfile：

```caddy
hub.example.com {
  reverse_proxy 127.0.0.1:8484 {
    flush_interval -1
  }
}
```

systemd drop-in：

```ini
Environment=PI_HUB_ADMIN_KEY=...
Environment=PI_HUB_PUBLIC_URL=https://hub.example.com
Environment=PI_HUB_PUBLIC_DASHBOARD_URL=https://dash.example.com
Environment=HERMES_API_BASE=http://127.0.0.1:8642
Environment=PI_HUB_DASHBOARD_BASE=http://127.0.0.1:9119
Environment=PI_HUB_PORT=8484
Environment=PI_HUB_HOST=127.0.0.1
```

插件不做 TLS，不监听公网端口。

### 11.2 无自有域名

仍然支持，但不是默认引导路径：

- Tailscale：`https://vps.tailnet.ts.net`
- 免费 DDNS 子域名 + Caddy
- SSH 隧道到 `http://127.0.0.1:8484`

公网 HTTP 不允许；TLS 是设备 token 的底线。

---

## 12. 开发阶段

### P0：仓库与骨架（0.5 天）

- 新仓库、`plugin.yaml`、`__init__.py`、`shim.py`、`adapter.py`
- 配置读取与校验
- 服务器线程启动 / 停止
- `/v1/hub/health`
- CI：Python 3.11 + `python -m unittest discover -s tests -t .`
- `hermes plugins validate .`（CI 未装 Hermes 时作为本地门槛）

**Gate**：插件可安装、可启用、health 返回 200。

### P1：数据库与配对（1 天）

- SQLite schema / 迁移
- 设备表、配对码表、审计表
- 生成码、消费码、过期 / 重放 / 并发
- 设备 token 签发与轮换
- 限流
- 配对审计

**Gate**：`curl` 生成 → 消费 → 重放失败 → 过期失败；单测全绿。

### P2：设备认证与路由（0.5 天）

- `Bearer` 解析、token 哈希查找
- `device_revoked` / `unauthorized` / `scope_required`
- `/v1/devices/me`
- `/heartbeat`
- 自注销 / 管理员注销
- `/register` break-glass

**Gate**：token 200、无 token 401、撤销后 401 `device_revoked`。

### P3：代理与 SSE（1.5 天）

- `/v1/*`、`/api/*` 代理
- 上游鉴权重写
- SSE 流式转发
- 错误映射
- 请求体上限
- 客户端断开处理

**Gate**：真实 Hermes 下对话流式正常；`/v1/capabilities` 200；无 token 401。

### P4：控制台侧路与媒体（1 天）

- `/api/config` GET/PUT
- 图片上传 / 读回
- `fsguard` 路径白名单
- 审计完善
- 限流完善
- 日志脱敏检查

**Gate**：审批档位可读可写；图片可上传读回；越权路径被拒绝。

### P5：部署与 G0（0.5–1 天）

- README / Caddy / systemd 说明
- 安装与更新流程
- G0 冒烟脚本
- 新仓库地址写回应用侧 `PLUGIN_REPO`
- `plugin.yaml` 版本 `0.1.0`

**Gate**：干净 VPS 按 README 部署成功；G0 全绿。

### 总工作量

约 **5–6 个工作日**。

---

## 13. 测试计划

### 13.1 单元

- 配置默认值 / 非法值降级
- 码生成字符集、长度、TTL
- 码规范化
- 码哈希、消费事务、并发消费
- 过期 / 已使用 / 不存在
- token 哈希、轮换、撤销
- 限流
- 审计脱敏
- 路径白名单

### 13.2 集成

`tests/fake_upstream.py` 起假 api_server / dashboard：

- 代理方法、query、body
- 上游鉴权头替换
- 客户端 `Authorization` 不泄漏
- SSE 分块到达
- 上游 401 / 500 映射
- 大请求体拒绝
- 控制台侧路只走白名单
- 媒体路径穿越拒绝

### 13.3 契约

按桌面端实际请求模拟：

- `POST /v1/devices/pairing`
- `POST /v1/devices/pair`
- `GET /v1/devices/me`
- `POST /v1/devices/me/heartbeat`
- `POST /v1/devices/{id}/revoke`
- `GET /v1/hub/health`
- `GET /v1/capabilities`
- `GET /api/sessions`
- `POST /v1/runs` + `GET /v1/runs/{id}/events`

### 13.4 命令

```bash
python -m unittest discover -s tests -t . -v
hermes plugins validate .
hermes doctor . --ci
```

---

## 14. 验收标准

| ID | 场景 | 期望 |
| --- | --- | --- |
| AC-GW01 | 健康检查 | `GET /v1/hub/health` 200，`upstreamOk` 正确 |
| AC-GW02 | 生成配对码 | 管理密钥 201，返回 `code` / `expiresAt` / `pairingUrl` |
| AC-GW03 | 消费配对码 | 无凭据 201，返回 token + scopes，无 `admin` |
| AC-GW04 | 重放 | 第二次 `409 pairing_used` |
| AC-GW05 | 过期 | `410 pairing_expired` |
| AC-GW06 | 不存在 | `404 pairing_not_found` |
| AC-GW07 | 无 token 代理 | `401 unauthorized` |
| AC-GW08 | 撤销后 | `401 device_revoked` |
| AC-GW09 | 设备自注销 | 只允许自己的 id；成功后 token 立即失效 |
| AC-GW10 | 同设备重配对 | 旧 token 失效，新 token 可用 |
| AC-GW11 | SSE | 桌面端能流式收到文本 / 工具事件 |
| AC-GW12 | 审批档位 | `GET/PUT /api/config` 可读可写 |
| AC-GW13 | 图片 | 上传 / 读回可用；越权路径拒绝 |
| AC-GW14 | 日志 | 不含 code / token / Authorization |
| AC-GW15 | 部署 | 域名 + Caddy 后 G0 全绿 |
| AC-GW16 | 桌面端联调 | 配对 → 连接 → 对话 → 注销 → 再配对 |

---

## 15. 应用侧后续改动

新插件通过 G0 后，应用仓库再做 Phase 3：

1. `src/utils/hermesPrompt.ts` 的 `PLUGIN_REPO` 指向新仓库
2. `docs/requirements/hermes-bootstrap-prompt.md`
   - 安装新插件
   - 设置 `PI_HUB_PUBLIC_URL`
   - 生成连接码，不写交接文件
3. `docs/guides/AGENT-TESTING.md` G1 首次连接步骤
4. `docs/requirements/CLOUD_AGENT_PAIRING.md` Phase 2 / Phase 3 状态
5. `docs/requirements/CLOUD_AGENT_DEVICES.md` 插件仓库与部署地址
6. `docs/architecture/PROJECT_STRUCTURE.md` 只保留仓库链接，不加入插件代码

---

## 16. 风险

| 风险 | 处理 |
| --- | --- |
| 上游鉴权方式与 Hermes 版本不一致 | `upstream.py` 隔离，集成测试固定假上游 |
| SSE 被 Caddy 缓冲 | 文档强制 `flush_interval -1`，测试分块到达 |
| `/api/fs/read-data-url` 越权读文件 | `realpath` + 白名单 + 测试路径穿越 |
| 配对码并发消费 | `BEGIN IMMEDIATE` + `UPDATE ... WHERE used_at IS NULL` |
| 管理密钥泄漏 | 只进 systemd，不进 `.env`、不进日志 |
| 域名 / 证书配置失败 | G0 单独检查 Caddy / DNS / 443 |
| 插件线程拖死 gateway | daemon 线程 + 顶层异常捕获 + 健康检查 |
| 桌面端与插件契约漂移 | 以 `CLOUD_AGENT_PAIRING.md §4` 为准，契约测试双向核对 |

---

## 17. 开工清单

新工作区里按顺序做：

- [ ] 建仓库 `pi-workbench-gateway`，`git init`
- [ ] 写 `plugin.yaml` / `__init__.py` / `shim.py` / `adapter.py`
- [ ] 写 `config.py` + 配置测试
- [ ] 写 `gateway/server.py` + `/v1/hub/health`
- [ ] 跑通 `hermes plugins validate .`
- [ ] 写 SQLite schema + 迁移
- [ ] 写配对码生成 / 消费 + 并发 / 过期 / 重放测试
- [ ] 写设备 token 签发 / 轮换 / 撤销
- [ ] 写 `Bearer` 鉴权 + scope
- [ ] 写 `/v1/devices/me` / heartbeat / revoke
- [ ] 写 `/v1/*`、`/api/*` 代理
- [ ] 写 SSE 分块转发测试
- [ ] 写 dashboard 侧路 + `fsguard`
- [ ] 写审计 + 日志脱敏
- [ ] 写 G0 冒烟
- [ ] 部署到干净 VPS
- [ ] 回应用仓库做 Phase 3 联调

---

## 18. 不做清单

- 不做多租户
- 不保存管理密钥到桌面端
- 不做 H3 `local_*` 任务邮箱
- 不做控制台 HTML 代理
- 不在插件内做 TLS
- 不允许公网 HTTP

---

## 19. 关联文档

- [CLOUD_AGENT_PAIRING](./CLOUD_AGENT_PAIRING.md) — 配对协议与桌面端 Phase 1
- [CLOUD_AGENT_DEVICES](./CLOUD_AGENT_DEVICES.md) — 设备身份、scope、审计
- [CLOUD_AGENT_APPROVAL](./CLOUD_AGENT_APPROVAL.md) — 审批链路
- [hermes-bootstrap-prompt](./hermes-bootstrap-prompt.md) — Phase 3 改写
- [AGENT-TESTING](../guides/AGENT-TESTING.md) — G1 手工验收
- [ADR-008](../decisions/ADR-008-cloud-single-entry-plugin.md) — 单入口插件决策
