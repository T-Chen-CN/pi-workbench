# ADR-002 主窗口关闭常驻托盘

- **状态**: 已采纳（2026-10-28）
- **影响范围**: `electron/main.ts` 的窗口生命周期、新增 `electron/tray.ts`、`config/settings.json`、设置「通用」分节、托盘资源
- **相关文档**: [设计系统 6.13](../design/DESIGN_SYSTEM.md)、[设计系统 6.7](../design/DESIGN_SYSTEM.md)

## 背景

Agent 会话、终端 PTY、文件监听与更新检查都跑在主进程里，与主窗口是否可见无关。但在此之前：

- 点 `X` 直接走 `app.quit()`：正在跑的会话（尤其长任务、后台工作区）与终端进程一起被杀；
- 用户想让它继续跑，只能把窗口最小化并一直占着任务栏。

诉求：点 `X` 时把界面收起来，任务继续跑；想回来时从托盘点一下即可，窗口回到原位置、原尺寸。

## 决策

**主窗口 `X` = 收进托盘，进程存活。** 真退出只保留两个入口：托盘菜单「退出」与系统级退出（Cmd+Q、关机）。

| 事项 | 决定 |
| --- | --- |
| 开关 | 设置「通用 → 关闭主窗口」复选框，`config/settings.json` 的 `closeToTray`，默认 `true`；保存后托盘即时创建 / 销毁 |
| 真退出判定 | `before-quit` 置 `quitting = true`（`app.quit()` 与系统退出都会触发），`close` 处理器据此放行；托盘「退出」不直接 `destroy()` 窗口，仍走 `app.quit()` 让 `will-prevent-unload` 生效 |
| 未保存确认 | 收进托盘**不拦**：窗口只是 `hide()`，渲染进程不卸载，`beforeunload` 不会跑；只有真退出才弹「还有未完成的工作」。真退出时若主窗口正隐藏，先 `show()` 再弹原生框，否则确认框会挂在不可见窗口上 |
| 取消退出 | `will-prevent-unload` 选「取消」时把 `quitting` 复位，关闭按钮回到「收进托盘」语义 |
| 托盘图标 | Windows / Linux 用彩色 `app-icon.ico`；macOS 菜单栏用单色 π 模板图 `tray-template.png`（16 / 32 两档，`setTemplateImage`，跟随系统深浅色，不区分 Paper / Ink）。模板图由 `scripts/make-tray-icon.mjs` 从 `app-icon.png` 生成：取浅色像素作 alpha 掩膜、裁掉署名、面积平均降到 16 / 32 |
| 托盘菜单 | 系统原生菜单（`Menu.buildFromTemplate`）：显示主窗口 / 分隔线 / 退出；文案跟随应用语言，设置保存后 `refreshTray()` 重建 |
| 唤回入口 | 托盘图标（Windows 单击即显示）、第二个实例（`second-instance`）、macOS Dock（`activate`）；统一 `restore()` → `show()` → `focus()` |
| Linux | 不创建托盘：GNOME 等桌面默认没有托盘区，收进去可能再也找不回来。关闭按钮降级为最小化到任务栏 |
| Windows 托盘失败 | `resolveCloseAction` 退回真正关闭，避免窗口藏起来却没有入口 |
| 首次提示 | Windows 首次收起用托盘气泡（`displayBalloon`）说明一次，每次启动至多一次；不使用应用内 Toast 或模态框 |
| 辅助窗口 | **完全不跟随**：主窗口收托盘时它们留在屏幕上，主窗口恢复时也不动它们；关闭辅助窗口照旧回位（即使主窗口正藏着，也静默回位，不唤醒、不重新拆出） |
| `window-all-closed` | 保持原样：收托盘时窗口只是隐藏不会触发；真关闭后托盘已无意义，非 macOS 直接退出 |

## 备选方案

- **`app.hide()` / 全部窗口最小化**：仍是任务栏图标，做不到「藏起来但活着」，也解决不了「窗口占着任务栏」。
- **窗口 close 时先问「最小化还是退出」**：每次都要回答，且问题本身对「继续跑」的诉求答非所问；默认行为应该直接对。
- **`autoHideMenuBar` 式隐藏 + 全局快捷键唤回**：与现有快捷键体系冲突，且用户不知道快捷键就彻底失联。

## 后果

- 后台任务不再随 `X` 被误杀；退出变成需要主动选择的动作（托盘菜单 / Cmd+Q）。
- 应用常驻内存与托盘图标；关闭窗口不再释放渲染进程内存。
- 主窗口藏在托盘期间下载完成的更新不会弹窗，打开主窗口才提示（更新状态在渲染层内存中，未丢）。
- 设置新增一个持久化字段：`closeToTray`。渲染层 `persistAppSettings` 每次先读磁盘再合并，主进程不会因为渲染层用旧副本保存而丢字段。
- 测试：`tests/tray.test.ts` 覆盖 `resolveCloseAction` 平台矩阵、菜单文案、托盘创建 / 销毁 / 语言切换与首次气泡；`tests/settings-store.test.ts` 覆盖 `closeToTray` 默认值与 hydrate。
