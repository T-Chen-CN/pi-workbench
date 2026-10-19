# 项目结构

## 📁 目录总览

```
pi-workbench/
├── electron/                   # Electron 主进程
│   ├── main.ts                # 主进程入口、窗口管理、IPC 处理
│   ├── preload.ts             # 预加载脚本、contextBridge
│   └── tsconfig.json          # Electron TypeScript 配置
│
├── src/                       # React 渲染进程
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 主应用组件
│   ├── components/           # React 组件
│   │   ├── ChatPanel.tsx
│   │   ├── DiffViewer.tsx
│   │   ├── Editor.tsx
│   │   ├── FileExplorer.tsx
│   │   ├── IPCDebug.tsx
│   │   ├── MonacoEditor.tsx
│   │   ├── Settings.tsx
│   │   └── Toast.tsx
│   ├── store/                # Zustand 状态管理
│   │   ├── agentStore.ts
│   │   ├── chatStore.ts
│   │   ├── diffStore.ts
│   │   ├── editorStore.ts
│   │   ├── errorStore.ts
│   │   └── i18nStore.ts
│   ├── api/                  # Electron API 封装
│   │   ├── index.ts          # 统一 API 接口
│   │   ├── diff.ts           # Diff 工具
│   │   └── piAgent.ts        # Pi Agent Mock
│   ├── types/                # TypeScript 类型
│   │   ├── electron.d.ts     # Electron API 类型
│   │   └── index.ts          # 通用类型
│   ├── i18n/                 # 国际化
│   │   └── translations.ts   # 中英文翻译
│   ├── styles/               # 样式
│   │   └── Settings.css
│   └── vite-env.d.ts         # Vite 类型定义
│
├── pi-bridge/                 # Node.js Pi Agent 桥接
│   ├── src/
│   │   └── index.ts          # Pi Agent Mock 实现
│   ├── dist/                 # 构建输出
│   ├── package.json
│   └── tsconfig.json
│
├── docs/                      # 项目文档
│   ├── README.md             # 文档导航
│   ├── architecture/         # 架构设计
│   ├── guides/               # 开发指南
│   ├── progress/             # 项目进度
│   └── reports/              # 审查报告
│
├── dist-electron/             # Electron 构建输出
├── dist/                      # Vite 构建输出
├── release/                   # 应用打包输出
│
├── package.json              # 项目依赖和脚本
├── tsconfig.json             # TypeScript 主配置
├── tsconfig.node.json        # Node TypeScript 配置
├── vite.config.ts            # Vite 构建配置
├── electron-builder.yml      # Electron 打包配置
├── tailwind.config.js        # TailwindCSS 配置
├── postcss.config.js         # PostCSS 配置
├── .gitignore                # Git 忽略规则
├── app-icon.png              # 应用图标
└── README.md                 # 项目说明
```

---

## 🔌 Electron 架构

### 主进程 (electron/main.ts)

负责：
- 创建和管理应用窗口
- 处理 IPC 通信
- 文件系统操作
- 系统对话框

### 预加载脚本 (electron/preload.ts)

通过 `contextBridge` 暴露安全的 API 到渲染进程：

```typescript
window.electronAPI = {
  selectDirectory: () => ipcRenderer.invoke('fs:selectDirectory'),
  readDirectory: (path) => ipcRenderer.invoke('fs:readDirectory', path),
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
}
```

### 渲染进程 (src/)

React 应用，通过 `window.electronAPI` 与主进程通信。

---

## 📦 核心组件

### FileExplorer (src/components/FileExplorer.tsx)

文件树组件：
- 递归渲染目录结构
- 支持展开/折叠
- 文件点击事件
- 最大深度限制（防止无限递归）

### MonacoEditor (src/components/MonacoEditor.tsx)

代码编辑器：
- 基于 Monaco Editor
- 支持多标签页
- 自动保存
- 语法高亮

### ChatPanel (src/components/ChatPanel.tsx)

聊天面板：
- 消息历史显示
- 实时输入
- 与 Pi Agent 集成（Mock）

### DiffViewer (src/components/DiffViewer.tsx)

代码差异查看器：
- Split 视图（并排对比）
- Unified 视图（统一视图）
- 行级差异标注

---

## 🗃️ 状态管理

使用 Zustand 管理全局状态：

| Store | 职责 |
|-------|------|
| `editorStore` | 打开的文件、当前标签页 |
| `chatStore` | 聊天消息历史 |
| `diffStore` | Diff 查看器状态 |
| `errorStore` | 全局错误处理 |
| `i18nStore` | 语言切换 |
| `agentStore` | Pi Agent 状态 |

