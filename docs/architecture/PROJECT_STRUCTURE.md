# 项目结构

**最后更新**: 2026-10-26（v0.5.2）

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
│   ├── main.ts                   # 启动、窗口与生命周期装配
│   ├── preload.cts               # contextBridge（编译为 CommonJS preload.cjs）
│   ├── app-paths.ts              # 便携式应用目录
│   ├── workspace-trust.ts        # 工作区信任与路径包含
│   ├── ipc/                      # 按域注册 IPC（files/workspace/agent/api-config/settings/system）
│   ├── agent-registry.ts         # 按工作区登记 Agent 实例
│   ├── approval-broker.ts        # 工具审批挂起 / 超时 / 取消
│   ├── notifications.ts          # 桌面通知路由（前台抑制）
│   ├── terminal-manager.ts       # PTY、输出缓冲与日志轮转
│   ├── plugin-manager.ts         # 工作区插件加载与钩子
│   ├── draft-store.ts            # 崩溃恢复草稿
│   ├── workspace-store.ts        # 最近工作区元数据（node:sqlite 单存储）
│   ├── watch-batcher.ts          # 文件监听事件批量合并
│   ├── watch-filter.ts           # 监听忽略规则
│   ├── atomic-json.ts            # 原子写 + .bak 恢复
│   ├── logger.ts                 # 主进程文件日志
│   ├── updater.ts                # 自动更新
│   ├── tsconfig.json             # 主进程构建（ESM）
│   └── tsconfig.preload.json     # preload 构建（CommonJS）
│
├── src/                          # React 渲染进程
│   ├── components/               # 扁平结构，无子目录
│   │   ├── AgentMarkdown.tsx     # 流式 / 完整 Markdown 渲染
│   │   ├── AgentTrace.tsx        # 思考、文本、工具步骤时间线
│   │   ├── ApprovalCard.tsx      # 工具审批卡
│   │   ├── ChatPanel.tsx         # 会话面板入口（调用 controller hook）
│   │   ├── ChatHeader.tsx        # 顶部与会话标签
│   │   ├── ChatTranscript.tsx    # 虚拟化消息滚动区
│   │   ├── ChatMessageRow.tsx    # 消息行、任务与变更摘要
│   │   ├── ChatApiKeyPrompt.tsx  # 未配置 API Key 的提示
│   │   ├── VirtualRows.tsx       # 共享虚拟列表渲染
│   │   ├── ChatSessionList.tsx   # 会话抽屉（搜索、置顶、归档、导出）
│   │   ├── CommandPalette.tsx    # 命令面板（Ctrl+Shift+P）
│   │   ├── DialogHost.tsx        # 应用内确认 / 输入对话框
│   │   ├── DiffViewer.tsx        # Split / Unified Diff 查看器
│   │   ├── ErrorBoundary.tsx     # 渲染错误兜底
│   │   ├── FileExplorer.tsx      # 文件树、新建/重命名/删除、监听刷新
│   │   ├── IPCDebug.tsx          # 开发调试面板（仅 DEV）
│   │   ├── MonacoEditor.tsx      # Monaco、每文件 model、自动保存、草稿
│   │   ├── SessionTabs.tsx       # 聊天面板内的会话标签
│   │   ├── Settings.tsx          # 通用 / API / 权限 / 快捷键 / 关于
│   │   ├── TerminalPanel.tsx     # xterm + PTY、输出附加或复制
│   │   ├── Toast.tsx             # Toast 展示组件
│   │   ├── ToolResultViewer.tsx  # 工具结果全量查看
│   │   ├── UpdateDialog.tsx      # 更新下载完成弹窗
│   │   ├── UpdateStatusIndicator.tsx # 状态栏更新提示
│   │   ├── WelcomeScreen.tsx     # 欢迎页与最近工作区
│   │   ├── WindowControls.tsx    # 自绘窗口按钮（Windows / Linux）
│   │   ├── WorkspaceView.tsx     # 单个工作区的常驻三栏视图
│   │   ├── ui.tsx                # Button / Input / Modal 等基础组件
│   │   └── patterns.tsx          # Card / Stat / ListRow 等内容模式
│   ├── store/                    # 每个功能域一个 store（13 个）
│   │   ├── approvalStore.ts      # 待审批请求
│   │   ├── chatStore.ts          # 消息、草稿、附件、排队、用量
│   │   ├── dialogStore.ts        # 确认 / 输入对话框
│   │   ├── diffStore.ts          # Diff 查看器（按工作区隔离）
│   │   ├── editorStore.ts        # 标签页、当前文件、脏标记（按工作区隔离）
│   │   ├── i18nStore.ts          # 语言
│   │   ├── selectionStore.ts     # 编辑器选区片段
│   │   ├── sessionStore.ts       # 会话标签与运行状态（按工作区隔离）
│   │   ├── settingsStore.ts      # 自动保存、默认模式、通知、快捷键
│   │   ├── themeStore.ts         # Paper / Ink 主题
│   │   ├── toastStore.ts         # 全局 Toast（组件外也可调用）
│   │   ├── updaterStore.ts       # 更新状态
│   │   └── workspaceStore.ts     # 当前工作区 + 最近打开列表
│   ├── workspace/
│   │   ├── WorkspaceScope.tsx    # 让深层组件知道所属工作区
│   │   └── editorTabs.ts         # 编辑器标签落盘
│   ├── theme/tokens.ts           # 从 CSS 变量读取颜色（Monaco / xterm）
│   ├── hooks/                     # useVirtualRows / useChatSessions / useChatPanelState / useRevertEdits
│   ├── utils/                    # 文件路径/树、快捷键、符号、图片、Markdown、diff 回退等
│   ├── api/
│   │   ├── index.ts              # IPC 封装 + Web dev mock
│   │   ├── piAgentAPI.ts         # Agent 调用（Electron IPC / Web SSE 桥接）
│   │   ├── chatContext.ts        # 上下文块拼装
│   │   ├── rendererLog.ts        # 渲染进程日志上报
│   │   └── diff.ts               # 行级 Diff 算法
│   ├── types/
│   │   ├── electron.d.ts         # window.electronAPI 与 IPC 结果类型
│   │   └── index.ts              # 编辑器通用类型
│   └── i18n/                     # 中英文文案与错误本地化
│
├── pi-bridge/                    # Agent 桥接层（主进程内运行）
│   ├── src/
│   │   ├── agent-manager.ts      # 会话/模型配置/工具编辑捕获/历史/导出
│   │   ├── approval-policy.ts    # 会话模式与审批策略
│   │   ├── tool-policy.ts        # 模式对应的工具集
│   │   ├── session-extras.ts     # 会话 sidecar（计划、权限）
│   │   ├── plan.ts               # 结构化计划
│   │   ├── atomic-json.ts        # 原子写
│   │   └── index.ts
│   └── dist/                     # 构建产物（不纳入版本库）
│
├── tests/                        # Vitest 单元 / 组件测试（48 个文件）
├── docs/                         # 项目文档
├── vite.config.ts                # Vite + 仅开发环境的 dev 中间件
├── vitest.config.ts
├── eslint.config.js
└── package.json                  # scripts / electron-builder 配置
```

---

## 3. 进程模型

```
┌────────────────────────── Renderer (no Node) ──────────────────────────┐
│ React + Zustand + Monaco                                                │
│   window.electronAPI  ← contextBridge ← preload.cjs                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ IPC (ipcRenderer.invoke / webContents.send)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Main Process (Node 24)                                                  │
│   fs / dialog / safeStorage / 文件监听                                    │
│   AgentManager (pi-coding-agent) ── HTTP ──> LLM Provider               │
│   read/write/edit/bash 工具直接作用于工作区                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**安全边界**：渲染进程禁用 `nodeIntegration`、启用 `contextIsolation`（sandbox 未显式开启）；
所有能力经 preload 显式暴露。Agent 只在主进程运行。

