# ADR-003 会话记录作为历史与导出的单一真相源

- **状态**: 已采纳（2026-10-28）
- **影响范围**: `pi-bridge/src/session-entries.ts`（新增）、`pi-bridge/src/session-history.ts`、`pi-bridge/src/session-export.ts`、`pi-bridge/src/agent-manager.ts`、`src/store/chatStore.ts`、`src/components/AgentTrace.tsx`、`src/components/ChatMessageRow.tsx`
- **相关文档**: [设计系统 6.14](../design/DESIGN_SYSTEM.md)、[STATUS 2026-10-28](../progress/STATUS.md)、[Backlog R-05 / R-10](../progress/BACKLOG.md)

## 背景

Pi 为一次会话保留两份数据：

- **会话记录**：`sessions/*.jsonl` 的全部 entry，只增不删；被放弃的分支（重新生成、编辑重发）也留档，通过 `parentId` 组成树，`getBranch()` 取当前分支的 root→leaf 路径。
- **模型上下文**：把 entry 投影成送给模型的消息数组，压缩后是裁剪版（`buildContextEntries` 从 `firstKeptEntryId` 起算）。

本项目此前把后者当成了历史来源：`sessionMessages()` 读 `runtime.session.messages`。由此产生三类缺陷：

1. **压缩前的历史消失**：重载会话只剩压缩后的消息，压缩点没有落点。
2. **压缩分隔线位置错**：实时侧把压缩提示当作 `system` 消息 `addMessage` 追加到数组末尾，而一轮回复在 store 里是持续生长的同一条 assistant 消息，后续 part 仍写回那条消息，于是分隔线永远停在轮末，多次压缩堆成一串。时间戳排序治不好（分隔线取当前时间，assistant 取本轮开始时间），因为问题在数据模型没有位置。
3. **md / html 导出不完整**：导出从同一份裁剪后的消息数组排版；只有 JSONL 走文件拷贝，天然完整。

## 决策

**历史与导出的唯一来源改为会话记录的 entry 链（`getBranch()`），压缩点成为一个带位置的时间线条目。**

| 事项 | 决定 |
| --- | --- |
| 时间线来源 | `pi-bridge/src/session-entries.ts` 的 `activeTimeline(sessionManager)`：沿 `getBranch()` 输出消息与压缩点，跳过 `session_info` / `model_change` / `thinking_level_change` / `custom` / `branch_summary` / `system` |
| `context_edit` | 收集路径上的编辑，同一目标取最后一次；`replacement === null` 表示该条被省略（Pi 的溢出恢复用它隐藏失败尝试），直接跳过 |
| 压缩点 | 新 part 类型 `{ type: 'compaction'; id; entryId?; timestamp; tokensBefore? }`，不含 `reason` |
| 实时落点 | `appendCompactionPart` 追加到正在流式输出的助手消息 `parts` 末尾，其次最后一条助手消息，都没有时新建只含分隔线的助手消息 |
| 事件通道 | 压缩点只由 `compaction_end` 产生（不用 `entry_appended` 另建）；`aborted` / `error` 的压缩不画；`entryId` 取 `getEntries()` 末尾未被消费的 `compaction`，用于重载后对齐 |
| 重载 | `buildSessionMessagesFromEntries()` 按时间线重建消息；压缩项不 flush 轮次，直接 push 为 part，与实时位置一致 |
| 导出 | md / html 同样遍历时间线，压缩点输出 `---` + 引用文案 / `<hr />` + `.compacted`；JSONL 仍原样拷贝 |
| 文案 | 只有「上下文已压缩 · 压缩前 N tokens」与「上下文已压缩」两档；不区分手动 / 自动 |

## 备选方案

- **在渲染层按时间戳排序**：不可行，压缩事件与轮次开始时间不可比，且多次压缩仍会堆在一处。
- **单独记录压缩事件列表再合并渲染**：需要两套排序与合并逻辑，重载后仍要从 JSONL 反推位置，等于把同一件事做两遍。
- **保留 `system` 消息但插入到正确下标**：位置信息在 store 里没有载体，任何"插入到第几条"的推断都会在下一轮流式输出时失效。
- **导出继续读模型上下文**：与"导出全量历史"的验收直接冲突。

## 后果

- 会话历史、导出、会话摘要三处口径统一；压缩前历史与压缩点位置在重载后保持正确。
- 时间线重建比读一份现成数组多一次 entry 遍历，只在打开会话 / 导出时发生，可接受。
- `getBranch()` 依赖 SDK 的 entry 结构（`type` / `parentId` / `context_edit` / `compaction`），升级 Pi SDK 时需复查 `session-entries.ts`。
- 会话列表标题与条数改为按完整时间线统计（此前按投影），数字会比压缩后看到的更多。
- 失败的压缩尝试、被替换的消息不会出现在历史与导出中，与模型实际看到的内容保持一致性以外的差异仅限"哪些被隐藏"这一层。
