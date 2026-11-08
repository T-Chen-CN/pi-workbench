# Pi Workbench 工作区派活（H3）方案

> **面向**：实现或改动「云端 Agent 派活到本地工作区」的人
> **什么时候读**：动网关插件的 dispatch / 中继、桌面的派活 worker、权限与审计之前
> **什么时候要改**：协议、权限模型、状态机或验收场景变化时

**状态**：设计定稿，P1 未开工（2026-11-08）
**范围**：云端 Hermes 主动调起本地工作区 Agent、下达指令、接收结果、多轮跟进直到任务落地
**不包含**：屏幕接管（C-08）、Kanban（C-09）、IM 渠道（C-11）、对外写 MCP 门（C-12）
**上游事实出处**：Hermes 0.23.0 源码（`/home/ubuntu/.hermes/hermes-agent`）；网关现状见 [CLOUD_AGENT](./CLOUD_AGENT.md)

---

## 1. 目标与非目标

### 1.1 一句话

云端 Hermes 是**项目经理**，本地工作区 Agent 是**工程队**：可以被叫起来干活、可以中途反问、可以被反复返工，直到用户的要求落地。

### 1.2 目标

1. 云端能**激活**一个当前没打开的本地工作区（不需要用户先动手），并在里面干真活。
2. 双方是**多轮会话**，不是一次性投递：本地能反问，云端能追问、纠偏。
3. 云端**持续跟进**直到任务落地；中途任何一方挂掉都要有明确结论，不能悬挂。
4. 全过程在桌面端**可见、可停、可回放**。

### 1.3 非目标

- 不做云端直接读本地文件树 / 传绝对路径（只看 Agent 的答复和相对路径列表）。
- 不做跨设备的任务迁移（任务绑死在 claim 它的设备上）。
- 不做派活任务的自动重试（失败如实回报，由 Hermes 决定要不要重派）。
- 不做本地逐条审批（见 §2）。

### 1.4 与云端 Agent 的关系

派活是云端 Agent 的**能力扩展**，不改现有链路：会话 / SSE / 审批 / 通知全部沿用。云端一侧只多出一组工具（`local_*`）与一个中继端点。

---

## 2. 角色与权限 `[确认]`

### 2.1 三段式

| 层 | 谁决策 | 范围 |
| --- | --- | --- |
| 执行期的一切 | **Hermes** | 用什么命令、改哪些文件、要不要换思路。本地 Agent 拿不准就问 Hermes，不问用户 |
| 人类 | **只在 Hermes 主动来问时** | 方案调整、执行方向确认、高风险细节 |
| 本地 Agent | 不决策 | 只执行 + 如实回报 |

一句话：**本地 Agent 的"用户"就是 Hermes；人类的身份是"Hermes 的委托人"，不是本地 Agent 的审批人。**

### 2.2 为什么不是逐条审批

逐条审批在这个场景里是**假安全**：人不在机器前，审批超时即拒绝，任务白跑；人在机器前，又等于替云端 Agent 干了一遍判断。真正的边界应该落在"这个工作区允不允许被派活"这一层一次性预授权。

### 2.3 边界清单

| 时机 | 手段 | 落点 |
| --- | --- | --- |
| 事前 | 工作区白名单（默认空）+ 派活总开关（默认关） | 桌面设置，落 `data/agent/dispatch.json` |
| 事中 | Hermes 自己的审批档位（`approvals.mode` = `manual` / `smart` / `off`）；它决定要不要问人 | 云端 config.yaml，既有能力 |
| 事后 | 本地写账本 + 派活会话可回放 + 变更文件列表 | 本地 audit + 会话记录 |
| 随时 | 一键停派活 / 中止当前任务 | 桌面 UI，立即生效 |

### 2.4 人类介入的建议触发点

写进派活工具的 description，供 Hermes 判断（不硬编码在代码里）：

- 要删除或覆盖**非本次任务产生**的文件；
- 要 `git push` / 改远端 / 改 CI；
- 要动工作区之外的东西；
- 任务范围和用户原话明显不一致；
- 连续两次同样的失败。

### 2.5 残余风险 `[确认]`

