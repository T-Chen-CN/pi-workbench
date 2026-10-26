# Pi Workbench - AI Agent 开发指南

> 本文件为 AI 助手（Claude、Pi Agent 等）提供项目特定的上下文、约束和最佳实践

**项目**: Pi Workbench  
**架构**: Electron 44 + React 19 + TypeScript
**运行要求**: Node.js ≥ 24（Electron 44 内置 Node 24，node:sqlite 与构建脚本均依赖）
**当前阶段**: Phase 6 持续优化
**最后更新**: 2026-10-26

---

## 🎯 项目概述

这是一个**轻量级 AI 辅助开发工作台**，类似 Cursor IDE，使用 **Electron** 构建桌面应用，集成 **Pi Agent** 作为智能助手内核。

### 核心目标

- 提供流畅的 AI 辅助编程体验
- 支持多工作区和多 Agent 协作
- 简洁易扩展的插件系统
- 跨平台（Windows/macOS/Linux）
- **便携式架构**: 所有数据自包含，无外部路径依赖

### 当前状态

- ✅ MVP 完成：文件管理、代码编辑、Diff 查看、聊天界面
- ✅ Phase 1 完成：Pi Agent 真实集成
- ✅ Phase 2 完成：工作区与对话体验（流式输出、修改审阅、上下文选择、多工作区）
- ✅ Phase 3 完成：终端集成（xterm + node-pty，输出可附加给 Agent）
- ✅ Phase 4 完成：工作台插件系统（命令 / 钩子 / 命令面板，示例 Git 插件）
- ✅ 多工作区常驻视图：每个打开的工作区保留完整运行时状态，切换标签或返回首页不重建；关闭标签只释放运行时，打开的文件与会话落盘恢复
- 🟡 Phase 6 持续：性能、快捷键、主题、崩溃恢复、自动更新等

---

## 📂 项目结构

```
pi-workbench/
├── electron/          # Electron 主进程（TypeScript）
│   ├── main.ts       # 窗口管理、IPC、文件监听、safeStorage、Agent 生命周期
│   ├── preload.cts   # contextBridge API 暴露（CommonJS → preload.cjs）
│   ├── tsconfig.json # 主进程构建（ESM）
│   └── tsconfig.preload.json  # preload 构建（CommonJS）
├── src/              # React 渲染进程
│   ├── components/   # UI 组件（扁平结构）
│   ├── store/        # Zustand 状态管理（独立 store）
│   ├── api/          # Electron IPC 封装 + Web dev 桥接 + diff
│   ├── types/        # TypeScript 类型定义
│   └── i18n/         # 国际化（中英文）
├── pi-bridge/        # Pi Agent 桥接层（AgentManager，已实现）
│   ├── src/
│   └── dist/         # 构建产物（不纳入版本库）
├── tests/            # Vitest 单元测试
├── docs/             # 项目文档
└── 配置文件          # package.json, tsconfig.json, eslint.config.js, vitest.config.ts
```

**重要**:

- 主进程和渲染进程完全分离（Electron 安全模型）
- 所有文件系统操作必须通过 IPC 进行
- 状态管理使用 Zustand，不是 Redux
- 样式使用 TailwindCSS，不是 CSS Modules

---

## 🔧 技术栈和约束

### 必须使用的技术

| 层级      | 技术                                | 版本      | 说明                           |
| --------- | ----------------------------------- | --------- | ------------------------------ |
| 桌面框架  | **Electron**                        | 44.9.1    | ⚠️ 不是 Tauri，已从 Tauri 迁移 |
| 前端框架  | **React**                           | 19.3.1    | 使用函数组件 + Hooks           |
| 构建工具  | **Vite**                            | 5.4.21    | HMR + 快速构建                 |
| 状态管理  | **Zustand**                         | 4.5.7     | ⚠️ 不是 Redux 或 Context API   |
| 编辑器    | **Monaco Editor**                   | 0.57.0    | VS Code 内核                   |
| 样式      | **TailwindCSS**                     | 3.4.19    | 原子化 CSS                     |
| 类型检查  | **TypeScript**                      | 5.9.3     | 严格模式                       |
| 打包      | **electron-builder**                | 26.15.3   | 生成安装包                     |
| Agent SDK | **@earendil-works/pi-coding-agent** | 1.3.0     | 运行在主进程                   |
| 终端      | **@xterm/xterm + node-pty**         | 6.x / 1.1 | 原生模块，打包需 `asarUnpack`  |

### 禁止使用的技术

❌ **Tauri / Rust** - 已迁移到 Electron  
❌ **Redux** - 使用 Zustand  
❌ **CSS Modules** - 使用 TailwindCSS  
❌ **Vue / Angular** - 使用 React  
❌ **Webpack** - 使用 Vite

---

## 🛠️ 开发规范

### 1. 代码组织原则

#### 组件放置规则

