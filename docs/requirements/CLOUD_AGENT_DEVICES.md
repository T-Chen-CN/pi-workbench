# 云端 Agent 多设备身份与反向派活方案 v1（草案，待批准）

> **面向**：要实现「多台本地程序连同一个云端 Agent」「云端 Agent 认得是哪台设备」「云端指挥本地 Agent 干活」的人
> **什么时候读**：动设备身份、控制面前置、反向任务通道、变更 S-02 之前
> **什么时候要改**：`pi-hub` 形态、设备身份口径、派活权限口径、验收场景变化时
> **状态**：v1 草案 · 2026-11-06 · **未开工**（变更 [CLOUD_AGENT v5](./CLOUD_AGENT.md) §6 的 S-02 铁律，必须先批准；批准后补 ADR-008）

---

## 0. 一句话

**给每台本地设备一张身份证，并把「云端派活」做成一条只能由本地授予能力的窄通道。**
云端只负责**发请求**，能力（写文件 / 跑命令 / 用哪个工作区）永远由**本地**按白名单 + 档位上限 + 逐次审批授予——这样既满足「云端指挥本地干活」，又不用把 S-02 改成「云端有本地能力」。

---

## 1. 三条需求与落点

| # | 你的原话 | 落点 | 结论 |
| --- | --- | --- | --- |
| D-01 | 多设备的多本地程序连同一个云端 Agent，云端要能识别是哪台设备 | 设备身份：`deviceId` + 设备名 + **每设备独立 token**；平台层（转发日志 / 审计）与模型层（`author` + 设备上下文）双路可见 | 需要新组件（见 §3） |
| D-02 | 同一个云端 Agent 只对应同一个用户，多设备只是「同一个人的不同入口」 | 不做账号 / 租户 / 团队；**一个 profile、一把用户身份、多台设备**；设备不是用户 | 不引入多租户 |
| D-03 | 云端 Agent 后续要能指挥本地 Agent 工作 | 反向任务通道：云端 `local_dispatch` 工具 → 设备任务邮箱 → 本地执行器 → 结果回灌到云端时间线 | 需要新组件 + 新 ADR（S-02 变更） |

---

## 2. 现状（读代码得来，不是设想）

| 事实 | 位置 / 依据 |
| --- | --- |
| 本地 → 云端是**单向可见**：本机能读 `/v1/capabilities`、`/health/detailed`、`/v1/toolsets`、`/v1/skills`、`/v1/models` | `electron/cloud/remote.ts`、`CloudDiagnosticsPanel.tsx` |
| 发起一轮只发 `{input, session_id}`，**零本机信息** | `electron/cloud/remote.ts:409` |
| 云端 Agent **零本地能力**（铁律） | [CLOUD_AGENT §6 S-02](./CLOUD_AGENT.md) |
| 本地不实现 ACP、不通告 `fs/*` / `terminal/*` | 同上 §1.1 |
| 只有**一把** `API_SERVER_KEY`（≥32B），没有按设备分权的概念 | 同上 §5.2 |
| 同会话并发轮次会**排队**（`run.queued` / `status: queued` / `admission_queued`） | 上游 `gateway/platforms/api_server_runs.py` |
| `/v1/runs` 支持 `author: {id, name, is_bot}`，注释写明 **"memory-attribution label only; grants nothing"** | 上游 `agent/turn_author.py`、`api_server.py:583` |
| `/v1/runs` 支持 `instructions`（与首轮历史一起解析） | 上游 `_resolve_chained_history` |
| MCP 服务器可配 `trust: untrusted` → **每个写能力工具调用都要人工审批**（Once / Session / Always，`Always` 写 `command_allowlist` 的 `mcp:<server>/<tool>`） | 上游 `website/docs/reference/mcp-config-reference.md` |
| `platform_toolsets.api_server` 是**显式白名单**，新增工具集必须加进去（clarify 就踩过） | [BACKLOG §7.5](../progress/BACKLOG.md) |
| 本地已有「派发 / 委派授权 / 不可放大 / headless 工作区 / 任务状态机」的设计 | [TOP_LEVEL_AGENT](./TOP_LEVEL_AGENT.md) §3.4 / §4.3 / §4.5 / §4.8 |

