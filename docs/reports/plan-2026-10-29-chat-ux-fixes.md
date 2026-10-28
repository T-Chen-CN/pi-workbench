# 落地方案：聊天体验与链接修复（10 项）

- **状态**：**已实现**（2026-10-29，分支 `pi/01a18458`，10 项全部落地；`type-check` / `lint` / `test` 全绿）
- **日期**：2026-10-29
- **范围**：会话复制按钮、内联变更卡折叠、链接失效、划词引用、引用当前文档、前端崩溃、面板拖出判定、插话时序与位置、用户/Agent 消息视觉分层、打开的文件跟随外部改动刷新
- **不在范围**：Agent 侧协议、会话存储格式、终端、Git 面板、托盘与更新

> 实现账在 §16；根因分析保留在 §1–§10。原“待拍板”清单已按默认选择执行，剩余取舍集中到 §14，改一句话就能改。

---

## 0. 结论速览

| # | 需求 | 根因（已确认） | 实现 | 状态 |
|---|---|---|---|---|
| 1 | 代码框复制按钮失效 | 打包后跑在 `pw-app://`，Chromium 不认其为可信来源，`navigator.clipboard.writeText()` 直接 reject | preload 原生剪贴板 + `copyText()` 三级回退，5 处调用点统一 | ✅ |
| 2 | 变更卡列出全部文件 | `TurnEditSummary` 无条件 `edits.map()`，没有展开状态 | 默认收起的折叠行（`aria-expanded`） | ✅ |
| 3 | 链接点不动 | 主窗口 `setWindowOpenHandler` 只放行 `about:blank` + `pi-panel:`，`<a target="_blank">` 被静默 deny | `shell:openExternal` + 渲染层链接三态接管 | ✅ |
| 4 | 无划词引用 | 只有 Monaco 选区，聊天与阅读视图没有选区捕获 | `SelectionQuoteButton` + 引用附件 | ✅ |
| 5 | 无“引用当前文档” | 输入框工具栏只有回形针；`ConversationState` 无对应字段 | store 布尔开关 + 工具栏开关按钮 + 提交注入 | ✅ |
| 6 | 前端崩溃 | `Model is disposed!`；顶层单一 ErrorBoundary 把整窗换成错误页 | Monaco `isDisposed` 守卫 + 面板级错误边界 | ✅ |
| 7 | 抓手拖不远不拆窗 | 拆窗判据只有“光标是否在窗口外” | 增加拖动距离判据（96 DIP） | ✅ |
| 8 | 插话慢、且永远落在会话末尾 | 渲染层一次提交只建一条助手消息；SDK 只在“下一步 LLM 调用前”注入 | 曾按“轮次拆段 + 乐观插入 + 等待提示”实现，**已于 2026-10-29 按要求整体撤销**（回归 HEAD 行为），改由单一数据源方案根治 | ⛔ 已撤销 |
| 9 | 用户与 Agent 消息区分度不够 | 两者都是整幅宽度正文，只靠 12px 角色标签与绿色 `›` 区分 | 用户消息改纸卡批注，Agent 保持流动正文 | ✅ |
| 10 | 打开的文件不跟随 Agent / 外部改动 | 监听只盯工作区根 + `.pi-workbench/**` 被过滤器忽略 + 脏缓冲直接忽略 + 路径严格相等 | 监听覆盖工作树 + 路径归一 + 轮末兜底重读 + 冲突提示 | ✅ |

崩溃与复制按钮的证据都在**已安装版**的渲染日志（不是主工作树里那份旧日志）：

```
D:\Program Files\Pi Workbench\logs\renderer.log
2026-10-28T21:03:36 [ERROR] Failed to copy code: {}
2026-10-28T21:07:43 [ERROR] Error: Model is disposed!
[UI] Unhandled render error: … at MonacoEditor-*.js → Suspense → FileView → WorkspaceView → ErrorBoundary
```

---

## 1. 会话代码框复制按钮

**现象**：点"复制"没有任何反馈，也不落剪贴板。

**根因**：`src/components/AgentMarkdown.tsx` 的 `CodeBlock` 用 `navigator.clipboard.writeText()`。生产环境外壳协议是 `pw-app://`（`electron/app-protocol.ts`），虽登记了 `secure: true`，但 Chromium 的 Clipboard API 只对 `http(s)`/`file` 等可信来源授予写权限，调用直接 reject，被 `catch` 吞成一行 `console.error`。同样的写法散落在 5 处：`GitView.tsx`（复制 SHA）、`ToolResultViewer.tsx`（复制完整结果）、`GithubSettings.tsx`（设备码）、`useChatPanelState.ts`（复制消息）、`AgentMarkdown.tsx`。

**落地方案**

1. `electron/preload.cts`：暴露 `writeClipboardText(text)`，内部 `require('electron').clipboard.writeText`（同步、无需权限，且主窗口与拆出面板共用同一段 preload 上下文）。
2. `src/utils/clipboard.ts`：`copyText(text)` 三级回退 —— Electron 原生 → `navigator.clipboard` → 临时 textarea + `execCommand`；全失败返回 `false`。
3. 5 处调用点改为 `await copyText()`，失败时 `toast.error(t('copyFailed'))`，不再静默。
4. `ElectronAPI` 类型与 `api/index.ts` 同步（Web dev 模式下 mock 走 `navigator.clipboard`）。

**边界**：空文本直接返回 `false`；`CodeBlock` 的 `copied` 绿勾仍在成功后才显示；辅助窗口里复制同样可用（不依赖 IPC）。

**测试**：`tests/clipboard.test.ts`（三级回退顺序、bridge 抛错时继续回退）；`tests/renderer-components.test.tsx` 现有用例补一条"点击复制调用 bridge"。

---

## 2. 内联变更卡默认收起

**现象**：助手消息下方直接平铺本轮所有改动文件。

**根因**：`src/components/ChatMessageRow.tsx` 的 `TurnEditSummary` 里 `edits.map(...)` 无条件渲染，没有折叠状态。

**落地方案**

1. 头部行改为按钮：`ChevronRight` 12px（展开旋转 90°）+ `t('turnChanges', { count })` + `aria-expanded` / `aria-controls`。
2. 默认 `open = false`；文件行（名称 + 查看修改 + 还原此文件）只在展开时渲染。
3. "全部还原"保留在头部行右侧，点击 `stopPropagation`，避免与展开动作互相触发（设计规范 4.5：不嵌套可交互元素）。
4. 折叠状态是组件本地状态：切换工作树 / 会话重开回到收起态，不落盘。

