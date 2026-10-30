# Agent 运行时

> **面向**：要改 Agent 集成、权限审批、计划模式、会话生命周期的人
> **什么时候读**：动 `pi-bridge/`、`electron/approval-broker.ts`、`agent:*` 频道之前
> **什么时候要改**：权限策略矩阵、审批流程、工具白名单、会话持久字段变化时

> Pi Agent 的集成方式、权限与审批（安全边界）、计划模式、会话生命周期、标题与压缩、导出、联网扩展。
> 流式事件与轨迹数据模型见 [AGENT_TRACE](../architecture/AGENT_TRACE.md)；会话记录的真相源见 [ADR-003](../decisions/ADR-003-session-record-single-source.md)。

## 1. 运行位置

- Agent **必须**运行在 Electron 主进程，与 `main.ts` 同进程，入口是 `pi-bridge/dist/index.js`（路径由 `app-paths.ts` 的 `getBridgeEntryUrl()` 解析）。
- ❌ 禁止另起子进程 / Worker / 本地 HTTP 服务承载 Agent。Vite 里的 `devAgentBridge` 只是**调试用替身**，仅在 `serve` 生效。
- `pi-coding-agent` 内置的 read / write / edit / bash 工具在主进程直接操作文件系统，不经过渲染层 IPC —— 这是设计决定，不是漏洞。应用自身（文件树、编辑器、终端）的文件操作仍必须走 IPC。

### 1.1 聊天附件怎么到 Agent

- 用户在输入区附加的文件**不限位置与格式**（桌面 / 其他盘 / 网络盘 / 可移动盘；文本 / PDF / Office / 压缩包 / 音视频）—— 因为附件**不传内容，只传路径**：`buildContextPrompt()` 把绝对路径 + 元信息（大小 / MIME / mtime / 是否在工作区外）写进 `<pi-workbench-context>` 块，Agent 需要时自己用 `read` / `grep` / `bash` 去读。
- 好处：不受上下文窗口、文本解码与二进制探测限制；会话记录不堆整文件内容；Agent 能用自己熟悉的方式跳读、分页、局部检索。
- 例外：**图片**必须走视觉通道（路径对视觉无用），由主进程读 base64 后随请求发送；**选区 / 划词引用**没有可交给 Agent 的文件语义，仍然内联快照（≤40k 字符）。
- 上限：单条消息 **10 个附件**（文件 + 图片合计，`MAX_ATTACHMENTS` / `MAX_IMAGE_COUNT` / `MAX_CHAT_IMAGES` 三处一致）；图片还有单张 10MB、合计 48MB base64 的旧上限。
- 文件路径丢读不到时不会阻断发送：由 Agent 的 `read` 工具报错，错误原文进入工具结果并本地化展示。
- 渲染层始终没有“传任意路径读内容”的能力：`fs:readFile` 仍只服务工作区与 `{appDir}/cache/`（见 [ipc-and-trust §5.1](ipc-and-trust.md)）。

## 2. 权限模型（安全边界，改这里等于改安全策略）

两级概念，**会话是权限的唯一权威**，全局只提供新会话的默认档（`DEFAULT_PERMISSION_LEVEL = 'ask'`）：

| 概念 | 取值 | 说明 |
| --- | --- | --- |
| `PermissionLevel` | `readonly` / `ask` / `auto` | 新会话默认档 |
| `SessionMode` | `readonly` / `plan` / `ask` / `auto` | 会话内可切换；`plan` 是工作方式，**不是更高的权限** |

工具按类别授权（`read` / `write` / `command` / `other`），矩阵在 `pi-bridge/src/approval-policy.ts`：

| 模式 | read | write | command | other |
| --- | --- | --- | --- | --- |
| `readonly` | allow | **deny** | **deny** | **deny** |
| `plan` | allow | **deny** | **deny** | **deny** |
| `ask` | allow | ask | ask | ask |
| `auto` | allow | allow | allow | allow |

- 只读用 `deny` 而不是 `ask`：让模型立刻收到明确拒绝，而不是挂在一个没人响应的审批上。
- `allow-always` 只把**该类别**加入当前会话的 `grants`，不跨会话；只在 `ask` 模式下产生授权。
- 会话权限（`mode` + `grants`）随会话落盘在 `data/agent/session-extras/<id>.json` 的 `permission` 字段：`null` 表示尚未固化，首次打开时从全局默认档（`DEFAULT_PERMISSION_LEVEL`）生成；之后以文件里的值为准，不再读全局默认。

