# Agent 过程轨迹（Thinking / Tool Trace）方案

> **状态**: 已实现（v1，2026-10-22）
> **日期**: 2026-10-22
> **范围**: `pi-bridge`、Electron IPC、Web dev 桥、`chatStore`、聊天渲染层、设计系统 v1.17
> **关联**: [设计系统](../design/DESIGN_SYSTEM.md)、[项目结构](./PROJECT_STRUCTURE.md)、[Agent 前端开发目标](../progress/AGENT_FRONTEND_BACKLOG.md)（审批、计划、检查点等后续项）

---

## 1. 背景

当前聊天界面只有一条 assistant 文本消息。实际运行中，模型的输出并不总是“一段思考 + 一段最终答案”，而是：

```text
thinking → text → tool call → tool result → thinking → text → tool call → …
```

现在的实现有三个问题：

1. **思考内容被丢弃**：`thinking_delta` 没有转发到渲染层，历史映射也只保留 `text` 块。
2. **工具执行不可见**：`tool_execution_start/end` 只被用于抓 write/edit 的快照，前端没有任何步骤展示。
3. **中间正文会消失**：流式期间所有 text delta 都追加进同一条 UI 消息，但结束时 `result.response` 只取最后一条 assistant 消息的文本，`finishStreamingMessage` 会把前面的正文覆盖掉。

结论：不能继续用“一个 thinking 字符串 + 一个 content 字符串”的模型，需要改成**有序的 message parts 时间线**。

## 2. 目标与非目标

### 目标

- 思考过程可展开查看，折叠标题实时反映当前状态，并在历史恢复后保留。
- 工具调用以步骤形式展示：工具名、目标/命令、状态、耗时、结果预览。
- thinking、text、tool 严格按发生顺序渲染；文本出现在中间时不会被工具步骤吞掉。
- 连续的过程步骤合并为一个可折叠的“过程组”，正文仍然在时间线中正常显示。
- 过程组始终默认收起；只有用户手动展开后才保持展开，不随输出阶段自动改变。
- 不破坏现有的流式性能优化（50ms 合并、块级 Markdown memo、低优先级解析）和会话切换体验。
- 全部改动遵循 `DESIGN_SYSTEM.md`，新增模式需先落地 v1.17 规范。

### 非目标（v1 不做）

- 不展示完整的工具原始结果（只做截断预览，完整内容仍保存在 Pi JSONL）。
- 不做工具结果的全屏查看器或独立 Diff 页（write/edit 复用现有 Diff 审阅入口）。
- 不做“把中间叙述也折叠进 work summary”的 Cline 式完成态摘要（已确认不做，所有正文始终按位置显示）。
- 不改动 Pi SDK 的会话存储格式。
- 不把完整 `write` 文件内容通过 IPC 发送。

## 3. 业界调研结论

| 方案 | 关键做法 |
| --- | --- |
| Vercel AI SDK 4.2+ | 消息从 `content/reasoning/toolInvocations` 改为有序 `message.parts`，按数组顺序渲染，专门解决多步 Agent 的交替输出 |
| Vercel AI Elements | `Reasoning` 单块可折叠，流式时展开、结束收起，触发器显示 “Thinking…” → “Thought for N seconds” |
| assistant-ui | `GroupedParts` 把**相邻**的 reasoning + tool-call 合并成一个 chain-of-thought 折叠组；text part 会打断分组，并在原位置渲染 |
| Cline | 工具按组渲染、可折叠；完成后的工具/思考/过渡叙述可折叠成 work summary，最终答案保持可见；工具行显示状态、目标与结果 |
| ChatGPT / Claude / Cursor | 统一采用 “Progress Steps”：答案上方的可折叠过程轨迹，默认收起；过程轨迹在完成后保留 |
| 社区反馈 | 用户反感“正在看思考时突然自动收起”和“完成后轨迹完全消失”；用户手动展开后不应再自动收起 |

