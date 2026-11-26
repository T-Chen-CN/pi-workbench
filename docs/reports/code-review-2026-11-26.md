# Pi Workbench 全量深度代码评审与架构审计报告

> **面向**：项目所有者、核心开发者与后续重构执行者
> **什么时候读**：规划 P0 安全止血、P1 稳定性/性能治理、P2 架构演进或修订项目规则文件前
> **类型**：全量独立审计报告（`docs/reports/` 临时报告；评审确认后可将拆解项并入 [BACKLOG](../progress/BACKLOG.md) 或转为正式 ADR）

- **审计日期**：2026-11-26
- **代码基线**：`v0.11.2`（commit `c0621a8`）
- **审计方式**：全仓只读深度走查（覆盖全部 4 个代码域、全部构建/CI 配置、全部规范文档与 ADR、以及实际安装的 `@earendil-works/pi-coding-agent@1.3.0` / `@earendil-works/pi-ai@1.3.0` 与 `dist/` / `apps/cloud/web-dist/` 产物），并对照业界与社区主流方案完成横向比对。

---

## 一、执行摘要与全局健康度评估

### 1.1 仓库规模与热点文件画像

| 区域 | 文件数 | 代码/文档行数 | 代表性热点/膨胀文件 |
| --- | ---: | ---: | --- |
| `src/`（渲染进程） | 157 | 39,274 | `translations.ts` (2,063)、`electron.d.ts` (1,779)、`CloudView.tsx` (1,702)、`useChatPanelState.ts` (1,547)、`ChatPanel.tsx` (1,261)、`GitView.tsx` (1,164)、`RepoMapCanvas.tsx` (974)、`App.tsx` (956)、`api/index.ts` (936)、`cloudStore.ts` (890)、`chatStore.ts` (861)、`piAgentAPI.ts` (844) |
| `electron/`（主进程） | 92 | 22,394 | `cloud/task-runner.ts` (1,278)、`main.ts` (1,141)、`worktree-coordinator.ts` (862)、`git-worktrees.ts` (837)、`updater.ts` (759)、`worktree-deps.ts` (747)、`documents/ooxml.ts` (744)、`repo-map.ts` (590)、`providers-service.ts` (564) |
| `pi-bridge/`（Agent 桥接） | 35 | 9,500 | `agent-manager.ts` (**3,234**)、`cloud-protocol.ts` (740)、`text-utils.ts` (424) |
| `apps/cloud/`（云端服务与 Web） | 38 | 9,616 | `CloudWebCards.tsx` (1,181)、`src/main.ts` (1,126)、`CloudWebApp.tsx` (1,057)、`dispatcher.ts` (994)、`cloudWebClient.ts` (659)、`routes.ts` (621)、`hub.ts` (594) |
| `tests/`（扁平测试目录） | 174 | 37,975 | 单目录平铺 174 个文件 |
| `docs/`（规范与文档） | 33 | 7,459 | `DESIGN_SYSTEM.md` (992 行 / 97 KB) |
| 构建 / 打包 / CI | 8 | 665+ | `vite.config.ts` (567 行 / 22 KB)、`build/installer.nsh` (244 行) |

> **产物与静态指标**：桌面渲染产物 `dist/` 共 392 文件 / **38.36 MB**；云端 Web 产物 `apps/cloud/web-dist/` 共 319 文件 / **18.92 MB**；后端（`electron/` + `pi-bridge/` + `apps/cloud/src/`）存在 **168 处 `*Sync(` 同步阻塞调用**；源码存在 **115 处 `any`**。

### 1.2 核心诊断：四大结构性矛盾

1. **安全意图强，但边界存在多条可复现穿透链**：项目在文档与局部实现上做了大量防御（`contextIsolation`、`safeStorage`、`realpath`、fail-closed 审批），但实际存在 **12 项高危安全问题**，包含打开仓库零点击主进程 RCE、单击 `.html` 一键沙箱逃逸 RCE、开发模式跨站 RCE、悬挂软链越界写、Web 搜索 Key 暴露给 Agent `bash`、云端私钥正文明文泄漏与限速绕过。
2. **过度自研与教条铁律引发工程反噬**：一刀切“禁止 Worker/子进程”把 128 MB 同步解压与 200 MB PDF 解析压在 Electron GUI 线程；禁止 `src/components/` 建子目录直接催生了多个千行上帝组件；Node 24 已内置 `node:sqlite`，云端却手搓 10 份 JSON 文件与两套写队列；为伪便携目录维护 244 行脆弱 NSIS 卸载脚本。
3. **规则文件与代码现实严重漂移，且规则自身自相矛盾**：`npm run type-check` 不检查 `electron/`、`pi-bridge/` 和 `apps/cloud/src/`（`AGENTS.md` 自己都没察觉）；`DESIGN_SYSTEM.md` 膨胀至 992 行、版本号落后 20 版，甚至将反无障碍条款（禁用 `prefers-reduced-motion`）写入规范；多项文档宣称的约束（不接受项目扩展、diff 不推 UI、单源真相、重连 `sweepUnits`）在代码中均未兑现或恰好相反。
4. **云端双端共享率仅 ~11%，平行双写已造成线上 Bug**：桌面端 `CloudView.tsx` + `cloudStore.ts`（2,592 行）与 Web 端 `CloudWebApp.tsx` + `CloudWebCards.tsx` + `cloudWebClient.ts`（2,920 行）平行实现 ~2,000 行逻辑，已导致 Web 端已完成工单摘要永不显示、设备刷新清空用户表单等现网缺陷；同时 `ui.tsx` 把桌面 2,063 行翻译表反向拉进了云端 Web 生产包。

### 1.3 问题严重度总览

| 级别 | 数量（核心项） | 典型问题 |
| --- | ---: | --- |
| **CRITICAL (P0)** | 15 项 | 零点击项目扩展 RCE、HTML 预览一键逃逸 RCE、Vite Dev 跨站 RCE、悬挂软链逃逸、Web Key 泄漏、`task-guard` `@`/`~` 绕过、云端私钥正文泄漏、`X-Real-IP` 绕过与永久锁死、设备 Token 横向 RCE、工作树审批卡全失效、审批/Abort 死锁、未合并分支误强删、云端 diff 广播/IO 灾难、`/device/ws` 重启丢帧、`flushEvents` 丢改动清单、切语言重启所有 Agent |
| **HIGH (P1)** | 28 项 | 退出看门狗强杀未保存弹窗、第二实例弹错误框、自动更新竞态与潜在删 `cache/`、只读目录崩溃、容量单向棘轮、`bindExtensions` 缺失、思考等级语义写反、轮次切树竞态、实时分支切换失效、云端 8k/12k 压缩失效、Windows 进程树杀序写反、OOXML 10 亿槽位 OOM、`%PDF-` 源码误判、系统代理绕过 WS、冷启动懒加载失效、流式/打字重渲染风暴、拆窗 4 处断链、`RepoMapCanvas` 假 60fps、虚拟列表/SplitDiff/PDF/Terminal 缺陷、云端僵尸工单、Web 摘要不显示、CI 漏检云端、公网泄露服务器攻击面 |
| **MEDIUM / LOW (P2)** | 25+ 项 | 168 处主进程同步 IO、155 条无 Schema 校验 IPC、`writeClipboardText` 契约漂移、伪便携模式碎片化、A11y 多处违规（Modal 无 Portal、Escape 穿透、嵌套交互 ARIA、`ink-subtle` 对比度）、`translations.ts` 缺类型约束与 37 死 key、死依赖与孤立文件、规则与文档漂移 |

---

## 二、P0 安全漏洞与越权风险审计

