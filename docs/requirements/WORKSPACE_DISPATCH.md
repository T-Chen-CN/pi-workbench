# Pi Workbench 工作区派活（H3）方案

> **面向**：实现或改动「云端 Agent 派活到本地工作区」的人
> **什么时候读**：动网关插件的 dispatch / 中继、桌面的派活 worker、权限与审计之前
> **什么时候要改**：协议、权限模型、状态机或验收场景变化时

**状态**：设计定稿 + 可行性已实测 + **P1 已落地**（网关 0.2.0 / 桌面 0.8.0 开发版），端到端跑通（2026-11-08 定稿，2026-11-09 验证与实现）
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

### 2.1.1 进度只有一个出口 `[确认]`

```
用户 ──▶ 本地程序里的「云端 Agent 会话」──▶ 工作区 Agent（派活）
              ↑ 唯一跟进入口                  ↑ 干活的手
```

- 派活任务 = 云端 Agent 的一次工具调用，和它自己跑 `bash`、读文件同级，是它的**内部动作**。
- 完成 / 失败 / 反问只落在**工具返回值**里；下一步（继续、汇总、问用户）只由云端 Agent 决定。
- 所以：**不弹系统通知、不推送、不广播进度**。子任务跑完就弹提示只会打断人，真正的信息在
  云端 Agent 的汇总里。桌面「派活」卡片只是本地审计 + 急停入口，不承担进度通知。
- 例外只有「用户主动要看」：轨迹**可查**（`local_task_trace`），但绝不主动推。

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

**分级落地**：P1/P2 只实现内部工具与中继，**不暴露** Agent Card 与 `/a2a` JSON-RPC 端点（没有外部客户端要用，先少写 400 行）；对外兼容放在 P3，协议语义从第一天就按 A2A 写，所以 P3 只是加一层信封映射，不用改状态机。

参考实现（仅作先例，不引代码）：rsclaw 的 hub-spoke A2A 中继、A2A 规范的 streaming / async 章节、GitHub Actions self-hosted runner 的拉取式队列参数。

### 4.2 Agent Card（P3）

P1/P2 不实现本节；工具与目录 UI 直接读 store。P3 再加 `GET /.well-known/agent-card.json`（管理密钥或 A2A bearer 认证），把**可派活工作区**投影成 skills：

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
| `clientToken` | string | **幂等键**，调用方给的稳定值（默认 `<contextId 或 sessionId>:<轮次序号>`）。同一个 token 重复调用只返回同一个任务，不重复派活（§5.2） |
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
| `local_dispatch(workspace, prompt, client_token?, context_id?)` | 入队并**阻塞等待**：拿到终态或 90s 超时即返回；同 `client_token` 重放直接返回已有任务 |
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
| 工具阻塞上限 | 90s | **不是为了绕上游超时**（插件工具没有执行超时，实测阻塞 150s 正常）。定 90s 是为了让云端每次回来都能给用户一句进度，而不是长时间没回音 |
| 设备中继 ping | 25s | 让中间层与 NAT 不回收连接；上游自有 SSE 心跳是 10s，桌面 60s 空闲阈值依赖它（见 §13 ④） |
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
  client_token     TEXT NOT NULL,
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
-- 幂等：同一个调用方的 token 只能对应一个任务，重放直接拿回原任务
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_token ON dispatch_tasks (client_token);

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
- **幂等先于状态机**：入队先按 `client_token` 查（`INSERT ... ON CONFLICT(client_token) DO NOTHING`），命中就返回已有任务并走同样的等待逻辑。否则云端重试 / 双击会派两个活，两边同时改一棵树。

---

## 6. 组件改动清单

### 6.1 网关插件（`pi-workbench-gateway`，Python 标准库）

| 文件 | 改动 |
| --- | --- |
| `hub/db.py` | schema 2 + 三张新表 + 迁移 |
| `hub/dispatch.py` | 新增：任务 store、状态机、claim 原子性、幂等（`client_token`）、目录读写、事件清理 |
| `hub/relay.py` | 新增：每设备一条 `queue.Queue` 的扇出（上限 64，满则丢弃并在下帧补发目录） |
| `hub/routes/dispatch.py` | 新增：`GET /v1/hub/relay/stream`（SSE，连上重放 `queued`）、`POST /v1/hub/relay/report`、`POST /v1/hub/workspaces`、`GET /v1/hub/dispatch/workspaces`（**四个端点都在一个文件里**，没有单独的 `routes/relay.py` / `routes/workspaces.py`） |
| `hub/routes/a2a.py` | **P3 已落地**：`/.well-known/agent-card.json`、`POST /a2a`（`message/send` / `tasks/get` / `tasks/cancel` / `tasks/resubscribe`） |
| `hub/maintenance.py` | **P2 已落地**：后台线程做超时收尾、租约重投、7 天清理（`expire()` / `purge()` 的调用方） |
| `hub/frames.py` | 中继帧载荷与 SSE 编码的唯一出处（请求线程与维护线程共用） |
| `hub/routes/__init__.py` | 注册新路由 |
| `tools.py` | 新增：`local_workspaces` / `local_dispatch` / `local_task_get` / `local_task_reply` / `local_task_cancel`，toolset `pi_workbench`；开关关闭时工具仍可被调，但**直接返回** `dispatch_disabled`（隐掉工具会让模型以为能力不存在） |
| `shim.py` | `register(ctx)` 里注册工具（**保持 shim 极薄**：只做注册与 store 注入）。真实签名是 `register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False)`；`schema` 必须自带 `name`/`description`/`parameters` |
| `adapter.py` | `connect()` 里把 store 实例挂到模块级，供工具 handler 使用（同进程，不另开服务） |
| `plugin.yaml` | 版本 0.1.2 → 0.2.0（新增能力，非补丁）；`tools` 声明 |
| `docs/CONTRACT.md` | 新增 dispatch 与 relay 端点表 |

