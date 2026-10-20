# Pi Workbench 项目方案

> 基于 Electron + React 的轻量级 AI 辅助开发工作台

**版本**: 2.0  
**最后更新**: 2026-10-20  
**当前状态**: MVP 阶段，核心功能已实现

---

## 📋 项目概述

### 项目定位

一个**轻量级**且**高度可扩展**的跨平台桌面应用，提供类似 Cursor IDE 的开发体验，以 **Pi Agent** 作为智能助手内核，支持多 Agent 协作和插件扩展。

### 核心理念

- **轻量优先**: 快速启动，低资源占用
- **模块化架构**: 按领域组织代码，清晰的模块边界
- **工作区隔离**: 每个项目独立的 Agent、配置和会话
- **插件驱动**: 按需扩展功能
- **直接集成**: Pi 核心模块直接导入，零子进程开销
- **便携式优先**: 所有运行时数据在应用目录内，无外部依赖，支持整体迁移

### 目标用户

- 需要 AI 辅助编程的开发者
- 希望通过自然语言指令完成开发任务的用户
- 需要定制化开发工具的高级用户

---

## 🎯 核心功能

### ✅ 已实现功能（MVP）

#### 1. 文件管理
- ✅ 文件树浏览和展开/折叠
- ✅ 文件操作：创建、打开、编辑、保存
- ✅ 选择工作区目录
- ✅ 不可变状态更新（防止无限递归）

#### 2. 代码编辑
- ✅ Monaco Editor 集成（VS Code 内核）
- ✅ 多标签页支持
- ✅ 自动保存
- ✅ 语法高亮
- ✅ 文件关闭

#### 3. 对话交互
- ✅ 聊天界面（ChatPanel）
- ✅ 消息历史显示
- ✅ 实时输入
- ✅ Pi Agent Mock 集成（模拟响应）

#### 4. 变更预览
- ✅ Diff 查看器（DiffViewer）
- ✅ Split 视图（并排对比）
- ✅ Unified 视图（统一视图）
- ✅ 行级差异标注

#### 5. 用户体验
- ✅ 中英文国际化（i18n）
- ✅ Toast 通知系统
- ✅ 错误处理和显示
- ✅ 加载状态指示
- ✅ IPC 调试面板

#### 6. 设置和配置
- ✅ 设置面板（Settings）
- ✅ 语言切换
- ✅ 应用图标

---

### 🔄 待实现功能（Roadmap）

#### Phase 1: Pi Agent 真实集成 ✅（2026-10-20 完成）
- [x] 替换 Mock Agent 为真实 Pi Agent
- [x] 安装 Pi 核心模块
  ```bash
  npm install @earendil-works/pi-coding-agent
  npm install @earendil-works/pi-ai
  ```
- [x] 实现 Agent Manager（`pi-bridge/src/agent-manager.ts`）
- [x] 统一的 OpenAI 兼容 API 配置（Provider / URL / Key / 模型列表 / 选择模型）
- [x] 配置 LLM 提供商（Anthropic / OpenAI / 任意兼容端点，如 DeepSeek）
- [x] 集成工具系统（read/write/edit/bash，由 SDK 内置）
- [x] API Key 使用 Electron safeStorage 加密存储
- [x] 纯 Web 开发模式调试桥接（仅 `vite dev`）

#### Phase 2: 工作区管理
- [ ] 多工作区支持
- [ ] 工作区级 Agent 实例
- [ ] 会话持久化
- [ ] 工作区配置管理
- [ ] 快速切换工作区

#### Phase 3: 终端集成
- [ ] 集成 xterm.js
- [ ] Bash 命令执行
- [ ] PTY 支持（通过 node-pty）
- [ ] 命令日志记录
- [ ] Agent 调用终端工具

#### Phase 4: Fleet 任务系统
- [ ] Git worktree 管理
- [ ] 后台 Agent 任务
- [ ] 任务状态监控
- [ ] 任务结果展示

#### Phase 5: 插件系统（简化版）
- [ ] 从 `.pi-workbench/plugins/` 加载插件
- [ ] 插件热重载
- [ ] 简单的 TypeScript SDK
- [ ] 为 Agent 添加自定义工具
- [ ] 示例插件（Git、GitHub API）

#### Phase 6: 优化和完善
- [ ] 性能优化（大文件、大项目）
- [ ] 文件监听（外部修改同步）
- [ ] 撤销/重做系统
- [ ] 快捷键支持
- [ ] 主题系统（明暗主题）

---

## 🏗️ 技术架构

### 当前架构（v2.0 - Electron）