## 3. 审批流程（fail-closed）

```
Pi tool_call 钩子 → AgentManager 归类 + 生成摘要 → ApprovalBroker（主进程持有 pending）
   → 渲染层 ApprovalCard（approvalStore）
   → agent:approval:respond → allow-once | allow-always | deny(reason ≤ 500 字)
```

硬规则：

- 超时 120 秒（`APPROVAL_TIMEOUT_MS`；broker 侧 clamp 在 1 秒 – 10 分钟之间），**超时即 deny**。
- 通道缺失、非法决策值（`sanitizeApprovalDecision` 返回 null）同样按 deny 处理。
- 拒绝理由回给模型：`The user denied this tool call: <reason>`；无理由时用固定文案。
- 请求结束（超时 / 取消 / 中止）由主进程通知渲染层移除卡片，避免留下僵尸审批卡。
- 审批只覆盖 **tool_call**；Agent 的文本、思考不受影响。

## 4. 计划模式

- 白名单（`pi-bridge/src/tool-policy.ts`）：`READ_ONLY_TOOLS = read, grep, find, ls, web_search, fetch_content, get_search_content, source_check`；`PLAN_ONLY_TOOLS = submit_plan`；`PLAN_MODE_TOOLS = 两者之和`。
- `ask` / `auto` 模式必须**排除** `submit_plan`；`resolveModeTools(mode, registered, platform)` 是唯一入口，结果只取决于模式、注册表和平台。
- 计划以结构化数据存在会话 extras 的 `plan` 字段（`submit_plan` 只允许调用一次），渲染层读 `agent:plan:get`。
- 平台约束：`powershell` 只在 win32 可用（`tool-policy.ts` 的 `WINDOWS_ONLY_TOOLS`）；Windows 上 `bash` 依赖 Git for Windows，PATH 由 `pi-bridge/src/environment.ts` 探测 `bash.exe` 后补入（`AgentManager` 只是调用方）。

## 5. 会话生命周期

- 同工作区可并行多个会话：每个会话独立 `AgentSession`，共享 `ModelRuntime` 与环境租约。
- 会话级持久状态在 `data/agent/session-extras/<id>.json`：`permission`（权限模式 + 授权类别）、`plan`（结构化计划）、`branchLeaves`（分支选中叶子，切回时恢复后续）、`title`、`thinkingDurations`。
- 频道（`agent` 域共 36 个，这里只列常用的；完整摘要见 [PROJECT_STRUCTURE §5](../architecture/PROJECT_STRUCTURE.md)）：
  - 生命周期：`agent:initialize` · `agent:dispose` · `agent:abort` · `agent:rewind`
  - 会话：`agent:sessions:list` · `agent:sessions:open` · `agent:sessions:create` · `agent:sessions:close` · `agent:sessions:rename` · `agent:sessions:delete` · `agent:sessions:getTabs` · `agent:sessions:setTabs` · `agent:sessions:meta:get` · `agent:sessions:meta:set` · `agent:session:settings` · `agent:session:stats` · `agent:session:setModel` · `agent:session:setPermission` · `agent:session:setThinking` · `agent:export-session`
  - 运行：`agent:chat` · `agent:steer` · `agent:stream`（推送）· `agent:session-title`（推送）· `agent:session-root-changed`（推送）· `agent:context:usage` · `agent:context:compact`
  - 计划与审批：`agent:plan:get` · `agent:plan:approve` · `agent:plan:reject` · `agent:approval:respond` · `agent:approval-request`（推送）· `agent:approval-resolved`（推送）
  - 分支与工具：`agent:branches:list` · `agent:branches:switch` · `agent:tool-result:meta` · `agent:tool-result:chunk` · `agent:tool-result:image` · `agent:tool-result:open` · `agent:models:capabilities` · `agent:prompt-resources`
  - 流式事件带 `workspaceDir + sessionId + requestId`。
- 会话标签与激活项落盘在 `{workspace}/.pi-workbench/chat-tabs.json`（见 [paths-and-storage](paths-and-storage.md)）。

**标题**（规则细节都踩过坑，改之前先读）：