约束：hub 包**仍然不知道 Hermes 存在**（`hub/*` 不 import `gateway.*` / `plugins.*`）；工具与 store 的粘合只在 `shim.py` / `tools.py` 里。

**部署必须同时改一处配置**：`api_server` 平台的工具面是白名单（`platform_toolsets.api_server`），插件工具集默认不在里面，**不登记就永远调不到**（§13 ①）。两种写法：

- 手改 `config.yaml` 追加一项（推荐，最小改动）；
- `hermes --profile pi-cloud tools enable <toolset> --platform api_server`：会把整张白名单**规范化重写**（排序，并剔除被 `agent.disabled_toolsets` 关掉的项，实测 `code_execution` 被移除），不是纯追加。

新装 / 升版后必须重启 gateway 单元才会重新注册工具（§13 ①）。

**启动自检（必做）**：`register()` 里检查 `platform_toolsets.api_server` 是否包含我们的 toolset，不在就打一条显式 WARN，写清“派活工具对模型不可见”与要加的那一行。这个坑无声无息：插件装了、工具注册了、模型就是看不到，**不能只靠人记得**。只告警，**不自动改宿主的 `config.yaml`**（插件写宿主配置太危险）。

### 6.2 桌面端

| 文件 | 改动 |
| --- | --- |
| `electron/dispatch/config.ts` | 新增：`data/agent/dispatch.json`（开关、白名单、每工作区 description）的原子写封装；`workspaceIdFor`（路径 sha1 前 12 位）、`restoreDispatchTrust`、`publicWorkspaces`（不含路径） |
| `electron/dispatch/relay.ts` | 新增：出站 SSE 常连（退避 1s→30s，空闲 90s 判死）、`publishWorkspaces`、`reportTask` |
| `electron/dispatch/ledger.ts` | 新增：本机账本 `data/agent/dispatch-ledger.json`（最近 20 条，回答「这个任务动了哪个工作区、对应哪条本地会话」） |
| `electron/dispatch/worker.ts` | 新增：中继 SSE 常连、心跳、claim 接收、执行、回报、重连退避、急停 |
| `electron/dispatch/executor.ts` | 新增：用 `agent:initialize`（受信任目录即可）→ `createSession` → 固定"无本地审批门" → `chat()` → 收集摘要 / 变更文件 / usage |
| `electron/ipc/dispatch.ts` | 新增 IPC：`dispatch:config:get/set`、`dispatch:workspace:add/update/remove`、`dispatch:stop`、`dispatch:state`（全部走 `handleIpc()`） |
| `electron/preload.cts` · `src/types/electron.d.ts` · `src/api/dispatch.ts` | 四步打通 + Web mock |
| `electron/main.ts` | 启动时按开关拉起 worker；退出时停 worker（`will-quit` 收尾链里加一步） |
| `src/components/DispatchCard.tsx` | 新增：云端页里的「派活」卡片（总开关、白名单与描述、发布状态、当前任务与急停、最近任务），挂进 `CloudConnectionView` |
| `src/components/CloudSessionView.tsx` | **未做**：派活会话在云端会话列表里没有标记 —— 派活不产生云端会话，标记改由本机账本承担（见 §15 待办） |
| `src/store/dispatchStore.ts` | 新增：配置与运行态（不进 cloudStore） |
| `src/i18n/translations.ts` | 文案（zh + en） |

约束：落盘走 `electron/atomic-json.ts`；路径校验用 `realpath` + `path.relative`（`electron/workspace-trust.ts`）；派活会话的权限**不走** `approvalBroker`（否则会 fail-closed 挂死）。

两个实测得出的硬约束：

- **开机要把白名单写进信任表**：`agent:initialize` 只认 `trustedWorkspaceRoots`（内存 Set）。启动时对 `dispatch.json` 的每个工作区调 `trustWorkspace()`，否则未打开过的目录 initialize 直接被拒（§13 ⑫）。
- **中继流不占代理 SSE 槽位**：每设备 2 槽位的计数只属于 `routes/proxy.py`；`routes/relay.py` 自己计数（或干脆不限），否则两个会话在看流时设备收不到派活（§13 ⑪）。

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

落地方式（已验证可行）：本地 Agent 额外注册一个阻塞式工具（`ask_dispatch_operator`），它先回报 `task.question` 并把自己挂住，拿到云端答案后作为**该工具返回值**继续跑。`pi.registerTool` 的 `execute` 可以返回未完成的 Promise，`StallWatchdog` 在工具执行期间自动挂起、且没有整轮上限（§13 ⑩）。

---

## 8. 分期与验收

| 期 | 内容 | 估量 |
| --- | --- | --- |
| **P1** | 目录 + 单向派活 + 阻塞等结果 + 审计 + 急停（**不含对外 A2A 端点**） | 插件 ~850 行 / 桌面 ~900 行 / 测试 ~800 行，4–6 人日 |
| **P2** ✅ | `input_required` 续跑 + 断线重连（`SubscribeToTask`）+ 租约重投 | 已完成（插件 0.3.0，见 §15.6） |
| **P3** ✅ | Agent Card + `/a2a` JSON-RPC + `tasks/resubscribe`；多设备路由靠 description（已落地），push webhook 未做 | 已完成（同上） |

### 8.1 P1 验收场景（必须手打）

| # | 步骤 | 预期 |
| --- | --- | --- |
| D1 | 云端会话里说「让本地 Tyc 工作区把 README 里的测试命令跑一遍」 | 工具被调用；本地出现派活会话并真的执行；云端拿到摘要与变更列表 |
| D2 | 关掉派活总开关后再派 | 工具仍在，但明确回 `dispatch_disabled`，不出现排队任务 |
| D3 | 只勾选 A 工作区，要求派到 B | B 不在目录里；工具回报 `no_workspace` 并列出可用工作区 |
| D4 | 关掉桌面（或用掉线设备）后派活 | 90s 内返回 `device_offline`/`working`，用户看到明确说明，无悬挂任务 |
| D5 | 派活进行中在桌面点急停 | 本地会话 abort；任务 `canceled`；云端拿到 canceled 并告知用户 |
| D6 | 查两端审计 | 本地 `audit.jsonl` 与 hub `audit_events` 各有一条派活记录；7 天后任务行被清理、审计行保留 |
| D7 | 用同一个 `client_token` 连派两次 | 只有一个任务；第二次直接返回同一个 `taskId` 与它的状态 |

