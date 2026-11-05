# 云端 Agent 审批：实现方案（C-05）

> **面向**：实现云端审批闭环（卡片 / 应答 / 审计 / 原生档位切换）的人
> **什么时候读**：动 `electron/cloud/*`、`CloudApprovalCard`、`cloudStore` 的审批状态、或改云端权限档位之前
> **什么时候要改**：服务端审批契约变化（事件字段 / 应答语义）、原生档位集合变化、审计格式变化时

**状态**：阶段 0 / 2 已实施（2026-11-06）；阶段 1（服务端拨档）待执行 · **日期**：2026-11-06
**上游**：[CLOUD_AGENT v5](./CLOUD_AGENT.md) §2 `C-C01` / `C-B03`、§8 `AC-03/04/16/17/22`；[BACKLOG §7.1](../progress/BACKLOG.md) `C-05`
**可行性证据**：§2（2026-11-06 对着实机 `Hermes 0.22.6` 只读实测，探针在 `cache/probe/`，已 gitignore）

---

## 0. 已确认的决策（2026-11-06）

| # | 议题 | 决定 |
| --- | --- | --- |
| 1 | 服务端审批开关 | **做**，由实现者（我）直接打最小 patch、读回复核、一条命令回滚 |
| 2 | 策略基线 / 漂移告警 / 一键还原 | **不做**。只显示当前原生档位 |
| 3 | 审批按钮 | **一次 / 本会话 / 拒绝**，默认拒绝；`always` 在映射层丢弃 |
| 4 | 档位 | **只用原生三档** `manual` / `smart` / `off`；不自造预设、不切工具集 |
| 5 | `approvals.deny` | **走 Hermes 默认 → 保持空**，不加 S-15 清单 |
| 6 | 审计内容 | 命令**摘要**（≤200 字）+ 命中规则，不存全文 |
| 7 | 卡片到达时滚动 | 用户本来贴在底部 → 滚到卡片；已上滚 → 不打扰，只在输入框上方亮「有待审批」 |
| 8 | 「本会话」按钮 | **保留** |
| 9 | 长期默认档位 | 阶段 1 之后先用 **`manual`** 一周，烦了再切 `smart`（控件一处点击） |
| 10 | UI 截图验收 | 由项目所有者出；实现方以单测 + `design-system.test.ts` 为门槛 |
| 11 | 提交节奏 | 分支 `feat/cloud-approval`，2 个 commit（契约+映射 / 应答通道+卡片+审计+档位）；阶段 1 的运维改动不进仓库 |

> **唯一偏离 Hermes 默认的一处**：`agent.disabled_toolsets: [code_execution]`（v5 `S-04` 硬要求；`execute_code` 整脚本绕过审批，开着等于所有档位失效）。只此一项，其余全默认。

---

## 1. 目标与非目标

**目标**：Hermes 申请执行权限时，人在 Pi Workbench 里能看见、能点、点完有效果，且每次决定都有审计。

| 做 | 不做 |
| --- | --- |
| 审批卡片（命令原文 / 命中规则 / 一次 / 本会话 / 拒绝 / 超时倒计时） | ❌ 「永远允许」（会写永久白名单，`S-08` 禁止） |
| 应答通道 `cloud:approval:respond`，严格回执 | ❌ 批量批（一次应答解多个请求） |
| 断流 / 重启后靠 `pending_controls` 补卡 | ❌ 审批队列跨任务聚合（同时只有一轮在跑） |
| 审计 `data/cloud-agent/audit.jsonl`（谁批的 / 哪条规则 / 真实结果） | ❌ 基线版本化 / 漂移告警 / 一键还原 |
| **原生档位切换**：`approvals.mode` = `manual` / `smart` / `off` | ❌ 自造「只读 / 询问 / 完全授权」预设、切工具集 |

