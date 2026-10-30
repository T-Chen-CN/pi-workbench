# 项目结构

> **面向**：需要找文件、查 IPC 频道、了解进程模型与数据流的人
> **什么时候读**：新增模块 / 频道、接手陌生代码、写设计文档之前
> **什么时候要改**：目录、频道、进程模型或关键数据流变化时

**最后更新**: 2026-10-29

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
│   ├── ipc/                      # 按域注册 IPC（agent / api-config / attachments / documents / files / git / settings / system / web-search* / workspace）
│   ├── documents/                # 文档解析（零依赖）：zip / xml / ooxml / pdf / detect / preview / render-bridge
│   │   ├── zip.ts                # node:zlib 手写 ZIP 中央目录（不引第三方）
│   │   ├── xml.ts                # 流式 XML 扇描（不建 DOM）
│   │   ├── ooxml.ts              # docx / xlsx / pptx / odt / epub 解析（同时出 Agent 文本与预览块）
│   │   ├── pdf.ts                # pdfjs legacy build 取文本（不依赖 canvas）
│   │   ├── detect.ts             # 按魔数判类型（不信扩展名）
│   │   ├── extract.ts            # Agent 侧文本抽取（截断 / 扫描页收集）
│   │   ├── agent-read.ts         # read 工具的文档分支（魔数分流 + 降级）
│   │   ├── preview.ts            # 只读预览模型（工作表 / 幻灯片 / 章节 / 块）
│   │   └── render-bridge.ts      # 扫描页渲染：主进程发字节，渲染进程回图片
│   ├── agent-registry.ts         # 按工作区登记 Agent 实例
│   ├── shutdown.ts               # 退出编排：分步超时清理 + 退出看门狗（强制 exit）
│   ├── child-registry.ts         # 子进程登记与进程树回收（taskkill /T）
│   ├── async-utils.ts            # 主进程超时工具（与 pi-bridge 同语义）
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
│   ├── app-protocol.ts           # 自定义 scheme（pw-file:// 等）注册
│   ├── external-links.ts         # 外链协议白名单（https / http / mailto）
│   ├── scheme-privileges.ts      # 自定义 scheme 权限声明
│   ├── file-protocol.ts          # 文件预览协议（图片 / PDF / 媒体）
│   ├── aux-window.ts             # 辅助窗口（可拖出面板）
│   ├── window-morph.ts           # 面板在主窗口与辅助窗口间迁移
│   ├── git-cache.ts              # Git 命令结果缓存
│   ├── git-worktrees.ts          # 会话工作树与 session-git.json
│   ├── worktree-coordinator.ts   # 工作树切换在轮次边界生效
│   ├── worktree-deps.ts          # 链接工作树依赖探测与后台安装
│   ├── repo-watcher.ts           # 仓库状态监听
│   ├── repo-sync.ts              # 分支拉取 / 同步
│   ├── repo-autofetch.ts         # 定时 fetch
│   ├── github-auth.ts            # GitHub 凭据读取
│   ├── github-oauth.ts           # OAuth 回调
│   ├── github-device-login.ts    # 设备码登录
│   ├── github-app.ts             # GitHub 设置装配
│   ├── secret-crypto.ts          # safeStorage 加解密封装
│   ├── agent-config-key.ts       # 模型配置 key 解析
│   ├── legacy-paths.ts           # 旧版本路径回收
│   ├── shell-refresh.ts          # 安装后刷新 shell 缓存
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
│   │   ├── ChatPanelHeader.tsx   # 聊天面板头部（收起 / 标题 / 工作树 chip / 拖出柄）
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
│   │   ├── SelectionQuoteButton.tsx # 划词「引用到对话」浮起按钮
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
│   │   ├── BootScreen.tsx        # 启动引导占位
│   │   ├── BrandSeal.tsx         # 品牌印章（欢迎页 / 空状态）
│   │   ├── EditorTabs.tsx        # 编辑器标签栏（含未保存与预览状态）
│   │   ├── FileView.tsx          # 文件阅读视图路由（按类型分发）
│   │   ├── MarkdownReadingView.tsx # Markdown 阅读视图（块级范围渲染）
│   │   ├── PdfReadingView.tsx    # PDF 阅读（pdf.js）
│   │   ├── OfficeDocumentView.tsx # Word / 表格 / 幻灯片 / EPUB 只读预览
│   │   ├── MediaView.tsx         # 图片 / 二进制预览
│   │   ├── HtmlPreview.tsx       # HTML 沙箱预览
│   │   ├── GitView.tsx           # 只读 Git 视图（提交图 / 工作树更改）
│   │   ├── CommitDetailView.tsx  # 提交详情覆盖层
│   │   ├── WorktreeChip.tsx      # 会话工作树切换 chip（合并入聊天头部）
│   │   ├── GithubSettings.tsx    # GitHub 关联（设备码登录 / PAT）
│   │   ├── WebSearchSettings.tsx # 联网搜索供应商设置
│   │   ├── PanelSlot.tsx         # 可停靠面板槽位
│   │   ├── PanelDragHandle.tsx   # 面板拖拽把手
│   │   ├── PanelWindowFrame.tsx  # 独立面板窗口外壳
│   │   ├── PanelContextMenu.tsx  # 面板右键菜单
│   │   ├── ui.tsx                # Button / Input / Modal 等基础组件
│   │   └── patterns.tsx          # Card / Stat / ListRow 等内容模式
│   ├── store/                    # 每个功能域一个 store（16 个）
│   │   ├── approvalStore.ts      # 待审批请求
│   │   ├── chatStore.ts          # 消息、草稿、附件、排队、用量
│   │   ├── dialogStore.ts        # 确认 / 输入对话框
│   │   ├── diffStore.ts          # Diff 查看器（按工作区隔离）
│   │   ├── editorStore.ts        # 标签页、当前文件、脏标记（按工作区隔离）
│   │   ├── gitStore.ts           # Git 视图状态（分支 / 提交 / 工作树）
│   │   ├── panelStore.ts         # 可停靠 / 可拖出面板的布局状态
│   │   ├── i18nStore.ts          # 语言
│   │   ├── selectionStore.ts     # 编辑器选区片段
│   │   ├── sessionStore.ts       # 会话标签与运行状态（按工作区隔离）
│   │   ├── settingsStore.ts      # 自动保存、默认模式、通知、快捷键
│   │   ├── terminalStore.ts      # 终端开关、缓冲区与会话归属
│   │   ├── themeStore.ts         # Paper / Ink 主题
│   │   ├── toastStore.ts         # 全局 Toast（组件外也可调用）
│   │   ├── updaterStore.ts       # 更新状态
│   │   └── workspaceStore.ts     # 当前工作区 + 最近打开列表
│   ├── workspace/
│   │   ├── WorkspaceScope.tsx    # 让深层组件知道所属工作区
│   │   ├── MarkdownLinkScope.tsx # 链接作用域（外链 / 锚点 / 仓库文件分发）
│   │   ├── linkTarget.ts         # 链接目标判定与信任校验
│   │   ├── quoteSelection.ts     # 划词选区取值与长度上限
│   │   ├── chatAttachments.ts    # 附件 ↔ 上下文条目的唯一映射（发送 / 插话 / 重发）
│   │   └── editorTabs.ts         # 编辑器标签落盘
│   ├── theme/tokens.ts           # 从 CSS 变量读取颜色（Monaco / xterm）
│   ├── hooks/                     # chatScroll（聊天贴底）/ useVirtualRows / useChatSessions / useChatPanelState / useRevertEdits
│   ├── utils/                    # 文件路径/树、快捷键、符号、图片、Markdown、剪贴板、diff 回退等
│   ├── api/
│   │   ├── index.ts              # IPC 封装 + Web dev mock
│   │   ├── piAgentAPI.ts         # Agent 调用（Electron IPC / Web SSE 桥接）
│   │   ├── chatContext.ts        # 上下文块拼装
│   │   ├── documentRender.ts     # 扫描页渲染桥（渲染进程侧）
│   │   ├── rendererLog.ts        # 渲染进程日志上报
│   │   └── diff.ts               # 行级 Diff 算法
│   ├── types/
│   │   ├── electron.d.ts         # window.electronAPI 与 IPC 结果类型
│   │   └── index.ts              # 编辑器通用类型
│   └── i18n/                     # 中英文文案与错误本地化
│
├── pi-bridge/                    # Agent 桥接层（主进程内运行）
│   ├── src/
│   │   ├── agent-manager.ts      # 会话 / 模型配置 / 工具编辑捕获 / 历史 / 导出
│   │   ├── environment.ts        # 环境租约（工作区级共享资源）
│   │   ├── model-config.ts       # models.json 读写与 key 插值
│   │   ├── approval-policy.ts    # 会话模式与审批策略
│   │   ├── tool-policy.ts        # 模式对应的工具集
│   │   ├── approval-extension.ts # 审批请求扩展
│   │   ├── plan.ts               # 结构化计划
│   │   ├── plan-extension.ts     # 计划工具扩展
│   │   ├── worktree-extension.ts # 工作树切换工具扩展
│   │   ├── session-extras.ts     # 会话 sidecar（计划、权限）
│   │   ├── session-history.ts    # JSONL 历史解析
│   │   ├── session-branch.ts     # 对话分支（fork）切换
│   │   ├── session-export.ts     # Markdown / HTML / JSONL 导出
│   │   ├── session-title.ts      # 首轮后生成会话标题
│   │   ├── chat-images.ts        # 图片附件预处理
│   │   ├── read-with-documents.ts # 同名覆盖 read：PDF / Office 走文档解析
│   │   ├── tool-results.ts       # 按 toolCallId 读取工具结果
│   │   ├── stall-watchdog.ts     # 无响应看门狗
│   │   ├── async-utils.ts        # 超时与重试工具
│   │   ├── text-utils.ts         # 文本截断 / 上下文块拼装与解析
│   │   ├── atomic-json.ts        # 原子写
│   │   ├── types.ts              # 桥接层类型
│   │   └── index.ts              # 对外导出
│   └── dist/                     # 构建产物（不纳入版本库）
│
├── tests/                        # Vitest 单元 / 组件测试（扁平，文件名与源码同名）
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

