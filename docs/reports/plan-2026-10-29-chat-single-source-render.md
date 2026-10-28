# 落地方案：聊天渲染单一数据源（实时 == 重载）

- **状态**：待项目所有者确认（**未执行**，本文只有设计）
- **日期**：2026-10-29
- **动因**：需求 8（插话）暴露的根因不是"插话位置算错了"，而是**同一段历史有两套渲染逻辑**
- **依赖文档**：[ADR-003](docs/decisions/ADR-003-session-record-single-source.md)（会话记录是单一真相源）
- **不在范围**：Agent 协议、终端、Git 面板、托盘与更新；本方案不改 JSONL 格式

---

## 0. 问题陈述

ADR-003 已经规定「历史与导出的单一真相源是会话记录」，聊天面板历史、md / html 导出、会话摘要都由 `pi-bridge/src/session-entries.ts` 的 `activeTimeline()` 重建。

**但实时路径绕过了它**：

| 路径 | 数据来源 | 代码位置 |
|---|---|---|
| 重载 / 切换会话 | `activeTimeline()` → `buildSessionMessagesFromEntries()` | `pi-bridge/src/session-entries.ts` + `pi-bridge/src/session-history.ts` |
| 流式实时 | `onTrace` 事件直接写 `chatStore` 的 `parts` | `src/hooks/useChatPanelState.ts` → `createTraceBuffer` |

两套逻辑意味着**任何一处不一致都要在两边各修一遍**，而且只有"重载后"才会暴露。已经出现的症状：

1. 插话位置：实时在末尾、重载在中间 —— 2026-10-29 曾用 `liveTurns` 切段在 UI 层补偿，**随后按要求整体撤销**，因此该问题目前处于"已知未修"状态，等本方案根治（见 §7.3）
2. 压缩点位置：`createTraceBuffer` 的 `compaction_end` 追加到"当前流式消息"，`buildSessionMessagesFromEntries` 追加到"当前轮次"——两者在"轮次已 flush 但消息仍在流"的窗口内会错位
3. `context_edit`（被替换 / 被隐藏的历史）：只在重载路径生效，实时永远看不到替换结果
4. 字段级缺口（本轮实测，见 §4）：token / cost、轮次改动卡、计划卡、`custom` entry 在重载后消失

**目标**：让两条路径产出**同一份 `AgentMessage[]`**，实时只是"磁盘状态的一个乐观预览"，并在每轮结束时以磁盘为准自我校正。

---

## 1. 现状：两条路径的具体形状

### 1.1 重载路径（已有，正确的那条）

```
JSONL ──SessionManager.getBranch()──► activeTimeline()
        ├─ 沿 parentId 取回当前分支（废弃分支不出现）
        ├─ context_edit：同一 targetId 取最后一次，replacement === null 表示省略
        └─ compaction → { kind: 'compaction', entryId, timestamp, tokensBefore }
                    │
                    ▼
        buildSessionMessagesFromEntries(items, { thinkingDurations, toolFilePath })
        ├─ user    → flushTurn() 后 push 一条 user 消息
        ├─ assistant → 累积进当前 turn 的 parts（text / thinking / toolCall→running）
        ├─ toolResult → 按 toolCallId 更新对应 tool part 状态
        └─ compaction → 不 flush，追加进当前 turn 的 parts
                    │
                    ▼
              AgentMessage[]（role / content / parts / timestamp）
```

关键性质：**轮次边界 = user 消息**（`flushTurn()` 只在 user 前调用）。这正是插话会自然切段的原因。

### 1.2 实时路径（要替换的那条）

```
onTrace(event) ──► createTraceBuffer(50ms) ──► chatStore.*
   text_delta / thinking_delta  → appendTextPart / appendThinkingPart(key, turn.id, …)
   tool_start / tool_update / tool_end → startToolPart / updateToolPart / endToolPart
   compaction_end → appendCompactionPart（追加到当前消息）
   plan_submitted / plan_updated → appendPlanPart / applyPlanUpdate
   retry_start / retry_end → setRetryStatus
                    │
                    ▼
        chatStore.conversations[key].messages（直接是 UI 模型）
```

