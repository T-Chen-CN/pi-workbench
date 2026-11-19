# 云端 Agent 方案可行性复核（代码侧）

> **面向**：决定开工的人
> **什么时候读**：P0 开工前；对某条需求"能不能做"有疑问时
> **类型**：临时分析（用户审查后可删）

**日期**：2026-11-19
**对象**：[CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md) v2（F-01~F-55 / A-01~A-29 / D-01~D-20 / G1~G7）
**服务器侧**：已完成，见 [cloud-server-feasibility-2026-11-19](./cloud-server-feasibility-2026-11-19.md)

**结论**：**方案可实施**，7 个前置缺口里 6 个有确定做法，1 个（G7）需要把 worktree coordinator 暴露给新模块；v2 新增的三项大件（Web 管理面、单会话记忆、多端同步）都可行，但有 **3 处需求表述需要修正**、**1 条前提要写明**、**1 个设计点要提前定**（详见 §6）。工期复核 **15.5 人日仍成立**（±1.5）。

---

## 1. 复核方法

- 读代码：`pi-bridge/src/`（24 文件）、`electron/ipc/agent.ts`、`electron/ipc/api-config.ts`、`electron/workspace-store.ts`、`src/components/`（聊天渲染链）、SDK 类型与实现（`dist/core/`）。
- 跑验证：双 `AgentManager` 同进程 PoC（`cache/poc-dual-manager.mjs`）、Node 内置 `WebSocket` 检查、压缩/记忆钩子源码确认。
- 交叉核对：服务器实测数据（延迟、并发、内存）与需求里的容量假设。

---

## 2. 前置缺口 G1–G7：逐条核实

| # | 结论 | 证据 / 做法 | 风险 |
| --- | --- | --- | --- |
| **G1** 扩展注入 | ✅ 可做 | `agent-manager.ts:1494` 的 `extensionFactories` 是字面量数组，紧邻 `additionalExtensionPaths`；改成 `[...builtin, ...(config.extensionFactories ?? [])]` 即可。`DefaultResourceLoader` 已接受该字段 | 无 |
| **G2** 工具白名单 | ✅ 可做 | `tool-policy.ts:60 resolveModeTools(mode, registered)` 只在 `agent-manager.ts:670` 一处调用，入参是已注册工具名数组；加 `toolAllowlist` 后取交集即可。`setActiveToolsByName` 已在用，`readonly` 模式就是靠它把工具砍到只读集 | 无 |
| **G3** 工单权限档 | ✅ 可做，但需要新入口 | 权限在**会话诞生时**从 `getDefaultPermissionLevel()` 取一次（`agent-manager.ts:1456`），之后由 extras 持有。`createSession(root?)` 没有权限参数 → 需要加可选第二参数（同时承载 G5 的 `origin`），约 40 行 | 无 |
| **G4** 路径限制 | ✅ 已取消 | — | — |
| **G5** 工单会话隔离 | ⚠️ 可做，但**必须做** | `isSessionOfWorkspace`（`ipc/agent.ts:150`）对 worktree 绑定的会话返回 `true` → 工单会话（跑在 worktree 里）**会**出现在用户会话列表。`session-extras.ts` 的 `load()` 是逐字段白名单构造，加 `origin` 必须同时改 `load()` 与 `save()`（约 5 行），否则字段会被丢弃 | 漏改 `load()` 会导致过滤静默失效 |
| **G6** 崩溃恢复 | ✅ 新增逻辑 | 现有代码里没有云端工单状态，属新模块；只要工单状态机落盘（`tasks.json` + 原子写）就能在启动时判定僵尸工单 | 需要明确"重启后 `running` → `interrupted` 并向云端汇报一次"的幂等（只汇报一次） |
| **G7** 独立 worktree | ✅ 机制现成，需接线 | `getCoordinator(workspaceDir).bind(sessionId, 'new', base)` 已在 `ipc/agent.ts:157` 使用；绑定关系落 `.pi-workbench/session-git.json`。云端模块需要拿到 coordinator 实例（现有代码按 workspace 懒加载，可直接复用同一入口） | coordinator 与 `ipc/agent.ts` 的 workspace 生命周期耦合，抽 `agent-core` 时要一并处理 |