**边界**：`edits.length === 0` 仍返回 `null`；展开后行结构与现在一致（`type-data` 文件名 + 文本按钮）。

**测试**：`tests/renderer-components.test.tsx` 增两例：默认不出现文件名；点击头部后出现，且点"全部还原"不触发展开。

---

## 3. 超链接点击无效

**现象**：聊天回复里的链接、Markdown 文档里的链接（含 `docs/*.md` 之间的相对链接、ADR 交叉引用）全部点不动。

**根因**：`electron/aux-window.ts` 的 `installAuxWindowSupport()` 在主窗口上装 `setWindowOpenHandler`，非 `about:blank` 一律 `deny`；返回 `deny` 时 Chromium 不会做任何事。`AgentMarkdown` 的 `a` 组件写的是 `target="_blank"`，正好落进这个分支。`will-navigate` 也只放行 `pw-app://`/`file://`/dev server，所以不带 `target` 的链接点了同样被拦。拆出的辅助窗口更严：子窗口 `setWindowOpenHandler` 直接全 deny。

**落地方案**

1. **主进程出口**（新增 `electron/external-links.ts`）：`isExternalUrl()` 只放行 `https:` / `http:` / `mailto:`，其余（`javascript:`、`file:`、自定义 scheme）一律拒绝；`ipc/system.ts` 注册 `shell:openExternal`，协议校验后 `shell.openExternal`。
2. **window.open 兜底**：`setWindowOpenHandler` 里先把外链交给 `shell.openExternal` 再 `deny`；这样即使某处仍写 `target="_blank"`（第三方渲染、HTML 预览）也不会静默失败。
3. **渲染层链接组件**：`src/workspace/linkTarget.ts` 解析 href → 三态：
   - `external`（http/https/mailto）→ `api.openExternalUrl()`；
   - `anchor`（`#section`）→ 在当前滚动容器里按标题文字 / `id` 滚动（GitHub 风格 slug 归一化，中文标题也能命中）；
   - `file`（其余一律按仓库内路径）→ `openFileInEditor(root, path, { revealLine })`，支持 `path#L12`、`./x.md`、`/docs/x.md`（以工作区根为基准）、`file:///…`。
4. **基准目录**：新增 `MarkdownLinkScope`（Context），提供 `docDir`（所在文档目录）、`workspaceDir` 与锚点容器 ref。`MarkdownReadingView` 传入当前文件目录；聊天消息传入 `viewRoot`（会话绑定的工作树根）。
5. **失败提示**：解析失败或打开失败 → `toast.error(t('linkOpenFailed'))`，不再静默。
6. **样式**：沿用 `.chat-markdown a`（`accent` + 下划线），不加新视觉。

**安全边界**：只放行三种协议；`file://` 链接不交给系统而是走编辑器（受工作区信任校验）；不引入 `shell.openPath` 之类的新通道。

**测试**：`tests/link-target.test.ts`（外部 / 锚点 / 相对 / 绝对 / `#L12` / 非法编码）；`tests/markdown-links.test.tsx`（点击外链调 `api.openExternalUrl`、相对路径调 `openFileInEditor`、锚点滚动到标题、`javascript:` 不触发任何调用）。

---

## 4. 划词引用（文档 + 会话）

**现状**：编辑器选区通过 `src/store/selectionStore.ts` 提供给"附加当前选区"；Markdown 阅读视图与聊天消息没有任何选区捕获，也没有引用入口。

**落地方案**

1. **选区 hook**（新 `src/hooks/useTextSelectionQuote.ts`）：在 `useHostDocument()` 上监听 `selectionchange` + `mouseup` + `keyup`，`requestAnimationFrame` 节流；返回 `{ text, rect } | null`：
   - 选区锚点/焦点节点必须落在传入的容器内；
   - `text.trim()` 非空且 ≤ 8000 字（超长提示 `t('quoteTooLong')` 并忽略）；
   - 选区折叠、`window.blur`、容器滚动时清空。
2. **浮起按钮**（新 `src/components/SelectionQuoteButton.tsx`）：`createPortal` 到宿主 `document.body`，`position: fixed` 贴选区末尾右下 8px，超出宿主窗口时向左上翻转并夹紧；`bg-raised` + `border-line` + `shadow-print`（浮层，符合 6.15 与 9.1），`type-caption` + `Quote` 12px 图标，28px 高，`aria-label={t('quoteSelection')}`；`onMouseDown` `preventDefault` 保住选区。
3. **写入聊天**（新 `src/workspace/quoteSelection.ts`）：`quoteIntoChat({ workspaceDir, text, path?, name, startLine?, endLine? })`：
   - 从 `useSessionStore` 取激活会话，`conversationKey()` + `ensureConversation()`；
   - `addAttachment(key, { kind: 'snippet', path, name, label, content, startLine, endLine })`；
   - 成功 `toast.success(t('quotedToChat'))`；无激活会话 → `toast.error(t('quoteNoSession'))`。
4. **接入点**
   - `MarkdownReadingView`：`article` ref 作为容器；`path` = 当前文件路径、`name` = 文件名；行号由块偏移换算（`MarkdownBlockRange.start/end` + 选区在块内的偏移量取换行数，得到 1-based `startLine` / `endLine`）。
   - `ChatTranscript`：滚动容器 ref 作为容器；`path` 留空、`name` = `t('quoteFromChat')`、`label` 记下消息角色（如"Pi 回复"），不带行号。
5. **Prompt 注入**：`src/api/chatContext.ts` 的 `ContextFile` 增可选 `label`；`buildContextPrompt()` 在 `path` 为空时用 `label` 作块标题（`--- 对话引用 ---`），仍受 `MAX_CONTEXT_SNIPPET_CHARS` / `MAX_CONTEXT_TOTAL_CHARS` 约束。
6. **附件 chip**：`ChatPanel` 里 snippet 有行号显示 `name:起–止`，无行号只显示 `name`；`title` 仍给完整路径（聊天引用给"来自对话"）。

**数据模型**：`src/store/chatStore.ts` 的 `ChatAttachment` 增 `label?: string`（只影响展示与 prompt 标题，不改发送链路）。

**边界**：引用不移动焦点、不改草稿；同一选区重复引用会产生两个独立 chip（由用户自己删）；引用内容随消息一起持久化在 JSONL 的 context 块里（与现有 snippet 行为一致，展示时由 `activeTimeline()` 剥离）。