---

## 🔄 IPC 通信流程

```
React 组件
    ↓
window.electronAPI.readFile(path)
    ↓
ipcRenderer.invoke('fs:readFile', path)
    ↓
主进程 ipcMain.handle('fs:readFile')
    ↓
Node.js fs.readFile()
    ↓
返回结果
    ↓
React 更新 UI
```

---

## 🛠️ 开发工作流

### 前端修改
- 文件: `src/**/*.tsx`, `src/**/*.css`
- 效果: Vite 热重载（自动刷新）
- 无需重启

### 主进程修改
- 文件: `electron/**/*.ts`
- 效果: 需要重启 `npm run dev`
- 或使用 `npm run electron:dev`（手动重载）

### 添加新的 IPC 命令
1. 在 `electron/main.ts` 中添加 `ipcMain.handle()`
2. 在 `electron/preload.ts` 中暴露到 `contextBridge`
3. 在 `src/types/electron.d.ts` 中添加类型定义
4. 在 React 中调用 `window.electronAPI.xxx()`

---

## 📊 构建流程

### 开发构建
```bash
npm run dev
```

同时启动：
- Vite 开发服务器 (http://localhost:5173)
- Electron 窗口（加载 Vite 页面）

### 生产构建
```bash
npm run build
```

执行：
1. `npm run build:renderer` - 构建 React 前端到 `dist/`
2. `npm run build:main` - 编译 Electron 主进程到 `dist-electron/`
3. `npm run build:bridge` - 编译 pi-bridge 到 `pi-bridge/dist/`

### 打包
```bash
npm run package
```

使用 electron-builder 打包成可执行文件，输出到 `release/`：
- Windows: `Pi Workbench Setup 0.1.0.exe`
- macOS: `Pi Workbench-0.1.0.dmg`
- Linux: `Pi Workbench-0.1.0.AppImage`

---

## 🔐 安全配置

Electron 安全最佳实践（已实施）：

```typescript
{
  contextIsolation: true,      // ✅ 上下文隔离
  nodeIntegration: false,      // ✅ 禁用 Node 集成
  sandbox: true,               // ✅ 沙箱模式
  webSecurity: true            // ✅ Web 安全
}
```

所有 Node.js API 都通过 `preload.ts` 和 `contextBridge` 暴露，确保安全性。

---

## 📝 类型定义

### electron.d.ts

定义 Electron API 类型：

```typescript
interface ElectronAPI {
  selectDirectory: () => Promise<SelectDirectoryResult>
  readDirectory: (path: string) => Promise<ReadDirectoryResult>
  readFile: (path: string) => Promise<ReadFileResult>
  writeFile: (path: string, content: string) => Promise<WriteFileResult>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
```

这确保了 TypeScript 的完整类型检查。

---

## 🎨 样式系统

- **TailwindCSS**: 大部分样式使用 Tailwind utility classes
- **CSS Modules**: 组件特定样式（如 Settings.css）
- **Monaco Editor**: 内置主题系统

---

## 🔄 数据流

```
用户操作
    ↓
React 组件
    ↓
Zustand Store (状态更新)
    ↓
Electron API 调用 (如果需要)
    ↓
主进程处理
    ↓
返回结果
    ↓
更新 Store
    ↓
React 重新渲染
```

---

## 📦 依赖说明

### 核心依赖
- `electron` - 桌面框架
- `react` - UI 框架
- `monaco-editor` - 代码编辑器
- `zustand` - 状态管理

### 构建工具
- `vite` - 前端构建工具
- `typescript` - 类型系统
- `electron-builder` - 打包工具
- `tailwindcss` - CSS 框架

### 开发工具
- `concurrently` - 并发运行多个命令
- `wait-on` - 等待服务启动
- `cross-env` - 跨平台环境变量

---

## 🚀 性能考虑

### React 优化
- 使用 `React.memo` 避免不必要的重新渲染
- Zustand store 只订阅需要的状态
- Monaco Editor 懒加载

### Electron 优化
- 主进程和渲染进程分离
- IPC 通信使用 `invoke/handle` 模式
- 预加载脚本最小化

---

## 🔮 后续扩展

### 计划添加的目录
- `src/hooks/` - 自定义 React Hooks
- `src/utils/` - 工具函数
- `src/constants/` - 常量定义
- `electron/services/` - 主进程业务逻辑

### 功能扩展点
- Pi Agent 真实集成（替换 Mock）
- 插件系统
- 主题系统
- 自动更新（electron-updater）

---

**文档版本**: 2.0  
**最后更新**: 2026-10-20  
**架构**: Electron 28 + React 19