**一句话**：D-01 今天只能做到「模型层猜」，D-03 完全没有路。而 D-03 要的本地执行语义，[TOP_LEVEL_AGENT](./TOP_LEVEL_AGENT.md) 已经定义过一遍 —— 只是今天派发方是本地顶层会话，之后要多一个派发方：云端。

---

## 3. 关键设计决定

### 3.1 新增一个组件：`pi-hub`（一物三用）

```
腾讯云 VPS
├── hermes-gateway     127.0.0.1:8642    ← 只有 hub 直连它（不再对公网暴露 api.）
├── hermes-dashboard   127.0.0.1:9119    ← 配置面，保持现状
├── pi-hub             127.0.0.1:8650    ← 新增：控制面前置 + 设备目录 + 任务邮箱 + MCP server
└── caddy              0.0.0.0:443
        api.  → hub（设备 token 校验后转发 :8642）
        mcp.  → hub 的 MCP 端点（Bearer = hub 自己的服务密钥，Hermes 侧配置）
        dash. → :9119
```

为什么**必须**有它（三个需求各差一块拼图，一个组件同时补上）：

| 缺口 | 单靠 Hermes 做不到的原因 | hub 补法 |
| --- | --- | --- |
| 按设备识别 / 撤销 | `API_SERVER_KEY` 只有一把，撤销等于全员掉线；Hermes 日志里没有设备概念 | 每设备一把 token，hub 校验后注入 `X-Pi-Device` + `author`，转发给 gateway |
| 设备在线状态 | gateway 不知道「谁在线」 | 设备心跳 + 长轮询连接数就是在线状态 |
| 云端 → 本地 | 本地没有可入站端口，Hermes 也没有「投递给某台设备」的通道 | hub 做任务邮箱 + 给 Hermes 暴露 MCP 工具 |

**不做的替代方案**：把 hub 塞进 dashboard 进程 → 侵入上游、跟着 `hermes update` 一起炸；让本地开入站端口 → 破 S-01。

### 3.2 设备身份：通道强制 + 工具按需（v1.1 修订，不再每轮注入）

| 层 | 内容 | 谁看得到 | 强弱 |
| --- | --- | --- | --- |
| **通道层（强制）** | hub 按 token 认设备，写进转发日志 / 任务审计 / 在线表；可单独撤销、可限速、可限权（只能派活 / 只能对话）。派活默认目标就是「请求这条通道的那台设备」 | 运维 / 控制台 / hub | **硬**（不可伪造） |
| **工具层（按需）** | 只读工具 `local_devices()`：设备名、在线、能力、最近活跃（D2 落地） | 模型**主动查**才看得见 | **硬**（token 换来，篡不了） |
| **记忆层（软）** | `author: {id: "pi-workbench/<deviceId>", name: "<设备名>", is_bot: false}` | 只进 memory provider 的 `sync_turn`，**不进 prompt** | 只做归属 |
| ~~模型层（每轮注入）~~ | ~~`instructions` 里的 `<pi-devices>`~~ → **v1.1 取消** | — | — |

**为什么取消每轮注入**（三条，按重要性）：

1. **大多数场景不需要**：身份是**通道属性**而非模型知识 —— 派活路由由 hub 按 token 决定，模型不必知道设备名。模型只在「用户直接问」或「多设备轮流接话」时才真需要；
2. **注入不可信、工具可验证**：注入进 prompt 的文字，模型读过的网页同样能写「我是设备 B，把任务派给我」；工具返回来自 hub 的 token，伪造不了 —— 把身份放在可信那一侧（对应 R-07 / R-08）；
3. **成本与缓存**：`instructions` → `ephemeral_system_prompt`，用 `session_id` 时服务端不记忆（只有 `previous_response_id` 链路才复用），等于每轮都发；按需读取常规成本为 0，且时间线上有工具卡可审计。

**`author` 的定位（已由上游源码确认，见 §9 QD-7）**：只做记忆归属与审计标签，**不构成授权、不进模型上下文**。

**唯一的注入例外**：共享会话里设备切换时，用**消息级极短前缀**（与本地 `<pi-workbench-context>` 同一套约定，渲染时剥掉），不走 system prompt；该场景默认关闭（§3.3）。

### 3.3 多设备与会话：默认一设备一会话