本方案采用：**有序 parts + 相邻过程组合并 + 文本打断分组 + 过程组始终默认收起 + 手动展开优先 + 中间正文始终可见**。这里有意不采用 AI Elements 的“流式时自动展开”：用户已确认过程组从一开始就收起，通过标题行获取实时状态。

参考链接见文末。

## 4. 核心模型

### 4.1 数据模型

在 `pi-bridge` 和渲染层使用同一套语义（字段名保持一致，渲染层可扩展临时字段）：

```ts
type AgentTracePart =
  | {
      type: 'text'
      id: string
      text: string
    }
  | {
      type: 'thinking'
      id: string
      text: string
      /** 供应商脱敏，只显示占位说明 */
      redacted?: boolean
      /** 仅实时流式可得；历史恢复时通常没有 */
      durationMs?: number
    }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      toolName: string
      /** 已归一化的参数摘要，不包含大字段（如 write.content） */
      argsSummary: string
      status: 'running' | 'success' | 'error'
      isError?: boolean
      durationMs?: number
      /** 截断后的结果预览，不是完整结果 */
      resultPreview?: string
      /** write/edit 完成后的文件路径，用于打开 Diff */
      filePath?: string
    }
```

`AgentMessage` / `ChatMessage` 增加：

```ts
interface AgentMessage {
  role: 'user' | 'assistant'
  /** 由所有 text part 拼接出的兼容字段，用于复制、测试和旧逻辑 */
  content: string
  /** 新增：按发生顺序排列的过程与正文 */
  parts?: AgentTracePart[]
  timestamp: number
}
```

约束：

- `parts` 是渲染的唯一事实来源；`content` 只作为派生值保留，避免一次性破坏现有复制、测试和统计逻辑。
- 历史消息没有 `parts` 时，自动降级为一个 text part。
- part 的 `id` 在实时与历史之间必须稳定：text/thinking 用递增序号，tool 用 `toolCallId`。
- **绝不把完整 `write` 内容或完整工具输出放进 part**；参数摘要和结果预览都有限额（见 5.4）。

### 4.2 渲染分组（派生，不存储）

```ts
type RenderGroup =
  | { type: 'text'; part: AgentTracePart }
  | { type: 'work'; parts: AgentTracePart[] }
```

规则：

- 相邻的 `thinking` / `tool` part 合并为一个 `work` 组。
- 任意 `text` part 结束当前 `work` 组；后面的 thinking/tool 在新位置开启新组。
- `text` part 始终原位渲染，不进入折叠组。
- 一个用户轮次对应一条 assistant `ChatMessage`，里面可以包含多个 `work` 组和多段 text。

这样可以直接表达：

```text
[work: thinking] → 正文 1 → [work: tool, tool, thinking] → 正文 2
```

## 5. 桥接层与事件协议

### 5.1 现状

- `pi-bridge/src/agent-manager.ts` 的 `subscribeToToolEdits` 只处理 `text_delta`，并只在工具事件里抓 write/edit 快照。
- `electron/main.ts` 的 `agent:chat` 只转发 `agent:stream` 文本增量。
- `sessionMessages` 只保留 `part.type === 'text'`。
- `chat()` 的 `result.response` 只取最后一条 assistant 消息。
- Web dev 桥的 SSE 只有 `delta` 事件。

### 5.2 统一流式事件

为了严格保证 text / thinking / tool 的顺序，Electron 端使用**同一条 `agent:stream` 通道**，payload 增加 `type` 字段：

```ts
type AgentStreamPayload = {
  requestId?: string
  workspaceDir?: string
  sessionId?: string
} & (
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_start'
      toolCallId: string
      toolName: string
      argsSummary: string
      startedAt: number
    }
  | {
      type: 'tool_update'
      toolCallId: string
      resultPreview?: string
    }
  | {
      type: 'tool_end'
      toolCallId: string
      status: 'success' | 'error'
      durationMs?: number
      resultPreview?: string
      filePath?: string
    }
)
```