白名单里一旦开了派活，云端就真有写权限。**提示注入是第一威胁**：本地 Agent 读仓库内容时可能被里面的指令劫持，而派活会话没有本地审批门。缓解手段只有四条：白名单里别放生产目录、写账本、事后可回放、随时急停。这套模型接受该残余风险，不再加中间层。

---

## 3. 拓扑与名词

```
   用户 ── 对话 ──► 云端 Hermes（VPS，会话 + SSE + 审批）
                        │  工具调用（进程内直写 store）
                        ▼
                  hub.db（dispatch_tasks / device_workspaces）
                        │  中继：SSE 常连（hub → 设备）+ POST 回执（设备 → hub）
                        ▼
              桌面主进程 dispatch worker（本机，无需入站端口）
                        │  AgentManager（受信任工作区，可不在 UI 中打开）
                        ▼
                  本地工作区 Agent（派活会话，无本地审批门）
```

| 名词 | 定义 |
| --- | --- |
| 设备 | 一台装了 Pi Workbench 并完成配对的机器；`device_id` 由配对决定，已有心跳与撤销机制 |
| 工作区 | 设备上的一个受信任目录；派活目录里只有 `workspace_id`（本地生成、稳定）+ `label` + 描述，**不含绝对路径** |
| 派活会话 | 专为一次派活新建的本地会话；权限固定为"无本地审批门"，在 UI 里打标可点进去看 |
| 任务 | 一次派活的完整生命周期，对应 A2A 的 `Task`（`taskId` / `contextId` / `state`） |
| 中继 | 网关承担的转发层：把云端对某个 `device/workspace` 的调用，送到该设备的常连通道上 |

---

## 4. 协议

### 4.1 对外讲 A2A 语义 `[确认]`

任务信封与状态机照 A2A v1.0 写（不自创）：`TASK_STATE_SUBMITTED` / `WORKING` / `INPUT_REQUIRED` / `COMPLETED` / `FAILED` / `CANCELED`。这样将来任何 A2A 客户端都能对接网关，我们也不用发明状态语义。

参考实现（仅作先例，不引代码）：rsclaw 的 hub-spoke A2A 中继、A2A 规范的 streaming / async 章节、GitHub Actions self-hosted runner 的拉取式队列参数。

### 4.2 Agent Card

`GET /.well-known/agent-card.json`（管理密钥或 A2A bearer 认证），把**可派活工作区**投影成 skills：

```json
{
  "name": "pi-workbench",
  "description": "Pi Workbench 本地工作区集群：把任务派给某台机器的某个工作区，由该工作区里的编码 Agent 执行。",
  "protocolVersion": "1.0",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "skills": [
    {
      "id": "dev-legion/tyc-workbench",
      "name": "TChen-Legion / 唐辰的开发工作台",
      "description": "触发词：前端、Electron、React、TypeScript、测试、文档。该工作区是 Pi Workbench 主仓库。",
      "tags": ["code", "electron", "react"]
    }
  ]
}
```

**description 必须写触发词**：小模型（当前是 DeepSeek）靠描述选目标，只写名字会选错——这是 rsclaw 文档里明确踩过的坑。

`GET /v1/hub/dispatch/workspaces` 给同一份数据的扁平版（设备 → 工作区 → 可派活 / 在线 / 正在跑的任务数），供工具与目录 UI 使用。

### 4.3 Task 信封

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `taskId` | string | 网关生成（`dt_<uuid>`），全局唯一 |
| `contextId` | string | 云端会话的一条连续上下文；同一 `contextId` 下的任务按创建顺序排列，供 `a2a_history` 式回看 |
| `deviceId` / `workspaceId` | string | 目标；必须都在目录里且 `dispatchable=true` |
| `state` | enum | 见 §5.2 |
| `prompt` | string | 首轮指令（来自 Hermes 工具调用） |
| `question` | string? | `INPUT_REQUIRED` 时本地 Agent 的问题 |
| `answer` | string? | 云端对 `question` 的回答 |
| `summary` | string? | 终态摘要（给云端模型看的正文，长度上限 4000 字符） |
| `filesChanged` | string[] | **相对工作区根**的路径列表（上限 200 条）；绝不出现绝对路径 |
| `usage` | object? | 本地这一轮的 token 用量 |
| `localSessionId` | string? | 本地会话 id，供人点进去看；对云端只做展示，不参与逻辑 |
| `error` | string? | 失败原因（脱敏后的短文本） |
| `createdAt` / `deadlineAt` | int | 秒级时间戳 |