**测试**：`tests/selection-quote.test.tsx`（选区 → 按钮 → 附件 → prompt 含引用块）；`tests/chat-context.test.ts` 增 `label` 用例；`tests/markdown-ranges.test.ts` 增选区行号换算。

---

## 5. 引用"正在查看的文档"

**现状**：输入框工具栏只有回形针（附件菜单），没有当前文档开关；`handleSubmit` 只消费 `attachments`。

**落地方案**

1. **状态**：`ConversationState` 增 `quoteCurrentFile: boolean`（默认 `false`）+ `setQuoteCurrentFile(key, value)`；`EMPTY_CONVERSATION` 同步；`reset()` 一并清空。
2. **控制器**：`useChatPanelState` 返回 `quoteCurrentFile`、`toggleQuoteCurrentFile`、`quotedFile`（= `currentEditorFile`，用于按钮文案）。
3. **按钮**（`ChatPanel` 附件按钮右侧）：`aria-pressed`，`title={t('quoteCurrentDocHint')}`，内容 = `FileText` 10px + 文件名（`truncate`，`type-caption`）；激活态 `border-accent` + `text-accent` + `bg-accent/10`；无当前文件时禁用并显示 `t('quoteCurrentDoc')`。
4. **提交时注入**（`handleSubmit`，仅 `takeComposerAttachments` 为真时）：
   - `quoteCurrentFile && currentEditorFile` → `api.readFile()`，≤120k 才并入 `contextFiles`（超限 `toast.error(t('contextTooLarge'))` 并跳过）；
   - 与已有附件按 `path` 去重，避免同一文件注入两次；
   - 读取完立即 `setQuoteCurrentFile(key, false)` —— 只要消息发出，按钮就回到未激活态（发送失败也不回滚，符合"一次性引用"语义）。
5. **运行中行为**：与现有附件一致 —— 排队消息（`consumeAttachments: false`）不读取输入框状态，文档只随"本轮发送"注入。

**测试**：`tests/chat-current-doc.test.tsx`：激活 → 发送 → `piAgentAPI.chat` 收到的 prompt 含文件内容，且按钮回到未激活；文件关闭后激活 → 发送不带该文件；与既有附件同路径时不重复注入。

---

## 6. 前端崩溃（`Model is disposed!`）

**现象**：21:07:43 编辑器区域抛错，顶层 `ErrorBoundary` 把整个窗口替换成错误页（"前端崩溃"）。

**根因**（`src/components/MonacoEditor.tsx`）

- model 缓存在 `modelsRef`，但 model 是 Monaco 全局对象（按 `monaco.Uri.file(path)` 复用）；
- 释放有两条路径：组件卸载全量 dispose；`openFiles` 变化时把不在列表里的路径 dispose；
- 两处都**没有**判断"是否还挂在编辑器上 / 是否已经 disposed"，`getOrCreateModel()` 直接 `existing.getValue()`；
- 切工作树（会话绑定变化导致 `viewRoot` 变化）或关闭标签时，`currentFile` 会短暂为 null / 换 store，释放 effect 先把仍挂载的 model 干掉，随后 `getValue()` / `setModelLanguage()` / `editor.getValue()` 抛 `Model is disposed!`；
- 顶层只有一个 ErrorBoundary（`App` 级），一个编辑器异常 = 整窗前功尽弃。

**落地方案**

1. **模型守卫**：
   - `getOrCreateModel()`：`existing && !existing.isDisposed()` 才复用；已 disposed 则从 map 删除后重建（`getModel(uri)` 结果同样判 `isDisposed()`）；
   - `openFiles` 释放 effect：`isDisposed()` 直接清理 map；`monacoRef.current?.getModel() === model` 时跳过（交给卸载路径）；
   - `setModelLanguage` / `getLineCount` / `getValue` 调用前判 `isDisposed()`；
   - 切换文件时，旧 model 已 disposed 则跳过 `saveViewState()`。
2. **面板级错误边界**：`ErrorBoundary` 增 `variant="pane"`（紧凑错误条 + "重试"），包住 `FileView` 与 `ChatPanel`，`key={viewRoot}` 让切工作树自动复位；顶层边界保留作为最后兜底。
3. **诊断留痕**：捕获到 disposed 时 `console.warn('[monaco] model was disposed', { path })`，随渲染日志落盘，便于下次定位真实触发点。

**可选项（需确认）**：`viewRoot` 变化时用 `key` 强制重建 `MonacoEditor`，从根上消除跨工作树复用 —— 代价是撤销栈与滚动位置丢失。默认**不做**，先靠守卫 + 边界兜住。

**测试**：`tests/monaco-editor.test.tsx` 增用例（`isDisposed()` 为真时不复用、不抛错；释放时不动当前挂载 model）；`tests/pane-error-boundary.test.tsx`（子组件抛错只替换面板，不影响外壳）。

---

## 7. 拆分抓手：拖得够远就拆窗

**现象**：只有在窗口外松手才拆；在主窗口里拖很远松手什么都不发生。

**根因**：`src/panelHost/panelDrag.ts` 的 `finishPanelDrag()` 完全依赖主进程 `auxDetachAt()` 的 `inside`；`electron/aux-window.ts` 的 `resolveDetachTarget()` 只要光标仍在窗口矩形内就返回 `{ inside: true }`，渲染层直接 return。

**落地方案**

1. `resolveDetachTarget()` 额外返回 `point`（光标屏幕坐标）与 `bounds`；`AuxDetachResult` 类型同步。
2. `panelDrag.ts`：模块级 `dragOrigin` 记录 `dragstart` 的 `screenX/screenY`；`finishPanelDrag(event)` 取主进程光标点算欧氏距离：
   - `distance >= DETACH_DRAG_DISTANCE`（建议 **96px**）→ 拆窗，即使 `inside === true`；
   - 否则退回原判据（`inside === false` 才拆）；
   - `dragOrigin` 缺失（`0,0`）时只用 `inside`，避免误判。
3. `PanelDragHandle.tsx`：`onDragEnd={(event) => void finishPanelDrag(workspacePath, panel, event)}`。
4. 误触防护：只在真正 `dragstart` 之后计距离；`Esc` 取消时 `dragend` 光标与起点几乎重合 → 距离小，不拆。

**测试**：`tests/panel-drag.test.tsx` 增三例：窗口内长距离 → 拆；窗口内短距离 → 不拆；窗口外落点 → 仍拆（原有 5 例保持）。

---

## 8. 插话（steer）：生效时机与插入位置

> **本项已撤销（2026-10-29，按要求回到 HEAD 行为）。** 本节保留根因分析与当时的方案记录；撤销范围见 §16.8。

