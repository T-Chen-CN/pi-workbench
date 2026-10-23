# 项目状态

本文件汇总项目的进度和完成状态。

## 最新状态

**更新时间**: 2026-10-23

- ✅ **Phase 0: MVP** — Electron 框架、文件管理、编辑器、Diff、国际化
- ✅ **便携式架构** — 所有应用数据自包含在应用目录内
- ✅ **Phase 1: Pi Agent 集成** — 真实 Agent 可用（模型拉取 / 对话 / 工具）
- ✅ **Phase 2: 工作区与对话体验** — 流式输出、修改审阅、上下文选择、多工作区标签
- ✅ **Phase 3: 终端集成** — xterm.js + node-pty，输出可附加给 Agent
- ✅ **Phase 4: 工作台插件系统** — 命令/钩子、启用禁用、热重载、命令面板
- ✅ **Phase 5: Fleet 后台任务** — worktree 隔离、任务队列、每任务 Agent、监控与日志
- 🟡 **Phase 6: 优化与完善** — 持续（分包 / CSP / 测试已完成）

## 当前版本

- **版本**: 0.2.2
- **框架**: Electron 44 + React 19 + TypeScript
- **Agent**: `@earendil-works/pi-coding-agent` 1.3.0
- **状态**: Phase 5 完成，Phase 6 持续优化

## 功能清单

### ✅ Phase 0: MVP（2026-10-20 完成）

- 桌面应用框架（Electron 44）
- 代码编辑器（Monaco Editor，自动保存 2s 防抖）
- 文件浏览器与多标签页
- Diff 查看器（Split / Unified）
- 聊天面板、设置面板
- 中英文国际化
- Toast 通知系统（全局 store）
- IPC 调试工具

### ✅ 便携式架构（2026-10-20 完成）

- 应用目录结构初始化（`config/`、`cache/`、`data/`、`logs/`）
- `getAppDir()` 路径管理（生产 = 可执行文件目录，开发 = 项目根目录）
- 应用配置 / 工作区配置管理 API
- 路径规范文档

### ✅ Phase 1: Pi Agent 真实集成（2026-10-20 完成）

- 统一 OpenAI 兼容的 API 配置：Provider + URL + Key + 拉取模型 + 选择模型
- 真实调用供应商 `/models` 拉取模型列表（Anthropic / OpenAI / 任意兼容端点）
- API Key 使用 Electron `safeStorage` 加密存储于 `{appDir}/config/api-config.json`
- AgentManager 在主进程运行，基于 `pi-coding-agent` SDK
- 自动生成 `data/agent/models.json`，支持 DeepSeek 等兼容端点
- read / write / edit / bash 工具可用
- 供应商错误（401、限流等）原样透传到聊天面板
- preload 采用 CommonJS 编译（sandbox 兼容），并提供启动自检
- 纯 Web 开发模式：Vite 中间件提供模型拉取代理与 Agent 桥接
- 已知限制：无流式输出（Phase 2 已解决，见下文“流式输出”）

详细报告：[Phase 1 完成报告](./PHASE-1-COMPLETE.md)

### ✅ Phase 1 加固（2026-10-20）

- 工作区生命周期闭环：打开时初始化 `.pi-workbench/`、切换/关闭时释放 Agent 并清空编辑器/聊天/Diff 状态
- 最近打开工作区列表（`config/settings.json`），欢迎页可直接打开
- 会话持久化：按工作区恢复 Pi 会话与聊天历史（跨重启）
- Agent 编辑捕获：write/edit 工具前后内容对比 → 自动打开 DiffViewer
- 文件操作补齐：重命名、删除；递归文件监听（300ms 防抖）
- 外部文件变化：未被本地修改时自动同步编辑器内容，删除时关闭标签
- 未保存保护：关闭标签 / 关闭工作区 / 关闭窗口均提示
- 修复 `markDirty` 未更新 `isDirty` 的问题（未保存圆点现在正确显示）
- 删除死代码：`Editor.tsx`、`errorStore`、旧 Mock IPC
- 工程化：Vitest 单元测试、ESLint、Prettier、GitHub Actions CI
- `pi-bridge/dist` 移出版本库（构建时生成）

### 🗂️ Phase 2–5 记录

#### Phase 2: 工作区与对话体验（完成）

- ✅ 最近打开列表（JSON，`config/settings.json`）
- ✅ 工作区生命周期（初始化 / 切换清理 / 关闭）
- ✅ 会话持久化与恢复（Pi 会话 + UI 历史）
- ✅ 主进程文件日志（`{appDir}/logs/main.log`，5MB 轮转并保留 `.1` 备份；渲染进程日志 2026-10-21 补齐为 `{appDir}/logs/renderer.log`）
- ✅ 流式输出（Electron：主进程推送 `text_delta` 增量；Web dev 模式仍整轮返回）
- ✅ Agent 修改审阅：本轮全部文件修改进入队列，可逐项保留或还原为修改前内容（修改已落盘，属事后审阅）
- ✅ 上下文选择（v1）：可把已打开的文件附加到下一条消息；单文件 120k / 单条消息 300k 字符上限，恢复历史时自动剥离文件内容
- ✅ 多工作区并行：标签页切换，各工作区独立 Agent 实例（配置变化时重建，关闭时释放）
- ✅ 上下文片段（2026-10-21）：编辑器选区可附加为 `文件:起止行` 片段，支持附件菜单与命令面板

