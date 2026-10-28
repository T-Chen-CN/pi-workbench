# Pi Workbench 项目方案

**版本**: 0.6.4
**最后更新**: 2026-10-27
**当前阶段**: Phase 6 持续优化

---

## 一、项目概述

### 项目定位

Pi Workbench 是一个轻量级 AI 辅助开发工作台（Cursor 类体验），基于 **Electron + React**，
集成 **Pi Coding Agent** 作为智能助手内核，所有数据自包含（便携式架构）。

### 核心理念

1. **本地优先**：无云端依赖，配置与数据在应用目录内
2. **Agent 原生**：Agent 直接读写工作区文件、执行命令
3. **简洁可扩展**：扁平组件结构、独立 Zustand store、按域拆分 IPC
4. **跨平台**：Windows / macOS / Linux

### 目标用户

- 希望用本地 AI Agent 辅助编码的个人开发者
- 需要接入自定义模型端点（DeepSeek、中转站等）的用户
- 偏好轻量工具而非完整 IDE 的用户

---

## 二、当前状态（2026-10-20）

| 阶段 | 状态 |
|---|---|
| Phase 0：MVP（文件 / 编辑 / Diff / 聊天 UI） | ✅ 完成 |
| 便携式架构 | ✅ 完成 |
| Phase 1：真实 Pi Agent 集成 | ✅ 完成 |
| Phase 1 加固（工作区生命周期 / 会话持久化 / Diff 联动 / 文件监听 / 测试） | ✅ 完成 |
| Phase 2：工作区与对话体验 | ✅ 完成 |
| Phase 3：终端集成 | ✅ 完成 |
| Phase 4：工作台插件系统 | ✅ 完成 |
| Phase 5：Fleet 后台任务（2026-10-24 移除） | ➖ 已移除 |
| Phase 6：优化与完善 | 🟡 持续 |

**已可用的端到端能力**：配置供应商 → 拉取真实模型 → 打开工作区 → Agent 对话（read/write/edit/bash）
→ Agent 修改自动展示 Diff → 重启后恢复会话。

---

## 三、核心功能

### ✅ 已完成

#### 文件与编辑

- 文件树浏览、展开/折叠
- 新建、重命名、删除文件/目录
- 多标签编辑（Monaco）、语法高亮
- 2 秒防抖自动保存、脏标记与未保存保护
- 递归文件监听（300ms 防抖），外部变更自动同步，外部删除自动关标签

#### 对话与 Agent

- 统一 OpenAI 兼容配置：Provider + Base URL + API Key + 模型拉取与选择
- API Key 使用 Electron `safeStorage` 加密存储
- 真实 Pi Agent：read / write / edit / bash（Windows 自动发现用户目录 Git Bash）
- 会话持久化：按工作区恢复对话（跨重启）
- 流式输出：主进程推送 `text_delta` 增量，聊天面板实时渲染（Web dev 模式仍整轮返回）
- Agent 修改审阅：本轮全部文件修改进入审阅队列，可逐项保留或还原（修改已直接落盘，属事后审阅）
- 上下文选择（v1）：把已打开的文件附加到下一条消息，带大小上限；历史恢复时自动剥离文件内容
- 供应商错误（401/限流等）原样透传
- Agent 修改捕获 → 自动打开 DiffViewer；全局 Toast 提示

#### 工作区

- 打开时初始化 `.pi-workbench/`
- 最近打开列表（最多 10 个），欢迎页直接打开
- 多工作区标签页：同时打开多个工作区，各自持有独立 Agent 实例（配置变化时重建，关闭时释放）
- 切换标签 / 返回首页只切换可见性，保留各工作区的编辑器、聊天、终端与 Diff 运行期状态
- 关闭工作区标签才释放 Agent、监听与终端；编辑器/会话标签与草稿留在磁盘，重新打开时恢复

#### 体验与工程

- 中英文国际化
- 全局 Toast、加载状态、错误横幅
- Diff 查看器（Split / Unified）
- IPC 调试面板（开发模式）
- 便携式数据目录；Web 开发模式调试桥接
- 主进程文件日志（`logs/main.log`，5 MB 轮转并保留 `.1` 备份）
- 内置终端（xterm.js + node-pty；输出按终端写入 `terminal-{id}.log`，可附加给 Agent）
- 多工作区标签页，各工作区独立 Agent 实例
- 工作台插件系统（主进程加载、命令 / 钩子、启用禁用与热重载、命令面板）
- GitHub 风格的 Git 示例插件（`examples/plugins/git-tools`）
- 生产构建注入 Content-Security-Policy（开发模式不受影响）
- Vitest 单测（store / diff / logger / AgentManager / IPC）、ESLint、Prettier、GitHub Actions CI

