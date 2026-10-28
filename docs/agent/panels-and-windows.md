# 面板、辅助窗口与托盘

> **面向**：要改面板拆出、辅助窗口、托盘、通知的人
> **什么时候读**：动 `electron/aux-window.ts`、`tray.ts`、`src/panelHost/*` 之前
> **什么时候要改**：窗口白名单、`pi-panel:` 契约、托盘行为变化时

> 设计决策在 [ADR-001](../decisions/ADR-001-detachable-panels.md)（面板拆出）与 [ADR-002](../decisions/ADR-002-tray-resident-main-window.md)（托盘常驻）。

## 1. 面板拆出窗口

机制：`window.open('about:blank', 'pi-panel:<host>')` + React `createPortal` —— **同一 renderer、同一份 store、同一个 JS 上下文**，只是 DOM 落在子文档里。子文档 `script-src 'none'`，永不执行脚本。

动手时必须守住：

| 约束 | 原因 |
| --- | --- |
| 主进程窗口白名单只放行 `about:blank` + `pi-panel:` 前缀（`AUX_FRAME_PREFIX`） | 否则等于开了任意开窗的口子 |
| `pi-panel:` 前缀与 `HostId` 格式在 `electron/aux-window.ts` 与 `src/panelHost/types.ts` **逐字一致** | 进程边界字符串是隐式契约，混用会静默失败（按钮"点了没反应"） |
| 一切"窗口级" API 走 `useHostDocument()` / `useHostKeydown()`，不用裸 `window` / `document` | 面板可能活在子文档里 |
| 窗口命令必须显式带 `frameName`（`pi-panel:aux:<n>`） | 一套 IPC 服务所有窗口（主窗口 + 每个辅助窗口），不带就无法确定目标窗口 |
| 拆出的面板在主窗口保持挂载但 `hidden` | portal 需要组件树活着；面板组件必须容忍"不可见但 mounted" |
| 面板宽度 / 宿主归 `panelStore`（运行期，不落盘） | 重启回默认布局，与"退出不自动恢复工作区"一致 |
| 终端 PTY 归 `terminalStore` | 拆窗只重建 xterm 视图，PTY 与尾部缓冲不能重建 |

- 关闭辅助窗口 = 面板回位；主窗口侧不提供"定位 / 还原"入口。
- 最小尺寸 320 × 220；外壳与主窗口一致（Windows / Linux 无边框自绘按钮，macOS `hiddenInset`）。
- 频道：`aux:drag-begin`（拖动起点）、`aux:detach-at`（拖出落点）、`aux:window-command`、`aux:window-state`。起点与落点都由主进程用 `screen.getCursorScreenPoint()` 取，混合 DPI 下不失真；渲染层不自己算坐标。
- 拆出判据：光标离开窗口 **或** 拖动距离 ≥ 96 DIP（`PANEL_DETACH_DISTANCE`，与面板头同宽量级）——短促误拖不会拆窗。
- 辅助窗口是**登记过的 IPC 来源**（`trustIpcSender` / `untrustIpcSender`，见 [ipc-and-trust §1](ipc-and-trust.md)），所以拆出面板里的复制、外链、会话操作都可用；但主进程窗口白名单不受影响，仍然只放行 `about:blank` + `pi-panel:`，其它 URL 一律 deny（`isExternalUrl()` 命中的交给 `shell.openExternal`）。
- 布局**不做**持久化。

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

## 4. 自定义协议

应用走自定义协议 `pw-app://bundle/` 加载（不同 `file://` URL 的 origin 不一致，会阻碍跨文档操作）；`pw-file://` 是只读文件协议，供图片 / 音频 / 视频 / PDF / HTML 预览使用，只允许 `GET` / `HEAD` 且限定在受信任根内。新增协议时要同步 `electron/app-protocol.ts`、`electron/scheme-privileges.ts` 与 `vite.config.ts` 的 CSP。

## 5. 启动窗口形变

`electron/window-morph.ts` 只做启动时的小尺寸 → 工作台尺寸插值（`easeOutCubic` + 边界插值），不依赖 Electron，主进程注入 `apply`、测试注入时钟。它**不是**面板窗口迁移逻辑，不要混用。