```
┌─────────────────────────────────────────────────────────┐
│                 Electron 应用层                          │
├─────────────────────────────────────────────────────────┤
│  前端层 (React 19 + Vite)                               │
│  ├─ 组件层                                              │
│  │  ├─ FileExplorer     文件浏览器                      │
│  │  ├─ MonacoEditor     代码编辑器                      │
│  │  ├─ ChatPanel        聊天面板                        │
│  │  ├─ DiffViewer       Diff 查看器                     │
│  │  ├─ Settings         设置面板                        │
│  │  ├─ Toast            通知系统                        │
│  │  └─ IPCDebug         IPC 调试                        │
│  ├─ 状态管理 (Zustand)                                  │
│  │  ├─ editorStore      编辑器状态                      │
│  │  ├─ chatStore        聊天状态                        │
│  │  ├─ diffStore        Diff 状态                       │
│  │  ├─ errorStore       错误处理                        │
│  │  ├─ i18nStore        国际化                          │
│  │  └─ agentStore       Agent 状态                      │
│  └─ API 层 (src/api/)                                   │
│     ├─ index.ts          统一 API 接口                  │
│     ├─ diff.ts           Diff 工具                      │
│     └─ piAgent.ts        Pi Agent (目前为 Mock)         │
├─────────────────────────────────────────────────────────┤
│  通信层 (Electron IPC)                                   │
│  ├─ fs:selectDirectory   选择目录                        │
│  ├─ fs:readDirectory     读取目录                        │
│  ├─ fs:readFile          读取文件                        │
│  ├─ fs:writeFile         写入文件                        │
│  └─ fs:deleteFile        删除文件（待实现）              │
├─────────────────────────────────────────────────────────┤
│  主进程层 (Electron Main Process - TypeScript)          │
│  ├─ electron/main.ts                                     │
│  │  ├─ 窗口管理          BrowserWindow                  │
│  │  ├─ IPC 处理器        ipcMain.handle()              │
│  │  └─ 菜单和托盘        (待实现)                       │
│  └─ electron/preload.ts                                 │
│     └─ contextBridge     安全的 API 暴露               │
├─────────────────────────────────────────────────────────┤
│  Node.js 层（与主进程同进程）                            │
│  ├─ 文件系统操作         Node.js fs/promises           │
│  ├─ 路径处理             Node.js path                  │
│  ├─ 对话框               Electron dialog               │
│  └─ Pi Agent 桥接（已实现）                             │
│     ├─ pi-bridge/        AgentManager                  │
│     ├─ @earendil-works/pi-coding-agent                 │
│     └─ @earendil-works/pi-ai                           │
├─────────────────────────────────────────────────────────┤
│  存储层（便携式架构）                                    │
│  ├─ 应用目录 (appDir/)                                  │
│  │  ├─ config/          应用全局配置                    │
│  │  ├─ cache/           缓存数据                        │
│  │  ├─ data/            持久化数据（数据库、会话）      │
│  │  └─ logs/            日志文件                        │
│  └─ 工作区目录 (workspaceDir/)                          │
│     └─ .pi-workbench/   工作区配置                      │
│        ├─ config.json   工作区设置                      │
│        ├─ sessions/     会话历史（待实现）              │
│        └─ plugins/      项目插件（待实现）              │
└─────────────────────────────────────────────────────────┘
```

---

### 数据存储策略（便携式架构）

**设计原则**: 应用是自包含的，所有运行时数据存储在应用目录内，不依赖系统标准路径

#### 应用目录结构

```
应用安装目录/
├── Pi Workbench.exe       # 可执行文件
├── resources/             # 应用资源（只读）
│   ├── app.asar          # 打包后的应用代码
│   └── ...
├── config/                # ⭐ 应用全局配置
│   ├── settings.json     # 用户设置（主题、语言等）
│   └── api-config.json   # API 配置（Key 加密存储）
├── cache/                 # ⭐ 缓存数据
│   └── temp/             # 临时文件
├── data/                  # ⭐ 持久化数据
│   ├── workspaces.db     # 工作区数据库（SQLite）
│   └── sessions/         # 跨工作区会话历史
└── logs/                  # ⭐ 日志文件
    ├── main.log          # 主进程日志
    └── renderer.log      # 渲染进程日志
```

#### 路径类型和用途

| 类型 | 位置 | 说明 | 示例 |
|------|------|------|------|
| **应用数据** | `{appDir}/config/` | 应用级配置、缓存、日志 | API Keys, 全局设置 |
| **工作区数据** | `{workspaceDir}/.pi-workbench/` | 项目级配置、插件 | 项目配置、自定义工具 |
| **临时数据** | `{appDir}/cache/temp/` | 运行时临时文件 | Diff 缓存、下载临时文件 |
| **用户文件** | `{workspaceDir}/` | 用户的项目文件 | 源代码、文档 |