### 🔄 进行中 / 计划中

后续开发记录在 [后续开发清单（BACKLOG.md）](./progress/BACKLOG.md)（P1–P3 已收尾）；v1 计划与交付结果见 [ROADMAP.md](./progress/ROADMAP.md)（已归档）。本文件不再重复维护待办清单。

---

## 四、技术架构

### 进程模型

```
Renderer (sandbox, no Node)
  React 19 + Zustand + Monaco
  window.electronAPI ← contextBridge ← preload.cjs
        │ IPC
Main Process (Node 24, Electron 44)
  fs / dialog / safeStorage / 文件监听
  AgentManager (pi-coding-agent) ── HTTP ──> LLM Provider
  read/write/edit/bash 工具直接操作工作区
```

### 技术栈

| 层级 | 技术 | 版本 |
|---|---|---|
| 桌面框架 | Electron | 44.9.1（Node 24） |
| 渲染进程 | React + TypeScript | 19 / 5.9 |
| 构建 | Vite | 5.4 |
| 状态管理 | Zustand | 4.5 |
| 编辑器 | Monaco Editor | 0.57 |
| 样式 | TailwindCSS | 3.4 |
| 终端 | `@xterm/xterm` + `node-pty` | 5.x / 1.1 |
| Agent SDK | @earendil-works/pi-coding-agent | 1.3 |
| 测试 | Vitest | 2.1 |
| 打包 | electron-builder | 26 |

> **Electron 版本约束**：构建与测试要求 Node ≥ 24（node:sqlite），Electron 28（Node 18）无法运行，必须 ≥ 39。

### 安全边界

- 渲染进程：`contextIsolation` + sandbox，无 Node 权限
- 所有能力经 preload 显式暴露
- Agent 仅运行在主进程；其工具（read/write/edit/bash）在主进程内直接操作文件系统
- API Key：磁盘加密（safeStorage）；`models.json` 仅保存 `$PI_WORKBENCH_API_KEY` 变量名
- 插件系统（未来）无沙箱 → 仅面向个人可信项目

### Web 开发模式（仅 `vite dev`）

无 Electron 主进程时，由 Vite 中间件提供：

- `/__pi/fetch-models`：代理供应商模型列表（规避 CORS，15s 超时）
- `/__pi/agent/{init,chat,chat-stream,abort,dispose}` 与会话列表/标签端点：在 Node 进程运行同一套 AgentManager

仅用于 UI / Agent 调试，功能少于 Electron（无审批、分支、计划、导出等）；生产环境必须使用 Electron。

---

## 五、数据存储策略（便携式）

| 数据 | 位置 | 说明 |
|---|---|---|
| API 配置 | `{appDir}/config/api-config.json` | `apiKey` 为 `enc:<base64>` |
| 应用设置 / 最近工作区 | `{appDir}/config/settings.json` | |
| Agent 模型配置 | `{appDir}/data/agent/models.json` | 不含明文 Key |
| Agent 会话 | `{appDir}/data/agent/sessions/*.jsonl` | 平铺文件，按 cwd 过滤，跨重启恢复 |
| 会话 sidecar | `{appDir}/data/agent/session-extras/*.json` | 计划、权限 |
| 工作区打开记录 | `{appDir}/data/workspaces.db` | SQLite 单存储，记录打开时间与次数 |
| 工作区配置 | `{workspace}/.pi-workbench/config.json` | `workspace:init` 创建 |
| Web dev Agent 数据 | `{appDir}/cache/temp/web-agent/` | 可随时删除 |
| 主进程日志 | `{appDir}/logs/main.log` | 5 MB 轮转，保留 `main.log.1`；渲染进程日志见 `logs/renderer.log` |
| Chromium profile | `{appDir}/data/profile/` | `app.setPath('userData', ...)`，缓存与 localStorage 随应用目录迁移 |
| 终端输出 | `{workspace}/.pi-workbench/terminal-{id}.log` | 每个终端独立文件；5MB 轮转；可附加给 Agent |