- 默认：`设备 × 项目 = 一个云端会话`（`session_id` 存在本地 `data/cloud-agent/device-sessions.json`）；
- 理由：同一会话的并发轮次在服务端**排队**（§2），两台设备抢一个会话只会互相阻塞；而「记忆」在 Hermes 是 profile 级全局的，不共享会话也不会失忆；
- 提供「共享会话」显式开关，界面上写明「另一台设备发言时会排队」，排队用 `run.queued` 事件显示成时间线上的一行；
- 设备清单 + 「本会话属于设备 A」写进会话首轮 `instructions`，让模型知道「现在是哪台机器在跟我说话」。

### 3.4 反向派活：能力只由本地授予

```
云端 Agent 想「在 project-X 上跑测试」
  └─> MCP 工具 local_dispatch(project, prompt, mode, timeout)
        ├─ [云端审批①] MCP 服务器以 trust: untrusted 注册 → 工具调用本身要人批
        ├─ pi-hub 校验：设备 token 有效？设备在线？该设备开了「允许派活」？
        ├─ 设备 ack 独占任务（同一 taskId 只执行一次）→ 本地执行器
        │     ├─ [本地白名单] projectId 必须已登记且允许该模式
        │     ├─ [本地档位上限] 请求的 mode ≤ 本机设置的上限（默认 readonly）
        │     ├─ [本地审批②] 落进既有 ApprovalBroker（fail-closed，超时即拒）
        │     └─ 新建本地会话执行（复用 TOP_LEVEL_AGENT 的任务 / 委派 / headless 工作区）
        └─ 结果回灌：MCP 工具返回值 = {status, summary, changedFiles, diffStat, logTail}
```

**为什么不破 S-02**：S-02 的原意是「云端不能凭自己拿到本地能力」。这套设计里，能力的三道门（白名单 / 档位上限 / 逐次审批）**全部在本地**，云端只能提交一个**请求**，本地可以永远拒（总开关、撤销 token、超时）。所以 S-02 的措辞要从「零本地能力」改成「**零本地授权**：能力只能由本地授予，云端只能发请求」，语义没松，只是说清了边界在哪。

---

## 4. 设备身份细则（D-01 / D-02）

| 项 | 定义 |
| --- | --- |
| `deviceId` | 本地首次启动生成 `crypto.randomUUID()`，落 `data/cloud-agent/device.json`，**机器认的就是它**。D0 不提供「重置身份」按钮（见下） |
| 设备名 | **默认直接读系统里的设备名**：macOS `scutil --get ComputerName`（"唐辰的 MacBook Pro"）· Linux `hostnamectl --pretty` · Windows 用计算机名（`os.hostname()`，改名要重启才生效，不为此去 spawn `reg query`）；任一失败 800ms 内回落 `os.hostname()`。清洗（去 Cc/Cs/Cn/Co 控制字符与 `/`、trim、≤40 字）+ 连接页可改 |
| 设备 token | 由 hub 签发：`pi_<base64url(32B)>`；**服务端只存 hash**，本地用 `safeStorage` 存 `enc:`（与 `connection.json` 同一套约定） |
| 名字 ≠ 身份 | 名字只作显示与 `author.name` 归属标签：会重名、会被改、常含个人信息（`唐辰的 MacBook Pro`），所以**不能当身份证**。认设备永远用 `deviceId` |
| 不做「重置设备身份」 | D0 去掉：它只影响云端记忆归属的连续性，用户日常没有这个动作。真正的需求是 D1 的**注销这台设备**（服务端撤销 token，本地清文件只是副作用）。可选补一条**换机器检测**：`device.json` 记 `hostnameAtCreation`，读到与当前机器名不符时提示一次「这个目录像是换了机器（或改了机器名），想让云端把它当新设备吗」——这是便携式目录被整包拷贝时唯一会暴露身份冲突的地方 |
| 绑定流程 | 连接页「登记这台设备」→ 用 hub 的管理密钥换一张设备 token → 一次性展示 + 写入 safeStorage + 提示「可在云端设备页撤销」 |
| 心跳 | 在线时每 30s `POST /v1/devices/:id/heartbeat`；离线判定 90s |
| 撤销 | hub 侧删除 / 停用 token → 该设备下一次请求即 `401 device_revoked`，其它设备不受影响 |
| 限权 | token 带 `scopes: ['chat','dispatch']`；只想给「能对话不能派活」的旧笔记本，就只给 `chat` |
| 模型可见性 | **默认不注入**；`author` 只作记忆归属；模型要确认时调 `local_devices()`（D2）。设备名不进 prompt → 不破 cache，也不可被内容注入伪造 |

