# ADR-001 面板拆分为独立窗口

- **状态**: 已采纳（2026-10-28）
- **影响范围**: 渲染进程外壳、辅助窗口、文件树 / Git / 聊天 / 终端四个面板、toast 与对话框
- **相关文档**: [设计系统 6.12](../design/DESIGN_SYSTEM.md)

## 背景

文件树、Git、聊天、终端常驻在同一窗口里，双屏或超宽屏用户希望把其中一块拖到另一块屏幕上，同时保留同一份运行状态（正在跑的 PTY、正在流式输出的会话）。诉求有两类：

1. **拆分**：把面板变成独立窗口，原窗口继续工作；
2. **挪动**：面板在窗口之间移动，返回时状态还在（滚动位置、展开的目录、shell 历史）。

不做的部分：窗口内拖拽重排布局、布局持久化、把 Monaco / Diff / 设置拆出去。

## 决策

**单 renderer + 子文档 portal**：面板不新开渲染进程，而是 `window.open('about:blank', 'pi-panel:<id>')` 开一个同源文档，再用 React `createPortal` 把面板子树渲染进那个 document。

- 同一份 React 树、同一份 Zustand store、同一个 JS 上下文；
- 状态天然只有一份，不需要跨进程同步，不存在「复制出来的聊天面板有两个输入框」这类问题；
- 子文档 `script-src 'none'`，永不执行脚本，只是 DOM 落点。

配套约束：

| 事项 | 决定 |
| --- | --- |
| 应用加载方式 | 改用自定义协议 `pw-app://bundle/`，否则不同 `file://` URL 的 origin 不一致，跨文档操作受限 |
| 辅助窗口外壳 | 系统原生标题栏（`frame: true`），窗口内只加 32px 信息栏与回位按钮 |
| 关闭辅助窗口 | 等于停靠回主窗口 |
| 原位置 | 渲染 `EmptyState` 占位（含「定位到独立窗口 / 还原到主窗口」），布局不塌陷，主窗口保持展开 |
| 入口 | 面板头部右键菜单 + 12px 拖出柄，不新增常驻按钮 |
| 拖出判定 | `dragend` 调主进程 `aux:detach-at`，由主进程读真实光标位置与工作区，渲染层不自己算 |
| 终端 PTY | 所有权升到 `terminalStore`，拆窗只重建 xterm 视图，PTY 与 200KB 尾部缓冲留在 store |
| 走动时带走的手感 | 展开的目录、文件树 / Git 滚动位置放 `panelUiState`（运行期内存，不落盘）；骨架树必须逐字复用 `listDirectory` 给出的路径写法（Windows 反斜杠），且首轮加载完成前不写回，否则空树会盖掉好快照 |
| toast / dialog | 每个窗口各挂一份，按「哪个窗口持有焦点」决定落点 |
| 布局持久化 | 不做。重启回默认布局，与「退出不自动恢复工作区」一致 |

## 备选方案

| 方案 | 否决原因 |
| --- | --- |
| 每个面板一个 `BrowserWindow` + 独立 renderer | 状态要跨进程同步（流式输出、审批、终端缓冲），等于给每个面板再造一套 IPC；同一份 store 的「移动」语义会退化成「复制 + 对齐」 |
| `BrowserView` / `WebContentsView` 在窗口间搬迁 | 需要主进程持有布局与视图生命周期，React 侧拿不到 DOM，现有面板组件要整体重写成视图容器 |
| 原生窗口贴靠（只做窗口最大化/分屏） | 不满足「面板独立、互不遮挡」的核心诉求 |
| 面板内拖拽重排布局 | 与拆窗正交，收益低、回归面大，单独评估 |

## 后果

**收益**

- 拆窗零状态迁移成本：会话流式输出、审批队列、终端 PTY 全程不断；
- 主题 / 语言一次镜像即同步，不需要重开窗口；
- 面板组件完全复用，`PanelSlot` 之外没有第二套渲染路径。

**代价与约束**

- 一切「窗口级」API 都不能再用裸 `window` / `document`：keydown、焦点、portal 落点必须走 `useHostDocument()` / `useHostKeydown()`；`ui.tsx` 的 `PopoverMenu` / `Modal` 已改为按自身文档解析；
- 子文档里的样式依赖 `<link>` 绝对化与 `<base>`，新增资源要检查路径；
- 需要守住主进程的窗口白名单（只放行 `about:blank` + `pi-panel:`），否则等于开了一个任意开窗的口子；
- 拆出的面板在主窗口保持挂载（`hidden`）——portal 需要组件树活着，不能真卸载，因此面板组件必须容忍「不可见但 mounted」。

## 落地位置

- 主进程：`electron/app-protocol.ts`、`electron/aux-window.ts`、`electron/main.ts`（`installAuxWindowSupport` + `registerAppProtocol`）
- 渲染层：`src/panelHost/{types,focus,auxWindow,HostContext,panelLabels,panelDrag,panelUiState}.ts`、`src/store/panelStore.ts`、`src/components/{PanelSlot,PanelWindowFrame,PanelContextMenu,PanelDragHandle}.tsx`
- 面板接入：`WorkspaceView.tsx`（`PanelSlot` 包裹 + `sidebarShown / chatShown / terminalShown`）、`TerminalPanel.tsx` + `src/store/terminalStore.ts`
- 测试：`tests/aux-window.test.ts`、`tests/panel-slot.test.tsx`、`tests/panel-store.test.tsx`、`tests/panel-drag.test.tsx`、`tests/terminal-store.test.ts`、`tests/chat-detach.test.tsx`、`tests/file-panel-detach.test.tsx`

## 后续可评估

- 多显示器 / 高 DPI 下的拖出落点复测（`computeDetachedRect` 已按工作区夹取，未在 4K + 200% 缩放组合上实测）；
- 面板「拖回主窗口」停靠（当前靠关闭窗口回位）；
- 布局持久化（需要先明确「重启恢复窗口」与当前「退出不恢复工作区」的策略冲突）。