#### 完整路径映射表

| 数据类型 | 存储位置 | 说明 | Phase |
|---------|---------|------|-------|
| **应用配置** | `{appDir}/config/settings.json` | 用户设置（语言、主题、自动保存等） | Phase 0 ✅ |
| **API 配置** | `{appDir}/config/api-config.json` | Provider / URL / API Key（safeStorage 加密）/ 模型 | Phase 1 ✅ |
| **Agent 配置** | `{appDir}/config/agent-config.json` | 全局 Agent 配置（模型、温度等） | Phase 1 |
| **快捷键配置** | `{appDir}/config/keybindings.json` | 自定义快捷键 | Phase 6 |
| **主题文件** | `{appDir}/config/themes/` | 自定义主题 | Phase 6 |
| **工作区数据库** | `{appDir}/data/workspaces.db` | 工作区列表和元数据（SQLite） | Phase 2 |
| **全局会话** | `{appDir}/data/sessions/{session-id}.json` | 跨工作区会话历史 | Phase 2 |
| **Fleet 任务** | `{appDir}/data/fleet-tasks.db` | 后台任务元数据 | Phase 5 |
| **Diff 缓存** | `{appDir}/cache/temp/diff-{id}.txt` | 临时 Diff 文件 | Phase 0 ✅ |
| **编辑历史** | `{appDir}/cache/edit-history/` | 撤销/重做历史 | Phase 6 |
| **自动保存草稿** | `{appDir}/cache/drafts/` | 崩溃恢复数据 | Phase 6 |
| **主进程日志** | `{appDir}/logs/main.log` | Electron 主进程日志 | Phase 2 |
| **渲染进程日志** | `{appDir}/logs/renderer.log` | React 渲染进程日志 | Phase 2 |
| **Agent 日志** | `{appDir}/logs/agent.log` | Pi Agent 运行日志 | Phase 1 |
| **工作区日志** | `{appDir}/logs/workspace-{id}.log` | 工作区特定日志 | Phase 2 |
| **Fleet 任务日志** | `{appDir}/logs/fleet-{task-id}.log` | 后台任务日志 | Phase 5 |
| **工作区配置** | `{workspaceDir}/.pi-workbench/config.json` | 项目级配置（Agent、插件等） | Phase 2 |
| **工作区会话** | `{workspaceDir}/.pi-workbench/sessions/` | 项目会话历史 | Phase 2 |
| **工作区插件** | `{workspaceDir}/.pi-workbench/plugins/` | 项目插件目录 | Phase 4 |
| **Fleet Worktrees** | `{workspaceDir}/.pi-worktrees/{task-name}/` | 后台任务 worktree | Phase 5 |

#### 实现要求

```typescript
// ✅ 正确：基于可执行文件的路径
const appDir = path.dirname(app.getPath('exe'))
const configDir = path.join(appDir, 'config')
const cacheDir = path.join(appDir, 'cache')
const dataDir = path.join(appDir, 'data')
const logsDir = path.join(appDir, 'logs')

// ❌ 禁止：使用系统标准路径（违反便携式约束）
const userData = app.getPath('userData')    // 不要使用！
const appData = app.getPath('appData')      // 不要使用！
```

#### 安装策略

