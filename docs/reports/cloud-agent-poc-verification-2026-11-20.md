# 云端 Agent V1/V2 PoC 实测报告

> **日期**：2026-11-20
> **对象**：[CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md) §4.0 的两个开工前置 PoC（V1 双实例并发、V2 压缩前历史）
> **性质**：临时报告（`docs/reports/`），结论已回填需求文档 §4.0 与 §3.6；本文件供审查，审查后可删
> **没有改任何产品代码**：脚本全部在 `cache/poc/`（`/cache/` 已 gitignore）

---

## 1. 结论

| 判定 | 结果 | 依据 |
| --- | --- | --- |
| **V1 双实例并发长回合** | **通过**（有一条必须接受的约束） | 两实例并发 30 轮 + 30 次压缩全部完成；唯一失败是被主动 abort 的那一轮；一实例 `dispose()` 不打断另一实例进行中的回合 |
| **V1 的 `process.env` 无串写** | **不通过，且不可能通过** | 82 个模型请求**全部**携带后 `initialize` 那个实例的 Key；跨实例共享 provider Key 是硬约束（文档 §3.1 已是这么写的） |
| **V1 内存 / 主线程** | 可接受，有新增数字 | 双实例峰值 RSS **160.5 MB**、heap **70.4 MB**；主线程最长停顿 **284 ms**（单实例基线 **154 ms**，见 §4.4） |
| **V2 压缩前完整历史** | **通过** | `session_before_compact` 每次都拿到完整 `branchEntries`（最多 26 条），第一次的用户消息在最后一次压缩时仍然可见 |
| 附带验证：事件唤醒 | **通过** | `sendCustomMessage({triggerTurn})` 空闲时起一轮（1 次模型请求）；流式中投递 → 本轮继续走完（再 +2 次请求），落盘是 `custom_message` 不是 `user` |
| 附带验证：工具守卫 | **通过** | `tool_call` 钩子 `block` 生效，拦截原因作为工具结果回到模型，回合继续 |

**一句话**：v3.2 里那条"云端单会话 + 事件唤醒 + 独立 `agentDir` 双实例"的架构假设**成立，可以开工**；代价是三个新发现的实现约束（§5），其中 `contextWindow` 只有四档、默认内置工具不含 `ls` 会让"按需给工具"的实现踩坑，必须在写 G2 之前知道。

---

## 2. 方法：为什么要先造一个 mock provider

`config/api-config.json` 里的 Key 是 `enc:` 前缀（Electron `safeStorage` 加密），普通 node 脚本解不开；同时 PoC 要跑 140+ 次模型请求、要精确控制"什么时候触发压缩"，真实 provider 既贵又不可复现。

所以先写了 **本地 OpenAI 兼容 mock provider**（`cache/poc/mock-openai.mjs`，约 120 行）：

- `POST /v1/chat/completions`，标准 SSE：`role` 帧 → `content` 分块帧 → `finish_reason` → **单独一帧 `usage`** → `[DONE]`；
- 行为确定性：请求里**带 `tools`** 且最后一条消息不是 `tool` → 返回 `tool_call`（默认 `ls {"path":"."}`）；否则返回文本（长度可配）；**不带 `tools`** 的请求（压缩摘要）永远返回文本；
- 记录每个请求的 `Authorization` 头、`model`、`lastRole`、`prompt_tokens` 估算和时间戳；
- 可跑在**子进程**里，这样事件循环卡顿能归因给 `AgentManager` 而不是 mock 自己。

协议细节按 `@earendil-works/pi-ai` 的 `openai-completions` 实现对齐（`api/openai-completions.js:562` 用 `client.chat.completions.create({ baseURL })`），因此**不需要新增 provider id**：现有 `writeModelsConfig`（`pi-bridge/src/model-config.ts`）把 `apiUrl` 指向本地端口即可跑通，`apiKey: "$PI_WORKBENCH_API_KEY"` 走环境变量。

脚本清单（`cache/poc/`，只存在于 PoC 期间，**现已删除**）：