**先澄清一半是设置不是 bug**：当前安装版 `D:\Program Files\Pi Workbench\config\settings.json` 里 `runWhileBusy: "queue"`。也就是说运行中按 Enter / 点发送走的是"排到下一轮"，要等整轮结束才发出；只有待发送列表里的「立即插入当前轮」按钮才走 steer。

**记录层面是正确的中途位置**（已核对本会话 JSONL，`data/agent/sessions/2026-10-28T21-08-45-110Z_01a18458-….jsonl`）：

```
141 21:14:14 assistant  parent=…           [thinking][toolCall]
142 21:14:14 toolResult parent=…           Successfully wrote to …
143 21:14:14 user       parent=98cd0894    「只检查，不执行」   ← 插话
144 21:14:19 assistant  parent=0186ad83    [thinking][toolCall]  ← 插话导致的续写
```

**但实时 UI 把它放到了末尾**：`useChatPanelState.handleSubmit()` 一次提交只创建一个助手消息（`const assistantId = chat.startStreamingMessage(key)`，闭包里是常量），`sendSteer()` 成功后调用 `chat.addMessage()` 把用户消息**追加到 messages 数组末尾**，而后续 text/tool 片段仍然写进它**上面**那条助手消息 —— 于是插话永远显示在最后，且由它触发的内容渲染在它之前。

**重载后又是另一个样子**：`pi-bridge/src/session-history.ts` 遇到轮次中间的 user entry 会 `flushTurn()` 切成两段，插话出现在中间。**实时与重载不一致**，这也是"看起来不对"的根源。

**生效时机（SDK 语义，非本仓库可控）**：`@earendil-works/pi-coding-agent` 的 steer 是"当前助手段落执行完工具调用之后、下一次 LLM 调用之前"注入（`agent-session.d.ts` 注释原文），不会打断已经开始的那一步。若当前步骤是一段长文本流，就要等它写完，主观上就是"没反应"。另外 `sendSteer()` 是 `await piAgentAPI.steer()` 成功后才插入消息，这期间的往返（扩展 input handler + IPC）也会被感知成延迟。

**落地方案**

1. **轮次拆段（核心修复，与记录对齐）**：把 `assistantId` 改成可变引用 —— `handleSubmit` 内 `const turnRef = { id: chat.startStreamingMessage(key) }`，trace 回调里所有 `appendTextPart / appendThinkingPart / startToolPart / updateToolPart / endToolPart / appendPlanPart` 一律读 `turnRef.id`；`sendSteer()` 成功后：先 `addMessage(user)`，再 `turnRef.id = chat.startStreamingMessage(key)`。后续片段自然落进新消息，轮次结束用最新 id 收尾（`finishStreamingMessage` / `setMessageUsage` / `setMessageEdits`）。
2. **乐观插入**：`sendSteer()` 立即 `removePending()` + `addMessage(user)`，再去 `await`；失败时 `removeMessage()` 回滚并 `toast.error`（原待发送内容恢复到待发送列表）。菜单往返不再阻塞"我已经插进去了"的反馈。
3. **等待提示**：插话消息下显示一行 `type-caption` "等待当前步骤结束"，助手产生下一段 part 后消失；文案如实描述 SDK 行为，不承诺"立刻打断"。
4. **空段兜底**：插话后若本轮没有续写，新开的助手消息必须移除（`finishStreamingMessage` 后显式 `removeMessage`，或复用 `isStreaming && !content && !parts` 的隐藏规则）。
5. **设置侧**：文档里写明"想默认插入当前轮，把设置『任务运行时发送消息』改成『立即插入当前轮』"；是否改成默认值另议（涉及既有用户配置迁移）。

**已知限制**

- 一轮只有一份 `runtime.pendingEdits`，拆段后编辑卡片归属到最后一段（可接受，标注即可）。
- steer 不打断已开始的流式输出（SDK 无该能力），长文本步骤仍会有等待；提示文案负责把预期说清楚。

**测试**：`tests/chat-steer.test.tsx` —— 运行中插话后用户消息位于两条助手消息之间、后续 delta 进入新消息、轮末收尾、失败回滚、无续写不留空消息；`tests/session-history.test.ts` 增"实时与重载 order 一致"的断言。

---

## 9. 用户消息与 Agent 消息的视觉分层

**现状**：两种消息都是整幅宽度的正文块，只靠 12px 角色标签和用户消息前的一个绿色 `›` 区分，正文同为 `font-reading` 14px / 1.85。设计规范 6.5 明确"不使用气泡"，所以不能直接改成对话气泡，需要在纸面语言里重新定义层次。

**方案**

- **A（推荐）纸卡批注**：用户消息 = `bg-raised` 纸卡 + `border-rule-hairline` + 左侧 2px `success` 竖线 + `px-3 py-2`（0–2px 圆角、无阴影）；角色标签「你」用 `text-success`；正文 `type-reading`；图片缩略图在卡内。Agent 消息保持现在的 `surface` 流动正文（无卡片、无边框），标签 `Pi Agent` 用 `accent`。一"卡"一"文"，深浅与形状都不同。
- **B（轻量）垂线 + 缩进**：用户消息左侧 2px `success` 竖线 + 8px 缩进 + `bg-sunken` 底，其余不变。改动最小，但区分度弱于 A。
- **C 右对齐窄列（对话框式）**：区分度最强，但偏离现有稿纸语言，不推荐。

**落地要点**

1. `ChatMessageRow` 的用户分支外层加纸卡容器，`data-testid="user-message"`；Agent 分支保持原结构（新增 `data-testid="agent-message"` 便于测试与截图对比）。
2. 只使用 token（`bg-raised` / `border-rule-hairline` / `success` / `accent` / `bg-surface`），不加阴影、不加圆角 > 2px。
3. 用户消息上下的间距从 `py-3` 收成 `my-3`，保证卡片与相邻消息的 `rule-divide` 分隔不打架。
4. 对比度：`text-ink` on `bg-raised` ≥ 4.5:1（Paper / Ink 各测一次）；`success` 竖线只作辅助，角色名以文字承担信息。
5. `DESIGN_SYSTEM.md` 6.5 增补"消息角色分层"条目，并在 9.2 检查清单补一条"Paper / Ink 下用户消息与 Agent 消息一眼可分"。

**测试**：`tests/renderer-components.test.tsx` 增结构断言（用户消息带纸卡容器与 `data-testid`、Agent 消息不带）；Paper / Ink 双主题截图对比。