### [CRITICAL] SEC-01：打开任意仓库即触发主进程零点击 RCE（无视 `readonly` / `plan` 模式）
- **位置**：[pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1917-L1935)
- **机理**：`AgentManager` 调用 `SettingsManager.create(config.workspaceDir, this.agentDir)` 与 `new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, ... })`，未传 `{ projectTrusted: false }` 与 `noExtensions: true`。核对实际安装的 `@earendil-works/pi-coding-agent@1.3.0` 源码确认：`SettingsManager` 默认 `projectTrusted = true`（`settings-manager.js:238`），`DefaultResourceLoader` 默认 `noExtensions = false`（`resource-loader.js:262`），`package-manager.js:2018-2037` 会自动发现并加载 `{workspace}/.pi/extensions/*.{js,ts}` 与 `{workspace}/.pi/settings.json`。
- **影响**：
  1. 用户打开任意第三方克隆仓库，无需发送对话、即使在 `readonly` 模式，仓库中的 `.pi/extensions/evil.js` 会直接在 Electron **主进程**以完整 Node 权限执行（可读取 `safeStorage`、密钥、任意文件）。
  2. 仓库中的 `.pi/settings.json` 可配置 `shellCommandPrefix` / `shellPath`。当用户在 `ask` 模式批准看似无害的 `npm test` 时，`ApprovalCard` 只展示 `args.command`（[approval-policy.ts](../../pi-bridge/src/approval-policy.ts#L201)），完全隐藏恶意前缀。
  3. 直接违背 [docs/agent/agent-runtime.md](../agent/agent-runtime.md#L138)“不接受 Pi SDK extensions”的架构声明。
- **修复**：显式向 `SettingsManager.create` 传入 `{ projectTrusted: false }`，向 `DefaultResourceLoader` 传入 `noExtensions: true`（仅通过 `additionalExtensionPaths` / `extensionFactories` 加载应用内置白名单扩展）。

### [CRITICAL] SEC-02：单击 `.html` 文件触发 1-Click 沙箱逃逸 → 完整 Electron IPC 与 OS RCE
- **位置**：[src/utils/fileKind.ts](../../src/utils/fileKind.ts#L106-L108)、[src/components/HtmlPreview.tsx](../../src/components/HtmlPreview.tsx#L84-L90)、[electron/aux-window.ts](../../electron/aux-window.ts#L243-L288)、[electron/ipc/register.ts](../../electron/ipc/register.ts#L31-L60)、[electron/file-protocol.ts](../../electron/file-protocol.ts#L169-L184)
- **完整攻击链**：
  1. 文件树单击即打开 `.html`，默认进入 `HtmlPreview` 阅读视图，渲染 `<iframe src="pw-file://local/..." sandbox="allow-scripts allow-forms allow-popups">`。
  2. 恶意 HTML 脚本执行 `const w = window.open('about:blank', 'pi-panel:pwn')`。
  3. `installAuxWindowSupport` 的 `setWindowOpenHandler`（`aux-window.ts:243-250`）**只判断 `url === 'about:blank'` 和 `frameName.startsWith('pi-panel:')`，未校验打开者是否为主框架**，放行并继承主窗口 `webPreferences`（含 `preload: preload.cjs`）。
  4. `did-create-window`（`aux-window.ts:287`）无条件把子窗口登记进 `trustIpcSender(child.webContents.id)`。
  5. 新窗口 `w` 与攻击 iframe 同源且未被注入 `script-src 'none'` CSP，同时 `preload.cjs` 在其主框架暴露 `window.electronAPI`，`isTrustedIpcSender` 显式放行 `fromAux && mainFrame && about:blank`。
  6. 攻击者通过 `w.electronAPI` 调用 `getRecentWorkspaces()` → `terminalCreate` + `terminalWrite`（或写入 `.pi-workbench/plugins/` 并启用），实现单击文件即获完整 OS 权限；同时 `pw-file://` 未下发 CSP 响应头，允许跨工作区子资源加载与外联外泄，`setWindowOpenHandler` 还会把 iframe 触发的 `http(s)/mailto` 直接送给 `shell.openExternal`。
- **修复**：
  1. `HtmlPreview` 移除 `allow-popups`；`pw-file://` 对 HTML 响应下发严格 `Content-Security-Policy` 响应头（禁外联、`frame-ancestors 'self'`）。
  2. 辅助窗口作为 ADR-001 定义的纯 DOM Portal 落点，**移除 `preload` 继承与 `trustIpcSender`**（Portal 内 React 事件本就运行在主窗口 JS Realm）；若确需打开，用主进程签发的一次性随机 Token 校验 `frameName` 并限制仅允许主框架触发。

### [CRITICAL] SEC-03：开发模式 `npm run dev` 暴露无认证跨站 RCE
- **位置**：[vite.config.ts](../../vite.config.ts#L38-L50) & [vite.config.ts](../../vite.config.ts#L103-L166)
- **机理**：`devAgentBridge` 在 `http://localhost:5173/__pi/agent/*` 暴露真实 `AgentManager`，写死 `getDefaultPermissionLevel: () => 'auto'`（全自动 `bash`/`write`），且 `readJson()` 完全不校验 `Origin`、`Host` 与 `Content-Type`。
- **影响**：本地开发期间浏览任意恶意网页，网页发送 `Content-Type: text/plain` 的简单 CORS `POST`（无需预检）即可调 `/__pi/agent/init` + `/__pi/agent/chat` 在开发机执行任意命令。
- **修复**：强制校验 `Origin` 严格匹配 `http://localhost:5173`、`Content-Type: application/json`、以及进程启动期随机 Token；或评估移除残缺的 Web dev 桥。

### [CRITICAL] SEC-04：悬挂符号链接（Dangling Symlink）逃逸工作区与云端工单工作树
- **位置**：[electron/workspace-trust.ts](../../electron/workspace-trust.ts#L15-L36)、[electron/ipc/files.ts](../../electron/ipc/files.ts#L99-L105)、[electron/cloud/task-guard.ts](../../electron/cloud/task-guard.ts#L49-L64)
- **机理**：`canonicalizePath()` 在 `realpathSync.native(current)` 抛 `ENOENT` 时未区分“路径不存在”与“悬挂软链目标不存在”，直接把段名压入 `missingSegments` 回溯父目录后拼回，导致指向工作区外未创建路径的软链（如 `workspace/trap -> C:\...\Startup\pwn.bat`）通过 `isPathInsideRoot` 校验，随后 `fs.writeFile` 跟随软链越界创建文件。两处实现均存在同一漏洞。
- **修复**：在 `catch` 分支先调 `lstatSync(current)`；若为符号链接则 `readlinkSync` 递归解析其目标路径再校验包含关系，并在写入时拒绝符号链接目标。

### [CRITICAL] SEC-05：云端 `task-guard` 路径与命令守卫存在多处简单绕过
- **位置**：[electron/cloud/task-guard.ts](../../electron/cloud/task-guard.ts#L30-L34) / [#L80-L146](../../electron/cloud/task-guard.ts#L80-L146) / [#L176-L277](../../electron/cloud/task-guard.ts#L176-L277)、[electron/cloud/task-runner.ts](../../electron/cloud/task-runner.ts#L314-L352)
- **漏洞清单**：
  1. **`write`/`edit` 前缀逃逸**：`task-guard.ts:80-83` 用 `path.resolve(cwd, input)`，而 Pi SDK `resolveToCwd`（`tools/path-utils.js:42-44`）会剥离前导 `@` 并展开 `~/`。传入 `write({ path: "@C:\\evil" })` 或 `"~/.bashrc"` 在守卫侧被当成相对路径放行，在 SDK 侧越界写入。
  2. **`pre-push` 守卫 fail-open + 简单绕过**：`task-runner.ts:349-352` 安装 hook 失败仅记警告继续执行；`git push --no-verify` 或 `git -c core.hooksPath=/dev/null push` 可绕过 hook；`GIT_PUSH` 正则可用 `g""it p""ush` / `node -e` / `git config alias.p push` 绕过，反而误杀 `git commit -m "fix push bug"` 与 `git grep push`。
  3. **`rm -rf` / `curl | sh` 绕过**：`escapingRmTarget` 忽略 `cd .. && rm -rf dir`、`/bin/rm`、`Remove-Item -Path=C:\`（`-` 开头被跳过）、软链目录 `rm -rf link/*`、PowerShell 反引号续行；`curl -o /tmp/x && bash /tmp/x` 绕过 `PIPE_TO_SHELL`；`writeTargets` 遇到白名单外参数名 fail-open。
  4. **已有工作单元绕过 `isAllowedWorkspace`**：`ensureUnitWorktree`（`task-runner.ts:314-332`）命中 `this.units` 缓存时提前返回，未复核 `isAllowedWorkspace` 与 `repoPath` 一致性。

### [CRITICAL] SEC-06：Web 搜索 API Key 明文留在 `process.env`，暴露给 Agent `bash` 及云端全部 git 子进程
- **位置**：[electron/ipc/web-search.ts](../../electron/ipc/web-search.ts#L130-L138)、[electron/cloud/task-report.ts](../../electron/cloud/task-report.ts#L238)、[electron/cloud/task-runner.ts](../../electron/cloud/task-runner.ts#L1023)、[electron/cloud/inventory.ts](../../electron/cloud/inventory.ts#L25)
- **机理**：`applyWebSearchConfig()` 把全部已保存供应商的明文 Key 写入主进程 `process.env['PI_WORKBENCH_WEB_SEARCH_KEY_*']`。虽然 `terminal-manager` 与 `worktree-deps` 做了环境清洗，但 **Pi SDK 的 `bash`/`powershell` 工具直接继承 `...process.env`**（且 SDK 提示词告知模型可检查 `PI_*` 变量）；同时 `electron/cloud/*` 的 6 处 `execFileAsync('git', ...)` 均未传 `env: sanitizedChildEnv()`；且 `main.ts:377` 自定义 `envSanitizer` 覆盖掉了 `terminal-manager.ts:83` 自带的敏感变量清单。
- **修复**：改为在 `createAgentSession` 中覆盖 `bash`/`powershell` 或注入 `spawnHook` 统一清洗 `PI_WORKBENCH_*`（Windows 不区分大小写），或改为内存传参不碰 `process.env`；统一全仓子进程环境清洗函数并补全云端 6 处 git 调用。

### [CRITICAL] SEC-07：云端脱敏 Diff 存在多行私钥明文泄漏、软链任意文件窃取与引号路径绕过
- **位置**：[electron/cloud/task-report.ts](../../electron/cloud/task-report.ts#L130-L143) / [#L272-L362](../../electron/cloud/task-report.ts#L272-L362) / [#L434-L448](../../electron/cloud/task-report.ts#L434-L448)
- **四项绕过**：
  1. **PEM 私钥正文完全明文外发**：`redactDiffLine` 逐行正则只匹配 `-----BEGIN ... PRIVATE KEY-----` 首行，将首行替换为 `[REDACTED: private-key]` 后，**第 2..N 行完整的 Base64 私钥正文原样发送至云端 `tasks.json`、所有 UI 客户端以及上游 LLM**。
  2. **软链窃取宿主机文件**：`collectTaskDiff`（440 行）与 `scanWorktreeSecrets`（274 行）调用 `fs.stat` 而非 `fs.lstat`，工单创建 `ln -s ~/.ssh/id_rsa note.txt` 即可把工作树外敏感文件（最高 64 KB）打包进 `task_result.diff`。
  3. **Git 引号路径与重命名绕过 `.env` 过滤**：`sanitizeDiffExcerpt` 用 `^diff --git a\/(.+?) b\/(.+)$` 解析路径，当文件名含空格/中文被 git 加引号（`"a/.env"`）或 `.env` 重命名为 `foo.txt`（仅校验 `b/`）时，完整内容绕过过滤。
  4. **规则与文件名黑名单缺口**：`secret-assignment` 强制要求引号，漏掉无引号 YAML、`.npmrc` `_authToken=`、DB 连接串 `postgres://user:pass@`、JWT/Bearer、Stripe `sk_live_`、`password="..."`；`EXCLUDED_DIFF_ATTENTION` 漏掉 `.npmrc`、`.pypirc`、`*.pem`、`*.key`、`credentials.json`、`.envrc`。
- **修复**：引入多行状态机脱敏 PEM 块（首行到 `-----END ...-----` 或 hunk 结束全部屏蔽）；未跟踪文件改用 `fs.lstat` 并拒绝符号链接；正确解码 git C-quoted 路径并同时校验 `a/` 与 `b/`；补齐高危文件名与密钥正则。

### [CRITICAL] SEC-08：云端认证/限速/CSWSH 多重缺陷与首次启动抢注风险
- **位置**：[apps/cloud/src/http/router.ts](../../apps/cloud/src/http/router.ts#L116-L168)、[apps/cloud/src/auth/rate-limit.ts](../../apps/cloud/src/auth/rate-limit.ts#L82-L105)、[apps/cloud/src/http/routes.ts](../../apps/cloud/src/http/routes.ts#L102-L108) / [#L165-L181](../../apps/cloud/src/http/routes.ts#L165-L181)、[apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L411-L425)
- **漏洞清单**：
  1. **`X-Real-IP` 伪造绕过单 IP 限速**：`sourceOf()` 在本机反代时优先读 `X-Real-IP`，而 Caddy 只写 `X-Forwarded-For` 并透传客户端伪造的 `X-Real-IP`。攻击者每次请求随机换头即可绕过 `limit: 5` 并驱逐 `perSource` 4096 槽位中的真实 IP。
  2. **未认证永久锁死管理员 DoS**：`AttemptLimiter` 累计 20 次失败触发**全局** 5 分钟熔断（连正确密码也返 429）。任意外部脚本每 5 分钟发 20 个错包即可永久封锁 `/v1/login` 与 `/v1/pair`。
  3. **CSWSH / CSRF 加固不足**：`isAllowedOrigin` 放行空 `Origin`（137 行）且忽略协议（`http://` 可匹配 `https://`）；`readJsonBody` 不校验 `Content-Type: application/json`。
  4. **无保护首次建号抢注**：`POST /v1/setup` 无一次性启动令牌、无限速、无 Origin 校验；任何新装或重置实例暴露公网即面临抢注接管。
  5. **响应安全头与 DoS 缺口**：JSON 响应缺 `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY`；缺 HSTS；`static.ts:50` CSP 的 `connect-src 'self' ws: wss:` 过宽；`readJsonBody` 无请求体超时（Slowloris 可绕过放在 `await ctx.json()` 之后的限速）；`Hub` 无最大连接数和 `ws.bufferedAmount` 背压检查；`sanitizeWorkspaces` 未限制数组长度。

### [CRITICAL] SEC-09：云端单 Token 零权限隔离导致跨设备横向 RCE
- **位置**：[apps/cloud/src/http/routes.ts](../../apps/cloud/src/http/routes.ts#L132-L139) / [#L345-L583](../../apps/cloud/src/http/routes.ts#L345-L583)、[apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L410-L425)
- **机理**：按 D-22 决策，单个设备配对 Token 同时可访问 `/device/ws`、`/client/ws` 和几乎全部 `requireUser` 管理接口。
- **影响**：任一辅助机器（设备 A）的 Token 泄露后，攻击者可为**设备 B** 签发 `quota: 50` 授权、向设备 B 派发 `auto` 权限 bash 工单、永久篡改云端 `SOUL.md` / `AGENTS.md` 提示词、替换云端模型配置或向设备 B 在跑工单注入 `task_message`。与 [docs/agent/cloud-agent.md](../agent/cloud-agent.md#L178-L179) 的低估表述不符。
- **修复**：将设备执行 Token 严格收敛为最小权限（仅 `/device/ws` + 上报本机工作区 + 自解绑），用户控制面（`/client/ws`、授权、模型配置、记忆/文档编辑）独立签发用户态会话或单独作用域 Token。

### [HIGH] SEC-10：跨工作区会话越权读取、重命名与删除
- **位置**：[pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L2098-L2124) / [#L2512-L2568](../../pi-bridge/src/agent-manager.ts#L2512-L2568) / [#L3132-L3138](../../pi-bridge/src/agent-manager.ts#L3132-L3138)
- **机理**：`deleteSession` 注释（2535 行）明确写着“必须先确认 id 属于当前工作区，避免跨工作区删除”，但下一行调用 `findSessionFile(sessionId)` → `SessionManager.listAll(this.sessionDir)` 对全局共享的 `{appDir}/data/agent/sessions/` **不做 `isSessionOfWorkspace` 校验**；`ensureRuntime`、`renameSession`、`appendTitleToSessionRecord` 存在同类问题。
- **修复**：在 `findSessionFile()` 内部强制用 `config.isSessionOfWorkspace(sessionId, info.cwd)` 过滤。

### [HIGH] SEC-11：插件无校验热重载、`worktree-deps` 默认执行生命周期脚本、`readonly` 外联外泄面、`fs:openExternally` 黑名单缺口
- **未沙箱插件热重载**（[electron/plugin-manager.ts](../../electron/plugin-manager.ts#L94-L98) / [#L242-L250](../../electron/plugin-manager.ts#L242-L250) / [#L485-L499](../../electron/plugin-manager.ts#L485-L499)）：仅按 `pluginId` 放行无文件哈希钉住，仓库 `git pull`/切分支/Agent 改写插件文件时 `fs.watch` 静默在主进程执行新代码；`unload` 不 await 异步 `deactivate()`；只清入口 `require.cache` 导致子模块陈旧泄漏。
- **`autoInstallWorktreeDeps` 默认 `true` 执行安装脚本**（[electron/ipc/settings.ts](../../electron/ipc/settings.ts#L24)、[electron/worktree-deps.ts](../../electron/worktree-deps.ts#L76-L99) / [#L445-L450](../../electron/worktree-deps.ts#L445-L450)）：自动跑 `npm ci`/`pnpm install` 且未加 `--ignore-scripts`（Windows 还开 `shell: true`），绑定不可信仓库工作树即触发恶意 `postinstall`。
- **`readonly`/`plan` 外联外泄与副作用**（[pi-bridge/src/tool-policy.ts](../../pi-bridge/src/tool-policy.ts#L13-L22)、[pi-bridge/src/approval-policy.ts](../../pi-bridge/src/approval-policy.ts#L145-L155)）：`read` 无工作区限制（可读 `~/.ssh/*` 等），而 `web_search`/`fetch_content` 在只读/计划模式自动放行，可通过提示词注入经 URL 外泄敏感文件，或触发 `pi-web-access` 向 `/tmp/pi-github-repos` 执行 `git clone` 落盘；此外 `approval-policy.ts:204` 仅预览 `write` 前 280 字节且 `stripAnsi` 漏防 OSC / `\r` / Unicode BiDi 欺骗。
- **`fs:openExternally` 黑名单漏网与历史工作区永久信任**（[electron/ipc/files.ts](../../electron/ipc/files.ts#L30-L35)、[electron/main.ts](../../electron/main.ts#L434)）：黑名单遗漏 Windows `.url/.scf/.inf/.chm/.iso/.vhd/.py/.docm/.xlsm`、macOS `.workflow/.scpt/.tool/.terminal`、Linux `.desktop`；`seedTrustedWorkspaces()` 启动时一次性永久信任 `workspaces.db` 里历史全部仓库，且关闭工作区不撤销信任。

### [HIGH] SEC-12：公开 MIT 仓库暴露个人生产基础设施完整攻击面
- **位置**：[docs/reports/cloud-server-feasibility-2026-11-19.md](./cloud-server-feasibility-2026-11-19.md#L8-L48)、[docs/agent/cloud-agent.md](../agent/cloud-agent.md#L255-L339)、[src/components/CloudView.tsx](../../src/components/CloudView.tsx#L623)、[apps/cloud/src/config.ts](../../apps/cloud/src/config.ts#L50)
- **问题**：公网报告文件暴露了现网 VPS 公网 IPv4/IPv6、内网 IP、云厂商区域、`ufw inactive`、`ip6tables ACCEPT`、`PermitRootLogin yes`、未装 `fail2ban`、免密 sudo 等高敏运维细节；[CloudView.tsx](../../src/components/CloudView.tsx#L623) 与 `config.ts` 等 5 处将个人生产域名写死为所有用户的默认值。
- **修复**：彻底清理仓库文档与代码中的个人域名与 VPS 拓扑信息（改用 `https://cloud.example.com` 占位符），并加固目标服务器防火墙/SSH 配置。

---

## 三、架构设计与编排缺陷（附社区/业界方案横向对比）

### 3.1 Electron 进程拓扑：“禁止 Worker/子进程”铁律把重负载与崩溃风险全压在 GUI 主线程
- **现状问题**：[AGENTS.md §4](../../AGENTS.md#L73) 与 [docs/agent/agent-runtime.md](../agent/agent-runtime.md#L12-L13) 将“禁止子进程/Worker 承载 Agent”设为铁律，并蔓延到文档解析、仓库地图扫描与插件系统。实测后端存在 **168 处 `*Sync(` 同步阻塞调用**，包括：
  - `zip.ts:157` 最高 128 MB 同步 `zlib.inflateRawSync` + 同步 XML 词法扫描 + 200 MB `pdf.js` 抽取全部在主进程运行；
  - `ooxml.ts:458-464` 缺少工作簿级总单元格预算，5 KB 构造 `.xlsx`（50 个表各引用 `AMJ19999`）可令主进程分配 ~10 亿数组槽位瞬间 OOM 崩溃；
  - `repo-map.ts:402` 同步读写最高 20 万条记录的 `repo-map.json`；
  - `draft-store.ts:82,89` 同步 `readdirSync` + `readFileSync` + `JSON.parse` 全工作区草稿（每份可达 6 MB）；
  - `logger.ts:62,77-88` 在每次 `console.*` 与不限流 `log:renderer` IPC 中同步 `fs.writeSync` + `renameSync`；
  - `workspace-store.ts:39` 同步 `DatabaseSync` 未开 `WAL` 与 `busy_timeout`；
  - 未沙箱的用户插件直接共享主进程 V8 堆与 `safeStorage`。
- **业界对照**：**VS Code / Cursor / Claude Desktop** 均采用 Electron 官方的 **`utilityProcess`**（Node.js 独立子进程 + Chromium IPC / `MessagePort`，无需本地 HTTP 端口）和 `worker_threads` 实现主进程轻量化：Main Process 仅负责窗口、菜单、托盘、原生对话框和权限仲裁，Agent 循环、索引、文档解析、插件宿主均独立隔离，单个任务 OOM 或死循环绝不拖垮编辑器与终端。
- **建议**：放开 `worker_threads` 与 `utilityProcess`：优先将 `electron/documents/*`、`repo-map.ts`、`PluginManager` 移出主线程；中期将 `AgentRegistry` 与 `CloudTaskRunner` 迁入独立 `utilityProcess`（通过 `MessagePort` 直连）。

### 3.2 IPC 层：155 条手工管道 × 5 文件样板爆炸 + 零运行时校验
- **现状问题**：目前有 **155 个 `handleIpc` 频道**（外加 `main.ts:144` 1 个绕过 `register.ts` 的裸 `ipcMain.on('app:boot-ready')`），每次新增都需手工同步 `electron/ipc/*.ts`、`preload.cts` (527 行)、`src/types/electron.d.ts` (1,779 行)、`src/api/index.ts` (936 行) / `piAgentAPI.ts` (844 行)。全链路 `...args: any[]`、零运行时入参校验，已出现多处真实漂移：
  - `writeClipboardText`（[system.ts](../../electron/ipc/system.ts#L279-L286) vs [preload.cts](../../electron/preload.cts#L54-L55) vs [clipboard.ts](../../src/utils/clipboard.ts#L46)）：主进程返 `{ success: false }`，类型谎称 `Promise<boolean>`，调用方判真把失败对象当成复制成功并跳过回退。
  - `app:saveSettings`（[settings.ts](../../electron/ipc/settings.ts#L112)）原样把任意未知键值和超大对象落盘到 `config/settings.json`；`fs:writeFile`、`terminal:write` 均未校验字符串类型与大小上限；`git:listAllWorktrees` 已注册却从未暴露。
  - `register.ts:49-50` 把测试替身放行逻辑（`!app.isReady() => true`）写死在生产安全校验里，且生产 CSP 仅靠 `<meta>`（无法防 `frame-ancestors`，开发态和 `pw-file://` 均无 CSP）。
- **业界对照**：**`electron-trpc` + Zod** 或轻量 **Schema-First Typed IPC Contract**（单一 `ipc-contract.ts` 定义频道名 + Zod 入参/返回 Schema，主进程 `handleIpc` 自动 `schema.safeParse`，Preload 与 Renderer 类型全自动推导）。

### 3.3 面板拆窗（ADR-001）：`window.open('about:blank')` + Portal 的系统性隐患
- **现状问题**：ADR-001 否决了“独立 `BrowserWindow` + IPC”，选择单渲染进程 `window.open('about:blank')` + `React.createPortal`。实际落地已经触发了几乎全部社区已知痛点：
  1. 触发 **SEC-02** 一键沙箱逃逸 RCE；
  2. [auxWindow.ts](../../src/panelHost/auxWindow.ts#L71-L89) 的 `cloneDocumentHead` 是一次性快照，**没有 `MutationObserver` 监听 `source.head`**，拆窗后动态加载的 CSS（如 Monaco/PDF/xterm/KaTeX 懒加载 chunk 与 Vite HMR）全丢失；
  3. **跨 Realm `instanceof HTMLElement` 失效**（[ui.tsx](../../src/components/ui.tsx#L267)）：`doc.body.appendChild` 会把节点 adopt 到子窗口 Realm，导致 `doc.activeElement instanceof HTMLElement` 在所有拆出窗口中恒为 `false`，`PopoverMenu` 关闭后永远无法恢复焦点；
  4. [GitView.tsx](../../src/components/GitView.tsx#L470) 与全局快捷键（`CommandPalette`、`App.tsx:370`）绑在主 `window` 上，拆窗内快捷键失灵；
  5. `closeToTray: false` 关闭主窗口时辅助窗未联动关闭，留下一堆失去 React 树的空白僵尸窗；
  6. [main.ts](../../electron/main.ts#L574-L588) 等多处把事件广播到 `BrowserWindow.getAllWindows()`，注释竟误以为辅助窗有独立渲染进程；
  7. [tokens.ts](../../src/theme/tokens.ts#L42-L56) `readThemeTokens()` 临时双切 `html.dark`，每次触发所有拆窗的 `MutationObserver` 与双倍全局样式重算。
- **业界对照**：现代 IDE 级桌面应用普遍采用 **Dockview**（原生支持多屏浮动/停靠/网格重排/布局序列化）+ **主进程管理的独立 `BrowserWindow` + 细粒度状态同步**。若短期保留 Portal 方案，必须彻底剥离辅助窗的 `preload`/`trustIpcSender`，补 `source.head` 同步、跨 Realm 类型检查与主窗关闭联动。

### 3.4 伪便携 `{appDir}` 架构与 NSIS 更新链路的复杂度反噬
- **现状问题**：强制将数据存于可执行文件同级目录已在 3 个维度破产：① 所有凭证走绑定机器/用户的 `safeStorage`，拷目录换机器后密钥全失效；② Windows 差分更新基准仍在 `%LOCALAPPDATA%\Pi-Workbench-Update` 常驻一份完整安装包；③ macOS 已退回系统 `Application Support`。但为了维护 Windows 伪便携，仓库被迫维持：
  - 244 行 [build/installer.nsh](../../build/installer.nsh)（硬编码 `StrCpy $1 $1 -2` 强假设 CRLF，LF 即截坏文件名；`.onVerifyInstDir` 静默置灰按钮无任何提示；`Delete` 无杀毒软件锁重试）；
  - `scripts/lib/installer-manifest.js`（路径 >200 字符或含非 ASCII 直接打包失败）；
  - 禁止装入 `C:\Program Files`，并与企业 AppLocker 冲突；
  - `main.ts:440` 只读目录顶层崩溃使 `ensureAppDirWritable()` 失效。
- **业界对照**：标准 per-user OS 目录（`app.getPath('userData')`）+ 独立免安装 `.zip` 便携模式（检测到 `portable` 标记文件或 `--user-data-dir` 时切换）；打包更新器可评估 **Velopack**（支持增量更新与原生 Portable 包）。

### 3.5 `AgentManager`（3,234 行）上帝类与“实时 vs 重载”双轨撕裂
- **现状问题**：
  - [pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts) 塞入了 17 个正交子系统、16 个类级可变字段和 31 字段的 `SessionRuntime` 巨型状态袋，互斥标志（`isProcessing` / `sdkStreaming` / `compactingPromise`）在 10 余个方法中检查口径各异。
  - [ADR-003](../decisions/ADR-003-session-record-single-source.md) 只把“重载与导出”统一到了 JSONL `activeTimeline()`，实时流式依然走 `chatStore` 命令式写 `parts`。[chat-render-single-source.md](../architecture/chat-render-single-source.md) 已精准诊断病根但至今未实施，实测存在 **10 处实时与重载不一致**（见 §4.1），且该设计稿假设用 `toolResult.details` 在重载时推导 `write` diff——核实 Pi SDK `tools/write.js:51` 返回 `details: undefined`，该前提本身需修正。
- **业界对照**：**OpenCode / Vercel AI SDK `UIMessage` / `assistant-ui` `MessageRepository`** 将 Runtime 按单一职责拆分为 Session 生命周期、事件投影器、Catalog 管理器、Title 服务，并以不可变 Event/Entry 流驱动唯一的 `deriveMessages()` 投影函数，同时用持久化 `entryId`（而非客户端 `Date.now()`）作为分支与 UI 锚点。

### 3.6 云端 `apps/cloud`：Node 24 环境手搓 10 份 JSON 文件 + 自造控制面 + 2,000 行前端双写
- **现状问题**：
  1. **数据层逆向造轮子**：全仓要求 Node ≥ 24（已内置 `node:sqlite`），`apps/cloud` 却把状态拆成 8 份 JSON（`accounts`/`devices`/`pairing`/`tasks`/`units`/`config`/`authorizations`/`client-state`）+ 另写一套独立写队列的 2 份记忆 JSON（`memories.json`/`dreams.json`），无跨表 ACID 事务、线性扫描、每次写盘全量序列化 + `fsync` + 回读 `JSON.parse` 覆盖 `.bak`。
  2. **代码巨石与协议零校验**：`apps/cloud/src/main.ts`（1,126 行）把 HTTP、WS、已读账本、离线摘要、配置回滚、梦境定时塞进 940 行大闭包，靠 `(session as any).deps.hub = hub` 强改内部字段打破循环依赖；`cloud-protocol.ts` 的 `decodeFrame` 纯靠 TS `as T` 强转，零运行时校验，且死锁 `v !== 1` 无能力协商（`v: 1` 还被硬编码在 12+ 处），与手动 Way B 发布的版本错配直接冲突。
  3. **前端共享率仅 ~11%**：桌面端 `CloudView.tsx` + `cloudStore.ts`（2,592 行）与 Web 端 `CloudWebApp.tsx` + `CloudWebCards.tsx` + `cloudWebClient.ts`（2,920 行）仅共享 3 个小视图（590 行），WS Frame Reducer（~405 vs ~456 行）和全部 8 个卡片/弹窗（单记忆管理页就重复 858 行）各写一份，已直接制造多个线上 Bug。
  4. **脆弱的记忆检索与“梦境整理”**：[memory-engine.ts](../../apps/cloud/src/memory/memory-engine.ts#L30-L73) / [#L261-L318](../../apps/cloud/src/memory/memory-engine.ts#L261-L318) 仅靠无停用词/无 TF-IDF 的 2-gram 集合交集检索；梦境整理向 LLM 塞入最多 200 条记忆却限制 `maxTokens: 1024`，条数超 ~50 条输出必截断，且若截断前输出了 `removeIds` 缺少回滚将永久误删自动记忆。
- **业界对照**：
  - 数据层直接用 Node 24 原生 **`node:sqlite` (WAL 模式)**，独立 `task_diffs` 表 + 索引 + 事务；
  - HTTP/WS 控制面采用 **Hono (`@hono/node-ws`)** 或 **Fastify (`@fastify/websocket`)** + **Zod** 帧校验与协议版本/能力握手；
  - 前端抽离共享 workspace 包 `packages/cloud-ui`（含统一状态机 Reducer 与全部卡片/弹窗）；
  - 若定位本质是“个人多设备远程控制本机 Agent”，业界更轻量的低运维方案是 **Tailscale** 或 **Cloudflare Tunnel + Cloudflare Access SSO**，将公网暴露面与身份认证下沉到成熟零信任网络层。

### 3.7 工作树内嵌与手写 DOM 仓库地图
- **工作树内嵌（`.pi-workbench/worktrees/`）**：把工作树建在仓库内部导致 Node 向上查找污染主仓 `node_modules`，进而倒逼出 747 行 `worktree-deps.ts` 与 `.git/info/exclude` 侵入。对照 **Claude Code / Conductor / Parallel Code**，将受管 worktree 统一放在仓库外的独立目录（如 `{appDir}/cache/worktrees/<repoHash>/<id>`）天然规避嵌套冲突。
- **`RepoMapCanvas`（974 + 559 + 590 行）**：手写 DOM 画布既没有 `@xyflow/react`（React Flow）的开箱即用平移/缩放/小地图/视口裁剪，又在节点多时受 DOM 重排制约；同时强制取代编辑器空态、禁列表视图、取消空白拖动画布并强制 `Space+左键` 拖移，显著推高学习成本。

---

## 四、高危正确性、并发竞态与数据丢失 Bug 清单

### 4.1 Agent 运行时、模型目录与 SDK 集成
| 严重度 | 问题 | 代码位置 |
| --- | --- | --- |
| **CRITICAL** | **所有链接工作树会话的审批卡完全不弹出**：传入 `workspaceDir: root`（worktree 路径）而非 `config.workspaceDir`，渲染层按主路径过滤直接丢弃 → 挂起 120s 后 fail-closed 失败，关闭工作区也取消不了审批。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1748)、[useChatPanelState.ts](../../src/hooks/useChatPanelState.ts#L223)、[approval-broker.ts](../../electron/approval-broker.ts#L138-L143) |
| **CRITICAL** | **审批挂起时 Abort / Close / Delete / Dispose 触发 AB-BA 死锁**：4 条 IPC 均先 `await agent.*()` 再调 `approvalBroker.cancel*()`，而 SDK `abort()` 会阻塞等待 `beforeToolCall` 返回；且 `approval-extension.ts:33` 忽略 `ctx.signal`。 | [ipc/agent.ts](../../electron/ipc/agent.ts#L457-L460) / [#L482-L483](../../electron/ipc/agent.ts#L482-L483)、[ipc/agent-sessions.ts](../../electron/ipc/agent-sessions.ts#L142-L143) / [#L294-L296](../../electron/ipc/agent-sessions.ts#L294-L296) |
| **HIGH** | **上下文/输出上限“单向棘轮”不可逆锁定**：`getCatalogRuntime()` 把 `modelsPath` 设成 `models.json` 而非 `null`，下调一次后新上限被当成目录上限，用户永远无法再调高。 | [providers-service.ts](../../electron/providers-service.ts#L116-L122) / [#L320-L325](../../electron/providers-service.ts#L320-L325) |
| **HIGH** | **从未调用 `session.bindExtensions()`**：导致 `worktree-extension.ts:31-43`（`resources_discover`）沦为死代码（链接工作树丢 `.pi/skills` / `.pi/prompts`），且 `pi-web-access` 的 `session_start`/`session_shutdown` 永不触发，持续泄漏 `/tmp/pi-github-repos`。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1948-L1964)、[worktree-extension.ts](../../pi-bridge/src/worktree-extension.ts#L31-L43) |
| **HIGH** | **云端工单压缩配置 `TASK_COMPACTION_SETTINGS` (8k/12k) 完全失效**：`initialize()` 写入的 `compaction.modelOverrides`（16k/20k）优先级高于顶层 `compaction`，直接覆盖。 | [task-runner.ts](../../electron/cloud/task-runner.ts#L65-L86) / [#L379-L389](../../electron/cloud/task-runner.ts#L379-L389)、[agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L782) |
| **HIGH** | **思考等级映射语义写反**：要求 `map[level] !== undefined`，与 `@earendil-works/pi-ai` 稀疏表语义（仅显式 `null` 表示禁用）相反，破坏稀疏配置模型。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L186-L190)、[providers-service.ts](../../electron/providers-service.ts#L211-L216) |
| **HIGH** | **实时分支切换（`1 / 2`）重试后失效**：渲染层与主进程各自打 `Date.now()`，精确毫秒匹配 `byTimestamp.get()` 必 miss，需重载会话才恢复。 | [chatStore.ts](../../src/store/chatStore.ts#L336) / [#L618-L625](../../src/store/chatStore.ts#L618-L625)、[session-branch.ts](../../pi-bridge/src/session-branch.ts#L38-L39) |
| **HIGH** | **实时与重载其余 9 处漂移**：① 实时插话位置倒置；② `context_edit` 实时不可见（重试失败尝试重复显示）；③ 压缩点扫 `getEntries()`（全分支）而非 `getBranch()`，且手动压缩附着错位；④ `usage` 重载消失且实时多步漏计前序步；⑤ 失败/截断/中止轮次的 `result.edits` 全部丢弃且不刷新文件树；⑥ 计划卡重载掉到对话末尾；⑦ `parentToolCallId` 重载丢失；⑧ part ID 与文本块切分口径不同；⑨ 思考计时器未按 `contentIndex` 隔离且缺时间戳回退 `Date.now()`。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L2294-L2313) / [#L2794-L2843](../../pi-bridge/src/agent-manager.ts#L2794-L2843)、[session-history.ts](../../pi-bridge/src/session-history.ts#L41-L156)、[useChatPanelState.ts](../../src/hooks/useChatPanelState.ts#L1074-L1127) |
| **HIGH** | **忙状态检查撕裂与 `dispose()` 竞态**：`isRuntimeBusy()` 漏查 `compactingPromise`；`chat()`/`compactContext`/`rewind`/`steer`/`switchBranch` 只查 `isProcessing` 忽略 `sdkStreaming`（可触发双 watchdog 误杀后台轮次）；`dispose()` 不等在途 `createRuntime()` 导致僵尸会话回插。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1294-L1297) / [#L2620-L2765](../../pi-bridge/src/agent-manager.ts#L2620-L2765) / [#L3209-L3219](../../pi-bridge/src/agent-manager.ts#L3209-L3219) |
| **HIGH** | **`PI_OFFLINE` 三套冲突语义 + `models-store` Windows `EBUSY` 清盘**：`providers-service.ts` 认 `0`/`false` 为在线，SDK `model-runtime.js:97` 认只要定义了就离线；`models-store.ts:79-94` 吞掉非 `ENOENT` 读错返 `{}`，Windows 锁冲突直接擦除其余供应商缓存；`models-dev-store.ts:61-72` 在 `await readFile` 前置 `diskLoaded = true` 产生启动竞态。 | [providers-service.ts](../../electron/providers-service.ts#L50-L55)、[models-store.ts](../../pi-bridge/src/models-store.ts#L79-L94)、[models-dev-store.ts](../../electron/models-dev-store.ts#L61-L72) |
| **MEDIUM** | **计划模式永久单次锁定 + `switch_worktree` 权限越级 + 重复双 `reload` 竞态**：`plan-extension.ts:63` 无 `approved -> completed` 流转，同一会话二次进计划模式永久报错；`switch_worktree` 落入 `'other'` 类别，点“始终允许”会连带放行全部未知扩展工具；`agent-manager.ts:1938-1946` 依赖双 `reload()` 清 SDK 全局 `extensionCache` 会互相踩踏并发工作区。 | [plan-extension.ts](../../pi-bridge/src/plan-extension.ts#L63)、[approval-policy.ts](../../pi-bridge/src/approval-policy.ts#L163)、[agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1938-L1946) |

### 4.2 Git 工作树与子进程管理
| 严重度 | 问题 | 代码位置 |
| --- | --- | --- |
| **CRITICAL** | **未合并分支被静默 `git branch -D` 强删（数据丢失）**：`branchHasNewCommits()` 遇任意 git 错误（如 `base` 分支已删/改名）返回 `false`，`release()` / `cleanupOrphans()` 随即强删分支。 | [git-worktrees.ts](../../electron/git-worktrees.ts#L495-L511)、[worktree-coordinator.ts](../../electron/worktree-coordinator.ts#L330-L335) / [#L708-L709](../../electron/worktree-coordinator.ts#L708-L709) |
| **HIGH** | **轮次边界切换工作树竞态**：`applyPendingRoot` 在置 `rebinding` 前先 `await resolvePersistedSessionFile()`，且 `chat()` 在 runtime 已存在时跳过 `ensureRuntime()`；排队消息可在切换窗口启动并被中途 dispose，或挤掉切换。 | [agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L602-L604) / [#L2158-L2215](../../pi-bridge/src/agent-manager.ts#L2158-L2215) / [#L2613-L2627](../../pi-bridge/src/agent-manager.ts#L2613-L2627) |
| **HIGH** | **每轮对话持锁串行扫描全部工作树 `git status -uall`**：每次发消息调用 `contextFor()` → `listWorktrees()` 持全局锁串行起 N 个 `git status`，与需求 `GIT_WORKTREE_SESSIONS.md:327` 矛盾；`getRepoInfo()` 同样串行起 7 个独立 `git.exe`。 | [worktree-coordinator.ts](../../electron/worktree-coordinator.ts#L418-L466) / [#L794-L822](../../electron/worktree-coordinator.ts#L794-L822)、[git-worktrees.ts](../../electron/git-worktrees.ts#L286-L302) |
| **HIGH** | **Windows 进程树强杀顺序写反 + 删树文件锁竞态**：`terminateTree` 与 `child-registry` 异步 `void killProcessTreeAsync(pid)` 下一行即同步 `child.kill('SIGTERM')`，根进程先死导致 `taskkill /T` 找不到孙进程（Unix 也没按进程组 `-pid` 杀）；`cancel()` 立刻释放串行槽位；`release()` 不等进程退出就 `git worktree remove`，触发 Windows `node_modules` 句柄占用失败并误报 `dirty`。 | [worktree-deps.ts](../../electron/worktree-deps.ts#L278-L289) / [#L379-L387](../../electron/worktree-deps.ts#L379-L387)、[child-registry.ts](../../electron/child-registry.ts#L118-L141)、[worktree-coordinator.ts](../../electron/worktree-coordinator.ts#L706-L707) / [#L752-L760](../../electron/worktree-coordinator.ts#L752-L760) |
| **HIGH** | **崩溃残留工作树永久脱离回收**：建树后落盘前崩溃，下次 `listWorktrees()` 把 `.pi-workbench/worktrees/` 下的目录自动登记为 `managed: false`（`ext-*`），`cleanupOrphans()` 永远无法清理（违背 GIT-152）。 | [worktree-coordinator.ts](../../electron/worktree-coordinator.ts#L445-L462) / [#L638-L650](../../electron/worktree-coordinator.ts#L638-L650) |
| **MEDIUM** | **分支劫持、远程检出无 `--track`、手动重装依赖短路、Git 参数注入缺 `--`**：`createWorktree` 失败回退可能静默切到同名旧分支；`checkout()` 检出远程分支掉入 detached HEAD；`worktree-deps.install()` 手动重试竟在目录存在时短路返 `ready` 无法修复坏 `node_modules`；多处 git 命令漏 `--` / `--no-ext-diff`，`limit` 传非数字产出 `git log -n NaN`；`parseGithubRemote` 未严校验 `owner`/`repo` 即拼接带 Bearer 头的 GitHub API URL。 | [git-worktrees.ts](../../electron/git-worktrees.ts#L333) / [#L475-L548](../../electron/git-worktrees.ts#L475-L548) / [#L740-L757](../../electron/git-worktrees.ts#L740-L757)、[worktree-deps.ts](../../electron/worktree-deps.ts#L639-L650) |

### 4.3 Electron 主进程、生命周期、鉴权与文档管线
| 严重度 | 问题 | 代码位置 |
| --- | --- | --- |
| **HIGH** | **退出看门狗在用户阅读未保存提示框时直接强杀应用**：`before-quit` 启动 10s `stallTimer`，随后 `will-prevent-unload` 弹出阻塞的 `showMessageBoxSync` 未暂停看门狗，思考超 10 秒即被 `app.exit(0)` 强杀并跳过所有清理。 | [electron/main.ts](../../electron/main.ts#L804-L840) / [#L1108-L1111](../../electron/main.ts#L1108-L1111)、[electron/shutdown.ts](../../electron/shutdown.ts#L149-L155) |
| **HIGH** | **第二实例（托盘唤回 / GitHub OAuth 回调）每次弹 `showErrorBox`**：违反托盘常驻与 OAuth 回调正常体验；且日志打开、协议注册甚至顶层初始化都在单实例锁判定之前运行。 | [electron/main.ts](../../electron/main.ts#L88-L109) / [#L151-L159](../../electron/main.ts#L151-L159) / [#L223-L243](../../electron/main.ts#L223-L243) |
| **HIGH** | **自动更新 4 处缺陷**：① `quitAndInstall()` 在 `will-prevent-unload` 确认前就拉起 NSIS 强杀进程；② 含空格路径 `/D=C:\...\Pi Workbench` 被 `uv_spawn` 自动加引号可能被 NSIS 忽略；③ 非 Windows 路径 `rmSync(cacheBase)` 会删掉整个 `{appDir}/cache/`（含 `drafts/`）；④ 强改 `electron-updater` 私有 `.app` 属性。 | [electron/updater.ts](../../electron/updater.ts#L166) / [#L253-L257](../../electron/updater.ts#L253-L257) / [#L650-L685](../../electron/updater.ts#L650-L685) |
| **HIGH** | **只读安装目录顶层直接崩溃**：模块顶层未 `try/catch` 直接调 `createWorkspaceStore` 建库，早于 `ensureAppDirWritable()` 提示运行。 | [electron/main.ts](../../electron/main.ts#L440)、[electron/workspace-store.ts](../../electron/workspace-store.ts#L35-L40) |
| **HIGH** | **凭证与鉴权 5 处 Bug**：① `setActiveProvider` 合成空对象绕过 `NOT_CONNECTED` 校验；② `auth-flow.ts` `api_key` 登录空块未写 `providers.json`；③ `github-auth.ts` 在 `safeStorage` 不可用时静默清空 Token 报成功；④ 登出/解绑用默认 `writeJsonAtomic` 把密文复制到 `.bak` 留存磁盘；⑤ `github-oauth.ts` 明文读 `clientSecret`，未校验 `state` 先处理 `error`（可被外部 `pi-workbench://oauth?error=...` 伪造弹窗或清空 `pendingLogin`）。 | [providers-service.ts](../../electron/providers-service.ts#L299-L307)、[auth-flow.ts](../../electron/auth-flow.ts#L135-L142)、[github-auth.ts](../../electron/github-auth.ts#L58-L99)、[link-store.ts](../../electron/cloud/link-store.ts#L90-L109)、[github-oauth.ts](../../electron/github-oauth.ts#L53-L144) |
| **HIGH** | **系统代理 `useSystemProxy` 绕过全部 WebSocket 且劫持 `localhost`**：`ws` 走 Node `http/https` 不走 `globalThis.fetch`；`net.fetch` 复用 `defaultSession` 污染 Cookie/HSTS 且错误代理回环地址。 | [electron/system-proxy.ts](../../electron/system-proxy.ts#L52-L103) |
| **HIGH** | **文档解析管线 4 处 Bug**：① `detect.ts:88` 凡前 4KB 含 `%PDF-` 均判 PDF（含源码文件自身）；② `ooxml.ts:459` 5KB 稀疏表 OOM 炸弹；③ `render-bridge.ts:51` 在拆窗聚焦时把 64MB PDF 字节发给无脚本辅助窗导致必现 60s 超时；④ `extract.ts` 读 PPTX 文本时白白同步解压并 Base64 编码最多 60 张图片，且 `preview.ts` 硬编码 `slideN.xml` 在重排页后配错图。 | [detect.ts](../../electron/documents/detect.ts#L88)、[ooxml.ts](../../electron/documents/ooxml.ts#L458-L464) / [#L596](../../electron/documents/ooxml.ts#L596)、[render-bridge.ts](../../electron/documents/render-bridge.ts#L51-L58)、[preview.ts](../../electron/documents/preview.ts#L196-L216) |
| **HIGH** | **`repo-autofetch.ts:53` 正则未转义 + 关闭预算倒挂 + 终端日志竞态**：`'Permission denied (publickey)'` 括号未转义，SSH 失败退避永不生效；`cloud-device` 关闭超时 1200ms 小于内部 `flush(1500)` 且退出不等待 `atomic-json` 队列/OAuth 本地端口；`terminal-manager` 同步 `flush()` 与异步 `logWriteChain` 并发写竞态；Linux 递归 `fs.watch` 在忽略前先给 `node_modules` 建 inotify 极易 `ENOSPC`。 | [repo-autofetch.ts](../../electron/repo-autofetch.ts#L53)、[electron/main.ts](../../electron/main.ts#L1050-L1097)、[terminal-manager.ts](../../electron/terminal-manager.ts#L337-L361)、[ipc/workspace.ts](../../electron/ipc/workspace.ts#L131) |

### 4.4 云端控制面与终端执行器
| 严重度 | 问题 | 代码位置 |
| --- | --- | --- |
| **CRITICAL** | **`task.progress.diff` 全量推送给所有 UI 并每 2 秒重写整个 `tasks.json`**：违背文档声明，最高 32 MB diff 塞进快照与广播，每次里程碑触发全文件序列化 + `fsync` + 回读 parse 覆盖 `.bak`。 | [dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L460-L475) / [#L857-L860](../../apps/cloud/src/tasks/dispatcher.ts#L857-L860)、[apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L276) |
| **CRITICAL** | **云端重启后 `/device/ws` 永久静默丢帧**：服务端重启 `lastSeq` 归零，桌面 `lastAckSeq` 保持旧高位；下次重连带旧高位游标，`replayDeviceLog` 忽略 `overflow` 静默吞掉所有 `seq <= old` 的工单与取消帧。 | [device-agent.ts](../../electron/cloud/device-agent.ts#L260) / [#L452-L458](../../electron/cloud/device-agent.ts#L452-L458)、[hub.ts](../../apps/cloud/src/ws/hub.ts#L478-L488) |
| **CRITICAL** | **`CloudSession.flushEvents()` 丢失 `changedFiles` 与 `secretHits`**：重建 `merged` 时漏抄字段，F-36/A-29 端到端失效；同工单 2s 内后到事件覆盖 `question`；`ready()` 为 false 时挂起队列永不重调度。 | [cloud-session.ts](../../apps/cloud/src/agent/cloud-session.ts#L256-L299) |
| **CRITICAL** | **`TaskDispatcher` 4 处竞态与额度绕过**：① `cancelTask` 749 行发取消帧，755 行立刻 `dropDeviceTask` 抹掉取消帧；② `tryDispatch` 发送失败不清 `deviceLog`，重连时重放 + 再派发导致双派单；③ `await saveTask` 后未复查是否已取消；④ `dispatch_task` 从不传 `idempotencyKey`（非幂等），且复用开放 `workUnitId` 跳过额度校验（`quota=1` 可无限派单）。 | [dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L185-L205) / [#L306-L333](../../apps/cloud/src/tasks/dispatcher.ts#L306-L333) / [#L748-L755](../../apps/cloud/src/tasks/dispatcher.ts#L748-L755)、[tools.ts](../../apps/cloud/src/agent/tools.ts#L178-L193) |
| **HIGH** | **Web 端已完成工单摘要永不显示 + 表单被 WS 帧重置**：Web 传 `task.result?.summary`，服务端只发 `task.progress.summary`；`ConfirmPlanModal` 随 `devices` 推送重置用户所选设备与仓库。 | [CloudWebCards.tsx](../../apps/cloud/web-src/CloudWebCards.tsx#L167-L174) / [#L1069-L1077](../../apps/cloud/web-src/CloudWebCards.tsx#L1069-L1077) |
| **HIGH** | **僵尸 `running` 工单永占槽位 + 重连不跑 `sweepUnits` + `onOpen` 乱序发帧**：重启后离线设备的 `running` 工单永不超时永久占 8 并发名额；`sweepUnits()` 只在 `start()` 跑、重连不跑，离线完成工单的工作树泄漏到重启；`onOpen` 期间 `await getWorkspaces()`（长达 8s）允许并发 `send()` 抢在 `hello` 和 outbox 之前发出。 | [dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L473-L484) / [#L781-L822](../../apps/cloud/src/tasks/dispatcher.ts#L781-L822)、[device-agent.ts](../../electron/cloud/device-agent.ts#L179) / [#L311-L335](../../electron/cloud/device-agent.ts#L311-L335) |
| **HIGH** | **`CloudTaskRunner` 泄漏与竞态 + `JsonDoc` 损坏风险 + 退出未 flush 记忆**：每次执行完不 dispose 工单会话且不退订 `subscribeTrace`；重建 `manager` 不 dispose 旧实例；`retryAfterConfigRefresh` 提前释放 `starting` 锁重开 `closeUnit` 竞态；`message()` 遇 `chat()` 失败不调 `finishFailed` 永久卡在 `running`；`currentTaskForSession()` 不按 `sessionId` 匹配；`client-link.open()` 不清 `reconnectTimer` 可能起双 WS；`JsonDoc.update()` 写盘失败内存已污染，并发写覆盖 `.bak`；`main.ts:1014` 退出未 await `memoryStore.flush()`。 | [task-runner.ts](../../electron/cloud/task-runner.ts#L374) / [#L463-L469](../../electron/cloud/task-runner.ts#L463-L469) / [#L571-L697](../../electron/cloud/task-runner.ts#L571-L697) / [#L1095-L1123](../../electron/cloud/task-runner.ts#L1095-L1123)、[client-link.ts](../../electron/cloud/client-link.ts#L76-L92)、[atomic.ts](../../apps/cloud/src/store/atomic.ts#L48-L57)、[apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L1014) |
| **MEDIUM** | **`BoundedLog.since()` 24h 后漏判溢出 + 只读 `GET /v1/snapshot` 触发拆建 + `update.sh` 浅健康检查**：24h 全部条目过期后 `first === undefined` 返 `overflow: false` 静默丢数百事件；`GET /v1/snapshot` 走 `ensureAgent()` 拆建且实际没做 `probeConfig`（违背文档）；`update.sh` 只判 `"ok":true` 不判 `"ready":true`，初始化失败不会自动回滚；`pi-cloud.service` 错把备份目录 `/var/backups/pi-cloud` 加入服务自身可写路径；三端未读数口径分裂。 | [hub.ts](../../apps/cloud/src/ws/hub.ts#L76-L86)、[apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L141-L209) / [#L856-L919](../../apps/cloud/src/main.ts#L856-L919)、[update.sh](../../apps/cloud/deploy/update.sh#L141-L148)、[pi-cloud.service](../../apps/cloud/deploy/pi-cloud.service#L33) |

---

## 五、前端架构、性能、打包体积与 UX / A11y 审查

### 5.1 高危状态与交互缺陷
1. **[CRITICAL] 切换界面语言会重新初始化全部工作区的 Pi Agent 并重载所有文件树**：[i18nStore.ts](../../src/store/i18nStore.ts#L28-L46) 每次 `setLanguage()` 生成新 `t` 引用，而 [useChatSessions.ts](../../src/hooks/useChatSessions.ts#L249)、[FileExplorer.tsx](../../src/components/FileExplorer.tsx#L238)、[ToolResultViewer.tsx](../../src/components/ToolResultViewer.tsx#L135)、[ProviderSettings.tsx](../../src/components/ProviderSettings.tsx#L180)、[CommandPalette.tsx](../../src/components/CommandPalette.tsx#L102)、[App.tsx](../../src/App.tsx#L174) 把 `t` 列入 `useEffect` 依赖，导致切换一次语言全局重跑初始化与磁盘/IPC 拉取。
2. **[HIGH] 终端重启回放旧乱码 + 并发 spawn 竞态**：[terminalStore.ts](../../src/store/terminalStore.ts#L130-L154) / [#L193-L217](../../src/store/terminalStore.ts#L193-L217) 重置了已废弃的 `buffer: []` 字段，遗漏 `replayBuffers.delete(workspacePath)`，且未给 `spawn()` 加代次令牌。
3. **[HIGH] 多工作区资源常驻叠加与泄漏**：
   - 所有打开的工作区永久挂载全套 Monaco + xterm + PDF + RepoMap DOM；[useFileDocument.ts](../../src/workspace/useFileDocument.ts#L286-L290) 监听全局 `pi:refresh-files`，导致隐藏工作区也在每次 Agent 改文件时批量 `exists` + `readFile`。
   - `cloudStore.ts:204-210` 绑定 3 个 IPC 监听器且丢弃退订函数；`FileExplorer.tsx:247` 用 `viewRoot` 写 `panelUiState`，`App.tsx:563` 只按主路径清理，泄漏工作树键；`useChatPanelState.ts:377-391` `@` 补全缺请求序号，慢请求会覆盖新输入；`App.tsx:336` 在 `beforeunload` 里发异步 `saveEditorTabs` 易被退出截断；`App.tsx:123-143` 状态栏 `fileLanguage` 只认 6 种扩展名（Python/Rust/Go 均显示 `Plain Text`）。
   - [useFileDocument.ts](../../src/workspace/useFileDocument.ts#L327) 判断 `event.key === 's'` 区分大小写，开启 Caps Lock 时 `Ctrl+S` 失效。

### 5.2 渲染性能、虚拟化与组件体验瓶颈
- **流式/打字重渲染风暴**：
  - [ChatPanel.tsx](../../src/components/ChatPanel.tsx#L308) 与 [MarkdownReadingView.tsx](../../src/components/MarkdownReadingView.tsx#L90) 给 `MarkdownLinkScopeProvider` 传未 memoize 的字面量对象，击穿 `ChatMessageRow`/`AgentMarkdown` 全部 `React.memo`。
  - [MonacoEditor.tsx](../../src/components/MonacoEditor.tsx#L388-L399) 每敲一字 `editor.getValue()` 拷贝全文并触发两次同步 Zustand `set()`；`useChatPanelState.ts:310-315` 每 50ms 跨所有工作区遍历 `Object.entries(conversations)`，重试时 250ms 定时 `setRetryNow` 重渲染整个 1,261 行 `ChatPanel`；`App.tsx` 与 `Settings.tsx` / `DiffViewer.tsx` 多处无 selector 订阅全局 Store（55 处 `useI18nStore()` 无 selector），`WorkspaceView` 未 `React.memo`。
- **虚拟化、滚动、Diff、PDF 四处缺陷**：
  - [useVirtualRows.ts](../../src/hooks/useVirtualRows.ts#L23-L30) 漏传 `getItemKey`，切会话复用旧会话行高缓存引发跳动/重叠；[useChatScroll.ts](../../src/hooks/useChatScroll.ts#L73-L79) 切会话不重置 `showScrollButton` 与 `newMessageCount`，且随 `messages` 频繁重建 `ResizeObserver`。
  - [DiffViewer.tsx](../../src/components/DiffViewer.tsx#L185-L212) `SplitDiffView` 左右各自 `filter` 无补齐空行、无同步滚动；[GitView.tsx](../../src/components/GitView.tsx#L1125)（200 提交 × 双 SVG）与 [OfficeDocumentView.tsx](../../src/components/OfficeDocumentView.tsx#L100-L138) `SheetTable` 均无虚拟化；`GitView.tsx:422` 每次切会话重复拉全仓提交日志并触发 `gitFetch`。
  - [PdfReadingView.tsx](../../src/components/PdfReadingView.tsx#L46) / [#L110-L124](../../src/components/PdfReadingView.tsx#L110-L124) `PdfPage` 未 memoize 且因 `onSize` 改依赖触发清零重绘两遍；`HtmlPreview.tsx:87` 未等自动保存刷盘即重载磁盘旧 HTML。
  - 超过 20,000 字符的流式回复在 [AgentTrace.tsx](../../src/components/AgentTrace.tsx#L188) / [ChatMessageRow.tsx](../../src/components/ChatMessageRow.tsx#L535) 会触发高亮断崖，瞬间剥掉全部 Shiki 高亮与 Mermaid 图表。
- **`RepoMapCanvas` 假 60fps 与反直觉交互**：
  - [RepoMapCanvas.tsx](../../src/components/RepoMapCanvas.tsx#L609) / [#L712](../../src/components/RepoMapCanvas.tsx#L712) / [#L912-L922](../../src/components/RepoMapCanvas.tsx#L912-L922) 每帧 `setViewportRect`/`setZoom` 且内联回调击穿 `React.memo(RepoMapNodeCard)`，平移缩放全量重渲染 DOM 卡片；无视口裁剪；`chainLayout` 有 `O(N²)` 去重；大目录向右展超 3,200px 不移镜头；空白拖/中键拖无效、强制 `Space+拖` 且全局空格拦截漏排除 `menu`/`menuitem`/`treeitem`/`<summary>`；多命中搜索只能看第一条，无计数与上下跳转；退层无面包屑、无一键回根。

### 5.3 打包体积、资源加载与冗余依赖实测分析

| 问题项 | 实测产物证据 | 根因与影响 |
| --- | --- | --- |
| **冷启动懒加载失效** | `dist/assets/index-*.js` **1,261 KB** + `markdown-*.js` **734 KB** + `react-vendor-*.js` **217 KB** + `index-*.css` **288 KB** | [App.tsx](../../src/App.tsx#L21) 静态导入 `CloudView` → `AgentMarkdown` → `StreamdownView`（含 `streamdown`/`shiki`/`katex`/`mermaid`），彻底抵消 `lazy(WorkspaceView)` |
| **桌面翻译表泄漏进云端 Web** | `apps/cloud/web-dist/assets/index-*.js` **943 KB**（已检出桌面 `worktree` 等文案） | `CloudWebCards` → `src/components/ui.tsx` → `useI18nStore`（2,063 行 `translations.ts`）+ `HostContext` + `zustand` |
| **云端 Web Mermaid 巨型包** | `apps/cloud/web-dist/assets/mermaid-*.js` **3,372 KB** | 手机/公网端承载 3.37 MB 图表引擎且静态导入插件工厂 |
| **CJK 字体全量多语种打包** | 桌面 `dist/` 259 字体文件 (**11.17 MB**)；云端 Web 319 文件 (**18.92 MB**)，含 `noto-sans-devanagari` (97 KB) | `main.tsx` 导入全部 6 套 `@fontsource` 全子集，公网 Web 端连天城文/希腊文/西里尔文一起打包（且 `static.ts` 全量常驻 RAM 缓存） |
| **pdf.js 资源转 Base64 JS** | `cmaps` 1,528 KB + `wasm` 1,199 KB + `standard_fonts` 1,009 KB = **3.74 MB** | [vite.config.ts](../../vite.config.ts#L465-L502) 将二进制转为 Base64 JS 模块，带来 33% 膨胀与 JS 解析开销 |
| **555 行 `mockAPI` 进生产包** | [src/api/index.ts](../../src/api/index.ts#L81-L637)、[src/api/piAgentAPI.ts](../../src/api/piAgentAPI.ts#L72-L374) | 未用 `import.meta.env.DEV` 门控，`mockAPI`（含 `localStorage`）与浏览器 SSE 桥全部打进生产 Electron |
| **死依赖与双 Markdown 残余** | `package.json:91-92`、`index.css:584-644`、`vite.config.ts:543-557` | `react-markdown`、`rehype-highlight` 全仓零引用，仍保留依赖、Vite 分包与 60 行 `.hljs-*` CSS；`markdownBlocks.ts` 又单独引 `unified`/`remark-parse` 仅做切块 |
| **编辑器语言被过度裁剪 + 公式误伤代码** | [vite.config.ts](../../vite.config.ts#L428-L439) vs [shikiHighlighter.ts](../../src/utils/shikiHighlighter.ts#L73-L107)、[StreamdownView.tsx](../../src/components/StreamdownView.tsx#L28) | Monaco 砍掉了 `yaml`/`bash`/`sql`/`dockerfile`/`cpp`/`java`/`powershell`/`toml`/`xml`（仅剩 10 种），而聊天 Shiki 支持 33 种；`singleDollarTextMath: true` 会把技术对话中的 `$VAR` / 价格误渲染成 KaTeX 公式 |

### 5.4 前端设计、无障碍（A11y）与 i18n
- **桌面原生交互退化**：自绘标题栏（`frame: false`）主动放弃了 **Windows 11 Snap Layouts** 悬停分屏，而 Electron 原生 `titleBarStyle: 'hidden' + titleBarOverlay` 可完美兼顾；启动强塞 **1 秒 `setBounds` 形变动画**（600ms 人工停留 + 25 次 16ms `setBounds` 调用，[window-morph.ts](../../electron/window-morph.ts#L48-L75)），拖慢冷启且在 Linux Wayland 上被合成器禁止。
- **焦点、键盘与 ARIA 缺陷**：
  - `Modal` 无 Portal 且未给背景设 `inert`，`FOCUSABLE_SELECTOR` 未过滤隐藏/禁用祖先元素；`CommandPalette` 与 `DiffViewer` 绕过 `Modal` 零焦点陷阱与恢复；
  - 4 处 `Escape` 穿透/双触发：`PopoverMenu` 在 `Modal` 内按 `Escape` 未调 `preventDefault()` 会把父弹窗一起关掉（[ui.tsx](../../src/components/ui.tsx#L289-L294) vs [#L536](../../src/components/ui.tsx#L536)）；`ToolResultViewer` 图片灯箱按 `Escape` 关整个查看器；`DialogHost`、`FileExplorer` 重复处理 `Escape`；
  - `Tab` 在 `role="tab"` 内嵌套 `<button>` 违反 WAI-ARIA `nested-interactive`（`GitView.tsx:762` 同理）；`FileExplorer` `role="treeitem"` 缺少方向键导航与 roving tabindex；`SelectionQuoteButton` 捕获阶段不节流 `scroll` 且越界不隐藏；`CardHeader` `{status ?? action}` 静默吞掉 `action`。
- **对比度与排版违规**：`--ink-subtle`（~3.1:1）规范明令“仅装饰/禁用”，却在 `patterns.tsx:208`、`ChatPanel`、`ChatMessageRow`、`AgentTrace`、`RepoMapNodeCard`、`GitView`、`OfficeDocumentView` 等十余处承载真实信息；存在 `7px` / `8.5px` / `9px` 极小字号。
- **i18n 缺口**：[translations.ts](../../src/i18n/translations.ts#L2063) 缺 `satisfies Record<Language, Record<TranslationKey, string>>`（`en` 漏 key 编译不报错）；存在 **37 个死 key**（74 行）；`cloudStore.ts` / `CloudView.tsx` 混入硬编码中英文；`CloudTraceSection.tsx:100,113` 存在英文单复数错误（`"1 tools"`, `"2 tool failed"`）。

---

## 六、规则文件、限制文件与工程治理本身审查

| 规则 / 门禁文件 | 核心不合理之处与实际反噬 | 改进建议 |
| --- | --- | --- |
| **[AGENTS.md](../../AGENTS.md)** | ① **验证矩阵盲区**：要求改 `electron/` 跑 `npm run type-check`，但 `package.json` 的 `type-check` 只查 `src/` + `vite.config.ts`，**完全不查 `electron/`、`pi-bridge/`、`apps/cloud/src/`**！<br>② **禁建子目录铁律反噬**：强制 `src/components/`（62 文件）与 `tests/`（174 文件）平铺，倒逼开发者把 8 个组件塞进 1,702 行单文件。<br>③ **`xxxStoreFor()` 铁律名存实亡**：9 个工作区 Store 仅 2 个遵守，且工厂的 `setTimeout(0)` 释放反生竞态。<br>④ **一刀切“禁 Worker/子进程”**：把文档解析/索引/插件锁死在 GUI 主线程。 | 补齐全工作区 `type-check`；允许按业务域建 `src/components/{chat,cloud,git,repo-map,settings,ui}/` 与 `tests/<domain>/`；工作区级状态改用 Zustand `createStore` + React Context 随视图卸载自动回收；把“禁本地 HTTP 服务”与“允许 `utilityProcess`/`worker_threads`”解耦。 |
| **[DESIGN_SYSTEM.md](../design/DESIGN_SYSTEM.md)** | ① **严重膨胀且越界**（992 行 / 97 KB）：把画布坐标公式、数据属性名、标题 JSON 格式、启动 `setBounds` 毫秒数全塞进视觉规范，却强制动任何 UI 前必读。<br>② **多处严重过时**：文首标 `v1.48`（记录已到 `v1.68`）；§6.7 仍写 0.10 已删供应商表；§9.2 仍写旧版面板列表视图；§11 索引把 `WorkspacePanel` 写为占位。<br>③ **反无障碍条款**：v1.18 明令忽略 `prefers-reduced-motion`（违反 WCAG 2.3.3），同时 `index.css:698` 又局部遵守，自相矛盾。 | 瘦身为纯 Token / 排版 / 组件 API / A11y 契约（目标 ≤300 行），页面交互规格下沉至对应特性文档；恢复 `prefers-reduced-motion` 支持；改用 `titleBarOverlay` 恢复 Win11 Snap Layouts；取消 1 秒启动 `setBounds` 动画。 |
| **[tests/design-system.test.ts](../../tests/design-system.test.ts)** & **[eslint.config.js](../../eslint.config.js)** | ① **脆弱字符串正则**：只扫 `.tsx` 漏掉 [shikiHighlighter.ts](../../src/utils/shikiHighlighter.ts#L22-L66) 里 24 处硬编码 hex；会对注释/URL 误报；`FLOATING` 按整文件豁免放行了千行 `App.tsx`/`ChatPanel.tsx`。<br>② **ESLint 护栏缺失**：全局关 `@typescript-eslint/no-explicit-any`，无 `eslint-plugin-jsx-a11y`，无跨包边界规则（放任 `apps/cloud/web-src` 跨 3 层引 `src/`）。 | 迁移到 AST 级 ESLint 规则 + `eslint-plugin-jsx-a11y` + `import/no-restricted-paths`（隔离桌面与云端依赖边界），按需收紧 `no-explicit-any`。 |
| **CI/CD & `tsconfig` & 文档** | ① `electron/tsconfig.json` 仅 `"include": ["main.ts"]` 漏掉孤立文件 `electron/text-sanitize.ts`。<br>② `ci.yml` 不跑 `type-check:cloud` 和 `build:cloud`。<br>③ `cloud-release.yml` 零测试零类型检查即发布 `cloud-latest`，且手工维护 18 条 `paths` 已漏掉 4 个传递依赖。<br>④ `build-cloud-bundle.mjs` 脱离 `package-lock.json` 用 `^` 现装线上依赖。<br>⑤ 过期文档：`PROJECT_PLAN.md`（仍写自定义端点与 `$PI_WORKBENCH_API_KEY`）、`ipc-and-trust.md`（写 127 频道 + 已删 `devModelsProxy`）、`paths-and-storage.md`（写 6s 看门狗实际 7.5s）、`cloud-agent.md`（5 处与代码矛盾）、`acceptance.mjs`（测已删 `/app.css`）。 | `npm run type-check` 串联全部 6 份 tsconfig；`ci.yml` 补 `type-check:cloud` + `build:cloud`；`cloud-release.yml` 必须先过测试与类型检查再发布，且按 `package-lock.json` 锁定生产依赖版本；建立文档“单一事实源”清理过时副本。 |

---

## 七、分阶段整改路线图与验收清单

### Phase 0：安全止血与数据丢失修复（建议 1–3 天内优先落地）
- [x] **本地 RCE / 逃逸封堵**：
  - [x] `pi-bridge/src/agent-manager.ts` 传 `{ projectTrusted: false }` + `noExtensions: true`（工作区显式信任开关记入 `BACKLOG.md` `S-01`）
  - [x] `HtmlPreview.tsx` 移除 `allow-popups`；`aux-window.ts` 去除辅助窗 `preload` 继承与 `trustIpcSender` 并阻断来自 `pw-file:` / `about:blank` 的弹窗；`file-protocol.ts` 下发结构性沙箱 CSP（含 `worker-src 'none'`），并在主进程 `webRequest.onBeforeRequest` 对外网请求默认离线拦截、按文件弹窗询问允许/拒绝
  - [x] `vite.config.ts` 锁定 `devAgentBridge`（`Host`/`Origin` + `Content-Type: application/json` + 启动随机 `X-Pi-Dev-Token` + 16 MB 体积上限）
  - [x] `workspace-trust.ts` 与 `cloud/task-guard.ts` 用 `lstatSync + readlinkSync` 封堵悬挂软链；`task-guard.ts` 对齐 SDK `@` / `~` 路径解析并加固命令守卫
  - [x] 在 SDK `bash`/`powershell`（`sanitizeAgentShellEnv`）、本地终端（`sanitizeTerminalEnv`）、工作树依赖安装（`sanitizeInstallEnv`）与云端全部 git 子进程按大小写无关强制清洗 `PI_WORKBENCH_*` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`；`autoInstallWorktreeDeps` 默认关闭（`false`），同时保留 Agent 自行补依赖与手动/开启后正常构建原生依赖的能力
  - [x] `agent-manager.ts` `findSessionFile` 强制校验 `isSessionOfWorkspace`
- [x] **云端安全与脱敏止血**：
  - [x] `apps/cloud/src/http/router.ts` 移除 `X-Real-IP` 信任、解耦全局熔断与管理员登录、强制 Cookie WS 校验精确非空 `Origin`、为 `/v1/setup` 加 `PI_CLOUD_SETUP_TOKEN` 支持与 15s Slowloris body 超时
  - [x] 拆分设备执行 Token（`token`：仅限 `/device/ws`、`PUT /v1/workspaces` 与自解绑）与桌面控制面 Token（`clientToken`：保留完整跨设备编排能力，纯设备 `token` 无法访问控制面）
  - [x] `electron/cloud/task-report.ts` 改为状态机多行 PEM 脱敏、`fs.lstat` 拒软链、解码 git 引号路径并查双侧、补全高危文件名与密钥正则
  - [x] 清理公开仓库中的个人域名、服务器 IP 与运维弱点报告（*注：线上 VPS 防火墙 / SSH / Caddy 运行时加固需在服务器侧单独执行*）
- [x] **最致命正确性/数据丢失修复**：
  - [x] `git-worktrees.ts` `branchHasNewCommits` 报错改为 fail-closed 返回 `true`
  - [x] `agent-manager.ts` 传 `config.workspaceDir` 修复链接工作树审批卡；4 处 IPC 改为先取消审批再 `abort/close/delete/dispose`，`approval-extension` 响应 `ctx.signal`
  - [x] `providers-service.ts` 传 `modelsPath: null` 修复容量单向棘轮；`setActiveProvider` 校验凭证存在；修复 `auth-flow` `api_key` 分支、`github-auth` fail-closed 与登出清理 `.bak`
  - [x] `electron/main.ts` 进入 `will-prevent-unload` 时暂停退出看门狗；第二实例静默唤回不弹 `showErrorBox`；保护顶层 `workspaceStore` 初始化；修 `updater.ts` 非 Windows `rmSync` 范围与 `/D=` 参数
  - [x] 云端：从 `publishTask` / `snapshot` / `tasks.json` 剥离 `progress.diff`（独立写 `task-diffs/<taskId>.json`）；修复 `/device/ws` 重启游标重置与 `overflow` 处理；修复 `CloudSession.flushEvents()` 保留 `changedFiles`/`secretHits`/高优 `kind` 与未就绪重排；修复 `cancelTask` 误删取消帧、`tryDispatch` 竞态、`sameUnit` 额度绕过、`CloudWebCards.tsx` 完成摘要与 `ConfirmPlanModal` 重置

### Phase 1：前端性能、打包瘦身、可靠性与门禁补齐（1–2 周）
- [x] **前端止血**：
  - [x] 移出所有初始化 `useEffect` 中的 `t` 依赖（改用 `useI18nStore.getState().t` / `tRef`）
  - [x] 懒加载 `CloudView` / `Settings` / `CommandPalette` / `IPCDebug`；按需动态加载 `@streamdown/mermaid`；清理 `react-markdown`/`rehype-highlight`/`.hljs-*`；`import.meta.env.DEV` 门控 `mockAPI` 与 dev 桥；`pdfjs` 资源改静态文件分发；按需裁剪非中/英字体子集（`cyrillic`/`devanagari`/`greek`/`vietnamese`）
  - [x] 恢复 Monaco 常用开发语言（25 种常用语言含 `yaml`/`bash`/`sql`/`dockerfile`/`cpp`/`java`/`powershell`/`toml`/`xml` 等）与状态栏 `fileLanguage` 映射；`singleDollarTextMath` 按所有者决策**保留开启（`true`）**
  - [x] 修复 `MarkdownLinkScopeProvider` memo、Monaco 按键状态合并、`useVirtualRows` `getItemKey`、`useChatScroll` 切会话复位、`SplitDiffView` 对齐与同步滚动、`PdfPage` memo 与重绘、`terminalStore.restart` 清 `replayBuffers` 与代次锁、`Ctrl+S` 大小写兼容、`useFileDocument` 隐藏工作区延迟磁盘同步、`RepoMapCanvas` 回调稳定化与中键平移
  - [x] 修复 `auxWindow.ts` `<head>` `MutationObserver` 与 `ui.tsx` 跨 Realm `instanceof` / Escape 穿透，修复 `readThemeTokens` 冗余切换 DOM、`GitView` 宿主窗口监听、`clipboard.ts` 返回契约、`cloudStore` 监听卸载、`useChatPanelState` `@` 补全序号、`App.tsx` worktree `clearPanelUi` 清理
  - [x] `translations.ts` 补 `satisfies Record<Language, Record<TranslationKey, string>>` 校验、清理 35 个死 key 并修复 `CloudTraceSection` 英文单复数
- [x] **云端持久化 & 共享 UI**：
  - [x] `apps/cloud` 迁至 Node 24 `node:sqlite` (WAL + 独立 `task_diffs` 表 + 事务 + 旧 JSON 一次性自动迁移保留备份 + 单调配置时间戳)，修复重启僵尸 `running` 工单收敛、重连 `sweepUnits`、`onOpen` 握手锁、只读 `GET /v1/snapshot` 不拆建运行时、`memoryStore` 原子回滚与退出 `memoryStore.flush()`
  - [x] 抽取共享 workspace 包 `packages/cloud-ui`（统一 WS Reducer、格式化工具、Paper & Ink 零桌面 store 原语与共享卡片/弹窗），剥离 `ui.tsx` 对 `useI18nStore` 耦合，彻底切断桌面翻译表与 `zustand` 泄漏进 `apps/cloud/web-dist`
- [x] **运行时与工程门禁**：
  - [x] 修复 `session.bindExtensions()`、`thinkingLevelsOf`、`TASK_COMPACTION_SETTINGS` 覆盖、`CloudTaskRunner` 会话释放/重建/并发锁、`repo-autofetch` 转义正则、`detect.ts` `%PDF-` 魔数、`ooxml.ts` 单元格预算与 PPTX 按需读图/真实 `sourcePath`、`render-bridge` 固定主窗、`terminateTree`/`ChildRegistry`/`TerminalManager` 杀树顺序与日志写竞态、`system-proxy` 隔离 session/放行回环/代理 WS、`main.ts` 关闭超时预算
  - [x] 补齐全仓 7 份 tsconfig 的 `type-check`（含 `electron/tsconfig.json` `**/*.ts`）与 `ci.yml` / `cloud-release.yml` 门禁，`build-cloud-bundle.mjs` 按根 `package-lock.json` 锁定版本，`update.sh` 校 `ready: true`（`hasConfig` 联动），收回 `pi-cloud.service` `/var/backups/pi-cloud` 写权限

### Phase 2：架构演进与规则重构（中长期）
- [ ] 将 `electron/documents/*`、`repo-map.ts`、`PluginManager`（加代码哈希校验）迁至 `worker_threads` / `utilityProcess`，逐步演进 `AgentRegistry` 进程隔离并消除 168 处主线程 `*Sync`
- [ ] 拆分 3,234 行 `AgentManager`，落地 `chat-render-single-source.md`（用 `entryId` 统一分支/历史/流式）
- [ ] Desktop IPC 与 Cloud WS 协议引入 Zod Schema-First 单一契约与协议能力协商
- [ ] 引入 Radix UI / React Aria 替换手搓 `Modal`/`PopoverMenu`/`Tab`；恢复 `titleBarOverlay`（Win11 Snap Layouts）、取消 1 秒 `setBounds` 动画、恢复 `prefers-reduced-motion`；`RepoMapCanvas` 改为按需打开或切换 `@xyflow/react`
- [ ] 重写瘦身 `AGENTS.md` 与 `DESIGN_SYSTEM.md`：放开按域分子目录、采用 Context 托管工作区 Store、以 ESLint（`jsx-a11y` + AST + 边界规则）取代正则单测、回归标准每用户目录 + 可选便携模式
