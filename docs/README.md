# 📚 Pi Workbench 文档中心

欢迎来到 Pi Workbench 项目文档。

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 22.19**（Pi SDK 要求；Electron 44 内置 Node 24）
- npm

### 安装和运行

```bash
npm install

# 开发（自动先构建 pi-bridge 与 Electron 主进程）
npm run dev

# 或仅 Web 调试（Agent 由 Vite dev 中间件承载）
npm run web:dev
```

应用将在 Vite 开发服务器和 Electron 窗口中同时启动。

### 质量检查

```bash
npm run type-check   # TypeScript
npm test             # Vitest 单元测试
npm run lint         # ESLint
npm run build        # 全量构建
```

---

## 📁 文档导航

### 📋 项目规划
- **[项目方案](./PROJECT_PLAN.md)** — 完整的项目方案、技术架构和开发路线图 ⭐

### 🏗️ 架构和设计
- **[项目结构](./architecture/PROJECT_STRUCTURE.md)** — 代码组织、进程模型与数据流
- **[Agent 过程轨迹方案](./architecture/AGENT_TRACE.md)** — 思考、工具调用与正文的 parts 时间线（已实现 v1）

### 🔧 开发指南
- **[构建和打包](./guides/BUILD_AND_PACKAGE.md)** — 构建、打包与发布
- **[Agent 测试清单](./guides/AGENT-TESTING.md)** — Phase 1 功能验收步骤
- **[Agent 过程轨迹测试方案](./guides/AGENT_TRACE_TESTING.md)** — thinking / 工具步骤的自动化与手动验收

### 📊 项目信息
- **[项目状态](./progress/STATUS.md)** — 当前功能状态与进度
- **[待开发功能方案](./progress/ROADMAP.md)** — 审批、计划、检查点、队列等全部待办项与里程碑（唯一清单）
- **[Phase 1 完成报告](./progress/PHASE-1-COMPLETE.md)** — Agent 集成实现细节

### 🗂️ 历史报告
- **[历史报告目录](./reports/README.md)** — 早期阶段归档（可按需删除）

---

## 🎯 按任务查找

| 我想... | 查看文档 |
|--------|---------|
| 了解项目全貌和规划 | [PROJECT_PLAN.md](./PROJECT_PLAN.md) ⭐ |
| 了解项目结构和进程模型 | [PROJECT_STRUCTURE.md](./architecture/PROJECT_STRUCTURE.md) |
| 查看思考与工具轨迹方案 | [AGENT_TRACE.md](./architecture/AGENT_TRACE.md) |
| 规划后续开发目标 | [ROADMAP.md](./progress/ROADMAP.md) |
| 构建和发布应用 | [BUILD_AND_PACKAGE.md](./guides/BUILD_AND_PACKAGE.md) |
| 验收 Agent 功能 | [AGENT-TESTING.md](./guides/AGENT-TESTING.md) |
| 验收过程轨迹 / 工具步骤 | [AGENT_TRACE_TESTING.md](./guides/AGENT_TRACE_TESTING.md) |
| 查看功能状态 | [STATUS.md](./progress/STATUS.md) |

---

## 💡 常见问题

### 如何启动开发环境？

```bash
# 完整开发环境（Electron + Vite）
npm run dev

# 仅浏览器（UI / Agent 调试，工作目录固定为项目根）
npm run web:dev
```

### 如何打包应用？

```bash
npm run package:win    # Windows
npm run package:mac    # macOS
npm run package:linux  # Linux
```

输出目录：`release/`

### 项目使用了哪些技术？

- **桌面框架**: Electron 44
- **前端**: React 19 + TypeScript
- **编辑器**: Monaco Editor
- **构建**: Vite 5
- **状态管理**: Zustand
- **样式**: TailwindCSS
- **Agent**: @earendil-works/pi-coding-agent
- **测试**: Vitest

---

## 🔗 相关链接

- [主项目 README](../README.md)
- [中文 README](../README_ZH.md)
- [Electron 官方文档](https://www.electronjs.org/docs/latest/)
- [React 官方文档](https://react.dev/)

---

**文档版本**: 2.1
**最后更新**: 2026-10-23
**项目版本**: 0.2.2