### 4.4 云端 → 网关 → 设备

**云端侧工具（进程内直写 store，不走 HTTP）**：

| 工具 | 语义 |
| --- | --- |
| `local_workspaces()` | 返回目录（设备 / 工作区 / 在线 / 可派活 / 忙闲） |
| `local_dispatch(workspace, prompt, context_id?)` | 入队并**阻塞等待**：拿到终态或 90s 超时即返回 |
| `local_task_get(task_id)` | 读当前状态（超时返回 `WORKING` 后用它续查） |
| `local_task_reply(task_id, answer)` | 回答 `INPUT_REQUIRED`，让本地同一轮继续 |
| `local_task_cancel(task_id)` | 取消（在工具边界生效） |

工具返回给模型的是**短文本 + 结构化摘要**，不是原始日志：正文摘要 ≤ 4000 字符，文件列表 ≤ 200 条。

**中继通道（设备侧长连）**：

| 方向 | 端点 | 内容 |
| --- | --- | --- |
| hub → 设备 | `GET /v1/hub/relay/stream`（SSE，设备 token） | `task.assigned` / `task.cancel` / `ping`（25s 一次） |
| 设备 → hub | `POST /v1/hub/relay/report`（设备 token） | `task.claimed` / `task.progress` / `task.question` / `task.done` / `task.failed` |
| 设备 → hub | `POST /v1/hub/workspaces`（设备 token） | 上报工作区清单与派活开关，随心跳一起刷新 |

**为什么不用 WebSocket**：网关是纯标准库 `ThreadingHTTPServer`（`hub/server.py:39`），已有 `StreamResponse` 做 SSE（`hub/router.py:61`），WS 要自己写握手与帧；SSE 语义上等价，且桌面侧已有 SSE 客户端实现可复用。

**为什么不用上游 A2A 客户端**：`plugins/platforms/a2a/tools.py:172` 的 `a2a_call` 只发一次 `SendMessage`、默认超时 120s、没有 `GetTask` 轮询，遇到 `input-required` 只是让模型再调一次。长任务与续跑都必须由我们自己的工具实现。

### 4.5 超时与重投参数

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 工具阻塞上限 | 90s | 低于上游 120s 默认超时，避免工具调用被掐断 |
| 设备中继 ping | 25s | 让中间层与 NAT 不回收连接 |
| 任务租约 | 120s | claim 后无 `task.progress` / 心跳即视为失联，可重投（`attempt ≤ 2`） |
| 任务总超时 | 10 分钟 | 远低于 `agent.gateway_timeout`（30 分钟） |
| 每设备并发 | 1 | 一个工作区一次只跑一件事，避免并发写同一棵树 |
| 每设备队列 | 5 | 超出直接拒绝并告知云端 |
| 任务记录保留 | 7 天 | 定时清理；审计行长期保留 |

### 4.6 错误码

| code | 场景 | 模型看到的话 |
| --- | --- | --- |
| `dispatch_disabled` | 网关或设备侧开关关闭 | 派活未开启（在哪开） |
| `no_workspace` | 目标工作区不在目录 / 不可派活 | 该工作区不可派活 |
| `device_offline` | 设备离线 | 设备离线，稍后再试 |
| `busy` | 该设备已有任务在跑 | 该设备正忙 |
| `queue_full` | 队列已满 | 队列已满 |
| `expired` | 超过 `deadlineAt` | 超时未完成 |
| `canceled` | 被取消 | 已取消 |
| `too_many_runs` | 本地会话并发上限 | 本地无空闲 |

---

## 5. 数据与状态

### 5.1 `hub.db` schema v2

`SCHEMA_VERSION` 1 → 2，新增三张表（沿用现有 `CREATE TABLE IF NOT EXISTS` + `schema_meta` 迁移方式）：

