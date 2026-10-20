# Pi Workbench 项目方案

**版本**: 0.1.0
**最后更新**: 2026-10-20
**当前阶段**: Phase 1 完成并加固，Phase 2 进行中

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
| Phase 2：工作区管理 | 🟡 约 60% |
| Phase 3-6 | ⏳ 未开始 |

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
- 供应商错误（401/限流等）原样透传
- Agent 修改捕获 → 自动打开 DiffViewer；全局 Toast 提示

#### 工作区

- 打开时初始化 `.pi-workbench/`
- 最近打开列表（最多 10 个），欢迎页直接打开
- 切换/关闭时释放 Agent、清空编辑器/聊天/Diff 状态、停止监听
- 编辑器/聊天/Diff 与工作区状态隔离

#### 体验与工程

- 中英文国际化
- 全局 Toast、加载状态、错误横幅
- Diff 查看器（Split / Unified）
- IPC 调试面板（开发模式）
- 便携式数据目录；Web 开发模式调试桥接
- Vitest 单测、ESLint、Prettier、GitHub Actions CI

### 🔄 进行中 / 计划中

| 能力 | 阶段 |
|---|---|
| 多工作区并行 + 工作区级 Agent 实例 | Phase 2 |
| 流式输出（当前为整轮返回） | Phase 2 |
| Diff 接受/拒绝（当前 Agent 直接落盘） | Phase 2 |
| 上下文选择（文件/符号）注入对话 | Phase 2 |
| 应用日志系统（`logs/`） | Phase 2 |
| 内置终端（xterm.js + node-pty） | Phase 3 |
| 插件 / 自定义工具（倾向基于 Pi 扩展系统） | Phase 4 |
| Fleet 后台任务（Git worktree） | Phase 5 |
| 性能、撤销/重做、快捷键、主题、自动更新 | Phase 6 |

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
| Agent SDK | @earendil-works/pi-coding-agent | 1.3 |
| 测试 | Vitest | 2.1 |
| 打包 | electron-builder | 26 |

> **Electron 版本约束**：Pi SDK 要求 Node ≥ 22.19，Electron 28（Node 18）无法运行，必须 ≥ 39。

### 安全边界

- 渲染进程：`contextIsolation` + sandbox，无 Node 权限
- 所有能力经 preload 显式暴露
- Agent 仅运行在主进程；其工具（read/write/edit/bash）在主进程内直接操作文件系统
- API Key：磁盘加密（safeStorage）；`models.json` 仅保存 `$PI_WORKBENCH_API_KEY` 变量名
- 插件系统（未来）无沙箱 → 仅面向个人可信项目

### Web 开发模式（仅 `vite dev`）

无 Electron 主进程时，由 Vite 中间件提供：

- `/__pi/fetch-models`：代理供应商模型列表（规避 CORS）
- `/__pi/agent/{init,chat,history,dispose}`：在 Node 进程运行同一套 AgentManager

仅用于 UI / Agent 调试；生产环境必须使用 Electron。

---

## 五、数据存储策略（便携式）

| 数据 | 位置 | 说明 |
|---|---|---|
| API 配置 | `{appDir}/config/api-config.json` | `apiKey` 为 `enc:<base64>` |
| 应用设置 / 最近工作区 | `{appDir}/config/settings.json` | |
| Agent 模型配置 | `{appDir}/data/agent/models.json` | 不含明文 Key |
| Agent 会话 | `{appDir}/data/agent/sessions/<cwd>/` | Pi SessionManager 管理，跨重启恢复 |
| 工作区配置 | `{workspace}/.pi-workbench/config.json` | `workspace:init` 创建 |
| Web dev Agent 数据 | `{appDir}/cache/temp/web-agent/` | 可随时删除 |
| 日志（待实现） | `{appDir}/logs/` | |

**禁止**：`app.getPath('userData')` / `appData` / `.env` / 系统临时目录。

---

## 六、项目结构

