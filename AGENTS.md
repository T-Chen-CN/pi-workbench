# Pi Workbench - AI Agent 开发指南

> 本文件为 AI 助手（Claude、Pi Agent 等）提供项目特定的上下文、约束和最佳实践

**项目**: Pi Workbench  
**架构**: Electron 44 + React 19 + TypeScript
**运行要求**: Node.js ≥ 22.19（Pi SDK 要求；Electron 44 内置 Node 24）  
**当前阶段**: Phase 1 完成并加固，Phase 2 进行中  
**最后更新**: 2026-10-20

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
- ⏳ Phase 2 待启动：工作区管理、终端、插件系统、Fleet 任务

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

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 桌面框架 | **Electron** | 44.9.1 | ⚠️ 不是 Tauri，已从 Tauri 迁移 |
| 前端框架 | **React** | 19.3.1 | 使用函数组件 + Hooks |
| 构建工具 | **Vite** | 5.4.21 | HMR + 快速构建 |
| 状态管理 | **Zustand** | 4.5.7 | ⚠️ 不是 Redux 或 Context API |
| 编辑器 | **Monaco Editor** | 0.57.0 | VS Code 内核 |
| 样式 | **TailwindCSS** | 3.4.19 | 原子化 CSS |
| 类型检查 | **TypeScript** | 5.9.3 | 严格模式 |
| 打包 | **electron-builder** | 26.15.3 | 生成安装包 |
| Agent SDK | **@earendil-works/pi-coding-agent** | 1.3.0 | 运行在主进程 |

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
// ✅ 正确：7 个顶层组件，扁平结构
src/components/
├── ChatPanel.tsx
├── DiffViewer.tsx
├── FileExplorer.tsx
├── IPCDebug.tsx
├── MonacoEditor.tsx
├── Settings.tsx
└── Toast.tsx

// ❌ 错误：不要创建子目录
src/components/chat/ChatPanel.tsx  // 不要这样！
```

#### Store 放置规则
```typescript
// ✅ 正确：每个功能域一个独立 store
src/store/
├── chatStore.ts       // 聊天消息（支持历史恢复）
├── diffStore.ts       // Diff 查看器
├── editorStore.ts     // 编辑器标签页、脏标记
├── i18nStore.ts       // 语言切换（persist）
├── toastStore.ts      // 全局 Toast（组件外也可调用）
└── workspaceStore.ts  // 当前工作区 + 最近打开

// ❌ 错误：不要合并 store
src/store/appStore.ts  // 不要创建巨大的单一 store！
```

---

### 2. IPC 通信规范

**所有文件系统操作必须通过 IPC！**

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
import fs from 'fs'  // 这会失败！渲染进程没有 Node.js 权限

// ❌ 绕过 contextBridge
window.require('fs')  // 安全风险，已禁用 nodeIntegration
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
  openFile: (file) => set((state) => ({
    openFiles: [...state.openFiles, file]
  })),
  closeFile: (index) => set((state) => ({
    openFiles: state.openFiles.filter((_, i) => i !== index)
  }))
}))

// 在组件中使用
const { openFiles, openFile } = useEditorStore()
```

#### ❌ 不要使用 Redux
```typescript
// ❌ 不要创建 Redux store
import { createStore } from 'redux'  // 不要使用！

// ❌ 不要使用 Context API 做全局状态
const AppContext = React.createContext()  // Zustand 更好！
```

---

### 4. 文件操作规范

#### 不可变状态更新（重要！）
```typescript
// ✅ 正确：使用展开运算符创建新数组
setItems(items.map(item => 
  item.path === targetPath 
    ? { ...item, isExpanded: !item.isExpanded }
    : item
))

// ❌ 错误：直接修改对象（会导致无限递归！）
const item = items.find(i => i.path === path)
item.isExpanded = true  // 不要这样！会触发无限重渲染
setItems([...items])
```

#### 文件路径处理
```typescript
// ✅ 正确：使用 path.join 处理跨平台路径
import path from 'path'
const fullPath = path.join(dirPath, fileName)

// ❌ 错误：手动拼接路径
const fullPath = `${dirPath}/${fileName}`  // Windows 会失败！
```

---

### 5. 文件路径规范（便携式约束）

**核心原则**: 所有应用数据必须在应用目录内，不得使用系统标准路径

#### 获取应用目录

```typescript
// ✅ 正确：基于可执行文件路径（便携式）
import { app } from 'electron'
import path from 'path'

// 开发模式和生产模式的统一处理
function getAppDir(): string {
  if (app.isPackaged) {
    // 生产模式：可执行文件所在目录
    return path.dirname(app.getPath('exe'))
  } else {
    // 开发模式：项目根目录（app.getAppPath() 比 process.cwd() 更稳定）
    return app.getAppPath()
  }
}

const appDir = getAppDir()
const configDir = path.join(appDir, 'config')    // 配置目录
const cacheDir = path.join(appDir, 'cache')      // 缓存目录
const dataDir = path.join(appDir, 'data')        // 数据目录
const logsDir = path.join(appDir, 'logs')        // 日志目录

// ❌ 错误：使用系统标准路径（违反便携式约束！）
const userData = app.getPath('userData')         // 不要使用！
// Windows: C:\Users\xxx\AppData\Roaming\pi-workbench
// macOS: ~/Library/Application Support/pi-workbench

const appData = app.getPath('appData')           // 不要使用！
const home = app.getPath('home')                 // 不要使用！
const documents = app.getPath('documents')       // 不要使用！
```