```sql
CREATE TABLE IF NOT EXISTS dispatch_tasks (
  task_id          TEXT PRIMARY KEY,
  context_id       TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  state            TEXT NOT NULL,
  question         TEXT,
  answer           TEXT,
  summary          TEXT,
  files_changed    TEXT,
  usage            TEXT,
  error            TEXT,
  local_session_id TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  deadline_at      INTEGER NOT NULL,
  claimed_at       INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dispatch_state ON dispatch_tasks (state, device_id);

CREATE TABLE IF NOT EXISTS dispatch_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_events ON dispatch_events (task_id, id);

CREATE TABLE IF NOT EXISTS device_workspaces (
  device_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL,
  dispatchable INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, workspace_id)
);
```

`files_changed` / `usage` 存 JSON 字符串。事件表只保留最近 200 条/任务，超出即删最旧。

### 5.2 状态机

```
queued ──claim──► running ──┬── done        → completed
  │                          ├── question    → input_required ──reply──► running
  │                          └── failed      → failed
  ├── deadline 到期 ──► expired
  └── cancel ──► canceled
```

- **claim 必须原子**：`UPDATE dispatch_tasks SET state='running', claimed_at=?, attempt=attempt+1 WHERE task_id=? AND state='queued'`，`rowcount=0` 表示被别人抢走。
- **`input_required` 不是终态**：本地会话挂住不结束（见 §7.2），云端 `local_task_reply` 后回到 `running`；超过 `deadlineAt` 仍无回答则 `expired`，本地那一轮被 abort。
- **终态不可逆**：进入 `completed` / `failed` / `canceled` / `expired` 后不再接受任何回报（重复回报记事件、回 200 但不改状态）。

---

## 6. 组件改动清单

### 6.1 网关插件（`pi-workbench-gateway`，Python 标准库）

| 文件 | 改动 |
| --- | --- |
| `hub/db.py` | schema 2 + 三张新表 + 迁移 |
| `hub/dispatch.py` | 新增：任务 store、状态机、claim 原子性、目录读写、事件清理 |
| `hub/a2a.py` | 新增：Agent Card 生成、`SendMessage` / `GetTask` / `SubscribeToTask` 的薄映射（JSON-RPC 信封） |
| `hub/routes/a2a.py` | 新增：`/.well-known/agent-card.json`、`POST /a2a`、`GET /v1/hub/dispatch/workspaces` |
| `hub/routes/relay.py` | 新增：`GET /v1/hub/relay/stream`（SSE）、`POST /v1/hub/relay/report`、`POST /v1/hub/workspaces` |
| `hub/routes/__init__.py` | 注册新路由 |
| `tools.py` | 新增：`local_workspaces` / `local_dispatch` / `local_task_get` / `local_task_reply` / `local_task_cancel`，toolset `pi_workbench`；`check_fn` 在开关关闭时让工具不可见 |
| `shim.py` | `register(ctx)` 里注册工具（**保持 shim 极薄**：只做注册与 store 注入） |
| `adapter.py` | `connect()` 里把 store 实例挂到模块级，供工具 handler 使用（同进程，不另开服务） |
| `plugin.yaml` | 版本 0.1.2 → 0.2.0（新增能力，非补丁）；`tools` 声明 |
| `docs/CONTRACT.md` | 新增 dispatch 与 relay 端点表 |

约束：hub 包**仍然不知道 Hermes 存在**（`hub/*` 不 import `gateway.*` / `plugins.*`）；工具与 store 的粘合只在 `shim.py` / `tools.py` 里。

### 6.2 桌面端

| 文件 | 改动 |
| --- | --- |
| `electron/dispatch/store.ts` | 新增：`data/agent/dispatch.json`（开关、白名单、每工作区 description）读写的原子写封装 |
| `electron/dispatch/worker.ts` | 新增：中继 SSE 常连、心跳、claim 接收、执行、回报、重连退避、急停 |
| `electron/dispatch/executor.ts` | 新增：用 `agent:initialize`（受信任目录即可）→ `createSession` → 固定"无本地审批门" → `chat()` → 收集摘要 / 变更文件 / usage |
| `electron/ipc/dispatch.ts` | 新增 IPC：`dispatch:config:get/set`、`dispatch:workspaces:list/add/remove`、`dispatch:stop`、`dispatch:state` |
| `electron/ipc/register.ts` | 注册上述域（**必须走 `handleIpc()`**） |
| `electron/preload.cts` · `src/types/electron.d.ts` · `src/api/dispatch.ts` | 四步打通 + Web mock |
| `electron/main.ts` | 启动时按开关拉起 worker；退出时停 worker（`will-quit` 收尾链里加一步） |
| `src/components/CloudConnectionView.tsx` | 新增「派活」分组：总开关、工作区白名单、每工作区描述、当前任务与急停 |
| `src/components/CloudSessionView.tsx` | 派活会话打标（谁派的、`taskId`），可点进去看 |
| `src/store/dispatchStore.ts` | 新增：配置与运行态（不进 cloudStore） |
| `src/i18n/translations.ts` | 文案（zh + en） |