---

## 10. 打开的文件不跟随外部（Agent）改动刷新

**现象**：Agent 改完文件后，编辑器里还是旧内容，必须关掉标签重新打开。

**现状检查（五条独立原因，后几条会叠加）**

1. **监听只在打开工作区时对工作区根注册**：`src/App.tsx` 里 `api.watchWorkspace(targetPath)` 只在打开工作区那一刻调一次，`electron/ipc/workspace.ts` 的 `fs:watch` 每个工作区一个递归 watcher。会话绑定工作树后**不会**再为工作树根注册。
2. **过滤器把工作树整段排掉**：`electron/watch-filter.ts` 的 `IGNORED_SEGMENT` 包含 `.pi-workbench` / `.pi-worktrees`，而工作树就放在 `.pi-workbench/worktrees/<id>`（本会话正是 `F:\Claude Code\唐辰的开发工作台\.pi-workbench\worktrees\01a18458`）——工作树里的写入一个事件都到不了渲染层。就算补上注册也不行：`fs:watch` 用 `isTrustedWorkspacePath()` 严格要求路径**等于**受信任根，工作树根会被直接拒。
3. **脏缓冲静默忽略**：`src/workspace/useFileDocument.ts` 的外部变更处理里有 `if (target.isDirty) return`。缓冲里有未保存修改时，磁盘变化被丢掉且没有任何提示，看起来就是"不刷新"。
4. **路径严格相等**：`state.openFiles.find((file) => file.path === payload.path)`。从聊天里的 `path:line` 打开的文件路径是 `${workspace}/${filePart}`（正斜杠，`AgentMarkdown.tsx`），watcher 用 `path.join` 给的是反斜杠——这类标签永远匹配不上，永远不会自动更新。
5. **没有兜底**：回合结束只 `emitAppEvent('pi:refresh-files')`，`FileExplorer` 收到后仅刷新目录树（`src/components/FileExplorer.tsx`），不重读已打开的文档；`fs.watch` 在原子写（写临时文件 + rename）、网络盘或句柄耗尽时还会漏事件。

**落地方案**

1. **监听覆盖工作树**：`fs:watch` 的校验从"等于受信任根"放宽为"位于受信任根内"（监听是只读操作，不扩大写权限）；`viewRoot !== workspacePath` 时为工作树根额外注册一个 watcher，`fs:unwatch` 同步回收。
2. **过滤器放行源码工作树**：`.pi-workbench` 下只忽略 `plugins` / `drafts` / `cache`，放行 `worktrees`（`.pi-worktrees` 同理）；`cache` / `dist` / `node_modules` 保持忽略。
3. **路径比较归一化**：`fs:changed` 与 `openFiles` 的比较改为"分隔符归一 + Windows 小写"，复用 `src/utils/filePath.ts`；顺手让 `src/workspace/linkTarget.ts` 用同一个 `joinPath`，删掉重复实现。
4. **轮末兜底重读**：除了 watcher，助手回合结束时对"已打开 / 干净 / 在编辑区"的标签做一次 `readFile` 比对，内容不同就更新（不依赖事件送达）。
5. **脏缓冲冲突可见**：磁盘内容与缓冲不同、且缓冲有未保存修改时，在 `FileView` 内容区上方显示一行 `type-caption` 提示 + 两个文本动作「重新加载（丢弃我的修改）」「保留我的修改」；干净缓冲则静默重载，不弹 toast。
6. **不打断阅读位置**：外部重载只 `updateOpenFile({ content })` + `markClean`，不动 `pendingReveal`；Monaco `setValue` 会清空撤销栈（文案说明）；Markdown 阅读视图的 `frozen` 只在视图切走时生效，重载后立即反映。

**边界**

- Agent 连续多次写同一文件：watcher 300ms 合并 + 重读比对，最终一致，不逐次提示。
- 用户正在输入（脏）时不被覆盖；冲突提示保留用户决定权，不自动合并。
- 大文件沿用现有大文件模式，不额外重读；媒体 / PDF 仍只递增 `version` 刷新预览。

**测试**：`tests/file-document.test.tsx` 增三例（干净缓冲外部变更 → 自动重载 + `markClean`；脏缓冲 → 不覆盖 + 出现冲突提示；分隔符不一致时仍能匹配）；`tests/watch-filter.test.ts`（worktrees 放行 / plugins 忽略）；`fs:watch` 信任放宽的用例加在 `tests/main-ipc.test.ts`。

---

## 11. 横切改动

### 11.1 新增 i18n key（zh / en 均需补全）

| key | zh | en |
|---|---|---|
| `copyFailedPlain` | 复制失败 | Copy failed |
| `linkOpenFailed` | 打开链接失败：{target} | Failed to open link: {target} |
| `quoteSelection` | 引用到对话 | Quote in chat |
| `quotedToChat` | 已引用到对话 | Quoted in chat |
| `quoteNoSession` | 先打开一个会话再引用 | Open a session before quoting |
| `quoteTooLong` | 选区过长，最多引用 {count} 字 | Selection too long, up to {count} characters |
| `quoteFromChat` | 对话引用 | Chat quote |
| `quoteCurrentDoc` | 引用当前文档 | Quote current document |
| `quoteCurrentDocHint` | 发送时自动带上当前查看的文档，发送后自动取消 | Attach the document you are viewing to the next message |
| `quoteCurrentFileOn` | 不再引用当前文档 | Stop quoting the current document |
| `fileChangedOnDisk` | 磁盘上的文件已被外部修改 | The file changed on disk |
| `fileReload` | 重新加载（丢弃我的修改） | Reload (discard my changes) |
| `fileKeepMine` | 保留我的修改 | Keep my changes |
| `paneErrorTitle` | 这块区域渲染出错了 | This area failed to render |

> ✅ 已全部写入 `src/i18n/translations.ts`（zh / en 对等），并额外补了 `paneErrorTitle`。

### 11.2 设计规范增补（已落地）

`docs/design/DESIGN_SYSTEM.md`（**v1.47**）：

- **6.5 聊天**：用户消息纸卡批注（与 Agent 正文分层）；Markdown 链接三态；划词引用；“引用当前文档”开关；内联变更卡默认收起。（插话等待提示随需求 8 撤销，规范已移除）
- **6.16 选区浮起操作**（新增）：“引用到对话”按钮的位置、尺寸、保选区、反馈与可访问性。
- **6.3 编辑器**：磁盘冲突提示条（`bg-panel` + `border-b rule-divide`，`warning` AlertCircle + 两个文本动作）。
- 变更记录追加 v1.47。

