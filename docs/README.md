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

> 云端 Agent 的架构决策已并入 [CLOUD_AGENT.md](./requirements/CLOUD_AGENT.md) 的「关键决策摘要」，不再单独维护 ADR。

### 📌 需求文档
- **[Git 会话工作流（会话-工作树绑定）](./requirements/GIT_WORKTREE_SESSIONS.md)** — 工作树会话的完整需求、边界执行顺序与验收场景
- **[云端 Agent（唯一方案）](./requirements/CLOUD_AGENT.md)** — 桌面端 Phase 1（连接码配对）、会话 / SSE / 审批 / 配置面、设备身份与心跳、网关插件 P0–P5、部署、安全边界、验收与路线。历史方案、历史 ADR、历史研究报告已并入本文
- **[工作区派活（H3）](./requirements/WORKSPACE_DISPATCH.md)** — 云端 Hermes 主动调起本地工作区 Agent：权限模型（Hermes 代行、人只管白名单）、A2A 语义与中继协议、hub.db schema、组件改动清单、三期验收场景
- **[云端自举 Prompt（Phase 3 草案）](./requirements/hermes-bootstrap-prompt.md)** — 交给已部署的 Hermes 完成域名 / 反代 / 网关插件 / 管理密钥，并生成一次性连接码；插件发布前不可用

### 🔧 开发指南
- **[构建和打包](./guides/BUILD_AND_PACKAGE.md)** — 构建、打包、发布与自动更新
- **[对外文案](./guides/PUBLIC_COPY.md)** — 仓库门面（About / Topics）、Release 说明模板与 README 结构、截图槽位
- **[Agent 测试清单](./guides/AGENT-TESTING.md)** — Agent 功能手动验收步骤；含云端 G1 入口与逐条手点，详细清单见 [CLOUD_AGENT](./requirements/CLOUD_AGENT.md)
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
- **[项目状态](./progress/STATUS.md)** — 一页快照：版本、质量门槛、在建项与下一步
- **[任务清单](./progress/BACKLOG.md)** — 唯一任务表：未完成项、平台验收、已决定不做；云端后置项见 [CLOUD_AGENT](./requirements/CLOUD_AGENT.md)

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
| 做云端 Agent（配对 / 审批 / 设备 / 网关 / 部署） | [requirements/CLOUD_AGENT.md](./requirements/CLOUD_AGENT.md)（唯一事实源） |
| 做「云端派活到本地工作区」（H3） | [requirements/WORKSPACE_DISPATCH.md](./requirements/WORKSPACE_DISPATCH.md) |
| 从零开发云端网关插件 | [requirements/CLOUD_AGENT.md](./requirements/CLOUD_AGENT.md) §5 + §9（P0–P5、AC-GW） |
| 改面板拆出 / 托盘行为 | [agent/panels-and-windows.md](./agent/panels-and-windows.md) |
| 查看思考与工具轨迹方案 | [AGENT_TRACE.md](./architecture/AGENT_TRACE.md) |
| 查某个架构决定的理由 | [decisions/](./decisions/) |
| 规划后续开发目标 | [BACKLOG.md](./progress/BACKLOG.md) |
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

**最后更新**: 2026-11-08（文档收敛：任务表合并、已交付文档删除、顶层 Agent 草案下线）
