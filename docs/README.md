# 📚 Pi Workbench 文档中心

> 这里是**文档索引**。三个入口：想用 → [中文 README](../README.md) 的「下载」与「配置」；想看它为什么这么设计 → [PROJECT_PLAN](./PROJECT_PLAN.md)；给 AI agent 的项目约束 → [AGENTS.md](../AGENTS.md)。

---

## 📁 文档导航

### 📋 项目规划
- **[项目方案](./PROJECT_PLAN.md)** — 定位、核心理念、技术架构、模块设计与技术决策（背景与原则，不是待办清单）

### 🏗️ 架构和设计
- **[项目结构](./architecture/PROJECT_STRUCTURE.md)** — 代码组织、进程模型、数据流与 IPC 频道表
- **[Agent 过程轨迹方案](./architecture/AGENT_TRACE.md)** — 思考、工具调用与正文的 parts 时间线（已实现 v1）
- **[聊天渲染单一数据源](./architecture/chat-render-single-source.md)** — 设计稿（未实施）：实时流式与重载历史产出同一份消息，根治插话 / 压缩点位置问题
- **[设计系统](./design/DESIGN_SYSTEM.md)** — 颜色、字体、组件与交互的唯一事实来源（强制）

### 🧾 架构决策（ADR）
- **[ADR-001 面板拆分为独立窗口](./decisions/ADR-001-detachable-panels.md)** — 单 renderer + 子文档 portal 的取舍
- **[ADR-002 主窗口托盘常驻](./decisions/ADR-002-tray-resident-main-window.md)** — 关闭按钮收托盘、真退出入口
- **[ADR-003 会话记录作为单一真相源](./decisions/ADR-003-session-record-single-source.md)** — 历史与导出取 JSONL 分支，不取压缩后的上下文
- **[ADR-004 云端 Agent 采用 Hermes 为后端](./decisions/ADR-004-cloud-agent-backend.md)** — 不自研、不 fork；两套真相源互不越界（接入/后端/自研范围已由 ADR-005、ADR-006 修订）
- **[ADR-005 云端 Agent 的控制面与自研范围](./decisions/ADR-005-cloud-agent-control-plane.md)** — 容器后端与「必批」互斥；能力收敛（控制面与配置面已由 ADR-006 修订；终端后端 ssh 已由 ADR-007 修订）
- **[ADR-006 控制面改用 API Server + 自有域名反代](./decisions/ADR-006-cloud-agent-api-control-plane.md)** — api_server（Bearer REST+SSE）为主通道、dashboard 作配置面（内嵌）、自研 8 → 4；SSH 仅运维（探针数量与用量归属已由 ADR-007 修订）
- **[ADR-007 放开整机权限、本地改双页面](./decisions/ADR-007-cloud-agent-full-host-access.md)** — 不建受限用户（Hermes 含 sudo）、隔离只做软限制；云端是两个独立页面（会话 / 配置）；不复用工作区前端；删预算熔断
- **[ADR-008 云端单入口插件与「零本地授权」](./decisions/ADR-008-cloud-single-entry-plugin.md)**（已接受）— S-02 由「零本地能力」改为「零本地授权」；本地与云端只留一条缝：自写 Hermes 插件 `pi-workbench`（设备 token → `deviceId`、scope、审计）；不做直连兜底

