# 面板、辅助窗口与托盘

> **面向**：要改面板拆出、辅助窗口、托盘、通知的人
> **什么时候读**：动 `electron/aux-window.ts`、`tray.ts`、`src/panelHost/*` 之前
> **什么时候要改**：窗口白名单、`pi-panel:` 契约、托盘行为变化时

> 设计决策在 [ADR-001](../decisions/ADR-001-detachable-panels.md)（面板拆出）与 [ADR-002](../decisions/ADR-002-tray-resident-main-window.md)（托盘常驻）。

## 1. 面板拆出窗口

机制（Phase E 修订）：**独立原生 `BrowserWindow` + 跨窗状态同步** —— 主进程通过 `panel:detach` IPC 派生真正的独立 `BrowserWindow`，直接加载 `pw-app://bundle/index.html?windowMode=panel&panel=<id>&workspace=<path>&hostId=<id>&...`（开发态为 `VITE_DEV_SERVER_URL`），由 `src/main.tsx` 挂载 `DetachedPanelApp`（内置 `<PanelWindowFrame>` 与 `<DiffViewer>`）。已彻底移除旧版 `window.open('about:blank')` 与跨文档 React `createPortal`。

动手时必须守住：

| 约束 | 原因 |
| --- | --- |
| `setWindowOpenHandler` 一律拒绝内部弹窗（含 `about:blank` + `pi-panel:`），仅允许可信来源拉起外部 `http(s)://` 链接 | 彻底收紧开窗面，所有面板拆窗必须经 `panel:detach` IPC 校验受信任工作区、合法面板 ID 与 `^aux:\d+$` hostId |
| 拆出窗口 **禁止设置 `parent: mainWindow`**（Q5） | 主窗口点 `X` 收进托盘（`hide()`）时，拆出窗口必须继续留在屏幕上可见 |
| 创建窗口时立即缓存数值 `wcId = child.webContents.id` 并登记 `trustIpcSender(wcId)`，`closed` 时按数值 `untrustIpcSender(wcId)` 注销 | 窗口销毁后读 `child.webContents` 会抛 `Object has been destroyed`，会导致面板回位与注销失败；帧来源仅放行 `pw-app://bundle/` 或开发服务器同源（不再放行 `about:blank`） |
| `pi-panel:` 前缀与 `HostId` 格式在 `electron/aux-window.ts` 与 `src/panelHost/types.ts` **逐字一致** | 窗口注册表按 `pi-panel:aux:<n>` 寻址，混用会让窗口控制命令静默失败 |
| `PanelSlot` 拆出后返回 `null`，`WorkspaceView` 不再保留隐藏 DOM | 面板运行在独立原生 `BrowserWindow` 内，主窗口侧 100% 让位给编辑器并释放渲染开销 |
| 跨窗状态通过 `sync:broadcast` → `sync:state` 同步，入站应用必须受回声防护 | 主题、语言、活跃会话、文件打开、面板 UI 快照与 `panel-docked` 实时一致，且不形成广播死循环 |
| 终端 PTY 与 200KB 回放缓冲由主进程 `TerminalManager` 持有并通过 `terminal:list` 暴露 | 拆窗或回位时 `terminalStore` 自动接管运行中 PTY 并回放历史，不重启 shell |
| 面板宿主归 `panelStore`（运行期，不落盘）；仅 `panelWidths` 持久化 | 应用重启后全部面板默认回位到主窗口（Q5） |

- **Q5 窗口生命周期**：
  1. 主窗口点 `X` 收进托盘（`mainWindow.hide()`）时，所有独立拆出面板窗口保持可见，不被连带隐藏；
  2. 关闭独立拆出面板窗口（系统 `X`、窗口按钮或标题栏「还原到主窗口」`panel:dock`）即通知主窗口回位（`aux:window-closed` + `sync:state` `panel-docked`）；
  3. 真正退出应用（`before-quit`）或主窗口彻底销毁（`closed`）时调用 `closeAllDetachedPanelWindows()` 统一收尾；重启后所有面板默认回位主窗口。