**为什么档位只用原生的**：Hermes 的工具开关粒度只到工具集（`file` 恒为 `patch,read_file,search_files,write_file`；上游按工具开关 #31375、只读 file 工具集 #85976 均未落地，本实例 27 个工具集里没有 `safe`），硬拼「只读档」只能整块删 `file`（连读都不能），不准确也没必要。

---

## 2. 现状事实（2026-11-06 实测）

### 2.1 服务端

| 项 | 事实 |
| --- | --- |
| 能力 | `run_approval_response: true`、`approval_events: true`、`endpoints.run_approval = POST /v1/runs/{run_id}/approval` |
| 当前配置 | `approvals.mode: off`（= 不问就干）、三子模式 `off`、`approvals.deny: []`、`agent.disabled_toolsets: []`、`terminal.backend: local` |
| **结论** | **现在不会有人申请**，因为审批被关掉了；不是前端有没有按钮的问题 |

### 2.2 `deny: []` 意味着什么（决策 5 的事实基础）

Hermes 默认 `approvals.deny` 就是空。保持默认后，安全地板只剩两层：

| 层 | 覆盖 | 不覆盖 |
| --- | --- | --- |
| **hardline blocklist**（代码内置，不可关） | `rm -rf /` 及变体、fork bomb、`mkfs.*` 打根设备、`dd if=/dev/zero of=/dev/sd*`、往根文件系统 `curl \| sh` | — |
| **危险模式审批**（`manual` 档下逐条问，约 35 条） | `rm -r`、`chmod 777`、`chown -R root`、`dd if=`、`> /etc/`、`systemctl stop/restart/disable/mask`、`kill -9 -1`、`pkill -9`、`bash -c`/`sh -c` 等、`curl \| sh`、`tee`/重定向到 `~/.ssh` 与 `.hermes/.env`、`xargs rm`、`find -exec rm`、`docker stop/kill/restart` 等 | **纯 `sudo <cmd>`**（模式表里没有 sudo 条目）、**`write_file` / `patch`（根本没有审批路径）**、`execute_code`（整脚本绕过，靠 `disabled_toolsets` 关） |

**接受的风险**：以默认空 deny 为前提，`sudo apt install xxx` 这类不命中 35 条模式的命令**不会问**就直接跑；文件写入永远不问。这是决策 5 的代价，写在这里以便以后回看。

### 2.3 前端（4 条实测缺陷，本方案要修的就是这些）

| 缺陷 | 位置 |
| --- | --- |
| 真实 `approval.request` 没有 `request_id`，当前只能合成 `s:approval:<seq>` | `electron/cloud/map.ts:482` |
| `approval.responded` 因匹配不到 id 而无法回填卡片（实测 `decision` 恒为 `null`） | `electron/cloud/map.ts:498` |
| 时间线把审批降级成 `run_error` 分隔线（无按钮） | `src/components/CloudTrace.tsx:60` |
| 断流 / 重启补不出卡片：无 `ensureApproval`、`pollControls` 只处理 clarify、`cloud:run:status` 丢掉 `pending_controls` | `map.ts` / `runner.ts:182` / `ipc/cloud-agent.ts:666` |

---

## 3. 契约

### 3.1 SSE 事件（`GET /v1/runs/{id}/events`）

**以下是 2026-11-06 拨到 `manual` 后抓到的真实帧**（探针 `cache/probe/step10-approval-frame.ps1`，已 gitignore）：

```jsonc
// approval.request —— 实测形状（与上游 PR 描述不同：是 prompt_id，不是 request_id）
{ "event": "approval.request", "run_id": "run_x", "timestamp": 1793871866.9,
  "kind": "approval",
  "prompt_id": "ee2d0ceebe1d4f5ebca75be7bc8620b2",
  "execution_generation": 1,
  "command": "rm -rf /tmp/pi-probe-approval-nonexistent; echo \"EXIT_CODE=$?\"",
  "description": "delete in root path",     // 命中规则的人类可读描述
  "choices": ["once", "deny", "session", "always"],
  "seq": 1 }

// approval.settled —— 应答之后服务端只推这个（**没有 choice 字段**）
{ "event": "approval.settled", "run_id": "run_x", "prompt_id": "ee2d…",
  "execution_generation": 1, "seq": 2 }
```