> 剩余待开发项（含符号级选择、自定义快捷键、插件面板级 UI 等）统一见 [ROADMAP.md](./ROADMAP.md)。

#### Phase 3: 终端集成（完成）

- ✅ xterm.js + node-pty（Electron 44 验证可用，`asarUnpack` 保留原生二进制）
- ✅ 编辑器下方终端面板：显示/隐藏保留会话、重启、尺寸自适应
- ✅ 输出日志 `{workspace}/.pi-workbench/terminal-{id}.log`（按终端拆分、5MB 轮转）
- ✅ 终端输出一键附加为 Agent 上下文

#### Phase 4: 工作台插件系统（完成）

- ✅ 插件清单与主进程加载器（`electron/plugin-manager.ts`，CommonJS 入口）
- ✅ 命令 / 钩子贡献点（`workspace:opened`、`file:saved`、`chat:message`）
- ✅ 启用禁用（`config.json` 持久化）与热重载（目录监听 + 手动）
- ✅ 命令面板（Ctrl+Shift+P）：执行命令、传参、查看输出、管理插件
- ✅ Git 示例插件（`examples/plugins/git-tools`）

#### Phase 5: Fleet 任务系统（完成）

- ✅ Git worktree 创建 / 清理（`{workspace}/.pi-worktrees/`，分支保留）
- ✅ 任务队列与状态机（queued / running / succeeded / failed / cancelled，每个工作区默认并发 1，全局上限 4）
- ✅ 每任务独立 Agent 实例，流式输出写入任务记录与 `fleet-{id}.log`
- ✅ 元数据持久化：`{appDir}/data/fleet-tasks.db`（`node:sqlite`，JSON 回退）
- ✅ Fleet 面板：创建 / 取消 / 查看日志 / 查看改动 / 合并回工作区 / 清理 worktree

#### Phase 6: 优化和完善（持续）