### 8.2 P2 验收场景

| # | 步骤 | 预期 |
| --- | --- | --- |
| D8 | 指令故意含糊（"把那个删了"） | 本地 Agent 反问；云端自己决定或问用户；回答后同一轮继续并完成 |
| D9 | 执行中断网（拔网线 30s） | 中继重连、任务状态不丢；云端的 `local_task_get` 能拿到真实状态 |
| D10 | 设备在 claim 后失联 | 租约到期重投（`attempt=2`）；同一任务不被两台设备同时执行 |

---

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 长任务撞 `agent.gateway_timeout`（30 分钟） | 任务总超时 10 分钟；工具单次阻塞 90s |
| **取消后设备仍在跑（实测确认）** | `/v1/runs/{id}/stop` 只取消云端那一轮：工具约 4s 内被中断返回，但设备侧**继续执行**（实测：云端 6.1s 已 `cancelled`，设备仍干满 78s）。因此工具被中断 / 抛异常时必须由我们**显式置 `canceled` 并发 `task.cancel`**，否则留下孤儿任务 |
| 中继流占满设备 SSE 槽位 | 每设备 2 条 SSE 槽位（`hub/routes/proxy.py:96`）只统计代理流；中继流必须**独立计数**，否则两个会话在看流时设备收不到派活 |
| 同一工作区并发写 | 每设备并发 1 + 队列上限；派活会话只跑在指定工作区 |
| 桌面休眠 / 关机导致任务悬挂 | 租约 120s + 重投；超过 `deadlineAt` 判 `expired` 并把原因交给云端 |
| 提示注入 | 白名单 + 写账本 + 会话可回放 + 一键急停（§2.5 已接受残余风险） |
| 云端模型选错工作区 | 每个工作区的 `description` 必写触发词；`local_workspaces` 返回忙闲与在线状态 |
| 记录膨胀 | 任务 7 天清理、每任务事件上限 200 条、摘要 4000 字符、文件列表 200 条 |
| 任务状态与本地实际不一致 | 本地回报是唯一真相；网关不改写终态；重复回报只记事件 |

---

## 10. 不做清单

- WebSocket 中继（stdlib 代价高，SSE 够用）
- **push webhook / 外部推送**：进度出口只有云端会话（§2.1.1）；A2A 的
  `pushNotificationConfig` 地址只能由第三方客户端提供，当前没有调用方
- **派活完成的强提醒（系统通知 / IM 推送）**：结果由云端 Agent 汇总，子任务完成不值得打断用户
- **逐条 trace 实时直播**：默认不推，需要时按需查（`local_task_trace` / `tasks/get` + `include:["trace"]`）
- 跨设备任务迁移 / 负载均衡（**永久不做**：工作区 = 一台机器的一个目录，换设备等于换任务，
  本地未提交改动 / 依赖 / git 状态全不相同，还会掩盖真实状态）
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

---

## 13. 可行性验证记录（2026-11-09 实测）

方案定稿后做了一轮**真机验证**：VPS 上装一个临时的 spike 插件（工具 + sqlite 状态机 + SSE 中继 + A2A 端点），用一个 Python "设备"代替桌面端，跑真实的 `/v1/runs`；桌面侧用真实 SDK + 假 provider 跑无窗口会话。全部临时物已清理，gateway 已回到 0.1.2 生产状态。

| # | 待验假设 | 怎么验的 | 结果 | 对方案的影响 |
| --- | --- | --- | --- | --- |
| ① | 插件注册的工具能被模型看见并调用 | 临时插件注册 `spike_dispatch`（toolset `pi_dispatch_spike`），登记进 `platform_toolsets.api_server`，重启 gateway，真实调用 | **成立**。模型先 `tool_describe`，再调 `spike_dispatch`；不登记工具集时插件工具**完全不可见**（白名单语义） | §6.1 增加"部署必须登记工具集"这一步；`hermes tools enable` 会重写整张白名单（实测剔除了 `code_execution`），推荐手改 config |
| ② | 工具 handler 可以长时间阻塞 | 同一轮里阻塞 3s / 78s / **150s** 三档 | **成立**。插件工具**没有执行超时**（`execution_timeout` 只有内置注册路径才会传），150s 阻塞后正常返回，`run` 正常收尾 | 阻塞时长只由我们决定；90s 是 UX 选择而不是上游限制 |
| ③ | 阻塞期间云端 SSE 不掉线 | 阻塞期间抓原始字节 | **成立**。每 10s 一条 `: keepalive` 注释帧 | 桌面 60s 空闲阈值（`electron/cloud/events.ts:73`）安全；**但依赖这条心跳**，上游改掉必须同步调大 |
| ④ | 经公网反代（Caddy）的 SSE 不被缓冲 | 从公网域名 `hub.tchen-xiaoxiao.com` 跟 110s | **成立**。首帧 0–1s 到达，keepalive 间隔稳定 10.0s，无缓冲 | 中继走 Caddy 无需 `flush_interval` 特调 |
| ⑤ | 工具线程与本机 HTTP 线程共用 sqlite 不冲突 | 工具 enqueue + HTTP claim/report 交替写同一张表（WAL + `busy_timeout`） | **成立**。全程无 `database is locked` | `dispatch.py` 用 WAL + `busy_timeout=10000` + autocommit 即可 |
| ⑥ | 中继能实时把任务推给设备 | 设备侧 SSE 常连，工具入队后测到达 | **成立**。入队即达（同一秒内） | 目录 / 任务推送按 §4.4 实现 |
| ⑦ | A2A 风格 `SendMessage` 阻塞到终态 | 临时端点收 JSON-RPC，enqueue 后阻塞，设备回报后返回 Task | **成立**。返回 `status.state=COMPLETED` + artifacts | §4.1 的 A2A 兼容层可以真做，不是纸面 |
| ⑧ | 取消会不会连带停掉设备 | 云端 `POST /v1/runs/{id}/stop` | **不成立（重要）**。云端 6.1s 已 `cancelled`、工具 4s 内被中断，**设备仍在执行并干满 78s** | 工具中断时必须显式置 `canceled` + 下发 `task.cancel`，否则孤儿任务（§9） |
| ⑨ | 桌面能在没有渲染层、没有审批通道时跑完一轮真会话 | 真实 `AgentManager` + 假 provider：`initialize` → `createSession` → `setSessionPermission(auto)` → `chat()` | **成立**。工具（`write`）真的执行、文件真的落盘、`requestApproval` **调用 0 次** | §6.2 的 `executor.ts` 就是这条路；派活会话不需要任何窗口 |
| ⑩ | 本地能"挂住一轮"等云端回答（P2 的底座） | 读 SDK 能力 + 现有 `plan-extension.ts` 用法 + 看门狗实现 | **成立**。`pi.registerTool({ execute })` 可返回未完成的 Promise；`StallWatchdog` 在工具执行期间**自动挂起**且无整轮上限 | §7.2 的 `input_required` 用"阻塞式工具"实现，不必结束再起一轮 |
| ⑪ | 每设备 SSE 槽位是否够用 | 读 `hub/routes/proxy.py:96` 的 `sse_acquire(limit=2)` | **不够**。槽位只算代理流，2 条被会话流占满后，中继流要么被拒、要么挤掉会话 | 中继流用独立计数（§9） |
| ⑫ | 未打开的工作区能不能初始化 Agent | 读 `electron/ipc/agent.ts:111` + `workspace-trust.ts` | **成立，但要多一步**。`agent:initialize` 只认 `trustedWorkspaceRoots` 里的路径（内存 Set） | 开机时把派活白名单逐条 `trustWorkspace()`（白名单本身就是一次授权，与 §2.3 一致） |