**新增验证（本次跑通）**：同一进程可并存两个 `AgentManager`（不同 `agentDir`）——

```
initialize A / B   → true / true，合计 68ms
会话 id 不同        → true
会话目录分别落到 A/agent/sessions、B/agent/sessions
dispose A 后 B 仍可用
```

这是"终端 device agent 与用户会话共用主进程"的前提，已验证成立。

---

## 3. v2 新增能力：可行性逐条

### 3.1 三条通道（客户端 / 设备）

| 项 | 结论 |
| --- | --- |
| 服务端接受 WS | 需要 `ws`（Node 的全局 `WebSocket` 只是客户端）。**这是全项目唯一新增运行时依赖** |
| 桌面端连 WS | **零依赖**：Node 24（Electron 44 内置）有全局 `WebSocket`，已在本机实测 `typeof WebSocket === 'function'` |
| 帧序列化 | `AgentTraceEvent` 全是可序列化对象（现有 IPC 就在传），无需改造 |
| 断线续传 | 服务端 outbox 是新代码；客户端 `lastAckSeq` 落盘可复用 `atomic-json.ts` |

### 3.2 Web 管理面

- 认证：`crypto.scrypt` 内置，不需要 bcrypt/argon2 包；cookie 手写即可。
- 静态页：由一个 `public/` 目录直出，不需要前端构建链（**不引入 Vite/React 到云端**）。
- ⚠️ **不能复用桌面端聊天组件**：`ChatMessageRow` 依赖 `chatStore` / `workspaceStore` / `WorkspaceScope` / `panelHost` / `diffStore` / `useRevertEdits`；`AgentMarkdown` 还依赖 `openFileInEditor` 与工作区路径解析。硬搬会把整个渲染层 + Electron API 拖进云端。
  → **需求要改**：D-19 改为「三端共用**事件帧**，渲染各自实现」；Web 用轻量只读渲染（markdown + 折叠工具块），不追求与桌面端像素一致。
  → 后续若想统一，P1 可抽 `src/markdown/` 纯展示层（无 store、无 IPC），成本另计。

### 3.3 单会话 + 长内容维护

| 项 | 结论 |
| --- | --- |
| 单会话 | 天然成立：云端只有一个 `AgentManager` 实例、一个 session |
| 自动压缩 | ✅ SDK 内置：`shouldCompact(contextTokens, contextWindow, compactionSettings)`（`core/agent-session.js:2477`），阈值来自 `SettingsManager.getCompactionSettings`；`agent-manager.ts:1389` 也有手动 `session.compact()` |
| ⚠️ "压缩前写记忆" | SDK **没有 pre-compaction 钩子**，只有 `compaction_start` / `compaction_end` 事件。但事件触发时旧消息还在 → 在 `compaction_start` 里读会话记录抽取记忆，效果等同。**需求表述改为"压缩发生时先落记忆"** |
| 记忆注入 | ✅ 现成挂点：`getWorktreeContext`（`agent-manager.ts:2228`）把上下文包进 `CONTEXT_BLOCK_START/END` 的隐藏块，恢复历史时由 `stripContextBlock` 剥离 → 记忆复用同一机制，只需把 hook 泛化成"每轮上下文提供者" |
| 记忆存储 | `node:sqlite` 在 Electron 44 已用（`electron/workspace-store.ts`）；但记忆条目量级小，建议 JSON + 索引（O-12），与云端 `atomic-json` 一致 |
| 知识库（P2） | 可做；检索先做关键词，向量留后 |
| 梦境（P1） | 纯后台任务，无技术障碍；注意与工单抢 CPU（2 vCPU），建议单次上限 + 每日 1 次 |

### 3.4 多端同步与恢复

