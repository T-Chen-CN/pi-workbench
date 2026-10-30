# IPC 与信任边界

> **面向**：要新增或修改 IPC 的人
> **什么时候读**：动 `electron/ipc/`、`preload.cts`、`src/api/` 之前
> **什么时候要改**：注册方式、来源校验、频道约定或 CSP 变化时

> 渲染进程没有任何 Node 权限，所有文件系统、子进程、safeStorage、PTY 操作都必须过 IPC。
> 频道全表与进程模型见 [PROJECT_STRUCTURE](../architecture/PROJECT_STRUCTURE.md)。

## 1. 三条铁律

1. **新增 handler 一律用 `handleIpc()`**（`electron/ipc/register.ts`）。仓库里唯一出现 `ipcMain.handle` 的地方就是 `register.ts` 自身。
2. **频道落在 `electron/ipc/` 下**，按域就近归文件（不是一域一文件）：`agent.ts` = `agent`（36）；`git.ts` = `git`（22）+ `github`（7）；`files.ts` = `fs`（8）+ `draft`（4）+ `workspace`（1）；`workspace.ts` = `workspace`（4）+ `fs`（2）+ `dialog`（1）+ `app`（2）；`system.ts` = `terminal`（5）+ `update`（5）+ `window`（4）+ `plugins`（4）+ `app`（4）+ `shell`（1）+ `clipboard`（1）+ `log`（1）；`settings.ts` = `app`（2）；`api-config.ts` = `apiConfig`（3）；`web-search.ts` = `webSearch`（2）。几处跨域共处一文件是因为它们共享同一份上下文（例如 `files.ts` / `workspace.ts` 都要用工作区信任判定）。**唯一例外**：`aux:*`（4 个）在 `electron/aux-window.ts` 里注册——它要用该模块私有的窗口登记表。装配入口是 `main.ts` 调的 `register<Domain>Ipc(context)`。
3. **不要绕过 contextBridge**：`nodeIntegration` 关闭，只暴露 `window.electronAPI`。

直接写 `ipcMain.handle` 会跳过来源校验——这正是 `handleIpc` 存在的唯一原因：

```ts
// electron/ipc/register.ts
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (typeof app.isReady !== 'function') return true   // 测试替身
  if (!app.isReady()) return true
  const mainWindow = getMainWindow()
  const fromMain = Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
  if (!fromMain && !trustedAuxSenders.has(event.sender.id)) return false
  // 子框架不能借用窗口身份（about:blank 子框架会继承同一 webContents）
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false
  return true
}
```

校验失败返回 `{ success: false, error: 'Untrusted IPC sender' }`（**fail-closed**，不是放行也不是抛错）。

**面板辅助窗口是登记的例外**：拆出的 `BrowserWindow` 由 `window.open('about:blank')` 创建、加载同一段 preload，`electron/aux-window.ts` 在窗口创建时 `trustIpcSender(webContents)` 登记、销毁时 `untrustIpcSender` 移除，因此拆出的面板可以直接调 IPC（复制、外链、会话、工作树 chip 等都照旧可用）。登记表只存 WebContents id，不扩大文件写入权限；子框架仍然被拒（见上面最后一行）。细节见 [panels-and-windows](panels-and-windows.md)。

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

## 4. 频道分布（18 域 / 124 个 handler）

`agent 36` · `git 22` · `fs 10` · `app 8` · `github 7` · `workspace 5` · `terminal 5` · `update 5` · `draft 4` · `plugins 4` · `window 4` · `aux 4` · `apiConfig 3` · `webSearch 2` · `shell 1` · `log 1` · `dialog 1` · `clipboard 1` · `attachment 1`。

按域的频道摘要（含每个频道的作用）在 [PROJECT_STRUCTURE §5](../architecture/PROJECT_STRUCTURE.md)，新增频道时同步那一节。

## 5. 工作区信任

- 工作区根目录只能由主进程批准：原生目录选择器的结果，或启动时从 `data/workspaces.db` 载入的最近工作区。
- 文件写 / 删 / 改只允许发生在受信任工作区与 `{appDir}/cache/` 内；判定用 `realpath` 规范化后 `path.relative` 检查包含关系（`electron/workspace-trust.ts`），不接受前缀字符串比较。
- 监听（`fs:watch`）走单独的 `resolveWatchableRoot()`：受信任根**及其内部子目录**可监听（会话绑定的 Git 工作树在根目录下），但监听不等于可写，写 / 删 / 改仍走 `resolveAllowedFileTarget()`。
- 渲染层传入的路径一律先规范化再校验；`editor-tabs.json` 这类记录只存**相对路径**，读回时重新校验是否仍在工作区内。

### 5.1 工作区之外的附件（`attachment:pick`）

聊天附件可以指向任意位置的文件（桌面 / 其他盘 / 网络盘 / 可移动盘），但**没有放宽 `resolveAllowedFileTarget()`**：

- `attachment:pick` 走原生 `dialog.showOpenDialog`（`openFile` + `multiSelections`，无格式过滤），只回传**路径与元信息**（名字 / 大小 / mtime / MIME），内容不经过渲染层。
- 唯一例外是图片：视觉通道只能收内容，所以主进程读一次并回传 base64（单文件 ≤32MB），渲染层再走既有的压缩与上限管道。
- 文件内容由 Agent 在**主进程里用自己的 `read` / `bash` 工具**按路径读取，那条链路本来就不受工作区限制（见 [agent-runtime](agent-runtime.md)）；渲染层始终没有“传任意路径读内容”的能力。
- 因此“选择附件”这个动作本身就是授权，不引入白名单、不引入二次确认；旧的 `fs:readFile` 仍然只服务编辑器与预览，工作区外路径依旧被拒。

## 6. Web 调试桥

`vite.config.ts` 里有三个开发期插件：`devModelsProxy`（`apply: 'serve'`，代发 `/models` 请求，避开 CORS，Key 走请求头）、`devAgentBridge`（`apply: 'serve'`，在 Node 里跑同一套 `AgentManager`，通过 SSE 输出）、`contentSecurityPolicy`（`apply: 'build'`，只在打包产物里注入 CSP）。

浏览器环境没有 `electronAPI` 时，`src/api/index.ts` 自动回退到 HTTP / mock，因此**新增 API 时两套实现都要过一遍**。

## 7. CSP 约束（生产）

`script-src 'self'`：**不要引入内联脚本或远程脚本**。`style-src` 允许 inline（Monaco 运行时注入 `<style>`）；`worker-src 'self' blob:`（Monaco worker）；`img-src`/`media-src`/`frame-src`/`connect-src` 额外允许 `pw-file:`（只读文件协议）。新增资源协议时必须同步改 `CONTENT_SECURITY_POLICY`。