**禁止**：`app.getPath('userData')` / `appData` / `.env` / 系统临时目录。

---

## 六、项目结构

```
electron/           主进程（main.ts 装配、ipc/ 域模块、preload.cts、两套 tsconfig）
src/
  components/       29 个扁平组件（ChatPanel、ChatHeader、ChatTranscript、ChatMessageRow、
                    ChatApiKeyPrompt、VirtualRows、WorkspaceView、SessionTabs、ApprovalCard、
                    ToolResultViewer、AgentTrace、AgentMarkdown、ChatSessionList、
                    CommandPalette、DialogHost、DiffViewer、ErrorBoundary、FileExplorer、
                    IPCDebug、MonacoEditor、Settings、TerminalPanel、Toast、UpdateDialog、
                    UpdateStatusIndicator、WelcomeScreen、WindowControls、ui、patterns）
  store/            13 个独立 store（approval、chat、dialog、diff、editor、i18n、selection、
                    session、settings、theme、toast、updater、workspace）
  api/              IPC 封装、Agent API（Electron IPC / Web SSE）、渲染日志、diff 算法
  types/            Electron API 与通用类型
  i18n/             中英文文案
pi-bridge/          AgentManager（主进程内运行；dist 不入库）
tests/              Vitest 单元测试
docs/               项目文档
```

详细说明见 [architecture/PROJECT_STRUCTURE.md](./architecture/PROJECT_STRUCTURE.md)。

---

## 七、核心模块设计

### 模块 1：文件管理（已实现）

- 目录选择、递归读取、文件读写 / 新建 / 重命名 / 删除
- 递归监听（`fs.watch` + 300ms 防抖，忽略 `.git`、`node_modules`、`.pi-workbench`、
  `dist`、`release`、`cache`）
- 不可变状态更新

### 模块 2：代码编辑（已实现）

- Monaco 多标签、语言推断、自动保存
- 程序化 `setValue` 抑制脏标记回环
- 外部变更同步（未脏时）、删除时关标签
- 关闭标签 / 工作区 / 窗口的未保存保护

### 模块 3：对话交互（已实现）

- 配置 → 拉取模型 → 选择 → 保存
- Agent 初始化：写 `models.json`、`ModelRuntime` 解析、`SessionManager.continueRecent`
- 对话：`session.prompt()`，读取最后一条 assistant 消息，错误透传
- 历史：从 Pi 会话恢复为可展示消息

**已增强**：流式输出、上下文选择、token 用量统计、自动重试（由 Pi SDK 提供）。

### 模块 4：Diff 查看（已实现）

- 行级 diff（`src/api/diff.ts`），Split / Unified
- AgentManager 在 write/edit 工具执行前后读取文件内容，`chat()` 返回 `edits`
- ChatPanel 计算 Diff 并打开查看器

**审批**：Agent 写文件 / 执行命令前会按权限策略请求审批（2026-10-23 实现）；Diff 审阅仍为事后审阅，修改在工具执行时已落盘。

### 模块 5：工作区管理（已实现）

已完成：

- `.pi-workbench/` 初始化、最近工作区、切换清理、会话恢复
- 多工作区标签页与工作区级 Agent 注册表（`electron/agent-registry.ts`）
- 按工作区的文件监听与终端生命周期（关闭工作区时一并释放）

已完成：

- 工作区元数据存储：`data/workspaces.db`（node:sqlite 单存储）
- 插件系统：命令 / 钩子、启用禁用、热重载（无沙箱，默认禁用）

### 模块 6：终端（已实现）

- 主进程 `TerminalManager`（`electron/terminal-manager.ts`）管理 PTY 进程
- 渲染进程使用 `@xterm/xterm` + FitAddon，面板位于编辑器下方
- 每个终端输出写入 `{workspace}/.pi-workbench/terminal-{id}.log`，可一键附加为 Agent 上下文
- 面板隐藏时保留会话；重启按钮重建 PTY；切换工作区按 key 重建
- node-pty 为原生模块：延迟加载，失败只影响终端；打包使用 `asarUnpack`

### 模块 7：工作台插件系统（已实现）

**定位**：插件扩展的是 Pi Workbench 本身，不是 Pi Agent。Agent 能力保持内置，
不接入 Pi SDK 的 extensions / custom tools。