### 📌 需求文档
- **[Git 会话工作流（会话-工作树绑定）](./requirements/GIT_WORKTREE_SESSIONS.md)** — 工作树会话的完整需求、边界执行顺序与验收场景
- **[顶层 Agent（跨工作区编排）](./requirements/TOP_LEVEL_AGENT.md)** — 草案：首页常驻顶层会话、派发子会话、委派授权、headless 工作区、任务状态机与验收场景
- **[顶层 Agent 简版需求](./requirements/TOP_LEVEL_AGENT_BRIEF.md)** — 同上，去掉术语与实现细节，只说「它要做什么 / 不做什么 / 权限规矩」
- **[云端 Agent 方案 v5](./requirements/CLOUD_AGENT.md)** — 以后端 Hermes 为基础的云端常驻 Agent（对标 Dots / Grok Bot / Muse）：50 条能力 ID 覆盖表（v5 删 1 条）、自研 4 条、通道（API Server 主 / dashboard 配置面 / ACP 迁移路径）、域名 + TLS 反代部署、整机权限与软限制口径、最小化 profile、安全边界 S-01~S-15、AC-01~AC-22、四探针 D1–D2、双轨工程序 A–H（v5：两页独立前端、不做预算熔断）
- **[云端 Agent 多设备身份与反向派活方案 v3.2](./requirements/CLOUD_AGENT_DEVICES.md)** — 本地与云端只留一条缝：自写 Hermes 插件 `pi-workbench`（`kind: platform`，与 gateway 同进程）；除 dashboard 外全部对接经它转发；设备 token → `deviceId`、scope 限权、审计逐条带设备；云端派活「只发请求、能力只由本地授予」（S-02 → 零本地授权，见 [ADR-008](./decisions/ADR-008-cloud-single-entry-plugin.md)）；**派活单位是工作区**（设备只是承载者，路径不出本机）；H0–H4 分期 + **§20 执行手册**（备份 → H0–H4 分步 + G0–G4 Gate）+ 20 条验收 + 预检 15 项实测；**H0 / H1 已完成**（插件上线、本地改单入口）
- **[云端 Agent 网关插件开发方案（从零实现）](./requirements/CLOUD_AGENT_GATEWAY_PLUGIN.md)** — 新仓库 `pi-workbench-gateway`：从零实现 Hermes `kind: platform` 网关插件；设备 token / 一次性连接码 / 限流 / 审计 / `/v1/*` 与 `/api/*` 反向代理 / SSE / 控制台侧路 / 域名 + Caddy 部署；含 P0–P5、验收 AC-GW01~16 与开工清单
- **[云端 Agent 配对连接方案（插件配对码）](./requirements/CLOUD_AGENT_PAIRING.md)** — Phase 1 桌面端已完成：删除 handoff v1/v1.1/v2 与管理密钥 UI，桌面端只粘贴一次性连接码；管理密钥不出服务器、控制台手动登录；含协议契约（`/v1/devices/pairing` + `/v1/devices/pair`）、Phase 1–3、验收与工作量
- **[云端 Agent 审批实现方案（C-05）](./requirements/CLOUD_AGENT_APPROVAL.md)** — 审批卡片 / 应答通道 / 断流补卡 / 审计 JSONL + **原生 `approvals.mode` 三档切换**（不自造档位预设）；含 2026-11-06 实机实测事实与两次服务端前置
- **[云端自举 Prompt（草案 v2）](./requirements/hermes-bootstrap-prompt.md)** — 交给已部署的 Hermes 自己完成域名 / 反代 / **网关插件 + 管理密钥**；当前仍交付 `hermes-handoff v2` 文件，Phase 3 改为一次性连接码（见 [配对方案](./requirements/CLOUD_AGENT_PAIRING.md)）；**未在干净机器实跑**，见 [BACKLOG §7.3](./progress/BACKLOG.md)

### 🔧 开发指南
- **[构建和打包](./guides/BUILD_AND_PACKAGE.md)** — 构建、打包、发布与自动更新
- **[对外文案](./guides/PUBLIC_COPY.md)** — 仓库门面（About / Topics）、Release 说明模板与 README 结构、截图槽位
- **[插件独立仓库迁移手册](./guides/PLUGIN_REPO_MIGRATION.md)** — A 方案执行版：插件搬进独立私有仓库（根目录即插件、只读 deploy key、`--ref <SHA>` 钉版本）、VPS 用 `plugins adopt` 取代 `tar + scp`、自举 Prompt 只注入 `{{PLUGIN_REPO}}`（不钉版本，跟版靠 `plugins update`）；含备份 / 回滚 / 验收 / 坑位速查
- **[Agent 测试清单](./guides/AGENT-TESTING.md)** — Agent 功能手动验收步骤；含 **云端单入口（G1）验收** 逐条手点清单（对话 / 工具 / 审批 / 插话 / 停止 / 跨重启接回 / 图片 / 会话与任务页 / 两种失败语义 / 注销再登记 / 审计对账）
- **[Agent 过程轨迹测试方案](./guides/AGENT_TRACE_TESTING.md)** — thinking / 工具步骤的自动化与手动验收

### 🧭 Agent 开发约束（从 AGENTS.md 拆出）
- **[路径与持久化](./agent/paths-and-storage.md)** — 便携式目录、启动顺序、落盘文件清单、多工作区状态
- **[IPC 与信任边界](./agent/ipc-and-trust.md)** — `handleIpc`、来源校验、preload / API 层、CSP
- **[Agent 运行时](./agent/agent-runtime.md)** — 会话、权限审批、计划模式、工具白名单、标题、压缩、导出、联网
- **[Git 与工作树会话](./agent/git-and-worktrees.md)** — 工作树绑定、Git 视图、仓库同步、GitHub 关联
- **[面板、辅助窗口与托盘](./agent/panels-and-windows.md)** — 拆出窗口、托盘常驻、通知、自定义协议
- **[仓库地图（工作区面板）](./agent/repo-map.md)** — 面板列出 Git 跟踪文件的职责：扫描口径、事实与缓存、增量指纹、降级与刷新
- **[工作区面板实现说明](./agent/workspace-panel.md)** — 面板从入口到画布的全貌：视图切换、底层地图、上浮链与当前层、视口 / 拖动 / 吸附、落盘状态、测试与改动指引
- **[报告与文档规范](./agent/reporting.md)** — 什么时候写报告、放哪里、怎么清理

