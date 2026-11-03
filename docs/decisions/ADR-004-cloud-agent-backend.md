# ADR-004 云端 Agent 采用 Hermes 为后端，真相源互不越界

> **面向**：要动云端 Agent 接入、新增云端 IPC、改审批与审计的人
> **什么时候读**：实现云端板块、写 `electron/ipc/cloud-agent.ts`、改 ACP 事件映射之前
> **什么时候要改**：不修改正文；后端选型或真相源边界变化时写新 ADR

- **状态**: 已采纳（2026-11-03）
- **⚠ 部分修订**: **接入口径**、**终端后端**与**自研范围**由 [ADR-005](ADR-005-cloud-agent-control-plane.md) 修订（接入口径后续再由 ADR-006 修订）；其中**终端后端**（ssh 到受限用户）再由 [ADR-007](ADR-007-cloud-agent-full-host-access.md) 修订（宿主级权限 + 软限制），以后端选型与两套真相源互不越界继续有效
- **影响范围**: 新增 `electron/cloud/`（ACP 客户端）、`electron/ipc/cloud-agent.ts`、`electron/preload.cts`、`src/types/electron.d.ts`、`src/api/cloud.ts`、新增渲染层云端板块、`src/store/cloudStore.ts`
- **相关文档**: [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md)、[ADR-005](ADR-005-cloud-agent-control-plane.md)、[ADR-006](ADR-006-cloud-agent-api-control-plane.md)、[选型调研](../reports/research-cloud-agent-2026-11-03.md)、[ADR-003](ADR-003-session-record-single-source.md)、[AGENT_TRACE](../architecture/AGENT_TRACE.md)、[agent-runtime](../agent/agent-runtime.md)

## 背景

需求是给 Pi Workbench 加一个**云端常驻 Agent**：不使用用户本地机器、7×24 在云上跑、用户通过本地面板观察与介入。它与现有本地 Pi Agent **并存**，不替代、不迁移。

调研阶段先尝试"从组件积木自研"，结论是不可行：需要的能力不止运行时，还有记忆、技能、定时、渠道、子代理、休眠恢复——任何一个产品级项目都已做对，自研等于重造。

候选三个产品级后端（Hermes / OpenClaw / OpenMuse）中：

| 判据 | Hermes | OpenClaw | OpenMuse |
| --- | --- | --- | --- |
| 闭源依赖 | 无 | 无 | **强制 CopilotKit Intelligence** |
| 执行面 | 六种终端后端（含 Modal / Daytona 休眠唤醒） | 跑自己机器 | Chromium + Docker |
| 标准接入协议 | **ACP adapter（含 `request_permission`）** | Gateway 协议 | 模板，需自改 |
| 体积 | 默认 118 个捆绑技能 | 12 GB 仓库 | 正常 |

选 Hermes 的决定性理由是前两项：**无闭源依赖** + **有标准接入协议**。

## 决策

**一、云端执行体选 Hermes Agent（MIT，Nous Research），Pi Workbench 只做控制台。不自研运行时，不 fork。**

| 事项 | 决定 |
| --- | --- |
| 后端 | Hermes Agent，跑在云 VPS 上，单进程 |
| 最小化 | 官方 profile 机制 + `hermes skills opt-out --remove`；**不 fork**（保住 `hermes profile update` 升级路径） |
| 终端后端 | Modal（主）/ Daytona（备）；后者上游 2026-06 已停开源维护 |
| 接入口 | **ACP（Agent Client Protocol）**，不走 Gateway IM 协议，不嵌 Python |
| 连接位置 | 只在 Electron 主进程；渲染层不持网络凭据 |
| 审批载体 | ACP 的 `session/request_permission` |
| 不做的 | 账号体系 / 多租户 / 团队共享（单用户自用） |

**二、两套真相源并存，互不越界。**

| | 本地 Agent | 云端 Agent |
| --- | --- | --- |
| 真相源 | 本地 `sessions/*.jsonl` + `parentId`（ADR-003，**不变**） | **Hermes 自己的会话存储** |
| 本地留存 | 全量 | 仅带 `eventCursor` 的**可丢弃缓存**（重开面板不闪空） |
| 缓存丢失 | — | 从 `eventCursor` 向 Hermes 重放；失败则整段重拉 |
| 禁止 | — | 云端会话**不得**写成本地 JSONL；本地分支语义**不得**进云端 |