### 13.1 当时没实测的三件事（后续进展）

1. **中继路由接进真 hub**：**已在 P1 落地后实测通过**（§15.3）。
2. **两台设备并发**：仍未跑真机；`running_count >= 1` 的拒派由插件单测覆盖（`tests/test_tools.py`），多设备路由按 `device/workspace` 精确匹配。
3. **P2 端到端**：仍未启动（P1 已完成，P2 未开工）。

### 13.2 这轮验证改掉的四处方案

1. §4.5 工具阻塞理由：从"绕上游 120s 超时"改成"UX 选择"（上游根本没有工具超时）。
2. §6.1 新增部署步骤：`platform_toolsets.api_server` 必须登记我们的工具集，且新装 / 升版后要重启 gateway。
3. §9 新增两条风险：取消后的孤儿任务、中继流与代理 SSE 的槽位冲突。
4. §7.2 明确 P2 的落地方式：本地用阻塞式工具等云端答案，而不是"结束一轮再起一轮"。

### 13.3 验证后定下的三处调整（2026-11-09）

1. **P1 不含对外 A2A 端点**（§4.1 / §4.2 / §6.1 / §8）：Agent Card 与 `/a2a` JSON-RPC 推到 P3。P1/P2 内部工具就够跑通全链路，少写约 400 行；协议语义仍按 A2A 写，P3 只加信封映射。
2. **工具集登记改成启动自检**（§6.1）：不登记就静默失效，这个坑只能靠一条显式 WARN 兜住；插件不自动改宿主配置。
3. **`local_dispatch` 加幂等键 `client_token`**（§4.3 / §5.1 / §5.2）：云端重放或双击不会派两个活。默认值 `<contextId 或 sessionId>:<轮次序号>`，store 用唯一索引兜底。

---

## 14. 上游升级后的复查清单

派活有三处**依赖 Hermes 内部行为**，升级上游（0.23 → 0.24 …）后必须各复查一次，任何一条变了都要改我们的实现：

| 依赖 | 怎么查 | 变了会怎样 |
| --- | --- | --- |
| 插件工具集必须登记进 `platform_toolsets.api_server` | `hermes --profile pi-cloud tools list --platform api_server`，看 `pi_workbench` 是否在列 | 工具对模型静默不可见（启动自检会报 WARN，但能力等于没了） |
| 运行中的工具不设执行超时 | 读 `tools/registry.py` 的 `register(... execution_timeout=...)`：插件走 `PluginContext.register_tool`，不传这个值 | 若某版开始给插件工具默认超时，90s 阻塞会被掐断，必须降阻塞时长并改用轮询 |
| 事件流每 10s 发 `: keepalive` | 阻塞期间抓 `/v1/runs/{id}/events` 原始字节 | 若心跳消失，桌面 60s 空闲阈值会误判断流（`electron/cloud/events.ts:73`），得调大阈值 |

---

## 15. P1 落地记录（2026-11-09）

### 15.1 交付内容

- **网关插件 0.2.1**（`pi-workbench-gateway`，`v0.2.0` → `v0.2.1` 加「关闭派活时清排队任务」，已部署到 VPS）：`hub/dispatch.py`、`hub/relay.py`、`hub/routes/dispatch.py`、`tools.py`、`hub/db.py`（schema 2）、`shim.py`（工具注册 + 启动自检）、`plugin.yaml`。插件侧 139 条单测。
- **桌面端**（本仓库）：`electron/dispatch/{config,relay,executor,worker,ledger}.ts`、`electron/ipc/dispatch.ts`、`src/api/dispatch.ts`、`src/store/dispatchStore.ts`、`src/components/DispatchCard.tsx`、preload / 类型 / `main.ts` 接线、i18n 文案。桌面侧新增 33 条单测（config / relay / worker / ledger / card / ipc）。
- **部署动作**（每台云端机器都要做一次）：`config.yaml` 的 `platform_toolsets.api_server` 追加 `- pi_workbench`，重启 gateway 单元。**手改，不用 `hermes tools enable`**（§13 ①）。