#### 路径分类和用途

```typescript
// ✅ 应用级数据：在应用目录
const settingsPath = path.join(appDir, 'config', 'settings.json')
const apiConfigPath = path.join(appDir, 'config', 'api-config.json')  // API Key 使用 safeStorage 加密
const dbPath = path.join(appDir, 'data', 'workspaces.db')
const logPath = path.join(appDir, 'logs', 'main.log')

// ✅ 工作区级数据：在工作区目录（用户选择的项目目录）
const workspaceConfig = path.join(workspacePath, '.pi-workbench', 'config.json')
const workspacePlugins = path.join(workspacePath, '.pi-workbench', 'plugins')
const workspaceSessions = path.join(workspacePath, '.pi-workbench', 'sessions')

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
    path.join(appDir, 'data', 'sessions'),
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
  const sessionsDir = path.join(configDir, 'sessions')
  
  // 创建目录
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(pluginsDir, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })
  
  // 创建默认配置
  const configPath = path.join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    const defaultConfig = {
      version: '1.0',
      enabledPlugins: [],
      agentConfig: {
        model: 'claude-3-5-sonnet',
        temperature: 0.7
      }
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
const handleClick = (event: any) => {  // 不要使用 any！
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
setItems(items.map(i => 
  i === item ? { ...i, isExpanded: true } : i
))
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
  loadItems()  // 这会更新 items
}, [items])  // items 变化又触发 useEffect → 无限循环！

// ✅ 正确：只在挂载时执行一次
useEffect(() => {
  loadItems()
}, [])  // 空依赖数组
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
  return app.isPackaged 
    ? path.dirname(app.getPath('exe'))
    : process.cwd()
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
    apiConfig: config.apiConfig, // provider / apiUrl / apiKey / selectedModel
  })
}
```

### 数据库和持久化约束

**SQLite 数据库位置**:
- ✅ 应用级数据库：`{appDir}/data/workspaces.db`
- ✅ 工作区数据库（可选）：`{workspaceDir}/.pi-workbench/workspace.db`
- ❌ **禁止**使用系统数据库目录

**会话存储策略**:
- ✅ 全局会话：`{appDir}/data/sessions/{session-id}.json`
- ✅ 工作区会话：`{workspaceDir}/.pi-workbench/sessions/{session-id}.json`
- 区分标准：跨工作区的会话用全局，单工作区的会话用工作区目录

**日志文件位置**:
- ✅ 所有日志：`{appDir}/logs/`
- ✅ 主进程日志：`{appDir}/logs/main.log`
- ✅ 渲染进程日志：`{appDir}/logs/renderer.log`
- ✅ Agent 日志：`{appDir}/logs/agent.log`

### 插件系统约束

**插件加载位置**:
- ✅ 工作区插件：`{workspaceDir}/.pi-workbench/plugins/`
- ❌ **禁止**从系统目录加载插件
- ❌ **禁止**从网络下载插件（安全风险）

**插件沙箱**:
- ⚠️ 简化版插件系统**无**沙箱隔离
- ⚠️ 插件可以访问 Node.js API
- ⚠️ 仅用于个人项目，不对外分发

### Fleet 任务约束

**Worktree 存储位置**:
- ✅ Worktree 目录：`{workspaceDir}/.pi-worktrees/{task-name}/`
- ✅ 任务元数据：`{appDir}/data/fleet-tasks.db`
- ❌ **禁止**在系统临时目录创建 worktree

---

## 🎨 UI/UX 指南

### 布局结构
```
┌─────────────────────────────────────────────┐
│  Title Bar                                  │
├──────────┬──────────────────────────────────┤
│          │  Editor Tabs                     │
│  File    ├──────────────────────────────────┤
│  Tree    │                                  │
│          │  Monaco Editor                   │
│  200px   │                                  │
│          │                                  │
├──────────┼──────────────────────────────────┤
│          │  Chat Panel (collapsible)        │
│          │  300px height                    │
└──────────┴──────────────────────────────────┘
```

### 颜色规范（TailwindCSS）
- 背景：`bg-gray-900` (深色主题)
- 文字：`text-gray-100`
- 边框：`border-gray-700`
- 高亮：`bg-blue-600` (选中状态)
- 错误：`text-red-400`

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
- **构建指南**: [docs/guides/BUILD_AND_PACKAGE.md](docs/guides/BUILD_AND_PACKAGE.md) - 打包发布流程
- **功能状态**: [docs/progress/STATUS.md](docs/progress/STATUS.md) - 当前进度追踪

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
2. **架构重大决策**：多 worktree 的协调、技术选型改变、大型重构
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

**最后更新**: 2026-10-20  
**维护者**: Pi Workbench Team  
**AI 友好**: 本文件专为 AI 助手设计，包含项目的所有关键约束和最佳实践