> 注：原文里把“选区浮起操作”放在 6.15（内容区浮动控件）下，实现时单独开了 6.16 —— 两者落点与行为都不同（一个贴内容角落常驻、一个贴选区临时出现）。

### 11.3 安全与信任边界

- `shell:openExternal` 只放行 `https/http/mailto`，其余拒绝（含 `javascript:`、`file:`、自定义 scheme）。
- 拆出的面板窗口（`about:blank`，与主窗口同源）需要 IPC 才能点链接 / 写剪贴板，因此 `ipc/register.ts` 增加"可由主窗口登记的辅助 webContents"名单；子框架仍被 `senderFrame === sender.mainFrame` 拦下，不放宽到任意 frame。
- 仓库内路径链接不走系统打开，仍经 `openFileInEditor`（受工作区信任校验 + 大文件确认）。
- `fs:watch` 虽然放宽为"受信任根内即可"，但只授予**监听**能力；写 / 删 / 改仍要求 `resolveAllowedFileTarget` 的原有校验。

---

## 12. 实施顺序与批次（已按此顺序执行完毕）

| 批次 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **A** | 主进程出口与基础设施：外部链接 IPC、preload（剪贴板 / 外链）、可信辅助窗口、`clipboard.ts`、`linkTarget.ts` | — | `npm run type-check`；`tests/app-protocol.test.ts`、`tests/main-ipc.test.ts` 绿 |
| **B** | 可感知修复（低风险）：复制按钮 5 处、变更卡折叠、链接组件接线、Monaco 守卫 + 面板错误边界 | A | 双主题截图；`panel-drag` 以外全部测试绿 |
| **C** | 新交互：划词引用（hook + 浮起按钮 + 引用附件 + prompt 注入）、引用当前文档开关 | B | 双主题截图（选区浮层、芯片、激活态按钮） |
| **D** | 拆分抓手距离判据 | A | 手测 + `tests/panel-drag.test.tsx` |
| ~~**E**~~ | ~~插话：轮次拆段、乐观插入、等待提示~~ | — | **已撤销**，不再实施 |
| **F** | 用户 / Agent 消息分层（方案 A） | 设计文档确认 | 双主题截图 + 结构断言 |
| **G** | 外部变更同步：工作树监听、过滤器、路径归一、轮末兜底、冲突提示条 | — | `tests/file-document.test.tsx`、`tests/watch-filter.test.ts` |

每批结束跑：`npm run type-check` → `npm run lint` → `npm test`。B/C/E/F/G 额外产出 Paper / Ink 截图（G 只需冲突提示条），并按设计规范 9.2 检查清单逐条过。

---

## 13. 风险与回退

| 风险 | 影响 | 措施 |
|---|---|---|
| 辅助窗口登记为可信发送者 | 拆出面板可调全部 IPC | 只登记主窗口 `did-create-window` 创建的子窗口；`closed` 立即移除；子框架仍拒绝 |
| 划词浮层抢焦点 / 与虚拟滚动冲突 | 引用后选区丢失、滚动错位 | 浮层挂 `document.body`（不参与内容布局），`onMouseDown` `preventDefault`，滚动 / 失焦即隐藏 |
| 引用注入挤占上下文 | 长选区吃 token | 单条 ≤8000 字，仍受 300k 总量约束；超长直接拒绝并提示 |
| 距离阈值拆窗误触 | 拖拽误拆面板 | 阈值 96px + 仅手柄触发 + `Esc` 取消（距离≈0）；不满意 96px 可调 |
| Monaco 守卫只治标 | 极端情况下仍可能复现 | 面板级边界把影响限制在编辑区；必要时再启用"`key` 重建编辑器"选项 |
| 链接行为变更 | 仓库内相对链接从"浏览器"改到"编辑器" | 更符合工作台预期；失败有 toast，可回退为仅支持外链 |
| ~~插话拆段改变实时结构~~ | — | 已按要求撤销，风险不再存在 |
| 乐观插入失败 | 消息与待发送项双写 / 丢失 | 失败路径统一 `removeMessage` + 恢复待发送项，测试覆盖 |
| 用户消息改纸卡后信息密度下降 | 长消息阅读体验 | 卡片不加内缩进（满宽）+ `type-reading` 行高不变；纸卡只作底色区分 |
| 工作树监听带来事件量 | 大型工作树 watcher 句柄 / 事件风暴 | 只针对当前会话的 `viewRoot` 注册，切会话 / 关工作区即回收；持续保留 `node_modules` / `dist` / `cache` 忽略 |
| 外部重载清空撤销栈 | 用户丢失撤销历史 | 只在磁盘内容确实不同且缓冲干净时重载；脏缓冲永不自动重载 |

**回退**：每批独立提交（`fix(chat)` / `feat(chat)` / `fix(panel)`），可单批 revert；无数据迁移、无落盘格式变更（除 `ChatAttachment.label` 可选字段，旧记录缺省即按路径显示）。

---

## 14. 已按默认执行的选择（如需改动，改一处即可）

1. **划词引用落点**：落成会话附件 chip（可删可留、发送时统一注入），不往输入框插引用块。→ `src/workspace/quoteSelection.ts`
2. **“引用当前文档”语义**：布尔开关，发送时取“当前激活标签文件”（切标签会跟着变），真正发出后复位；排队期间保留。若要“激活时锁定那一刻的文件”，把 `quoteCurrentFile: boolean` 换成 `{path,name}`。→ `chatStore.ts`
3. **变更卡折叠后**：“全部还原”仍在头行（收起时也能还原整轮）。→ `ChatMessageRow.tsx`
4. **面板级错误边界**：编辑器 / 聊天各自一块，崩溃只损失该区域（可点“重试”就地恢复；切文件 / 切会话自动清错）。→ `ErrorBoundary.tsx`、`WorkspaceView.tsx`
5. **仓库内相对链接**：在编辑器打开（带 `#L12` 行号），外链才交系统浏览器。→ `linkTarget.ts`
6. **拆分阈值**：96 DIP；拖动距离够就拆（含拖回窗口内松手），距离与落点由主进程同一坐标源计算。→ `electron/aux-window.ts`
7. ~~**插话拆分粒度**~~：曾按“每次插话切一段”实现，**已撤销**，回到 HEAD 行为（消息追加到末尾）。→ `useChatPanelState.ts`
8. ~~**插话失败**~~：曾实现“回滚 + 退回待发送”，**已撤销**，回到 HEAD 的 `steerFailed` 提示。→ `sendSteer`
9. **用户消息样式**：A 纸卡批注（`bg-raised` + 发丝边 + 2px `success` 左竖线）。换 B（垂线缩进）/ C（右对齐窄列）只是 `ChatMessageRow.tsx` 一个 div 的类名，设计文档已按 A 记录。
10. **“等待当前步骤结束”提示**：要。纸卡内 `type-caption` 一行，助手产出下一段输出后自动消失。
11. **磁盘冲突**：提示条 + 两个动作（重新加载 / 保留我的修改），绝不静默覆盖脏缓冲。→ `useFileDocument.ts`、`FileView.tsx`
12. **外部更新的提示**：干净缓冲静默重载，不弹 toast；只有脏缓冲才出现提示条。
13. **监听范围**：当前会话绑定的 `viewRoot` 额外监听一层（`viewRoot !== workspacePath` 时才挂，切会话 / 关工作区即回收），主工作区根仍由 `App.tsx` 统一监听。

