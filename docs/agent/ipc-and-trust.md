# IPC 与信任边界

> **面向**：要新增或修改 IPC 的人
> **什么时候读**：动 `electron/ipc/`、`preload.cts`、`src/api/` 之前
> **什么时候要改**：注册方式、来源校验、频道约定或 CSP 变化时

> 渲染进程没有任何 Node 权限，所有文件系统、子进程、safeStorage、PTY 操作都必须过 IPC。
> 频道全表与进程模型见 [PROJECT_STRUCTURE](../architecture/PROJECT_STRUCTURE.md)。

## 1. 三条铁律

1. **新增 handler 一律用 `handleIpc()`**（`electron/ipc/register.ts`）。仓库里唯一出现 `ipcMain.handle` 的地方就是 `register.ts` 自身。
2. **频道落在 `electron/ipc/` 下**，按域就近归文件（不是一域一文件）：`agent.ts` = `agent`（36）；`git.ts` = `git`（22）+ `github`（7）；`files.ts` = `fs`（8）+ `draft`（4）+ `workspace`（1）；`workspace.ts` = `workspace`（4）+ `fs`（2）+ `dialog`（1）+ `app`（2）；`system.ts` = `terminal`（5）+ `update`（5）+ `window`（4）+ `plugins`（4）+ `app`（4）+ `log`（1）；`settings.ts` = `app`（2）；`api-config.ts` = `apiConfig`（3）；`web-search.ts` = `webSearch`（2）。几处跨域共处一文件是因为它们共享同一份上下文（例如 `files.ts` / `workspace.ts` 都要用工作区信任判定）。**唯一例外**：`aux:*`（3 个）在 `electron/aux-window.ts` 里注册——它要用该模块私有的窗口登记表。装配入口是 `main.ts` 调的 `register<Domain>Ipc(context)`。
3. **不要绕过 contextBridge**：`nodeIntegration` 关闭，只暴露 `window.electronAPI`。

直接写 `ipcMain.handle` 会跳过来源校验——这正是 `handleIpc` 存在的唯一原因：

```ts
// electron/ipc/register.ts
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (typeof app.isReady !== 'function') return true   // 测试替身
  if (!app.isReady()) return true
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents) return false
  if (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame) return false
  return true
}
```

校验失败返回 `{ success: false, error: 'Untrusted IPC sender' }`（**fail-closed**，不是放行也不是抛错）。

推论：**面板辅助窗口**（拆出的独立 `BrowserWindow`）不直接调 IPC。它通过 `window.open('about:blank')` 创建，与主窗口共享同一 JS 上下文，React portal 把面板渲染进子文档，所以 IPC 调用仍由主窗口发出（见 [panels-and-windows](panels-and-windows.md)）。

## 2. 新增一个 IPC 的 4 步

| 步骤 | 文件 | 说明 |
| --- | --- | --- |
| 1 | `electron/ipc/<域>.ts` | `handleIpc('<域>:<动作>', async (_event, args…))`；先 `isTrustedWorkspacePath()` 校验工作区，再操作 |
| 2 | `electron/preload.cts` | 包一层 `ipcRenderer.invoke(...)` 暴露到 `contextBridge`（保持参数序列化友好，不传函数 / class 实例） |
| 3 | `src/types/electron.d.ts` | 补 `ElectronAPI` 上的类型 |
| 4 | `src/api/index.ts` | 封装成 `api.xxx()`，**同时补 Web 调试 mock**（浏览器里没有 `window.electronAPI`） |

新增 `main → renderer` 事件时：主进程 `webContents.send(channel, payload)`，preload 用 `ipcRenderer.on` 暴露成回调，记得在组件卸载时反注册。

## 3. 结果与错误约定

- 返回值统一是判别式对象：`{ success: true, …data }` / `{ success: false, error: string }`。
- 主进程的 `error` 是**固定英文串**（便于匹配），渲染层通过 `src/i18n/errors.ts` 映射成当前语言；未知错误原样展示，不要吞掉诊断信息。
- 事件类频道（`update:status`、`window:maximized-changed`、agent 流式 `trace`）只单向推送，不等待回执；终止 / 取消走独立 invoke 频道。

## 4. 频道分布（16 域 / 120 个 handler）

`agent 36` · `git 22` · `fs 10` · `app 8` · `github 7` · `workspace 5` · `terminal 5` · `update 5` · `draft 4` · `plugins 4` · `window 4` · `aux 3` · `apiConfig 3` · `webSearch 2` · `log 1` · `dialog 1`。

按域的频道摘要（含每个频道的作用）在 [PROJECT_STRUCTURE §5](../architecture/PROJECT_STRUCTURE.md)，新增频道时同步那一节。

## 5. 工作区信任

- 工作区根目录只能由主进程批准：原生目录选择器的结果，或启动时从 `data/workspaces.db` 载入的最近工作区。
- 文件写 / 删 / 改只允许发生在受信任工作区与 `{appDir}/cache/` 内；判定用 `realpath` 规范化后 `path.relative` 检查包含关系（`electron/workspace-trust.ts`），不接受前缀字符串比较。
- 渲染层传入的路径一律先规范化再校验；`editor-tabs.json` 这类记录只存**相对路径**，读回时重新校验是否仍在工作区内。

## 6. Web 调试桥

`vite.config.ts` 里有三个开发期插件：`devModelsProxy`（`apply: 'serve'`，代发 `/models` 请求，避开 CORS，Key 走请求头）、`devAgentBridge`（`apply: 'serve'`，在 Node 里跑同一套 `AgentManager`，通过 SSE 输出）、`contentSecurityPolicy`（`apply: 'build'`，只在打包产物里注入 CSP）。

浏览器环境没有 `electronAPI` 时，`src/api/index.ts` 自动回退到 HTTP / mock，因此**新增 API 时两套实现都要过一遍**。

## 7. CSP 约束（生产）

`script-src 'self'`：**不要引入内联脚本或远程脚本**。`style-src` 允许 inline（Monaco 运行时注入 `<style>`）；`worker-src 'self' blob:`（Monaco worker）；`img-src`/`media-src`/`frame-src`/`connect-src` 额外允许 `pw-file:`（只读文件协议）。新增资源协议时必须同步改 `CONTENT_SECURITY_POLICY`。
