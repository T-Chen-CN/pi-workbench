# Pi Workbench

Lightweight desktop code editor with Pi Agent integration, built with Electron + React.

## 技术栈

- **桌面框架**: Electron 28
- **前端**: React 19 + TypeScript
- **编辑器**: Monaco Editor
- **构建**: Vite 5
- **状态管理**: Zustand
- **样式**: TailwindCSS

## 项目结构

```
pi-workbench/
├── electron/                     # Electron 主进程
│   ├── main.ts                  # 主进程入口
│   ├── preload.ts               # 预加载脚本
│   └── tsconfig.json
├── src/                         # React 渲染进程
│   ├── main.tsx                 # React 入口
│   ├── App.tsx                  # 主应用组件
│   ├── components/              # React 组件
│   │   ├── FileExplorer.tsx
│   │   ├── MonacoEditor.tsx
│   │   ├── ChatPanel.tsx
│   │   ├── DiffViewer.tsx
│   │   └── Settings.tsx
│   ├── store/                   # Zustand 状态管理
│   ├── api/                     # Electron API 封装
│   │   └── index.ts
│   ├── types/                   # TypeScript 类型
│   │   └── electron.d.ts
│   └── i18n/                    # 国际化
│       └── translations.ts
├── pi-bridge/                   # Node.js Pi Agent 桥接
│   ├── src/
│   │   └── index.ts             # Pi Agent Mock
│   ├── package.json
│   └── tsconfig.json
├── dist-electron/               # Electron 构建输出
├── release/                     # 应用打包输出
├── package.json
├── tsconfig.json
├── vite.config.ts
├── electron-builder.yml         # 打包配置
└── tailwind.config.js
```

## 环境要求

- Node.js 18+
- npm 或 pnpm

## 快速开始

### 1. 安装依赖

```bash
npm install
npm run build:bridge
```

### 2. 开发模式

**完整开发环境（推荐）**：
```bash
npm run dev              # 启动 Vite + Electron
```

**仅浏览器开发**（UI 调试）：
```bash
npm run web:dev          # 启动 Vite (http://localhost:5173)
```

**分离模式**：
```bash
# Terminal 1
npm run web:dev          # 启动 Vite

# Terminal 2
npm run electron:dev     # 启动 Electron
```

### 3. 构建应用

**构建前端 + 主进程**：
```bash
npm run build
```

**打包桌面应用**：
```bash
npm run package          # 打包当前平台
npm run package:win      # Windows
npm run package:mac      # macOS
npm run package:linux    # Linux
```

输出目录：`release/`

## 特性

- ✨ 跨平台桌面应用 (Electron)
- 🚀 现代化开发体验 (Vite + HMR)
- 📝 强大的代码编辑器 (Monaco Editor)
- 🤖 Pi Agent 集成 (待实现)
- 💬 实时代码对话
- 📁 文件系统操作
- 🌍 中英文国际化
- 🔍 Diff 查看器
- 🎨 现代化 UI (TailwindCSS)
- 📦 **便携式架构**: 所有数据自包含，支持整体迁移

## 便携式架构

Pi Workbench 采用**便携式架构**，所有应用数据存储在应用目录内，不依赖系统标准路径。

### 目录结构

```
Pi Workbench/                    # 应用安装目录
├── Pi Workbench.exe            # 可执行文件
├── resources/                  # 应用资源（只读）
├── config/                     # ⭐ 应用配置
│   ├── settings.json          # 用户设置
│   └── api-keys.json          # API Keys
├── cache/                      # ⭐ 缓存数据
│   └── temp/                  # 临时文件
├── data/                       # ⭐ 持久化数据
│   ├── workspaces.db          # 工作区数据库
│   └── sessions/              # 会话历史
└── logs/                       # ⭐ 日志文件
    └── app.log

{工作区目录}/                   # 用户的项目目录
└── .pi-workbench/              # 工作区配置
    ├── config.json            # 项目配置
    ├── sessions/              # 项目会话
    └── plugins/               # 项目插件
```

### 优势

- ✅ **真正便携**: 可整个目录拷贝到 U 盘或其他电脑运行
- ✅ **易于备份**: 一个目录包含所有数据
- ✅ **多版本共存**: 不同版本各自独立
- ✅ **易于清理**: 删除目录即可完全卸载
- ✅ **不污染系统**: 不在系统目录留下数据

### 安装方式

**方式 1: 安装版**（推荐）
- 运行 `Pi-Workbench-Setup-x.x.x.exe`
- 默认安装到 `%LOCALAPPDATA%\Programs\Pi Workbench\`
- Per-user 安装，无需管理员权限

**方式 2: 便携版**
- 解压 `Pi-Workbench-x.x.x-portable.zip`
- 运行 `Pi Workbench.exe`
- 可放在 U 盘或任意位置

## 开发流程

1. 修改 React 代码 → 自动热重载 (Vite HMR)
2. 修改 Electron 主进程 → 自动重启 (concurrently)
3. Pi 集成通过 IPC 通信 (`electronAPI`)
4. 浏览器开发模式使用 Mock API

## API 使用

### 文件操作

```typescript
import { api } from './api'

// 选择目录
const result = await api.openDirectoryDialog()
if (result.success && result.path) {
  console.log('Selected:', result.path)
}

// 读取目录
const dirResult = await api.listDirectory(path)
if (dirResult.success && dirResult.items) {
  dirResult.items.forEach(item => {
    console.log(item.name, item.isDirectory)
  })
}

// 读取文件
const fileResult = await api.readFile(filePath)
if (fileResult.success && fileResult.content) {
  console.log(fileResult.content)
}

// 写入文件
const writeResult = await api.writeFile(filePath, content)
if (writeResult.success) {
  console.log('Saved!')
}
```

### 类型安全

所有 API 都有完整的 TypeScript 类型支持（见 `src/types/electron.d.ts`）。

## 项目配置

### Electron Builder

配置文件：`electron-builder.yml`

支持的平台：
- Windows (NSIS 安装包)
- macOS (DMG)
- Linux (AppImage, deb, rpm)

### Vite 配置

- 自动清理输出目录
- 优化打包体积
- 支持 HMR
- 路径别名：`@/` → `src/`

## 故障排查

### 应用无法启动

1. 确保已安装所有依赖：`npm install`
2. 确保已构建 pi-bridge：`npm run build:bridge`
3. 检查端口 5173 是否被占用

### 文件操作失败

- 检查文件路径是否正确
- 确保有文件系统访问权限
- 查看控制台错误信息

### 打包失败

- 确保已运行 `npm run build`
- 检查 `electron-builder.yml` 配置
- Windows: 可能需要管理员权限