### 📊 项目信息
- **[项目状态](./progress/STATUS.md)** — 各阶段状态、功能清单与最近提交
- **[后续开发清单](./progress/BACKLOG.md)** — P1–P3 已收尾；保留平台验收与停放项
- **[v1 功能开发方案](./progress/ROADMAP.md)** — 已交付范围、验收记录与归档说明
- **[Phase 1 完成报告](./archive/PHASE-1-COMPLETE.md)** — Agent 集成实现细节（已归档）

### 🗂️ 历史归档
- `archive/` — 阶段报告与一次性设计稿；更早的内容查 Git 历史

---

## 🎯 按任务查找

| 我想... | 查看文档 |
|--------|---------|
| 了解项目为什么这么设计 | [PROJECT_PLAN.md](./PROJECT_PLAN.md) |
| 了解项目结构和进程模型 | [PROJECT_STRUCTURE.md](./architecture/PROJECT_STRUCTURE.md) |
| 查某个 IPC 频道 / 新增 IPC | [agent/ipc-and-trust.md](./agent/ipc-and-trust.md) |
| 查落盘位置与状态恢复 | [agent/paths-and-storage.md](./agent/paths-and-storage.md) |
| 改编辑区面板 / 仓库地图画布 | [agent/workspace-panel.md](./agent/workspace-panel.md) |
| 改权限 / 审批 / 计划模式 | [agent/agent-runtime.md](./agent/agent-runtime.md) |
| 改工作树会话 / Git 视图 | [agent/git-and-worktrees.md](./agent/git-and-worktrees.md) |
| 规划 / 实现跨工作区顶层 Agent | [requirements/TOP_LEVEL_AGENT_BRIEF.md](./requirements/TOP_LEVEL_AGENT_BRIEF.md)（先看简版）→ [TOP_LEVEL_AGENT.md](./requirements/TOP_LEVEL_AGENT.md) |
| 做云端 Agent（常驻自主 Agent） | [requirements/CLOUD_AGENT.md](./requirements/CLOUD_AGENT.md) + [ADR-004](./decisions/ADR-004-cloud-agent-backend.md) + [ADR-005](./decisions/ADR-005-cloud-agent-control-plane.md) + [ADR-006](./decisions/ADR-006-cloud-agent-api-control-plane.md) + [ADR-007](./decisions/ADR-007-cloud-agent-full-host-access.md) |
| 改云端审批 / 权限档位 | [requirements/CLOUD_AGENT_APPROVAL.md](./requirements/CLOUD_AGENT_APPROVAL.md) |
| 做多设备身份 / 云端派活 / 对接层 | [requirements/CLOUD_AGENT_DEVICES.md](./requirements/CLOUD_AGENT_DEVICES.md)（v2.1，预检完成待开工）· [decisions/ADR-008](./decisions/ADR-008-cloud-single-entry-plugin.md)（已接受） |
| 做云端配对 / 首次连接 | [requirements/CLOUD_AGENT_PAIRING.md](./requirements/CLOUD_AGENT_PAIRING.md)（连接码契约与 Phase 1–3） |
| 从零开发云端网关插件 | [requirements/CLOUD_AGENT_GATEWAY_PLUGIN.md](./requirements/CLOUD_AGENT_GATEWAY_PLUGIN.md)（新仓库、P0–P5、AC-GW） |
| 改面板拆出 / 托盘行为 | [agent/panels-and-windows.md](./agent/panels-and-windows.md) |
| 查看思考与工具轨迹方案 | [AGENT_TRACE.md](./architecture/AGENT_TRACE.md) |
| 查某个架构决定的理由 | [decisions/](./decisions/) |
| 规划后续开发目标 | [BACKLOG.md](./progress/BACKLOG.md) |
| 查看 v1 交付记录 | [ROADMAP.md](./progress/ROADMAP.md) |
| 构建和发布应用 | [BUILD_AND_PACKAGE.md](./guides/BUILD_AND_PACKAGE.md) |
| 改 README / 发版说明 / 仓库 About | [PUBLIC_COPY.md](./guides/PUBLIC_COPY.md) |
| 验收 Agent 功能 | [AGENT-TESTING.md](./guides/AGENT-TESTING.md) |
| 验收过程轨迹 / 工具步骤 | [AGENT_TRACE_TESTING.md](./guides/AGENT_TRACE_TESTING.md) |
| 查看功能状态 | [STATUS.md](./progress/STATUS.md) |
| 查看设计规范 | [DESIGN_SYSTEM.md](./design/DESIGN_SYSTEM.md) |

---

## 🔗 相关链接

- [中文 README](../README.md) — 下载、特性一览、配置、开发情况
- [English README](../README.en.md)
- [Electron 文档](https://www.electronjs.org/docs/latest/) · [React 文档](https://react.dev/)

---

**最后更新**: 2026-11-06（新增云端网关插件开发方案）