说明：

- 现有的 `delta` 字段继续保留在 `text_delta` 上，减少调用方改动；但新增事件必须带 `type`。
- 不再新增 `agent:thinking` 独立通道，避免两条通道在渲染层的回调顺序与发送顺序不一致。
- Web dev 桥的 SSE 使用 `event: trace` 承载同一份 payload；`event: done` 仍返回最终结果。文本增量可以继续用 `event: delta`，但为了顺序一致，建议统一成 `event: trace` + `type`。

### 5.3 事件来源

`AgentSession.subscribe` 已提供所需事件：

| SDK 事件 | 处理 |
| --- | --- |
| `message_update` + `text_delta` | 转发 `text_delta` |
| `message_update` + `thinking_delta` | 转发 `thinking_delta` |
| `message_update` + `thinking_end` | 若该 contentIndex 没收到过 delta（脱敏/只给完整内容），补发一次 `thinking_delta`（内容为 end 的 `content`），或标记 `redacted` |
| `tool_execution_start` | 转发 `tool_start`，同时保留现有 write/edit 快照逻辑 |
| `tool_execution_update` | 可选转发 `tool_update`（v1 可先不启用） |
| `tool_execution_end` | 转发 `tool_end`，附带 isError、durationMs、结果预览、write/edit 文件路径 |
| `turn_end` / `agent_end` | 若仍有 running 的工具 part，渲染层统一收尾为 error/未完成 |

事件顺序由 SDK 的 session 事件顺序保证；桥接层只做归一化，不重排。

### 5.4 参数与结果限额

- `write`：只发送 `{ path, bytes }`，绝不发送 `content`。
- `edit`：只发送 `{ path, editCount }`。
- `read` / `ls`：发送路径。
- `bash` / `powershell`：发送命令，截断到 1,000 字符。
- `grep` / `find`：发送 pattern、path/glob。
- 其他工具：发送工具名 + JSON 参数摘要，截断到 500 字符。
- `resultPreview`：最多 2,000 字符（bash 可优先取尾部），超出追加省略提示。
- 图片类工具结果只显示 `[图片]` 占位，不把 base64 内容发送到渲染层。
- `argsSummary` 和 `resultPreview` 都是**展示用字符串**，不参与回传给模型。

### 5.5 `chat()` 结果

- `result.response` 保留为“最后一条 assistant 文本”，用于兼容非流式调用和现有返回类型。
- **有 parts 时，`finishStreamingMessage` 不再用 `result.response` 覆盖已有 parts**；只标记流式结束。
- 没有 parts（非流式/Web 回退）时，仍按旧逻辑写入一条 text part。
- 错误与中止：保留已收到的 parts，错误继续显示在消息下方；running 的工具收尾为 error/未完成。

### 5.6 历史聚合

`sessionMessages` 从“每个 assistant 消息一条”改为“一个用户轮次一条 assistant 消息”：

1. 遇到 `role === 'user'`，开始新一轮。
2. 遍历 assistant 消息的 `content` 数组，按数组顺序转换为 thinking / text / tool part。
3. 遇到 `role === 'toolResult'`，按 `toolCallId` 找到 tool part，补齐 `status`、`isError`、`durationMs`、`resultPreview`、`filePath`。
4. 一轮结束后输出一条 assistant `AgentMessage`：
   - `content` = 所有 text part 拼接；
   - `parts` = 按顺序收集的全部 part；
   - `timestamp` = 该轮首条 assistant 消息的时间。
5. 没有 parts 的历史（旧数据）自动视作单个 text part。

`runtime.messageHistory` 继续保留用于 `getMessageHistory` 的兼容回退，但不再是历史真源；`getSessionMessages` 统一使用上面的聚合结果。

## 6. 渲染层与状态

### 6.1 `chatStore`