### 15.2 实现时补定的细节

| 细节 | 取舍 |
| --- | --- |
| 每设备并发 | 网关侧 `running_count >= 1` 直接拒派；桌面侧再排一次本地队列（串行执行）。两端各兜一次，因为设备可能收到重放帧 |
| 清单上报节奏 | 中继连上就报一次 + 每 30s 一次；重连成功后立刻补报（断线期间用户可能改了白名单） |
| 目录不存在的工作区 | **不从白名单删掉**，只在界面上标「目录已不存在」并把上报清单过滤掉。外接盘没挂上不该静默丢掉授权 |
| 急停 | 断中继 + `agent.abort` + **显式回报 `canceled`**（云端 stop 不会停设备，§13 ⑧），并把 `enabled: false` 落盘、排队任务逐个回报 `canceled`；急停后不自动重连，需要用户重新打开开关 |
| 关闭派活开关 | **等于停止本机派活**：队列逐条回 `canceled`、运行中的会话 `abort`、账本记「派活已关闭」，再上报不可派活并断中继。只断中继会留下仍在写文件的会话（实测模型把「派活已关闭」当成云端回答写进了文件） |
| 关闭派活时上报什么 | 上报**不可派活**的完整清单（`dispatchable: false` + 工作区仍在），不是空列表：云端模型再派时拿到「这个工作区没打开派活开关」，能据此请用户打开；空列表只能得到「这台机器上什么都没有」 |
| 关闭派活后的排队任务 | 网关在收到 `dispatchable: false` 时清掉该设备的 `queued` 任务（`cancel_pending`）。否则重连时重放，一条云端早已放弃的指令会在几分钟后突然执行 |
| 本机账本 | `data/agent/dispatch-ledger.json` 最近 20 条（任务 id / 工作区 / 结果 / 摘要 / 本地会话 id）。摘要单条上限 4KB，超过记 `truncated: true`；面板「最近任务」一行预览 + 点开看全文（旧行为是硬切 500 字且没有入口）。会话本身不带派活标记（那是 pi-bridge 的落盘格式，P1 不动） |
| 派活会话权限 | 固定 `auto` + `grants: []`，**不接 `approvalBroker`**；否则没有本地审批通道时会 fail-closed 挂死（§13 ⑨） |
| 回报里的 `localSessionId` | worker 兜底补：执行器忘了带也能落进上报与账本，云端据此把任务锚到本机会话 |

### 15.3 端到端实测（真网关 + 真云端模型）

做法：临时设备 `tmp-dispatch-probe`（配对发放 token，测试后 revoke）+ 真实 `DispatchWorker`（执行器用桩，只往临时仓库写文件）+ 从同一凭据发一条真实 `/v1/runs`，让模型自己选工具。

| 验证点 | 结果 |
| --- | --- |
| 中继接进真 hub（鉴权 / 路由 / 公网 Caddy） | **通过**：`GET /v1/hub/dispatch/workspaces` 回读到本机目录，`online: true`、`relayStreams: 1` |
| 中继流不占代理 SSE 槽位 | **通过**：派活中同时开 `/v1/runs/{id}/events`，中继始终保持 1 条（§13 ⑪ 的独立计数成立） |
| 模型能看见并调用插件工具 | **通过**：`tool_describe` → `local_workspaces` → `local_dispatch` → `local_task_get`，四步 `error: false` |
| 任务真的落到本机 | **通过**：`task.assigned` 帧到达，worker 状态 `runningTaskId=dt_95a72836…`，执行器真的写了文件 |
| 本机回报回到云端工具结果 | **通过**：`local_dispatch` 返回 `completed` + 摘要 + `files`，模型据此作答 |
| 本机账本 | **通过**：`recent[0]` = 该任务，状态 `completed`，带 `sessionId` |
| 白名单只能靠人点选扩张 | **通过**（单测）：`dispatch:config:set` 递陌生路径被丢弃；新增目录只走 `dispatch:workspace:add` 的系统对话框 |
| 撤销设备后目录立即失效 | **通过**：`revoke` 后 `device_workspaces` 被清空（`drop_device`），任务行保留 |
| 清理 | 临时设备已 revoke、探针测试文件与临时目录已删除 |

本地执行那一段单独验了一次（同一个探针框架、`DispatchExecutor` 走**真实 `AgentManager`** + 本地假 provider）：

| 验证点 | 结果 |
| --- | --- |
| `ensureWorkspaceAgent` → `createSession` → `setSessionPermission(auto)` → `chat()` 接线 | **通过**：2 次模型调用（先要 `write`，再收尾），报告 `kind: done` |
| 工具真的执行、文件真的落盘 | **通过**：`HELLO.txt` 写入临时仓库，`files: ["HELLO.txt"]` |
| 本地审批门 | **通过**：`requestApproval` 调用 **0 次** |
| 摘要 / 用量 / 本地会话 id | **通过**：`summary` 为模型收尾文本，`usage.totalTokens=140`，`localSessionId` 落在报告里 |
| 失败路径 | 未注入失败（`report.kind: failed` 由 `tests/dispatch-worker.test.ts` 覆盖） |

### 15.4 GUI 端到端验收（2026-11-09，dev build + 真 VPS + 真云端模型）

环境：`npm run dev` 起的 Electron（`--remote-debugging-port=9222`，用 CDP 驱动界面）、VPS 上 0.2.1 网关、真实云端模型（`deepseek-flash`）、真工作区 `D:/tmp/dispatch-acceptance`（临时 git 仓库）。