**支持的传输形态（分阶段）**

| 阶段 | 本地连谁 | 身份强度 |
| --- | --- | --- |
| D0（先做） | 直连 `api.`，共用 `API_SERVER_KEY` | 只有模型层（`author` + 设备上下文），平台层无身份 |
| D1（主形态） | 经 `api.` → hub → gateway | 平台层强制 + 模型层 |

旧路径保留为「直连降级」，用于 hub 挂掉或用户不想装 hub 的场景（对应 UI 上的连接方式选择）。

---

## 5. 反向派活细则（D-03）

### 5.1 任务信封（hub ↔ 设备）

```ts
interface RemoteTask {
  taskId: string            // hub 生成（uuid），幂等的唯一键
  deviceId: string
  projectId: string         // 逻辑项目 id；**绝对路径永不出本机**
  prompt: string            // 任务说明（≤ 8k 字符）
  mode: 'readonly' | 'ask'  // 上限由本地钳制，'full' 一律拒绝
  timeoutS: number          // 默认 900，上限 3600
  createdAt: number
  expiresAt: number         // 设备离线超过 TTL 即作废（默认 10 分钟）
  origin: { runId: string; sessionId: string | null }  // 云端来源，用于回灌与审计
}
```

### 5.2 三个 MCP 工具（注册名 `mcp-pi-hub`）

| 工具 | 语义 | 备注 |
| --- | --- | --- |
| `local_devices()` | 列出设备：名字、在线、能力（`chat`/`dispatch`）、最近活跃 | 只读，供模型自己选设备 |
| `local_dispatch(project, prompt, device?, mode?, timeout_s?)` | 派活并**等待**结果 | 默认选「最近活跃且空闲」的设备；同步等待 ≤ 上限，超时返回 `{status:"running", taskId}` |
| `local_task(task_id)` | 查/续等一个任务 | 配合上一条的异步返回，最长再等 15 分钟 |

**为什么是同步工具**：工具返回值就是模型上下文里的「事实」，同步语义最不容易出错；异步续等交给 `local_task`，避免 MCP 工具超时把结果丢掉。

### 5.3 本地执行器（复用既有能力，不新造）

| 环节 | 复用 |
| --- | --- |
| 任务 → 会话 | [TOP_LEVEL_AGENT](./TOP_LEVEL_AGENT.md) §4.3 派发 + §3.4 任务一等对象（任务 id / 状态机 / 时间线） |
| 权限 | 既有 `SessionMode` + `electron/approval-broker.ts`（fail-closed、超时即拒） |
| 授权不可放大 | §4.5 委派授权规则：云端请求的 `mode` 只能**小于等于**本机上限 |
| headless | §4.8：目标工作区不必打开，`WorkspaceView` 是否存在不影响执行 |
| 工作区信任 | `electron/workspace-trust.ts`（`realpath` + `path.relative`）不变 |

新增的只有三件事：设备 token 校验、任务队列与独占 ack、结果摘要生成（`changedFiles` / `diffStat` / `logTail`）。

### 5.4 结果回传粒度

默认只回：`status` / 一句话 `summary` / 变更文件列表 / diff 统计 / 最后 40 行日志。
**不回**完整文件内容、不回完整 diff（要看得让云端读 git，或本地导出一份），避免「本地代码库被整体搬进模型上下文」。

---

## 6. 安全模型（本方案的唯一边界变更）

威胁模型从 v5 的三条（防误操作 / 防外泄 / 防公网扫描）扩一条：**防跨端提权** —— 云端被攻破或模型被注入后，不能绕过本地审批让本地执行任意动作。