- **没有 `pattern_key` / `pattern_keys`**：命中规则只在 `description` 里 → 映射层按 `pattern_keys → pattern_key → description` 兜底。
- **没有 `timeout_s`**：倒计时用配置里的 `approvals.timeout`（120s）兜底，不编造服务端字段。
- `choices` 里会出现 `always`：**一律不渲染**；`session` 保留（决策 8）。
- 结算回执是 `approval.settled`（不带 choice）而非 `approval.responded`：本地已记的决定**必须保留**，否则会退化成「别人处理的」。
- 运行时状态确实是 `waiting_for_approval`，`toRunStatus()` 会折成内部的 `waiting_approval`。

### 3.2 状态轮询（`GET /v1/runs/{id}`）

实测（`cache/probe/step11-approval-pending.ps1`）：

```jsonc
{ "status": "waiting_for_approval",
  "pending_controls": [
    { "kind": "approval",
      "prompt_id": "ee1d8826f6cc4934bcc963a361881913",
      "execution_generation": 1,
      "command": "rm -rf /tmp/pi-probe-approval-two",
      "description": "delete in root path",
      "choices": ["once", "deny", "session", "always"] } ],
  "session_id": "run_x", "admission_id": "dca9…", "execution_generation": 1 }
```

答复之后再查：`pending_controls: []`、`status: "running"` → 这是断流后补卡 / 判活的唯一来源。

### 3.3 应答（`POST /v1/runs/{id}/approval`）

实测结论（2026-11-06，Hermes 0.22.6）：**三个字段都是必填**，run-scoped 语义不存在。

| body | 结果 |
| --- | --- |
| `{"choice":"deny"}` | **400 `invalid_params`** |
| `{"request_id":…,"choice":"deny"}` | **400 `invalid_params`** |
| `{"request_id":…,"execution_generation":1,"choice":"deny"}` | **200 `{status:"resolved", prompt_id}`** |

`request_id` 直接吃 `prompt_id` 的值；`execution_generation` 在 `approval.request`、`pending_controls` 与 `GET /v1/runs/{id}` 上都有，卡片缺失时由主进程现取一次。

放行与拒绝都验证过：`deny` → `tool.completed{error:true}`（Agent 说明「被审批层拦下」）；`once` → 工具真的执行，`exit_code: 0`，且 Hermes 自己在工具结果里记了 `"approval": "Command required approval (delete in root path) and was approved by the user."`。

---

## 4. 数据模型

`CloudTracePart.approval`（`electron/cloud/types.ts` + `src/types/cloud.ts` 两侧同步）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `a:<promptId \| command-hash>` |
| `requestId` | string | 服务端 `request_id`/`prompt_id`；缺失时用 `runId`（**不再合成序号**，否则无法回填） |
| `generation` | number? | `execution_generation`，拿不到就省略（不填默认 1） |
| `command` | string | 完整命令（卡片正文，UI 截断显示） |
| `patternKeys` | string[] | 命中规则（审计与 UI 都用它） |
| `choices` | `('once' \| 'session' \| 'deny')[]` | 过滤掉 `always` 后的可选项 |
| `decision` | `once \| session \| deny`? | 已决结果（回填点） |
| `decidedAt` | number? | 本地点击时间 |

**状态机**：`pending`（出卡，倒计时） → `decided`（回填，卡片收折）/ `expired`（超时：本地置灰 + 「已自动拒绝」，等 `tool.completed` 的 `BLOCKED` 预览确认）。

---

## 5. 分层改动

### 5.1 主进程