**三、事件模型复用 `AGENT_TRACE`。** 唯一新增的 part 类型是 `approval`（对应 `request_permission`），其余（text / thinking / tool / plan）直接映射，换取对话流渲染层几乎免改。

## 备选方案

- **自研云端 Agent（v1 方案）**：需要 50 条能力，其中 40 条开源已有现成实现，纯浪费；且最难的不是运行时，而是交互与审批模型——这恰恰与云无关。
- **fork OpenMuse 改造**：它是 MIT 模板，明确鼓励 clone 定制，TS 栈与我们同构。**否决原因**：缺 `CPK_INTELLIGENCE_API_KEY` 则 API 起不来；alpha；无图形桌面。但其"不确定的外部写之后不做隐藏重试"与 stored review 语义已抄入自研要求。
- **OpenClaw**：星数最高、policy as code 最成熟。**否决原因**：12 GB 仓库、teams 概念冗余、无标准客户端协议。降为备选。
- **fork Hermes 做精简版**：不存在"精简 Hermes"二开项目——因为它本身就是 OpenClaw 的精简重写；且 fork 会丢升级路径。改为官方 profile 机制。
- **把云端会话镜像成本地 JSONL**：会让两套压缩/分支/恢复逻辑打架，出现"本地以为第 3 步、云端实际第 7 步"。否决。
- **引入 NemoClaw 做 OS 级加固**：提供 OpenShell 系统级隔离且支持 Hermes。**暂不引入**，留作 C-D01 需要更强隔离时的选项。

## 后果

- 自研范围从 50 条降到 **10 条**（6 条核心：动作级审批、幂等键、恢复核对、预算熔断、审计三问、屏幕流）。分期从 P0–P6 压缩为 P0–P4。
- 引入一个**跨语言外部依赖**：Hermes 是 Python。缓解方式是只走 ACP 协议、不读源码；代价是 ACP 协议变更时要跟。
- **P0 存在单点风险**：`acp_adapter/` 是否完整实现 `request_permission` 与工具事件流**尚未验证**。P0 第一天做连通性穿刺；若不通，退路是 Hermes Gateway 协议或本地 REST。
- 本地渲染层几乎免改（事件复用 AGENT_TRACE），但**新增一条独立的数据通路**（云端 store ≠ chatStore），两套 store 不得互相 import。
- 云端板块与现有工作区独立：切走只 `visibility: hidden` + `inert`，不卸载、不 reset；关闭标签是唯一回收入口（沿用现有约定）。
- 单用户前提被写入需求文档，C-A05 / C-H04 / S-06 永久删除。威胁模型转为"防自己的 agent 搞坏自己的东西"，不可逆操作审批升为绝对核心。
- Hermes 与 OpenMuse 默认开遥测；本项目要求默认关闭并写入验收（AC-15）。
- 本地 Agent 的既有铁律（主进程运行、ADR-003、便携目录、退出收尾、工作区信任）**全部不变**。

## 修订记录

| 日期 | 变化 |
| --- | --- |
| 2026-11-03 | 初次采纳 |
| 2026-11-03 | **终端后端再次修订（[ADR-007](ADR-007-cloud-agent-full-host-access.md)）**：不再用 `ssh` 到受限用户，Hermes 改宿主级权限（含 sudo），隔离降为软限制 + 云侧兜底；容器后端仍否决（它会关掉审批）。后端选型与真相源边界不变。 |
| 2026-11-03 | **三处决策由 [ADR-005](ADR-005-cloud-agent-control-plane.md) 修订**：①接入口径——主通道改为 gateway 认证 HTTP/WS，ACP 降备通道（ACP 只有 stdio，且 `hermes acp` 是 gateway daemon 的 viewer，「gateway 关闭」不成立）；②终端后端——默认 `ssh` 到专用 VPS，容器后端（Modal/Daytona/Docker/Vercel）会**静默跳过危险命令审批**，与 S-04 互斥；③自研范围 10 → 8 条（C-C01 重定义为策略+门+UI，C-E03 收窄，C-E07 降级，C-E01/C-G04 降为 Hermes Kanban / clarify 的视图）。另：正文与 CLOUD_AGENT §5.3 提到的 `eventCursor` 重放**作废**（ACP 与 gateway 均无此原语），改为 `session.resume` + 显式断线占位。 |
