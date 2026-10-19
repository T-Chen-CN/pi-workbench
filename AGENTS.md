# Pi Workbench - AI Agent 开发指南

> 本文件为 AI 助手（Claude、Pi Agent 等）提供项目特定的上下文、约束和最佳实践

**项目**: Pi Workbench  
**架构**: Electron 28 + React 19 + TypeScript  
**当前阶段**: MVP 完成，Phase 1 开发中  
**最后更新**: 2026-10-20

---

## 🎯 项目概述

这是一个**轻量级 AI 辅助开发工作台**，类似 Cursor IDE，使用 **Electron** 构建桌面应用，集成 **Pi Agent** 作为智能助手内核。

### 核心目标
- 提供流畅的 AI 辅助编程体验
- 支持多工作区和多 Agent 协作
- 简洁易扩展的插件系统
- 跨平台（Windows/macOS/Linux）

### 当前状态
- ✅ MVP 完成：文件管理、代码编辑、Diff 查看、聊天界面
- 🔄 Phase 1 进行中：Pi Agent 真实集成
- 📋 后续 Phase：工作区管理、终端、插件系统、Fleet 任务

---

## 📂 项目结构

```
pi-workbench/
├── electron/          # Electron 主进程（TypeScript）
│   ├── main.ts       # 窗口管理、IPC 处理
│   └── preload.ts    # contextBridge API 暴露
├── src/              # React 渲染进程
│   ├── components/   # UI 组件（8 个）
│   ├── store/        # Zustand 状态管理（6 个 store）
│   ├── api/          # Electron IPC 封装
│   ├── types/        # TypeScript 类型定义
│   └── i18n/         # 国际化（中英文）
├── pi-bridge/        # Pi Agent 桥接层（待实现）
├── docs/             # 项目文档（9 个文件）
└── 配置文件          # package.json, tsconfig.json 等
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
| 桌面框架 | **Electron** | 28.3.3 | ⚠️ 不是 Tauri，已从 Tauri 迁移 |
| 前端框架 | **React** | 19.0.0 | 使用函数组件 + Hooks |
| 构建工具 | **Vite** | 5.4.11 | HMR + 快速构建 |
| 状态管理 | **Zustand** | 5.0.2 | ⚠️ 不是 Redux 或 Context API |
| 编辑器 | **Monaco Editor** | 0.52.2 | VS Code 内核 |
| 样式 | **TailwindCSS** | 3.4.16 | 原子化 CSS |
| 类型检查 | **TypeScript** | 5.6.3 | 严格模式 |
| 打包 | **electron-builder** | 25.1.8 | 生成安装包 |

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
// ✅ 正确：8 个顶层组件，扁平结构
src/components/
├── ChatPanel.tsx
├── DiffViewer.tsx
├── Editor.tsx
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
├── agentStore.ts      // Agent 状态
├── chatStore.ts       // 聊天消息
├── diffStore.ts       // Diff 查看器
├── editorStore.ts     // 编辑器标签页
├── errorStore.ts      // 全局错误
└── i18nStore.ts       // 语言切换

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

### 5. TypeScript 规范

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

---

## 📋 当前开发任务优先级

### 🔥 Phase 1: Pi Agent 真实集成（进行中）

**目标**: 替换 Mock Agent 为真实的 Pi Agent

**任务清单**:
1. [ ] 安装 Pi 核心模块
   ```bash
   npm install @earendil-works/pi-agent-core
   npm install @earendil-works/pi-ai
   npm install @earendil-works/pi-durable
   ```

2. [ ] 实现 `pi-bridge/src/agent-manager.ts`
   - 创建 Agent 实例
   - 消息发送和接收
   - 工具系统集成

3. [ ] 配置 LLM 提供商
   - Anthropic Claude API
   - 环境变量管理（.env 文件）
   - API Key 配置界面（Settings 组件）

4. [ ] 基础工具集成
   - `read_file`: 通过 IPC 读取文件
   - `write_file`: 通过 IPC 写入文件
   - `edit_file`: 通过 diff 库编辑文件
   - `bash`: 执行命令（简化版，先返回 mock）

5. [ ] 更新 `src/api/piAgent.ts`
   - 移除 Mock 实现
   - 连接到真实的 Agent Manager
   - 处理流式响应

**重要提示**: 
- Pi Agent 运行在**主进程**，与 Electron main.ts 同进程
- 不要创建子进程或 Worker
- 所有文件操作必须通过现有的 IPC 通道

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
```

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

- Install @earendil-works/pi-agent-core
- Implement AgentManager in pi-bridge/
- Connect to Anthropic Claude API
- Add read_file and write_file tools
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
2. 在 `electron/preload.ts` 暴露到 `contextBridge`
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