| 文件 | 改动 |
| --- | --- |
| `electron/cloud/map.ts` | ①`approval.request` 用真实字段（§3.1）；②新增 `ensureApproval(control)`（与 `ensureClarify` 同构，按 `prompt_id` 去重）；③`approval.responded` 三级回填：`prompt_id` → `command` → 唯一未决项；④`always` 从 `choices` 中剔除 |
| `electron/cloud/runner.ts` | `pollControls` 改为同时处理 `clarify` 与 approval（按字段判别，不硬编码单一 `kind`）；终态收尾把未决审批标 `expired` |
| `electron/cloud/remote.ts` | 新增 `respondApproval({runId, requestId?, generation?, choice})` → `POST /v1/runs/{id}/approval`；错误码经现有 `CloudApiError` 翻译 |
| `electron/cloud/policy.ts`（新） | ①`getApprovalPolicy()`：主进程 `GET dash:/api/config`，**只取** `approvals.mode` / `approvals.timeout` / `approvals.deny`（**只算条数，不留内容**）/ `agent.disabled_toolsets` / `terminal.backend`；②`setApprovalMode(mode)`：`PUT` 最小 patch `{"config":{"approvals":{"mode":...}}}`，写后读回复核 |
| `electron/cloud/audit.ts`（新） | `appendAudit(entry)`：`data/cloud-agent/audit.jsonl`，append + `fsync`（参考 `terminal-manager.ts:299`；**不用** `atomic-json`） |

### 5.2 IPC（四步齐全：`handleIpc` → preload → `types/electron.d.ts` → `api/cloud.ts` + Web mock）

| 频道 | 方向 | 入参 | 出参 |
| --- | --- | --- | --- |
| `cloud:approval:respond` | invoke | `{ runId, requestId?, generation?, choice }` | `{ success, decision?, error? }` |
| `cloud:policy:get` | invoke | — | `{ success, mode, timeout, denyCount, disabledToolsets, terminalBackend }` |
| `cloud:policy:set` | invoke | `{ mode: 'manual'\|'smart'\|'off' }` | `{ success, mode, error? }` |
| `cloud:run:status`（改） | invoke | 不变 | 增加 `pendingControls`（脱敏：`kind` / `prompt_id` / `command` / `pattern_key`） |

### 5.3 渲染层

| 文件 | 改动 |
| --- | --- |
| `src/components/CloudApprovalCard.tsx`（新） | 命令原文（等宽、可复制、截断 6 行）+ 命中规则 + 三个按钮（一次 / 本会话 / 拒绝）+ 倒计时 + 「超时将自动拒绝」+ 禁用态（无通道 / 已决 / 已过期） |
| `src/components/CloudModeSwitch.tsx`（新） | 原生三档：**询问我**（`manual`，推荐）/ **自动判断**（`smart`，标「不推荐：判定不可复现」）/ **完全不问**（`off`，红字 + 二次确认）；当前值来自 `cloud:policy:get`，不本地记忆 |
| `src/components/CloudTrace.tsx` | `approval` part 走卡片，不再降级为分隔线；已决 / 过期的卡片保留在时间线上（可回看） |
| `src/components/CloudWorkspaceView.tsx` | 页签栏右侧放 `CloudModeSwitch` 紧凑形态 |
| `src/store/cloudStore.ts` | `approvals` 派生自 parts；`respondApproval` / `loadPolicy` / `setMode`；`waiting_approval`；`pendingControls` 合并去重；`hasPendingApproval` 供输入框上方提示 |
| `src/hooks/useCloudBridge.ts` | 新的 `policy` 帧 → store |
| `src/i18n/translations.ts` | 新增键（中英）：卡片标题 / 按钮 / 倒计时 / 超时 / 失败 / 三档文案 / 二次确认 / 待审批提示 |
| `src/utils/cloudFormat.ts` | 命令摘要与规则文案格式化（卡片与审计共用） |

---

## 6. 交互规则

### 6.1 卡片