`turn.id` 由 `startStreamingMessage()` 生成，**跟 entry 没有任何对应关系**；`liveTurns` 是"一轮被插话切成多段"的补偿。

---

## 2. 目标架构

```
                    ┌────────────────────────────┐
JSONL  ────────────►│  entries（真相源，只增不删） │
                    └────────────────────────────┘
                                 │
   onTrace 事件 ──► 归一化成 entry（同样的形状）
                                 │
                                 ▼
                    deriveMessages(entries)   ← 唯一渲染函数
                    ├─ 全量：历史 / 重载 / 导出
                    └─ 增量：只重算尾轮（流式性能）
                                 │
                                 ▼
                        AgentMessage[] → UI
```

三条不变量（写进代码注释与测试）：

1. **UI 消息只能由 `deriveMessages()` 产出**，任何 `appendTextPart` 式的直接写 parts 都不再允许。
2. **同一组 entry，实时与重载必须产出逐字段相等的结果**（§9 的对账测试）。
3. **轮次边界只由 user / compaction 决定**，与流事件到达顺序无关。

### 2.1 类型草案

```ts
// pi-bridge/src/session-view.ts（新增，bridge 与渲染层共用同一实现）
export type ViewEntry =
  | { kind: 'user'; id: string; timestamp: number; text: string; images?: AgentImagePayload[] }
  | { kind: 'assistant'; id: string; timestamp: number; content: AssistantContentPart[] }
  | { kind: 'toolResult'; id: string; timestamp: number; toolCallId: string; toolName: string;
      isError?: boolean; durationMs?: number; content: unknown; details?: unknown }
  | { kind: 'compaction'; id: string; timestamp: number; tokensBefore?: number }

/** 历史 / 重载 / 导出：全量 */
export function deriveMessages(entries: ViewEntry[], ctx: DeriveContext): AgentMessage[]

/** 流式：只重算最后一轮（entries 为该轮的 entry 片段） */
export function deriveMessage(entries: ViewEntry[], ctx: DeriveContext): AgentMessage | null
```

`deriveMessages` 就是现在的 `buildSessionMessagesFromEntries`（先原地修改签名，再迁到 `session-view.ts`）；`deriveMessage` 是它的单轮形态——**同一个函数，两种调用粒度**，不做两份实现。

`ctx` 承载外部输入：`thinkingDurations`、`toolFilePath`、以及 §4 里补齐的 `usage` / `edits` 提取规则。

### 2.2 实时侧如何"归一化成 entry"

流事件 → entry 的映射规则（新增 `src/chat/liveEntries.ts`）：

| 流事件 | 落到哪个 entry | 具体动作 |
|---|---|---|
| 用户提交（含插话）| 新 `user` entry | 直接构造，`steerPending` 作为 UI 覆盖标记（不落盘） |
| `text_delta` / `thinking_delta` | 当前 `assistant` entry 的 `content` | 追加 / 合并到尾部同一 part（与 Pi 的 content 数组形态一致） |
| `tool_start` | 当前 `assistant` entry 的 `content` | 追加 `{ type: 'toolCall', id, name, arguments }` |
| `tool_end` | 新 `toolResult` entry | 与 JSONL 的 toolResult 同形（含 `isError` / `durationMs` / `details`，若事件里有） |
| `compaction_end` | 新 `compaction` entry | `{ entryId, timestamp, tokensBefore }` |
| `plan_submitted` | 侧挂（不进 entry） | 见 §4.3 |
| `retry_*` | 侧挂（状态条） | 不进 entry |

> 关键点：`tool_end` 生成**独立 entry**，而不是"回填到 tool part"，这样 `toolResult` 的匹配逻辑（按 `toolCallId`）与重载完全同一条代码。

---

## 3. 数据契约与容错

1. **未知 entry 类型**：`deriveMessages` 显式列白名单（`message` / `compaction` / `custom`），其余**忽略但计数**，并在开发模式下 `console.warn` 一次（避免以后升级 SDK 静默丢内容）。
2. **不丢历史**：`context_edit` 之后仍按 ADR-003 语义——`replacement === null` 从时间线移除，但原始 entry 仍在文件里。
3. **时间戳**：一律走 `entryTimestamp()`；缺失时用上一条 + 1，保证稳定排序（现在是 `Date.now()`，会让"同一条历史每次重载时间都变"）。
4. **part id 稳定性**：现在 `nextId()` 用自增序号（`text-1`、`text-2`），换一次渲染顺序就变。改为 `entry.id + ':' + 序号`（如 `a1b2:text:2`），保证 React key 与虚拟列表 itemKey 稳定。