- ✅ 2026-10-20 代码审查修复：编辑器初始化与自动保存、Web 模式终端降级与错误边界、API Key 配置后卡死、空文件打开、脏标签状态、文件监听批量事件、语言持久化、Fleet 崩溃恢复
- ✅ 新增渲染层测试（jsdom + React Testing Library）：编辑器创建、释放、自动保存与切换文件
- ✅ 2026-10-21 后端可靠性加固：原子写配置与 `.bak` 恢复、工作区信任边界统一、插件默认禁用与首次启用确认、终端剥离 API Key、单实例锁、未保存关窗确认、按工作区监听 / 终端 / Fleet 队列
- ✅ 2026-10-21 Agent / Fleet：硬超时与 abort 宽限、dispose 前中止、本轮消息判定、token 用量统计、Fleet queued 恢复与 UUID 任务 id
- ✅ 2026-10-21 Phase 6 功能：渲染进程日志、自动更新（electron-updater）、崩溃恢复草稿、Monaco 每文件 model（撤销栈隔离）、Web dev 桥按工作区 + SSE 流式
- ✅ 2026-10-21 工程：CI 增加 Windows 打包冒烟、新增 tag 发布工作流
- ✅ 2026-10-21 P3 体验收尾：Toast 动画与时长、快捷键文案、Monaco/xterm 主题改为读取 CSS token、应用内确认/输入对话框、自动保存设置、Fleet 详情刷新去重、插件重复 id 与配置写入保护、工作区打开/监听失败等交互细节
- ✅ 2026-10-21 性能与发布：Monaco 编辑器改为懒加载（首屏不再加载 4.4MB chunk）；Windows 发布只保留 NSIS 安装包，自动更新继续走 electron-updater
- ✅ 2026-10-21 设计系统 v1.12：线条角色化（控件 50% / 分隔 22% / 卡片发丝 18%），纸卡改为 `bg-raised` + 发丝边、取消区内投影，满墨外框与 `shadow-print` 只保留给浮层；新增对应守卫测试
- ✅ 2026-10-21 设计系统 v1.13：工作区区域分层（外壳/侧栏 panel、编辑器画布与激活标签 surface）；Monaco 背景改为 surface；拖拽接缝改为 2px `rule-seam`，修复 125% 缩放下两侧线宽不一致
- ✅ 2026-10-21 Agent 日志拆分：`AgentManager` 支持注入 `AgentLogger`，主进程与 Fleet 任务写入 `logs/agent.log`（5MB 轮转），`main.log` 不再混入 Agent 日志
- ✅ 2026-10-21 性能：聊天记录 / Diff / 文件树虚拟滚动（`@tanstack/react-virtual`），流式输出只重渲染最后一条；Monaco 大文件模式（>2MB 关闭换行折叠，>10MB 或 >200k 行只读）与提示条
- ✅ 2026-10-21 上下文片段：编辑器选区可附加为 `文件:起止行` 片段（附加时快照，≤40k 字符），支持附件菜单与命令面板「附加当前选区」，发送时块头标注行号范围
- ✅ 2026-10-21 渲染层测试：补齐 CommandPalette / FleetPanel / TerminalPanel 的 jsdom 行为测试（18 个用例，覆盖打开与过滤、命令执行、任务创建/取消/合并/清理、终端创建/重启/附加输出）
- ✅ 2026-10-21 多会话：会话标签栏与会话列表抽屉、同工作区多个 AgentSession 并行、模型生成会话标题（首轮后）、标签持久化（`.pi-workbench/chat-tabs.json`）、聊天状态按工作区+会话分桶；命令面板加入新建/列表/重命名/删除/关闭会话
- ✅ 2026-10-22 会话标签状态：运行中 accent 脉冲、错误 danger 图标（保留到下次发送/成功）、待操作 warning 靶心环（占位，暂无触发）、未读 success 实心点、已读无标记；草稿用标题旁铅笔；补充状态动效与 aria 文案
- ✅ 2026-10-22 流式渲染性能：增量按 50ms 窗口合并写入 store；流式 Markdown 按顶层块 memo 渲染，解析降为低优先级（`useDeferredValue`），流式期间关闭代码高亮；长输出不再阻塞会话切换 / 新建会话，结束后整体重渲染一次恢复完整 GFM 与高亮
- ✅ 2026-10-22 Agent 过程轨迹：thinking / text / tool 改为有序 parts；相邻过程组合并为默认收起的过程组，只有用户手动展开后才保持展开；工具步骤显示状态、耗时、参数与结果预览，write/edit 可打开对应 Diff；历史恢复保留思考与工具步骤；文本、思考、工具共用有序事件缓冲
- ✅ 2026-10-23 更新功能完善：修复“已是最新版本”误报，改为使用 `isUpdateAvailable`；启动 12 秒后静默检查、Windows/Linux 自动下载但绝不自动安装、下载完成弹窗（拒绝后下次启动再提示）；全局 `updaterStore`，状态栏显示版本号 / 更新提示 / 下载进度；安装包缓存改为 `{appDir}/cache`（自定义 AppAdapter）；macOS 数据目录改为 `~/Library/Application Support/pi-workbench`，更新只检查并引导手动下载；Windows 安装目录不可写时启动提示；版本号来自 `app.getVersion()`；命令面板加入“检查更新”；发布工作流扩展为 Windows/macOS/Linux 三平台并校验标签版本
- ✅ 2026-10-23 发布 v0.2.0 / v0.2.1 / v0.2.2：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage）；修复 GitHub 资产名中的空格被替换为点、导致 `latest.yml` 404 的问题（显式 `artifactName`）；“重启并安装”改为静默安装，避免第二次弹出安装向导
- ✅ 2026-10-23 AF-01 工具审批：`tool_call` 钩子按类别策略放行 / 询问 / 阻止；主进程 `ApprovalBroker` 挂起工具调用并处理超时（fail-closed）；聊天输入框上方渲染审批卡（允许一次 / 本会话 / 始终 / 拒绝并说明）；会话标签 `needsAction` 由审批触发；设置新增“权限”分页（读取 / 修改 / 命令 / 其他）
- ✅ 2026-10-23 AF-02 计划模式：输入区 Plan / Act 两段式切换；Plan 模式仅启用只读工具并在提示中注入计划指令，`tool_call` 钩子二次拦截写操作；助手给出计划后显示“执行计划”，切回 Act 并继续；计划提示块在历史恢复时剥离
- ✅ 2026-10-23 AF-06 通知：审批等待、长任务完成（≥15s）、会话失败在应用不在前台时发送桌面通知，点击定位到工作区与会话；设置新增通知总开关与分项开关（安静时段未实现）
- ✅ 2026-10-23 AF-04 队列与 steer：运行中输入框可用；消息可排队（本轮结束后自动发送）或插话（`streamingBehavior: 'steer'` 注入当前轮）；待发送消息卡片支持切换模式、删除与空闲时手动发送
- ✅ 2026-10-23 AF-05 上下文用量：输入区上方显示上下文占用条与 token 计数（80% warning / 95% danger）；支持二次确认后手动压缩上下文，运行中拒绝压缩
- ✅ 2026-10-23 AF-03 检查点：每轮前建立检查点并记录 write/edit 的旧内容（新文件标记为删除）；聊天头部检查点菜单支持恢复代码 / 对话 / 两者，保留最近 20 个；bash 副作用不在回退范围
- ✅ 大文件模式与虚滚动（2026-10-21：聊天 / Diff / 文件树虚拟滚动，>2MB 关闭换行折叠，>10MB 只读）
- 已完成：构建分包、生产 CSP、主进程测试覆盖

## 最近提交

详见 git 提交历史。

---

**更新时间**: 2026-10-23