- **安装版**: 默认安装到 `%LOCALAPPDATA%\Programs\Pi Workbench\`（Windows）
  - Per-user 安装，无需管理员权限
  - 用户目录有写权限
- **便携版**: 用户解压到任意位置（如 U 盘）
  - 整个目录可拷贝
  - 无需安装，解压即用

#### 优势

- ✅ **真正便携**: 可整个目录拷贝到 U 盘或其他电脑运行
- ✅ **易于备份**: 一个目录包含所有数据
- ✅ **多版本共存**: 不同版本不会冲突
- ✅ **易于清理**: 删除目录即可完全卸载
- ✅ **不污染系统**: 不在系统标准目录留下痕迹

---

### 当前架构（v2.0 - Electron）

```
┌─────────────────────────────────────────────────────────┐
│                 Electron 应用层                          │
├─────────────────────────────────────────────────────────┤
│  前端层 (React 19 + Vite)                               │
│  ├─ 组件层                                              │
│  │  ├─ FileExplorer     文件浏览器                      │
│  │  ├─ MonacoEditor     代码编辑器                      │
│  │  ├─ ChatPanel        聊天面板                        │
│  │  ├─ DiffViewer       Diff 查看器                     │
│  │  ├─ Settings         设置面板                        │
│  │  ├─ Toast            通知系统                        │
│  │  └─ IPCDebug         IPC 调试                        │
│  ├─ 状态管理 (Zustand)                                  │
│  │  ├─ editorStore      编辑器状态                      │
│  │  ├─ chatStore        聊天状态                        │
│  │  ├─ diffStore        Diff 状态                       │
│  │  ├─ errorStore       错误处理                        │
│  │  ├─ i18nStore        国际化                          │
│  │  └─ agentStore       Agent 状态                      │
│  └─ API 层 (src/api/)                                   │
│     ├─ index.ts          统一 API 接口                  │
│     ├─ diff.ts           Diff 工具                      │
│     └─ piAgent.ts        Pi Agent (目前为 Mock)         │
├─────────────────────────────────────────────────────────┤
│  通信层 (Electron IPC)                                   │
│  ├─ fs:selectDirectory   选择目录                        │
│  ├─ fs:readDirectory     读取目录                        │
│  ├─ fs:readFile          读取文件                        │
│  ├─ fs:writeFile         写入文件                        │
│  └─ fs:deleteFile        删除文件（待实现）              │
├─────────────────────────────────────────────────────────┤
│  主进程层 (Electron Main Process - TypeScript)          │
│  ├─ electron/main.ts                                     │
│  │  ├─ 窗口管理          BrowserWindow                  │
│  │  ├─ IPC 处理器        ipcMain.handle()              │
│  │  └─ 菜单和托盘        (待实现)                       │
│  └─ electron/preload.ts                                 │
│     └─ contextBridge     安全的 API 暴露               │
├─────────────────────────────────────────────────────────┤
│  Node.js 层（与主进程同进程）                            │
│  ├─ 文件系统操作         Node.js fs/promises           │
│  ├─ 路径处理             Node.js path                  │
│  ├─ 对话框               Electron dialog               │
│  └─ Pi Agent 桥接（已实现）                             │
│     ├─ pi-bridge/        AgentManager                  │
│     ├─ @earendil-works/pi-coding-agent                 │
│     └─ @earendil-works/pi-ai                           │
├─────────────────────────────────────────────────────────┤
│  存储层（便携式架构）                                    │
│  ├─ 应用目录 (appDir/)                                  │
│  │  ├─ config/          应用全局配置                    │
│  │  ├─ cache/           缓存数据                        │
│  │  ├─ data/            持久化数据（数据库、会话）      │
│  │  └─ logs/            日志文件                        │
│  └─ 工作区目录 (workspaceDir/)                          │
│     └─ .pi-workbench/   工作区配置                      │
│        ├─ config.json   工作区设置                      │
│        ├─ sessions/     会话历史（待实现）              │
│        └─ plugins/      项目插件（待实现）              │
└─────────────────────────────────────────────────────────┘
```

### 技术栈

#### 桌面框架
- **Electron 44.9.1**（Node 24，Pi SDK 要求 Node ≥22.19）
  - 理由：成熟的生态系统、易于调试、丰富的社区支持
  - 与 Tauri 对比：打包体积更大（~120MB vs ~40MB），但开发体验更好

#### 前端技术
- **React 19**: 最新的 UI 框架
- **Vite 5**: 快速的构建工具和 HMR
- **Monaco Editor**: VS Code 的编辑器内核
- **Zustand**: 轻量级状态管理（< 1KB）
- **TailwindCSS**: 原子化 CSS 框架

#### 后端技术（主进程）
- **TypeScript**: 类型安全的 Node.js
- **Node.js fs/promises**: 异步文件操作
- **Electron API**: 窗口、对话框、IPC

#### Agent 内核（待集成）
- **@earendil-works/pi-coding-agent**: Agent 运行时（含 read/write/edit/bash 工具）
- **@earendil-works/pi-ai**: 统一 LLM API
- **@earendil-works/pi-ai**: 模型与供应商抽象（ModelRuntime）
- **支持的 LLM**: Anthropic Claude, OpenAI GPT-4

---

## 📂 项目结构

```
pi-workbench/
├── electron/                      # Electron 主进程
│   ├── main.ts                   # 主进程入口、窗口管理、IPC
│   ├── preload.ts                # 预加载脚本、contextBridge
│   └── tsconfig.json             # TypeScript 配置
│
├── src/                          # React 渲染进程
│   ├── components/               # React 组件
│   │   ├── ChatPanel.tsx        # 聊天面板
│   │   ├── DiffViewer.tsx       # Diff 查看器
│   │   ├── Editor.tsx           # 编辑器封装
│   │   ├── FileExplorer.tsx     # 文件浏览器
│   │   ├── IPCDebug.tsx         # IPC 调试
│   │   ├── MonacoEditor.tsx     # Monaco 集成
│   │   ├── Settings.tsx         # 设置面板
│   │   └── Toast.tsx            # 通知
│   ├── store/                   # Zustand 状态
│   │   ├── agentStore.ts
│   │   ├── chatStore.ts
│   │   ├─ diffStore.ts
│   │   ├── editorStore.ts
│   │   ├── errorStore.ts
│   │   └── i18nStore.ts
│   ├── api/                     # API 封装
│   │   ├── index.ts             # Electron IPC 封装
│   │   ├── diff.ts              # Diff 算法
│   │   └── piAgent.ts           # Pi Agent Mock
│   ├── types/                   # TypeScript 类型
│   │   ├── electron.d.ts        # Electron API 类型
│   │   └── index.ts             # 通用类型
│   ├── i18n/                    # 国际化
│   │   └── translations.ts      # 中英文翻译
│   ├── styles/                  # 样式
│   │   └── Settings.css
│   ├── App.tsx                  # 主应用组件
│   ├── main.tsx                 # React 入口
│   └── vite-env.d.ts            # Vite 类型
│
├── pi-bridge/                    # Pi Agent 桥接（待实现）
│   ├── src/
│   │   ├── index.ts             # 主入口
│   │   ├── agent-manager.ts     # Agent 管理
│   │   └── types.ts             # 类型定义
│   ├── package.json
│   └── tsconfig.json
│
├── docs/                         # 项目文档
│   ├── README.md                # 文档导航
│   ├── architecture/            # 架构设计
│   ├── guides/                  # 开发指南
│   ├── progress/                # 项目进度
│   └── reports/                 # 审查报告
│
├── dist/                         # Vite 构建输出
├── dist-electron/                # Electron 构建输出
├── release/                      # 应用打包输出
│
├── package.json                  # 项目依赖
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 配置
├── electron-builder.yml          # 打包配置
├── tailwind.config.js            # Tailwind 配置
└── README.md                     # 项目说明
```

---

## 🔧 核心模块设计

### 模块 1: 文件管理（已实现）

**功能**:
- 选择工作区目录
- 递归读取文件树
- 文件读写操作
- 不可变状态更新

**API**:
```typescript
// 选择目录
const result = await api.openDirectoryDialog()