---

## 4. 字段级差距（本轮实测）

用现网会话记录核对了一遍：`data/agent/sessions/2026-10-28T21-08-45-110Z_*.jsonl`，988 条 message entry，字段如下：

```
assistant : api, content, durationMs, model, provider, rawStopReason, responseId,
            role, stopReason, thinkingLevel, timestamp, usage
toolResult: content, details(部分), durationMs(部分), isError, role, timestamp,
            toolCallId, toolName
custom    : customType（如 web-search-results）, data
```

对照 UI 元素：

| UI 元素 | 实时来源 | 重载来源 | 结论 |
|---|---|---|---|
| 正文 / 思考 / 工具块 | 流事件 | `content[]` | ✅ 已一致 |
| 工具结果摘要 | `tool_end` | `content` + `details` | ✅ 已一致 |
| **token / 成本行** | `result.usage` | ❌ builder 未映射，**但 JSONL 里有 `usage`** | 补映射即可（低成本） |
| **轮次改动卡（diff 折叠）** | `result.edits`（`runtime.pendingEdits`） | ❌ 无 | 需从 `toolResult.details` 推导；推导不出就降级为"该轮有写入类工具"，并在设计文档写明 |
| **计划卡** | `plan_submitted` 事件 | ❌（在侧挂 extras） | 定为"侧挂状态"，不进 entries；重载后由 `session:getPlan` 取回 |
| **web 搜索结果** | `custom` entry（`web-search-results`） | ❌ 忽略 | 先保持忽略（现状），但列入白名单并写明 |
| 压缩点 | `compaction_end` | `activeTimeline` | ✅ 已一致 |
| 思考时长 | 实时计时 | `thinkingDurations`（extras） | ✅ 已一致 |
| 分支（R-03） | `refreshBranches()` | 同一 API | ✅ 已一致 |

> §4 的三处 ❌ 是本方案开始前必须收口的，否则"统一数据源"会**让实时功能退化成重载后的样子**（token 行消失、改动卡消失）——这是本方案最大的风险点，见 §10。

---

## 5. 分阶段实施

### 阶段 0：对账测试（先量化，不改行为）

- 新增 `tests/session-view-parity.test.ts`：
  - 夹具：一段真实形状的 entry 序列（含 user 插话、toolResult、compaction、context_edit、说明字段缺失的边界）
  - 断言：`deriveMessages(entries)` 与"当前实时路径重建出的 messages"逐字段相等
- 先把**已知不一致**写成 `it.fails(...)`（如压缩点错位、`context_edit`），让偏差可见、可追踪
- 产出：一份"当前不一致清单"，用于验证后续阶段是否真的修掉

### 阶段 1：把 builder 变成共用实现

- 新建 `pi-bridge/src/session-view.ts`：把 `buildSessionMessagesFromEntries` 迁过来，导出 `deriveMessages` / `deriveMessage`
- `session-history.ts` 保留为薄封装（导出、摘要等既有调用方不用改）
- 补 §4 的 `usage` 映射与 `part id` 稳定性
- 渲染层通过既有 IPC 拿到的仍是 `AgentMessage[]`，**这一步零行为变化**

### 阶段 2：实时落 entry

- 新增 `src/chat/liveEntries.ts`：`applyTraceEvent(entries, event) → entries`（纯函数，可单测）
- `useChatPanelState` 的 `traceBuffer` 改为"事件 → entry"，`chatStore` 只保留 `entries` + 由它推导的 `messages`
- `chatStore` 的 `appendTextPart / startToolPart / endToolPart / appendCompactionPart` **下线**（保留 `startStreamingMessage` 的等价能力：追加一条 assistant entry）
- `liveTurns` 补丁删除（切段由 `deriveMessages` 的 `flushTurn` 规则自然产生）

### 阶段 3：轮末以磁盘为准