| 情形 | 表现 |
| --- | --- |
| 收到 `approval.request` | 出卡；**本来贴在底部 → 滚到卡片；已上滚 → 不打扰**，输入框上方亮「有 1 个待审批」（决策 7） |
| 点「一次」 | 发 `once`；卡片收折为「已允许（一次）」 |
| 点「本会话」 | 发 `session`；收折为「本会话内同类命令不再询问」 |
| 点「拒绝」 | 发 `deny`；收折为「已拒绝」 |
| 倒计时归零 | 本地置 `expired` + 「已超时，将由服务端自动拒绝」；不再允许点击 |
| 回执失败 | 卡片内红字显示翻译后的错误码，按钮恢复可点（`409 已结算` 除外：置灰并重拉状态） |
| SSE 已断 | 卡片标「连接已断开，可能无法应答」；仍可点（走 HTTP 不等于走流） |
| 完全授权档（`off`） | 不会出卡；若被 hardline blocklist 拦成 `BLOCKED`，工具卡显示「被服务端硬禁令拦截」而非普通失败 |

### 6.2 不做「永远允许」

`choices` 里的 `always` 在映射层丢弃（不是只在 UI 隐藏），渲染层拿不到也就发不出。

### 6.3 档位切换

| 方向 | 表现 |
| --- | --- |
| → `manual`（收紧） | 一键生效，无确认 |
| → `smart` | 一行提示「判定不可复现，审计不完整」，不确认 |
| → `off`（放宽） | **二次确认**，文案写清：「切到这里等于整机不设防；`write_file`/`patch` 本来就没有审批路径」 |
| 任意切换 | 生效后读回复核（读 == 写才算成功）；变更写审计；提示「立即影响正在跑的轮次」 |
| 首次真写前 | 先发空 patch `{"config":{}}`，对比前后 `GET /api/config` 的 hash 与 mtime，确认不重写 / 不漂移 |

---

## 7. 审计

**文件**：`data/cloud-agent/audit.jsonl`（追加 + `fsync`，一行一条，永不改写；**首期不轮转**）。**实施时同步登记进 [paths-and-storage](../agent/paths-and-storage.md) 的落盘清单。**

```jsonc
{ "at": 1793733048000, "kind": "approval", "runId": "run_x", "sessionId": "s_x",
  "command": "git reset --hard HEAD",          // ≤200 字摘要（决策 6：不存全文）
  "patternKeys": ["recursive delete"],
  "choice": "deny",
  "mode": "manual",                            // 决策当时的档位
  "result": { "error": true, "preview": "BLOCKED: ..." } }  // 来自 tool.completed，可为 null

{ "at": ..., "kind": "mode", "from": "manual", "to": "off" }
```

审计只回答三个问题：**谁批的**（本机用户点的那一下）、**依据哪条规则**（`pattern_keys` + 当时的 `mode`）、**真实结果**（工具卡最终 `error` / `preview` 前 200 字）。

---

## 8. 分期

### 阶段 0：前端闭环（纯本地，可独立合入）

1. `types.ts` / `types/cloud.ts` 的 approval 字段扩展
2. `map.ts`：真实字段 + `ensureApproval` + 三级回填 + 剔除 `always`
3. `runner.ts`：`pollControls` 纳入 approval；终态标记未决为 `expired`
4. `remote.ts` + IPC 四步：`cloud:approval:respond`；`cloud:run:status` 透出 `pendingControls`
5. `CloudApprovalCard` + `CloudTrace` 接入 + i18n
6. `cloudStore` 状态机 + `useCloudBridge` + 待审批提示
7. `audit.ts` + 收尾落账
8. 测试（§10）

**DoD**：`npm test` + `npm run lint` + `npm run type-check` 绿；mock 帧下卡片能出、能点、能回填、能过期；`design-system.test.ts` 绿。

### 阶段 1：服务端收严 + 抓真帧（由实现者直接执行，回滚 30 秒）

1. `cp config.yaml config.yaml.bak-approval-<ts>`
2. 改（最小 patch，**只 4 个键**）：
   - `approvals.mode: manual`
   - `approvals.timeout: 120`
   - `approvals.cron_mode` / `single_query_mode` / `unattended_mode: deny`
   - `agent.disabled_toolsets: [code_execution]` ← **唯一一处非默认**
   - `approvals.deny` **保持空**（决策 5）