约束：落盘走 `electron/atomic-json.ts`；路径校验用 `realpath` + `path.relative`（`electron/workspace-trust.ts`）；派活会话的权限**不走** `approvalBroker`（否则会 fail-closed 挂死）。

### 6.3 文档

`docs/README.md` 索引 + `BACKLOG` 行状态 + `STATUS` 一行 + `CLOUD_AGENT §9.4` 的 H3 行改为指向本文。

---

## 7. 时序

### 7.1 P1：单向派活（阻塞等结果）

```
用户 → Hermes：让本地那个工作区把 X 做了
Hermes → local_dispatch(workspace, prompt)
  ├ queue 里落一条 queued
  ├ 中继 SSE 推送 task.assigned 给设备
  ├ 设备 claim（原子）→ 回报 task.claimed → 桌面起派活会话执行
  ├ 设备 task.done(summary, filesChanged, usage)
  └ 工具在 ≤90s 内返回摘要 → Hermes 继续对话（用户看到结果）
超时：工具返回 state=working + taskId，Hermes 用 local_task_get 续查或先答复用户
```

### 7.2 P2：本地反问（`input_required` 挂起）

```
本地 Agent 判断信息不足 → 该轮不结束，回报 task.question（state=input_required）
  ├ Hermes 的 local_dispatch 返回「需要你的决定：…（taskId）」
  ├ Hermes 判断自己能定 → local_task_reply(taskId, 答案) → 设备把答案作为该轮输入继续
  └ Hermes 判断该问人 → 在自己会话里问用户 → 用户回答 → 再 local_task_reply
```

关键：本地会话**不结束**（运行时保持"等待外部输入"状态），答案作为同一轮的下一段输入；这样多轮语义靠"同一个本地 sessionId + 同一条云端 session"维持，不需要起新会话。

---

## 8. 分期与验收

| 期 | 内容 | 估量 |
| --- | --- | --- |
| **P1** | 目录 + 单向派活 + 阻塞等结果 + 审计 + 急停 | 插件 ~1000 行 / 桌面 ~900 行 / 测试 ~900 行，5–7 人日 |
| **P2** | `input_required` 续跑 + 断线重连（`SubscribeToTask`）+ 租约重投 | +2–3 人日 |
| **P3** | 多设备路由调优（description）、外部 A2A 客户端互操作、push webhook | +2–3 人日 |

### 8.1 P1 验收场景（必须手打）

| # | 步骤 | 预期 |
| --- | --- | --- |
| D1 | 云端会话里说「让本地 Tyc 工作区把 README 里的测试命令跑一遍」 | 工具被调用；本地出现派活会话并真的执行；云端拿到摘要与变更列表 |
| D2 | 关掉派活总开关后再派 | 工具不可见或明确回 `dispatch_disabled`，不出现排队任务 |
| D3 | 只勾选 A 工作区，要求派到 B | B 不在目录里；工具回报 `no_workspace` 并列出可用工作区 |
| D4 | 关掉桌面（或用掉线设备）后派活 | 90s 内返回 `device_offline`/`working`，用户看到明确说明，无悬挂任务 |
| D5 | 派活进行中在桌面点急停 | 本地会话 abort；任务 `canceled`；云端拿到 canceled 并告知用户 |
| D6 | 查两端审计 | 本地 `audit.jsonl` 与 hub `audit_events` 各有一条派活记录；7 天后任务行被清理、审计行保留 |

### 8.2 P2 验收场景