`ChatMessage` 增加 `parts?: AgentTracePart[]`，并新增/调整动作：

```ts
appendTextPart(key, messageId, delta)
appendThinkingPart(key, messageId, delta)
startToolPart(key, messageId, event)
updateToolPart(key, messageId, event)
endToolPart(key, messageId, event)
finishStreamingMessage(key, messageId, finalResponse?)
```

实现规则：

- `append*Part`：如果最后一个 part 同类型，直接追加 `text`；否则 push 新 part。
- `startToolPart`：push `status: 'running'` 的 tool part；`argsSummary` 已由桥接层生成。
- `update/endToolPart`：按 `toolCallId` 定位并更新，不改变数组顺序。
- thinking 的 `durationMs` 由渲染层计算：首个 `thinking_delta` 到达时记录起点，遇到下一个非 thinking 事件（text/tool）或流式结束时写入；历史恢复通常没有该值。
- `finishStreamingMessage`：
  - 有 parts：只设置 `isStreaming = false`，把所有仍为 running 的 tool part 标记为 `error`（未完成）。
  - 无 parts：创建单个 text part。
- `content` 始终由 text parts 重新计算，供复制/测试/旧组件使用。
- `setMessages` 接收历史时保留 `parts`；旧历史没有 parts 时生成 text part。

### 6.2 有序事件缓冲

现有 `createDeltaBuffer` 只处理文本；加入 thinking/tool 后，**不能用两个独立定时器**，否则 text 和 thinking 的 part 顺序可能与实际发生顺序不同。

改为一个通用的有序事件缓冲：

```ts
type BufferedTraceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start' | 'tool_update' | 'tool_end'; payload: ... }

createTraceBuffer(onFlush: (events: BufferedTraceEvent[]) => void, intervalMs = 50)
```

规则：

- 文本/思考增量在队列内合并相邻同类型项，减少渲染次数。
- tool 事件按到达顺序入队；flush 时按队列顺序依次 dispatch。
- 流式结束时立即 flush；错误/中止时同样 flush。
- 保持现有 50ms 窗口和 4,000 字符上限的收益。

### 6.3 UI 结构

新增 `src/components/AgentTrace.tsx`（扁平组件，符合项目结构约定）：

- `AgentParts`：遍历 parts，把相邻的 thinking/tool 组合成 `WorkGroup`，text 用现有的 `StreamingMarkdown` / `MarkdownBody`。
- `WorkGroup`：
  - 触发器：chevron + 标题 + 当前/汇总状态；
  - 内容：组内 thinking 与 tool 按顺序渲染；
  - 初始始终收起；只有用户手动展开后才保持展开，不随正文开始、轮次结束或后续步骤自动改变；
  - 折叠状态下标题必须继续显示实时状态（思考中 / 当前工具 / 失败摘要）。
- `ToolRow`：
  - 状态图标（spinner / Check / AlertCircle）+ 工具标签 + 目标 + 耗时；
  - 可展开的结果/参数预览（mono、限高、可滚动）；
  - write/edit 完成后提供“查看修改”入口，复用现有 Diff 审阅。

示意：

```text
[›] 过程 · 思考 8 秒 · 2 个工具        （已完成，默认收起）
正文 part 1（Markdown）
[›] 运行 bash…                         （进行中，默认收起，标题实时更新）
正文 part 2（Markdown）
```

用户点开某个过程组后：

```text
[⌄] 过程 · 思考 8 秒 · 2 个工具        （用户展开，保持展开）
  │ 思考：先检查测试脚本……
  │ ✓ read package.json            12ms
  │ ! bash npm test              失败
```

工具标签建议：

