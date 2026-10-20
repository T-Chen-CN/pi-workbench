# 项目结构

**最后更新**: 2026-10-20（Phase 1 完成后）

---

## 1. 技术栈

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

---

## 2. 目录结构

```
pi-workbench/
├── electron/                     # Electron 主进程
│   ├── main.ts                   # 窗口、IPC、文件系统、安全存储、Agent 生命周期
│   ├── preload.cts               # contextBridge（编译为 CommonJS preload.cjs）
│   ├── tsconfig.json             # 主进程构建（ESM）
│   └── tsconfig.preload.json     # preload 构建（CommonJS，sandbox 兼容）
│
├── src/                          # React 渲染进程
│   ├── components/               # 扁平结构，无子目录
│   │   ├── ChatPanel.tsx         # Agent 对话、历史恢复、Diff 触发
│   │   ├── DiffViewer.tsx        # Split / Unified Diff 查看器
│   │   ├── FileExplorer.tsx      # 文件树、新建/重命名/删除、目录监听刷新
│   │   ├── IPCDebug.tsx          # 开发调试面板
│   │   ├── MonacoEditor.tsx      # Monaco、自动保存、外部变更同步
│   │   ├── Settings.tsx          # 供应商 / URL / Key / 模型拉取
│   │   └── Toast.tsx             # Toast 展示组件
│   ├── store/                    # 每个功能域一个 store
│   │   ├── chatStore.ts          # 消息、加载、错误（支持历史恢复）
│   │   ├── diffStore.ts          # Diff 查看器状态
│   │   ├── editorStore.ts        # 标签页、当前文件、脏标记
│   │   ├── i18nStore.ts          # 语言（persist）
│   │   ├── toastStore.ts         # 全局 Toast（组件外也可调用）
│   │   └── workspaceStore.ts     # 当前工作区 + 最近打开列表
│   ├── api/
│   │   ├── index.ts              # IPC 封装 + Web dev mock / dev 代理
│   │   ├── piAgentAPI.ts         # Agent 调用（Electron IPC / Web dev 桥接）
│   │   └── diff.ts               # 行级 Diff 算法
│   ├── types/
│   │   ├── electron.d.ts         # window.electronAPI 与 IPC 结果类型
│   │   └── index.ts              # 编辑器 / 通用类型
│   └── i18n/translations.ts      # 中英文文案
│
├── pi-bridge/                    # Agent 桥接层（主进程内运行）
│   ├── src/
│   │   ├── agent-manager.ts      # 会话/模型配置/工具编辑捕获/历史读取
│   │   └── index.ts
│   └── dist/                     # 构建产物（不纳入版本库）
│
├── tests/                        # Vitest 单元测试（store / diff）
├── docs/                         # 项目文档
├── vite.config.ts                # Vite + 仅开发环境的 dev 中间件
├── vitest.config.ts
├── eslint.config.js
└── package.json                  # scripts / electron-builder 配置
```

---

## 3. 进程模型

```
┌────────────────────────── Renderer (sandbox, no Node) ──────────────────────────┐
│ React + Zustand + Monaco                                                          │
│   window.electronAPI  ← contextBridge ← preload.cjs                               │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ IPC (ipcRenderer.invoke / webContents.send)
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│ Main Process (Node 24)                                                             │
│   fs / dialog / safeStorage / 文件监听                                             │
│   AgentManager (pi-coding-agent) ── HTTP ──> LLM Provider                          │
│   read/write/edit/bash 工具直接作用于工作区                                        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**安全边界**：渲染进程禁用 `nodeIntegration`，启用 `contextIsolation` 与 sandbox；
所有能力经 preload 显式暴露。Agent 只在主进程运行。

**Web 开发模式**（`npm run web:dev`）：没有 Electron 主进程，`vite.config.ts` 中仅 `serve`
生效的中间件提供：

- `/__pi/fetch-models` — 代理供应商 `/models`（规避 CORS）
- `/__pi/agent/{init,chat,history,dispose}` — 在 Vite 的 Node 进程中运行同一套 AgentManager

---

## 4. 关键数据流

### 打开工作区

```
App.openWorkspace
  → api.openDirectoryDialog()
  → api.initWorkspace(path)        # 创建 .pi-workbench/
  → 释放旧 Agent + 清空 editor/chat/diff store
  → api.watchWorkspace(path)
  → api.addRecentWorkspace(path)   # config/settings.json
  → ChatPanel 挂载 → 读取 api-config.json → agent:initialize
  → agent:getHistory → 恢复会话消息
```

### 一次对话

```
ChatPanel.handleSubmit
  → piAgentAPI.chat(message) → IPC agent:chat
  → AgentManager.chat → session.prompt()
  → 捕获 write/edit 工具前后的文件内容（FileEdit[]）
  → 返回 { response, edits }
  → ChatPanel: 追加消息；若有 edits → computeDiff → diffStore → DiffViewer
```

### 配置与存储

| 数据 | 位置 | 说明 |
|---|---|---|
| API 配置 | `{appDir}/config/api-config.json` | `apiKey` 为 `enc:<base64>`（safeStorage） |
| 应用设置 / 最近工作区 | `{appDir}/config/settings.json` | |
| Agent 模型配置 | `{appDir}/data/agent/models.json` | `apiKey: "$PI_WORKBENCH_API_KEY"`，不落盘 |
| Agent 会话 | `{appDir}/data/agent/sessions/<cwd>/` | 跨重启恢复 |
| 工作区配置 | `{workspace}/.pi-workbench/config.json` | |
| Web dev Agent 数据 | `{appDir}/cache/temp/web-agent/` | 仅开发模式 |

---

## 5. IPC 通道

| 通道 | 方向 | 用途 |
|---|---|---|
| `dialog:openDirectory` | invoke | 选择工作区 |
| `fs:readFile` / `writeFile` / `listDirectory` / `exists` / `stat` | invoke | 文件操作 |
| `fs:delete` / `fs:rename` | invoke | 删除 / 重命名 |
| `fs:watch` / `fs:unwatch` | invoke | 工作区递归监听 |
| `fs:changed` | main → renderer | 文件变化事件（300ms 防抖） |
| `app:getSettings` / `saveSettings` | invoke | 应用设置 |
| `app:getRecentWorkspaces` / `addRecentWorkspace` | invoke | 最近工作区 |
| `workspace:init` / `getConfig` / `saveConfig` | invoke | 工作区初始化与配置 |
| `apiConfig:get` / `save` / `fetchModels` | invoke | 供应商配置与模型拉取 |
| `agent:initialize` / `chat` / `getHistory` / `dispose` | invoke | Agent 生命周期 |

---

## 6. 扩展方式

### 新增 IPC

1. `electron/main.ts` 注册 `ipcMain.handle`
2. `electron/preload.cts` 暴露到 `contextBridge`
3. `src/types/electron.d.ts` 补类型
4. `src/api/index.ts` 封装（同时补 Web mock）

### 新增组件 / Store

- 组件放 `src/components/`，扁平结构，Tailwind 写样式
- Store 放 `src/store/`，每个功能域一个；不要合并成巨型 store
- 状态更新必须不可变（创建新对象/数组）

### 新增页面级状态清理

工作区切换时需要在 `App.resetWorkspaceState()` 中清理对应 store。

---

## 7. 构建产物

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `dist/` | 渲染进程 | 否 |
| `dist-electron/` | 主进程 + preload | 否 |
| `pi-bridge/dist/` | AgentManager | 否（`predev`/`build` 自动生成） |
| `release/` | 安装包/解包目录 | 否 |