```
electron/           主进程（main.ts、preload.cts、两套 tsconfig）
src/
  components/       7 个扁平组件（ChatPanel、DiffViewer、FileExplorer、IPCDebug、
                    MonacoEditor、Settings、Toast）
  store/            6 个独立 store（chat、diff、editor、i18n、toast、workspace）
  api/              IPC 封装、Agent API、diff 算法
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

**待增强**：流式输出、上下文选择、Diff 接受/拒绝。

### 模块 4：Diff 查看（已实现）

- 行级 diff（`src/api/diff.ts`），Split / Unified
- AgentManager 在 write/edit 工具执行前后读取文件内容，`chat()` 返回 `edits`
- ChatPanel 计算 Diff 并打开查看器

**待增强**：多文件修改列表、接受/拒绝（当前修改已直接落盘）。

### 模块 5：工作区管理（进行中）

已完成：

- `.pi-workbench/` 初始化、最近工作区、切换清理、会话恢复

待完成：

- 多工作区并行与工作区级 Agent 实例（`Map<workspacePath, AgentManager>`）
- 工作区元数据存储：先 JSON，SQLite 待 Fleet 规模再评估
- 日志系统

### 模块 6：终端（待实现）

- xterm.js + node-pty（原生模块，需 electron-rebuild 与打包验证）
- 用户终端与 Agent bash 工具独立

### 模块 7：插件系统（待实现）

- 优先基于 **Pi SDK 扩展机制**（extensions / custom tools / inline extensions），
  而不是自研 loader + dynamic require
- 插件目录：`{workspace}/.pi-workbench/plugins/`
- 无沙箱，仅限个人可信项目

### 模块 8：Fleet 任务（待实现）

- Git worktree：`{workspace}/.pi-worktrees/{task-name}/`
- 每个任务独立 Agent 实例与工作目录
- 任务元数据：`{appDir}/data/fleet-tasks.db`（SQLite 在此阶段引入更有价值）
- 任务日志：`{appDir}/logs/fleet-{task-id}.log`

---

## 八、开发路线图

### ✅ Phase 0：MVP（2026-10-20 完成）

Electron 框架、文件管理、Monaco 编辑、Diff、聊天 UI、国际化、Toast、IPC 调试。

### ✅ Phase 1：Pi Agent 集成（2026-10-20 完成）

真实 Agent、模型拉取、安全存储、错误透传、会话持久化、Diff 联动、文件监听、
工作区生命周期、测试与 CI。详见 [progress/PHASE-1-COMPLETE.md](./progress/PHASE-1-COMPLETE.md)。

### 🟡 Phase 2：工作区与对话体验（进行中，预计 1-2 周）

- [x] 工作区初始化 / 生命周期 / 最近列表
- [x] 会话持久化与恢复
- [x] 切换时状态隔离
- [ ] 多工作区并行 + 工作区级 Agent 实例
- [ ] 流式输出
- [ ] Diff 接受/拒绝
- [ ] 上下文选择（文件 / 符号）注入
- [ ] 日志系统

**验收**：切换工作区时 Agent 与会话正确隔离；重启恢复上次状态；修改可审阅后应用。

### ⏳ Phase 3：终端集成（预计 1-2 周）

- [ ] xterm.js + node-pty（验证 Electron 44 原生模块构建）
- [ ] 用户终端与命令日志
- [ ] Agent 与终端联动（读取终端输出）

### ⏳ Phase 4：插件与自定义工具（预计 1-2 周）

- [ ] 接入 Pi 扩展系统（工具 / 命令 / 模板）
- [ ] 工作区插件目录与热重载
- [ ] 示例插件（Git / GitHub）

### ⏳ Phase 5：Fleet 后台任务（预计 2-3 周）

- [ ] Git worktree 管理
- [ ] 任务队列与状态机
- [ ] 每任务独立 Agent 实例
- [ ] 任务监控与日志

### ⏳ Phase 6：优化与完善（持续）

- [ ] 性能（大文件、大项目、虚拟滚动）
- [ ] 撤销/重做
- [ ] 快捷键 / 命令面板
- [ ] 主题系统
- [ ] 崩溃恢复（草稿）
- [ ] CSP 与安全加固
- [ ] 自动更新（electron-updater）
- [ ] 测试覆盖率提升（AgentManager、IPC）

---

## 九、技术决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | Electron 44 | 生态成熟；Pin Pi SDK 要求的 Node ≥ 22.19 |
| 状态管理 | Zustand | 轻量、无样板代码；按域拆分 store |
| 数据位置 | 便携式应用目录 | 可整体迁移、无外部依赖 |
| Agent 集成 | pi-coding-agent SDK | 内置工具与会话管理，避免自研 Agent 循环 |
| Agent 工具文件访问 | 主进程直连 fs | SDK 设计如此；安全边界仍在主进程 |
| 供应商配置 | 统一 OpenAI 兼容 + models.json | 支持 DeepSeek 等任意端点 |
| 工作区存储 | 先 JSON，SQLite 延后 | 数量小；避免原生模块成本 |
| 插件系统 | 基于 Pi 扩展（规划） | 避免维护两套插件 API |
| Web 模式 | Vite dev 中间件 | 便于 UI/Agent 调试，不进入生产 |

---

## 十、质量保障

```bash
npm run type-check   # TypeScript 严格模式
npm test             # Vitest（store / diff）
npm run lint         # ESLint + react-hooks
npm run build        # renderer → bridge → main（顺序不可颠倒）
npm run package:win  # NSIS + portable
```

- 构建顺序：**桥接层必须先于主进程**（主进程引用 `pi-bridge/dist` 类型）
- CI：GitHub Actions（push / PR：type-check → test → lint → build）
- 打包验证：`asar` 必须包含 `pi-bridge/dist` 与 `@earendil-works/pi-coding-agent`

---

## 十一、目标

### 短期（1 个月内）

- 完成 Phase 2：多工作区、流式输出、Diff 审阅、日志
- 发布可用的 Windows 安装包（NSIS + portable）

### 中期（3 个月内）

- 内置终端（Phase 3）
- 基于 Pi 扩展的插件系统（Phase 4）
- 跨平台打包与自动更新

### 长期（6-12 个月）

- Fleet 后台任务系统（Phase 5）
- 性能、快捷键、主题、崩溃恢复等打磨（Phase 6）

---

## 十二、参考资源

- Electron：https://www.electronjs.org/docs/latest/
- React：https://react.dev/
- Pi Coding Agent：`node_modules/@earendil-works/pi-coding-agent/docs/`
- Monaco Editor：https://microsoft.github.io/monaco-editor/
- 项目开发约束：[AGENTS.md](../AGENTS.md)