- 跨窗事件广播：主进程将 `fs:changed`、`git:changed`、`git:worktree-deps`、`terminal:data`、`terminal:exit`、`agent:approval-request`、`agent:approval-resolved`、`agent:session-title`、`agent:session-root-changed`、`agent:host-crashed`、`plugins:changed` 广播至所有存活 `BrowserWindow`；拆出 Chat 窗口调用 `agent:initialize` / `agent:chat` 时自动绑定独立的 `utilityProcess` 直连 `MessagePort`。
- 最小尺寸 320 × 220；外壳与主窗口一致（Windows / Linux 原生 `titleBarStyle: 'hidden' + titleBarOverlay`，macOS `hiddenInset`；无 overlay 时回退自绘按钮），`maximize` / `unmaximize` 状态同时推送给主窗口与拆出窗口自身。
- 频道：`panel:detach`、`panel:dock`、`sync:broadcast` / `sync:state`、`terminal:list`，以及既有 `aux:drag-begin`（拖动起点）、`aux:detach-at`（拖出落点）、`aux:window-command`、`aux:window-state`、`aux:window-closed`。起点与落点仍由主进程用 `screen.getCursorScreenPoint()` 取，混合 DPI 下不失真；拆出判据保持光标离开窗口 **或** 拖动距离 ≥ 96 DIP（`PANEL_DETACH_DISTANCE`）。

## 2. 主窗口关闭与托盘常驻

- 主窗口 `X` 默认**收进托盘**（`config/settings.json` 的 `closeToTray`，默认 `true`）：进程、Agent 会话、终端、文件监听与更新定时器全部继续运行。
- 真退出只有两个入口：托盘菜单「退出」（`app.quit()`）与系统级退出（Cmd+Q / 关机）。`before-quit` 置 `quitting` 标志，`close` 处理器据此放行。
- 收进托盘**不拦未保存确认**：只是 `hide()`，渲染进程不卸载；`will-prevent-unload` 只属于真退出路径（真退出时若主窗口藏着，先 `show()` 再弹原生确认框）。
- ❌ 禁止让关闭按钮直接 `app.quit()`（会连带杀掉会话与终端），也禁止在收进托盘时弹未保存确认。
- 图标：Windows / Linux 用彩色 `app-icon.ico`；macOS 菜单栏用单色 π 模板图 `tray-template.png`（由 `scripts/make-tray-icon.js` 从 `app-icon.png` 生成，`setTemplateImage` 跟随系统深浅色）。
- 菜单为系统原生菜单，只有文案跟语言：显示主窗口 / 分隔线 / 退出；设置保存后 `refreshTray()` 即时重建。
- Windows 首次收起弹一次托盘气泡（每次启动至多一次）；macOS / Linux 不提示。
- 唤回：托盘图标（Windows 单击即显示）、第二实例、macOS Dock（`activate`）；都先 `restore()` 再 `show()` + `focus()`。
- Linux **不创建托盘**（桌面环境支持不一致），关闭降级为最小化到任务栏；Windows 托盘创建失败时退回真正关闭，不把窗口藏起来。
- ❌ 辅助窗口不跟随主窗口隐藏 / 恢复：主窗口收托盘时它们留在屏幕上，唯一出口是关闭 → 面板回位（不唤醒、不重新拆出）。
- ⚠️ 已知取舍：主窗口藏在托盘期间下载完成的更新不会弹窗，打开主窗口时才提示（状态在渲染层内存里）。

## 3. 通知

`electron/notifications.ts` 只在应用**不在前台**时发系统通知；类型 `approval` / `complete` / `error` 各有独立开关（`settings.json` 的通知配置），`enabled` 为总闸。新增通知类型时同步 `NotificationKind`、prefs 归一化和设置界面。

点击后的去向由渲染层决定（`app:notify-click` 载荷带 `workspaceDir` + `sessionId`）：切到对应工作区并激活会话。

## 4. 自定义协议

应用走自定义协议 `pw-app://bundle/` 加载（不同 `file://` URL 的 origin 不一致，会阻碍跨文档操作）；`pw-file://` 是只读文件协议，供图片 / 音频 / 视频 / PDF / HTML 预览使用，只允许 `GET` / `HEAD` 且限定在受信任根内。新增协议时要同步 `electron/app-protocol.ts`、`electron/scheme-privileges.ts` 与 `vite.config.ts` 的 CSP。

## 5. 启动窗口

`electron/boot-window.ts` 直接以正常工作台尺寸居中打开主窗口，不再播放 1s `setBounds` 启动形变动画（原 `electron/window-morph.ts` 已移除），渲染层就绪或兜底超时后立即切入主界面。