| 验收项 | 做法 | 结果 |
| --- | --- | --- |
| D1 真实工作区跑一轮 | 用配对探针设备发 `/v1/runs`，让云端模型自己 `local_dispatch` | **通过**：任务在本机 `auto` 会话里执行，`ACCEPTANCE.md` 落盘，两行内容（标记 + ISO 时间）正确，`git status` 只多这一个未跟踪文件 |
| 面板「最近任务」 | 首屏 + 推送 | **通过**：连接页直接列出账本（修掉「推送的是裸 state、Store 只认 `{config,state}`」的合并缺陷后） |
| D5 界面急停 | 慢任务跑到一半点「急停」并确认 | **通过**：本机 `enabled:false / connected:false / running:null`，账本记 `canceled`「本机急停」，`dispatch.json` 落盘 `enabled:false`；云端那条 `local_dispatch` 立刻返回「状态 canceled，原因是「本机急停」」；网关无残留 `queued` 任务 |
| 云端取消（`local_task_cancel`） | 另起一条 run 让模型取消正在跑的任务 | **通过**：本机任务中止（`SLOW2.md` 停在第 4 行）、账本 `canceled`「云端取消」、hub `dispatch_tasks` 同步 `canceled` |
| D7 幂等 | 一条 run 里连调两次 `local_dispatch`，`client_token` 相同 | **通过**：两次返回**同一个** taskId，文件只写一次 |
| D2 关掉派活再派 | 关开关后在云端用目标 `设备/工作区` 直派 | **通过**：工具回「工作区 … 没有打开派活开关」，`local_workspaces` 里 `dispatchable: false`、`online: true`，本机不落任何文件 |
| D3 断线不漏活 | 硬杀 Electron（不走优雅退出）→ 云端派活（排队）→ 重启 | **通过**：任务在 hub 里 `queued`，重启后中继连上即重放并执行，`RECONNECT.md` 写出；那条 `local_dispatch` 等待后返回 `completed` |
| D6 审计 | 网关 `audit_events` + `dispatch_events` | 网关照常记 `dispatch.assigned/claimed/report/canceled`；**桌面侧不另写 `audit.jsonl`**（账本注释里已定的口径：本机只留最近 20 条供回看，审计归网关） |

### 15.5 本轮验收中发现并修掉的问题

| 问题 | 表现 | 修法 |
| --- | --- | --- |
| `safeStorage` 在 ready 前被用 | 启动日志 `safeStorage cannot be used before app is ready`，派活的解密路径跑了两次 | `dispatchWorker.refresh()` 移到 `app.whenReady()` 的 `startupReady` 之后 |
| 面板不显示最近任务 | 主进程推送的是裸 state，Store 的 `extract` 只认 `{config,state}`，首屏也不填 `recent` | `dispatchStore` 重写 `extract`（兼容裸 state、`config.state.recent` 兜底）+ 统一 `merge()`；补 2 条单测 |
| 急停被记成失败 | abort 让 `chat()` 抛错，`failed` 落账；`enabled` 没落盘，重启又自己连上；排队任务不给终态 | 急停写 `enabled:false` + 取消原因表（`cancelReasons`）+ 排队任务逐个回报 `canceled`；账本状态加 `canceled` |
| 关掉派活后云端还能派 | 只断中继不报状态，网关在 90s「可能只是抖动」窗口里继续接受，任务排队到开关重新打开后才执行 | 停止/关闭时上报 `dispatchable:false` 的完整清单；网关 `cancel_pending` 清掉该设备的 `queued` 任务（插件 0.2.1，含单测） |
| 取消原因不分来源 | 云端取消也写「本机已中止该任务」 | 取消原因表区分「本机急停」/「云端取消」，报告与账本都用它 |

### 15.6 P2 / P3 落地记录（2026-11-09，插件 0.3.0）

**P2：设备中途消失、结果要来回几轮**

| 落地项 | 做法 |
| --- | --- |
| `input_required`（D8） | 派活会话额外注入阻塞式工具 `ask_cloud_operator`（`pi-bridge/src/dispatch-extension.ts`）；`AgentManager.createSession(root, { dispatchAsk })` 才会注册它，交互会话没有。工具 `execute` 挂住 → 桌面上报 `question` → 网关状态 `input_required` → 云端 `local_task_reply` → 推 `task.answered` → 工具返回答案，同一轮继续 |
| 反问的边界 | 等 9 分钟；本机急停 / 云端取消 / 关开关都会 reject 这个 Promise（否则会话挂在工具里，abort 也收不干净）。任务卡在「等回答」时仍算活着，进度心跳继续续租约 |
| 租约重投（D10） | `DispatchStore.reclaim()`：`running` / `input_required` **120s 没有任何回报**即回 `queued`；`attempt` 上限 2，用尽判 `failed`。按「有没有回报」而不是「设备在不在线」判断，本地还在发 `progress` 的任务不会被抢走 |
| 重连接回（D9） | 中继连上补发 `queued` + `running` + `input_required`；桌面 worker 按 `taskId` 去重（正在跑的不重复起，等回答的继续等）。派活帧里的 `attempt` 改成「第几次投递」（1 起） |
| 回报补发 | 终态回报失败时进 `pendingReports`，重连后先补发再报清单 —— 否则设备白干一场，云端永远等不到结果 |
| 后台维护 | `hub/maintenance.py`：每 15s 扫超时（发 `task.cancel`）与租约；每 10 分钟清一次 7 天前的任务行。P1 时 `expire()` / `purge()` 只有实现没人调 |

**P3：对外 A2A**