3. 复核：`/api/config` 读回一致；`/v1/toolsets`（`code_execution` 应为 off；其余 26 个不动）
4. **探针 ②**：让 Agent 跑 `bash -c "echo probe"`（命中「`-c` 脚本执行」危险模式；被批准也无害），抓 `approval.request` 与 `pending_controls` 原样留档 `cache/probe/frames/`
5. 两种回执语义各试一次，确定口径并回填 §3.3
6. 回滚：恢复备份 + 重启 gateway（`hermes-gateway`）

### 阶段 2：原生档位切换

1. `policy.ts`（白名单子集读 + 最小 patch 写 + 读回复核）
2. IPC 四步：`cloud:policy:get` / `cloud:policy:set`
3. `CloudModeSwitch` + 二次确认 + 生效说明 + 模式变更审计
4. 首次空 patch 验证（§6.3 最后一行）
5. 测试

---

## 9. 风险与未知

| 编号 | 未知 / 风险 | 处理 |
| --- | --- | --- |
| R1 | 回执到底是 `{choice}` 还是 `{request_id, execution_generation, choice}`；`approval.request` 是否真不带 `request_id` | **已关闭（2026-11-06 实测）**：canonical 生效；`approval.request` 只带 `prompt_id`。代码仍保留「能带就带 + 兜底」 |
| R2 | `pending_controls` 里 approval 的字段名 | **已关闭**：`{kind:'approval', prompt_id, execution_generation, command, description, choices}`（无 `pattern_*` / `timeout_s`） |
| R3 | `PUT /api/config` 是否会重写 YAML（丢注释 / 顺序） | **已执行**：patch 返回 `{"ok":true}` 且读回一致；注释能否保留需登服务器才知道（本机只能经 HTTP，故未断言） |
| R4 | `GET /api/config` 返回解析后的密钥 | 铁律：主进程读、只取白名单子集、**永不回传整份** |
| R5 | 多端同时审批同一请求 | 服务端以 `stale_generation` / `approval_not_pending` 拒绝；本地按 409 处理并重拉状态 |
| R6 | 审批期间 SSE 断线 | 卡片可点（HTTP 不依赖流）；15s 状态轮询兜底（`waiting_for_approval` + `pending_controls` 已实测） |
| R7 | **纯 `sudo` 不在危险模式表里**，`write_file`/`patch` 无审批路径（决策 5 的代价） | 接受并在连接页「当前策略」处一句话说明；不额外造 deny 清单 |
| R8 | 阶段 0 合入时服务端仍是 `off` → 卡片不会出现 | **已解除**：2026-11-06 已把服务端拨到 `manual`（`timeout: 120`、三子模式 `deny`、`disabled_toolsets: [code_execution]`），并抓帧验证 |

---

## 10. 测试矩阵

| 文件 | 覆盖 |
| --- | --- |
| `tests/cloud-map.test.ts` | 真实字段映射；`always` 被剔除；`ensureApproval` 去重；`approval.responded` 三级回填；无 `request_id` 时用 `runId` |
| `tests/cloud-runner.test.ts` | `pollControls` 同时补 clarify + approval；终态把未决标 `expired` |
| `tests/cloud-agent-ipc.test.ts` | `cloud:approval:respond` 只接受三个 choice；`requestId`/`generation` 可选但类型严格；`cloud:policy:set` 值白名单；`cloud:run:status` 输出不含多余字段 |
| `tests/cloud-store.test.ts` | 卡片状态机（pending → decided / expired）；回执失败回退可点；`pendingControls` 去重合并 |
| `tests/cloud-view.test.tsx` | 三按钮、无 `always`、倒计时文案、禁用态、`waiting_approval` 指示、待审批提示 |
| `tests/cloud-policy.test.ts`（新） | 白名单子集提取（不夹带密钥、`deny` 只留条数）；patch 形状只含 `approvals.mode`；读回不一致报错 |
| `tests/design-system.test.ts` | 卡片 / 控件只用 token，无硬编码色、无 `uppercase` 等 |

