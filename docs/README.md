# 📚 Pi Workbench 文档中心

> 这里是**文档索引**。安装、运行、配置、打包请从 [主 README](../README.md) 开始；给 AI agent 的项目约束见 [AGENTS.md](../AGENTS.md)。

---

## 📁 文档导航

### 📋 项目规划
- **[项目方案](./PROJECT_PLAN.md)** — 定位、核心理念、技术架构、模块设计与技术决策（背景与原则，不是待办清单）

### 🏗️ 架构和设计
- **[项目结构](./architecture/PROJECT_STRUCTURE.md)** — 代码组织、进程模型、数据流与 IPC 频道表
- **[Agent 过程轨迹方案](./architecture/AGENT_TRACE.md)** — 思考、工具调用与正文的 parts 时间线（已实现 v1）
- **[设计系统](./design/DESIGN_SYSTEM.md)** — 颜色、字体、组件与交互的唯一事实来源（强制）

### 🧾 架构决策（ADR）
- **[ADR-001 面板拆分为独立窗口](./decisions/ADR-001-detachable-panels.md)** — 单 renderer + 子文档 portal 的取舍
- **[ADR-002 主窗口托盘常驻](./decisions/ADR-002-tray-resident-main-window.md)** — 关闭按钮收托盘、真退出入口
- **[ADR-003 会话记录作为单一真相源](./decisions/ADR-003-session-record-single-source.md)** — 历史与导出取 JSONL 分支，不取压缩后的上下文

### 📌 需求文档
- **[Git 会话工作流（会话-工作树绑定）](./requirements/GIT_WORKTREE_SESSIONS.md)** — 工作树会话的完整需求、边界执行顺序与验收场景

### 🔧 开发指南
- **[构建和打包](./guides/BUILD_AND_PACKAGE.md)** — 构建、打包、发布与自动更新
- **[Agent 测试清单](./guides/AGENT-TESTING.md)** — Agent 功能手动验收步骤
- **[Agent 过程轨迹测试方案](./guides/AGENT_TRACE_TESTING.md)** — thinking / 工具步骤的自动化与手动验收

### 🧭 Agent 开发约束（从 AGENTS.md 拆出）
- **[路径与持久化](./agent/paths-and-storage.md)** — 便携式目录、启动顺序、落盘文件清单、多工作区状态
- **[IPC 与信任边界](./agent/ipc-and-trust.md)** — `handleIpc`、来源校验、preload / API 层、CSP
- **[Agent 运行时](./agent/agent-runtime.md)** — 会话、权限审批、计划模式、工具白名单、标题、压缩、导出、联网
- **[Git 与工作树会话](./agent/git-and-worktrees.md)** — 工作树绑定、Git 视图、仓库同步、GitHub 关联
- **[面板、辅助窗口与托盘](./agent/panels-and-windows.md)** — 拆出窗口、托盘常驻、通知、自定义协议
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
| 改权限 / 审批 / 计划模式 | [agent/agent-runtime.md](./agent/agent-runtime.md) |
| 改工作树会话 / Git 视图 | [agent/git-and-worktrees.md](./agent/git-and-worktrees.md) |
| 改面板拆出 / 托盘行为 | [agent/panels-and-windows.md](./agent/panels-and-windows.md) |
| 查看思考与工具轨迹方案 | [AGENT_TRACE.md](./architecture/AGENT_TRACE.md) |
| 查某个架构决定的理由 | [decisions/](./decisions/) |
| 规划后续开发目标 | [BACKLOG.md](./progress/BACKLOG.md) |
| 查看 v1 交付记录 | [ROADMAP.md](./progress/ROADMAP.md) |
| 构建和发布应用 | [BUILD_AND_PACKAGE.md](./guides/BUILD_AND_PACKAGE.md) |
| 验收 Agent 功能 | [AGENT-TESTING.md](./guides/AGENT-TESTING.md) |
| 验收过程轨迹 / 工具步骤 | [AGENT_TRACE_TESTING.md](./guides/AGENT_TRACE_TESTING.md) |
| 查看功能状态 | [STATUS.md](./progress/STATUS.md) |
| 查看设计规范 | [DESIGN_SYSTEM.md](./design/DESIGN_SYSTEM.md) |

---

## 🔗 相关链接

- [主 README](../README.md) — 安装、运行、配置、打包
- [中文 README](../README_ZH.md)
- [Electron 文档](https://www.electronjs.org/docs/latest/) · [React 文档](https://react.dev/)

---

**最后更新**: 2026-10-29