---

## 15. 本轮改动清单

分支 `pi/01a18458`：

**主进程**
- 新增 `electron/external-links.ts`：外链白名单（https / http / mailto）
- `electron/aux-window.ts`：外链交系统浏览器、拖动起点与距离、`aux:drag-begin`
- `electron/workspace-trust.ts`：新增 `resolveWatchableRoot`（受信任根内即可监听）
- `electron/ipc/workspace.ts`：`fs:watch` 改用 `resolveWatchableRoot`
- `electron/watch-filter.ts`：放行 `.pi-workbench/worktrees/**` 与 `.pi-worktrees/**`
- `electron/ipc/register.ts`、`electron/ipc/system.ts`、`electron/preload.cts`：受信辅助窗口 IPC、`shell:openExternal`、`clipboard:writeText`、`aux:drag-begin`

**渲染层**
- 新增 `src/utils/clipboard.ts`、`src/workspace/linkTarget.ts`、`src/workspace/MarkdownLinkScope.tsx`、`src/workspace/quoteSelection.ts`、`src/components/SelectionQuoteButton.tsx`
- `src/components/AgentMarkdown.tsx`：链接三态接管、代码块复制改 `copyText`
- `src/components/MarkdownReadingView.tsx`：链接基准 + 可引用域标记
- `src/components/ChatPanel.tsx`：链接基准、引用当前文档开关、引用 chip 标签、拆窗时的引用按钮
- `src/components/ChatMessageRow.tsx`：变更卡默认收起、用户消息纸卡、可引用域标记
- `src/components/MonacoEditor.tsx`：model 已释放守卫
- `src/components/ErrorBoundary.tsx`：`scope="pane"` + `resetKey`
- `src/components/WorkspaceView.tsx`：面板级错误边界、工作树监听、引用按钮
- `src/components/FileView.tsx`：磁盘冲突提示条
- `src/components/{GitView,GithubSettings,ToolResultViewer}.tsx`、`src/hooks/useChatPanelState.ts`：复制改走 `copyText`
- `src/components/GitView.tsx`：PR 链接改走 `openExternalUrl`
- `src/hooks/useChatPanelState.ts`：引用当前文档注入
- `src/store/chatStore.ts`：`quoteCurrentFile`、附件 `label`（插话相关字段已随需求 8 撤销删除）
- `src/workspace/useFileDocument.ts`：路径归一比较、脏缓冲冲突、轮末兜底重读
- `src/api/chatContext.ts`：引用块标题支持 `label`
- `src/utils/filePath.ts`：`samePath`、`joinPath` 分隔符对齐
- `src/i18n/translations.ts`：新增 15 个 key（zh / en 对等）

**文档与测试**
- `docs/design/DESIGN_SYSTEM.md`：v1.47（消息分层、变更卡折叠、链接三态、划词引用 6.16、引用当前文档、插话等待、编辑器冲突提示条）
- 新增 `tests/{link-target,selection-quote,chat-store-steer}.test.ts`、`tests/{clipboard,markdown-link}.test.ts(x)`
- 更新 `tests/{watch-filter,file-document,monaco-editor,panel-drag,design-system,aux-window}.test.ts(x)`

验证：`npm run type-check` / `npm run lint` / `npm test`（107 个测试文件、1013 个用例全绿）；`npm run build:renderer` / `build:main` 通过。

---

## 16. 实施记录

### 16.1 复制（需求 1）

`copyText()` 三级回退：主进程剪贴板（`clipboard:writeText` IPC）→ `navigator.clipboard` → `execCommand`。

> 自查修正：一开始在 preload 里直接 `clipboard.writeText()`，但主窗口 `webPreferences.sandbox = true`，沙箱 preload 只能拿到 `ipcRenderer / contextBridge / webUtils` 等少数模块，`clipboard` 是 `undefined`，那条路径实际永远失败（只会落到 `execCommand`）。已改为 preload 转 IPC、由主进程写剪贴板，`copyText()` 同时兼容同步（Web dev）与异步（Electron）桥。5 处调用点（代码块、Git SHA、GitHub 设备码、工具结果、消息复制）全部改走它，失败给 `copyFailedPlain` Toast（不再只写 console）。

### 16.2 变更卡（需求 2）

头行变折叠触发器（`aria-expanded` / `aria-controls` / chevron 旋转 90°），默认收起，展开才渲染文件行；“全部还原”留在头行且不触发折叠。

### 16.3 链接（需求 3）

- 主进程：`setWindowOpenHandler` 对 `isExternalUrl()` 放行到 `shell.openExternal`，其余照旧 deny；新增 `shell:openExternal` IPC。
- 渲染层：`MarkdownAnchor` 接管点击 → 三态解析 → 打开；不再用 `target="_blank"`。
- 基准：阅读视图按所在文档目录，聊天按当前工作树根，`/path` 按仓库根。
- 代码里的 `path:line` 引用也走同一基准与 `joinPath`（Windows 上得到反斜杠，顺带修好这类标签不跟随外部改动）。
- 自查补漏：`GitView` 的 PR 链接原本还是 `target="_blank"`（同样的静默拒绝），已改为走 `api.openExternalUrl`；全仓已无 `target="_blank"` 的 `<a>`。

### 16.4 划词引用（需求 4）

监听宿主文档的 `selectionchange`（120ms 防抖），只认 `[data-quote-scope]` 域内选区（文档 `doc` / Agent 回复 `chat`），浮在选区右上方；点击落成 `snippet` 附件（`label` 记来源，`path` 可空），发送时由 `buildContextPrompt` 包进上下文块。上限 8000 字，无会话 / 超限 / 空选区都有明确提示；聊天面板拆到独立窗口时按钮也跟着到那个文档。