- 插件目录：`{workspace}/.pi-workbench/plugins/<id>/`，由 `plugin.json` 声明
- CommonJS 入口导出 `activate(api)`，可注册命令与钩子；`deactivate()` 可选
- 可用 API：`api.workspaceDir`、`registerCommand`、`on`、`log`
- 命令通过命令面板（Ctrl+Shift+P）执行，可传字符串参数并查看输出
- 启用/禁用持久化在 `config.json` 的 `enabledPlugins` + `pluginsConfigured`
- 目录监听自动重载（500ms 防抖），也可手动重新加载
- 无沙箱，仅限个人可信插件；不向渲染进程加载插件 JS
- 示例插件：`examples/plugins/git-tools`（status / log / commit all）

---

## 八、开发路线图

### 推进约定（Phase 2–6）

- 每个阶段使用 `feat/phase-N-*` 分支，质量门禁（type-check → test → lint → build → 打包冒烟）通过后合并到 main 并推送
- 阶段内按依赖顺序交付，独立功能单元完成即提交，保持 main 始终可用
- 阶段收尾更新本文件与 [progress/STATUS.md](./progress/STATUS.md)，并输出简短汇报
- 只有遇到产品/架构分叉或环境阻塞时才暂停确认

### ✅ Phase 0：MVP（2026-10-20 完成）

Electron 框架、文件管理、Monaco 编辑、Diff、聊天 UI、国际化、Toast、IPC 调试。

### ✅ Phase 1：Pi Agent 集成（2026-10-20 完成）

真实 Agent、模型拉取、安全存储、错误透传、会话持久化、Diff 联动、文件监听、
工作区生命周期、测试与 CI。详见 [progress/PHASE-1-COMPLETE.md](./progress/PHASE-1-COMPLETE.md)。

### ✅ Phase 2：工作区与对话体验（完成）

- [x] 工作区初始化 / 生命周期 / 最近列表
- [x] 会话持久化与恢复
- [x] 切换时状态隔离
- [x] 主进程文件日志（`main.log`，5 MB 轮转）
- [x] 流式输出（Electron 流式增量；Web dev 仍整轮返回）
- [x] Agent 修改审阅（多文件队列，逐项保留 / 还原；事后审阅）
- [x] 上下文选择 v1（附加已打开的文件）；上下文片段（编辑器选区，2026-10-21）
- [x] 多工作区并行 + 工作区级 Agent 实例

**验收**：对话流式渲染；修改可审阅并逐项保留/还原；已打开的文件可附加为上下文；多工作区标签切换时 Agent 与会话正确隔离；重启恢复上次会话。切换工作区保留编辑器标签与运行期状态，关闭工作区标签时释放运行时。

### ✅ Phase 3：终端集成（完成）

- [x] xterm.js + node-pty（Electron 44 下验证可用；安装包通过 `asarUnpack` 保留原生二进制）
- [x] 用户终端、重启与输出日志（`{workspace}/.pi-workbench/terminal-{id}.log`）
- [x] Agent 与终端联动：终端输出可作为上下文附件发送给 Agent

**说明**：终端按工作区创建，面板显隐不销毁会话；切换工作区会重建终端。"Agent 读取终端输出"通过附加当前终端的 `terminal-{id}.log` 实现。

### ✅ Phase 4：工作台插件系统（完成）

- [x] 插件清单格式与主进程加载器（`electron/plugin-manager.ts`）
- [x] 命令与生命周期钩子贡献点（`workspace:opened` / `file:saved` / `chat:message`）
- [x] 插件启用/禁用与热重载（目录监听 + 手动重新加载）
- [x] Git 示例插件（`examples/plugins/git-tools`）
- [x] 命令面板（Ctrl+Shift+P）执行插件命令、查看输出、管理插件

> 插件只扩展工作台本身，不扩展 Pi Agent，也不加载 Pi SDK extensions。
> v1 只加载主进程 CommonJS 插件，不向渲染进程注入任意 JS（受生产 CSP 约束）。

### ➖ Phase 5：Fleet 后台任务（2026-10-24 移除）

该功能已整体移除：工作区不再创建 `.pi-worktrees`、任务队列和后台 Agent。旧版本遗留的 worktree 与 `pi-fleet/*` 分支需手动清理。

### Phase 6：优化与完善（持续记录）