| 文件 | 作用 |
| --- | --- |
| `mock-openai.mjs` | mock provider（可库用） |
| `mock-server.mjs` | 子进程外壳：`READY <port>` 报端口，stdin 打 `stats` 取统计 |
| `smoke.mjs` | 冒烟：单实例 1 轮，确认 `tool_call → tool 结果 → 文本` 闭环（2 次请求） |
| `v1-dual-concurrent.mjs` | V1：`MODE=dual`（双实例）/ `MODE=single`（对照组） |
| `v2-compaction-hook.mjs` | V2：SDK 直连 + `session_before_compact` 钩子 |
| `v3-v4-sdk-mechanisms.mjs` | 事件唤醒（V3）+ 工具守卫（V4） |

---

## 3. V1：双实例并发

### 3.1 装置

- 两个 `AgentManager`，**各自独立 `agentDir`**（`A` 先 `initialize`，`B` 后 `initialize`），Key 分别 `KEY-A` / `KEY-B`；
- 两个实例用**不同 model id**（`mock-a` / `mock-b`），让 mock 侧能证明"请求真的在交错"，而不是一边跑完另一边才跑；
- `settings.json` 写 `compaction: { enabled: true, reserveTokens: 127000, keepRecentTokens: 1000 }`（为什么这么写见 §5.1）；
- 每个实例 30 轮，每轮含 1 次工具调用；第 11 轮对 B 主动 `abort()`；第 12 轮**在 B 回合进行中**对 A 调 `dispose()`；然后 B 跑完剩余轮次。

### 3.2 结果

| 指标 | 双实例 | 单实例（对照组） |
| --- | --- | --- |
| 完成的轮次 | A 11（后主动 dispose）+ B 30 | B 30 |
| 失败轮次 | 1（主动 abort 的那轮） | 1（同上） |
| 压缩次数 | A 6 + B 24 | 24 |
| mock 请求数 | 140（其中 58 次是无 `tools` 的压缩摘要） | 107（47 次摘要） |
| 请求交错次数 | 59（80 次回合请求在两个 model id 间反复切换） | 0 |
| 单轮最长耗时 | A 583 ms / B 608 ms | 638 ms |
| 峰值 RSS / heap | **160.5 MB / 70.4 MB** | 156.6 MB / 67.1 MB |
| 主线程最长停顿 | **284 ms** | **154 ms** |
| 会话数（`listSessions`） | 各 2，目录互不相交 | 2 |
| 总耗时 | 15.6 s | 15.3 s |

**逐条对照 V1 的判定标准：**

1. **两个会话互不干扰 — 通过。** 84 次回合请求全部完成；B 在 A `dispose()` 的那一刻正在跑回合，`chat()` 仍返回 `success: true`（`disposeAMidTurnB.success = true`）；`abort(B)` 只让 B 那一轮返回 `Agent request was aborted.`，A 的下一轮照常。
2. **`process.env` 无串写 — 不通过（不可修）。** mock 记录的 140 个请求里，`Authorization` 头去重后只有 `KEY-B` 一个值：A 先 `initialize` 时环境变量是 `KEY-A`，B 一 `initialize` 就变成 `KEY-B`，此后**两个实例的所有请求都带 B 的 Key**。这不是 bug 而是 `environment.ts:24` 的模块级引用计数 + 单份 `process.env` 的必然结果。附带验证：`dispose(A)`（引用计数 2→1）不还原环境变量；`dispose(B)`（→0）把环境变量**精确还原**成进程原始值（`restoredToBaseline: true`，本机原本就有 `PI_WORKBENCH_API_KEY`，35 字符）。
   → **结论**：设备侧的本地会话与云端工单会话**必须共用同一个 provider Key**。这在文档里已经是硬约束（§3.1），本次只是从"读代码推断"变成"实测确认"。若将来真要两套 Key，唯一不落明文的办法是让工单 `agentDir` 的 `models.json` 用**另一个环境变量名**（`apiKey: "$CLOUD_AGENT_API_KEY"`），并在 `initialize` 前后自己 set/unset——不建议，因为引用计数为 0 时会被还原成"最后一个写的人"。