### 16.5 引用当前文档（需求 5）

回形针右侧新增 `BookMarked` 开关（`aria-pressed`，激活时 `bg-active`），无打开文件时禁用。提交时读一次当前文件放进上下文块；**真正发出**才复位（排队期间保留）。

### 16.6 崩溃（需求 6）

`MonacoEditor` 加 `isDisposed()` 守卫：取 model 前（已释放则重建）、`getValue` / `setValue` 前后（抛错则重建）、跳过已释放 model 的选区与内容同步；dispose 侧不再二次释放。`ErrorBoundary` 新增 `scope="pane"` + `resetKey`，编辑器与聊天各自一块。

### 16.7 拆分抓手（需求 7）

`dragstart` 时主进程记下光标（`aux:drag-begin`），`dragend` 用同一坐标源算距离；`distance >= 96` 或光标离开窗口都拆窗，矩形由主进程给。

### 16.8 插话（需求 8）

**本项已撤销（2026-10-29）**。曾实现的方案是：`handleSubmit` 的 `assistantId` 常量换成 `turn.id`（模块级 `liveTurns` 按会话保存）；`sendSteer` 先乐观插入用户消息（带 `steerPending`“等待当前步骤结束”），再开新助手段，后续片段写进新段；失败回滚消息与新段、文本退回待发送；轮末 `finishAllStreaming` 收尾所有段并丢掉空段。

撤销原因：这套东西本质是 UI 层对“两套渲染逻辑”的补偿，需求方选择不做补偿、直接等技术债根治（见 `plan-2026-10-29-chat-single-source-render.md`）。撤销范围：`useChatPanelState.ts` 的 `liveTurns` / `turn.id` / 重写的 `sendSteer`、`chatStore.ts` 的 `steerPending` / `clearSteerPending` / `finishAllStreaming` / `addMessage` 返回值、`ChatMessageRow.tsx` 的等待提示、2 个 i18n key、`tests/chat-store-steer.test.ts`。撤销后行为回到 HEAD：插话消息实时出现在会话末尾，重载后回到中间。

剩下的“慢”与本次撤销无关：SDK 只在当前步骤结束、下一次 LLM 调用前注入，叠加设置项“任务运行时发送消息”（默认排队）。

### 16.9 消息分层（需求 9）

用户消息 = 纸卡批注（`bg-raised` + `border-rule-hairline` + 2px `success` 左竖线 + `px-3 py-2`），角色标签与 `›` 转 `success`；Agent 保持无底色流动正文。设计规范同步 v1.47（6.5）。

### 16.10 外部改动同步（需求 10）

- 监听：`fs:watch` 放宽为“受信任根内即可”，`WorkspaceView` 在 `viewRoot !== workspacePath` 时额外监听工作树根；过滤器放行 `.pi-workbench/worktrees/**` 与 `.pi-worktrees/**`（其余应用数据目录继续忽略）。
- 匹配：`samePath()` 分隔符归一 + Windows 忽略大小写。
- 干净缓冲：静默重载 + `markClean`；脏缓冲：留冲突提示条（重新加载 / 保留我的修改），绝不覆盖。
- 点「保留我的修改」会记住那份磁盘内容，同一份不再重复弹提示；磁盘内容再变才重新提示。
- 兜底：`pi:refresh-files`（助手回合结束）时对所有打开文件读盘比对一次，不依赖事件送达。

**已知未覆盖**：媒体 / PDF 仍只递增 `version` 刷新预览；终端不参与文件文档层。

---

## 17. 交付后自查（第二轮修正）

第一轮"全部实现"之后又做了一遍针对性复核（读代码 + 补测试），发现并修掉 4 处真实问题：

| # | 问题 | 影响 | 修正 |
|---|---|---|---|
| 1 | 剪贴板写在沙箱 preload 里，`clipboard` 模块不可用 | 需求 1 的主路径一直失败，只剩 `execCommand` 兜底 | 改为 `clipboard:writeText` IPC，由主进程写；`copyText()` 兼容同步/异步桥，新增 2 个测试 |
| 2 | `GitView` 的 PR 链接仍是 `target="_blank"` | 需求 3 的同类死链（Git 面板里点不动） | 改走 `api.openExternalUrl`；全仓无 `target="_blank"` |
| 3 | 插话成功后如果本轮没再产出，`steerPending` 永远为真 | "等待当前步骤结束"永久挂在消息上 | 曾用轮末 `finishAllStreaming` 清标记；该项随需求 8 整体撤销，已不存在 |
| 4 | "保留我的修改"后同一份磁盘差异会反复弹提示 | 每回合都跳一次冲突条 | 记住被忽略的那份内容，磁盘再变才重新提示 |

**这一轮确认无法自我验证的**：

- **可访问性 / 视觉**：Paper / Ink 双主题截图（设计规范要求）跑不了窗口，只能确认样式类已生成进 CSS（`border-l-success` / `border-rule-hairline` / `bg-raised`）。
- **需求 6 的复现**：日志定位到 `MonacoEditor` 的 `Model is disposed!`，所有读写路径都加了 `isDisposed` 守卫 + 面板级错误边界；但没有稳定复现序列，所以是"同类崩溃不再整窗白屏"，不是"根因已复现"。
- **需求 8 的一半**：设置 `runWhileBusy: "queue"` + SDK 只在"当前步骤结束、下一次 LLM 调用前"注入，决定了插话天然有延迟；UI 侧（位置、提示、回滚）已修，"立即打断当前步骤"做不到。

**另外修正了一处自己制造的噪音**：中途对改动过的文件跑了一遍 `prettier --write`（仓库里有 `.prettierrc.json`），但仓库实际代码不是 prettier 3 排版的，导致 diff 里混进约 900 行纯格式变更。已用三方合并（`ours = 现文件`、`base = prettier(HEAD)`、`theirs = HEAD`）还原成仓库原有排版，只保留语义改动：`35 files changed, 1072 insertions(+), 351 deletions(-)`（原为 1407 / 1004）。还原后 `tsc` ×2、`eslint`、`vitest`（107 文件 / 1013 用例）、`build:renderer`、`build:main` 全部复跑通过。


---

> 本文件是临时方案稿（`docs/reports/`）。后续建议：把 §14 的产品取舍并入 `docs/progress/BACKLOG.md`（若仍有待定），随后删除本文件。