- 服务端 `seq` + 快照 + 增量：新代码，难度低（outbox 本来就要 `seq`）。
- 客户端重连拉快照：桌面端已有 IPC 事件通道，加一个 `cloud:snapshot` 即可。
- 离线期汇报：云端在客户端重连时插入一条系统消息，落进会话 JSONL（顺带满足"可回溯"）。

### 3.5 配置轮换（F-13）——**需要修正**

`initialize()` 第一件事是 `await this.disposeAllRuntimes()`（`agent-manager.ts:589`），即**换配置会拆掉所有会话运行时**。F-13 写的"轮换对进行中的会话不中断"做不到。

**修正**：云端把配置轮换**排队到轮次边界**（当前轮 `done` / `cancelled` 后再 `initialize()`），并回报"新配置将在下一轮生效"。这样语义等价，且实现简单。

### 3.6 `wait_task` 与会话单线程——**已定：取消阻塞工具**

云端只有一个会话，阻塞式 `wait_task` 会让模型卡在工具调用里：用户消息排队、长工单每 30 s 空转烧 token。

**决定（2026-11-19）**：取消 `wait_task`（D-21），推进全靠**事件唤醒**——工单状态变化时服务端往会话投一条 `system` 级事件并触发一轮；工具白名单降为 6 个。停滞看门狗从 P0 拆出，见 BACKLOG `C-02`。

### 3.7 终端 device agent 的落点——**需求要补一条前提**

device agent 需要一个有 `fs` / `git` / `AgentManager` 的地方 → 只能跑在**终端 app 的主进程**（新增 `electron/cloud/` 模块，用独立的 `AgentManager` 实例 + 独立 `agentDir`）。

推论（必须写进需求）：**app 关闭 = 终端离线**，工单进 `queued` 等它回来。所以"离开电脑"的前提是**托盘常驻**（现有行为：主窗口 X 收托盘，不退出）。

---

## 4. 与服务器实测的交叉核对

| 需求假设 | 实测 | 判定 |
| --- | --- | --- |
| 8–10 并发会话 | 空进程 140 MB，空会话 ≈1 MB | ✅ 有余量；带历史会话需在联调时实测 |
| WS 长连接可靠 | 空闲 90 s 不断、20 并发 0 失败 | ✅ |
| 流式不缓冲 | SSE 帧间隔 200ms 原样到达 | ✅ |
| 端到端延迟可接受 | 往返 p50 54 ms | ✅ 汇报/审批交互无感 |
| 单进程一套模型配置 | `acquireProviderEnv(apiKey, provider)` 写进程环境变量（`agent-manager.ts:609`） | ⚠️ 单用户单实例刚好，多套配置需重建进程级环境（我们的单账号假设下没问题） |
| 崩溃自愈 | systemd `kill -9` 后 3s 起 | ✅ 配合 G6 的僵尸工单判定即可 |

---

## 5. 风险清单

| 级别 | 风险 | 处置 |
| --- | --- | --- |
| 🔴 | **单会话是单点**：会话 JSONL 损坏 / 模型 Key 失效 → 整个云端不可用 | 原子写 + 每日备份（F-54）；Key 轮换走排队机制 |
| 🟡 | Web 渲染不能复用桌面组件，需另写一套轻量实现 | 已计入工期；D-19 修正表述 |
| 🟡 | ~~`wait_task` 阻塞期间用户消息排队~~ | 已解决：取消阻塞工具，改事件唤醒（D-21） |
| 🟡 | 新增依赖 `ws`（服务端） | 需按 AGENTS 的"Ask first"确认 |
| 🟡 | worktree coordinator 与新模块的耦合 | 抽 `agent-core` 时一并暴露接口 |
| 🟢 | 2 vCPU 上"梦境 + 工单"抢 CPU | 单次上限 + 每日 1 次 + 无活跃工单才触发 |
| 🟢 | Electron 主进程承载 WS + 心跳定时器 | 两条件（客户端/设备）常在 2s 内重连，无压力 |