- 每轮 `finally` 里调用一次 `piAgentAPI.getMessages(...)`（已有 API），用返回结果**替换**本轮的乐观 entries
- 这样即使实时侧漏了某个事件（丢帧、扩展自造事件），也会在轮末自愈
- 若替换后仍有差异，`console.warn` 出差异摘要（脚手架期保留，稳定后删）

### 阶段 4：性能

- 推导必须增量：流式期间只对"尾轮 entry 片段"调用 `deriveMessage`
- `messages` 引用要稳定：未被追加的轮次返回同一个对象（`deriveMessages` 内做 `Object.is` 复用），否则虚拟列表整屏重渲染
- 预算：2000 条 entry 全量推导 < 30ms（一次）；流式期间每次 flush（50ms）增量推导 < 3ms

### 阶段 5：清理

- 删除 `session-history.ts` 里重复的推导逻辑（如仍有）
- 删除 `liveTurns`、`finishAllStreaming` 里的"空段回收"特判（推导层天生不会产出空段）
- 在 `docs/design/DESIGN_SYSTEM.md` 里补一句"消息由单一推导函数产出"，避免以后又有人在组件里造 parts

---

## 6. 变更清单

**pi-bridge**
- 新增 `session-view.ts`（`deriveMessages` / `deriveMessage` / `ViewEntry`）
- `session-history.ts`：改为调用新模块
- `agent-manager.ts`：无需改协议；确认 `onTrace` 事件里可拿到 `toolResult` 的 `details` / `durationMs`（拿不到就退化为不完整，见 §4）

**渲染层**
- 新增 `src/chat/liveEntries.ts`（纯函数 + 单测）
- `src/store/chatStore.ts`：`messages` 改由 `entries` 推导；下线按 part 追加的 API
- `src/hooks/useChatPanelState.ts`：traceBuffer 改走 entry；删除 `liveTurns`；轮末 re-sync
- `src/components/ChatTranscript.tsx` / `ChatMessageRow.tsx`：预期不改（仍吃 `AgentMessage[]`）

**测试**
- 新增 `tests/session-view-parity.test.ts`、`tests/live-entries.test.ts`
- 更新 `tests/chat-store-steer.test.ts`（改为验证 entry 层）、`tests/renderer-components.test.tsx` 中依赖 store API 的用例

---

## 7. 兼容与迁移

1. **旧会话**：entry 形状不变，无需迁移；渲染结果应更接近导出结果（导出本来就走 `activeTimeline`）。
2. **分支切换**：`session:switchBranch` 之后重新拉 `getMessages`，与现在一致。
3. **插话（需求 8）**：**分段由推导规则自然产生，不再需要 UI 补偿**——OpenAI 官方 steer 语义本身就是"原响应 `incomplete(reason: steered)` + 新响应续写"，所以"一条 user entry 切开一条 assistant 轮"是协议行为。原 `liveTurns` / `steerPending` 补偿已撤销，本方案落地后实时与重载都会走同一条 `flushTurn()` 规则；若仍需"等待当前步骤结束"的提示，应作为 entry 上的临时 UI 标记（不落盘）在阶段 2 之外单独评估。
4. **重试 / 编辑重发**：仍走"新增 entry 分支"，`refreshBranches` 不变。
5. **导出 md / html**：继续用 `activeTimeline()`；阶段 1 之后与面板共用同一推导，导出与面板不再各修一遍。
6. **计划卡**：明确为侧挂状态（`session:getPlan`），不进 entries；设计文档注明"计划卡不参与历史重建"。
7. **`custom` entry**：白名单化 + 忽略，不实现渲染（未来要展示再说）。

---

## 8. 性能与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 全量推导随历史线性增长 | 长会话切换卡顿 | 增量推导 + 引用复用；阶段 4 有预算 |
| 实时归一化丢事件 | 表现为"少一段文字" | 轮末以磁盘为准（阶段 3）自愈 |
| `tool_end` 事件缺 `details` | 改动卡/结果摘要退化 | 阶段 1 先核事件载荷，缺就显式降级并在 UI 注明 |
| 推导规则变更影响导出 | 导出内容变化 | 对账测试覆盖导出路径 |
| 一次性替换 store API | 回归面大 | 阶段 2/3 之间用一个 `deriveLive` 开关，可回退到旧路径（保留一个版本后删除） |