**Web 开发模式**（`npm run web:dev`）：没有 Electron 主进程，`vite.config.ts` 中仅 `serve`
生效的中间件提供：

- `/__pi/fetch-models` — 代理供应商 `/models`（规避 CORS，15s 超时）
- `/__pi/agent/{init,chat,chat-stream,abort,dispose}` 与会话列表/标签端点 —
  在 Vite 的 Node 进程中运行同一套 AgentManager；该桥为调试用，功能少于 Electron，且默认自动放行工具

---

## 4. 关键数据流

### 打开工作区

```
App.openWorkspace
  → api.openDirectoryDialog()
  → api.initWorkspace(path)        # 创建 .pi-workbench/ 与 plugins/
  → api.watchWorkspace(path)
  → api.addRecentWorkspace(path)   # data/workspaces.db
  → WorkspaceView 常驻挂载（每个已打开工作区一份）
  → ChatPanel 读取 api-config.json → agent:initialize
  → agent:sessions:open → 恢复会话消息
```

切换工作区 / 返回首页只切换 `WorkspaceView` 的可见性，不卸载、不重置运行期状态；
关闭工作区标签才释放 Agent、监听与终端，并把标签与草稿留在磁盘供下次恢复。

### 一次对话

```
ChatPanel.handleSubmit
  → piAgentAPI.chat(message) → IPC agent:chat
  → AgentManager.chat → session.prompt()
  → 捕获 write/edit 工具前后的文件内容（FileEdit[]）
  → 返回 { response, edits }
  → ChatPanel: 追加消息；消息内显示变更卡，可逐文件打开 Diff / 还原
```