---

## 11. 验收映射

| 验收 | 覆盖 | 备注 |
| --- | --- | --- |
| AC-03 命令级审批（拒绝 → run 继续不重试 → 审计有记录） | 阶段 0 + 1 | |
| AC-04 审批超时（自动 deny，审计有记录） | 阶段 0 + 1 | `timeout: 120` |
| AC-16 审批不被后端关掉 | 阶段 2 | `deny` 保持空 → **部分满足**：危险模式会问，纯 `sudo` 不问（见 R7） |
| AC-17 `execute_code` 已禁用 | 阶段 1 | 唯一非默认项 |
| AC-22 整机权限可用（先拦再放行） | 阶段 1 第 4 步 | 用 `systemctl stop xxx` 类命令试 |
| AC-18 / AC-21 策略可回滚 / 被改可发现 | **降级** | 只保证「档位显示 = 服务端真值」 |

---

## 12. 安全约束（实施时必须守住）

1. `GET /api/config` 只在主进程解析，只把白名单子集交给渲染层；任何日志、审计、错误信息里不出现密钥。
2. 档位切换只允许写 `approvals.mode` 一个键；写入前做值白名单校验；写后读回复核。
3. 放宽档位必须二次确认；收紧不确认。
4. 回执只允许 `once` / `session` / `deny`；`always` 在映射层丢弃。
5. 审计只写命令摘要（≤200 字）+ 规则，不落全文；`approvals.deny` 只在内存里计数，不落内容。
6. 失效即拒绝：拿不到 `pending_controls`、通道异常、回执超时——一律按「将自动拒绝」呈现，**不自动重试**（`S-05`）。
7. 不切 `platform_toolsets`、不动 `terminal.backend`、不加 deny 清单（决策 4/5）。

---

## 13. 实施记录（2026-11-06，阶段 0 + 2）

| 位置 | 落地内容 |
| --- | --- |
| `electron/cloud/types.ts` · `src/types/cloud.ts` | `CloudApprovalChoice`（`once`/`session`/`deny`，无 `always`）、`CloudApprovalMode`、`CloudApprovalPolicy`（白名单子集）、审批片段的真实字段（`requestId`/`generation`/`patternKeys`/`choices`/`timeoutSeconds`/`expiresAt`/`decision`/`settled`） |
| `electron/cloud/map.ts` | `ensureApproval()` 单点建卡（SSE 与 `pending_controls` 同一入口）；`approvalChoicesOf()` 剔 `always`；三级回填（id → 命令 → 唯一未决）；`expirePendingApprovals()` 在 `run.completed` / `failed` / `cancelled` 收尾 |
| `electron/cloud/remote.ts` | `respondApproval()`：能带就带 `request_id` + `execution_generation`，被 400 `invalid_params` 拒时回退 `{choice}` |
| `electron/cloud/client.ts` | `CloudApiError.backendCode` 保留服务端错误码（`stale_generation` / `approval_not_pending` …）并译成中文文案 |
| `electron/cloud/runner.ts` | `pollControls` 同时补 clarify + approval；`controlKindOf()` 按 `kind` 再按字段形状识别；`auditToolOutcome()` 在下一个终态工具卡补写审计结果 |
| `electron/cloud/audit.ts`（新） | `data/cloud-agent/audit.jsonl` 追加 + `fsync`；命令摘要 ≤200 字 |
| `electron/cloud/policy.ts`（新） | `GET /api/config` → 白名单子集（不夹带密钥）；`writeApprovalMode()` 只发 `{"config":{"approvals":{"mode":…}}}` 并读回复核 |
| `electron/ipc/cloud-agent.ts` | `cloud:approval:respond`（白名单 + 审计）、`cloud:policy:get` / `policy:set`（档位变更记审计）、`cloud:run:status` 透出脱敏后的 `pendingControls` |
| `src/store/cloudStore.ts` | 审批状态机（乐观决定 → 失败回退；「已在别处结算」→ `settled` 不再可点）、`expireApproval`、`loadPolicy` / `setMode`（显示永远跟服务端读回） |
| `src/components/CloudApprovalCard.tsx`（新） | 命令 + 命中规则 + 三按钮 + 倒计时；超时置灰；已结算另说；无 `always` |
| `src/components/CloudModeSwitch.tsx`（新） | 三档原生控件；收紧一键、放松二次确认；未知档位只说「未知」不覆盖 |
| `src/components/CloudSessionView.tsx` | 滚动上翻时不抢视口，只在输入框上方亮「有待审批」；底部状态栏挂档位控件 |
| `src/components/CloudTrace.tsx` | 审批片段渲染成卡片（原来是 `run_error` 分隔线） |

