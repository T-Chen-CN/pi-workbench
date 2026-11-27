# 项目结构

> **面向**：需要找文件、查 IPC 频道、了解进程模型与数据流的人
> **什么时候读**：新增模块 / 频道、接手陌生代码、写设计文档之前
> **什么时候要改**：目录、频道、进程模型或关键数据流变化时

**最后更新**: 2026-11-27

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
│   ├── workspace-trust.ts        # 工作区信任与路径包含（lstat/readlink/realpath 防悬挂软链）
│   ├── path-safety.ts            # 纯 Node 路径安全工具（Worker 可复用，不引 electron）
│   ├── worker-runner.ts          # 轻量 worker_threads 执行器（文档解析 / 仓库地图卸载）
│   ├── ipc/                      # 按域注册 IPC + schemas.ts（高危入参 Zod 校验）
│   ├── documents/                # 文档解析（零依赖，documents-worker.ts 跑在 worker_threads）
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
│   ├── text-sanitize.ts          # 剥终端颜色码（派活轨迹 / 审计预览，与 pi-bridge 同语义）
│   ├── logger.ts                 # 主进程文件日志
│   ├── updater.ts                # 自动更新
│   ├── app-protocol.ts           # 自定义 scheme（pw-file:// 等）注册
│   ├── external-links.ts         # 外链协议白名单（https / http / mailto）
│   ├── scheme-privileges.ts      # 自定义 scheme 权限声明
│   ├── file-protocol.ts          # 文件预览协议（图片 / PDF / 媒体）
│   ├── aux-window.ts             # 辅助窗口（纯 DOM Portal，不继承 preload；原生 titleBarOverlay）
│   ├── boot-window.ts            # 主窗口启动管理器（即时目标尺寸打开，无形变动画）
│   ├── git-cache.ts              # Git 命令结果缓存
│   ├── git-worktrees.ts          # 会话工作树与 session-git.json
│   ├── worktree-coordinator.ts   # 工作树切换在轮次边界生效
│   ├── worktree-deps.ts          # 链接工作树依赖探测与安装（默认关闭自动安装）
│   ├── repo-map.ts               # 仓库地图：Git 跟踪文件 → 职责事实表（repo-map-worker.ts 卸载扫描）
│   ├── repo-map-canvas.ts        # 画布布局落盘（repo-map-canvas.json，读 + 清洗 + 原子写）
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
│   ├── components/               # 按业务域分组（10 个子目录）
│   │   ├── chat/                 # AgentMarkdown / AgentTrace / ApprovalCard / Chat* / SessionTabs / ToolResultViewer
│   │   ├── cloud/                # CloudStatusIndicator / CloudTraceSection / CloudView / TaskResultSection
│   │   ├── editor/               # DiffViewer / EditorTabs / FileView / HtmlPreview / MarkdownReadingView / MediaView / MonacoEditor / OfficeDocumentView / PdfReadingView / TerminalPanel
│   │   ├── files/                # FileExplorer
│   │   ├── git/                  # CommitDetailView / GitView / WorktreeChip
│   │   ├── panels/               # PanelContextMenu / PanelDragHandle / PanelSlot / PanelWindowFrame
│   │   ├── repo-map/             # RepoMapCanvas / RepoMapMinimap / RepoMapNodeCard / WorkspacePanel
│   │   ├── settings/             # GithubSettings / ProviderAuthPanel / ProviderSettings / Settings / UpdateDialog / UpdateStatusIndicator / WebSearchSettings
│   │   ├── ui/                   # ui / patterns / BrandSeal / BootScreen / DialogHost / ErrorBoundary / SelectionQuoteButton / Toast / VirtualRows / WindowControls / StreamdownView / StreamingTranscript / IPCDebug
│   │   └── workspace/            # CommandPalette / WelcomeScreen / WorkspacePickerDialog / WorkspaceView
│   ├── store/                    # 每个功能域一个 store（16 个）
│   │   ├── approvalStore.ts      # 待审批请求
│   │   ├── chatStore.ts          # 消息、草稿、附件、排队、用量
│   │   ├── dialogStore.ts        # 确认 / 输入对话框
│   │   ├── diffStore.ts          # Diff 查看器（按工作区隔离）
│   │   ├── editorStore.ts        # 标签页、当前文件、脏标记、面板开关（按工作区隔离）
│   │   ├── gitStore.ts           # Git 视图状态（分支 / 提交 / 工作树）
│   │   ├── repoMapStore.ts       # 仓库地图扫描结果（按工作区缓存 / 按需补描述）
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
│   │   ├── editorTabs.ts         # 编辑器标签落盘
│   │   └── repoMapCanvas.ts      # 底层画布布局的读取与防抖落盘（上浮链状态不落盘）
│   ├── theme/tokens.ts           # 从 CSS 变量读取颜色（Monaco / xterm）
│   ├── hooks/                     # chatScroll（聊天贴底）/ useVirtualRows / useChatSessions / useChatPanelState / useRevertEdits
│   ├── utils/                    # 文件路径/树、快捷键、符号、图片、Markdown、剪贴板、diff 回退
│   │                             # 仓库地图：repoMapText（文案）/ repoMapLayout（底层 + 上浮链 + 层级深度）
│   │                             # repoMapCanvasState（落盘形状与迁移）/ repoMapLod
│   ├── api/
│   │   ├── index.ts              # IPC 封装 + Web dev mock
│   │   ├── piAgentAPI.ts         # Agent 调用（Electron IPC / Web SSE 桥接）
│   │   ├── chatContext.ts        # 上下文块拼装
│   │   ├── documentRender.ts     # 扫描页渲染桥（渲染进程侧）
│   │   ├── rendererLog.ts        # 渲染进程日志上报
│   │   └── diff.ts               # 行级 Diff 算法
│   ├── types/
│   │   ├── electron.d.ts         # window.electronAPI 与 IPC 结果类型
│   │   ├── navigation.ts         # 顶层视图 AppView
│   │   └── index.ts              # 编辑器通用类型
│   └── i18n/                     # 中英文文案与错误本地化
│
├── tests/                        # Vitest 单元 / 组件测试（按域分子目录：agent / cloud / electron / git / ui / utils）
│
├── packages/cloud-ui/            # 桌面端与云端 Web 共享 UI（npm workspace，零 Electron / zustand / 桌面 store 依赖）
│   └── src/                      # types / format / frameReducer / primitives / cards
│
├── apps/cloud/                   # 云端服务（npm workspace，不依赖 Electron）
│   ├── src/
│   │   ├── main.ts               # 装配：存储 / 云端会话 / 派活器 / 两条 WS / 静态客户端
│   │   ├── config.ts             # 环境变量（PI_CLOUD_*），加密 key 与 cookie secret 必填
│   │   ├── http/                 # Router、REST 控制面、Web 客户端静态托管
│   │   ├── ws/hub.ts             # 客户端与设备两条通道、seq/ack/resume、outbox
│   │   ├── tasks/                # 工单状态机、授权强制点、派活器
│   │   ├── agent/                # 云端单会话（6 个工具）与 trace 投影
│   │   ├── auth/                 # scrypt 口令、token 哈希、限速熔断、cookie
│   │   ├── secure/               # AES-256-GCM 配置加密
│   │   └── store/                # Node 24 node:sqlite (WAL + 独立 task_diffs 表 + 旧 JSON 自动迁移)
│   ├── web-src/                  # Web 控制台源码（React + Tailwind + @pi-workbench/cloud-ui，本地 Vite 构建到 web-dist/）
│   └── deploy/                   # systemd 单元、Caddy 片段、每日备份、按需拉取更新脚本
│
├── electron/cloud/               # 终端执行器（device agent），只跑在桌面端主进程
│   ├── device-agent.ts           # /device/ws、心跳、重连、离线队列、G6 恢复
│   ├── task-runner.ts            # 单元 worktree + 工单会话 + 里程碑/结果回流
│   ├── task-guard.ts             # 工具守卫（越界写、git push、curl|sh、越界 rm -rf）
│   ├── client-link.ts            # 桌面端云端页的客户端通道（token 留在主进程）
│   ├── link-store.ts             # 配对凭据（safeStorage 加密）
│   └── inventory.ts              # 工作区上报清单（路径 / remote / 默认分支）
│
├── pi-bridge/                    # Agent 桥接层（主进程内运行）
│   ├── src/
│   │   ├── agent-manager.ts      # 会话协调入口（拆分出 agent-runtime-types / agent-session-events / agent-title-service / agent-catalog）
│   │   ├── session-view.ts       # 聊天消息唯一投影（deriveMessages / 持久化 entryId / 聚合 usage）
│   │   ├── environment.ts        # 环境租约（工作区级共享资源）
│   │   ├── model-config.ts       # models.json 读写与 key 插值
│   │   ├── approval-policy.ts    # 会话模式与审批策略
│   │   ├── tool-policy.ts        # 模式对应的工具集
│   │   ├── approval-extension.ts # 审批请求扩展
│   │   ├── plan.ts               # 结构化计划
│   │   ├── dispatch-extension.ts # 派活反问工具 ask_cloud_operator（当前无调用方；云端用 electron/cloud 的 ask_cloud）
│   │   ├── cloud-protocol.ts     # 云端协议契约（帧、状态机常量、事件载荷；桌面端/云端/Web 共用）
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
├── tests/                        # 按域分子目录（agent / cloud / electron / git / ui / utils）
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
生效的中间件提供 `/__pi/agent/{init,chat,chat-stream,abort,dispose}` 与会话列表/标签端点（校验 `Host`/`Origin`、`Content-Type: application/json` 与随机 `X-Pi-Dev-Token`），在 Vite 的 Node 进程中运行同一套 AgentManager；该桥仅用于开发调试，生产不启用。

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
  → ChatPanel 读取 providers.json（active provider + 模型）→ agent:initialize
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
| `app:getRecentWorkspaces` / `addRecentWorkspace` | invoke | 最近工作区（只返回仍然存在的目录） |
| `app:hasActiveWork` | invoke | 更新安装前的忙碌检查 |
| `workspace:init` / `dispose` / `searchFiles` / `editorTabs:*` | invoke | 工作区生命周期与标签 |
| `repo-map:scan` / `repo-map:describe` | invoke | 仓库地图扫描 / 降级模式下补齐描述（只读，缓存写在工作区 `.pi-workbench/`） |
| `repo-map:canvas:get` / `repo-map:canvas:set` | invoke | 画布布局读写（`.pi-workbench/repo-map-canvas.json`，写前清洗坐标与路径键） |
| `providers:list` / `setActive` / `setOverrides` / `refresh` | invoke | 供应商列表、切换、容量下调、目录刷新 |
| `providers:setApiKey` / `forget` / `login` / `authAnswer` / `cancelLogin` | invoke | 凭证录入、移除、OAuth 登录与交互 |
| `providers:auth-event` | event | 登录过程中的提示 / 授权链接 / 设备码 / 需要输入 / 结果 |
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
| `cloud:linkStatus` / `pair` / `unlink` / `reconnect` / `refreshWorkspaces` / `listWorkspaces` | invoke | 云端配对与终端执行器状态 |
| `cloud:getConfig` / `saveConfig` | invoke | 云端模型配置（主进程代理，Key 不进渲染层） |
| `cloud:clientOpen` / `clientSend` / `clientClose` / `clientState` | invoke | 云端页的客户端通道（token 留在主进程） |
| `cloud:state` / `cloud:client-frame` / `cloud:client-state` | main → renderer | 执行器状态、云端帧与通道状态 |

---

## 6. 扩展方式

### 新增 IPC

用 `handleIpc()` 在 `electron/ipc/<域>.ts` 注册（来源校验），再走 preload → 类型 → `src/api`。四步清单与示例见 [agent/ipc-and-trust §2](../agent/ipc-and-trust.md)。

### 新增组件 / Store

- 组件按业务域放入 `src/components/{chat,cloud,editor,files,git,panels,repo-map,settings,ui,workspace}/`，Tailwind 语义 token 写样式
- 测试按域放入 `tests/{agent,cloud,electron,git,ui,utils}/`
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
| `apps/cloud/web-dist/` | 云端 Web 静态产物 | 否（`build:cloud-web` / `build:cloud` 生成） |
| `release/` | 安装包/解包目录 | 否 |