// 读取目录
const items = await api.listDirectory(path)

// 读取文件
const content = await api.readFile(filePath)

// 写入文件
await api.writeFile(filePath, content)
```

---

### 模块 2: 代码编辑（已实现）

**功能**:
- Monaco Editor 集成
- 多标签页管理
- 自动保存（2秒防抖）
- 语法高亮

**状态管理**:
```typescript
interface EditorState {
  openFiles: OpenFile[]
  currentFileIndex: number | null
  unsavedChanges: Set<string>
}
```

---

### 模块 3: 对话交互

**Phase 0 的 Mock 实现已移除**（原 `src/api/piAgent.ts` 已删除）。

**实际实现**:
```typescript
// pi-bridge/src/agent-manager.ts
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'

class AgentManager {
  async initialize(config: AgentConfig) {
    // 1. 将 provider / baseUrl / model 写入 models.json
    //    （apiKey 用 $PI_WORKBENCH_API_KEY 环境变量插值，不落盘）
    // 2. 用 ModelRuntime 解析自定义 provider 的模型
    const modelRuntime = await ModelRuntime.create({ modelsPath, authPath })
    const model = modelRuntime.getModel('pi-workbench', config.apiConfig.selectedModel)

    // 3. 创建会话（内置 read/write/edit/bash 工具）
    const { session } = await createAgentSession({
      cwd: config.workspaceDir,
      agentDir,
      modelRuntime,
      model,
    })
    return session
  }
}
```

---

### 模块 4: Diff 查看（已实现）

**功能**:
- Split 视图（并排对比）
- Unified 视图（统一视图）
- 行级差异算法

**使用**:
```typescript
import { showCodeDiff } from './api/diff'

// 显示差异
showCodeDiff(originalCode, modifiedCode)
```

---

### 模块 5: 工作区管理（待实现）

**设计**:
```typescript
interface Workspace {
  id: string                     // UUID
  path: string                   // 项目路径
  name: string                   // 工作区名称
  agents: AgentInstance[]        // Agent 实例
  config: WorkspaceConfig        // 配置
  createdAt: number
  lastAccessedAt: number
}