- 首轮回复后由模型生成**一次**；记录里已有 `name` 或用户手动重命名后**不再自动改写**（`settledTitles` + `persistSessionTitle` 统一拦截）。
- sidecar `data/agent/session-extras/<id>.json` 的 `title` 只做备份与防重生成；记录里丢了会补写回 JSONL。
- 命名输入取「首条用户消息 + **最后一条**文本回复」，不用压缩后的 `session.messages`（首条 assistant 常只有 thinking / toolCall）；送模型前剔除「工作目录 / 已加载的规矩 / 工作树状态」这类环境段落。
- 要求模型只回 JSON `{"title": …}`，最多 512 token（推理型模型会把预算花在 reasoning 上）；空内容或复述用户原话判为不可用，最多重试 3 次。
- 结果不依赖运行时存活：关标签 / 切换工作树后在途结果直接写进会话文件。

**上下文压缩**：`compaction` 条目在时间线上是一个 `AgentTracePart`（`type: 'compaction'`），落在发生它的那一轮消息里，实时与重载后位置一致；文案只有「上下文已压缩 · 压缩前 N tokens」与「上下文已压缩」两档，不区分手动 / 自动。`agent:context:compact` 触发手动压缩，`agent:context:usage` 取用量。

**历史与导出**：唯一真相源是 JSONL entry 沿 `parentId` 的分支（`sessionManager.getBranch()`），由 `pi-bridge/src/session-entries.ts` 的 `activeTimeline()` 重建 —— 聊天面板历史、md / html 导出、会话摘要都走它，压缩前历史不丢失。`context_edit` 按最后一次替换生效（`replacement === null` 表示该条被省略，Pi 的溢出恢复就是这样隐藏失败尝试）。JSONL 导出是原文件直接拷贝。

## 6. 模型配置

- 写入 `{appDir}/data/agent/models.json`；API Key 通过环境变量 `$PI_WORKBENCH_API_KEY` 插值，**不落盘**（见 `pi-bridge/src/model-config.ts`）。
- 容量档位：64K / 128K / 256K / 1M，各自配套输出上限（8K / 8K / 16K / 16K），最终取 `min(配套值, catalog)` —— 只缩不放大，否则请求会被供应商拒绝。
- provider / apiUrl / apiKey / selectedModel 是**应用级全局配置**，所有工作区共用；❌ 禁止放进工作区配置（`.pi-workbench/config.json`）。

## 7. 内置联网能力

- `pi-web-access` 以固定版本随包分发（`package.json` 锁定，见 `THIRD_PARTY_NOTICES.md`），由 `AgentManager` 通过 `additionalExtensionPaths` 在**每次创建会话时无条件加载**。
- ❌ 不写入 `data/agent/settings.json` 的 `packages`、不经过 Pi 的 npm 包管理器、不进入 `.pi-workbench/plugins`、不提供启用 / 禁用开关。
- 配置链路：`config/web-search.json`（Key 用 safeStorage，`enc:`）→ 下发 `{appDir}/data/agent/web-search.json` 只写变量名 `$PI_WORKBENCH_WEB_SEARCH_KEY_<PROVIDER>` → 按 provider 注入环境变量。同一时刻只启用一家 provider，切换时保留已保存的 Key。
- 变量取值：`toolActivation: "eager"` / `toolExposure: "direct"`（工具常驻声明，激活集由会话模式白名单决定）。
- 敏感前缀 `PI_WORKBENCH_WEB_SEARCH_KEY` 必须**同时**出现在 `electron/terminal-manager.ts` 的 `SENSITIVE_ENV_PREFIXES` 与 `main.ts` 的 `envSanitizer` 里（否则会泄漏进终端子进程或日志）。
- 扩展按 cwd 缓存工厂；联网配置变化后 `AgentManager` 会再 `reload()` 一次以读到新配置。
- 联网工具归 `read` 类，只读与计划模式都可用。

## 8. 工作台插件（与 Agent 扩展无关）

- 插件只扩展 Pi Workbench 本身：`PluginApi = { workspaceDir, pluginDir, pluginId, registerCommand, on, log }`，事件为 `workspace:opened` / `file:saved` / `chat:message`。
- 加载位置：`{workspaceDir}/.pi-workbench/plugins/`，CommonJS 入口 `plugin.json.main`；启用白名单在 `config.json`（`pluginsConfigured: true` 时才把 `enabledPlugins` 当白名单）。
- ⚠️ 无沙箱、可访问 Node API；❌ 不接受 Pi SDK extensions / custom tools，也不从网络下载插件。
- 示例：`examples/plugins/git-tools`。