---

## 6. 需要改的需求表述（4 处）

| # | 位置 | 现在写的 | 应改为 |
| --- | --- | --- | --- |
| 1 | **D-19** | 三端共用"事件帧与渲染逻辑" | 三端共用**事件帧**；渲染各自实现（Web 轻量只读），P1 可再抽纯展示层 |
| 2 | **F-13** | 配置轮换"对进行中的会话不中断" | 轮换**排队到轮次边界**生效，回报"下一轮生效"（`initialize()` 会 `disposeAllRuntimes()`） |
| 3 | **F-37** | "压缩前把要点写进记忆" | "压缩发生时（`compaction_start`）先从会话记录抽取记忆"，SDK 无 pre-compaction 钩子 |
| 4 | **§3.4 / §4.10** | 未说明终端执行位置 | 补前提：device agent 跑在终端 app 主进程，**app 必须常驻（托盘）**，关闭即终端离线、工单排队 |

另需新增一条设计决策：~~`wait_task` 期间用户消息可打断~~ → 已定：不提供阻塞型工具（D-21）。

---

## 7. 工期复核

| 块 | 原估 | 复核 | 依据 |
| --- | --- | --- | --- |
| G1+G2 | 0.5 | 0.5 | 都是局部改动，有测试可依 |
| G3 | 0.5 | 0.5 | `createSession` 加参数 + extras 兼容 |
| G5+G6 | 0.5 | 0.7 | extras `load/save` 双改 + 僵尸判定幂等 |
| G7 | 0.5 | 0.5 | coordinator 现成，主要是接线 |
| 内核抽取 | 1 | 1 | 已验证零 Electron 依赖；难点是 coordinator 边界 |
| apps/cloud 骨架 | 2 | 2.5 | 现成零框架（`node:http` + `ws` + `scrypt`），但账号/会话/路由都要手写 |
| Web 管理面 | 2 | 2 | 独立轻量实现（不复用 React），页面不多 |
| 数据面双通道 | 2 | 2 | outbox/seq/ack/续传是明确工作量 |
| 云端会话 + 7 工具 + 状态机 | 2 | 2 | 幂等与状态机是主体 |
| 多端同步与恢复 | 1 | 1 | 快照 + 增量 + 离线汇报 |
| 终端 device agent | 1.5 | 1.5 | 独立 AgentManager 已验证可行 |
| 桌面端 UI | 1 | 1 | 状态栏 + 配对 + 配置页 |
| 串联验收 | 1 | 1 | A-01~A-29 |
| **合计** | **15.5** | **≈ 16.2** | 主要偏差在骨架（+0.5）与会话隔离（+0.2） |

**建议对外仍按 16 人日**（含缓冲），比"乐观 15.5"更现实。

---

## 8. 开工前建议先验证的 3 件小事（合计 ~1 小时）

1. **G1+G2 落地**（不是 PoC，是第一步真改动）：`extensionFactories` + `toolAllowlist`，跑 `npm test`。
2. **纯自定义工具集下的会话可用性**：把工具砍到只剩自定义 7 个，确认 `chat` 一轮能正常跑完（避免"砍掉 read 后模型缺基础能力"的意外，例如它想看目录）。
3. **`ws` 在 Node 24 上的最小回环**：服务端 `ws` + 客户端内置 `WebSocket` 互通，跑通 outbox `seq/ack` 骨架。

---

## 9. 未验证项（保持诚实）

| 项 | 状态 |
| --- | --- |
| 真实模型调用（云端） | ❌ 缺 Key；通路已验证（`api.deepseek.com` 401 = 可达） |
| 带历史的会话内存占用 | ⚠️ 只测过空会话；联调时补测（建议记录 10/30/50 轮后的 RSS） |
| Web 页面在移动浏览器 | 不在本期范围（D-11） |
| 多设备并发工单 | 逻辑上单设备并发 1、多设备并行；未压测 |