| # | 步骤 | 预期 |
| --- | --- | --- |
| D7 | 指令故意含糊（"把那个删了"） | 本地 Agent 反问；云端自己决定或问用户；回答后同一轮继续并完成 |
| D8 | 执行中断网（拔网线 30s） | 中继重连、任务状态不丢；云端的 `local_task_get` 能拿到真实状态 |
| D9 | 设备在 claim 后失联 | 租约到期重投（`attempt=2`）；同一任务不被两台设备同时执行 |

---

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 长任务撞 `agent.gateway_timeout`（30 分钟） | 任务总超时 10 分钟；工具单次阻塞 90s |
| 同一工作区并发写 | 每设备并发 1 + 队列上限；派活会话只跑在指定工作区 |
| 桌面休眠 / 关机导致任务悬挂 | 租约 120s + 重投；超过 `deadlineAt` 判 `expired` 并把原因交给云端 |
| 提示注入 | 白名单 + 写账本 + 会话可回放 + 一键急停（§2.5 已接受残余风险） |
| 云端模型选错工作区 | 每个工作区的 `description` 必写触发词；`local_workspaces` 返回忙闲与在线状态 |
| 记录膨胀 | 任务 7 天清理、每任务事件上限 200 条、摘要 4000 字符、文件列表 200 条 |
| 任务状态与本地实际不一致 | 本地回报是唯一真相；网关不改写终态；重复回报只记事件 |

---

## 10. 不做清单

- WebSocket 中继（stdlib 代价高，SSE 够用）
- 跨设备任务迁移 / 负载均衡
- 云端直接读本地文件树或绝对路径
- 派活任务自动重试
- 本地逐条审批与永久授权（`always` 一律禁止）
- 派活任务与用户会话争抢同一工作区（并发 1 直接避免）

---

## 11. 决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 权限主体 | Hermes 代行，人只管白名单 | 逐条审批在无人值守时是假安全（§2.2） |
| 对外协议 | A2A 语义（Task / contextId / input-required） | 有成熟先例与规范，不自创状态机 |
| 传输 | hub 中继 + SSE + POST 回执 | 网关是 stdlib，WS 成本高；SSE 已有实现 |
| 云端工具 | 自研 `local_*` | 上游 `a2a_call` 单次、120s、无 `GetTask` |
| 等待机制 | 工具阻塞 90s + `local_task_get` 续查 | 不依赖上游"会话注入"（api_server 明确 `supports_async_delivery=False`） |
| 反问机制 | `input-required`，本地同一轮挂起 | 比"结束一轮再起一轮"干净，上下文不丢 |
| 发现 | Agent Card skills + 目录表 | 与 A2A 生态兼容；描述驱动路由 |
| 存储 | `hub.db` sqlite | 任务需跨网关重启存活 |
| 取消 | 工具边界生效 | 与上游语义一致，不强杀进行中的工具 |

---

## 12. 参考

**外部先例**

- rsclaw「A2A v1.0 + hub-spoke relay」：spoke 只保留一条出站长连，hub 公网 A2A 端点按 `agentId` 路由；`SendMessage` 阻塞到终态、`SubscribeToTask` 断线续订、`input-required` 挂起后同 `taskId` 续跑、push webhook（HMAC + 3 次退避）、ed25519 身份与 per-spoke scopes。本文的拓扑与语义基本照此。
- A2A 规范 `Streaming and Async`：长任务三种交付（阻塞 / SSE / webhook）。
- GitHub Actions self-hosted runner：长轮询 50s、分配后 60s 无人接则重投、排队 24h 失败——本文的中继与租约参数参考其经验。

**本地事实出处**

- `gateway/platforms/api_server.py:1039`（`supports_async_delivery = False`）
- `gateway/wake.py:154`（非推送适配器需原始 session_id 自投递）
- `hermes_cli/plugins.py:463`（`register_tool` 签名）、`:607`（`post_message`）、`:935`（`register_hook`）
- `plugins/platforms/a2a/tools.py:172`（`a2a_call` 一次性调用）、`:26`（`protocol.py` 的 Task 状态常量）
- 网关：`hub/server.py:39`（`ThreadingHTTPServer`）、`hub/router.py:61`（`StreamResponse`）、`hub/db.py`（schema 1）