```typescript
// ✅ 正确：顶层组件扁平放置，不建子目录
src/components/
├── AgentMarkdown.tsx
├── AgentTrace.tsx
├── ApprovalCard.tsx
├── ChatApiKeyPrompt.tsx
├── ChatHeader.tsx
├── ChatMessageRow.tsx
├── ChatPanel.tsx
├── ChatTranscript.tsx
├── ChatSessionList.tsx
├── CommandPalette.tsx
├── DialogHost.tsx
├── DiffViewer.tsx
├── ErrorBoundary.tsx
├── FileExplorer.tsx
├── IPCDebug.tsx
├── MonacoEditor.tsx
├── SessionTabs.tsx
├── Settings.tsx
├── TerminalPanel.tsx
├── Toast.tsx
├── ToolResultViewer.tsx
├── VirtualRows.tsx
├── UpdateDialog.tsx
├── UpdateStatusIndicator.tsx
├── WelcomeScreen.tsx
├── WindowControls.tsx
├── WorkspaceView.tsx
├── ui.tsx
└── patterns.tsx

// ❌ 错误：不要创建子目录
src/components/chat/ChatPanel.tsx  // 不要这样！
```

#### Store 放置规则

```typescript
// ✅ 正确：每个功能域一个独立 store（13 个）
src/store/
├── approvalStore.ts   // 待审批请求
├── chatStore.ts       // 聊天消息、草稿、附件、排队消息
├── dialogStore.ts     // 应用内确认/输入对话框（替代 confirm/prompt）
├── diffStore.ts       // Diff 查看器（按工作区隔离）
├── editorStore.ts     // 编辑器标签页、脏标记（按工作区隔离）
├── i18nStore.ts       // 语言切换
├── selectionStore.ts  // 编辑器选区片段
├── sessionStore.ts    // 会话标签与运行状态（按工作区隔离）
├── settingsStore.ts   // 自动保存、默认模式、通知、快捷键
├── themeStore.ts      // Paper / Ink 主题
├── toastStore.ts      // 全局 Toast（组件外也可调用）
├── updaterStore.ts    // 更新状态
└── workspaceStore.ts  // 当前工作区 + 最近打开

// ❌ 错误：不要合并 store
src/store/appStore.ts  // 不要创建巨大的单一 store！
```

---

### 2. IPC 通信规范

**所有文件系统操作必须通过 IPC！**

**工作区信任**：

- ✅ 工作区根目录只能由主进程批准：原生目录选择器的结果，或启动时从 `config/settings.json` 载入的最近工作区
- ✅ 文件写 / 删 / 改只允许发生在受信任工作区与应用缓存目录（`{appDir}/cache/`）内；校验使用 `realpath` 规范化 + `path.relative` 判断包含关系
- ❌ 禁止让渲染进程通过 `workspace:init` 自行注册任意目录；最近工作区由主进程 SQLite 独占管理，渲染层不再保存 `recentWorkspaces`

#### ✅ 正确的做法

```typescript
// 渲染进程 (src/api/index.ts)
export const api = {
  async readFile(path: string) {
    return window.electronAPI.readFile(path)
  }
}

// 主进程 (electron/main.ts)
ipcMain.handle('fs:readFile', async (_, path: string) => {
  const content = await fs.readFile(path, 'utf-8')
  return { success: true, content }
})
```

#### ❌ 错误的做法

```typescript
// ❌ 渲染进程中直接使用 Node.js API
import fs from 'fs' // 这会失败！渲染进程没有 Node.js 权限

// ❌ 绕过 contextBridge
window.require('fs') // 安全风险，已禁用 nodeIntegration
```

---

### 3. 状态管理规范

#### ✅ 使用 Zustand

```typescript
// src/store/editorStore.ts
import { create } from 'zustand'

interface EditorState {
  openFiles: OpenFile[]
  currentFileIndex: number | null
  openFile: (file: OpenFile) => void
  closeFile: (index: number) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  openFiles: [],
  currentFileIndex: null,
  openFile: (file) =>
    set((state) => ({
      openFiles: [...state.openFiles, file]
    })),
  closeFile: (index) =>
    set((state) => ({
      openFiles: state.openFiles.filter((_, i) => i !== index)
    }))
}))

// 在组件中使用
const { openFiles, openFile } = useEditorStore()
```

#### ❌ 不要使用 Redux

```typescript
// ❌ 不要创建 Redux store
import { createStore } from 'redux' // 不要使用！

// ❌ 不要使用 Context API 做全局状态
const AppContext = React.createContext() // Zustand 更好！
```

---

### 4. 文件操作规范

#### 不可变状态更新（重要！）

```typescript
// ✅ 正确：使用展开运算符创建新数组
setItems(items.map((item) => (item.path === targetPath ? { ...item, isExpanded: !item.isExpanded } : item)))

// ❌ 错误：直接修改对象（会导致无限递归！）
const item = items.find((i) => i.path === path)
item.isExpanded = true // 不要这样！会触发无限重渲染
setItems([...items])
```

#### 文件路径处理

```typescript
// ✅ 正确：使用 path.join 处理跨平台路径
import path from 'path'
const fullPath = path.join(dirPath, fileName)

// ❌ 错误：手动拼接路径
const fullPath = `${dirPath}/${fileName}` // Windows 会失败！
```

---

### 5. 文件路径规范（便携式约束）

**核心原则**: 所有应用数据必须在应用目录内，不得使用系统标准路径

#### 获取应用目录

