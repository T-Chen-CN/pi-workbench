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
│   ├── ipc/                      # 按域注册 IPC（agent / api-config / attachments / cloud-agent / dispatch / documents / files / git / settings / system / web-search* / workspace）
│   ├── cloud/                    # 云端 Agent 主进程侧
│   │   ├── config.ts             # 连接配置（网关地址 / 设备 token，safeStorage 加密）+ cloudTransport() 单入口
│   │   ├── gateway.ts            # 网关：配对 / 我是谁 / 撤销 + 错误码翻译（与 CLOUD_AGENT 的错误码表对齐）
│   │   ├── client.ts / remote.ts # 网关客户端与 REST 调用（会话、轮次、停止、插话）
│   │   ├── events.ts / map.ts    # SSE 事件解析与时间线映射（含插话回执）
│   │   ├── runner.ts             # 轮次生命周期（断流重订阅、校帧、停止兜底）
│   │   ├── dashboard.ts          # 控制台原生视图（WebContentsView）宿主
│   │   ├── media.ts              # 图片旁路（Bearer 设备 token）：上传 / 按路径读回
│   │   ├── ledger.ts             # 未结算账本：分类 / 记账 / 结账 / 历史复核 / 剪枝
│   ├── dispatch/                 # 工作区派活（云端 Hermes → 本机工作区）
│   │   ├── config.ts             # 白名单 `data/agent/dispatch.json`（id 由路径哈希，不落路径上云）
│   │   ├── relay.ts              # 出站 SSE 中继（退避重连）+ 清单上报 + 任务回报
│   │   ├── executor.ts           # 把一条云任务变成一次真实本地会话（权限 auto，无本地审批门）
│   │   ├── worker.ts             # 帧分发 / 串行队列 / 取消 / 反问 / 心跳 / 账本写入
│   │   ├── ledger.ts             # 本机账本 `data/agent/dispatch-ledger.json`（最近 20 条）
│   │   └── trace.ts              # 派活轨迹 `cache/dispatch-traces/`（步骤上限 200，路径脱敏，仅事后查）
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
│   ├── text-sanitize.ts          # 剥终端颜色码（派活轨迹 / 审计预览，与 pi-bridge 同语义）
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
│   ├── repo-map.ts               # 仓库地图：Git 跟踪文件 → 职责事实表（只读 + 增量缓存）
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
│   │   ├── WorkspacePickerDialog.tsx # 标签栏 `+` 的弹窗：历史工作区 + 新增工作区
│   │   ├── WindowControls.tsx    # 自绘窗口按钮（Windows / Linux）
│   │   ├── WorkspaceView.tsx     # 单个工作区的常驻三栏视图
│   │   ├── BootScreen.tsx        # 启动引导占位
│   │   ├── BrandSeal.tsx         # 品牌印章（欢迎页 / 空状态）
│   │   ├── EditorTabs.tsx        # 编辑器标签栏（面板标签 + 未保存与预览状态）
│   │   ├── FileView.tsx          # 编辑区容器：面板 / 文件视图分发（按类型路由）
│   │   ├── WorkspacePanel.tsx    # 工作区面板：工具条 / 搜索 / 降级提示 + 画布容器
│   │   ├── RepoMapCanvas.tsx     # 仓库地图：底层地图 + 上浮链（平移 / 缩放 / 拖动 / 吸附 / LOD / 小地图）
│   │   ├── RepoMapNodeCard.tsx   # 画布卡片（文件夹卡 / 文件卡）
│   │   ├── RepoMapMinimap.tsx    # 画布小地图（SVG 缩略图 + 视口框）
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
│   │   ├── CloudWorkspaceView.tsx # 云端 Agent 外壳：会话 / 控制台 / 任务 / 连接四个常驻页签（切走只 hidden + inert）
│   │   ├── CloudSessionView.tsx  # 云端会话列表 + 时间线 + 输入框
│   │   ├── CloudConsoleView.tsx  # 云端控制台全屏宿主（原生视图边界上报 / 失败与未连接态）
│   │   ├── CloudConnectionView.tsx # 云端连接页（地址 / 密钥 / 连通性 / 能力回显）
│   │   ├── DispatchCard.tsx       # 「云端 → 派活」卡片（开关 / 白名单 / 运行态 / 急停 / 最近任务）
│   │   ├── CloudTrace.tsx        # 云端时间线（文本 / 思考折叠 / 分隔线）
│   │   ├── CloudSubagentCard.tsx  # 子代理卡片（目标 / 状态 / token / 输出尾巴）
│   │   ├── CloudLedgerDrawer.tsx  # 未结算账本抽屉（做了 / 没做 / 不管）
│   │   ├── CloudJobsView.tsx      # 定时任务页（列表 / 现在跑 / 暂停 / 恢复）
│   │   ├── CloudDiagnosticsPanel.tsx # 自检折叠块（健康 / 工具集 / 技能 / 模型）
│   │   ├── CloudClarifyCard.tsx   # clarify 提问卡（选项 + 自由回答）
│   │   ├── CloudApprovalCard.tsx  # 审批卡（一次 / 本会话 / 拒绝；默认拒绝，`always` 永不渲染）
│   │   ├── CloudModeSwitch.tsx    # 审批档位手动切（manual / smart / off；放宽到 off 要二次确认）
│   │   ├── CloudToolCard.tsx     # 云端工具执行卡
│   │   ├── ui.tsx                # Button / Input / Modal 等基础组件
│   │   └── patterns.tsx          # Card / Stat / ListRow 等内容模式
│   ├── store/                    # 每个功能域一个 store（16 个）
│   │   ├── approvalStore.ts      # 待审批请求
│   │   ├── chatStore.ts          # 消息、草稿、附件、排队、用量
│   │   ├── cloudStore.ts         # 云端连接、会话列表、时间线片段、当前轮次、控制台状态
│   │   ├── dispatchStore.ts      # 派活配置、运行态、最近任务（刻意与 cloudStore 分开）
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
│   │                             # useCloudBridge（主进程推来的云端事件 → store）
│   │                             # useCloudImage（按路径读云端图片，带 24 条缓存）
│   ├── utils/                    # 文件路径/树、快捷键、符号、图片、Markdown、剪贴板、diff 回退
│   │                             # 仓库地图：repoMapText（文案）/ repoMapLayout（底层 + 上浮链 + 层级深度）
│   │                             # repoMapCanvasState（落盘形状与迁移）/ repoMapLod
│   │                             # cloudImages（`/image <path>` 指令的抽取 / 剥离 / 拼接）
│   ├── api/
│   │   ├── index.ts              # IPC 封装 + Web dev mock
│   │   ├── piAgentAPI.ts         # Agent 调用（Electron IPC / Web SSE 桥接）
│   │   ├── cloud.ts              # 云端 Agent IPC 封装（浏览器下返回「未配置」）
│   │   ├── dispatch.ts           # 派活 IPC 封装（浏览器下返回「不可用」空态）
│   │   ├── chatContext.ts        # 上下文块拼装
│   │   ├── documentRender.ts     # 扫描页渲染桥（渲染进程侧）
│   │   ├── rendererLog.ts        # 渲染进程日志上报
│   │   └── diff.ts               # 行级 Diff 算法
│   ├── types/
│   │   ├── electron.d.ts         # window.electronAPI 与 IPC 结果类型
│   │   ├── cloud.ts              # 云端时间线片段 / 会话 / 轮次状态（主进程有一份结构相同的副本）
│   │   ├── navigation.ts         # 顶层视图 AppView
│   │   └── index.ts              # 编辑器通用类型
│   └── i18n/                     # 中英文文案与错误本地化
│
├── tests/                        # 扁平测试目录（文件名与源码同名）
├── docs/                         # 规范原文；云端方案唯一入口是 requirements/CLOUD_AGENT.md
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
│   │   ├── dispatch-extension.ts # 派活反问工具 ask_cloud_operator（只注入派活会话）
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
| `app:getRecentWorkspaces` / `addRecentWorkspace` | invoke | 最近工作区（只返回仍然存在的目录） |
| `app:hasActiveWork` | invoke | 更新安装前的忙碌检查 |
| `workspace:init` / `dispose` / `searchFiles` / `editorTabs:*` | invoke | 工作区生命周期与标签 |
| `repo-map:scan` / `repo-map:describe` | invoke | 仓库地图扫描 / 降级模式下补齐描述（只读，缓存写在工作区 `.pi-workbench/`） |
| `repo-map:canvas:get` / `repo-map:canvas:set` | invoke | 画布布局读写（`.pi-workbench/repo-map-canvas.json`，写前清洗坐标与路径键） |
| `apiConfig:get` / `save` / `fetchModels` | invoke | 供应商配置与模型拉取 |
| `agent:initialize` / `chat` / `abort` / `dispose` / `steer` | invoke | Agent 生命周期与运行控制 |
| `agent:sessions:*` / `agent:plan:*` / `agent:tool-result:*` | invoke | 会话、计划、工具结果 |
| `agent:stream` / `agent:session-title` | main → renderer | 流式事件与会话标题 |
| `agent:approval-request` / `approval-resolved` | main → renderer | 审批请求与解除 |
| `app:notify-click` | main → renderer | 系统通知点击：本地带 `workspaceDir`（切工作区 + 激活会话）；云端带 `cloud` + `sessionId` + 可选 `requestId`（切云端页 + 打开会话 + 定位那张审批 / 澄清卡，`data-cloud-card` 锚点） |
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
| `cloud:config:get` / `connect` / `disconnect` | invoke | 云端 Agent 连接配置（`data/cloud-agent/connection.json`，只允许 `gatewayUrl` / `deviceToken` / `deviceScopes` / `deviceId` / `dashboardUrl`；token 走 `safeStorage` 加密，渲染层只拿 `hasDeviceToken`）与连通性探测；旧字段（`baseUrl` / `apiKey` / `dashboardToken` / 管理密钥 / 控制台账号口令 / 旧凭证导入记录）在 `config:get` 时按白名单清掉 |
| `cloud:gateway:status` / `gateway:pair` / `gateway:revoke` | invoke | 云端单入口（`hub.`）三件事：`status` = 配对了没有 + scope + 上游在不在 + 本机心跳状态（未配对时**不发任何请求**）；`pair` = 一次性连接码换设备 token（`deviceId` 钉死本地 `device.json` 的 id，明文 token 只留主进程，落盘 `enc:`；不带任何管理凭据；成功后清 active-run、pokes 心跳、渲染层刷新 config 并直接重连）；`revoke` = 设备自注销并只清设备凭据（保留 `gatewayUrl` / `dashboardUrl`） |
| `cloud:device:get` / `device:set` / `device:reprobe` | invoke | 本机设备身份（`data/cloud-agent/device.json`，启动时即建）：`get` 首次会补一次系统友好名探测（`probedAt` 后不再自动探），`set` 只改 `name`（空串 = 恢复默认名），`reprobe` 是用户显式「重新读取系统名」。`id` 只读，随每轮 `POST /v1/runs` 的 `author` 发出（只做记忆归属，**不进 prompt**） |
| `cloud:sessions:list` / `messages:list` | invoke | 云端会话列表与历史消息（主进程直接映射成时间线片段） |
| `cloud:sessions:update` / `sessions:delete` | invoke | 会话条目操作（PATCH 白名单字段 / 硬删除，不可恢复） |
| `cloud:run:start` / `run:stop` / `run:status` / `run:steer` / `run:attach` | invoke | 云端轮次：POST `/v1/runs`（带幂等键）、停止、状态轮询、运行中插话（`queued` 不接受插话）；`run:attach` 用 `data/cloud-agent/active-run.json` 在重启后接回还在跑的那一轮（订阅带 `last_seq` 上限，只收新事件，先铺历史再放增量） |
| `cloud:clarify:respond` | invoke | 回答 clarify 提问（body 严格 `{request_id, execution_generation, answer}`） |
| `cloud:approval:respond` | invoke | 提交审批决定（只收 `once` / `session` / `deny`，`always` 一律拒；body **三个字段必填** `{request_id, execution_generation, choice}`，实测少一个就是 400 `invalid_params`）；回执一成功立刻写一条审计 |
| `cloud:policy:get` / `policy:set` | invoke | 服务端原生审批档位（`approvals.mode` = `manual` / `smart` / `off`）：只读白名单子集（`mode` / `timeout` / deny 条数 / 禁用工具集 / 终端后端）、写最小 patch 并读回复核 |
| `cloud:diagnostics` | invoke | 自检：`/health/detailed` + `/v1/{toolsets,skills,models}` 四块独立成败 |
| `cloud:jobs:list` / `jobs:create` / `jobs:update` / `jobs:delete` / `jobs:run` / `jobs:pause` / `jobs:resume` | invoke | 定时任务：列表 + 新建 + 编辑 / 删除 + 三个动作 |
| `cloud:ledger:list` / `ledger:resolve` / `ledger:note` | invoke | 未结算账本：列条目、人工三选一（做了 / 没做 / 不管）、手工补记 |
| `cloud:run:resolve-unknown` | invoke | 收尾「主人进程丢了」的 run（凭据由主进程现查，渲染层只递 runId） |
| `cloud:media:upload` / `media:read` | invoke | 图片上传与按路径读回（经网关旁路，凭据就是设备 token；插件转发给控制台） |
| `cloud:event` | main → renderer | SSE 帧映射后的时间线增量 / 轮次状态 / 会话 id |
| `cloud:status` | main → renderer | 连接状态变化 |
| `cloud:dashboard:open` / `close` / `bounds` / `reload` | invoke | 程序内控制台：`WebContentsView`（独立 partition、sandbox、无 preload）的开合、边界同步、重载。**可见性唯一真相是 `bounds.visible`**：为 false 时视图直接从窗口摘除；`bounds` 只接受主窗口上报 |
| `cloud:dashboard:loaded` / `load-failed` / `dashboard:closed` | main → renderer | 控制台首帧加载完成 / 加载失败 / 页面内 Esc 关闭 |
| `dispatch:config:get` / `config:set` | invoke | 派活总开关与工作区白名单（`data/agent/dispatch.json`）。写入时把每个目录登记进信任表（白名单本身就是一次授权），返回给渲染层的清单**带本机路径**（只在本机界面显示），上云的是 `publicWorkspaces()` 过滤后的 id / label / description |
| `dispatch:workspace:add` / `workspace:update` / `workspace:remove` | invoke | 白名单增删改：`add` 走系统选目录对话框（用户点选即授权），`update` 只改显示名与描述 |
| `dispatch:state` / `dispatch:stop` | invoke | 运行态快照（连没连上 / 在跑什么 / 排了几个 / 最近任务）与急停（断中继 + abort 当前会话 + 显式回报 `canceled`） |
| `dispatch:state-changed` | main → renderer | 派活运行态或账本变化 |

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