3. **30 轮后 RSS 可接受 — 通过。** 双实例峰值 160.5 MB，第二个实例相对单实例只多 **≈ 4 MB RSS / 3 MB heap**（会话上下文被压缩维持在 ~2.4k token 量级）。按"会话数 × 1 MB"这一档估算偏保守，实际是常数级的进程底座 + 小增量。

### 3.3 顺带确认的两件事

- **`initialize()` 会先开一个空壳会话**（`createSession` 之前 `listSessions` 已经是 1，之后是 2）。这正是 **G5 取消**的依据：工单会话用独立 `agentDir` 后，`data/cloud/agent/sessions/` 与 `data/agent/sessions/` 物理分开，用户列表天然看不到，不需要过滤逻辑。
- **`settings.json` / `models.json` 没有互相抖动**：两个 `agentDir` 各写各的，A 的 `models.json` 只声明 `mock-a`、B 只声明 `mock-b`，两边 30 轮都拿到了自己声明的模型（mock 侧 `model` 字段只有 `mock-a` / `mock-b`，无串号）。

### 3.4 事件循环停顿（新发现，需登记）

单实例基线就有 **154 ms** 最长停顿，双实例 **284 ms**。也就是说：

- 停顿**不是并发引入的**，`AgentManager` 单实例跑一轮就已经会让主线程卡 150 ms 级（同步写会话 JSONL / `fsync`、工具执行的同步部分）；
- 并发只是把峰值推到约 2 倍，**没有出现相乘级劣化**；
- 对云端派活的影响：工单会话跑在 device agent 同一进程里时，用户侧 UI 会出现 100–300 ms 级顿挫。P0 可接受（本地会话本身已经如此），但这是"工单在后台跑不影响用户操作"这句话的真实边界——**不影响正确性，只影响手感**。若要优化，方向是把会话 JSONL 追加改成异步（与 `cache/drafts` 同一思路），属独立议题，不在 P0。

---

## 4. V2：压缩前的完整历史

### 4.1 装置

用 SDK 直连（`ModelRuntime` + `SettingsManager` + `DefaultResourceLoader({ extensionFactories })` + `createAgentSession`），也就是"agent-core 成型后"的形态；`models.json` 形状与 `writeModelsConfig` 写出来的一致；扩展里挂 `session_before_compact` / `session_compact` / `session_compact_failed`，每轮检查 `branchEntries` 里还能不能找到第 1 轮的用户消息。

### 4.2 结果

| 指标 | 值 |
| --- | --- |
| 轮次 | 8（全部成功） |
| hook 触发次数 | 8 次 `session_before_compact` + 8 次 `session_compact`，0 次 failed |
| 最后一次 hook 的 `branchEntries` | **26 条** |
| 其中可见的轮次标记 | **8/8**（第 1 轮到第 8 轮都在） |
| 第 1 轮消息是否仍可见 | **是**（`keepsFirstTurn: true`） |
| 会话 JSONL 条目数 | 27 |
| `preparation.tokensBefore` | 1 696（首次）→ 4 736（末次） |

### 4.3 结论

`branchEntries` 是**完整分支历史**，不是"压缩后剩下的窗口"——压缩只在投影上打了注意力截断点，JSONL 与 `branchEntries` 不丢。所以：

- **F-38 的修正是对的**：云端记忆抽取（P1）可以只依赖压缩钩子，不需要另建"历史快照"通道；
- **P1 记忆抽取的成本可控**：一次钩子能拿到全量历史，不必每轮都抓；
- 注意 `preparation` 里我探测的 `cutIndex` 为 `undefined`（实际字段是 `tokensBefore` / `keepRecentTokens` 一类），P1 实现时以 `types.d.ts:601` 的事件定义为准，不要照抄本报告的探测字段。

### 4.4 为什么用 `reserveTokens: 127000` 而不是缩小 `contextWindow`