| 落地项 | 做法 |
| --- | --- |
| Agent Card | `GET /.well-known/agent-card.json`（设备 token 或 admin）把**可派活**工作区投影成 skills，`id` = `设备/工作区`，description 保留用户写的触发词 |
| `POST /a2a` | JSON-RPC 2.0：`message/send`（`messageId` 兼作幂等键，`configuration.blocking` 支持阻塞等结果）、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`（SSE 状态帧） |
| 状态映射 | `queued→submitted`、`running→working`、`input_required→input-required`、终态同名、`expired→failed`（A2A 无 expired）；`metadata` 带设备 / 工作区 / 改动文件 / 用量 / 本地会话 id |
| 不做 | push webhook（卡片的 `capabilities.pushNotifications` 仍为 `false`）；`tasks/resubscribe` 用 1s 轮询 store，不引事件总线 |

**真机验收（VPS 0.3.0 + 真实云端模型 + dev build）**

| 验收项 | 结果 |
| --- | --- |
| D8 本地反问 | **通过**：本地 Agent 调 `ask_cloud_operator` 问「ANSWER.md 里写 A 还是写 B？」→ 云端 `local_task_reply` 答「写 A」→ 同一轮继续并写出 `ANSWER.md`（内容 `A`），任务 `completed` |
| D9 断线接回 | **通过**（探针设备打真 hub）：claim 后关掉中继连接 → 重连立刻收到同一任务的 `task.assigned`，`tasks/get` 仍是 `working`，随后 `done` → `completed` |
| D10 租约重投 | **通过**（真桌面 + 真云端）：任务跑到一半**硬杀 Electron** → 120s 后 hub 记 `task.requeued`（attempt=1）→ 重启桌面，重连收到 attempt=2 的派活帧 → 从零重跑并 `completed`，账本与云端都一致 |
| P3 A2A | **通过**（真 hub）：Agent Card 列出两个可派活工作区；`message/send` / `tasks/get` / `tasks/cancel` 全通，状态映射正确 |

### 15.7 第二轮验收发现并修掉的问题（同日，插件 0.3.0 内补丁）

用 dev build + 真 VPS 重打一遍 P2/P3，重点打「上一轮没覆盖的路径」：A2A 打真桌面、
`tasks/resubscribe` 全生命周期、等回答时取消 / 超时、连续两次反问。

| 问题 | 表现 | 修法 |
| --- | --- | --- |
| A2A 无法回答反问 | `message/send` 不看 `message.taskId`，回答反问被当成**新任务**（还会撞「设备正忙」），外部客户端只能等 deadline | 带 `taskId` 的 message 走 `answer()` + 推 `task.answered`，并跳过设备忙检查（同一任务本来就在占设备） |
| 过期任务没有原因 | `expire()` 只改状态不写 `error`，客户端看到 `failed` 却不知为什么 | 写入「超过截止时间仍未完成（网关收尾）」 |
| 桌面取消原因不区分来源 | 网关超时收尾也被记成「云端取消」 | `task.cancel` 帧的 `reason` 透传，账本按真实原因落 |
| A2A skill 后缀匹配 | `workspaceId.endswith(target)` 会让 `bfc` 命中意外工作区（派错目录比报错更糟） | 只认 `设备/工作区`、`workspaceId`、`label` 三种精确写法 |
| 重连补发会重跑已完成任务 | 回报丢失时网关补发 `running` 任务，桌面当成新任务再执行一遍 | worker 记 `finished`（最近 50 条）+ 退回本机账本：收到补发只**补发回报**，不重跑 |
| 关派活开关不打断正在跑的任务 | 只拒绝反问、不 abort，模型把工具错误当成「云端回答」写进文件（实测产出 `OFF.md` =「派活已关闭」），并且照常报 `done` | 关开关 = 停止本机所有派活工作：先摘队列并回报 `canceled`，再 abort 会话、等 drain 收尾，最后才宣布不可派活、断中继（回报必须在中继断开前发出，否则云端要等到租约超时） |
| 反问被拒的措辞像答案 | 错误文本只有「派活已关闭」，小模型会当回答 | 错误文本明确写「这不是云端回答，本次任务不要再写任何文件」 |

第二轮验收结果（全部通过）：

| 场景 | 结果 |
| --- | --- |
| A2A → 真桌面 blocking 派活 | `message/send` 阻塞返回 `completed`，`A2A.md` 内容正确 |
| A2A 回答反问（两次连续） | 两轮 `input-required` → 两次 `message.taskId` 回答 → `completed`，`TWOSTEP.md` 两行都对 |
| `tasks/resubscribe` 全生命周期 | 帧序列 `working → input-required → working → completed(final)` |
| 等回答时云端取消 | 状态 `canceled`，本地账本「云端取消」，会话被 abort，`question` 清空 |
| 等回答时超 deadline | 60s 后 `expired → failed`，原因「超过截止时间仍未完成（网关收尾）」；本地账本同样原因、任务停止 |
| 工具路径（`local_dispatch` + `local_task_reply`） | 改动后重跑仍通过（`D8B.md` = `ok`） |
| 等回答时关掉派活开关 | 本地会话被 abort，不再产出文件（`OFF2.md` 未生成），账本与云端均为 `canceled` /「派活已关闭」 |
| 设备 token 越权 | 探针设备看不到 Legion 的工作区（卡片 0 个 skill），读/取消/派活一律「没有找到」，admin 密钥不受限 |
| 未鉴权访问 A2A | 401 |

### 15.8 补齐 §8.1 / §8.2 剩余验收场景（同日，dev build + 真 VPS）

§15.4 / §15.6 漏掉的三个场景补测（都不是改代码，纯验收）：

| 场景 | 做法 | 结果 |
| --- | --- | --- |
| §8.1 D3 派到不在白名单的工作区 | 让云端模型把任务派给不存在的「部署仓库」 | **通过**：`local_workspaces` 里查不到，模型如实说「没找到这个工作区」并列出唯一可用的那个，再问要不要改派 |
| §8.1 D4 设备下线后派活 | 硬杀 Electron 后派活 | **通过**：任务停在 `queued`；`local_workspaces` 在 90s 心跳窗口内仍显示 `online: true`（设计如此），窗口过后变 `online: false`；模型如实报告 taskId、状态、没有写任何文件，并给出「取消或等设备上线」两条路 |
| §8.2 D9 执行中断网 30s | 任务跑到一半停掉网关 33s 再起 | **通过**：本地会话照常跑完，中继自动重连，任务 `completed`（`attempt=1`，没有被租约抢走），文件内容正确，账本与云端一致 |

D6 的「7 天后清理」由单测覆盖（`test_purge_keeps_live_tasks` / `test_sweep_purges_only_when_asked`），不做真机等 7 天。

### 15.9 轨迹可查落地（2026-11-09，插件 0.3.1→0.3.2）

按「默认不推、按需可查」把最后一项做完，同时把 §10 的不做清单补齐理由。

| 层 | 改动 |
| --- | --- |
| 桌面 | 新增 `electron/dispatch/trace.ts`：`TraceCollector` 吃 `tool_start` / `tool_end` 攒步骤（工具、参数摘要、成败、耗时、改动文件），摘要里的本机绝对路径脱敏成工作区内相对路径；限 200 步 / 64KB 落 `cache/dispatch-traces/<taskId>.json`（保留最近 50 个，供重启后补报） |
| 桌面 | 执行器把 `onTrace` 透传给 `chat()`；worker 在**终态回报**里带一份紧凑副本（≤24KB，超了只留最近若干步并置 `truncated`）。`claimed` / `progress` / `question` 一律不带 |
| 网关 | `dispatch_tasks.trace`（schema 3，老库启动时自动 `ALTER TABLE`）；`report(trace=...)` 校验并压到 32KB |
| 云端可查 | 新工具 `local_task_trace(task_id, offset, limit)`：分页列步骤；`local_task_get` 的终态文案会提示「共 N 步，用 local_task_trace 看」 |
| 外部可查 | A2A `tasks/get` 支持 `include: ["trace"]`，默认不返回 |
| 文案 | `expired` 不再写「可以换台设备重派」，改成「在同一个工作区重派，或先问用户」 |

真机验收（dev build + VPS 0.3.1→0.3.2 + 真云端模型）：

| 场景 | 结果 |
| --- | --- |
| 云端模型主动查轨迹 | **通过**：`local_dispatch` 完成后模型调 `local_task_trace`，拿到逐步骤列表（工具名、成败、耗时、改动文件），并向用户复述 |
| A2A 查轨迹 | **通过**：`tasks/get` 不带 `include` → 无 `trace`；带 `include:["trace"]` → `metadata.trace` 有步骤 |
| 默认不推送 | **通过**：整轮验收中网关没有新增任何推送通道；`claimed` / `progress` 回报里没有 `trace` |
| 脱敏 | **通过**：轨迹里工作区内的路径变相对路径，盘符形式（`D:\…`）、git-bash 挂载形式（`/d/…`）、家目录/临时目录的绝对路径都压成文件名；云端模型自己也确认「轨迹里没有出现 D:\ 或 /d/」 |
| 摘要 vs 轨迹 | 边界写清：**轨迹**（元数据）脱敏；**摘要**（本地 Agent 自己写的总结）不做二次改写——那是任务产出内容，改了就不是原文了 |

### 15.9.1 全量复验（2026-11-09 晚，插件 0.3.2）

按「再跑一遍完整验收」把整条链路从派活到收尾重跑，顺带把三处**文案/状态**瑕疵改掉。

| 场景 | 结果 |
| --- | --- |
| 云端 run → 派活 → 多文件写入 | **通过**：`FULL1.md` / `FULL2.md` 内容逐字正确，模型自己用 `local_task_trace` 复查 6 步 |
| 派活幂等 | **通过**：同一 `client_token` 两次只建一条任务，文件只写一次 |
| A2A blocking 完成 + trace 按需 | **通过**：`tasks/get` 不带 `include` 无轨迹，带 `include:["trace"]` 有步骤 |
| A2A 反问闭环（`tasks/resubscribe`） | **通过**：`working → input-required → working → completed`，回答落盘 |
| 越权隔离 | **通过**：探测设备看不到别人的 skill / 任务，派活报「没有找到目标工作区」 |
| 网关重启（停 33s） | **通过**：本地会话照跑，重连后 `completed`、`attempt=1` |
| 硬杀 Electron → 租约重投 | **通过**：121s 后 `task.requeued`；重启后补跑 `attempt=2`、文件正确（重放只补报不重跑已完成任务） |
| 本机急停 | **通过**：运行中急停 → 账本「本机急停」、云端 `canceled`、文件未写、开关落盘 `enabled:false` |
| 关掉派活后再派 | **通过**：`local_workspaces` 显示 `dispatchable:false`，`local_dispatch` 直接拒，云端如实转述并请用户开开关 |
| 等回答时关掉派活 | **通过**：运行会话被中止、账本「派活已关闭」、不回写任何文件 |
| 截止时间到期 | **通过**：59s 后 `failed`，理由「超过截止时间仍未完成（网关收尾）」 |
| 轨迹不推送 | **通过**：`dispatch_events` 里 0 条带 trace，`pending` 0 |
| 界面 | **通过**：派活卡片状态、最近任务（完成 / 已取消 + 理由）与云端一致 |

复验时改掉的三处：

| 问题 | 改法 |
| --- | --- |
| 开关打开时按钮写「已关闭」 | 按钮写**动作**（`关闭派活` / `允许云端派活`），状态写结果（`已开启` / `已关闭`）；新增 `cloudDispatchDisable` 词条 + 单测 |
| 运行态推送里的 `enabled` 被界面忽略 | `applyState` 用推送的 `enabled` 修正开关显示（否则别的入口改了开关，卡片还显示旧状态）+ 单测 |
| 设备忙时提示「换一台设备」 | 同一工作区只属于一台机器，改「等它结束再用 `local_workspaces` 复查，要打断就 `local_task_get`」；`provides_tools` 补 `local_task_trace`（doctor 对账） |

### 15.10 仍未做

到这里**方案内没有剩余项**。刻意不做的东西见 §10：push webhook、强提醒、逐条 trace 直播、
跨设备重投（永久不做）。租约重投仍只投**原设备**——这不是待办，是语义要求（§10）。

`tasks/resubscribe` 的事件粒度就是状态变化（`working → input-required → completed`），
要明细走 `tasks/get` + `include:["trace"]`。
