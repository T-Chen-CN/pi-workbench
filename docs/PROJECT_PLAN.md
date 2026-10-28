# Pi Workbench 项目方案

> **面向**：需要理解"为什么这么设计"的人 —— 新人、评审者、动架构前的 AI agent。
> **什么时候读**：要改架构、加子系统、或质疑某个技术选择时。
> **什么时候要改**：定位 / 理念 / 进程模型 / 核心模块边界 / 技术选型发生变化时。

**最后更新**: 2026-10-29 · **当前阶段**: Phase 6 持续优化

> 阶段状态见 [STATUS](./progress/STATUS.md)，交付记录见 [ROADMAP](./progress/ROADMAP.md)，待办见 [BACKLOG](./progress/BACKLOG.md)，代码结构与频道表见 [PROJECT_STRUCTURE](./architecture/PROJECT_STRUCTURE.md)。

---

## 一、项目概述

### 项目定位

轻量级 AI 辅助开发工作台（Cursor 类体验），基于 **Electron + React**，集成 **Pi Coding Agent** 作为智能助手内核，所有数据自包含（便携式架构）。

### 核心理念

1. **本地优先**：无云端依赖，配置与数据在应用目录内
2. **Agent 原生**：Agent 直接读写工作区文件、执行命令
3. **简洁可扩展**：扁平组件结构、独立 Zustand store、按域拆分 IPC
4. **跨平台**：Windows / macOS / Linux

### 目标用户

- 希望用本地 AI Agent 辅助编码的个人开发者
- 需要接入自定义模型端点（DeepSeek、中转站等）的用户
- 偏好轻量工具而非完整 IDE 的用户

### 已打通的端到端能力

配置供应商 → 拉取真实模型 → 打开工作区 → Agent 对话（read/write/edit/bash）→ 修改自动进入审阅与 Diff → 重启后恢复会话。

---

## 二、技术架构

### 进程模型

```
Renderer (sandbox, no Node)
  React 19 + Zustand + Monaco
  window.electronAPI ← contextBridge ← preload.cjs
        │ IPC（统一经 handleIpc，fail-closed 来源校验）
Main Process (Node 24, Electron 44)
  fs / dialog / safeStorage / 文件监听 / 终端 PTY
  AgentManager (pi-coding-agent) ── HTTP ──> LLM Provider
  read/write/edit/bash 工具直接操作工作区
```

### 技术栈

Electron 44（内置 Node 24）· React 19 · TypeScript 5.9 · Vite 5 · Zustand 4 · TailwindCSS 3.4 · Monaco 0.57 · `@xterm/xterm` 6 + `node-pty` 1.1 · `@earendil-works/pi-coding-agent` 1.3 · Vitest 2 · electron-builder 26。

精确版本见 `package.json`。

> **Node 版本约束**：要求 Node ≥ 24（`node:sqlite` 用于工作区历史），Electron 必须 ≥ 39。

### 安全边界

- 渲染进程：`contextIsolation` + sandbox，无 Node 权限；所有能力经 preload 显式暴露。
- Agent 仅运行在主进程；其工具（read/write/edit/bash）在主进程内直接操作文件系统 —— 安全边界靠进程隔离与审批策略，不靠 IPC 拦截。
- API Key：磁盘加密（safeStorage，`enc:` 前缀）；`models.json` 只保存 `$PI_WORKBENCH_API_KEY` 变量名。
- 插件系统**无沙箱**，仅面向个人可信项目；不向渲染进程加载插件 JS。
- 生产构建注入 CSP（`script-src 'self'`）。

### Web 开发模式（仅 `vite dev`）

无 Electron 主进程时，由 Vite 中间件提供：

- `/__pi/fetch-models`：代理供应商模型列表（规避 CORS，15s 超时）
- `/__pi/agent/*`：在 Node 进程运行同一套 AgentManager，SSE 流式

仅用于 UI / Agent 调试，功能少于 Electron（无审批、分支、计划、导出等）；生产必须用 Electron。

---

## 三、核心模块设计

> 模块 1–7 的**边界与职责**属于设计决策，写在这里；具体文件位置与频道见 [PROJECT_STRUCTURE](./architecture/PROJECT_STRUCTURE.md)，Agent 侧约束见 [agent/](./agent/)。

### 模块 1：文件管理

- 目录选择、递归读取、文件读写 / 新建 / 重命名 / 删除
- 递归监听（`fs.watch` + 300ms 防抖，忽略 `.git`、`node_modules`、`.pi-workbench`、`dist`、`release`、`cache`）
- 不可变状态更新

### 模块 2：代码编辑

- Monaco 多标签、语言推断、自动保存（2 秒防抖）
- 程序化 `setValue` 抑制脏标记回环；每文件独立 model（撤销栈隔离）
- 外部变更同步（未脏时写入）、外部删除自动关标签
- 关闭标签 / 工作区 / 窗口的未保存保护