`models.json` 的 `contextWindow` 经 `normalizeContextWindow` 只接受 **64k / 128k / 256k / 1M** 四档（`pi-bridge/src/types.ts:22`、`model-config.ts:134`）。我第一版写 `4000`，被静默回落成 128 000，压缩阈值变成 126 500 token，30 轮里一次都没触发；改成 `reserveTokens: 127000` 后阈值降到 ~1 000 token，压缩每轮都触发。

→ 这是 **PoC 之外的真实约束**，见 §5.1。

---

## 5. 新发现的三个实现约束（v3.2 未覆盖）

### 5.1 `contextWindow` 只有四档，压缩阈值只能靠 `reserveTokens` 调

- `models.json` 里写非四档值会被**静默规范化**成 128k，不报错；
- `compaction.reserveTokens` / `keepRecentTokens` 在 `settings.json` 里是**自由数值**，没有档位约束；
- 影响：文档里"云端单会话按 128k 口径"的估算是唯一可用的；想让工单会话更早压缩（省 token / 省钱）只能改 `reserveTokens`，且这个值**是按 `agentDir` 的 `settings.json` 生效**的——`data/cloud/agent/settings.json` 可以单独写一套更激进的压缩参数，与用户会话互不影响。

**建议（已回填 §4.0）**：`data/cloud/agent/settings.json` 由 device agent 首次启动时写入 `{ compaction: { enabled: true, reserveTokens: <按额度定> } }`，并在配置同步里保留这一项不被覆盖。

### 5.2 默认内置工具只有 `read` / `bash` / `edit` / `write`

`createAgentSession` 不传 `tools` 时只启用这四个（`sdk.d.ts:44-47`）。`ls` / `grep` / `find` 需要显式列出。踩坑形态：模型调 `ls`，运行时返回的**不是报错中断，而是一条 `Tool ls not found` 的工具结果**（我在 V4 第一版就是这么失败的），模型会自己换路重试——多烧一轮 token，且看起来"能用"因此很难发现。

→ 影响 **G2**（`toolAllowlist`）：实现时必须明确"传 `tools` 即白名单，会**顶掉**默认四件套"，所以工单会话的工具集要写全（例如 `['read','ls','grep','find','edit','write','bash']`），不能只写"新增"的那几个。

### 5.3 `sendCustomMessage` 不返回 entryId

返回类型是 `Promise<void>`（`agent-session.d.ts:609-612`），落盘条目是 `CustomMessageEntry`（`type: 'custom_message'`，带 `customType` / `details` / `display`）。云端若要"事件已投递"的可观测回执，得**自己**在 `details` 里带 `eventId`，靠它去对账；拿不到 SDK 生成的 entry id。

→ 影响 §3.6 与工单状态机：事件去重/回执用自带的 `eventId`，不要依赖返回值。

---

## 6. 附带验证：事件唤醒与工具守卫

### 6.1 事件唤醒（V3）

| 场景 | 结果 |
| --- | --- |
| 空闲时 `sendCustomMessage({ customType: 'task-event', triggerTurn: true, deliverAs: 'followUp' })` | **起了 1 轮**（mock 请求 +1），`wokeUp: true` |
| 流式中（`session.isStreaming === true`）投递同一调用 | **不抛错**，本轮走完后继续（+2 次请求，`continuedAfterDelivery: true`）→ 证实 `agent.hasQueuedMessages()` 让边界继续成立 |
| 落盘形态 | 2 条 `custom_message`，`customType` 全为 `task-event`；`user` 条目仍只有真正的用户输入（1 条） |

**意义**：云端"工单事件唤醒设备侧 Agent"不需要自建队列、不需要伪造用户消息，也不会污染聊天记录的用户消息序列（多端同步不会把它当成"人说的话"）。

### 6.2 工具守卫（V4）

| 场景 | 结果 |
| --- | --- |
| `tool_call` 钩子对 `ls` 返回 `{ block: true, reason: 'V4-GUARD: ls 被守卫拦截' }` | 钩子触发 1 次；工具未执行 |
| 原因是否回到模型 | **是**，工具结果内容就是那句 reason |
| 回合是否继续 | **是**，之后还有 2 次 assistant 轮次（模型看到原因后继续） |