| 编号 | 约束 | 落地 |
| --- | --- | --- |
| R-01 | 能力只由本地授予 | 三道门（白名单 / 档位上限 / 逐次审批）全在本地；hub 不持有任何本地能力 |
| R-02 | 云端请求不得放大 | `mode` 只能 ≤ 本机上限；`full` 一律 `refused: permission_ceiling` |
| R-03 | 工作区白名单 | 未登记 `projectId` → `refused: unknown_project`，不创建本地会话 |
| R-04 | 双层审批 | MCP `trust: untrusted`（云端侧）+ 本地 ApprovalBroker（本地侧）；任一拒绝即中止 |
| R-05 | 总开关 + 可撤销 | 本机「允许云端派活」默认**关**；关掉后 hub 派活立即 `refused: disabled`；token 可单独撤销 |
| R-06 | 任务 TTL 与独占 | 过期不执行；`taskId` 唯一，两台设备不会重复跑同一个任务 |
| R-07 | 审计三问 | 谁派的（run / session / 设备）/ 哪台设备执行的（deviceId + 本地会话）/ 真实结果（工具卡 + 本地 JSONL），一条链可查 |
| R-08 | 注入隔离 | 派活来源必须是一个 MCP 工具调用（有审批路径），不接受自由文本；本地执行时按档位审批，不允许静默提权 |
| R-09 | 路径不出本机 | 云端只见 `projectId` + 项目名；绝对路径、用户名、目录结构一律不外发 |
| R-10 | 结果最小化 | 只回摘要与统计（§5.4） |
| R-11 | hub 自身可审计 | 每次转发 / 派活 / 撤销写一行 JSONL；设备 token 只存 hash |
| R-12 | 密钥卫生 | 设备 token 走 `safeStorage`，渲染层永不持有；hub 管理密钥只用于登记，不进任何日志 |

**S-02 的新措辞（等批准）**：
> ~~云端 Agent 零本地能力：Pi Workbench 不实现 ACP，不通告 `fs/*`、`terminal/*`~~
> **云端 Agent 零本地授权**：云端只能提交请求（对话 / 派活），本地能力（工作区、档位、写与命令）只能由本地按白名单 + 上限 + 逐次审批授予，且可随时整体撤销。

---

## 7. 分期与工期

| 期 | 目标 | 交付判据 | 工期 |
| --- | --- | --- | --- |
| **D0 身份 v0** | `device.json` + 设备名设置 + 每轮 `author` + 审计带设备名 + 会话页显示「发起设备」**（不动 prompt）** | AC-D01（平台层）；**无服务端改动，可单独合入** | 1.5 天 |
| **D1 pi-hub 控制面前置** | hub 服务（设备登记 / token 校验 / 转发 / 心跳 / 撤销 / 审计）+ Caddy 调整 + 本地「经 hub 连接」与直连降级 | AC-D02 / AC-D03；两台设备各持一把 token | 1 周 |
| **D2 派活最小闭环** | 任务邮箱 + MCP server（3 个工具，`trust: untrusted`）+ 本地执行器（白名单 / 档位上限 / 审批 / 结果回传）+ 派活总开关。**模型层身份在这里交付**：`local_devices()` 是唯一权威来源（按需查，不注入） | AC-D05 / AC-D06 / AC-D07 / AC-D08 / AC-D10 / AC-D01（模型层） | 1.5 周 |
| **D3 多设备体验** | 每设备每项目会话 + 共享会话开关 + 设备面板（在线 / 能力 / 最近任务）+ 排队可视化 | AC-D04 / AC-D09 | 1 周 |
| **D4 安全收口** | token 轮换 / 撤销 UI、任务 TTL 与限速、审计导出、注入演练、运维文档（备份 / 升级 / hub 挂了怎么办） | AC-D11 ~ AC-D14 | 0.5 周 |

**合计约 4.5–5 周**，关键路径是 D1（hub）。

---

## 8. 验收场景

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| AC-D01 | 设备识别（平台层） | 两台设备各发一轮，hub 转发日志 / 审计 / 会话页都能标出设备；`author` 出现在服务端会话记录里 |
| AC-D01b | 设备识别（模型层，D2） | 问云端「你现在从哪台设备收到这条消息」→ 它调 `local_devices()`（时间线上有工具卡）并答对；**不依赖任何 prompt 注入**，改设备名后无需重连即生效 |
| AC-D02 | 设备撤销（平台层） | 撤销设备 A 的 token → A 立刻 `401 device_revoked`，B 完全不受影响 |
| AC-D03 | 在线状态 | 关掉 A → 90s 内设备面板显示离线；重连自动恢复 |
| AC-D04 | 多设备并发 | A、B 同时对同一会话发言 → 后者 `queued`，界面显示排队，两条都不丢 |
| AC-D05 | 派活闭环 | 云端「在 project-X 跑测试」→ 工具卡带参数 → 本地新会话执行 → 结果（含 diff 统计）回到云端时间线 |
| AC-D06 | 双层审批 | 云端 MCP 调用弹一次审批；本地执行按档位再批；任一处拒绝则整体中止且审计有记录 |
| AC-D07 | 不可放大 | 云端请求 `mode: full` → `refused: permission_ceiling`，本地不建会话 |
| AC-D08 | 白名单 | 请求未登记项目 → `refused: unknown_project` |
| AC-D09 | 幂等与独占 | 同一 `taskId` 重放只执行一次；两台设备不会同时跑同一任务 |
| AC-D10 | 过期 | 设备离线时派活 → TTL 后 `expired`，设备上线也不执行 |
| AC-D11 | 总开关 | 关闭「允许云端派活」→ 立即 `refused: disabled`；重新打开无需重装 |
| AC-D12 | 审计三问 | 一条任务链能回答「谁派的 / 哪台设备执行 / 真实结果」 |
| AC-D13 | 注入演练 | 让云端读一个含恶意指令的网页后派活 → 本地仍必须人工批准，且不能拿到高于上限的档位 |
| AC-D14 | 断网恢复 | 本地断网 1 分钟，任务在 TTL 内重连后完成；超时后不重复执行 |