### 13.2 真机复盘修掉的两个缺陷（2026-11-06 晚）

第一次真机点「本次允许」后，审计只写了决定行、**没有结果行**。实测定位到两处：

1. **审计写得太晚**：决定行原来写在「回执成功 → 再 GET 一次 `/api/config` 拿档位」之后。那是一次网络往返，而服务端在回执成功后立刻执行工具、推 `tool.completed` —— 结果行先到，`pendingByRun` 里还没有这条决定，于是配不上。
   改法：回执一成功就落盘，档位用内存缓存（`cachedPolicyMode`，由 `cloud:policy:get/set` 维护），刷缓存异步做。
2. **回执字段**：`{choice}` 与 `{request_id, choice}` 都是 `400 invalid_params`，三个字段缺一不可；缺 `execution_generation` 时由主进程用 `GET /v1/runs/{id}` 补。

3. **被拒绝的结果是空白**：Hermes 记录被拦下的调用时 `output` 是空串，原因全在 `error` 里（`BLOCKED: Command denied by user. …`）。历史映射现在 `output || error` 兜底，工具卡与审计结果行都能看到真实原因。

4. **结果行没有内容**：实时 `tool.completed` 的 `preview` 一直是空串，真结果只在历史里。现在空预览先不落盘（只记住 `error`），等这一轮收尾重拉历史补上；历史也没有内容时才写一行只有 `error` 的，宁缺毋滥。

顺带加固：结果行按 **`toolCallId`** 对号（审批总是紧跟在它拦下的那次 `tool.started` 之后），实时流和历史纠正帧（`reconcile`）都参与配对 —— 断流时结果只从历史回来，也不能把「真实结果」这一问丢掉。

**待做**：UI 截图验收（Paper / Ink × 1024 / 1440）。

### 13.1 已对服务端做的改动（可原样回滚）

2026-11-06 执行，读回复核通过；`/v1/toolsets` 里 `code_execution.enabled=false` 立即生效（无需重启网关）。

```jsonc
// PUT {dashboard}/api/config
{ "config": {
    "approvals": { "mode": "manual", "timeout": 120,
                   "cron_mode": "deny", "single_query_mode": "deny", "unattended_mode": "deny" },
    "agent": { "disabled_toolsets": ["code_execution"] } } }
```

改动前：`mode: off`、`timeout: 300`、三个子模式 `off`、`approvals.deny: []`、`agent.disabled_toolsets: []`、`terminal.backend: local`。

回滚（等价于界面里点「完全不问」，但不用装客户端）：

```jsonc
{ "config": { "approvals": { "mode": "off", "timeout": 300,
                             "cron_mode": "off", "single_query_mode": "off", "unattended_mode": "off" },
              "agent": { "disabled_toolsets": [] } } }
```

已单独验证过**最小 patch 不破坏其它键**（只发 `{"config":{"approvals":{"mode":"manual"}}}`，`timeout` / `cron_mode` / `disabled_toolsets` / `terminal.backend` 全部原样），所以策略层日常只发这一个键。