| 工具 | 标签 | 目标 | 结果预览 |
| --- | --- | --- | --- |
| `read` | 读取 | 文件路径 | 文件内容摘要 |
| `write` | 写入 | 文件路径 | 写入字节数 |
| `edit` | 修改 | 文件路径 | 修改处数 + “查看修改” |
| `bash` / `powershell` | 运行命令 | 命令 | 输出尾部 |
| `grep` | 搜索 | pattern + 路径/glob | 匹配摘要 |
| `find` | 查找文件 | pattern + 路径 | 文件列表摘要 |
| `ls` | 列出目录 | 路径 | 目录项摘要 |
| 其他 | 工具名 | 参数摘要 | 结果摘要 |

### 6.4 展开/收起规则

| 状态 | 行为 |
| --- | --- |
| 初始 / 新建过程组 | 始终收起，不因 thinking 或工具开始执行而自动展开 |
| 当前组正在 thinking | 保持收起，标题显示“思考中…”，状态点脉冲 |
| 当前组正在执行工具 | 保持收起，标题显示当前工具，例如“运行 bash…” |
| 该组之后出现 text | 不改变展开状态；正文按位置显示 |
| 文本后再次出现 thinking/tool | 新建过程组，默认收起；不会把新内容塞回上方的旧组 |
| 用户手动展开 | 保持展开，不因正文开始、后续工具或轮次结束而自动收起 |
| 用户手动收起 | 保持收起；标题继续显示当前/最终状态 |
| 一轮结束 | 不改变任何组的展开状态（默认仍为收起，用户展开的仍展开） |
| 历史恢复 | 全部收起，不自动播放动效 |

摘要文案（收起时始终可见）：

- 进行中：`思考中…` / `执行 read…` / `运行 bash…`
- 完成：`过程 · 思考 12 秒 · 3 个工具`；没有时长时显示 `过程 · 3 个步骤`
- 错误：`过程 · 1 个工具失败`（danger 文案，不只靠颜色）

## 7. 设计系统（v1.17）

在 `docs/design/DESIGN_SYSTEM.md` 新增“过程轨迹”条目，并在 `patterns.tsx` / `AgentTrace.tsx` 落地：

- **触发器**：`type-label`，`text-ink-muted`；chevron 14px；收起状态下也必须显示当前活动状态（思考中 / 当前工具 / 失败），运行中状态点为 `accent`，1.4s 脉冲（复用现有 `pulse`），`prefers-reduced-motion` 下关闭。
- **组内容**：左侧 `border-rule-hairline` 发丝线，`pl-3`（12px），与正文形成二级层次；不使用卡片、阴影或渐变。
- **思考文字**：`type-body`（13px/1.6）+ `text-ink-muted`，Markdown 渲染但关闭代码高亮；与正文的 `type-reading` 14px 区分。
- **工具行**：`type-label` + 状态图标（16/14px）；目标路径用 `type-data`；结果预览用 `bg-sunken` + `rule-hairline`，`type-data`，最大高度约 240px，内部滚动。
- **状态语义**：运行中 `accent` spinner、成功 `success` Check、失败 `danger` AlertCircle；必须有文字状态，不可只靠颜色。
- **无障碍**：触发器使用 `<button aria-expanded aria-controls>`；运行中的内容加 `aria-busy`；不使用 `aria-live` 播报每个增量。
- **动效**：只允许 chevron 旋转（120–200ms ease-out）和运行中脉冲；其余保持静态。
- 新增 i18n 键：`thinkingInProgress`、`thoughtProcess`、`traceSummary`、`toolRunning`、`toolSuccess`、`toolError`、`toolResultPreview`、`redactedThinking`、`viewChanges` 等，中英文同步。

## 8. 性能

- text + thinking 增量统一走有序事件缓冲，50ms 一次，避免每个 token 重渲染。
- 过程组默认收起，组内容不挂载 DOM；用户展开后才渲染 thinking / 工具详情。
- part 级 memo：只有当前活跃 part 会随增量重渲染；历史 parts 不重渲染。
- text part 继续使用现有的块级 Markdown memo + `useDeferredValue`；thinking 复用同一管线但关闭高亮。
- 工具结果只渲染截断预览，限制最大高度；完整结果不进入 DOM。
- 消息列表虚拟化保持不变；长过程轨迹不应导致会话切换、新建会话再次卡顿。
- 目标：长 thinking + 多工具调用时，点击标签切换仍能在 100ms 内响应；不出现“等输出结束才执行点击”的现象。

