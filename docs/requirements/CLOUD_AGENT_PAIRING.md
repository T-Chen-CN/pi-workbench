# 云端 Agent 配对连接方案（插件配对码）

> **面向**：实现「桌面端首次连接云端」与「插件签发设备 token」的人
> **什么时候读**：动 `electron/cloud/*`、连接页、`cloud:gateway:*`、插件设备路由之前
> **什么时候要改**：配对协议、设备 token 签发方式、控制台登录方式变化时
> **状态**：v1 · 2026-11-06 · **Phase 1 已完成（桌面端）**；Phase 2 插件待实现
> **取代**：桌面端的 `hermes-handoff` 导入（v1 / v1.1 / v2 全部删除）与管理密钥输入
> **上游**：[ADR-008](../decisions/ADR-008-cloud-single-entry-plugin.md) · [CLOUD_AGENT_DEVICES](./CLOUD_AGENT_DEVICES.md) · [插件仓库](https://github.com/T-Chen-CN/pi-workbench-plugin)

---

## 0. 一句话

**桌面端只输入一个短命的「连接码」，插件发设备 token；管理密钥永远不出服务器。**

```
服务器：装插件 → 生成一次性连接码 → 交给用户
桌面端：粘贴连接码 → 配对 → 自动连接
```

功能尚未上线，**不做任何历史兼容**：旧交接文件、旧配置字段、旧 IPC 一律删除；只在开发分支经历“桌面端先改完、插件随后支持”的空窗期，不发版。

---

## 1. 背景

当前首次连接有三条路：

1. 直接填网关地址 + 管理密钥，再点登记；
2. 导入 `hermes-handoff v2` 文件（自动填网关、管理密钥、控制台账号，并带自检快照）；
3. 导入更旧的 `v1 / v1.1` 文件（API 地址 + API Key，没有管理密钥）。

问题：

- 管理密钥是“签发设备 token”的根凭据，却要进入桌面端、进 `safeStorage`、进剪贴板；
- 三种文件格式、两套解析分支、两套 UI 文案，维护成本高；
- `v1 / v1.1` 本来就没有管理密钥，导入后还要手填，实际价值很低；
- 控制台账号 / 口令也被顺手存进桌面端，属于另一条敏感面。

插件现在已经承担“唯一入口”，但没有配对接口。把“签发”留在插件里、把“消费”放在桌面端，是更简单也更安全的形态。

---

## 2. 目标与非目标

### 目标

- 桌面端**不再保存管理密钥**，也不再有“记住 / 忘记管理密钥”。
- 桌面端**不再导入任何文件**；连接页只有一个“连接码”输入。
- 管理密钥只在服务器上使用；桌面端只拿到设备 token。
- 控制台首次手动登录，cookie 留在独立 partition；桌面端**不存账号口令**。
- 配对成功后立即连接、心跳、可注销、可重新配对。
- 代码路径唯一：没有 v1/v2 分支、没有 fallback、没有直连。

### 非目标

- 不做多用户 / 多租户；仍是单用户多设备。
- 不做浏览器审批流（设备码 `user_code` + 网页确认）；MVP 用服务器命令生成短码，后续可升级。
- 不做 `admin` scope 的桌面端签发；改服务端配置只能走服务器。
- 不保留 handoff 文件格式；不提供导入入口，旧文件不再识别，用户改用连接码。

---

## 3. 最终用户体验

### 3.1 服务器侧（自举 Prompt 结束时）

```bash
# 管理密钥从文件/环境读，不打印
PI_HUB_ADMIN_KEY="$(cat ~/pi-hub-admin-key)" \
curl -sS -X POST https://hub.<域名>/v1/devices/pairing \
  -H "X-Pi-Admin-Key: $PI_HUB_ADMIN_KEY"
```

返回（示例）：

```json
{
  "code": "ABCDE-FGHJK",
  "expiresAt": 1793938800,
  "pairingUrl": "https://hub.<域名>/#pair=ABCDE-FGHJK"
}
```

交给用户的只有两行：

```
网关：https://hub.<域名>
连接码：https://hub.<域名>/#pair=ABCDE-FGHJK
```

码在 URL fragment（`#` 后），不会发给服务器、不会进访问日志；10 分钟内有效，只能用一次。

### 3.2 桌面端连接页

未配对时：

```
云端网关
  网关地址（高级）  https://hub.tchen-xiaoxiao.com
  连接码            https://hub.example.com/#pair=ABCDE-FGHJK
                    （也可以只填 ABCDE-FGHJK）
  [配对并连接]      [复制自举 Prompt]
```

规则：

- 粘贴完整链接：自动拆出 `gatewayUrl`（origin）与 `code`（fragment）。
- 只填码：使用当前/默认网关地址。
- 配对中禁用按钮；失败保留输入，显示可读错误。
- 成功后卡片切到已配对状态，立即 `connect()`。

已配对时：

```
这台设备已配对
  设备 ID / 权限 / 心跳 / 上游版本
  [刷新状态] [注销这台设备] [打开控制台]
```

不再有“管理密钥”“忘记管理密钥”“从文件导入”。

### 3.3 控制台

- 地址来自配对响应的 `dashboardUrl`；没有就按 `hub.` → `dash.` 派生，再不行用官方默认。
- 首次打开 `dash.` 手动登录；cookie 存在独立 partition（`persist:hermes-dashboard`），之后免登录。
- 桌面端不再保存 `DASHBOARD_USER` / `DASHBOARD_PASSWORD`，也没有“复制口令”。

### 3.4 注销与重新配对

- “注销这台设备”用设备 token 自注销，不需要管理密钥。
- 重新配对：服务器生成新码 → 桌面端再输一次；同一 `deviceId` 会让插件轮换 token，旧 token 立即失效。
- 撤销**别的**设备、轮换管理密钥：只在服务器执行。

---

## 4. 协议契约

本节是**桌面端对插件的要求**；插件按此实现，应用不迁就插件现状。

### 4.1 生成配对码

```
POST /v1/devices/pairing
Header: X-Pi-Admin-Key: <管理密钥>
Body: {}
```

成功 `2xx`（建议 `201`；应用接受任意 `2xx`）：

```json
{
  "code": "ABCDE-FGHJK",
  "expiresAt": 1793938800,
  "pairingUrl": "https://hub.example.com/#pair=ABCDE-FGHJK"
}
```

- 只有服务器调用；管理密钥不出服务器。
- `expiresAt` 为 Unix 秒。
- `pairingUrl` 由插件按请求的 `Host` / `X-Forwarded-Proto` 生成；生成不了可省略，由自举 Prompt 拼。
- 码统一为 **10 位 Crockford Base32**（去掉 `I` `L` `O` `U`），显示为 `XXXXX-XXXXX`；服务端只存 `sha256(规范化后的码)`。

### 4.2 消费配对码

```
POST /v1/devices/pair
Body: {
  "code": "ABCDE-FGHJK",
  "deviceId": "b8235e0e-a459-4bad-95a2-5d0585a613fc",
  "name": "TChen-Legion"
}
```

成功 `2xx`（建议 `201`；应用接受任意 `2xx`）：

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

- 不需要任何 header 凭据；码本身就是授权。
- `deviceId` 必须是桌面端 `device.json` 的稳定 id；同一 id 再配对 = 轮换 token。
- `name` 走现有 `_clean_text` / 长度限制；非法则 `invalid_params`。
- `scopes` 固定 `chat` + `dispatch`；**永远不返回 `admin`**，忽略客户端传的 scopes。
- `dashboardUrl` 可选；插件能推导就返回。
- 响应形状与现有 `/v1/devices/register` 保持一致，便于复用 token 生成与审计。

### 4.3 错误码

| code | HTTP | 桌面端提示 |
| --- | --- | --- |
| `pairing_not_found` | 404 | 连接码不存在，检查是否粘完整 |
| `pairing_expired` | 410 | 连接码已过期，请在服务器重新生成 |
| `pairing_used` | 409 | 连接码已使用，请重新生成 |
| `rate_limited` | 429 | 尝试太频繁，稍后再试 |
| `invalid_params` | 400 | 设备标识或名称不合法 |
| `pairing_disabled` | 503 | 当前插件版本不支持配对，请升级插件 |

错误响应沿用插件现有形状：`{ "error": { "code": "...", "message": "..." } }`。

旧版插件没有该路由时返回 404；桌面端**先看响应体 `error.code`**：有 `pairing_not_found` 才按上表提示，没有结构化错误码的 404 才映射为“插件需要升级”，不要把所有 404 都当成连接码错误。

### 4.4 安全参数

| 项 | 值 |
| --- | --- |
| 码长度 / 熵 | 10 位 Crockford Base32，约 50 bit |
| TTL | 600 秒（10 分钟） |
| 使用次数 | 1 次；事务内消费 |
| 存储 | `sha256(规范化码)`，不存明文 |
| 限流 | `/pair` 每 IP 10 次/分钟；`/pairing` 每 IP 5 次/分钟 |
| 失败处理 | 失败也计数；超限返回 429；审计只记结果类别 |
| 传输 | 只允许 HTTPS；loopback 例外沿用现有规则 |
| 日志 | 永不记录 code / token / 管理密钥 |
| scope | 只发 `chat` / `dispatch` |

### 4.5 数据与审计

建议表：

```sql
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
```

- 每次创建 / 消费时顺手删除过期超过 1 小时的记录。
- 消费在 `BEGIN IMMEDIATE` 事务里完成：校验 + 标记 `used_at` + 轮换设备 token。
- 审计事件：`device.pairing.create`、`device.pair`、`device.pair.fail`（只记原因 / IP / deviceId）。
- 现有 `/v1/devices/register` 保留，作为服务器 break-glass；桌面端不再调用。

---

## 5. 桌面端改造（Phase 1，只改本仓库）

### 5.1 删除清单

| 位置 | 删除内容 |
| --- | --- |
| `electron/cloud/handoff.ts` | 整个文件：v1 / v1.1 / v2 解析、预览、补丁 |
| `src/components/CloudHandoffDialog.tsx` | 整个文件；`CloudWorkspaceView` 里的挂载一并删除 |
| `electron/ipc/cloud-agent.ts` | `cloud:handoff:pick` / `apply` / `copy`、`pendingHandoff`、文件选择 |
| `electron/preload.cts` / `src/types/electron.d.ts` / `src/api/cloud.ts` | 对应 handoff 方法与类型 |
| `src/store/cloudStore.ts` | `handoffPreview` / `handoffBusy` / `handoffError` / `pickHandoff` / `applyHandoff` / `copyHandoffSecret` / `clearHandoffPreview` |
| `electron/ipc/cloud-agent.ts` | `cloud:gateway:register`、`cloud:gateway:forget-admin-key` |
| `electron/cloud/config.ts` | `adminKey` / `dashboardUser` / `dashboardPassword` / `handoffImportedAt` / `handoffProfile` 字段与读写 |
| `electron/cloud/types.ts` / `src/types/cloud.ts` | `CloudHandoff*`、`CloudConfigPatch`、`hasAdminKey`、`hasDashboardPassword`、`dashboardUser` |
| `src/i18n/translations.ts` | `cloudHandoff*` / `cloudImport*` / `cloudHandoffWarn_*` / `cloudHandoffErr_*`（中英各一套） |
| `tests/cloud-handoff.test.ts` / `tests/cloud-handoff-view.test.tsx` | 整个文件 |
| `src/hooks/useCloudImage.ts` | 不受影响；图片仍走设备 token |

`CloudConnectionView` 的“管理密钥”输入、记住勾选、“忘记管理密钥”按钮、“从文件导入”按钮全部删除。

### 5.2 新增桌面端能力

**主进程**

- `electron/cloud/gateway.ts`
  - 删除 `registerDevice`（桌面端不再用管理密钥登记）；
  - 新增 `pairDevice({ gatewayUrl, code, deviceId, name })` → `POST /v1/devices/pair`；
  - 错误码翻译加入 `pairing_not_found` / `pairing_expired` / `pairing_used` / `rate_limited` / `pairing_disabled`。
- `electron/ipc/cloud-agent.ts`
  - 新增 `cloud:gateway:pair`，输入 `{ gatewayUrl?: string; code: string; name?: string }`；
  - 规范化连接码（大写、去 `-` / 空格）；完整链接在渲染层拆好，主进程只收结果；
  - 成功后写 `gatewayUrl` / `deviceToken`（`enc:`）/ `deviceScopes` / `deviceId` / `dashboardUrl`；`dashboardUrl` 优先取配对响应，缺省按 `hub.` → `dash.` 派生，换网关时同步重算；
  - 网关变更时 `clearActiveRun()`；`heartbeat.poke()`；清 `client` / `runner`；返回 `publicCloudConfig()`；
  - 失败不落任何 token，不覆盖原配置；
  - `cloud:gateway:revoke` 去掉 `adminKey` 入参，只做设备自注销。
- `electron/cloud/config.ts`
  - `CloudConfig` 缩为：`gatewayUrl` / `deviceToken` / `deviceScopes` / `deviceId` / `dashboardUrl`；
  - `connection.json` 用白名单重写，旧字段（`baseUrl` / `adminKey` / `dashboardUser` / `dashboardPassword` / `handoff*` / `apiKey` / `dashboardToken`）读取时忽略并在 `config:get` 清掉；
  - `publicCloudConfig()` 只回 `gatewayUrl` / `hasDeviceToken` / `deviceScopes` / `deviceId` / `dashboardUrl`。

**渲染层**

- `src/store/cloudStore.ts`
  - `registerGateway` / `forgetAdminKey` → `pairGateway(input)`；
  - 配对成功后 `getConfig()` + `connect()` + `loadGateway()`；
  - `pairBusy` / `pairError` 替代 `gatewayBusy` 中的登记部分。
- `src/components/CloudConnectionView.tsx`
  - 未配对：网关地址（高级、默认官方）+ 连接码 + “配对并连接”；
  - 连接码支持完整 `https://host/#pair=CODE`：`new URL()` 取 origin，正则取 fragment；
  - 只填码：用当前/默认网关；
  - 已配对：设备卡、心跳、刷新、注销、打开控制台；无管理密钥相关 UI。
- `src/components/CloudConsoleView.tsx`：不变；`dashboardUrl` 来自配对响应或派生。
- 新增 i18n（约 8 对）：`cloudPairCode` / `cloudPairCodeHint` / `cloudPairConnect` / `cloudPairing` / `cloudPairFailed` / `cloudPairExpired` / `cloudPairPluginOutdated` / `cloudPairGatewayAdvanced`。

### 5.3 配置与迁移

目标 `connection.json`：

```json
{
  "gatewayUrl": "https://hub.example.com",
  "deviceToken": "enc:...",
  "deviceScopes": ["chat", "dispatch"],
  "deviceId": "b8235e0e-a459-4bad-95a2-5d0585a613fc",
  "dashboardUrl": "https://dash.example.com"
}
```

- 功能未上线，不做数据迁移；旧文件里的字段直接丢弃。
- 已经配对过的开发机保留 `deviceToken` 即可继续用；管理密钥 / 控制台口令会被清掉。
- 没有 `deviceToken` 的机器进入“未配对”，等插件配对上线后重新配对。

### 5.4 状态机

```
unconfigured（无 token）
  └─ 输入连接码 → pairing（按钮禁用）
       ├─ 成功 → connected（token 落盘、connect、heartbeat）
       └─ 失败 → unconfigured（保留网关与输入，显示错误）
connected
  ├─ 心跳失败 / 撤销 → 现有逻辑（error / 提示重新配对）
  └─ 注销 → unconfigured（gatewayUrl 保留）
```

### 5.5 测试

- `tests/cloud-gateway-pair.test.ts`：成功、404/410/409/429、同 deviceId 轮换、网关变更清 `active-run`。
- `tests/cloud-store.test.ts`：`pairGateway` 成功后 `config.hasDeviceToken === true`、`connection === 'connected'`；失败不写 token。
- `tests/cloud-view.test.tsx`：粘贴完整链接自动拆网关/码；只填码；插件过期提示；已配对卡片不再有管理密钥按钮。
- `tests/cloud-agent-ipc.test.ts`：`cloud:gateway:pair` 的落盘、错误、撤销；删除所有 handoff/register 用例。
- 全部 mock `net.fetch`，不依赖插件；Phase 1 收尾跑 `npm test` + `npm run type-check` + `npm run lint`。

Phase 1 结束时：应用可编译、测试全绿；真实配对会因插件未实现而返回“插件需要升级/不支持”。

---

## 6. 插件改造（Phase 2，独立仓库）

按 §4 契约实现，不改桌面端：

| 文件 | 改动 |
| --- | --- |
| `core/db.py` | `pairing_codes` 表 + 创建/消费/清理函数 |
| `core/server.py` | `POST /v1/devices/pairing`、`POST /v1/devices/pair`；复用 register 的 token 轮换 |
| `core/auth.py` | 配对码哈希、常量时间比较、过期 / 已用判断 |
| `core/audit.py` | 三个审计事件 |
| `plugin.yaml` | 版本 bump；不需要新增 env |
| `tests/` | 生成、消费、过期、重放、并发消费、限流、scope、`pairingUrl`、审计 |

实现要点：

- `/pairing` 必须校验 `X-Pi-Admin-Key`；`/pair` 不校验 header。路由白名单要确保 `/pair` 不被全局设备 token 中间件拦掉，`/pairing` 只认管理密钥。
- 码用 `secrets.choice` 生成，不用 `random`；只存哈希；事务内消费；对客户端按 §4.3 返回明确原因，审计 / 日志只记结果类别，不记录 code。
- 复用现有设备表与 token 轮换逻辑；`deviceId` 相同 → 旧 token 失效。
- 限流用现有 `PI_HUB_RATE_LIMIT` 之外的独立桶更安全；至少固定 10 次/分钟/IP。Caddy 后取真实客户端 IP 时只信任本机反代传入的 `X-Forwarded-For`。
- 审计只记 IP / deviceId / 结果，永不记 code / token。
- 保留 `/v1/devices/register` 给服务器 break-glass；桌面端不再调用。

部署后用 `curl` 验收：

```bash
# 1) 生成
curl -sS -X POST https://hub.example.com/v1/devices/pairing \
  -H "X-Pi-Admin-Key: $PI_HUB_ADMIN_KEY"

# 2) 消费
curl -sS -X POST https://hub.example.com/v1/devices/pair \
  -H 'Content-Type: application/json' \
  -d '{"code":"ABCDE-FGHJK","deviceId":"...","name":"test"}'

# 3) 重放 → pairing_used；过期 → pairing_expired；错误码 → pairing_not_found
```

---

## 7. 自举 Prompt 改造（Phase 3）

`docs/requirements/hermes-bootstrap-prompt.md` 第五 / 六步改为：

1. 第四步验证不变（DNS / TLS / `hub/health` / 401 / dashboard / 端口）。
2. 第五步不再写 `~/.hermes/handoff/*.txt`，不再要求 `scp` / 删除文件；改为用管理密钥调用 `/v1/devices/pairing`，拿到 `code` / `pairingUrl`。
3. 第六步给用户：
   - 网关地址（`https://hub.<域名>`）；
   - 连接码链接（`https://hub.<域名>/#pair=XXXXX-XXXXX`，10 分钟内有效）；
   - 一句“在 Pi Workbench 连接页粘贴，点配对并连接”。
4. 仍然禁止在对话里打印管理密钥；连接码可以给，但提醒短命、单次。
5. 如果生成失败：给出原始错误码与排查方向（插件未升级 / 管理密钥未配置 / Caddy 未转发）。

---

## 8. 实施阶段与 Gate

| 阶段 | 范围 | Gate |
| --- | --- | --- |
| **Phase 1** | 桌面端删除历史 + 配对 UI/IPC/config + mock 测试；写本方案 | `npm test` / 双 tsc / lint 全绿；无 handoff / adminKey 残留；真实配对允许未通 |
| **Phase 2** | 插件两条路由 + SQLite + 限流 + 审计 + 测试 | 插件单测全绿；`curl` 生成/消费/重放/过期/限流全部符合 §4 |
| **Phase 3** | 桌面端真实配对 + Prompt + 文档 + G1 | 粘贴连接码 → 连接 → 对话 → 注销 → 重新配对；无管理密钥进入桌面端 |

开发顺序：**Phase 1 → Phase 2 → Phase 3**。Phase 1 与 Phase 2 之间不发版；桌面端暂时不能配对是已知状态。

---

## 9. 验收

| ID | 场景 | 期望 |
| --- | --- | --- |
| AC-P01 | 粘贴完整连接链接 | 自动填网关与码，点配对成功 |
| AC-P02 | 只填码 + 默认网关 | 配对成功 |
| AC-P03 | 配对成功 | token 加密落盘、立即 connected、心跳开始 |
| AC-P04 | 过期 / 已用 / 不存在 | 显示对应提示，不落 token，保留输入 |
| AC-P05 | 同一设备重新配对 | 旧 token 立即失效，新 token 可用 |
| AC-P06 | 桌面端全量检查 | 配置/UI/日志无 `adminKey` / handoff / 控制台口令 |
| AC-P07 | 注销后重新配对 | 注销只清设备凭据，网关保留；新码可再配对 |
| AC-P08 | 管理密钥边界 | 管理密钥只在服务器；桌面端从未发送 |
| AC-P09 | 自举 Prompt | 输出连接码链接，不写文件、不 `scp` |
| AC-P10 | 旧 handoff 文件 | 已无导入入口；不存在解析路径 |

---

## 10. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 连接码被旁观 / 转发 | 50 bit、10 分钟、单次、IP 限流；权限只有 `chat/dispatch` |
| 旧插件不支持 `/pair` | 桌面端明确提示“升级插件”；不自作降级到管理密钥 |
| 控制台地址推导错 | 优先用配对响应的 `dashboardUrl`；否则 `hub.` → `dash.`，再回落官方默认 |
| 桌面端暂时不能配对 | 只在开发分支存在，Phase 1/2 之间不发版 |
| 管理员操作变麻烦 | 撤销别的设备 / 轮换管理密钥本就属于服务器运维；桌面端只保留自注销 |
| 旧开发机配置残留 | `config:get` 按白名单重写；旧字段自动消失 |

---

## 11. 工作量

| 阶段 | 估算 |
| --- | --- |
| Phase 1 桌面端 | 1–1.5 天 |
| Phase 2 插件 | 2–3 天 |
| Phase 3 联调 / Prompt / 文档 / G1 | 0.5–1 天 |
| 合计 | 约 1 周 |

---

## 12. 关联文档

- [ADR-008 云端单入口插件](../decisions/ADR-008-cloud-single-entry-plugin.md)
- [CLOUD_AGENT_DEVICES](./CLOUD_AGENT_DEVICES.md) — 设备身份、scope、心跳、派活
- [CLOUD_AGENT_APPROVAL](./CLOUD_AGENT_APPROVAL.md) — 审批链路（不涉及配对）
- [hermes-bootstrap-prompt](./hermes-bootstrap-prompt.md) — Phase 3 改写
- [AGENT-TESTING](../guides/AGENT-TESTING.md) — G1 手工验收
- [PROJECT_STRUCTURE](../architecture/PROJECT_STRUCTURE.md) — IPC / 文件树
- [paths-and-storage](../agent/paths-and-storage.md) — `connection.json` 字段
- [插件仓库](https://github.com/T-Chen-CN/pi-workbench-plugin) — Phase 2 实现

---

## 13. Phase 1 落地记录（2026-11-06）

桌面端已完成，插件路由尚未实现；真实配对待 Phase 2。

| 项 | 结果 |
| --- | --- |
| 删除历史路径 | `electron/cloud/handoff.ts`、`CloudHandoffDialog.tsx`、`cloud:handoff:*`、`cloud:gateway:register`、`cloud:gateway:forget-admin-key`、管理密钥 / 控制台口令 / handoff 配置字段、对应 i18n 与测试全部移除 |
| 新增配对路径 | `electron/cloud/gateway.ts` 的 `pairDevice()`、`cloud:gateway:pair`、`cloudApi.gatewayPair()`、`cloudStore.pairGateway()` |
| 连接页 | 网关地址（高级）+ 连接码 + 「配对并连接」；支持 `https://host/#pair=CODE` 与 `?pair=CODE`；错误按 `pairing_*` 码显示 |
| 配置 schema | `connection.json` 只剩 `gatewayUrl` / `deviceToken` / `deviceScopes` / `deviceId` / `dashboardUrl`；`config:get` 白名单清理旧字段 |
| 控制台地址 | 优先配对响应的 `dashboardUrl`；缺省同网关保留现值，换网关按 `hub.` → `dash.` 派生 |
| 安全约束 | 桌面端代码不再出现 `X-Pi-Admin-Key`；注销只带设备 token；配对失败不写 token |
| 测试 | 新增 `tests/cloud-pairing.test.ts`、`tests/cloud-gateway-pair.test.ts`；config / gateway / IPC / store / view / types 用例同步 |
| 验证 | `npm test`（151 文件 / 1770 用例）、`npm run type-check`、`npm run lint` 全绿 |
| 尚未验证 | 真实插件 `/v1/devices/pairing` 与 `/v1/devices/pair`；Phase 2 完成后跑 Phase 3 联调 |