```typescript
// ✅ 正确：基于可执行文件路径（便携式；macOS 例外见下）
import { app } from 'electron'
import path from 'path'

function getAppDir(): string {
  // AppImage：可执行文件在只读挂载点，数据放在 .AppImage 旁边
  if (process.env.APPIMAGE) return path.dirname(process.env.APPIMAGE)
  if (!app.isPackaged) return app.getAppPath() // 开发模式
  if (process.platform === 'darwin') {
    // macOS 应用包内不可写，且更新会整体替换 .app。
    // 经项目所有者确认，macOS 使用系统标准数据目录作为例外。
    return path.join(app.getPath('appData'), 'pi-workbench')
  }
  return path.dirname(app.getPath('exe')) // Windows / Linux 生产模式
}

const appDir = getAppDir()
const configDir = path.join(appDir, 'config') // 配置目录
const cacheDir = path.join(appDir, 'cache') // 缓存目录
const dataDir = path.join(appDir, 'data') // 数据目录
const logsDir = path.join(appDir, 'logs') // 日志目录

// ❌ 错误：使用系统标准路径（除 macOS 已确认的例外）
const userData = app.getPath('userData') // 不要使用！
// Windows: C:\Users\xxx\AppData\Roaming\pi-workbench
// macOS: ~/Library/Application Support/pi-workbench

const home = app.getPath('home') // 不要使用！
const documents = app.getPath('documents') // 不要使用！
```

> **macOS 例外（2026-10-23 经项目所有者确认）**：macOS 应用包内不可写、且自动更新会替换整个 `.app`，因此打包版的数据目录使用 `~/Library/Application Support/pi-workbench`。Windows / Linux 仍严格遵循便携式约束。不要在 macOS 上按“禁止系统路径”改回应用包内。

#### 启动期路径约束（必须遵守）

- ✅ `app.setPath('userData', '{appDir}/data/profile')` 必须在 `app.requestSingleInstanceLock()` **之前**执行；否则单实例锁会先在默认 userData（`%APPDATA%\pi-workbench`）创建目录与锁文件。
- ✅ Pi SDK 的全局目录必须通过 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 指向 `{appDir}/data/agent`，且必须在任何 Pi SDK 模块加载之前设置（`electron/app-paths.ts` 在模块加载时完成，`main.ts` 第一个导入它）。禁止使用 `~/.pi`。
- ✅ 启动时回收/清理旧版本遗留：`~/.pi` 合并进 `{appDir}/data/agent` 后删除（检测到独立 Pi CLI 时保留）；删除旧默认 userData 与安装器在 LOCALAPPDATA 的差分副本。实现见 `electron/legacy-paths.ts`，仅打包版执行。
- ✅ electron-builder 安装器会把自身复制到 `%LOCALAPPDATA%\{updaterCacheDirName}\installer.exe`；`customInstall` 在安装完成后删除它，启动清理兜底。
- ❌ 禁止在 `~/.pi`、`%APPDATA%`、`%LOCALAPPDATA%` 等系统目录保存应用数据；唯一例外见“自动更新约束”的更新包缓存。

#### 路径分类和用途

```typescript
// ✅ 应用级数据：在应用目录
const settingsPath = path.join(appDir, 'config', 'settings.json')
const apiConfigPath = path.join(appDir, 'config', 'api-config.json') // API Key 使用 safeStorage 加密
const dbPath = path.join(appDir, 'data', 'workspaces.db')
const logPath = path.join(appDir, 'logs', 'main.log')

// ✅ 工作区级数据：在工作区目录（用户选择的项目目录）
const workspaceConfig = path.join(workspacePath, '.pi-workbench', 'config.json')
const workspacePlugins = path.join(workspacePath, '.pi-workbench', 'plugins')

// ✅ 临时数据：在应用缓存目录
const tempFile = path.join(appDir, 'cache', 'temp', `diff-${Date.now()}.txt`)
```

#### 初始化目录结构

```typescript
// electron/main.ts - 应用启动时创建必要的目录
async function initAppDirectories() {
  const appDir = getAppDir()

  const dirs = [
    path.join(appDir, 'config'),
    path.join(appDir, 'cache'),
    path.join(appDir, 'cache', 'temp'),
    path.join(appDir, 'data'),
    path.join(appDir, 'logs')
  ]

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }

  console.log('应用目录已初始化:', appDir)
}

// 在 app.whenReady() 中调用
app.whenReady().then(async () => {
  await initAppDirectories()
  createWindow()
})
```

#### 工作区配置初始化

```typescript
// 打开工作区时创建 .pi-workbench 目录
async function initWorkspaceConfig(workspacePath: string) {
  const configDir = path.join(workspacePath, '.pi-workbench')
  const pluginsDir = path.join(configDir, 'plugins')

  // 创建目录
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(pluginsDir, { recursive: true })

  // 创建默认配置
  const configPath = path.join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    const defaultConfig = {
      version: '1.0',
      enabledPlugins: []
    }
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2))
  }
}

// 添加 IPC 处理器
ipcMain.handle('workspace:init', async (_, workspacePath: string) => {
  try {
    await initWorkspaceConfig(workspacePath)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

#### 配置文件管理

```typescript
// electron/main.ts - 读写应用配置
async function loadAppSettings() {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')

  if (!existsSync(settingsPath)) {
    // 默认配置
    return {
      language: 'zh-CN',
      theme: 'dark',
      autoSave: true
    }
  }

  const content = await fs.readFile(settingsPath, 'utf-8')
  return JSON.parse(content)
}

async function saveAppSettings(settings: any) {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
}