**安全边界**：渲染进程禁用 `nodeIntegration`、启用 `contextIsolation` 与 `sandbox`；
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

落盘位置、写入者与恢复语义见 [agent/paths-and-storage §3](../agent/paths-and-storage.md)。

---

## 5. IPC 通道（摘要）

| 通道 | 方向 | 用途 |
|---|---|---|
| `dialog:openDirectory` | invoke | 选择工作区 |
| `attachment:pick` | invoke | 选择聊天附件（任意路径 / 任意格式，只回传路径与元信息；图片额外回传 base64） |
| `documents:preview` | invoke | 取 Office / EPUB 的只读预览模型（经 `resolveAllowedFileTarget` 校验） |
| `documents:render-request` | main → renderer | 请求把扫描页字节画成图片（字节随事件下发，渲染层没有路径读能力） |
| `documents:render-result` | invoke | 渲染进程回传图片或失败原因 |
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
| `log:renderer` | invoke | 渲染进程日志 |
| `update:check` / `download` / `install` / `getState` / `openDownload` | invoke | 自动更新 |
| `update:status` | main → renderer | 更新进度事件 |
| `window:minimize` / `toggleMaximize` / `close` / `isMaximized` | invoke | 自绘窗口按钮 |
| `window:maximized-changed` | main → renderer | 最大化状态变化 |
| `git:*`（22 invoke + 2 推送） | invoke / main → renderer | 工作树、只读历史、分支 / 提交、工作树依赖安装；见 [git-and-worktrees §3](../agent/git-and-worktrees.md) |
| `github:*`（7 invoke + 1 推送） | invoke / main → renderer | GitHub OAuth（设备码 / 回调）、登录状态、账号配置 |
| `aux:*`（4 invoke + 1 推送） | invoke / main → renderer | 可停见面板的辅助窗口（拖动起点、拆出位置、窗口命令、状态、关闭事件）；handler 注册在 `electron/aux-window.ts` |
| `shell:openExternal` | invoke | 外部链接（https / http / mailto）交系统浏览器；白名单在 `electron/external-links.ts` |
| `clipboard:writeText` | invoke | 写系统剪贴板（`pw-app://` 下 `navigator.clipboard` 不可用） |
| `webSearch:get` / `save` | invoke | 联网搜索供应商与 Key（`safeStorage` 加密） |

---

## 6. 扩展方式

### 新增 IPC

用 `handleIpc()` 在 `electron/ipc/<域>.ts` 注册（来源校验），再走 preload → 类型 → `src/api`。四步清单与示例见 [agent/ipc-and-trust §2](../agent/ipc-and-trust.md)。

### 新增组件 / Store

- 组件放 `src/components/`，扁平结构，Tailwind 写样式
- Store 放 `src/store/`，每个功能域一个；状态更新必须不可变（创建新对象/数组）
- 工作区级状态用 `xxxStoreFor(workspacePath)` 工厂（铁律见 [AGENTS.md §4](../../AGENTS.md)）

### 关闭工作区

`App.closeWorkspace` 会确认未保存文件与运行中任务，然后释放该工作区的 Agent、监听与终端；
`editor-tabs.json`、`chat-tabs.json` 与草稿保留在磁盘，重新打开时恢复。
切换工作区只改变可见性，不重置 store。

---

## 7. 构建产物

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `dist/` | 渲染进程 | 否 |
| `dist-electron/` | 主进程 + preload | 否 |
| `pi-bridge/dist/` | AgentManager | 否（`predev`/`build` 自动生成） |
| `release/` | 安装包/解包目录 | 否 |