### 配置与存储

| 数据 | 位置 | 说明 |
|---|---|---|
| API 配置 | `{appDir}/config/api-config.json` | `apiKey` 为 `enc:<base64>`（safeStorage） |
| 应用设置 / 最近工作区 | `{appDir}/config/settings.json` | |
| 工作区打开记录 | `{appDir}/data/workspaces.db` | SQLite 单存储，记录打开时间与次数 |
| Agent 模型配置 | `{appDir}/data/agent/models.json` | `apiKey: "$PI_WORKBENCH_API_KEY"`，不落盘 |
| Agent 会话 | `{appDir}/data/agent/sessions/*.jsonl` | 平铺文件，按 cwd 过滤 |
| 会话 sidecar | `{appDir}/data/agent/session-extras/*.json` | 计划、权限 |
| 工作区配置 | `{workspace}/.pi-workbench/config.json` | |
| 打开中的会话 / 编辑器标签 | `{workspace}/.pi-workbench/chat-tabs.json` / `editor-tabs.json` | |
| Web dev Agent 数据 | `{appDir}/cache/temp/web-agent/` | 仅开发模式 |

---

## 5. IPC 通道（摘要）

| 通道 | 方向 | 用途 |
|---|---|---|
| `dialog:openDirectory` | invoke | 选择工作区 |
| `fs:readFile` / `writeFile` / `listDirectory` / `exists` / `stat` | invoke | 文件操作 |
| `fs:delete` / `fs:rename` | invoke | 删除 / 重命名 |
| `fs:watch` / `fs:unwatch` | invoke | 工作区递归监听 |
| `fs:changed` | main → renderer | 文件变化事件（300ms 批量） |
| `app:getSettings` / `saveSettings` | invoke | 应用设置 |
| `app:getRecentWorkspaces` / `addRecentWorkspace` | invoke | 最近工作区 |
| `app:hasActiveWork` | invoke | 更新安装前的忙碌检查 |
| `workspace:init` / `dispose` / `searchFiles` / `editorTabs:*` | invoke | 工作区生命周期与标签 |
| `apiConfig:get` / `save` / `fetchModels` | invoke | 供应商配置与模型拉取 |
| `agent:initialize` / `chat` / `abort` / `dispose` / `steer` | invoke | Agent 生命周期与运行控制 |
| `agent:sessions:*` / `agent:plan:*` / `agent:tool-result:*` | invoke | 会话、计划、工具结果 |
| `agent:stream` / `agent:session-title` | main → renderer | 流式事件与会话标题 |
| `agent:approval-request` / `approval-resolved` | main → renderer | 审批请求与解除 |
| `terminal:create` / `write` / `resize` / `close` / `flush` | invoke | 终端 PTY |
| `plugins:list` / `invoke` / `reload` / `setEnabled` | invoke | 工作台插件 |
| `draft:save` / `delete` / `list` / `clear` | invoke | 崩溃恢复草稿 |
| `chat:pending:get` / `set` | invoke | 排队消息持久化 |
| `log:renderer` | invoke | 渲染进程日志 |
| `update:check` / `download` / `install` / `getState` / `openDownload` | invoke | 自动更新 |
| `update:status` | main → renderer | 更新进度事件 |
| `window:minimize` / `toggleMaximize` / `close` / `isMaximized` | invoke | 自绘窗口按钮 |
| `window:maximized-changed` | main → renderer | 最大化状态变化 |

---

## 6. 扩展方式

### 新增 IPC

1. `electron/main.ts` 注册 `handleIpc`
2. `electron/preload.cts` 暴露到 `contextBridge`
3. `src/types/electron.d.ts` 补类型
4. `src/api/index.ts` 封装（同时补 Web mock）

### 新增组件 / Store

- 组件放 `src/components/`，扁平结构，Tailwind 写样式
- Store 放 `src/store/`，每个功能域一个；不要合并成巨型 store
- 状态更新必须不可变（创建新对象/数组）
- 工作区级状态使用 `xxxStoreFor(workspacePath)` 工厂，不要放全局单例

### 关闭工作区

`App.closeWorkspace` 会确认未保存文件与运行中任务，然后释放该工作区的 Agent、监听与终端；
`editor-tabs.json`、`chat-tabs.json` 与草稿保留在磁盘，重新打开时恢复。
不要新增「切换工作区时重置 store」的逻辑——切换只改变可见性。

---

## 7. 构建产物

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `dist/` | 渲染进程 | 否 |
| `dist-electron/` | 主进程 + preload | 否 |
| `pi-bridge/dist/` | AgentManager | 否（`predev`/`build` 自动生成） |
| `release/` | 安装包/解包目录 | 否 |