---

## 9. 开工前必须收敛的问题

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| QD-1 | 接受在 VPS 上新增第三个常驻服务 `pi-hub`（自己写、自己运维、自己备份）吗？ | 接受；它是 D-01 与 D-03 的公共前置 |
| QD-2 | D-01 先做「模型层标签」（3 天、零服务端改动），还是直接上 hub？ | 先 D0 再 D1，D0 单独就有价值且可回退 |
| QD-3 | 多设备默认「每设备一会话」还是「共享一会话」？ | 默认分开（并发会排队），共享作为显式开关 |
| QD-4 | 派活的权限上限默认档？总开关默认开还是关？ | 上限默认 `readonly`，总开关默认**关** |
| QD-5 | 结果回传只回摘要，还是要能回完整 diff / 日志？ | 只回摘要（§5.4），需要时本地导出 |
| QD-6 | 多设备时谁决定派给哪台：模型指定 / 任选空闲 / 本地默认？ | 模型可指定设备名，缺省「最近活跃且空闲」，冲突时排队而不是并行 |
| QD-7 | ~~`author` 是否真会进模型上下文？~~ | **已回答（读上游源码，无需探针）**：`agent/prompt_builder.py` 无任何 `turn_author` 引用；`agent/memory_manager.py:446-463` 只转给 memory provider 的 `sync_turn`（注释 "reaches only providers whose `sync_turn` accepts it"）；`agent/bot_chain.py:71-96` 只看 `is_bot` / `hops`。结论：**`author` 不进 prompt**，只做记忆归属 |
| QD-8 | 共享会话里设备切换时，是否需要「消息级」极短设备前缀？ | 默认不需要（共享会话默认关）；真要做就用消息级 `<pi-device>`，**不进 system prompt** |

---

## 10. 非目标

❌ 多租户 / 账号体系 / 团队共享（D-02 明确单用户）· ❌ 云端直接读写本地文件系统 · ❌ 云端绕过本地审批执行命令 · ❌ 本地开入站端口 · ❌ 把 `pi-hub` 塞进 dashboard 进程 · ❌ 用 ACP 作为派活通道 · ❌ 让设备 token 具备「代表用户批准」的权力 · ❌ 跨设备同步本地会话记录（本地真相源仍是 ADR-003）

---

## 11. 变更记录

| 版本 | 日期 | 变化 |
| --- | --- | --- |
| v1.2 | 2026-11-06 | 设备名默认改为**直接读系统友好名**（macOS `ComputerName` / Linux `hostnamectl --pretty` / Windows 计算机名，失败回落 hostname），并明确「名字 ≠ 身份」；D0 去掉「重置设备身份」按钮，改由 D1 的服务端注销承担，另留一条可选的「换机器检测」 |
| v1.1 | 2026-11-06 | 设备身份改为**通道强制 + 工具按需**：取消「每轮 `instructions` 注入」，`author` 明确只做记忆归属（已读上游源码确认不进 prompt），模型层识别推到 D2 的 `local_devices()`；D0 从 3 天缩到 1.5 天且不动 prompt；新增 QD-8 与 AC-D01b |
| v1 | 2026-11-06 | 初稿：三条需求 → 设备身份（两层可见）/ pi-hub 一物三用 / 反向派活只发请求 / S-02 改口径 / D0–D4 分期与 14 条验收 |