**回退开关**：`config/settings.json` 加 `chat.renderPipeline: 'derived' | 'legacy'`（默认 `legacy`，阶段 3 验证后翻默认，再删 legacy）。

---

## 9. 验收标准

**必须全部满足才算完成**

1. `deriveMessages(entries)` 的结果与"实时路径产出"逐字段相等（同一夹具），包括：
   - parts 顺序与 id
   - 压缩点位置（落在发生它的那一轮里）
   - `context_edit` 替换 / 省略
   - tool part 的 status / isError / durationMs / resultPreview
   - `usage`（tokens / cost）
2. 插话：一条 user entry 出现在两条 assistant 轮之间，实时与重载位置一致
3. 2000 条 entry 全量推导 < 30ms；流式每次 flush 增量 < 3ms（`vitest` 里用 `performance.now()` 断言上限，留 3× 余量）
4. 现有 1013 个用例全绿；`type-check` / `lint` 通过
5. 手工验收（需要你在真机上过一遍）：
   - 长会话滚动不跳、不闪
   - 插话后立刻看到自己的消息在"中间"，且不出现空白的助手段
   - 关掉标签重开、切换分支、导出 md/html，内容与面板一致
   - token / 改动卡在重载后仍在

---

## 10. 最大的风险与前置条件

**前置条件**：§4 的「token 行、改动卡」必须在阶段 1 一并补齐。否则统一数据源之后，这两块会从"实时有、重载没有"变成"两边都没有"——用户感知是**功能倒退**。

若 `toolResult.details` 无法可靠推导出 `FileEdit[]`，则本方案需要调整范围：改动卡明确为运行期信息，重载后改为在 tool part 内联展示（`ToolResultViewer` 已有 diff 能力），并在设计文档与本文记录该取舍。

---

## 11. 不做的事

- 不改 JSONL 格式、不写新的持久化层
- 不引入第三方聊天框架（AI SDK / assistant-ui 只借鉴**模式**：`UIMessage.parts` 即持久化格式、`MessageRepository` 单一数据源）
- 不动 Agent 协议、不实现"真正打断当前步骤"的 steer（那是 SDK/模型能力）
- 不重写虚拟列表实现

---

## 12. 工作量与顺序

| 阶段 | 内容 | 估时 | 可独立交付 |
|---|---|---|---|
| 0 | 对账测试 + 不一致清单 | 0.5 天 | ✅ |
| 1 | 抽出 `session-view.ts`，补 usage / 稳定 id | 1 天 | ✅（零行为变化） |
| 2 | 实时落 entry，下线 parts 直写 | 1.5 天 | 需开关保护 |
| 3 | 轮末以磁盘为准 + 对账转绿 | 0.5 天 | ✅ |
| 4 | 增量推导与性能达标 | 1 天 | ✅ |
| 5 | 清理补丁与文档 | 0.5 天 | ✅ |
| — | **合计** | **约 5 天**（不含 §10 若需要改改动卡范围的额外工作） | |

建议按 **0 → 1 → 3（先让"轮末以磁盘为准"上线兜底）→ 2 → 4 → 5** 顺序，让收益尽早落地且始终可回退。

---

## 附录：为什么不是另外两条路

- **只做 UI 补偿（现状）**：`liveTurns` 能对齐插话，但压缩点、`context_edit`、字段缺口仍在，且下次加 part 类型还要再补一遍。
- **把插话编码进 assistant 消息的一个 part**：消息数量稳定，但要侵入 Pi 的 entry 形态与 md/html 导出，且与 provider 的"successor response"语义不一致，未来 SDK 自己记录 steer 位置时会冲突。

参考资料：
- ADR-003 会话记录单一真相源（本仓库）
- AI SDK `UIMessage`：UI 状态即持久化格式，parts 带 `state: streaming | done` — https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message
- assistant-ui Runtime architecture：`MessageRepository` 作为 message parts 单一数据源 — https://www.assistant-ui.com/docs/runtimes/concepts/architecture
- OpenAI Mid-turn steering：steer 打断后原响应 `incomplete(reason: "steered")`，服务端新建 successor response — https://developers.openai.com/api/docs/guides/steering