interface WorkspaceConfig {
  defaultModel: string           // 默认 LLM
  autoSave: boolean              // 自动保存
  enabledPlugins: string[]       // 启用的插件
}
```

---

### 模块 6: 终端（待实现）

**技术方案**:
- 前端: xterm.js
- 后端: node-pty (PTY 支持)
- 通信: Electron IPC

**实现**:
```typescript
// 主进程
import { spawn } from 'node-pty'

ipcMain.handle('terminal:spawn', (_, cwd) => {
  const ptyProcess = spawn('bash', [], {
    name: 'xterm-color',
    cwd: cwd,
    env: process.env
  })
  
  return terminalId
})

// 渲染进程
import { Terminal } from 'xterm'

const term = new Terminal()
term.open(document.getElementById('terminal'))
```

---

### 模块 7: 插件系统（待实现 - 简化版）

**设计理念**:
- 本地加载（从 `.pi-workbench/plugins/`）
- 无需安装、无需签名
- 简单的 TypeScript SDK
- 为 Agent 添加自定义工具

**插件格式**:
```
.pi-workbench/plugins/my-plugin/
├── manifest.json
└── index.ts
```

**manifest.json**:
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "index.ts",
  "tools": [
    {
      "name": "my_tool",
      "description": "Do something"
    }
  ]
}
```

**index.ts**:
```typescript
export default {
  id: 'my-plugin',
  
  tools: [{
    name: 'my_tool',
    description: 'Do something useful',
    async execute(params) {
      // 实现工具逻辑
      return { result: 'done' }
    }
  }]
}
```

---

## 📅 开发路线图

### ✅ Phase 0: MVP 完成 (已完成 - 2026-10-20)

- ✅ Electron 框架搭建
- ✅ 文件管理（浏览、读写）
- ✅ Monaco Editor 集成
- ✅ 多标签页支持
- ✅ 聊天面板（Mock Agent）
- ✅ Diff 查看器
- ✅ 中英文国际化
- ✅ Toast 通知系统
- ✅ 错误处理
- ✅ 应用图标

**当前状态**: 可以打开项目、浏览文件、编辑代码、查看差异、模拟对话

---

### ✅ Phase 1: Pi Agent 真实集成（2026-10-20 完成）

**目标**: 替换 Mock Agent 为真实的 Pi Agent

**结果**: 已完成，详细记录见 [progress/PHASE-1-COMPLETE.md](./progress/PHASE-1-COMPLETE.md)

**实际实现**:
1. 依赖：`@earendil-works/pi-coding-agent` 1.3.0（早期规划中的 pi-agent-core / pi-durable 未使用）
2. `AgentManager`（`pi-bridge/src/agent-manager.ts`）运行在主进程
   - 生成 `{appDir}/data/agent/models.json`，支持任意 OpenAI 兼容端点
   - API Key 通过环境变量 `$PI_WORKBENCH_API_KEY` 插值，不写入磁盘
3. 统一 API 配置：Provider + Base URL + API Key + 模型列表 + 选择模型
   - API Key 通过 Electron `safeStorage` 加密存储在 `{appDir}/config/api-config.json`
   - 真实调用供应商 `/models` 拉取模型
4. 工具：read / write / edit / bash 由 SDK 内置，在主进程中直接执行
   （原“文件操作必须通过 IPC”的约束据此调整：渲染进程仍无 Node 权限，安全边界为主进程）
5. 纯 Web 开发模式：Vite 中间件提供模型拉取代理与 Agent 桥接（仅 `vite dev`）

**验证**:
- ✅ Agent 实例创建成功，模型解析为 `pi-workbench/<model>`
- ✅ 供应商错误（401 等）透传到 UI
- ✅ Web 与 Electron 两种模式均可真实对话
- ✅ `type-check` / `build` 通过

**遗留项（转入后续阶段）**:
- 流式输出
- 会话持久化与恢复
- Agent 编辑与 DiffViewer 联动
- 安装包完整冒烟测试

---

### 🔄 Phase 2: 工作区管理 (预计 1-2 周)

**目标**: 支持多工作区切换和会话持久化

**任务**:
1. 工作区数据结构设计
   ```typescript
   interface Workspace {
     id: string                     // UUID
     path: string                   // 项目路径
     name: string                   // 工作区名称
     config: WorkspaceConfig        // 配置
     createdAt: number
     lastAccessedAt: number
   }
   ```

2. SQLite 数据库集成
   - **数据库位置**: `{appDir}/data/workspaces.db`
   - 存储工作区列表和元数据
   - 使用 `better-sqlite3` 或 `sql.js`

3. 工作区初始化
   - 创建工作区时初始化 `.pi-workbench/` 目录
   - 生成默认配置文件
   - **配置位置**: `{workspaceDir}/.pi-workbench/config.json`