### 模块 3：对话交互

- 配置 → 拉取模型 → 选择 → 保存
- Agent 初始化：写 `models.json`、`ModelRuntime` 解析、会话续接
- 流式输出、上下文选择（打开的文件 / 编辑器选区）、token 用量、错误透传
- 修改审阅：本轮全部文件修改进入审阅队列，逐项保留或还原（修改在工具执行时已落盘，属**事后**审阅）

### 模块 4：Diff 查看

- 行级 diff（`src/api/diff.ts`），Split / Unified
- AgentManager 在 write/edit 工具执行前后读取文件内容，`chat()` 返回 `edits`
- 写文件 / 执行命令前的**事前**拦截由审批策略负责（见 [agent/agent-runtime](./agent/agent-runtime.md)）

### 模块 5：工作区管理

- `.pi-workbench/` 初始化、最近工作区（`data/workspaces.db`）、切换清理、会话恢复
- 多工作区标签页与工作区级 Agent 注册表（`electron/agent-registry.ts`）
- 按工作区的文件监听与终端生命周期（关闭工作区时一并释放）
- 插件系统：命令 / 钩子、启用禁用、热重载（无沙箱，默认不启用）

### 模块 6：终端

- 主进程 `TerminalManager`（`electron/terminal-manager.ts`）管理 PTY 进程
- 渲染层 `@xterm/xterm` + FitAddon，面板位于编辑器下方
- 输出写入 `{workspace}/.pi-workbench/terminal-{id}.log`，可一键附加为 Agent 上下文
- 面板隐藏保留会话；重启按钮重建 PTY；切换工作区按 key 重建
- `node-pty` 为原生模块：延迟加载，失败只影响终端；打包 `asarUnpack`

### 模块 7：工作台插件系统

**定位**：插件扩展 Pi Workbench 本身，不扩展 Pi Agent；Agent 能力保持内置，不接入 Pi SDK 的 extensions / custom tools。

- 目录 `{workspace}/.pi-workbench/plugins/<id>/`，`plugin.json` 声明，CommonJS 入口导出 `activate(api)`
- API：`workspaceDir` / `registerCommand` / `on` / `log`；`deactivate()` 可选
- 命令通过命令面板（Ctrl+Shift+P）执行，可传字符串参数并查看输出
- 启用双开关：`config.json` 的 `enabledPlugins` + `pluginsConfigured`
- 目录监听自动重载（500ms 防抖）；示例 `examples/plugins/git-tools`

---

## 四、技术决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 桌面框架 | Electron 44 | 生态成熟；内置 Node 24 |
| 状态管理 | Zustand | 轻量、无样板；按域拆分 store |
| 数据位置 | 便携式应用目录 | 可整体迁移、无外部依赖（macOS 例外见 [BUILD_AND_PACKAGE §6](./guides/BUILD_AND_PACKAGE.md)） |
| Agent 集成 | pi-coding-agent SDK | 内置工具与会话管理，避免自研 Agent 循环 |
| Agent 工具文件访问 | 主进程直连 fs | SDK 设计如此；边界靠进程隔离 + 审批 |
| 供应商配置 | 统一 OpenAI 兼容 + models.json | 支持 DeepSeek 等任意端点 |
| 工作区存储 | SQLite（`data/workspaces.db`） | 记录打开时间与次数，单一来源 |
| 插件系统 | 工作台插件宿主 | 只扩展工作台，默认不启用、无沙箱 |
| Web 模式 | Vite dev 中间件 | 便于 UI / Agent 调试，不进生产 |
| 面板拆出 | 单 renderer + 子文档 portal | 见 [ADR-001](./decisions/ADR-001-detachable-panels.md) |
| 主窗口关闭 | 收托盘常驻 | 见 [ADR-002](./decisions/ADR-002-tray-resident-main-window.md) |
| 会话历史来源 | JSONL 分支记录 | 见 [ADR-003](./decisions/ADR-003-session-record-single-source.md) |

---

## 五、推进约定

- 每个阶段使用 `feat/phase-N-*` 分支；质量门禁（type-check → test → lint → build → 打包冒烟）通过后合并到 main。
- 阶段内按依赖顺序交付，独立功能单元完成即提交，保持 main 始终可用。
- 阶段收尾更新 [STATUS](./progress/STATUS.md) 与 [BACKLOG](./progress/BACKLOG.md)，不更新本文（本文只在设计变化时改）。
- 只有遇到产品 / 架构分叉或环境阻塞时才暂停确认。

---

## 六、参考资源

- Electron：https://www.electronjs.org/docs/latest/
- React：https://react.dev/
- Pi Coding Agent：`node_modules/@earendil-works/pi-coding-agent/docs/`
- Monaco Editor：https://microsoft.github.io/monaco-editor/
- 项目开发约束（AI agent 入口）：[AGENTS.md](../AGENTS.md)