**意义**：G8 的"工作树外不可写 + 命令级拒绝清单"可以只用 `tool_call` 钩子实现，block 不会中断整轮，也不会静默失败。

---

## 7. 对需求文档的影响（已回填）

| 文档位置 | 改动 |
| --- | --- |
| §4.0 PoC 表 | V1 / V2 标记为**已执行 · 通过（2026-11-20）**，附判定数字与脚本位置 |
| §4.0 新增"实测新增约束" | §5.1（四档 `contextWindow` + `reserveTokens`）与 §5.2（默认工具集）进 G2 前置说明 |
| §3.6 SDK 一等因素材 | 事件唤醒 / 压缩钩子 / 工具 block 三条从"读代码"升级为"实测" |
| §3.1 环境变量 | 补"跨实例 Key 串写已实测：全部请求携带后初始化者的 Key" |
| §7 工期 | 不变（27.0 人日）；V1/V2 的 0.5 人日已花掉，实际是"开工前门槛已过" |

---

## 8. 未覆盖 / 残余风险

1. **真实 provider 未打**：mock 覆盖协议与并发，但不覆盖真实 provider 的限流、超时、SSE 抖动。工单会话在云端额度耗尽时的表现，仍要靠 O-06 的额度口径 + 实测。
2. **`ensureBashOnPath` 对 `process.env.PATH` 的改写未单独测**：两实例同进程、改写幂等（同一路径），本次没有观察到异常，但"PATH 被第二个实例改坏"这条风险只能算"未复现"，不是"已排除"。
3. **长会话真机内存未压**：本次压缩把上下文维持在 2.4k token，峰值 160 MB 属于"短上下文"档。若关掉压缩跑满 128k，内存与停顿都要重测（与 P4 的压测合并做）。
4. **主线程 154 ms 基线停顿的成因未定位**：只测到"单实例就有"，没做 CPU profile。如果是会话 JSONL 同步写 + `fsync`，改异步能显著改善，但那是独立议题。
5. **多客户端并发输入**：本次只验证"单会话内事件可排队"，没验证"两个客户端同时发用户消息"的归属语义（文档里仍未定的口径）。

---

## 9. 复现（脚本已删除）

PoC 脚本执行完即行删除：不进版本库，也不留在 `cache/` 里当“需要维护的资产”。结论与逐项数据已固化在本报告与需求文档 §4.0 / §3.6 / §3.1，**重跑不是必要条件**。

若将来确实要复跑（例如量化「异步写会话 JSONL」的收益，或换 provider 后回归并发行为），按 §2 的装置描述重建，总量约 300 行：

1. **mock provider**：`POST /v1/chat/completions`，SSE 顺序为 `role` → `content` / `tool_calls` 分块 → `finish_reason` → 单独一帧 `usage` → `[DONE]`。规则：带 `tools` 且末条消息不是 `tool` → 回工具调用；不带 `tools`（压缩摘要）→ 永远回文本。
2. **V1**：两个 `AgentManager` 各自 `initialize({ agentDir, apiConfig })`，用不同 model id 区分实例；`Promise.all` 各跑 30 轮；中途 `abort` 与 `dispose` 交叉；用 `setInterval` 量 `Date.now()` 漂移与 `process.memoryUsage()`。
3. **V2**：`ModelRuntime.create` + `SettingsManager.create` + `DefaultResourceLoader({ extensionFactories })` + `createAgentSession`；扩展里挂 `session_before_compact`，检查 `branchEntries` 里是否还有早期轮次。
4. **压缩触发**：只能靠 `settings.json` 的 `compaction.reserveTokens`（`models.json` 的 `contextWindow` 只有四档，见 §4.4）。

依赖：`pi-bridge/dist` 已构建（`npm run build:bridge`）；`PI_WORKBENCH_API_KEY` 由脚本自己设，不需要真实 Key。