// IPC 处理器
ipcMain.handle('app:getSettings', async () => {
  try {
    const settings = await loadAppSettings()
    return { success: true, settings }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('app:saveSettings', async (_, settings) => {
  try {
    await saveAppSettings(settings)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})
```

---

### 6. TypeScript 规范

#### 类型定义位置

```typescript
// ✅ 正确：在 src/types/ 定义全局类型
src/types/
├── electron.d.ts    // Electron API 类型
└── index.ts         // 通用类型（Message, OpenFile 等）

// ❌ 错误：在组件内定义全局类型
// ChatPanel.tsx
interface Message { ... }  // 如果其他地方也用，应该放 types/
```

#### 严格类型检查

```typescript
// ✅ 正确：明确的类型注解
const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  // ...
}

// ❌ 错误：使用 any
const handleClick = (event: any) => {
  // 不要使用 any！
  // ...
}
```

---

## 🚫 常见错误和陷阱

### 错误 1: 在渲染进程使用 Node.js API

```typescript
// ❌ 错误
import fs from 'fs'
const data = fs.readFileSync('file.txt')

// ✅ 正确
const data = await window.electronAPI.readFile('file.txt')
```

### 错误 2: 直接修改状态对象

```typescript
// ❌ 错误：会导致 React 无限重渲染
item.isExpanded = true
setItems(items)

// ✅ 正确：创建新对象
setItems(items.map((i) => (i === item ? { ...i, isExpanded: true } : i)))
```

### 错误 3: 混淆 Tauri 和 Electron API

```typescript
// ❌ 错误：Tauri API（已不再使用）
import { invoke } from '@tauri-apps/api/tauri'

// ✅ 正确：Electron API
window.electronAPI.someMethod()
```

### 错误 4: 忘记防抖（Debounce）

```typescript
// ❌ 错误：每次按键都保存文件
onChange={(value) => {
  saveFile(value)  // 性能问题！
}}

// ✅ 正确：使用 useDebounce
const debouncedValue = useDebounce(value, 2000)
useEffect(() => {
  saveFile(debouncedValue)
}, [debouncedValue])
```

### 错误 5: 循环依赖的 useEffect

```typescript
// ❌ 错误：items 变化触发 loadItems，loadItems 又改变 items
useEffect(() => {
  loadItems() // 这会更新 items
}, [items]) // items 变化又触发 useEffect → 无限循环！

// ✅ 正确：只在挂载时执行一次
useEffect(() => {
  loadItems()
}, []) // 空依赖数组
```

### 错误 6: 使用系统标准配置目录（违反便携式约束）

```typescript
// ❌ 错误：使用系统路径
import { app } from 'electron'
const configPath = path.join(app.getPath('userData'), 'config.json')
// 这会存储到：
// Windows: C:\Users\xxx\AppData\Roaming\pi-workbench\
// macOS: ~/Library/Application Support/pi-workbench/

// ❌ 错误：使用其他系统路径
const settingsPath = path.join(app.getPath('appData'), 'settings.json')
const cachePath = path.join(app.getPath('temp'), 'cache')
const logPath = path.join(app.getPath('home'), '.pi-workbench', 'logs')

// ✅ 正确：使用应用目录
function getAppDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd()
}

const appDir = getAppDir()
const configPath = path.join(appDir, 'config', 'config.json')
const cachePath = path.join(appDir, 'cache')
const logPath = path.join(appDir, 'logs', 'app.log')
// 这会存储到应用安装目录内
```

**为什么这是错误的**:

- 违反便携式架构原则
- 无法整体迁移应用（配置留在系统目录）
- 卸载后会留下数据残留
- 多版本会相互干扰（共享同一个配置目录）
- 不方便备份（数据分散在不同位置）

**正确的做法**:

- 所有应用数据存在应用目录：`{appDir}/config/`, `{appDir}/cache/`, `{appDir}/data/`
- 工作区数据存在工作区目录：`{workspaceDir}/.pi-workbench/`
- 临时文件存在应用缓存：`{appDir}/cache/temp/`

---

## 🔒 核心架构约束

### Pi Agent 集成约束

**运行位置**:

- ✅ Pi Agent **必须**运行在 Electron 主进程中
- ✅ 与 `electron/main.ts` 在同一进程
- ❌ **禁止**创建子进程或 Worker 运行 Agent
- ❌ **禁止**通过 HTTP 服务运行 Agent

**文件操作约束**:

- ⚠️ **现状说明**：`pi-coding-agent` 内置的 read/write/edit/bash 工具在主进程中直接操作文件系统，不经过渲染进程 IPC
- ✅ 安全边界：Agent 只运行在主进程，渲染进程仍无 Node.js 权限
- ✅ 应用自身（文件树、编辑器）的文件操作仍**必须**通过 IPC
- ❌ **禁止**把 Agent 放入渲染进程或额外子进程

**配置存储约束**:

- ✅ API 配置存储在 `{appDir}/config/api-config.json`（API Key 使用 Electron `safeStorage` 加密，格式 `enc:<base64>`）
- ✅ Agent 模型配置写入 `{appDir}/data/agent/models.json`（API Key 通过环境变量 `$PI_WORKBENCH_API_KEY` 插值，不落盘）
- ✅ 模型供应商（provider / API URL / API Key / 模型）是**应用级全局配置**，所有工作区共用
- ❌ 禁止在工作区配置（`.pi-workbench/config.json`）中提供 provider / API Key / 模型选择
- ❌ **禁止**使用 `.env` 文件（位置不明确，违反便携式约束）
- ❌ **禁止**将 API Key 写入源码或提交到版本控制

**示例**:

```typescript
// ✅ 正确：Agent 在主进程初始化
// electron/main.ts
const { AgentManager } = await import('../pi-bridge/dist/index.js')

let agentManager: any | null = null

async function initAgent(config: ApiConfig) {
  agentManager = new AgentManager()
  await agentManager.initialize({
    workspaceDir: config.workspaceDir,
    agentDir: path.join(getAppDir(), 'data', 'agent'),
    apiConfig: config.apiConfig // provider / apiUrl / apiKey / selectedModel
  })
}
```

### 数据库和持久化约束

**SQLite 数据库位置**:

- ✅ 应用级数据库：`{appDir}/data/workspaces.db`
- ✅ 工作区数据库（可选）：`{workspaceDir}/.pi-workbench/workspace.db`
- ❌ **禁止**使用系统数据库目录

**会话存储策略**:

- ✅ Agent 会话：`{appDir}/data/agent/sessions/*.jsonl`（Pi JSONL，按 cwd 过滤；一个工作区可同时有多个会话）
- ✅ 打开中的会话标签与激活会话：`{workspaceDir}/.pi-workbench/chat-tabs.json`
- ✅ 打开中的编辑器标签与当前文件：`{workspaceDir}/.pi-workbench/editor-tabs.json`（只存相对路径；显式关闭工作区不清除，重新打开时恢复）
- ✅ 会话标题：`session_info` 条目；首轮回复后由模型生成一次，手动重命名优先
- ✅ 同工作区多个会话可并行运行（每个会话独立 `AgentSession`，共享 `ModelRuntime` 与环境租约）
- 会话 API：`agent:sessions:list/open/create/close/rename/delete`，流式事件带 `workspaceDir + sessionId + requestId`

**多工作区与状态保留**:

- ✅ 每个打开的工作区各自挂载一套常驻视图（`WorkspaceView`）和按工作区隔离的 editor / diff store；切换标签、返回首页只切换可见性（`visibility: hidden` + `inert`），不卸载、不 reset。
- ✅ 运行期状态全部保留：Monaco 撤销栈与滚动、聊天草稿/附件/滚动、终端进程与缓冲区、文件树展开、面板宽度与收起状态、流式输出。
- ✅ 关闭工作区标签是唯一回收运行时的入口：确认未保存文件 / 运行中任务 → 写 `editor-tabs.json` → dispose Agent、终端与监听 → 卸载视图。`chat-tabs.json`、`editor-tabs.json` 和草稿都**不删除**。
- ✅ 退出应用 / 重启：运行时全部回收，不自动恢复工作区标签；固定状态仍在磁盘，下次从最近项目打开工作区时恢复。
- ✅ 固定状态范围：打开的文件（含顺序）、当前文件、打开的会话与激活项、草稿。面板宽度、终端开关、会话模式属于运行期，不落盘。

**日志文件位置**:

- ✅ 所有日志：`{appDir}/logs/`
- ✅ 主进程日志：`{appDir}/logs/main.log`（5MB 轮转，保留 `.1`）
- ✅ 渲染进程日志：`{appDir}/logs/renderer.log`（未捕获异常与 console.warn/error）
- ✅ Agent 日志：`{appDir}/logs/agent.log`（5MB 轮转保留 `.1`，由主进程注入 `AgentLogger`，含工作区 Agent）

**Chromium profile**:

- ✅ `app.setPath('userData', '{appDir}/data/profile')`，缓存与 localStorage 随应用目录迁移
- ✅ 语言偏好等应用设置仍写 `{appDir}/config/settings.json`（渲染进程不使用 localStorage 保存设置）

### 自动更新约束

**行为**:

- ✅ 启动 12 秒后静默检查一次；检查失败只写 `main.log`，不打扰用户
- ✅ Windows / Linux 发现新版本后**自动下载**，但**绝不自动安装**（`autoInstallOnAppQuit = false`）
- ✅ 下载完成弹窗，用户选择“重启并安装”或“稍后”；拒绝后下次启动重新检查并再弹
- ✅ macOS 未签名，只检查版本（GitHub Releases API），弹窗引导到 Release 页面手动下载 dmg
- ❌ 不提供“跳过此版本”，不做预发布通道（`allowPrerelease = false`）
- ❌ 不自动重启、不静默安装

**缓存与路径**:

- ✅ Windows 安装包缓存：`%LOCALAPPDATA%\Pi-Workbench-Update`（安装目录之外）。安装器不能从 `$INSTDIR` 内启动——electron-builder 的卸载器会按路径前缀结束进程，会把安装器自己杀掉
- ✅ Linux 安装包缓存：`{appDir}/cache/{updaterCacheDirName}`（通过自定义 `AppAdapter` 覆盖 electron-updater 的系统缓存目录）
- ✅ 安装完成后安装器写入 `%LOCALAPPDATA%\Pi-Workbench-Update.flag`；应用启动时依据标记删除外部缓存目录与标记（带重试，失败留给下次启动）
- ✅ Windows 更新时设置 `installDirectory = appDir`，让安装器带 `/D=`，不依赖注册表 `InstallLocation`
- ✅ 没有可用更新时清理过期缓存
- ✅ 更新事件写入 `{appDir}/logs/main.log`

**Windows 更新与数据保护**:

- ✅ 更新安装器从 `%LOCALAPPDATA%\Pi-Workbench-Update` 启动（不在安装目录内），避免被卸载器的按路径进程检测误杀
- ✅ 安装完成标记与清理：`customInstall` 写 `<缓存根>.flag`，应用启动时删除缓存根与标记；真正卸载时一并清理
- ✅ 安装器在 `%LOCALAPPDATA%\pi-workbench-updater` 的差分副本由 `customInstall` 删除，启动清理兜底（我们的缓存不在那里，副本不会被读取）
- ✅ 更新时的删除逻辑由 `build/installer.nsh` 的 `customRemoveFiles` 接管：只删除
  `resources/installer-manifest.files.txt` / `installer-manifest.dirs.txt` 清单内的程序文件
- ✅ 清单由 `scripts/after-pack-manifest.js`（electron-builder `afterPack`）生成；清单缺失时更新不删除任何文件
- ✅ 受保护目录：`config/`、`data/`、`logs/`、`cache/`
- ✅ 真正卸载时删除清单文件、数据目录与安装器生成的文件（卸载器、图标、`app-update.yml`、`elevate.exe`、`.write-probe`、外部更新缓存）
- ❌ 禁止在安装目录的其他位置保存运行时数据（不在清单外保护范围，更新会被删除）
- ❌ 新增数据目录时必须同步更新 `PROTECTED_TOP_LEVEL` 与卸载分支，否则更新会清理该目录

**发布**:

- ✅ 更新源为 GitHub Releases（公开仓库 `T-Chen-CN/pi-workbench`）
- ✅ 推送 `v*` 标签触发三平台构建（Windows NSIS / macOS universal dmg / Linux AppImage）
- ✅ 标签必须与 `package.json` 的 `version` 一致，否则 Release 流水线失败
- ✅ 当前不签名、不公证；macOS 用户需手动覆盖安装，Windows 可能出现 SmartScreen 提示

### 插件系统约束

**插件定位**:

- ✅ 插件只扩展 **Pi Workbench 本身**（命令 / 菜单 / 钩子 / 声明式 UI）
- ❌ **禁止**把插件系统当作 Pi Agent 扩展机制（不接入 Pi SDK 的 extensions / custom tools）
- ❌ **禁止**从系统目录加载插件
- ❌ **禁止**从网络下载插件（安全风险）

**插件加载位置**:

- ✅ 工作区插件：`{workspaceDir}/.pi-workbench/plugins/`

**插件沙箱**:

- ⚠️ 简化版插件系统**无**沙箱隔离
- ⚠️ 插件可以访问 Node.js API
- ⚠️ 仅用于个人项目，不对外分发

**v1 能力边界**:

- ✅ 主进程 CommonJS 插件：命令（命令面板执行）与钩子（workspace:opened / file:saved / chat:message）
- ✅ 启用禁用与热重载（`config.json` 的 `enabledPlugins` + `pluginsConfigured`）
- ❌ 不向渲染进程加载插件 JS（生产 CSP `script-src 'self'`）
- ❌ 不接入 Pi SDK extensions / custom tools

---

## 🎨 UI/UX 指南

### 前端设计规范（强制）

- **唯一事实来源**：[docs/design/DESIGN_SYSTEM.md](docs/design/DESIGN_SYSTEM.md)。进行任何前端设计相关改动前必须先阅读并遵守。
- 适用范围：颜色、字体、字号、间距、圆角、阴影、图标、动效、组件、布局、主题、空状态、提示文案。
- 只允许使用规范中的设计 token、`src/components/ui.tsx` 的基础组件与 `src/components/patterns.tsx` 的内容模式；禁止硬编码颜色、`gray-* / blue-* / red-*` 调色板类、`dark:` 变体、emoji 图标；Monaco / xterm 等第三方渲染器通过 `src/theme/tokens.ts` 读取 CSS token，不直接写色值。
- **需要引入规范之外的设计元素时，必须先更新 `DESIGN_SYSTEM.md` 并获得项目所有者确认，再写代码；未经确认的设计例外不得合并。**
- 每次 UI 改动需提供 Paper / Ink 两套截图，并通过对比度、键盘焦点、1024 / 1440 宽度、`type-check` / `lint` / `test` 检查。

### 布局结构

```
┌─────────────────────────────────────────────┐
│  Title Bar                                  │
├──────────┬───────────────────┬──────────────┤
│          │  Editor Tabs      │              │
│  File    ├───────────────────┤  Chat Panel  │
│  Tree    │                   │  336px       │
│  232px   │  Monaco Editor    │  (可收起)     │
│          │                   │              │
│          ├───────────────────┤              │
│          │  Terminal (可收起) │              │
└──────────┴───────────────────┴──────────────┘
```

### 视觉与组件规范（Paper & Ink）

- 视觉语言：纸面 + 墨线 + 松绿。默认 Paper 浅色，Ink 深色通过 `<html class="dark">` 切换；不要在组件里写 `dark:` 变体。
- 所有颜色使用语义 token，禁止硬编码色值或 gray/blue/red 调色板类：
  - 纸面：`bg-surface`（编辑器画布、激活标签）/ `bg-panel`（顶栏、侧栏、状态栏、终端）/ `bg-raised`（纸卡、浮层）/ `bg-sunken`（输入与代码）
  - 悬停与选中：`bg-hover` / `bg-active`
  - 文字：`text-ink` / `text-ink-muted`（承载信息）/ `text-ink-subtle`（仅装饰、分隔与禁用态）
  - 边框：`border-rule-control`（控件边界）/ `border-rule-divide`（结构分隔）/ `border-rule-hairline`（卡片外框）/ `bg-rule-seam`（2px 拖拽接缝）；满墨 `border-line` 仅用于浮层
- 区域分层：编辑器画布与激活标签用 `surface`（更深），顶栏、侧栏、状态栏、终端用 `panel`；区域先靠底色区分，接缝只做收口。
  - 强调与状态：`text-accent`（松绿链接/选中）、`bg-accent`（主按钮）、`text-success`（暖橄榄）、`text-warning`、`text-danger`（朱砂红）
- 字体：`font-display`（Instrument Serif + 思源宋体）用于 ≥18px 标题与项目名；`font-reading`（思源宋体）用于 14px 阅读型正文（欢迎页导语、Agent 回复、设置说明）；控件、标签与字段值用默认 `font-sans`（Noto Sans + Noto Sans SC，Label 12px / Value 12.5px）；路径、ID、时间、快捷键与代码用 `font-mono`（Geist Mono，Data 11.5px）。中文标签不要用 mono，也不要加 uppercase 或字距。
- 形状：圆角 0–2px（`rounded-sm` / `rounded`）；页面内纸卡用 `bg-raised` + 发丝外框、不用阴影；浮层（弹窗、菜单、Toast）用 `bg-raised` + 满墨外框 + `shadow-print`；禁止渐变、玻璃拟态、柔光。
- 新组件优先复用 `src/components/ui.tsx` 的 `Button / IconButton / Input / Select / Textarea / Field / EmptyState / Modal / Spinner`，以及 `src/components/patterns.tsx` 的 `Card / CardHeader / SectionHeader / Stat / StatusText / QuickAction / ListRow / KeyCap / SearchField`。
- 文字只使用 `type-*` 语义角色（`type-label` / `type-value` / `type-data` / `type-reading` 等）；业务组件禁止直接写 `font-*`、任意字号、`uppercase`、`tracking-[...]`、`leading-[...]`。
- 新内容类型先落到 `patterns.tsx` 的组件或命名变体，再在页面组合；禁止页面级一次性样式。
- `tests/design-system.test.ts` 是强制门槛，绕过它等同于设计规范未落地。
- 图标统一使用 `lucide-react`（16px 常规 / 14px 紧凑），不要使用 emoji 充当图标。
- 间距使用 4px 网格。

### 交互规范

- 文件点击：立即打开，不需要双击
- 自动保存：2 秒防抖后保存
- 错误提示：使用 Toast 组件，3 秒后自动消失
- 加载状态：显示加载指示器，不阻塞 UI

---

## 🔍 调试和测试

### 开发工具

```bash
# 开发模式（推荐）
npm run dev           # 启动 Vite + Electron

# 仅浏览器开发（调试前端）
npm run web:dev       # http://localhost:5173

# 仅 Electron（调试主进程）
npm run electron:dev

# 质量检查
npm run type-check    # TypeScript
npm test              # Vitest
npm run lint          # ESLint
npm run build         # 全量构建
```

> `npm run dev` 会通过 `predev` 自动构建 `pi-bridge` 与主进程/preload，无需手动 build。
>
> 修改 `tailwind.config.js`（新增颜色/工具类）后必须重启 `npm run dev`：Tailwind 配置只在服务器启动时读取，Vite 的 CSS HMR 不会生成新工具类，页面会回退到 Tailwind 默认边框色（深色主题下表现为异常发亮的硬线）。

### IPC 调试

- 使用 `<IPCDebug />` 组件查看 IPC 调用
- 主进程日志：在终端查看
- 渲染进程日志：F12 打开 DevTools

### 常用调试技巧

```typescript
// 调试 Zustand 状态
useEditorStore.subscribe((state) => {
  console.log('Editor state changed:', state)
})

// 调试 IPC 调用
const result = await api.readFile(path)
console.log('IPC result:', result)
```

### 渲染层测试

- Vitest + `jsdom` + React Testing Library；测试文件用 `// @vitest-environment jsdom`
- Monaco 等重型组件通过 `vi.mock` 模拟，避免真实渲染
- 修改编辑器 / 聊天 / 文件树交互后，请补充或更新对应的渲染层测试

---

## 📝 提交规范

### Commit Message 格式

```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `refactor`: 代码重构
- `style`: 代码格式（不影响功能）
- `test`: 测试相关
- `chore`: 构建工具、依赖更新

### Scope 示例

- `agent`: Pi Agent 相关
- `editor`: Monaco Editor 相关
- `file`: 文件管理相关
- `ui`: UI 组件相关
- `ipc`: IPC 通信相关

### 示例 Commit

```
feat(agent): Integrate real Pi Agent runtime

- Install @earendil-works/pi-coding-agent
- Implement AgentManager in pi-bridge/
- Support OpenAI-compatible providers (DeepSeek etc.) via models.json
- Add read/write/edit/bash tools
- Remove mock implementation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

---

## 🔗 重要文档链接

- **项目方案**: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) - 完整的项目规划和路线图
- **项目结构**: [docs/architecture/PROJECT_STRUCTURE.md](docs/architecture/PROJECT_STRUCTURE.md) - 架构详解
- **设计规范**: [docs/design/DESIGN_SYSTEM.md](docs/design/DESIGN_SYSTEM.md) - 前端设计唯一事实来源（强制）
- **构建指南**: [docs/guides/BUILD_AND_PACKAGE.md](docs/guides/BUILD_AND_PACKAGE.md) - 打包发布流程
- **功能状态**: [docs/progress/STATUS.md](docs/progress/STATUS.md) - 当前进度追踪
- **待开发清单**: [docs/progress/BACKLOG.md](docs/progress/BACKLOG.md) - 开发清单（P1–P3 已收尾；V-01/V-02 平台验收与发布待办）
- **已完成方案**: [docs/progress/ROADMAP.md](docs/progress/ROADMAP.md) - v1 交付记录（已归档，不再新增待办）

---

## ⚡ 快速参考

### 添加新的 IPC 命令

1. 在 `electron/main.ts` 添加 `ipcMain.handle('command:name', ...)`
2. 在 `electron/preload.cts` 暴露到 `contextBridge`
3. 在 `src/types/electron.d.ts` 添加类型定义
4. 在 `src/api/index.ts` 封装 API

### 添加新的组件

1. 在 `src/components/` 创建组件文件
2. 使用 TailwindCSS 类名编写样式
3. 通过 Zustand store 管理状态
4. 在 `App.tsx` 中引入使用

### 添加新的 Store

1. 在 `src/store/` 创建 store 文件
2. 使用 `create<T>()` 定义接口和实现
3. 在组件中通过 `useXxxStore()` 使用
4. 避免在 store 中调用 IPC（在组件中调用）

---

## ⚠️ 迁移历史提醒

**重要**: 本项目已从 **Tauri** 迁移到 **Electron**

如果看到以下内容，说明是过期的：

- ❌ Tauri API 调用 (`invoke`, `@tauri-apps/api`)
- ❌ Rust 代码 (`src-tauri/`)
- ❌ Cargo.toml
- ❌ tauri.conf.json

所有 Tauri 相关代码已移除。如果需要实现类似功能，使用 Electron API。

---

## 💡 最佳实践

1. **安全第一**: 永远不要在渲染进程暴露 Node.js API
2. **类型安全**: 充分利用 TypeScript，避免 `any`
3. **不可变更新**: 永远创建新对象，不要直接修改

### 4. 报告和文档规范

#### 何时写报告

**禁止创建报告的情况**（直接做，简单告知）：

- 日常代码修复（修 bug、改 typo、格式调整）
- 单个文件的小改动
- 临时的分析或调查
- 批量文本替换、配置更新
- **即使用户说"详细检查"，也只在下面的明确指示下才写报告**

**允许创建报告的情况**（必须满足以下条件之一）：

1. **用户明确说**："生成报告"、"写成文档"、"需要审查记录"、"创建文档"
2. **架构重大决策**：多工作区 / 多 Agent 的协调、技术选型改变、大型重构
3. **安全审计**：安全漏洞、权限问题、数据处理风险
4. **里程碑归档**：阶段完成总结（仅在用户明确指示时）

#### 报告文件放置规范

**如果允许写报告，必须遵守**：

```
docs/
├── reports/              # 临时分析报告（用户审查后删除或移动）
│   ├── audit-YYYY-MM-DD.md
│   ├── review-YYYY-MM-DD.md
│   └── investigation-xxx.md
├── decisions/            # 架构决策记录（永久文档）
│   └── ADR-001-xxx.md
└── progress/             # 项目进度（永久文档）
    └── STATUS.md
```

**命名规范**：

- 临时报告：`{类型}-{日期}.md` 或 `{类型}-{主题}.md`（放 docs/reports/）
- 永久文档：`{主题}.md`（放 docs/ 或其子目录）

**文件生命周期**：

- 临时报告（docs/reports/）：用户审查完后由用户决定删除或移到永久位置
- 永久文档（docs/）：版本控制中保留，定期更新

#### 判断流程

```
用户请求
    ↓
【明确要求写报告吗?】
"生成报告" / "创建文档" / "审查记录" / "需要文档"
    ├─ 是 → 【允许写报告】
    │       ↓
    │       放在 docs/reports/{类型}-{日期}.md
    │       ↓
    │       告知: "报告已生成在 docs/reports/{filename}"
    │
    └─ 否 → 【禁止写报告】
            ↓
            直接做，简单告知结果
            ↓
            示例: "已修复 X，改动包括 Y 和 Z"
```

#### 报告清理

- `docs/reports/` 中的文件是**临时的**
- 用户决定后：
  - 📌 保留：移到 `docs/decisions/` 或 `docs/analysis/`（改为永久）
  - 🗑️ 删除：`rm docs/reports/{filename}`
  - 📝 整合：合并内容到 AGENTS.md、STATUS.md 等永久文档

### 5. 防抖节流

- 对频繁操作（输入、滚动）使用防抖

### 6. 错误处理

- 所有异步操作都用 try-catch 包裹

### 7. 用户反馈

- 操作完成后显示 Toast 通知

### 8. 性能优化

- 使用 React.memo 避免不必要的重渲染

### 9. 代码复用

- 提取通用逻辑到 hooks 或 utils

---

**最后更新**: 2026-10-26  
**维护者**: Pi Workbench Team  
**AI 友好**: 本文件专为 AI 助手设计，包含项目的所有关键约束和最佳实践
