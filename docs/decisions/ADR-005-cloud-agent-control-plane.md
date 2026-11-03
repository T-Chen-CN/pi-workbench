# ADR-005 云端 Agent 的控制面、终端后端与自研范围（修订 ADR-004 的三项决策）

> **面向**：实现云端板块、写 `electron/cloud/` 控制面客户端、改审批与自研范围的人
> **什么时候读**：写代码前；读 [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md) 之前
> **什么时候要改**：不修改正文；控制面传输、终端后端选型或自研范围再次变化时写新 ADR

- **状态**: 已采纳（2026-11-03）
- **⚠ 部分修订**: 下面「决策 → 一」表的**控制面传输**（gateway 认证 WS + SSH 隧道）、**配置面归属**与「自研范围」已由 [ADR-006](ADR-006-cloud-agent-api-control-plane.md) 修订；表里的**终端后端**（ssh 到受限用户）已由 [ADR-007](ADR-007-cloud-agent-full-host-access.md) 修订（改宿主级权限 + 软限制）。「终端后端不用容器」与「本地客户端能力收敛」两节继续有效
- **影响范围**: `electron/cloud/`（控制面客户端）、`electron/ipc/cloud-agent.ts`、`src/store/cloudStore.ts`、新增渲染层顶层板块、Hermes profile 的 `config.yaml`
- **修订**: [ADR-004](ADR-004-cloud-agent-backend.md) 的「接入口径」「终端后端」「自研范围」三处决策
- **相关文档**: [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md)、[核查与更正](../reports/research-cloud-agent-2026-11-03.md#7-核查与更正2026-11-03)、[ADR-003](ADR-003-session-record-single-source.md)、[ADR-006](ADR-006-cloud-agent-api-control-plane.md)、[AGENT_TRACE](../architecture/AGENT_TRACE.md)

## 背景

ADR-004 采纳「Hermes 为后端 + ACP 接入 + Modal 终端后端 + 自研 10 条」之后，我们按文档逐条核对了 Hermes 官方文档、ACP 规范与仓库实况，发现三处会导致方案无法落地的偏差：

| 待解决的问题 | 核查结论 |
| --- | --- |
| ACP 能否作为远程控制面 | ACP 是 **JSON-RPC over stdio**，agent 是 client 的**子进程**，**没有 socket 传输**；且 `hermes acp` 是 **gateway daemon 的 viewer**，daemon 没跑会 `Gateway inaccessible: not_ready`。ADR-004 里「gateway 关闭」不成立 |
| Modal 作为终端后端 | Hermes 在 `docker` / `modal` / `daytona` / `vercel_sandbox` / `singularity` 后端下**主动跳过 dangerous 命令审批**（"the container itself is the security boundary"）。而审批是 S-04 的唯一载体 |
| 自研 10 条是否都成立 | 审批只覆盖 dangerous shell 命令；`write_file`/`patch` **没有审批路径**；per-tool 策略是 open issue；`execute_code` 在本地/ACP 会话**无整脚本审批**；同时 Hermes 已有 Kanban（任务板）与 `clarify`（问答），E01/G04 不必自研 |

## 决策

**一、控制面主通道 = gateway 的认证 HTTP/WS；ACP 降为备通道。**

| 事项 | 决定 |
| --- | --- |
| 主通道 | 本地主进程经 SSH 隧道连 gateway 控制面（认证 HTTP/WS） |
| 备通道 | `ssh vps -- hermes acp`（stdio 子进程），用于穿刺保底、事件形状参考、未来换后端的迁移路径 |
| 不用的 | Gateway IM 协议（只用于 C-J02 渠道） |
| 依据 | `session.resume` 返回 **pending admissions**（断线补齐的唯一正解）；cron / Kanban / `process` / `subagent` 观测不在 ACP 面上（`hermes-acp` toolset 刻意排除 messaging 与 cronjob） |
| 风险 | ACP 适配器跑在 `use_unstable_protocol=True` → 版本钉死；控制面 WS 的事件流细节待 §9.0 闸门② 验证 |

**二、终端后端默认 `ssh` 到同机受限用户；容器后端与「必批」互斥。**

| 选项 | 审批 | 采用 |
| --- | --- | --- |
| `ssh` / `local`（专用 VPS + 受限用户） | ✅ 可用 | **默认** |
| `modal` / `daytona` / `docker` / `vercel` | ❌ 静默关闭 | 仅在**自建 MCP 执行器门**落地后，作为可选加固 |
| 「共享一台机各占一屏」 | — | 不做；多 agent 用 `gateway.multiplex_profiles`（每 profile 独立 session authority） |

**三、自研范围 10 → 8 条，其中真做 4 条。**

| 原编号 | 原判定 | 新判定 |
| --- | --- | --- |
| C-C01 动作级审批 | 语义分类器 | **重定义**：策略编排（`approvals.deny` / `manual` / allowlist）+ 自建 MCP 执行器门 + 控制台审批 UI |
| C-B01 屏幕流 | 桌面截图 | **改技术**：自建 MCP browser + CDP `Page.startScreencast`（云端 headless，没有桌面） |
| C-C02 接管 | 依赖 B01 | 保留；语义 = CDP `Input.*` 驱动浏览器 |
| C-B03 审计三问 | 自研 | 保留 |
| C-E04 预算熔断 | 自研 | **受约束**：依赖 usage 事件（待穿刺），硬闸只有 MCP `spend_limit` |
| C-E03 幂等键 | 对外写全覆盖 | **收窄**：仅覆盖经我们 MCP 门的写 |
| C-E07 恢复核对 | 自动核对 | **降级**：恢复后列出未结算对外写、逐条人工确认 |
| C-E01 任务卡 | 自研任务模型 | **降为视图**：Hermes Kanban 已是持久任务板 |
| C-G04 建议卡片 | 自研 | **降为视图**：gateway 已有 `clarify.request/respond/settled` |

**四、本地客户端能力收敛（安全条款）。**

ACP client 在 `initialize` 时通告能力。本项目**永不通告** `fs.readTextFile` / `fs.writeTextFile` / `terminal/*`——否则云端 agent 可反向让本地读写本地文件、在本地跑命令，S-02 直接失效。审批响应**不提供 `allow_always`**（它会写 Hermes 永久白名单）。

## 备选方案

- **只用 ACP（ADR-004 原方案）**：跨机器必须 `ssh` 包一层子进程，生命周期绑在连接上；没有断线 resume、没有 cron/Kanban 观测面。**否决**，但保留为备通道。
- **只用 gateway WS**：事件形状与 `AGENT_TRACE` 的对齐关系尚需穿刺确认；先做双通道穿刺再定主备，不在纸面上赌。
- **Modal 作为唯一后端**：审批会被整层关闭，S-04 失守。**否决**。
- **fork Hermes 加幂等/审批**：丢失 `hermes profile update` 升级路径，且 118 技能的体积问题有官方解法。**否决**。

## 后果

- **工期重估**：8–9 周 → **12–17 周**（§9.0 环境与闸门 1–2 天 + P0 2–3 周 + P1 4–5 + P2 3–4 + P3 2–3 + P4 1–2）。
- **环境渐进生产化**：不一次把 Hermes 环境搭完。D0 只搭「最小可测实例」（半天–1 天），调优由后续阶段驱动：审批策略（P1）→ MCP 执行器（P1）→ MCP browser（P1）→ IM 渠道（P4）。理由见 [CLOUD_AGENT §9.1](../requirements/CLOUD_AGENT.md#91-d0最小可测实例半天)。
- **新增前置闸门**：§9.0 的 D0–D2（最小可测实例 + 三件套：审批回调 / 控制面事件流 / 断线 resume）为 go/no-go。
- **新增两条验收**：AC-16（审批不被后端静默关闭）、AC-17（`execute_code` 已禁用）；AC-11 增加"抓报文验证未通告 `fs/*`、`terminal/*`"。
- **承认三个能力缺口并写进文档**：`write_file`/`patch` 无审批、`execute_code` 必须禁用、容器后端与必批互斥。
- **本地侧多两件改造**：顶层视图（板块与工作区并列，`PanelId` 是固定 union，不能靠加 panel 解决）+ transcript 表现层从 `chatStore` 解耦（云端 store 与 `chatStore` 不得互相 import）。
- **真相源边界仍按 ADR-004**：云端真相源是 Hermes 的 `state.db`，本地只留可丢弃 UI 缓存。ADR-004 的「`eventCursor` 重放」作废——ACP 与 gateway 都没有这个原语，改为 `session.resume` + 显式断线占位。
- **战略风险登记**：官方 Hermes Desktop（Electron + React，2026-06-02 起公开预览）已在做同类控制台。差异化必须落在「与本地工作区同窗 + 本地/云端并存 + 统一审批与审计」，P0 后复核一次。

## 修订记录

| 日期 | 变化 |
| --- | --- |
| 2026-11-03 | 初次采纳（修订 ADR-004 的控制面传输、终端后端、自研范围） |
| 2026-11-03 | 终端后端由 [ADR-007](ADR-007-cloud-agent-full-host-access.md) 修订：取消受限用户 `piagent` 与 `terminal.backend: ssh`，Hermes 改宿主级权限（含 sudo），隔离降为软限制 + 云侧兜底 |
