# 项目状态

> **面向**：想知道"现在做到哪一步"的人与 agent
> **什么时候读**：每次开工前、阶段收尾时
> **什么时候要改**：每次发布或阶段收尾（只追加新状态，不改历史记录）

本文件汇总项目的进度和完成状态。

## 最新状态

**更新时间**: 2026-10-29

- 🟡 **0.7.4 发布中**（基线 `main` @ 0.7.3 发布后的 4 个提交：工作树依赖自动安装与复用（GIT-118）、零引用死代码清理、文档拆分，以及聊天体验 / 外链 / 剪贴板 / 编辑器外部刷新批次合入）
- ✅ **最新版本 0.7.3**（标签命中区整块可点 + 会话标题锁定）；完整记录见下方 Phase 6 的 2026-10-28 条目
- ✅ **Phase 0: MVP** — Electron 框架、文件管理、编辑器、Diff、国际化
- ✅ **便携式架构** — 所有应用数据自包含在应用目录内
- ✅ **Phase 1: Pi Agent 集成** — 真实 Agent 可用（模型拉取 / 对话 / 工具）
- ✅ **Phase 2: 工作区与对话体验** — 流式输出、修改审阅、上下文选择、多工作区标签
- ✅ **Phase 3: 终端集成** — xterm.js + node-pty，输出可附加给 Agent
- ✅ **Phase 4: 工作台插件系统** — 命令/钩子、启用禁用、热重载、命令面板
- ➖ **Phase 5: Fleet 后台任务（2026-10-24 移除）** — 原 worktree 隔离与任务队列已删除
- 🟡 **Phase 6: 优化与完善** — 持续（分包 / CSP / 测试已完成）

## 当前版本

- **版本**: 0.7.4
- **框架**: Electron 44 + React 19 + TypeScript
- **Agent**: `@earendil-works/pi-coding-agent` 1.3.0
- **状态**: Phase 6 持续优化

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

详细报告：[Phase 1 完成报告](../archive/PHASE-1-COMPLETE.md)

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

- ✅ 最近打开列表（JSON，`config/settings.json`；2026-10-26 已迁到 `data/workspaces.db`）
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

#### Phase 5: Fleet 任务系统（2026-10-24 移除）