- [x] Monaco 懒加载（欢迎页/首屏不再加载编辑器 chunk，打开工作区时按需加载）
- [x] 性能（大文件模式、聊天 / Diff / 文件树虚拟滚动；2026-10-21）
- [x] 构建分包（Monaco / React / vendor 独立 chunk）
- [x] 撤销/重做（Monaco 每个文件独立 model，撤销栈按文件隔离）
- [x] 快捷键 / 命令面板（Ctrl+, / Ctrl+Shift+P / Ctrl+S）
- [x] 主题系统（Paper & Ink，Paper / Ink 双主题）
- [x] 崩溃恢复（编辑器草稿写入 `cache/drafts/`，启动时提示恢复）
- [x] CSP 与安全加固（生产构建已注入 CSP）
- [x] 代码审查回归修复（编辑器初始化/自动保存、Web 终端降级、错误边界、监听批量事件、语言持久化）
- [x] 渲染层测试（jsdom + React Testing Library：编辑器创建 / 自动保存）
- [x] 自动更新（electron-updater，打包版本可用）
- [x] 渲染进程日志（`logs/renderer.log`）
- [x] P3 体验收尾（Toast 动画、快捷键文案、编辑器/终端主题 token 化、应用内对话框、自动保存设置、插件重复 id 与配置竞争修复）
- [x] 后端可靠性加固（原子写配置、可信路径、Agent 中止与恢复、按工作区监听）
- [x] 测试覆盖率提升（store / logger / AgentManager / IPC / 终端 / 插件 / 渲染组件）

---

## 九、技术决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | Electron 44 | 生态成熟；Node ≥ 24（Electron 44 内置 Node 24） |
| 状态管理 | Zustand | 轻量、无样板代码；按域拆分 store |
| 数据位置 | 便携式应用目录 | 可整体迁移、无外部依赖 |
| Agent 集成 | pi-coding-agent SDK | 内置工具与会话管理，避免自研 Agent 循环 |
| Agent 工具文件访问 | 主进程直连 fs | SDK 设计如此；安全边界仍在主进程 |
| 供应商配置 | 统一 OpenAI 兼容 + models.json | 支持 DeepSeek 等任意端点 |
| 工作区存储 | SQLite（`data/workspaces.db`） | 记录打开时间与次数，单一来源 |
| 插件系统 | 工作台插件宿主（已实现） | 插件只扩展工作台，不扩展 Pi Agent；默认禁用、无沙箱 |
| Web 模式 | Vite dev 中间件 | 便于 UI/Agent 调试，不进入生产 |

---

## 十、质量保障

```bash
npm run type-check   # TypeScript 严格模式
npm test             # Vitest（store / diff / logger / AgentManager / IPC / 终端 / 插件 / 渲染组件）
npm run lint         # ESLint + react-hooks
npm run build        # renderer → bridge → main（顺序不可颠倒）
npm run package:win  # NSIS 安装包
```

- 构建顺序：**桥接层必须先于主进程**（主进程引用 `pi-bridge/dist` 类型）
- CI：GitHub Actions（push / PR：type-check → test → lint → build）
- 打包验证：`asar` 必须包含 `pi-bridge/dist` 与 `@earendil-works/pi-coding-agent`

---

## 十一、目标

### 短期（1 个月内）

- [x] 发布可用的 Windows 安装包（NSIS；v0.2.2，2026-10-23）
- [x] Phase 2-4 已全部完成；Phase 5 已移除

### 中期（3 个月内）

- [x] 跨平台打包与自动更新（Windows / macOS / Linux，2026-10-23）
- [x] 上下文片段（编辑器选区，2026-10-21）

### 长期（6-12 个月）

- [x] Phase 6 打磨：主题、崩溃恢复、自动更新、性能（虚拟滚动 / 大文件模式）

> 后续开发目标记录在 [BACKLOG.md](./progress/BACKLOG.md)（P1–P3 已收尾）；v1 已完成部分见 [ROADMAP.md](./progress/ROADMAP.md)。

---

## 十二、参考资源

- Electron：https://www.electronjs.org/docs/latest/
- React：https://react.dev/
- Pi Coding Agent：`node_modules/@earendil-works/pi-coding-agent/docs/`
- Monaco Editor：https://microsoft.github.io/monaco-editor/
- 项目开发约束：[AGENTS.md](../AGENTS.md)