4. Agent 实例与工作区绑定
   - 每个工作区独立的 Agent 实例
   - Agent 工作目录设置为工作区路径
   - Agent 配置从工作区配置读取

5. 会话历史保存和恢复
   - **全局会话**: `{appDir}/data/sessions/{session-id}.json`
   - **工作区会话**: `{workspaceDir}/.pi-workbench/sessions/{session-id}.json`
   - 区分策略：跨工作区会话用全局，单工作区会话用工作区目录

6. 工作区切换
   - 保存当前工作区状态
   - 加载目标工作区状态
   - 切换 Agent 实例

7. 日志管理
   - **日志位置**: `{appDir}/logs/`
   - `main.log`: 主进程日志
   - `renderer.log`: 渲染进程日志
   - `agent.log`: Agent 运行日志
   - `workspace-{id}.log`: 工作区特定日志

**验收标准**:
- ✅ 能同时管理多个项目工作区
- ✅ 切换工作区时 Agent 和历史记录正确切换
- ✅ 关闭应用后能恢复上次的工作区状态
- ✅ 所有数据存储符合便携式架构
- ✅ 数据库文件在应用目录内

---

### 🔄 Phase 3: 终端集成 (预计 1 周)

**目标**: 集成终端，支持命令执行

**任务**:
1. 集成 xterm.js
2. 集成 node-pty
3. IPC 通信实现
4. bash 工具集成到 Agent

**验收标准**:
- 能在应用内打开终端
- 能执行 bash 命令
- Agent 能调用 bash 工具执行命令

---

### 🔄 Phase 4: 插件系统（简化版） (预计 2 周)

**目标**: 实现本地插件加载和工具扩展

**任务**:
1. 插件加载器实现
   - **插件位置**: `{workspaceDir}/.pi-workbench/plugins/`
   - 扫描插件目录
   - 加载 manifest.json
   - 动态 require 插件代码

2. 插件 SDK 设计
   - 定义插件接口 (`PluginInterface`)
   - 工具注册 API
   - Agent 工具系统集成

3. 插件热重载
   - 监听插件目录变化
   - 卸载旧版本
   - 重新加载新版本

4. 示例插件开发
   - Git 插件（查看状态、提交、推送）
   - GitHub API 插件（创建 issue、PR）
   - **约束**: 插件无沙箱，仅用于个人项目

**验收标准**:
- ✅ 能从 `.pi-workbench/plugins/` 加载插件
- ✅ 插件能为 Agent 添加自定义工具
- ✅ 修改插件后能热重载
- ✅ 插件配置存储在工作区目录

---

### 🔄 Phase 5: Fleet 任务系统 (预计 2-3 周)

**目标**: 支持后台 Agent 任务

**任务**:
1. Git worktree 管理
   - **Worktree 位置**: `{workspaceDir}/.pi-worktrees/{task-name}/`
   - 创建独立的 worktree
   - 管理 worktree 生命周期

2. 后台 Agent 实例
   - 为每个任务创建独立的 Agent 实例
   - Agent 工作目录设置为 worktree 路径
   - 任务之间互不干扰

3. 任务队列系统
   - **任务数据库**: `{appDir}/data/fleet-tasks.db`
   - 任务状态管理（pending, running, completed, failed）
   - 任务优先级队列

4. 任务状态监控
   - 实时任务进度更新
   - 任务日志收集：`{appDir}/logs/fleet-{task-id}.log`
   - 任务结果展示

**验收标准**:
- ✅ 能创建独立的 worktree 执行任务
- ✅ 任务在后台运行不阻塞主 Agent
- ✅ 能查看任务进度和结果
- ✅ Worktree 在工作区目录内
- ✅ 任务元数据在应用数据库中

---

### 🔄 Phase 6: 优化和完善 (持续进行)

**任务**:
- 性能优化（大文件、大项目）
  - 虚拟滚动
  - 文件懒加载
  - Monaco Editor 性能调优
  
- 文件监听（外部修改同步）
  - 使用 `chokidar` 监听文件变化
  - 自动重新加载外部修改的文件
  
- 撤销/重做系统
  - 编辑历史管理
  - **历史存储**: `{appDir}/cache/edit-history/`
  
- 快捷键支持
  - 定义全局快捷键
  - 快捷键配置：`{appDir}/config/keybindings.json`
  
- 主题系统（明暗主题）
  - 主题配置：`{appDir}/config/themes/`
  - 自定义主题支持
  
- 错误恢复机制
  - 自动保存草稿：`{appDir}/cache/drafts/`
  - 崩溃恢复
  
- 日志管理优化
  - 日志轮转（按日期或大小）
  - 日志清理策略
  - **日志位置**: `{appDir}/logs/`