## 9. 测试计划

### `pi-bridge`

- thinking_delta 按顺序转发；`thinking_end` 无 delta 时补发/脱敏处理。
- tool_start/update/end 的字段与顺序；写文件参数不包含 content。
- 历史聚合：一个用户轮次 → 一条 assistant parts；toolCall 与 toolResult 正确配对；错误、耗时、文件路径。
- 中止/超时：running 工具收尾、已收到 parts 保留。

### IPC / Web dev 桥

- Electron `agent:stream` 统一事件按顺序到达；requestId / workspace / sessionId 路由正确。
- Web dev SSE `trace` 与 `done` 顺序、payload 一致性。

### `chatStore`

- 有序缓冲合并相邻增量但保持 tool 事件顺序。
- text → tool → text → thinking 的 parts 顺序正确。
- 工具状态更新/失败/未完成收尾。
- `finishStreamingMessage` 不再覆盖已有 parts。
- 历史 parts 恢复与旧历史降级。

### 渲染层

- thinking → text：过程组全程默认收起，标题从“思考中…”更新为完成摘要；正文正常显示。
- text → tool → text → thinking → text：正文原位显示，过程组在正确位置，不吞正文；文字后的新组仍默认收起。
- 用户手动展开/收起后状态保持，不随正文开始或轮次结束改变。
- 工具运行/成功/失败三种状态、耗时、结果预览、write/edit 查看修改。
- 历史恢复默认收起；ARIA 属性正确；脱敏 thinking 显示占位。
- 长 thinking 下标签切换/新建会话仍可响应。

### 门禁

- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build`
- Paper / Ink 截图，1024 / 1440 宽度检查

## 10. 实施顺序

1. **桥接层契约**：统一事件类型、thinking 转发、工具事件归一化、历史 parts 聚合；补 `agent-manager` 测试。
2. **IPC / Web 桥**：`electron/main.ts`、`preload.cts`、`src/types/electron.d.ts`、`src/api/piAgentAPI.ts`、`vite.config.ts`；补主进程/桥接测试。
3. **状态层**：`chatStore` parts、有序缓冲、完成/中止收尾；补 store 测试。
4. **渲染层**：`AgentTrace.tsx`、`ChatPanel` 接入、i18n、设计系统 v1.17；补渲染测试。
5. **验收**：全量门禁、Paper/Ink 截图、手动跑交替思考/工具/长输出场景。

建议拆成两个提交/PR：

- `feat(agent): expose ordered thinking and tool trace parts`
- `feat(chat): render agent work trace with collapsible tool steps`

## 11. 已确认决策与剩余风险

已确认：

1. **过程组始终默认收起**，包括 thinking 和工具执行期间；标题行实时显示当前状态。
2. **用户手动展开后保持展开**，不因正文开始、后续工具或轮次结束自动收起；用户再次手动收起则保持收起。
3. **中间正文不折叠**：所有 text part 始终按位置显示，不做 Cline 式 work summary。

剩余风险/待定项：

1. **工具结果深度**：v1 只展示预览；是否需要“在编辑器中打开完整结果”待定。
2. **脱敏 thinking**：部分供应商只返回加密签名，不展示原文，显示“该段思考已被供应商脱敏”。
3. **IPC 体积**：必须坚持参数/结果限额，尤其禁止发送 `write.content`。
4. **多会话并发**：事件带 `sessionId` / `requestId`，继续保持现有路由，不允许跨会话串流。
5. **新过程组的展开状态**：当前设计为每个组独立，用户新展开一个组不会自动展开后面新建的组；若后续希望“一次展开、全部跟随”，再增加偏好设置。

## 12. 验收标准

- 思考内容默认收起，折叠标题实时反映思考/工具状态；用户展开后保持展开，结束后仍可继续查看。
- 工具调用以步骤展示，运行中/成功/失败状态清晰，失败不只靠颜色。
- `thinking → text → tool → text` 的顺序与模型实际输出一致，中间正文不会消失或折叠。
- 历史恢复后的顺序、工具状态和摘要与实时一致（时长可缺失），所有过程组默认收起。
- 长 thinking + 多工具调用期间，会话切换、新建会话、输入框保持可响应。
- 未产生 thinking/工具的模型行为与现状一致。
- 类型检查、Lint、全部测试、构建通过；提供 Paper / Ink 截图。

## 13. 参考资料

- [AI SDK 4.2 migration — ordered message parts](https://ai-sdk.dev/docs/migration-guides/migration-guide-4-2)
- [Vercel AI Elements — Reasoning](https://elements.ai-sdk.dev/components/reasoning)
- [AI Elements Reasoning reference](https://github.com/vercel/ai-elements/blob/main/skills/ai-elements/references/reasoning.md)
- [assistant-ui — Chain of Thought / GroupedParts](https://www.assistant-ui.com/docs/guides/chain-of-thought)
- [assistant-ui — Reasoning](https://www.assistant-ui.com/elements/reasoning)
- [Cline PR #13315 — collapse completed work into a work summary](https://github.com/cline/cline/pull/13315)
- [Cline ToolGroupRenderer](https://github.com/cline/cline/blob/main/webview-ui/src/components/chat/chat-view/components/messages/ToolGroupRenderer.tsx)
- [Cline v3.15 Task Timeline](https://cline.bot/blog/cline-v3-15-unveiling-task-timeline-gemini-implicit-caching-new-community-docs)
- [TanStack AI chat architecture — ordered segments](https://github.com/TanStack/ai/blob/main/packages/ai/docs/chat-architecture.md)
- [Dreadnode TUI — inline tool rows and reasoning](https://docs.dreadnode.io/tui/conversation/)
- [AI UX Playground — Progress Steps](https://aiuxplayground.com/pattern/status-steps/)
- [Cursor forum — Keep thought process expanded](https://forum.cursor.com/t/keep-thought-process-expanded-when-agent-has-made-new-changes/164278)

> 验收步骤见 [Agent 过程轨迹测试方案](../guides/AGENT_TRACE_TESTING.md)。

## 14. 实现记录（v1）

- 桥接层：`AgentManager` 统一发出 `text_delta / thinking_delta / thinking_redacted / tool_start / tool_end`；历史按“用户轮次”聚合为一条带 `parts` 的 assistant 消息；`FileEdit` 增加 `toolCallId`。
- IPC / Web dev：`agent:stream` 承载统一事件；Web dev 桥使用 SSE `trace` 事件；渲染层通过 `AgentChatStreamHandlers` 接收。
- 状态层：`chatStore` 支持 text / thinking / tool parts、工具状态更新、未完成工具收尾；新增 `createTraceBuffer` 有序合并事件。
- 渲染层：`AgentTrace.tsx` 提供过程组与工具行；过程组默认收起、手动展开保持；`AgentMarkdown.tsx` 抽出可复用的 Markdown 渲染。
- 设计系统：更新至 v1.17，补充过程组、工具行、思考排版与无障碍规则。
- 验证：`type-check`、`lint`、`test`（32 个文件 / 307 用例）、`build` 均通过。

与方案一致的取舍：`tool_update` 在 v1 未启用（只处理 start/end 和最终结果预览）；工具行的“查看修改”只在当前 Diff 队列包含该工具调用时出现；thinking 时长仅实时流式可得，历史恢复时显示工具数量摘要。