- ➖ 已整体移除；旧版本遗留的 `.pi-worktrees` 与 `pi-fleet/*` 分支需手动清理。

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
- ✅ 2026-10-23 AF-07 消息操作：悬停可复制整条消息；最后一条回复支持重新生成，最后一条用户消息支持编辑后重发（回退到该消息再发送）；分支切换 UI 后续已在 R-03 实现
- ✅ 2026-10-23 AF-08 模型与思考控制：输入区上方可切换会话级模型与思考级别，切换写入 Pi 会话并随会话恢复；模型列表来自已拉取的 API 配置
- ✅ 2026-10-23 AF-09 文件引用：输出中的 `path[:line]` 可点击打开；`@` 触发工作区文件搜索并附加为上下文；支持拖入文件作为附件（图片附件后续已在 R-08 实现）
- ✅ 2026-10-23 AF-10 内联变更审阅：助手消息内显示本轮修改的文件卡，支持逐文件查看 Diff / 还原与全部还原；冲突与脏文件拒绝覆盖
- ✅ 2026-10-23 AF-11 错误与重试：自动重试事件转发到聊天（显示次数、等待与错误摘要）；错误条提供重新生成与打开设置入口
- ✅ 2026-10-23 AF-12 本轮任务：输入区上方折叠条显示最后一轮工具步骤的完成进度，可展开查看每条工具与参数
- ✅ 2026-10-23 E-01 符号级选择：附件菜单可从当前文件提取函数 / 类 / 接口 / 类型并按符号附加片段（TS/JS、Python、Go、Rust、JVM）
- ✅ 2026-10-23 E-06 工具实时输出：转发 `tool_execution_update`，工具执行中即可看到增量结果
- ✅ 2026-10-23 AF-13 会话管理：会话抽屉支持搜索、置顶、归档（默认隐藏）与导出 Markdown；置顶 / 归档存于 `.pi-workbench/sessions-meta.json`
- ✅ 2026-10-23 AF-14 斜杠命令：`/help`、`/plan`、`/act`、`/compact`、`/clear`、`/model <名称>` 在发送前执行，不写入对话
- ✅ 2026-10-23 AF-15 用量与预算：输入区上方显示会话累计 token / 费用；设置可配置美元预算，超出时提示
- ✅ 2026-10-23 AF-16 导航与滚动：离开底部显示“回到底部 / 新消息数”，`Alt+↓` 回底并恢复自动跟随
- ✅ 2026-10-23 AF-17 统一活动：顶栏活动数汇总运行中会话，可直接跳转（Fleet 已于 2026-10-24 移除，不再计入）
- ✅ 2026-10-23 AF-18 空状态建议：空会话提供解释项目 / 找未完成工作 / 运行测试三条起步建议
- ✅ 2026-10-23 E-02 自定义快捷键：命令面板与打开设置可改键，带冲突检测、Esc 取消与恢复默认
- ✅ 2026-10-23 E-07 历史 thinking 时长：sidecar 记录每段思考时长，历史恢复时显示
- ✅ 2026-10-23 E-08 历史工具行 Diff：sidecar 保存 write/edit 前后内容，历史工具行可查看 Diff
- ✅ 2026-10-23 E-04 工作区 SQLite：`data/workspaces.db` 记录打开时间与次数，最近工作区按数据库排序；不可用时回退 JSON
- ✅ 2026-10-23 E-05 Monaco 分包：仅保留 10 种实际使用的语言分词器，monaco chunk 减小约 8.6%；构建产物经 vite preview 验证编辑器可正常打开
- ✅ 2026-10-23 审批卡生命周期修复：主进程在超时、会话中止、会话关闭或工作区释放时发送 `agent:approval-resolved`，渲染层据此移除审批卡并清除待操作标记；中止请求会主动取消该会话的挂起审批。真实供应商界面验证：审批等待中点“停止”，卡片消失且文件未写入
- ✅ 2026-10-23 通知与文件树修复：Windows 开发版设置 `AppUserModelId` 后系统通知可用；通知对象保活并在点击时 restore / show / moveTop / focus（Windows 短暂置顶兜底），日志记录交付、跳过原因与点击后焦点结果；Agent 写盘后主动刷新文件树。真实界面验证：通知可弹出、点击回到应用、新文件出现在文件树
- ✅ 2026-10-23 方案收尾：v1 [ROADMAP.md](./ROADMAP.md) 归档，缩小范围或未实现的项目与平台验收转入 [BACKLOG.md](./BACKLOG.md)；CI 通过
- ✅ 2026-10-24 方案细化：R-04 采用结构化计划（计划卡只读、可批准 / 拒绝）；R-10 全量导出（Markdown / HTML 默认折叠过程、JSONL 导出原始文件）；R-20 图片等比内嵌并可点击预览、二进制结果外部打开；R-18 决定不做
- ✅ 2026-10-24 移除检查点：删除聊天头部检查点入口、检查点存储与回退 IPC；代码回退由 git 与单文件还原承担，消息重试 / 编辑与分支切换保持不变
- ✅ 2026-10-24 R-08 图片 / 截图附件：粘贴或拖入图片进入附件条（缩略图、可移除），限制 4 张 / 单张 5MB / PNG-JPEG-WebP-GIF；图片通过 `PromptOptions.images` 随消息发送，不混入文本上下文；纯文本模型的提示并入 R-06。type-check / lint / 422 用例 / build 通过
- ✅ 2026-10-24 R-02 排队消息跨重启：待发送消息按会话写入 `.pi-workbench/pending-messages.json`（原子写、结构清洗），工作区初始化时恢复，关闭标签 / 删除会话时移除。type-check / lint / 426 用例 / build 通过
- ✅ 2026-10-24 R-03 对话分支切换：同一用户消息的多次回复显示 `‹ n/m ›`，切换只移动 Pi 会话树叶子，sidecar 记录各分支停留位置，切回恢复完整后续；重新生成以当前分支的末条用户消息为准。type-check / lint / 433 用例 / build 通过
- ✅ 2026-10-24 R-20 工具结果全量查看器：工具行可打开完整结果（分段读取、虚拟化行视图、搜索、复制、图片内嵌与放大、多图切换、外部编辑器打开），只读且不重新注入上下文。type-check / lint / 437 用例 / build 通过
- ✅ 2026-10-24 R-10 会话导出三格式：Markdown / HTML 含正文、思考、工具参数与完整结果（默认收起），HTML 自带样式可离线打开；原始 JSONL 直接复制会话文件；会话抽屉提供格式菜单与系统保存对话框。type-check / lint / 441 用例 / build 通过
- ✅ 2026-10-24 R-05 自动压缩分隔线：转发 `compaction_start/end`，压缩完成后插入系统消息分隔线（原因与压缩前 tokens），并刷新上下文仪表。type-check / lint / 443 用例 / build 通过
- ✅ 2026-10-24 R-06 模型能力提示：models.json 写入全部可选模型并为已知模型附带能力元数据；选择器显示上下文 / 思考 / 图像能力，不可用模型标注禁用，不支持的思考级别禁用；不支持的模型阻止图像附件。type-check / lint / 445 用例 / build 通过
- ✅ 2026-10-24 R-09 `path:line` 跳转：点击输出中的 `src/a.ts:42` 打开文件后滚动并定位到第 42 行（首次打开与已打开标签均生效）。type-check / lint / 447 用例 / build 通过
- ✅ 2026-10-24 R-13 提示模板与技能：斜杠菜单与命令面板列出 Pi 模板（`/名称`）与技能（`/skill:名称`），按前缀过滤并可插入；读取前重新扫描文件，新增无需重启；执行仍经现有工具审批。type-check / lint / 450 用例 / build 通过
- ✅ 2026-10-24 R-15 空状态建议个性化：按工作区类型（Node / Python / Rust / Go）与最近打开的文件生成“解释文件 / 审查文件 / 运行测试 / 未完成工作”，最多三条，点击填入输入框。type-check / lint / 455 用例 / build 通过
- ✅ 2026-10-24 R-16 子 Agent 活动：工具事件携带 `parentToolCallId`，过程视图把嵌套调用缩进并标注“子 Agent”，保留原状态与耗时。type-check / lint / 458 用例 / build 通过
- ✅ 2026-10-24 R-19 重试倒计时：重试期间按本地时间每 250ms 刷新剩余秒数，`retry_end`（成功或失败）立即清除状态；BACKLOG 中 P1–P3 开发项至此全部完成。type-check / lint / 462 用例 / build 通过
- ✅ 2026-10-24 R-04 结构化计划：Plan 模式通过 `submit_plan` 产出只读计划卡（步骤 / 文件 / 风险），仅批准或拒绝；批准后切回 Act 并按步骤执行，`update_plan_step` 更新状态，“本轮任务”显示计划进度；计划存于 sidecar，压缩后仍保留。type-check / lint / 470 用例 / build 通过
- ✅ 2026-10-24 图片附件优化：长边 2048 预处理（小图不重编码、截图优先 PNG、照片 JPEG），单张 10MB / 20 张 / 请求 48MiB；设置中按模型勾选图片能力并写入 `models.json` input，未勾选时明确阻止；用户消息与历史恢复均显示图片缩略图并可点击放大。type-check / lint / 483 用例 / build 通过
- ✅ 2026-10-26 全面审查修复：会话 id 白名单与 sidecar 删除顺序（路径穿越）、删除会话取消挂起审批、DraftStore 启动容错、发布 CI 增加 type-check/lint、Vite/Vitest 配置纳入类型检查、删除 5 个死 IPC 与 10 组未用文案、移除无用依赖与死目录/类型、合并重复快捷键/大小/分类工具、终端标题显示真实 shell、设置保存串行化、首页会话命令明确报错、通知摘要压缩、CSP 收紧、文档同步。48 文件 500 用例全绿
- ✅ 2026-10-26 架构收口：历史工具 Diff 改为仅当前进程内存（不再写 sidecar）、最近工作区改为 SQLite 单存储并迁移旧 settings 列表、构建/CI 升到 Node 24 并升级 @types/node、拆分 agent-manager / 主进程 IPC / ChatPanel（主组件约 1040 行）、收敛虚拟列表/还原/路径/事件总线与 Markdown 解析器、开启渲染进程 sandbox。type-check / lint / 502 用例 / build 通过
- ✅ 2026-10-24 方案收尾：BACKLOG P1–P3 全部开发项经项目所有者手动验收通过（结构化计划、模板 / 技能审批、三格式导出、工具结果查看器、排队恢复、分支切换、压缩分隔线、行号跳转、个性化建议、子 Agent、重试倒计时、图片附件与消息内全窗口预览）；V-01 / V-02 平台验收与版本发布继续暂缓
- ✅ 2026-10-24 发布 v0.3.0：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附带 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`；同时修复快捷键测试依赖宿主平台、导致 macOS 构建失败的问题
- ✅ 2026-10-24 发布 v0.3.1：Windows 自动更新改为清单式删除——升级只替换程序文件，保留 `config` / `data` / `logs` / `cache`；卸载才清理数据目录。首个带该修复的版本仍需手动安装
- ✅ 2026-10-24 移除 Fleet 后台任务：删除界面、IPC、任务队列、worktree 管理与存储代码；当前构建不再包含 Fleet 模块，旧任务数据与 `pi-fleet/*` 分支保留在磁盘上待手动清理。type-check / lint / 470 用例 / build 通过
- ✅ 2026-10-24 会话模式成为权限主体：状态行「模式」段提供只读 / 计划 / 询问 / 完全四档，移除输入区 Plan / Act 切换；计划卡与兜底执行条改为拒绝 / 同意并执行 / 完全执行，批准时原子切换到目标模式；设置页只提供只读 / 询问 / 完全三个默认档；会话标签按模式配色并新增上下文环。设计系统 v1.24
- ✅ 2026-10-24 发布 v0.4.0：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含会话模式、移除 Fleet、统一发送 / 停止与队列设置
- ✅ 2026-10-25 关闭提醒：关闭项目（含后台工作区）与退出程序时，若有运行中的会话或等待中的审批，会先确认；终端不纳入提醒。type-check / lint / 478 用例 / build 通过
- ✅ 2026-10-26 面板折叠回归面板头：顶栏移除文件树 / 聊天开关，收起按钮分别放在文件树头部最右端与聊天头部最左端；收起后显示 26px 全高窄条，整条可点击、图标居中，收起 / 展开后焦点回到窄条与头部按钮。设计系统 v1.28
- ✅ 2026-10-26 工具可用性对齐会话模式：新增纯函数工具策略（只读 / 计划 / 执行三组），从全部已注册工具中按模式启用；执行模式补齐 grep / find / ls / update_plan_step，`submit_plan` 仅计划模式可用，powershell 仅 Windows 启用；模式矩阵与计划批准流程补充测试
- ✅ 2026-10-26 多工作区常驻视图与返回首页：每个打开的工作区各自保留一套常驻视图与编辑器 / Diff 状态，切换标签或返回首页只切换可见性，不卸载、不重置；新增首页视图与「返回首页 / 返回工作区」；编辑器标签写入 `.pi-workbench/editor-tabs.json`，重新打开工作区时恢复；工作区标签显示待操作 / 错误 / 运行中标记。设计系统 v1.29
- ✅ 2026-10-26 发布 v0.5.0：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含面板折叠回归面板头、工具可用性对齐会话模式、多工作区常驻视图与返回首页
- ✅ 2026-10-26 发布 v0.5.1：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含渲染进程 sandbox、SQLite 单一最近工作区存储、主进程 IPC 与 AgentManager 拆分、ChatPanel 拆分、工具 Diff 仅内存、会话删除加固与文件树排序
- ✅ 2026-10-26 发布 v0.5.2：Windows 更新缓存移至 `%LOCALAPPDATA%\Pi-Workbench-Update`（安装完成后清理）、安装器显式 `/D` 装回原目录；Pi SDK 目录与旧默认 userData 回收进安装目录，消除 `~/.pi`、`%APPDATA%\pi-workbench`、`%LOCALAPPDATA%\pi-workbench-updater` 等外部残留
- ✅ 2026-10-27 内置联网搜索：pi-web-access 0.45.0 随包分发，AgentManager 无条件加载；设置页新增「联网搜索」分区（十家 provider 单选、Key 加密保存在 `config/web-search.json`、智谱端点可选、切换保留旧 Key）；首页「开始使用」改为 API → 联网搜索 → 打开项目三步；只读与计划模式可使用联网工具；新增 `THIRD_PARTY_NOTICES.md` 与相关单测。type-check / lint / 597 用例 / build 通过
- ✅ 2026-10-27 发布 v0.6.0：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含会话 Git worktree（按轮次切换、共享复用与生命周期管理）、Git 面板全分支提交图重构（ref 分类着色、合并标记、列宽引导、并行提交详情）、GitHub OAuth 登录（PKCE + PAT 回退）与 PR/CI 状态、印章品牌标识与 TChen 签名（设计系统 v1.31）、内置联网搜索
- ✅ 2026-10-27 发布 v0.6.1：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含 GitHub Device Flow 登录（内置 OAuth client ID，替代 PKCE 手动贴码流程）与更新后 shell 缓存刷新（Windows 安装器 `SHChangeNotify` + 三平台启动兜底 `shell-refresh.ts`）
- ✅ 2026-10-27 启动页与窗口形变：窗口先以 420×260 小窗显示静态启动页，面板数据就绪后停留满 600ms 再 400ms 放大到 1200×800，遮罩 150ms 淡出；主题与语言随 URL 预置，暗色首帧不再闪纸色；启动期只渲染启动页，`WorkspaceView` 改为懒加载（xterm / Markdown 离开启动路径）；主进程把权限迁移、SQLite 播种与联网配置移到建窗之后。设计系统 v1.32
- ✅ 2026-10-27 发布 v0.6.2：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含启动页与单窗口形变（420×260 → 1 秒放大到 1200×800）、安装包瘦身与安装/卸载加固、Windows 差分更新恢复、Git 面板自动同步与会话 id 保留
- ✅ 2026-10-27 Agent 空闲超时：移除 10 分钟整轮 wall-clock 上限，改为“模型静默 120s”才判定卡死；工具执行、审批等待、`toolcall_delta` 与工具输出均计入心跳或挂起计时，长任务不再被误杀；用户主动停止与卡死收尾分离（仅后者重建运行时），`AgentChatOptions.timeoutMs` 删除。type-check / lint / 用例 / build 通过
- ✅ 2026-10-27 发布 v0.6.3：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含 Agent 空闲超时（工具执行 / 审批等待不计时，长任务不再被 10 分钟误杀）、会话 Git 面板清理幽灵 worktree 记录（目录已删的条目可遗忘，不可用的条目不再允许切换）
- ✅ 2026-10-28 面板拆分为独立窗口：文件树 / Git / 聊天 / 终端可右键或拖动拆成辅助窗口（与主窗口同一套无边框自绘外壳 + 34px 标题栏，窗口按钮按 `frameName` 寻址），关闭窗口即回位，原位保留占位不塌陷布局；面板以子文档 portal 渲染，共享同一份 store，终端 PTY 与 200KB 回放缓冲升到 `terminalStore`，展开目录与滚动位置随窗口带走；应用改由 `pw-app://` 协议加载以统一 origin；布局不持久化。拖出柄按主进程真实光标判定（`dropEffect` 不能作取消判据）。设计系统 v1.36，决策见 [ADR-001](../decisions/ADR-001-detachable-panels.md)
- ✅ 2026-10-28 发布 v0.6.4：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含按模型配置上下文窗口（64K / 128K / 256K / 1M 档位 + 图像能力表，`maxTokens` 随档位并受目录值钳制，旧 `availableModels` / `imageModels` 读取时迁移，会话运行中拒绝重建性质的保存）、窄侧栏提交列表两行网格与按实测宽度折叠 refs、Git 自动同步把 fetch 事件与 watcher 竞速解耦（新提交不再丢失 `reason: fetch`）、聊天栏变宽时编辑器列正确收缩（`min-w-0` + `overflow-hidden`，聊天栏宽度受容器与编辑器预留约束）
- ✅ 2026-10-28 聊天图片附件按 id 消费：提交时立即从输入框消费本轮图片（不再等流式结束才清空），流式期间新加的图片留给下一轮；排队消息携带自己的图片（内存态，按项目所有者要求移除 R-02 的 `pending-messages.json` 持久化与 `chat:pending:get/set` IPC）；运行中插话支持带图与纯图片（`agent:steer` 允许空文本 + 图片）；重试 / 编辑重发 / 计划执行不读取也不消费输入框附件；纯图片（无文本）可发送，纯图片会话直接写固定标题「图片对话 / Image chat」（Anthropic 端点补占位文本，避开空 text 块 400）。type-check / lint / 729 用例通过
- ✅ 2026-10-28 文件阅读视图：编辑器按类型分派阅读 / 源码两种形态，Markdown 与 HTML 默认渲染、可切回 Monaco；图片 / 视频 / 音频走只读协议 `pw-file://` 预览并提供系统打开；Markdown 支持块级就地编辑；PDF 改为 pdf.js 自绘（单一滚动容器 + canvas 虚拟化、适应宽度与 50%–400% 缩放、页码 / 翻页 / 键盘），不再依赖 Chromium 内置查看器；标签条按类型出图标并在右侧提供单一视图切换按钮。阅读视图与 Monaco 常驻只切显隐，切换实测 27ms。设计系统 v1.37
- ✅ 2026-10-28 发布 v0.7.0：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含文件阅读视图与 pdf.js PDF 阅读器、面板拆分独立窗口（`pw-app://` 外壳 + 无边框自绘标题栏 + 拖出拆分）、聊天图片附件按 id 消费（排队项与运行中插话可带图、纯图片允许发送）、Agent 自动压缩后不再误报「无响应」、两个自定义 scheme 特权改为一次注册（修复合并后 `pw-file` 丢失 `stream` / `standard` / `fetch` 特权导致的媒体拖动与 HTML 相对路径问题）
- ✅ 2026-10-28 发布 v0.7.1：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含聊天头部三层合两层（工作树切换并入头部为 24px chip、会话标签栏升为 34px 并与正文列连通、移除常态「就绪」状态、未命名会话按需加序号）、辅助窗口继承应用菜单（快捷键在拆分窗口可用）
- ✅ 2026-10-28 拆分窗口改为「主窗口彻底让位」：拆出的面板不再在原位置渲染占位卡（删 `PanelDetachedPlaceholder` 与 `PanelSlot` 的 `placeholder` 入参），侧栏 / 对话列 / 终端行连同 2px 接缝一起把空间让给编辑器，面板仍保持挂载（`hidden`）以维持 portal；files / git 都拆出时侧栏与 26px 导轨全部消失，只剩一个停靠时保留侧栏并把标签切到还在的一边；独立窗口标题改为工作区名（`basename`），删除 `focusPanelWindow` 与「定位到独立窗口 / 已分离」文案，回位只靠关窗。设计系统 v1.39，新增 `tests/workspace-panel-layout.test.tsx`。type-check / lint / 887 用例通过
- ✅ 2026-10-28 主窗口关闭改为收进托盘：`X` 不再退出进程，Agent 会话 / 终端 / 文件监听 / 更新定时器继续运行，真退出只走托盘菜单「退出」或系统级退出；收进托盘不拦未保存确认，真退出才拦；托盘图标 Windows / Linux 用彩色 `app-icon.ico`、macOS 用单色 π 模板图（`scripts/make-tray-icon.js` 由品牌图标生成 16 / 32 两档），菜单为系统原生菜单（显示主窗口 / 分隔线 / 退出，跟随应用语言）；Linux 降级为最小化到任务栏，Windows 首次收起用托盘气泡提示一次；辅助窗口完全不跟随主窗口隐藏 / 恢复；设置「通用」新增「关闭主窗口」开关（`config/settings.json` 的 `closeToTray`，默认收进托盘）。设计系统 v1.40，决策见 [ADR-002](../decisions/ADR-002-tray-resident-main-window.md)。新增 `tests/tray.test.ts` 与 `tests/close-to-tray-setting.test.tsx`。type-check / lint / 904 用例通过
- ✅ 2026-10-28 会话历史 / 导出改为以会话记录为单一真相源：新增 `pi-bridge/src/session-entries.ts`（`activeTimeline()` 沿 `getBranch()` 重建完整分支，应用 `context_edit` 替换与省略），聊天历史恢复、md / html 导出与会话摘要统一由它输出，压缩前的消息不再丢失；压缩点改为消息内的 `compaction` part（实时与重载后位置一致，落在发生它的那一轮），渲染为细线分隔条，文案统一为「上下文已压缩 · 压缩前 N tokens」并删除手动 / 自动措辞；`compaction_end` 补发 `entryId` / `timestamp` / `aborted` / `willRetry`，失败或取消的压缩不再画分隔线。设计系统 v1.41（新增 6.14），决策见 [ADR-003](../decisions/ADR-003-session-record-single-source.md)，新增 `tests/session-entries.test.ts` / `session-history.test.ts` / `session-export.test.ts` / `chat-store-compaction.test.ts` / `agent-trace-compaction.test.tsx`。type-check / lint / 937 用例通过
- ✅ 2026-10-28 聊天记录回底修复：用户主动发送（含重试 / 编辑重发 / 计划执行 / 运行中插话）无条件恢复跟随并贴到滚动容器真实底部，不再因为上滑看过历史就不回底；跟随判定抽成 `src/hooks/chatScroll.ts`（距底判定 / 按钮阈值 / 贴底），按真实 `scrollHeight` 贴底，消息列表之外的「思考中」与错误块高度也计入；贴底分两帧（`measure` 完成后再贴一次），容器尺寸从 0 恢复或变化时按 `ResizeObserver` 补一次贴底，隐藏期间（`clientHeight === 0`）不参与跟随判定也不写 `scrollTop`。新增 `tests/chat-scroll.test.ts` 及 3 个渲染层用例（上滑后发送、插话、容器无布局）。type-check / lint / 946 用例通过
- ✅ 2026-10-28 视图切换按钮离开文件标签条：改为浮在编辑器内容区右下角的 `OverlayButton`（28px、内缩 16px 让开滚动条、常态 `bg-raised/90` 半透明、hover / focus 实心），阅读与源码两种视图共用同一落点、切换不跳动；标签再多也不会把它挤出可视区（原位置在 `overflow-x-auto` 的标签条最右端，`ml-auto` 在溢出后被推走）；Markdown 阅读视图版心补 `pb-12` 避让，滚到底时最后一行不被压住。设计系统 v1.42（新增 6.15 与 5.11 `OverlayButton`），`tests/file-view.test.tsx` 新增 2 例（浮层落点与标签条解耦 / 两视图位置一致）。type-check / lint / 948 用例通过
- ✅ 2026-10-28 发布 v0.7.2：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版包含拆出面板后主窗口彻底让位（不再有占位卡与「定位 / 还原」按钮，独立窗口标题改为工作区名）、主窗口关闭收进托盘常驻（Agent / 终端 / 监听继续运行，真退出只走托盘菜单或系统级退出）、会话历史与 md / html 导出改为以会话记录（entry 链）为单一真相源（压缩点落回它发生的那一轮，压缩前内容不再丢失）、聊天记录回底（发送 / 重试 / 编辑重发 / 计划执行 / 运行中插话一律回底）、视图切换按钮改为内容区右下角浮层（标签再多也不会被挤出可视区）
- ✅ 2026-10-28 会话标题确定后不再改写：标题（模型生成或手动重命名）一经写入 `session_info` 即锁定，后续轮次、压缩后重开、切换工作树、重启应用都不再自动生成或覆盖；自动生成改从会话记录取输入（首条用户消息 + 最早带文本的回复），不再用压缩后的 `session.messages`，并跳过 thinking / toolCall 开头的首条 assistant（此前会静默放弃且不重试）；生成结果不依赖运行时存活（关标签 / 切换工作树后在途结果直接补写进会话文件），sidecar 新增 `title` 快照做防丢失与记录补写；`ensureRuntime` 并发合并，避免同一会话两个 `SessionManager` 互相看不见标题；回退标题与磁盘列表统一为记录行序首条用户消息。渲染层新增 `pinnedTitles` + 列表请求序号，晚到的 `sessions:list` 不再把已确定标题降级回收；`agent:session-title` / `agent:session-root-changed` 改为广播所有窗口（拆出的对话列不再漏事件）；同名重命名不再追加重复的 `session_info`，会话删除后不再被在途标题结果重新写回 sidecar；模型返回空内容（推理型模型会把 token 预算花在 reasoning 上，此前 `max_tokens: 64` 会被吃光）不算确定、最多重试 3 次，标题请求预算提到 512。命名输入再做去噪：取最后一条文本回复并剔除「工作目录 / 已加载的规矩 / 工作树状态」这类环境说明段落（模型会把其中的项目名当主题，实测「你是谁？」被命名成「DSH 编码智能体介绍」），要求模型只回 JSON `{"title": …}`，解析为空或复述用户原话的标题判为不可用并重试。设计系统 v1.45，新增 10 个桥接用例、7 个标题工具用例、1 个 sidecar 用例与 3 个 store 用例。type-check / lint / 971 用例通过
- ✅ 2026-10-28 标签命中区改为整块标签矩形：此前三个标签条（工作区 / 编辑器文件 / 聊天会话）都把点击挂在内层文字按钮上，34px 标签只有约 17px 可点、左侧 12px 内边距是死区，hover 矩形与实际响应区域不一致；`patterns.tsx` 新增 `Tab`（点击、内边距、hover、激活底色都在本体上，文字与标记层 `pointer-events-none`，关闭按钮 24px 命中区 + `data-tab-aux` 阻断冒泡，中键可关），内置 roving tabindex 与 ←/→/Home/End 自动激活；标签条隐藏横向滚动条改为滚轮横移 + 聚焦自动滚入视野。设计系统 v1.43（新增 4.5 命中区与 Tab 规范、禁止项、检查清单），新增 `tests/tab-hit-area.test.tsx`，`design-system.test.ts` 增加两条静态门槛
- ✅ 2026-10-28 发布 v0.7.3：三平台 CI 发布（Windows NSIS / macOS universal dmg / Linux AppImage），附 `latest*.yml` 与 blockmap；本版为 0.7.2 之后的修复版，包含标签命中区改为整块标签矩形（三条标签条统一 `Tab`、关闭命中区 24px、键盘导航）、会话标题一经确定不再被自动改写（含压缩后重开 / 切工作树 / 重启，sidecar `title` 快照防丢失，空返回不计确定最多重试 3 次）、标题输入改用去噪后的最后一条回复摘录并校验模型输出（env 说明段落不参与命名）。type-check / lint / 985 用例通过
- ✅ 2026-10-29 工作树依赖自动安装与复用（GIT-118）：新增 `electron/worktree-deps.ts` 按仓库根 lockfile 识别包管理器（pnpm / bun / yarn（v1 与 berry）/ npm / uv）并在链接工作树里后台 `spawn` 安装（串行（同时只跑一个）、10 分钟硬超时、输出只进日志与内存尾部）；安装结果按 `sha1(工作树自己的 lockfile)` 写进 `session-git.json` 的 `installedLockfileHash`，哈希未变且 `node_modules` / `.venv` 存在则复用不再安装；没有 lockfile 的仓库跳过（状态 `none`）。状态经新推送频道 `git:worktree-deps` 进入工作树 chip（安装中 / 已就绪 / 安装失败可重试），同时进入 Agent 上下文；手动触发走 `git:installWorktreeDeps`；删除 / 遗忘工作树与关闭工作区都会终止在跑的安装；自动安装可用设置项 `autoInstallWorktreeDeps` 关闭（默认开，安装会执行仓库脚本）。修掉了「工作树在仓库内部、Node 向上解析到主 checkout 的 `node_modules`」导致的静默依赖污染。新增 `tests/worktree-deps.test.ts`，扩充 `worktree-coordinator` / `worktree-chip` / `git-ipc` 用例。type-check / lint / 1045 用例通过
- ✅ 2026-10-29 GIT-118 复查修正：哈希改为取**工作树自己那份 lockfile**（无则回退仓库根）—— 原来用仓库根的哈希描述工作树里的安装，导致分支换 lockfile 时永不重装、两个不同分支的工作树共用一个哈希；依赖安装只在**绑定工作树时**触发（`ensureInstalled`），`statusFor` 改为纯读，修掉「光是枚举工作树就给所有工作树（含用户手工创建的、无会话绑定的）装一遍依赖」；安装改为串行，排队任务被取消时不再启动。新增 `statusFor` 只读 / 串行排队 / 排队取消 / 工作树自身 lockfile 变化重装 / 未绑定工作树不安装 五类用例
- ✅ 2026-10-29 聊天体验与链接批次合入 main（`pi/01a18458`）：代码框 / 消息 / 提交 SHA / 工具结果的复制改走主进程 `clipboard:writeText`（`copyText()` 三级回退：Electron 原生 → `navigator.clipboard` → textarea + `execCommand`，失败给 Toast 不再静默）；外链（https / http / mailto）统一由 `shell:openExternal` 交系统浏览器（`electron/external-links.ts` 白名单），对话与阅读视图的 Markdown 链接分三态（外链 / `#anchor` 本文档滚动 / 仓库文件交编辑器打开），不再使用 `target="_blank"`；新增划词「引用到对话」浮起按钮与输入区「引用当前文档」开关；内联变更卡默认收起；用户消息改纸卡批注、Agent 保持流动正文；面板级 `ErrorBoundary` 兜住 Monaco `Model is disposed!`（不再整窗白屏）；拖出面板增加 96 DIP 拖动距离判据（`aux:drag-begin`）；辅助窗口登记为受信任 IPC 来源（`trustIpcSender` / `untrustIpcSender`，子框架仍拒绝，频道增至 18 域 / 123 handler）；打开的文件跟随外部（Agent 直接写盘 / git 切分支）改动自动刷新，脏缓冲显示冲突提示条，监听过滤器不再吞 `.pi-workbench/worktrees/**`，`fs:watch` 允许受信任根的子目录（`resolveWatchableRoot`，只授予监听不授予写）。插话时序改动已按要求整体撤销，改由 [聊天渲染单一数据源](../architecture/chat-render-single-source.md)（设计稿，未实施）根治。设计系统 v1.47（新增 6.16），`ipc-and-trust` / `panels-and-windows` / ADR-001 同步新的 IPC 信任模型。type-check / lint / 1069 用例通过
- 已完成：构建分包、生产 CSP、主进程测试覆盖

## 最近提交

详见 git 提交历史。