**所有新增功能必须符合便携式架构约束**
- 性能优化（大文件、大项目）
- 文件监听（外部修改同步）
- 快捷键支持
- 主题系统
- 错误恢复机制
- 单元测试

---

## 🚀 快速开始

### 环境要求
- Node.js 18+
- npm 或 pnpm

### 安装依赖
```bash
npm install
npm run build:bridge
```

### 开发模式
```bash
# 完整开发环境
npm run dev

# 仅浏览器开发
npm run web:dev

# 仅 Electron
npm run electron:dev
```

### 构建
```bash
npm run build              # 构建所有
npm run build:renderer     # 仅前端
npm run build:main         # 仅主进程
```

### 打包
```bash
npm run package            # 当前平台
npm run package:win        # Windows
npm run package:mac        # macOS
npm run package:linux      # Linux
```

---

## 📝 技术决策记录

### 为什么选择 Electron 而不是 Tauri？

**Tauri 优势**:
- 包体积更小（~40MB vs ~120MB）
- 更低的内存占用
- 使用系统 WebView

**Electron 优势** (我们选择的原因):
- 更成熟的生态系统
- 更好的开发体验（Chrome DevTools）
- 更简单的调试流程
- 不需要 Rust 工具链
- 更大的社区和更多的资源

**结论**: 对于快速迭代和开发体验优先的项目，Electron 是更好的选择。

### 为什么用 Zustand 而不是 Redux？

- 更轻量（< 1KB）
- 更简单的 API
- 无需 Provider 包装
- TypeScript 友好
- 足够满足需求

### 为什么插件系统采用简化设计？

- 个人项目，不需要复杂的沙箱和权限系统
- 本地加载更灵活，开发更快
- 按需开发插件，不预先实现所有功能
- 降低维护成本

### 为什么采用便携式架构？

**传统应用数据目录**（系统标准路径）:
- Windows: `%APPDATA%\pi-workbench\` 或 `%LOCALAPPDATA%\pi-workbench\`
- macOS: `~/Library/Application Support/pi-workbench/`
- Linux: `~/.config/pi-workbench/`

**便携式架构** (我们的选择):
- 所有应用数据在应用目录内
- 安装版默认安装到 `%LOCALAPPDATA%\Programs\Pi Workbench\`（有写权限）
- 便携版可解压到任意位置

**优势**:
- ✅ **真正便携**: 可整个目录拷贝到 U 盘或其他电脑运行，无需重新安装
- ✅ **易于备份**: 一个目录包含所有数据，备份只需拷贝整个文件夹
- ✅ **多版本共存**: 不同版本各自独立，不会相互干扰
- ✅ **易于清理**: 删除目录即可完全卸载，不留残留
- ✅ **不污染系统**: 不在系统标准目录留下数据，保持系统干净
- ✅ **开发友好**: 开发和测试时可以快速创建多个独立实例

**劣势**:
- ❌ 不符合系统标准（但我们认为优势更重要）
- ❌ 需要确保安装目录有写权限（通过 per-user 安装解决）
- ❌ 用户数据不会自动同步到云端（但可以手动备份整个目录）

**结论**: 对于开发工具类应用，便携性、易管理性和多版本共存比遵循系统规范更重要。用户可以轻松地在多台电脑间迁移工作环境，或者同时使用多个版本进行测试。
- 按需开发插件，不预先实现所有功能
- 降低维护成本

---

## 📚 参考资源

### 官方文档
- [Electron 文档](https://www.electronjs.org/docs/latest/)
- [React 文档](https://react.dev/)
- [Vite 文档](https://vitejs.dev/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)

### Pi Agent 文档
- Pi Agent Core (待添加链接)
- Pi AI (待添加链接)

### 参考项目
- [Cursor IDE](https://cursor.sh/)
- [ControlCode](https://github.com/luis3132/ControlCode)
- [ZeroClaw Studio](https://github.com/goasleep/zeroclaw-studio)

---

## 🎯 项目目标

### 短期目标 (3 个月)
- ✅ 完成 MVP（已完成）
- 🔄 集成真实的 Pi Agent
- 🔄 实现工作区管理
- 🔄 集成终端功能

### 中期目标 (6 个月)
- 实现插件系统
- Fleet 任务系统
- 性能优化
- 完善文档

### 长期目标 (1 年)
- 稳定的 1.0 版本
- 丰富的插件生态
- 社区贡献
- 持续优化

---

**项目版本**: 2.0 (基于 Electron)  
**最后更新**: 2026-10-20  
**开发状态**: 活跃开发中

🚀 **让我们开始吧！**
