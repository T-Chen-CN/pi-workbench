# Pi Workbench 全仓深度代码与架构审查报告

> **审查日期**：2026-11-28
> **审查基线**：`0.11.2+`（Phase 0–2 深度整改与全局清理后的 `main` 主干，全仓 583 个受控文件）
> **修复进度（2026-11-28）**：报告中全部 **59 项纯代码 Bug** 已按确认方案（`1.B / 2.A / 3.A / 4.A / 5.A / 6.A`）全部修复落地，并补齐 5 个专项回归测试文件（全仓 7 份 `type-check`、`lint`、`npm test` **183 文件 / 1,906 用例**、`npm run build`、`npm run build:cloud` 全绿）。其余架构演进、设计系统与工具链/发布优化项留待后续按需排期。
> **审查范围**：`electron/`、`pi-bridge/`、`apps/cloud/`、`packages/cloud-ui/`、`src/`、`tests/`、`build/`、`scripts/`、`.github/workflows/`、全部配置文件、设计系统与规则约束文档（`AGENTS.md` / `DESIGN_SYSTEM.md` / ADRs）
> **审查原则**：不预设现有规则与文档为正确前提，逐行验证代码实现、安全边界、并发状态机、渲染性能、产物体积、测试有效性与规则合理性，并对照 2025–2026 社区与业界主流方案。

---

## 目录

1. [执行摘要与六大系统性矛盾](#一执行摘要与六大系统性矛盾)
2. [P0 安全边界与数据丢失缺陷](#二p0-安全边界与数据丢失缺陷)
3. [P0 / P1 确定性运行时与并发状态机 Bug](#三p0--p1-确定性运行时与并发状态机-bug)
4. [架构编排与模块设计缺陷](#四架构编排与模块设计缺陷)
5. [前端设计、渲染性能与 Paper & Ink 设计系统评审](#五前端设计渲染性能与-paper--ink-设计系统评审)
6. [规则文件、门禁、测试与工程工具链本身的缺陷](#六规则文件门禁测试与工程工具链本身的缺陷)
7. [社区 / 业界更优方案对照矩阵](#七社区--业界更优方案对照矩阵)
8. [分阶段整改优先级清单](#八分阶段整改优先级清单)

---

## 一、执行摘要与六大系统性矛盾

### 问题分布总览

| 维度 | Critical (P0) | High (P1) | Medium / Design-Smell (P2) | 核心特征 |
| --- | :---: | :---: | :---: | --- |
| Electron 主进程 / IPC / 原生能力 | 4 | 8 | 10+ | 插件哈希 3 处 RCE 绕过、`pw-file://` 离线预览 fail-open、同步 `taskkill`、手写 XML/OOXML 损坏数据 |
| `pi-bridge` / Agent 运行时 / 协议 | 6 | 6 | 11 | `PI_OFFLINE` 被覆盖、凭证 JSON 异常清库、`session-view` 5 处断裂、2,581 行上帝类与过期产物陷阱 |
| 云端栈（`apps/cloud` + `electron/cloud`） | 6 | 8 | 11 | 鉴权丢弃主体导致跨设备 RCE、宿主机无沙箱工单、`flushEvents` 卡死 `thinking`、裸 `tar` 热备 SQLite |
| 桌面渲染层核心架构 / 状态 / 性能 | 4 | 4 | 8 | 拆窗点停止失效、打包版复制失效、新建文件 0 字节覆写、`visibility: hidden` 内存泄漏、级联重渲染 |
| 设计系统 / 云端共享 UI / i18n / 工程门禁 | 4 | 6 | 8 | 6 处 `{{...}}` 占位符坏损、手写浮层 7 处碰撞、10.3 MB 字体打进公网 Web、门禁漏检与 0 E2E |

### 六大系统性矛盾

1. **“纸面安全边界”与真实实现存在大量 Fail-Open 裂口**：插件 SHA-256 校验放行 `node_modules` / `.node` / 软链目标且无哈希直接放行；云端 `requireUserPrincipal` 算出调用方身份后直接丢弃返回值；远端工单以 `mode: auto` 裸跑宿主机 `bash` 与无约束 `read`；`pw-file://` 离线预览对 opaque `"null"` 沙箱 iframe fail-open；`PI_OFFLINE` 被 `pi-bridge` 的 `allowNetwork: true` 硬覆盖。
2. **多处“拆分 / 去重”实际停留在半成品**：[agent-manager.ts](../../pi-bridge/src/agent-manager.ts) 仍 2,581 行；[useChatPanelState.ts](../../src/hooks/useChatPanelState.ts) 仍 1,554 行（聚合 109 个属性返回给 1,286 行 [ChatPanel.tsx](../../src/components/chat/ChatPanel.tsx)）；抽离 `packages/cloud-ui` 后，18 个 UI 原语被复制分叉，[CloudView.tsx](../../src/components/cloud/CloudView.tsx)（1,373 行）与 [CloudWebApp.tsx](../../apps/cloud/web-src/CloudWebApp.tsx) + [CloudWebCards.tsx](../../apps/cloud/web-src/CloudWebCards.tsx)（1,902 行）仍复制了 ~1,500 行记忆/配置/聊天代码，且 `apps/cloud/web-src` 仍反向 `../../../src/` 引用 9 个桌面文件。
3. **高密度自造轮子引发隐蔽缺陷**：手写 ZIP/XML/OOXML/EPUB 解析器存在 6 个数据损坏/乱序 Bug；手写 Modal/Popover/CommandPalette 存在 7 个焦点/Escape/`inert` 碰撞；手写 16MB 同步 LCS Diff（而包里早已含 4.14MB Monaco）；手写 `RepoWatcher` 漏掉所有 `.git/refs/**`；`pi-bridge` 内存在 4 份手抄 `atomic-json`；手写 HTTP CONNECT 代理缺失超时/SOCKS/HTTPS 支持。
4. **Electron 进程与窗口模型反噬稳定性与内存**：主进程同时跑 Agent、同步 `execFileSync('taskkill')`、同步 `readFileSync(2MB)`、每次文件请求同步 `existsSync('portable')`；渲染层用 `visibility: hidden` 常驻后台工作区导致 PDF 显存/Observer/布局泄漏；用 `window.open('about:blank')` Portal 拆窗导致拆窗停止失效、Streamdown/xterm 跨文档失灵。
5. **“轻量”定位与真实产物体积严重背离**：桌面端 `dist/` 实测 **37.20 MB（514 文件）**，含 Monaco（13.4MB 含 workers）+ Shiki 双语法高亮、KaTeX 双份打包、10.76 MB CJK 字体、无用 `quickjs-eval.wasm`；公网“轻量” `apps/cloud/web-dist/` 实测 **18.49 MB（358 文件）**，其中 **10.31 MB 为 CJK `.woff2` 字体**且由原生 `node:http` 无 gzip/brotli 直出。
6. **规则、门禁与测试本身制造“安全幻觉”**：`AGENTS.md` 把缓存与 150MB 安装器塞进 Windows Roaming `%APPDATA%`、固化 4 步手工同步 IPC、禁止持久化面板宽度；`DESIGN_SYSTEM.md` 强制 7–11.5px 微字与宋体正文；`design-system.test.ts` 用正则扫原始文本却完全漏掉 `packages/cloud-ui`；`eslint.config.js` 全局关闭 `no-explicit-any` 且不卡 warnings；主进程 IPC 测试 mock 直接绕过 `isTrustedIpcSender`；全仓 0 个真实 Electron E2E 测试且 PR CI 不在 Windows 跑单测。

---

## 二、P0 安全边界与数据丢失缺陷

### 2.1 Electron 主进程与桌面端安全

#### S-01 插件 SHA-256 哈希钉住存在 3 个主进程 RCE 绕过
- **位置**：[electron/plugin-manager.ts](../../electron/plugin-manager.ts#L95-L160), [L452-L462](../../electron/plugin-manager.ts#L452-L462), [L660](../../electron/plugin-manager.ts#L660)
- **问题机制**：插件无沙箱运行在 Electron 主进程（拥有完整 Node、`safeStorage`、`process.env` 权限）。哈希校验存在三处绕过：
  1. `computePluginDirectoryHash()` 显式跳过 `node_modules`（`L129`）且仅哈希 `.js/.cjs/.mjs/.json`（`L95, L142`），通过 `git pull` 或 Agent 修改 `<plugin>/node_modules/` 或 `.node`/`.wasm` 原生模块不会改变哈希，热重载或重启即静默执行；
  2. 对符号链接仅哈希目标路径字符串 `symlink:${rel}->${readlinkSync(full)}`（`L132-L139`），从不哈希目标文件内容；
  3. 若 `pinnedHashes[id]` 缺失（`L452-L454: if (expectedHash)`），直接 **fail-open** 跳过校验执行。
- **建议**：长期将插件迁入独立 `utilityProcess` + 显式能力消息通道；短期必须缺失哈希 fail-closed、哈希非 `.git` 全部文件（含 `node_modules` 与 `.node`）、拒绝插件目录内任何软链、禁止未经二次确认的热重载执行。

#### S-02 `pw-file://` 离线预览 fail-open、SVG 无 CSP、主窗口缺 HTTP CSP 与权限拦截
- **位置**：[electron/file-protocol.ts](../../electron/file-protocol.ts#L38), [L176-L203](../../electron/file-protocol.ts#L176-L203), [L346-L383](../../electron/file-protocol.ts#L346-L383), [electron/app-protocol.ts](../../electron/app-protocol.ts#L140-L147), [electron/aux-window.ts](../../electron/aux-window.ts#L243-L256), [src/components/editor/HtmlPreview.tsx](../../src/components/editor/HtmlPreview.tsx#L102-L108), [vite.config.ts](../../vite.config.ts#L454-L486)
- **问题机制**：
  1. `HtmlPreview.tsx:106` 使用 `<iframe sandbox="allow-scripts allow-forms">`（无 `allow-same-origin`），Chromium 赋予其**不透明源 `"null"`**。`file-protocol.ts:348-354` 在 `resolvePreviewFilePath` 返回空时仅拦截 `details.initiatorOrigin === 'pw-file://local'`，永远无法匹配 `"null"`。恶意工作区 HTML 配合 `<meta name="referrer" content="no-referrer">` 在 `pagehide`/`unload` 发起 `navigator.sendBeacon` / `fetch({ keepalive: true })` 时 `details.frame === null`、空 referrer、`initiatorOrigin === "null"`，直接走 `callback({})` 静默外泄数据；
  2. `HTML_PREVIEW_CSP` 仅挂在 `text/html`（`L201`），`image/svg+xml` 零 CSP；
  3. 联网询问弹窗只展示单个 `targetHost`，用户点“允许”后缓存键不含域名（`L383, L434-L439`），直接放行该文件访问**所有外部域名**；
  4. `aux-window.ts:245-256` 的 `setWindowOpenHandler` 用 `referrer` 黑名单，空 referrer 可绕过；
  5. 主窗口仅靠 `vite.config.ts:469` 在生产构建注入 `<meta http-equiv="Content-Security-Policy">`（无 `app-protocol.ts` HTTP 响应头，dev 态零 CSP，`<meta>` 不支持 `frame-ancestors`），且全仓未注册 `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler`。
- **建议**：`app-protocol.ts` 下发 HTTP CSP 头并注册默认拒绝的 `setPermissionRequestHandler`；`file-protocol.ts` 反转成**白名单**（仅自动放行 `pw-app://bundle` 与 dev 源，其余一律拦截/按 `(filePath, targetHost)` 授权）；对 `image/svg+xml` 下发 `script-src 'none'`；`setWindowOpenHandler` 改为源站白名单。

#### S-03 `fs:openExternally` 扩展名黑名单可被任意可执行文件绕过
- **位置**：[electron/ipc/files.ts](../../electron/ipc/files.ts#L38-L49), [L96-L113](../../electron/ipc/files.ts#L96-L113)
- **问题机制**：仅依赖 `BLOCKED_EXTERNAL_OPEN_EXTENSIONS` 黑名单调用 `shell.openPath(target)`：macOS/Linux 上无扩展名且带 `+x` 的 ELF/Mach-O/Shell 脚本 `extname === ''` 直接执行；Windows 漏掉 `.xll`/`.xlam`/`.xla`/`.ppam`/`.msix`/`.appx`/`.sct`/`.ws`/`.rdp`/`.jnlp`/`.diagcab`/`.iqy`/`.slk`/`.vsto`/`.svg`/`.html` 等格式，且未验证 `stats.isFile()`。
- **建议**：改为安全文档/媒体**白名单**（PDF、图片、音视频、Office 文档等），白名单外统一退回 `shell.showItemInFolder(target)`。

#### S-04 工作树 `session-git.json` 投毒删除非 `pi/` 分支 + 自动装依赖默认 fail-open
- **位置**：[electron/worktree-coordinator.ts](../../electron/worktree-coordinator.ts#L204), [L730-L731](../../electron/worktree-coordinator.ts#L730-L731), [L776-L777](../../electron/worktree-coordinator.ts#L776-L777), [electron/git-worktrees.ts](../../electron/git-worktrees.ts#L237-L276), [electron/worktree-deps.ts](../../electron/worktree-deps.ts#L76-L95)
- **问题机制**：
  1. 注释声称自动装依赖默认关闭（fail-closed），但 `worktree-coordinator.ts:204` 写为 `depsConfig?.isAutoInstallEnabled() ?? true`，且 `worktree-deps.ts` 执行 `npm ci` / `pnpm install` **未传 `--ignore-scripts`**，打开不可信仓库创建工作树可能直接触发恶意 `postinstall`；
  2. 仓库内可被提交的 `.pi-workbench/session-git.json` 虽在加载时标注不可信，但 `release()`（`L731`）与 `cleanupOrphans()`（`L777`，`git:repoInfo` 自动触发）在调用 `deleteBranch(repo.root, record.branch)`（`git branch -D`）前**未检查 `record.branch.startsWith('pi/')`**，恶意条目可删除 `develop` 等非托管分支。
- **建议**：将默认值改为 `?? false` 且默认 `--ignore-scripts`；将 `session-git.json` 迁出 Git 仓库至 `{appDir}/data/`，并在 `deleteBranch()` 内部硬编码强制校验 `pi/` 前缀。

#### S-05 环境变量清理漏剥离 35+ 家供应商 API Key 与内部目录路径
- **位置**：[pi-bridge/src/agent-runtime-types.ts](../../pi-bridge/src/agent-runtime-types.ts#L25-L42), [electron/terminal-manager.ts](../../electron/terminal-manager.ts#L83-L96), [electron/worktree-deps.ts](../../electron/worktree-deps.ts#L104), [electron/ipc/web-search.ts](../../electron/ipc/web-search.ts#L134), [electron/app-paths.ts](../../electron/app-paths.ts#L130-L131)
- **问题机制**：
  1. `sanitizeAgentShellEnv` / `sanitizeTerminalEnv` / `sanitizeInstallEnv` 仅剥离 `PI_WORKBENCH_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 与 `PI_WORKBENCH_*`，遗漏 `@earendil-works/pi-ai` 支持的 35+ 环境变量（含内置供应商 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`XAI_API_KEY`、`XIAOMI_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 及 `AWS_SECRET_ACCESS_KEY`、`GITHUB_TOKEN`、`GH_TOKEN`、`NPM_TOKEN`）以及指向 `{appDir}/data/agent` 的 `PI_CODING_AGENT_DIR`；
  2. `ipc/web-search.ts:134` 把解密后的联网 API Key 明文写进全局 `process.env`，迫使全仓维护 4 份互不一致的清理函数，且 `electron-updater`、Worker 线程与主进程插件仍全部继承。
- **建议**：子进程环境改用**安全白名单**（或至少统一一套过滤模块剥离 `*_API_KEY`、`*_AUTH_TOKEN`、`*_OAUTH_TOKEN`、`*_SECRET*`、`GITHUB_TOKEN`、`NPM_TOKEN`、`PI_CODING_AGENT_*`、`PI_WORKBENCH_*`）；联网密钥改为通过运行时配置直传而非污染 `process.env`。

#### S-06 凭证与模型存储 JSON 解析异常时静默清空全部供应商 + 虚假跨进程安全声明
- **位置**：[pi-bridge/src/credentials-store.ts](../../pi-bridge/src/credentials-store.ts#L16-L18), [L142-L162](../../pi-bridge/src/credentials-store.ts#L142-L162), [L275-L297](../../pi-bridge/src/credentials-store.ts#L275-L297), [pi-bridge/src/models-store.ts](../../pi-bridge/src/models-store.ts#L79-L105), [pi-bridge/src/session-extras.ts](../../pi-bridge/src/session-extras.ts#L172-L174)
- **问题机制**：
  1. `credentials-store.ts` 与 `models-store.ts` 在 `throwOnIoError`/`strict=true` 写前读路径上虽然重抛了 I/O 错误，但**吞掉了 `JSON.parse` 异常并返回空对象 `{}`**，导致下一次 `modify('openai', ...)` 用仅含单个供应商的结果原子覆写整份文件，永久丢失其他供应商的 API Key 与 OAuth Refresh Token；
  2. `credentials-store.ts` 注释声称“跨进程读-改-写安全”，实则只有进程内内存 Promise 链，双进程并发刷新一次性旋转 OAuth Refresh Token 会导致令牌作废；
  3. `session-extras.ts:173` 在覆盖 `.bak` 前未验证原文件是有效 JSON，会把已损坏主文件覆盖到唯一备份上。
- **建议**：写路径遇 `JSON.parse` 异常必须抛错（或将坏文件移至 `.corrupt.<ts>`）绝不静默返回 `{}`；引入跨进程文件锁（如 `O_CREAT|O_EXCL` 锁文件）或明确单进程代理架构；统一收敛到单份 `atomic-json.ts`。

#### S-07 文件树新建同名文件静默清空原文件为 0 字节
- **位置**：[src/components/files/FileExplorer.tsx](../../src/components/files/FileExplorer.tsx#L485-L525)
- **问题机制**：`handleCreateFile` 直接调用 `api.writeFile(filePath, '')`，无任何存在性校验，输入已有文件名（如 `package.json`、`README.md`）直接 0 字节截断原文件且无确认弹窗。
- **建议**：新增主进程 `fs:createFile` IPC，底层使用 `fs.writeFile(path, '', { flag: 'wx' })` 原子拒绝已存在文件。

---

### 2.2 云端服务（`apps/cloud`）与桌面远端执行器（`electron/cloud`）安全

#### S-08 权限分离形同虚设：`requireUserPrincipal` 返回值被丢弃 → 跨设备 RCE
- **位置**：[apps/cloud/src/http/routes.ts](../../apps/cloud/src/http/routes.ts#L128-L149), [L381-L619](../../apps/cloud/src/http/routes.ts#L381-L619), [apps/cloud/src/store/store.ts](../../apps/cloud/src/store/store.ts#L615-L621), [electron/cloud/link-store.ts](../../electron/cloud/link-store.ts#L15-L27)
- **问题机制**：`routes.ts:130-134` 注释明确写着返回调用方主体以供高敏接口做跨设备范围约束，但 `requireUser`（`L147-L149`）调用后**直接丢弃返回值**。结果任意一台桌面端的 `clientToken`（且与设备执行 `token` 同存于一份 `cloud-link.json`）均可：向**其他在线设备**签发授权并远程派活、覆写云端 LLM API Key、篡改 `AGENTS.md`/`SOUL.md` 系统提示词、往其他设备在跑工单追加指令。另 `store.ts:615-621` 对旧设备把执行 `token` 回退当 `clientToken` 使用。
- **建议**：所有高敏路由与 WS 帧强制检查 `principal`：`device-client` 仅限操作自身 `deviceId`，跨设备授权、模型配置与系统提示词文档变更必须要求管理员 Web 会话（或显式二次确认）。

#### S-09 远端工单在宿主机裸跑 `mode: auto`：读工具零防护 + `task-guard` 与 `pre-push` 可轻易绕过
- **位置**：[electron/cloud/task-runner.ts](../../electron/cloud/task-runner.ts#L43-L53), [L343-L369](../../electron/cloud/task-runner.ts#L343-L369), [L620-L622](../../electron/cloud/task-runner.ts#L620-L622), [electron/cloud/task-guard.ts](../../electron/cloud/task-guard.ts#L25-L83), [L142-L301](../../electron/cloud/task-guard.ts#L142-L301)
- **问题机制**：
  1. `task-guard.ts` 只检查 `write`/`edit` 与 `bash`/`powershell`，对 `read`/`ls`/`grep`/`find` 直接 `return undefined`（`L288`），远端工单可任意读取 `~/.ssh/id_rsa`、`~/.aws/credentials`、`cloud-link.json` 及其他项目 `.env`；
  2. `GIT_PUSH` 正则可被 `git p\ush`、`"git" push`、shell 变量、Windows 绝对路径、`git alias`、`node -e` 绕过；worktree `pre-push` hook 可被 `git push --no-verify`、`-c core.hooksPath=/dev/null` 或直接删除 hook 文件绕过，且安装 hook 失败时仅 `warn` 并 **fail-open** 继续执行（`task-runner.ts:343-369`）；
  3. `canonicalize()` 超过 20 跳软链或深度 64 时 **fail-open** 返回词法路径（`task-guard.ts:68, 77, 82`），可越出 worktree 写入/删除；
  4. `escapingRmTarget`（`L171`）仅检查带 `-r`/`-f` 的 `rm`，放行 `rm ~/.ssh/id_rsa`、`find -delete`、`mv`、重定向覆写和子 shell `(cd .. && rm -rf x)`。
- **建议**：不要把正则当安全边界——对无人值守的远端 `mode: auto` 工单引入真实 OS 沙箱 / 容器（Linux `bubblewrap`/Landlock、macOS `sandbox-exec`、Windows 容器/WSL2）；同时补齐 `read`/`ls`/`grep`/`find` 的 worktree 路径守卫，复用 `path-safety.ts` 的 fail-closed 规范化函数，hook 安装失败时拒绝派活。

#### S-10 密钥脱敏扫描漏检全部 JSON 凭据与 Pi 自身 Token，且未覆盖摘要/里程碑
- **位置**：[electron/cloud/task-report.ts](../../electron/cloud/task-report.ts#L191), [L246-L294](../../electron/cloud/task-report.ts#L246-L294), [L376-L464](../../electron/cloud/task-report.ts#L376-L464), [L566-L585](../../electron/cloud/task-report.ts#L566-L585), [electron/cloud/task-runner.ts](../../electron/cloud/task-runner.ts#L834-L840), [L913-L922](../../electron/cloud/task-runner.ts#L913-L922)
- **问题机制**：
  1. `secret-assignment` 正则（`L271`）要求键名紧跟 `\s*[:=]`，JSON 中 `"api_key": "..."` 之间存在闭合引号 `"`，**100% 漏检所有 JSON 凭据**；另漏检 Pi 自身 `pk_` Token、`aws_secret_access_key`、`https://user:pass@host`、PGP 私钥、GitLab `glpat-`、HuggingFace `hf_`、SendGrid `SG.`、含特殊字符密码，且 diff 仅修改已有 PEM 私钥中部行时因上下文无 `-----BEGIN` 导致裸体私钥未脱敏；
  2. `task_milestone.text`（原始 bash 输出预览）与 `task_result.summary`（模型总结）**从未经过脱敏扫描**，直接入库并广播给所有客户端；
  3. 超过 8 MiB diff 抛出 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 后被空 `catch` 静默吞掉，误报为“0 密钥命中”；
  4. 无引号规则对 `password = validatePasswordStrength` 等普通代码高误报，而 `classifyAttentionPath` 漏了 `terraform.tfvars`、`kubeconfig`、`*.p8`、`service-account.json` 却误把 `.env.example` 标成高敏。
- **建议**：采用成熟规则集（如 Gitleaks 规则 + 熵检测 + 兼容 JSON 引号 `["']?\s*[:=]`）；对全部出站文本字段（`summary`、`milestone.text`、`error`、`diff`）统一脱敏；`git diff` 改流式 `spawn` 避免 8MB 截断失明。

#### S-11 间接提示词注入 → 持久系统提示词投毒与自动派活升级
- **位置**：[apps/cloud/src/memory/memory-engine.ts](../../apps/cloud/src/memory/memory-engine.ts#L137-L151), [L227-L249](../../apps/cloud/src/memory/memory-engine.ts#L227-L249), [L288-L295](../../apps/cloud/src/memory/memory-engine.ts#L288-L295), [apps/cloud/src/agent/tools.ts](../../apps/cloud/src/agent/tools.ts#L95-L111), [L258-L295](../../apps/cloud/src/agent/tools.ts#L258-L295), [apps/cloud/src/tasks/dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L82), [pi-bridge/src/cloud-protocol.ts](../../pi-bridge/src/cloud-protocol.ts#L406)
- **问题机制**：不可信仓库产出的 `summary`（Zod 无长度上限）、128KB `diff`、里程碑原样写入云端会话；压缩前抽取的记忆经 `before_agent_start` 直接注入 **`systemPrompt`** 的 `<cloud-persistent-context>` 且**未做 XML 转义**（含 `</cloud-persistent-context>` 即可破壳写入高权系统指令）；云端 Agent 以 `approval: false` 运行且 `list_devices` 直接向模型打印 7 天有效期的 `authorizationId`，`quota: 1` 的授权在同一工作单元下允许追加最多 20 次 `sameUnit` 派活。
- **建议**：自动抽取记忆不得注入 `systemPrompt`，应置于低权限、带随机边界/转义的不可信数据消息块中；限制 `result.summary` 最大长度；缩短默认授权 TTL（如 2–4 小时）并明确约束 `sameUnit` 上限。

#### S-12 实时 SQLite WAL 裸 `tar` 热备损坏风险 + 全局可读 `0644` 文件权限
- **位置**：[apps/cloud/deploy/backup.sh](../../apps/cloud/deploy/backup.sh#L23-L35), [apps/cloud/deploy/pi-cloud-backup.service](../../apps/cloud/deploy/pi-cloud-backup.service#L9-L15), [apps/cloud/deploy/pi-cloud.service](../../apps/cloud/deploy/pi-cloud.service#L7-L40), [apps/cloud/src/memory/memory-store.ts](../../apps/cloud/src/memory/memory-store.ts#L360-L371)
- **问题机制**：
  1. `backup.sh:23-28` 直接对运行中的 `cloud.db`/`-wal`/`-shm` 执行 `tar czf`，违反 SQLite WAL 热备规则，并发写入或 checkpoint 时会产生不可恢复损坏库；且 `.part` 压缩包先以默认 `0644` 全局可读创建，移动后才 `chmod 600`；
  2. `pi-cloud.service` 缺少 `UMask=0077`（及 `CapabilityBoundingSet=`、`PrivateDevices`、`SystemCallFilter`、`TimeoutStopSec` 等加固项），导致 `cloud.db`、会话 JSONL 与 `AGENTS.md` 均以 `0644` 落盘；
  3. `pi-cloud-backup.service` 不必要地加载了含加密主密钥的 `/etc/pi-cloud/env`；`Caddyfile.snippet` 缺失 `Strict-Transport-Security`、`Referrer-Policy`、`Permissions-Policy`。
- **建议**：`backup.sh` 顶部设 `umask 077`，通过 `sqlite3 cloud.db ".timeout 5000" ".backup ..."`（或 Litestream）做一致快照并跑 `PRAGMA integrity_check` 后再打包；`pi-cloud.service` 增加 `UMask=0077` 与完整 systemd 沙箱及 `LoadCredentialEncrypted=`；AES-GCM 密文增加 `kid` 字段与 AAD 绑定以便密钥轮换。

#### S-13 云端供应链传递依赖未锁 + 非原子覆盖发布 + `update.sh` 鉴权坏损与提权风险
- **位置**：[scripts/build-cloud-bundle.mjs](../../scripts/build-cloud-bundle.mjs#L53-L77), [.github/workflows/cloud-release.yml](../../.github/workflows/cloud-release.yml#L92-L112), [apps/cloud/deploy/update.sh](../../apps/cloud/deploy/update.sh#L40-L52), [L107-L185](../../apps/cloud/deploy/update.sh#L107-L185)
- **问题机制**：
  1. `build-cloud-bundle.mjs` 生成不含锁文件的 `package.json`（仅锁 4 个顶层包）再运行 `npm install --omit=dev`，所有传递依赖每次构建直接从公网 npm 解析最新匹配版本，彻底绕过 `package-lock.json` 完整性哈希；
  2. `cloud-release.yml:106-107` 对固定文件名 `--clobber` 原地覆写，存在新包+旧 manifest 的竞态窗口，且无加密签名（SHA-256 与 tarball 同源托管于可变 tag，自证无效）；
  3. `update.sh:50-52` 对 `${PI_CLOUD_GITHUB_TOKEN:+-H "Authorization: Bearer ..."}` 未加引号展开，空格拆词导致私有仓库鉴权彻底失效；
  4. `update.sh:126` 以 root 执行 `tar -xzf` 未传 `--no-same-owner --no-same-permissions`；`ln -sfn`（`L137`）非原子；`L174` 清理旧版拿规范化 `REAL_DIR` 对比未规范化 `TARGET_DIR` 可能误删当前版；回滚既无健康检查也无升级前 DB 快照（前向迁移后回滚会崩环）。
- **建议**：基于根锁文件用 `npm ci --omit=dev`（或 `pnpm deploy --prod`）构建产物；发布不可变带版本号资产名并用 Cosign / GitHub Attestation 签名验签；修复 `update.sh` 参数数组、`tar` 安全参数、`ln -s && mv -Tf` 原子切换与升级前 SQLite 快照。

#### S-14 未校验远端 WS 帧可击溃 Electron 主进程 + 重新配对泄漏旧服务器连接 + 明文 `http://` 放行
- **位置**：[electron/cloud/device-agent.ts](../../electron/cloud/device-agent.ts#L176-L196), [L284-L286](../../electron/cloud/device-agent.ts#L284-L286), [L472-L541](../../electron/cloud/device-agent.ts#L472-L541), [electron/ipc/cloud.ts](../../electron/ipc/cloud.ts#L204-L205), [electron/cloud/link-store.ts](../../electron/cloud/link-store.ts#L113-L134)
- **问题机制**：
  1. `DeviceAgent.onMessage()` 直接做 TS 强制断言 `as ServerToDeviceFrame` 而不跑 Zod 校验，收到缺失 `task` 字段的 `{ v: 1, type: "task" }` 在回调中抛未捕获 `TypeError` 击溃主进程；
  2. 已配对时再次 `cloud:pair` 复用单例 `deviceAgent.start()`，既未关闭旧 `this.socket` 也未在消息监听器中校验 `this.socket === socket`，旧云端服务器仍可继续向本机下发工单；
  3. `normalizeBaseUrl` 允许任意远程明文 `http://`（不限本机回环），导致配对码、Bearer Token 与明文 LLM API Key 裸奔传输，且未拦截 `169.254.169.254` 等内网元数据地址。
- **建议**：所有 `ServerToDevice`/`ServerToClient` 帧补齐 Zod schema 并 `try/catch` 校验；`cloud:pair` 先销毁旧实例并校验 `this.socket === socket`；非 `localhost`/`127.0.0.1`/`::1` 强制 `https://`。

#### S-15 认证/限流/CSRF 薄弱与未签名发版破坏 macOS Keychain 连续性
- **位置**：[apps/cloud/src/http/router.ts](../../apps/cloud/src/http/router.ts#L120-L158), [L182-L187](../../apps/cloud/src/http/router.ts#L182-L187), [apps/cloud/src/auth/rate-limit.ts](../../apps/cloud/src/auth/rate-limit.ts#L24-L94), [apps/cloud/src/auth/credentials.ts](../../apps/cloud/src/auth/credentials.ts#L12-L60), [apps/cloud/src/http/routes.ts](../../apps/cloud/src/http/routes.ts#L159-L276), [.github/workflows/release.yml](../../.github/workflows/release.yml#L48), [package.json](../../package.json#L173-L184)
- **问题机制**：
  1. `/v1/login` 按原始 IP 字符串限流且 `globalLimit: Infinity`，任意 IPv6 `/64` 可无限爆破；`/v1/pair` 全局上限 20 次即可被 4 个 IP 永久 DoS 5 分钟；
  2. `scrypt` 使用弱默认值 `N=16384`、无版本/参数头、无最大密码长度限制，且 `/v1/setup` 绕过 `MAX_CONCURRENT_SCRYPT`；6 位配对码仅单轮 SHA-256 且并发有效码数量无上限；
  3. `/v1/setup` 默认未强制 `PI_CLOUD_SETUP_TOKEN`，而公开免鉴权的 `/v1/health` 直接广播 `hasAccount: false`，首次部署存在抢注窗口；
  4. 7 个空请求体 Cookie 写接口允许缺失 `Origin` 头（未校验 `Sec-Fetch-Site`），CSRF 防护不完整；
  5. 三平台发版均关闭代码签名（`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`，macOS `identity: null`），macOS 每次更新因 ad-hoc CDHash 变化会导致 Keychain 拒绝解密已有 `safeStorage` 凭证并令 `electron-updater` / Squirrel.Mac 无法自动更新。
- **建议**：IPv6 按 `/64` 归一化；改用 Argon2id（或带 PHC 参数头的 `scrypt` `N>=131072`）+ 128B 密码长度上限；生产首次启动强制引导口令；Cookie 写操作强制 `Sec-Fetch-Site: same-origin` 或显式自定义头；CI 接入 macOS Developer ID 签名/公证与 Windows Authenticode。

---

## 三、P0 / P1 确定性运行时与并发状态机 Bug

### 3.1 前端与跨进程功能 Bug

| 编号 | 缺陷摘要 | 精确位置 | 复现路径与根因 |
| --- | --- | --- | --- |
| **B-01** | **生产 UI 渲染原始 `{1,234}` 花括号** | [src/store/i18nStore.ts](../../src/store/i18nStore.ts#L16-L21), [src/i18n/translations.ts](../../src/i18n/translations.ts#L291-L294), [L895](../../src/i18n/translations.ts#L895), [L1281-L1284](../../src/i18n/translations.ts#L1281-L1284), [L1902](../../src/i18n/translations.ts#L1902) | `interpolate()` 只替换单花括号 `/\{(\w+)\}/g`，但 `agentOutputTruncated`、`agentEmptyResponse`、`usageReasoningTokens` 6 条中英文文案写了 `{{count}}` / `{{limit}}`，外层花括号残留到 UI。 |
| **B-02** | **拆窗/合窗期间点“停止”失效且会话被重初始化覆盖** | [src/components/panels/PanelSlot.tsx](../../src/components/panels/PanelSlot.tsx#L39-L47), [src/hooks/useChatPanelState.ts](../../src/hooks/useChatPanelState.ts#L319-L321), [L1107-L1173](../../src/hooks/useChatPanelState.ts#L1107-L1173), [src/hooks/useChatSessions.ts](../../src/hooks/useChatSessions.ts#L130-L254) | `key={host}` 强制卸载旧 `ChatPanel` 并挂载新实例；`stoppedKeysRef`/`submitRef` 存于组件本地 `useRef`。新窗口点停止写入新 ref，旧实例在途 `chat()` 读到 `false` 误判出错并拿旧闭包派发 `pending[0]`；同时新实例重跑全量初始化并拿磁盘标签覆盖内存打开标签。 |
| **B-03** | **打包版（`pw-app://`）Streamdown 所有复制按钮静默失效** | [src/components/ui/StreamdownView.tsx](../../src/components/ui/StreamdownView.tsx#L129-L134), [src/utils/clipboard.ts](../../src/utils/clipboard.ts#L4-L7) | `pw-app://` 下 `navigator.clipboard.writeText()` 必然 reject；`streamdown@2.8.1` 内置 5 处复制按钮直接调用 `navigator.clipboard.writeText()` 并吞错，完全绕过 `copyText()` IPC。 |
| **B-04** | **11 种已打包 Monaco 语言全部退化为 `plaintext`** | [vite.config.ts](../../vite.config.ts#L492-L518), [src/components/editor/MonacoEditor.tsx](../../src/components/editor/MonacoEditor.tsx#L13-L33) | 构建保留了 25 种语言，编辑器只映射了 14 种扩展名，打开 `.yaml`/`.sql`/`.sh`/`Dockerfile`/`.cpp`/`.java`/`.xml`/`.scss`/`.ps1`/`.cs`/`.php`/`.swift`/`.kt`/`.ini` 页脚显示正确语言但 Monaco 无语法高亮。 |
| **B-05** | **目录重命名/删除留下幽灵编辑器标签** | [src/components/files/FileExplorer.tsx](../../src/components/files/FileExplorer.tsx#L438), [L465](../../src/components/files/FileExplorer.tsx#L465) | `editorStore.removeOpenFile(node.path)` 仅按精确路径匹配，从不关闭被改名/删除目录下的已打开文件标签。 |
| **B-06** | **React 19 StrictMode 下 `CloudWebApp` 在状态 updater 中直接发 WS 帧** | [apps/cloud/web-src/CloudWebApp.tsx](../../apps/cloud/web-src/CloudWebApp.tsx#L489-L520), [apps/cloud/web-src/main.tsx](../../apps/cloud/web-src/main.tsx#L19) | 在 `setSession((current) => ...)` 内部调用 `wsRef.current.send(mark_read)`，StrictMode/并发渲染下重复调用导致双发帧。 |
| **B-07** | **Settings 已打开时切换目标分节不生效 & `AgentTrace` 重复 DOM ID** | [src/components/settings/Settings.tsx](../../src/components/settings/Settings.tsx#L78), [L105](../../src/components/settings/Settings.tsx#L105), [src/components/chat/AgentTrace.tsx](../../src/components/chat/AgentTrace.tsx#L350), [src/store/chatStore.ts](../../src/store/chatStore.ts#L299) | `useState(initialSection)` 忽略后续 `initialSection` 变化；`contentId = trace-${parts[0].id}` 在多条助手消息间产生重复 `id="trace-thinking-1"`，破坏 `aria-controls`。 |

### 3.2 Agent 运行时与 `pi-bridge` Bug

| 编号 | 缺陷摘要 | 精确位置 | 复现路径与根因 |
| --- | --- | --- | --- |
| **B-08** | **`PI_OFFLINE` 被 `pi-bridge` 主动绕过 + 竞写 `models-store.json`** | [pi-bridge/src/agent-catalog.ts](../../pi-bridge/src/agent-catalog.ts#L187-L191), [pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L318-L355) | `refreshCatalog()` 硬传 `allowNetwork: true` 覆盖 SDK 的 `PI_OFFLINE` 守卫，并拉取全部 8 家供应商（违背 D14）；每次工作区 `initialize()` 都在后台拉网并与主进程 `providers-service` 竞写同一缓存文件。 |
| **B-09** | **ADR-003“单一真相源”在 `session-view.ts` 存在 5 处断裂** | [pi-bridge/src/session-view.ts](../../pi-bridge/src/session-view.ts#L138-L271), [pi-bridge/src/session-entries.ts](../../pi-bridge/src/session-entries.ts#L76), [pi-bridge/src/agent-projections.ts](../../pi-bridge/src/agent-projections.ts#L78-L204), [pi-bridge/src/agent-title-service.ts](../../pi-bridge/src/agent-title-service.ts#L81-L92) | ① 跳过 `custom_message` 导致云端多轮事件唤醒重载后合并为一条巨型消息并丢失 `taskEvent`；② 未投影 `toolResult.nestedCalls`，轮末对账立刻抹除全部子 Agent 嵌套工具轨迹；③ 无条件把 `running` 改写为 `status: 'error'`，轮中快照把在跑工具误标报错；④ 轮前压缩劫持 `turn.entryId` 破坏分支锚点；⑤ 导出重造投影逻辑并丢图/用量，标题提取扫全文件 `getEntries()` 会用已撤销分支命名。 |
| **B-10** | **`AgentManager` 生命周期与并发泄漏（4 处竞态）** | [pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L1534-L1566), [L1779-L1791](../../pi-bridge/src/agent-manager.ts#L1779-L1791), [L1844](../../pi-bridge/src/agent-manager.ts#L1844), [L2427-L2448](../../pi-bridge/src/agent-manager.ts#L2427-L2448), [pi-bridge/src/agent-session-events.ts](../../pi-bridge/src/agent-session-events.ts#L204-L219) | ① `disposeRuntime()` 只判 `isProcessing`，忽略 `sdkStreaming`/compaction 未做 abort；② `agent_end` 在 `willRetry`/溢出续跑期间提前清 `sdkStreaming` 并杀掉 `bgWatchdog`；③ `openSession()`/`resetRuntimeAfterHardStop()` 绕过 `creatingRuntimes` 去重，并发时覆写 `runtimes.set` 永久泄漏 `AgentSession`；④ `requestSessionRoot()` 在压缩/后台轮次误返 `success: false` 却已挂起 `pendingRoots`；硬停恢复后还会白等第二次 5s `abort` 超时。 |
| **B-11** | **审批取消残留 + 权限归一化 fail-open 至 `'ask'` + 辅助调用不支持模型回落** | [pi-bridge/src/approval-extension.ts](../../pi-bridge/src/approval-extension.ts#L124-L148), [pi-bridge/src/approval-policy.ts](../../pi-bridge/src/approval-policy.ts#L101-L104), [L149-L155](../../pi-bridge/src/approval-policy.ts#L149-L155), [pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L2493-L2540) | ① 取消审批未传 `AbortSignal`，宿主等待 120s 且暂停 watchdog；② 损坏/非法 `permission.mode` 回落到 `'ask'` 而非 fail-closed `'readonly'`；③ `completeAuxiliaryPrompt()` 未用 `resolveActiveModel()`，配置模型下架回落后云端记忆抽取与梦境整理永久返回 `null`；④ `setSessionThinking()` 未按模型能力收敛或返回实际生效档位；⑤ `deleteSession()` 对未发消息但已写 extras 的会话提前返回导致孤儿 sidecar 泄漏；⑥ Windows 大小写路径不一致导致 `listSessions()` 漏会话、`deleteSession()` 拒删。 |
| **B-12** | **计划模式与文档工具边缘 Bug** | [pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts#L540-L598), [pi-bridge/src/plan.ts](../../pi-bridge/src/plan.ts#L57-L82), [pi-bridge/src/read-with-documents.ts](../../pi-bridge/src/read-with-documents.ts#L136-L162), [L268-L275](../../pi-bridge/src/read-with-documents.ts#L268-L275) | `rejectPlan` 缺少 `isRuntimeBusy` 守卫、`approvePlan` 在写盘前原地改内存、`isStructuredPlan` 未校验 `files` 数组；`read-with-documents` 对所有无扩展名文件（`.gitignore`/`.env`/`Dockerfile`/`Makefile`）都走魔数探测、多页扫描 PDF 仅把第 1 页塞进 `structuredContent`、abort 不取消后台 worker。 |

### 3.3 云端服务与终端执行器状态机 Bug

| 编号 | 缺陷摘要 | 精确位置 | 复现路径与根因 |
| --- | --- | --- | --- |
| **B-13** | **`CloudSession.flushEvents()` 每次空闲事件唤醒必卡死在 `thinking` 且失败丢事件** | [apps/cloud/src/agent/cloud-session.ts](../../apps/cloud/src/agent/cloud-session.ts#L287-L324) | 空闲时 `await sendCustomMessage({ triggerTurn: true })` 会等整轮 LLM 结束并触发 `onSettled() -> idle` 后才返回，随后 `L323` 执行 `if (!busy) this.beginTurn()` 把状态永久覆写回 `'thinking'`；且 `L288` 提前 `pending.clear()` 导致失败永久丢失工单通知。 |
| **B-14** | **`reclaimIfClean` 在云端 Agent 醒来前销毁工作树，破坏 `sameUnit` 续派** | [apps/cloud/src/tasks/dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L542-L550), [L197-L204](../../apps/cloud/src/tasks/dispatcher.ts#L197-L204) | 工单提交完 `worktreeClean === true`，`wake()` 节流延迟 2 秒，但 `L549` 同步判单元无在途工单即发 `close_unit` 删树；2 秒后 Agent 醒来在同单元续派直接报 `unit-closed`。 |
| **B-15** | **心跳 25s 误杀（60s 超时死代码）+ 断网零宽限秒杀健康工单 + 无 WS 背压** | [apps/cloud/src/ws/hub.ts](../../apps/cloud/src/ws/hub.ts#L378-L386), [L446-L476](../../apps/cloud/src/ws/hub.ts#L446-L476), [apps/cloud/src/tasks/dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L832-L838) | 单次丢 pong 在 25s 直接 `terminate()`；网络闪断 1 秒即不可逆标 `cancelled(device-offline)`，重连后主动发 `task_cancel` 杀死健康任务；`hub.ts` 不限 `/client/ws` 连接数也不检查 `socket.bufferedAmount`，慢客户端在 `MemoryMax=1500M` 下可拖 OOM 整服。 |
| **B-16** | **桌面执行器崩溃恢复、退出冲刷、并发与文件名判定多处 Bug** | [electron/cloud/task-runner.ts](../../electron/cloud/task-runner.ts#L284-L300), [L359-L436](../../electron/cloud/task-runner.ts#L359-L436), [L713-L719](../../electron/cloud/task-runner.ts#L713-L719), [L746](../../electron/cloud/task-runner.ts#L746), [L852-L856](../../electron/cloud/task-runner.ts#L852-L856), [L1125-L1218](../../electron/cloud/task-runner.ts#L1125-L1218), [electron/cloud/device-agent.ts](../../electron/cloud/device-agent.ts#L179-L256) | ① 离线启动 `recoverInterrupted()` 立即清空 `tasks.json` 仅放内存 `outbox`，未连上前退出即永久丢报告；② 退出时在线发送不入 `outbox`，`flush(1500)` 0ms 返回直接关连接；③ `bind` 与写 `units.json` 间崩溃永久遗留孤儿 worktree；④ `line.includes('D')` 把含大写 `D` 的修改文件（`README.md`）误标 `deleted`；⑤ 重复 `answer()`/`retryAfterConfigRefresh()` 绕过串行链、`ensureManager()` 销毁另一 `waiting_human` 任务依赖的 `AgentManager`、`dispose()` 先关会话再 `abort`；⑥ 正则 `L852` 把 `src/foo.bar/baz.ts` 里的 `foo.bar` 当改动文件。 |
| **B-17** | **云端杂项逻辑 Bug：假溢出、OAuth 刷新拆实例、梦境饿死、已吊销设备幽灵、优雅停机顺序错、UTF-8 截断乱码** | [apps/cloud/src/ws/hub.ts](../../apps/cloud/src/ws/hub.ts#L78-L98), [apps/cloud/src/main.ts](../../apps/cloud/src/main.ts#L698-L767), [L1020-L1038](../../apps/cloud/src/main.ts#L1020-L1038), [apps/cloud/src/memory/memory-engine.ts](../../apps/cloud/src/memory/memory-engine.ts#L285), [apps/cloud/src/tasks/dispatcher.ts](../../apps/cloud/src/tasks/dispatcher.ts#L626), [L903-L924](../../apps/cloud/src/tasks/dispatcher.ts#L903-L924), [L1008-L1056](../../apps/cloud/src/tasks/dispatcher.ts#L1008-L1056), [electron/cloud/task-report.ts](../../electron/cloud/task-report.ts#L539), [L574-L576](../../electron/cloud/task-report.ts#L574-L576) | ① `dropTask()` 制造 seq 空洞令 `BoundedLog.since()` 误判溢出；② OAuth 刷新更新 `updatedAt` 触发整套 `AgentManager` 拆建且明文凭证常驻 `lastGoodConfig` 堆内存；③ 梦境整理每次取最新 50 条且新梦境置顶，第 51–200 条永久饿死；④ 已吊销设备永不从列表过滤；⑤ `dispatcher` 轻信客户端时钟 `frame.at`、`nextTaskId` 从裁剪缓存算有碰撞风险、派发分 3 次事务非原子；⑥ 停机先关 `store` 后关 HTTP Server；⑦ `base` 为空时同跑 `git diff HEAD` 和 `git diff` 导致未暂存 hunk 重复，且 `subarray(0, N).toString('utf8')` 拦腰切断多字节中文产生 `U+FFFD`。 |

### 3.4 Electron 主进程原语、文档解析、更新与退出 Bug

| 编号 | 缺陷摘要 | 精确位置 | 复现路径与根因 |
| --- | --- | --- | --- |
| **B-18** | **`RepoWatcher` 静默丢弃全部 `.git/refs/**` 分支与 Tag 更新** | [electron/repo-watcher.ts](../../electron/repo-watcher.ts#L70-L134) | `fs.watch(.git/refs)` 返回相对路径 `"heads/main"` / `"tags/v1.0"`，既不在 `REF_FILES` 也不匹配 `/(refs\|logs\|worktrees)/`，全部被 `else return` 丢弃。 |
| **B-19** | **同步 `execFileSync('taskkill')` 击穿退出看门狗 + POSIX 未杀进程树** | [electron/terminal-manager.ts](../../electron/terminal-manager.ts#L228-L261), [electron/child-registry.ts](../../electron/child-registry.ts#L41-L84), [electron/main.ts](../../electron/main.ts#L1082-L1103), [electron/worktree-deps.ts](../../electron/worktree-deps.ts#L289-L292), [L491](../../electron/worktree-deps.ts#L491) | `terminalManager.closeAll()` 对每个终端跑 3s 同步 `execFileSync('taskkill')`，锁死主线程令 400ms 超时与 7.5s 看门狗失效；Unix 调 `process.kill(pid)` 未取 `-pid` 遗留子进程树；`worktree-deps` 取消时立刻从 `childRegistry` 反注册导致退出不等 `npm` 终止。 |
| **B-20** | **`AutoUpdater.quitAndInstall` 先拉静默安装后问用户 + 含空格安装路径 `/D=` 失效** | [electron/updater.ts](../../electron/updater.ts#L467-L488), [L587](../../electron/updater.ts#L587), [L626-L668](../../electron/updater.ts#L626-L668), [electron/main.ts](../../electron/main.ts#L816-L855) | `quitAndInstall` 先 detached 拉起 `installer.exe /S` 再调 `app.quit()`，用户在 `will-prevent-unload` 点取消仍会被后台覆写；默认路径 `Pi Workbench` 含空格导致 NSIS `/D=` 失效；`fetchLatestGithubRelease` 绕过 `useSystemProxy: false`；全仓存在两套互不一致且均不支持 prerelease 的手写 SemVer 比较。 |
| **B-21** | **`ApprovalBroker` 在主窗缺失时挂死 10 分钟（违反 fail-closed）** | [electron/main.ts](../../electron/main.ts#L328-L341), [electron/approval-broker.ts](../../electron/approval-broker.ts#L119-L143) | `!mainWindow` 时 `send` 回调静默返回而不抛错，工具调用挂死至 `MAX_TIMEOUT_MS`（10 分钟）；重复 `requestId` 覆盖旧条目泄漏计时器；`cancelForWorkspace` 未规范化路径。 |
| **B-22** | **手写 ZIP / XML / OOXML / PDF 解析器 7 处实测 Bug** | [electron/documents/xml.ts](../../electron/documents/xml.ts#L84-L188), [electron/documents/ooxml.ts](../../electron/documents/ooxml.ts#L153-L249), [L393-L397](../../electron/documents/ooxml.ts#L393-L397), [L600-L606](../../electron/documents/ooxml.ts#L600-L606), [electron/documents/zip.ts](../../electron/documents/zip.ts#L43-L165), [electron/documents/preview.ts](../../electron/documents/preview.ts#L152-L215), [electron/documents/extract.ts](../../electron/documents/extract.ts#L182-L189), [electron/documents/render-bridge.ts](../../electron/documents/render-bridge.ts#L58-L95) | ① 自闭合 `<script/>` 清空整章 EPUB；② 去命名空间引发 `<p:sldId id r:id>` 属性覆盖打乱 PPTX 页序；③ 缺 `r` 属性的 XLSX `<row>` 全覆写第 0 行；④ 嵌套 DOCX 表格清空外层行；⑤ 内部 DTD `[...]` 截断泄文本；⑥ ZIP 缺 ZIP64/CRC32 与 EOCD 精确校验；⑦ 按页读大 PDF 读取+解析整份 100MB 文件**两遍**，且 `pickTargetWindow` 会回退选到无 preload 辅助窗挂死 60s。 |
| **B-23** | **并发/存储/路径边缘 Bug 簇（`TerminalManager` / `WorkerClient` / `DraftStore` / `FileLogger` / `system-proxy` / `git` / `settings`）** | [electron/terminal-manager.ts](../../electron/terminal-manager.ts#L198), [L286-L342](../../electron/terminal-manager.ts#L286-L342), [electron/worker-runner.ts](../../electron/worker-runner.ts#L114-L172), [electron/draft-store.ts](../../electron/draft-store.ts#L55-L130), [electron/logger.ts](../../electron/logger.ts#L146-L185), [electron/system-proxy.ts](../../electron/system-proxy.ts#L91-L165), [electron/git-worktrees.ts](../../electron/git-worktrees.ts#L286-L442), [electron/ipc/settings.ts](../../electron/ipc/settings.ts#L115-L151), [electron/path-safety.ts](../../electron/path-safety.ts#L59), [electron/repo-map-canvas.ts](../../electron/repo-map-canvas.ts#L85-L123) | ① `activeAsyncWrites` 是 `Set` 而非引用计数，`onExit` 绕过保护；② `WorkerClient` 回调无 `reqId` 并发串台且单次超时杀共享 worker；③ `DraftStore` 漏传 `fsync: false` 每次自动保存刷盘、删除绕过写队列可被复活、所有工作区混放单目录；④ `FileLogger.close()` 丢/乱序在途日志；⑤ `system-proxy` CONNECT 无超时、死错误监听、不支持 SOCKS/HTTPS 代理；⑥ `git status` 未禁 `quotepath` 令中文路径八进制转义，`getRepoInfo()` 每次起 9 个 `git` 进程；⑦ `app:saveSettings` 部分保存抹掉未列举配置字段；⑧ `isPathInsideRoot` 误拒 `..env`；⑨ `repo-map-canvas` 允许 `'__proto__'` 原型污染；⑩ `main.ts` 在单实例锁之前执行旧目录迁移、开 3 个日志、写注册表并在模块顶层打开 SQLite；⑪ `watch-filter.ts` 按任意层级忽略 `cache`/`dist`/`release`/`logs` 破坏 `src/cache/`；⑫ `github-oauth.ts` 只做只读 GET 却索要全量读写 `repo` 权限；⑬ `ipc/files.ts:123` `fs:writeFile` 非原子写，崩在半途截断源码文件。 |

---

## 四、架构编排与模块设计缺陷

### A-01 主进程承载 Agent 与同步重操作，缺乏崩溃与事件循环隔离
- **位置**：[docs/agent/agent-runtime.md](../../docs/agent/agent-runtime.md#L12-L13), [electron/app-paths.ts](../../electron/app-paths.ts#L60-L110), [pi-bridge/src/agent-session-events.ts](../../pi-bridge/src/agent-session-events.ts#L237-L300)
- **问题**：硬性要求 Agent 必须与窗口共处 Electron 主进程；每次 `write`/`edit` 工具起止都在主线程同步 `readFileSync`（最大 2MB）且未做 `realpath` 软链校验、无总量上限；`getAppDir()` 未记忆化，导致每次 `pw-file://` 和 `fs:*` 请求都同步 `fs.existsSync('portable')`。
- **改进**：主进程保持薄壳，将 Agent 循环、MCP 与插件迁至 Electron `utilityProcess`，通过 `MessageChannelMain` 直连渲染层传流式帧；`resolveAppPaths()` 启动单次记忆化；文件 diff 快照改为异步且设总内存上限。

### A-02 `window.open('about:blank')` React Portal 拆窗模型与第三方库根本冲突
- **位置**：[docs/decisions/ADR-001-detachable-panels.md](../../docs/decisions/ADR-001-detachable-panels.md), [src/panelHost/auxWindow.ts](../../src/panelHost/auxWindow.ts#L54-L151), [src/components/panels/PanelSlot.tsx](../../src/components/panels/PanelSlot.tsx#L20-L47), [electron/ipc/register.ts](../../electron/ipc/register.ts#L21-L29)
- **问题**：
  - `Streamdown` 硬编码全局 `document.addEventListener` / `document.body.style.overflow`，拆出聊天窗中 Mermaid 全屏按 `Esc` 关不掉、下拉菜单点外部关不掉；
  - `@xterm/xterm@6.0.0` 原地修改 `mainWindow.document.head` 的 `<style>.innerText`，但 `auxWindow.ts` 的 `MutationObserver` 缺 `subtree`/`characterData` 且不清理移除节点；
  - 拆出窗点击“查看更改”或 Git 提交，弹窗落在已隐藏的主窗口里；`auxWindow.ts` CSP 漏了 `pw-file:`；
  - 主进程仍向无 `preload` 的辅助窗广播所有流式帧（`BrowserWindow.getAllWindows()`），且 `register.ts` 残留零调用的 `trustIpcSender`。
- **改进**：改为标准多 `BrowserWindow` 加载同套前端入口（`?panel=chat&workspace=...`）+ 主进程/BroadcastChannel 状态同步，彻底根除跨 Realm DOM 缺陷。

### A-03 多工作区 `visibility: hidden` + `inert` 保活造成显存、Observer 与后台 I/O 泄漏
- **位置**：[src/components/workspace/WorkspaceView.tsx](../../src/components/workspace/WorkspaceView.tsx#L190), [L297-L305](../../src/components/workspace/WorkspaceView.tsx#L297-L305), [src/components/editor/PdfReadingView.tsx](../../src/components/editor/PdfReadingView.tsx#L174-L182), [src/components/editor/MonacoEditor.tsx](../../src/components/editor/MonacoEditor.tsx#L204-L382), [src/components/files/FileExplorer.tsx](../../src/components/files/FileExplorer.tsx#L316-L326), [src/hooks/useFileDocument.ts](../../src/hooks/useFileDocument.ts#L307-L321)
- **问题**：Chromium 下 `visibility: hidden` 仍参与完整布局、合成、Observer：后台工作区每个 PDF 钉住 150–250MB 画布位图；Monaco 同时开 `automaticLayout` + `ResizeObserver` + `window.resize` 三重重排；`FileExplorer` 在隐藏工作区持续响应 `fs:changed` 递归拉目录；`useFileDocument` 切回时绕过 `syncFile()` 把 PDF/视频/图片也送进 `api.readFile()`。
- **改进**：参考 VS Code **Model/View 分离**（内存保留 `ITextModel`、`ICodeEditorViewState`、PTY 缓冲与 Zustand 状态，卸载非活跃工作区 DOM），或至少切换为 `display: none` / `content-visibility: hidden` / React 19.2 `<Activity>`。

### A-04 上帝文件、`pi-bridge` 杂物间化与过期产物陷阱
- **位置**：[pi-bridge/src/agent-manager.ts](../../pi-bridge/src/agent-manager.ts)（2,581 行）, [pi-bridge/src/cloud-protocol.ts](../../pi-bridge/src/cloud-protocol.ts)（1,056 行）, [src/hooks/useChatPanelState.ts](../../src/hooks/useChatPanelState.ts)（1,554 行）, [src/components/chat/ChatPanel.tsx](../../src/components/chat/ChatPanel.tsx)（1,286 行）, [pi-bridge/package.json](../../pi-bridge/package.json), [vitest.config.ts](../../vitest.config.ts)
- **问题**：
  1. `AgentManager` 仍塞入 13 项职责并共享 32 字段可变 `SessionRuntime`；`pi-bridge` 混杂 Node SDK、存储、纯协议与预设，未导出浏览器安全子路径导致 `packages/cloud-ui/src/types.ts`（236 行）与 `electron/ipc/agent-helpers.ts` 反复复制代码；
  2. `npm run type-check` 校验过时 `pi-bridge/dist/*.d.ts`，`npm test` 同一轮混引 `pi-bridge/src/` 与过时 `pi-bridge/dist/`，且 `electron/ipc/agent.ts` 动态 `import(getBridgeEntryUrl())` 丢失静态类型退化为 `any`；
  3. `cloud-protocol.ts` 已存在 `branch` vs `defaultBranch` 类型漂移（被 `as unknown as T` + `.loose()` 掩盖）、`task_result` 漏校验 `diff`/`tests`/`worktreeClean`、`decodeFrame` 依赖 `Set` 引用相等才触发校验、`negotiateProtocolCapabilities` 是生产零调用死代码；
  4. `pi-bridge` 内复制了 4 份 `atomic-json` 实现；`runtime.messageHistory` 无限累积内存且生产零调用。
- **改进**：`AgentManager` 拆为 `SessionController` + `SessionRepository` + 轻宿主；将纯协议/预设/图片校验拆为浏览器安全子路径并用 `z.infer` 作为唯一类型源；采用 TypeScript Project References + Vitest alias（或 `esbuild`/`tsup` 一体构建）消除手动 `build:bridge` 与过期产物。

### A-05 5 文件 4,400 行手工 IPC 胶水与双运行时开发桥
- **位置**：[electron/preload.cts](../../electron/preload.cts)（531 行）, [src/types/electron.d.ts](../../src/types/electron.d.ts)（1,796 行）, [src/api/index.ts](../../src/api/index.ts)（957 行）, [src/api/piAgentAPI.ts](../../src/api/piAgentAPI.ts)（860 行）, [vite.config.ts](../../vite.config.ts#L16-L444)（430 行 `devAgentBridge`）
- **问题**：182 个频道跨 5 处手工同步已发生真实撒谎（`writeClipboardText` 返回 `{ success, error }` 却声明 `Promise<boolean>`；`AgentStreamPayload` 字段缺漏）；`piAgentAPI.ts` 吞异常转 `{ success: false }` 而 `api/index.ts` 直接抛 reject 导致调用方处理失配；`vite.config.ts` 内嵌 430 行非原子落盘且服务关闭不释放 `agents` 的 HTTP 替身桥（加上 555 行 `mockAPI`），维护成本高且掩盖 Electron 真问题（如 `pw-app://` 剪贴板）。
- **改进**：用单源 Typed IPC Contract（`electron-trpc` / `@egoist/tipc` / Zod Channel Map）统一驱动主进程、preload、类型与渲染层客户端，收缩或移除 `vite.config.ts` 内嵌服务端。

### A-06 `packages/cloud-ui` 抽取不彻底与双向跨包纠缠
- **位置**：[packages/cloud-ui/src/primitives.tsx](../../packages/cloud-ui/src/primitives.tsx), [src/components/cloud/CloudView.tsx](../../src/components/cloud/CloudView.tsx), [apps/cloud/web-src/CloudWebApp.tsx](../../apps/cloud/web-src/CloudWebApp.tsx), [apps/cloud/web-src/CloudWebCards.tsx](../../apps/cloud/web-src/CloudWebCards.tsx), [.github/workflows/cloud-release.yml](../../.github/workflows/cloud-release.yml#L10-L18)
- **问题**：仅因 `ui.tsx` 用了 `useHostDocument`，`packages/cloud-ui` 复制了 18 个 UI 原语并已出现样式/A11y 分叉；记忆管理（435 行 vs 425 行）、模型配置（219 行 vs 211 行）、消息行、输入框与侧栏仍各自维护两份；同时 `apps/cloud/web-src` 仍通过 `../../../src/` 反向导入 9 个桌面文件，逼迫 `cloud-release.yml` 手工枚举路径触发构建。
- **改进**：抽出零桌面依赖的 `@pi-workbench/ui`（`hostDocument` 通过 Context 可选注入），把共享 Markdown/Trace/Memory/Config/Composer 全部收口进 `@pi-workbench/cloud-ui` + `CloudTransport` 适配器，彻底斩断 `../../../src/` 跨包回指。

### A-07 云端 SQLite 退化为全表内存 JSON 转储 + 单会话与单进程瓶颈
- **位置**：[apps/cloud/src/store/store.ts](../../apps/cloud/src/store/store.ts#L172-L323), [L522-L621](../../apps/cloud/src/store/store.ts#L522-L621), [apps/cloud/src/agent/cloud-session.ts](../../apps/cloud/src/agent/cloud-session.ts)
- **问题**：启动把全表读进 JS 数组，每次查表 O(N) 遍历并现拼 `db.prepare()`；`idx_tasks_device_status` / `idx_tasks_idempotency` **100% 死索引**；开了 `PRAGMA foreign_keys = ON` 却零外键；`createAccount`/`consumePairingCode`/`updateAuthorization` 注释号称 SQLite CAS 实则读 JS 数组做无条件 `UPDATE`；无 `PRAGMA user_version` 迁移机制；`memories.json`/`dreams.json` 与 `cloud.db` 脑裂；`units`/`authorizations`/`devices` 永不清理；全站单线性会话导致跨仓库上下文互污染与高噪音唤醒；所有队列/限流/状态都在单进程内存里，`update.sh` 重启即中断一切。
- **改进**：改用真实关系查询 + 缓存 Prepared Statement + `PRAGMA user_version` 迁移 + 索引化 token 查找（`pk_<kid>.<secret>`）+ 将记忆/梦境/出站队列表合入同一事务库；按项目/工作单元拆分会话线程并仅在高信号状态变化时唤醒模型。

### A-08 将工作台运行态文件写入用户 Git 仓库 `.pi-workbench/`
- **位置**：[electron/terminal-manager.ts](../../electron/terminal-manager.ts), [electron/git-worktrees.ts](../../electron/git-worktrees.ts), [electron/plugin-manager.ts](../../electron/plugin-manager.ts), [electron/ipc/agent-sessions.ts](../../electron/ipc/agent-sessions.ts#L18-L47)
- **问题**：把明文终端历史（永不清理的 `terminal-*.log`）、标签态、`session-git.json`、`repo-map*.json`、`plugins/` 放进用户仓库内，带来 `.pi-workbench` 软链逃逸风险、仓库提交投毒风险与修改 `.git/info/exclude` 污染。
- **改进**：遵循 VS Code `workspaceStorage` 模式，将工作台运行态与托管状态统一落入 `{appDir}/data/workspaces/<canonical-hash>/`。

### A-09 封闭工具生态（无 MCP 支持）
- **位置**：[docs/PROJECT_PLAN.md](../../docs/PROJECT_PLAN.md#L124)
- **问题**：明文禁止 Agent 扩展且不支持 **Model Context Protocol (MCP)**，在 2026 年主流编码工作台（Claude Code / Cursor / Zed）全员标配 MCP 的生态下，用户无法接入数据库、Jira/Linear、内部 API 等标准工具。
- **改进**：在隔离的 `utilityProcess` 中按需引入受控 MCP Client，并统一纳入现有 `approval-policy` 权限矩阵。

---

## 五、前端设计、渲染性能与 Paper & Ink 设计系统评审

### F-01 手写浮层、命令面板与基础组件存在 7 处交互/A11y 碰撞
- **位置**：[src/components/ui/ui.tsx](../../src/components/ui/ui.tsx#L157-L352), [L482-L646](../../src/components/ui/ui.tsx#L482-L646), [src/components/ui/patterns.tsx](../../src/components/ui/patterns.tsx#L159-L248), [L478-L544](../../src/components/ui/patterns.tsx#L478-L544), [src/components/workspace/CommandPalette.tsx](../../src/components/workspace/CommandPalette.tsx#L113-L184), [src/components/ui/Toast.tsx](../../src/components/ui/Toast.tsx#L41-L89)
- **问题汇总**：
  1. `Modal` 内的 `PopoverMenu` 按 `Escape` 时因 FIFO 冒泡顺序直接关掉整个 `Modal`；
  2. `Modal` 先设 `inert` 再读 `activeElement`（`ui.tsx:555-556`），Chromium 立即 blur 至 `body` 破坏关闭后的焦点恢复；
  3. 嵌套 `Modal` 不锁定父 `Modal`（`modalInertNodes` 并非文档声称的引用计数），且桌面端混用 `ui.tsx` 与 `cloud-ui/primitives.tsx` 两套互不知晓的 `Modal`；
  4. `CommandPalette` 从更高层 `z-[60]` 弹窗强抢 Tab 焦点，且缺 `combobox`/`listbox`/`aria-activedescendant`；
  5. `PopoverMenu` 因内联 `onClose` 在父重渲染时重复抢焦点、未走 Portal 易被裁切、无视口翻转；
  6. 任意 `Modal` 打开时 `ToastContainer` 处于 `#root` 内被 `inert`，无法点关闭；`Toast` 错误提示未用 `role="alert"`、3 秒硬消失不响应悬停且可双调 `onClose`；
  7. `Tab` 隐藏关闭按钮无 `tabIndex={-1}` 形成键盘陷阱，且 `<div>` 包裹 `<button role="tab">` 未设 `role="presentation"`；`ListRow` 恒为 `<button>` 包裹 `trailing` 存在嵌套交互风险；`Select` 把 `className` 挂在内层 `<select>` 而非外层容器。
- **建议**：用 **Base UI / Radix UI**（支持 `container={hostDocument.body}`）+ **Floating UI** + **`cmdk`** 替代手写实现。

### F-02 级联重渲染风暴与主线程卡顿
- **位置**：[src/App.tsx](../../src/App.tsx#L80-L105), [src/hooks/useChatPanelState.ts](../../src/hooks/useChatPanelState.ts#L70-L72), [L965-L1035](../../src/hooks/useChatPanelState.ts#L965-L1035), [L1126-L1128](../../src/hooks/useChatPanelState.ts#L1126-L1128), [src/components/editor/MonacoEditor.tsx](../../src/components/editor/MonacoEditor.tsx#L393-L397), [src/hooks/useChatAttachments.ts](../../src/hooks/useChatAttachments.ts#L59-L84), [src/components/chat/AgentTrace.tsx](../../src/components/chat/AgentTrace.tsx#L487-L529), [src/utils/shikiHighlighter.ts](../../src/utils/shikiHighlighter.ts#L210-L274), [src/api/diff.ts](../../src/api/diff.ts#L46-L77), [src/pdf/renderPages.ts](../../src/pdf/renderPages.ts#L23-L46), [src/components/repo-map/RepoMapCanvas.tsx](../../src/components/repo-map/RepoMapCanvas.tsx#L135-L291), [L921-L995](../../src/components/repo-map/RepoMapCanvas.tsx#L921-L995), [src/components/git/GitView.tsx](../../src/components/git/GitView.tsx#L436-L714), [src/theme/tokens.ts](../../src/theme/tokens.ts#L50-L66)
- **核心瓶颈**：
  - `App.tsx` 无 selector 订阅全量 `workspaceStore`/`toastStore`/`sessionStore`，而所有核心面板均未 `React.memo`，每 2s 自动保存弹 Toast 触发全部工作区整树重渲染；
  - `draftInput` 与 `messages` 绑在同一 `ConversationState` 对象里，聊天打字每键重渲染 1,286 行 `ChatPanel`，流式 50ms 节拍也反向重渲染输入框；每次流式 flush 对 N 个事件循环调 N 次 Zustand `set()`；`ToolRow` 传入内联闭包击穿 `React.memo`；
  - Monaco 每次击键 `editor.getValue()` 推入 Zustand，随后 `useChatAttachments` 对整文件跑正则提取符号；
  - Shiki 对未闭合流式代码块绕过缓存每 50ms 在 React render 里 O(N²) 同步高亮；手写 `computeDiff` 同步分配 16MB `Int32Array`；`renderPages` 主线程同步 `canvas.toDataURL('image/png')` 冻结 150–500ms 且与 `loadPdf.ts` 互相覆写 `workerPort` 泄漏 PDF worker；
  - `RepoMapCanvas` 拖拽/缩放每帧 rAF 调 `setViewportRect` + `setZoom` 重渲染三层组件（伪 60fps）、每次渲染重复建 saver 对象、渲染期读 `dragRef.current`，且全局劫持 `Space` 键破坏聊天/文件树/Git 滚动；
  - 每次轮末 `sessionsOpen` 经 IPC 序列化全量历史（含 48MB base64 图），`findSessionFile` 每次全盘扫所有 `.jsonl`，`deriveMessages` 工具查找为 O(T²)；
  - `tokens.ts` 切主题时同步翻转 `html.dark` 触发 `2×N` 次全文档样式重算。

### F-03 产物体积臃肿与重复引擎
- **实测数据**：
  - 桌面端 `dist/`：**37.20 MB（514 文件）** — `ts.worker` 6.88MB + `monaco` 4.14MB + `mermaid` 3.33MB + `pdf.worker` 1.19MB + `css/html/json workers` 2.13MB + **Shiki 33 份重复语言语法（`cpp` 770KB）** + **KaTeX 双份打进 `markdown` 与 `mermaid` chunk 且 CSS 进首屏** + **`quickjs-eval.wasm` 458KB 无用打包** + **10.76 MB CJK 字体** + `@xterm/xterm` 静态打入 `WorkspaceView.js`（551KB）+ `MarkdownReadingView` 用 `unified/remark-parse` 解析一遍切块再交给 N 个 `<Streamdown>` 二次解析。
  - 云端 Web `apps/cloud/web-dist/`：**18.49 MB（358 文件）** — **10.31 MB CJK 可变字体（207 个 `.woff2`）** + `index.js` 852KB + `cynefin`/`cytoscape` 1.11MB + `katex` 548KB + 原生 `node:http` 无 gzip/brotli 压缩直出。

### F-04 Store 架构分裂与 Zustand v4 + React 19
- **位置**：[src/store/editorStore.ts](../../src/store/editorStore.ts#L187-L204), [src/App.tsx](../../src/App.tsx#L384-L402), [L649-L655](../../src/App.tsx#L649-L655), [src/store/themeStore.ts](../../src/store/themeStore.ts#L22-L39), [src/components/cloud/CloudView.tsx](../../src/components/cloud/CloudView.tsx#L142-L171), [package.json](../../package.json#L107)
- **问题**：9 个工作区 store 中仅 2 个走 `xxxStoreFor`，其余 7 个为全局单例 Map 且存在多个永不清理的模块级 Map 泄漏；`editorStoreFor` 读即创建（`beforeunload` 误建 store），`setTimeout(..., 0)` 销毁与异步回调竞态复活；删除工作树后对应 store 永久滞留；停留在 `zustand@4.5.7`（走 CJS shim）；`CloudView`/`GitView` 分别出现 29 个 / 20 个分散 store hook；`useResolvedTheme` 每组件挂一个 `matchMedia` 监听。

### F-05 CSS 缺陷、Cloud Web 移动端/A11y 与 5 套割裂 i18n
- **位置**：[src/index.css](../../src/index.css#L66-L167), [L636-L649](../../src/index.css#L636-L649), [tailwind.config.js](../../tailwind.config.js#L20-L38), [apps/cloud/web-src/index.html](../../apps/cloud/web-src/index.html#L5), [apps/cloud/web-src/CloudWebApp.tsx](../../apps/cloud/web-src/CloudWebApp.tsx#L683-L803), [apps/cloud/web-src/CloudWebCards.tsx](../../apps/cloud/web-src/CloudWebCards.tsx#L263-L786), [src/i18n/errors.ts](../../src/i18n/errors.ts#L8-L33)
- **问题**：
  - `index.css` 设 `* { scrollbar-width: thin }` 令 Chromium ≥ 121 中后续 `::-webkit-scrollbar*` 全变死代码；`html.dark` 缺 `color-scheme: dark` 令原生 `<select>` 与滚动条泛白；`prefers-reduced-motion` 冻结全部加载中 `<Spinner>`；全局 `optimizeLegibility` 拖慢排版；`rule-*` 颜色配置不支持 `/opacity` 修饰符；`:focus-visible` 仅 1px 且输入框 `focus:outline-none` 取消焦点环；
  - Cloud Web 声明 `viewport-fit=cover` 却零 `env(safe-area-inset-*)`；输入框 `12.5px < 16px` 触发 iOS 自动放大；表单控件缺 `<label>`/`aria-label`；错误文案错用品牌松绿 `text-accent` 而非 `text-danger`；删除设备/授权/记忆零二次确认；错误横幅 `truncate` 截断且无提示；硬编码过时回退版本号 `'0.11.2'`；
  - 全仓并存 **5 套割裂的 i18n 实现**（97.7KB 单体 `translations.ts`、主进程硬编码 `TRAY_LABELS`、`cloud-ui` 默认中文+手传 label prop 袋、Cloud Web 100% 中文、`CloudTraceSection` 内联三元）；错误本地化靠脆弱的英文原文精确字符串匹配而非结构化错误码；无复数支持，`.toLocaleString()` 不传应用语言。

### F-06 Paper & Ink 视觉与排版规范本身的工程与人体工学缺陷
- **位置**：[docs/design/DESIGN_SYSTEM.md](../../docs/design/DESIGN_SYSTEM.md#L33-L96), [src/index.css](../../src/index.css#L60-L64), [L178-L367](../../src/index.css#L178-L367), [tailwind.config.js](../../tailwind.config.js#L98-L107)
- **问题**：
  1. 定义了 `7px`（未文档化）、`8.5px`、`9px`、`10.5px`、`11px`、`11.5px` 微字，功能路径/SHA/时间戳广泛用 `11.5px`，Windows ClearType 下极易视觉疲劳；
  2. 长编码回复强行用中文字体 `--font-reading: 'Noto Serif SC Variable', 'Songti SC', 'SimSun', serif`（缺拉丁衬线且回退 Windows 点阵宋体），与无衬线等宽行内代码混排冲突明显；
  3. 规范自相矛盾：`DESIGN_SYSTEM.md:83` 写 `type-eyebrow-cjk` 为 `11px ui`，但 `index.css:189` 为衬线且 `WelcomeScreen.tsx:156` 用它渲染全大写英文；`Card` 规范写 20–24px 实装 12–16px；`tailwind.config.js` 定义了 `rounded-md: 2px`（等同 `rounded`）却被规范与测试禁用；
  4. `shadow-print: 5px 6px 0` 硬投影挂在编辑器浮窗/Toast 上制造视觉噪点；教条禁用 `dark:` 与标准字号类导致无法做深浅模式光学微调与移动端响应式字号。

---

## 六、规则文件、门禁、测试与工程工具链本身的缺陷

### R-01 `AGENTS.md` 中的不合理与过时约束
- **位置**：[AGENTS.md](../../AGENTS.md#L6-L85), [build/installer.nsh](../../build/installer.nsh#L8-L95)
- **问题**：
  1. **“严格两目录模型”违背 OS 规范**：把 Chromium 缓存、草稿与永久留存的 ~150MB `installer.exe` 全部写进 Windows **Roaming `%APPDATA%`**（企业漫游目录）与 macOS `Application Support`（Time Machine 备份目录），而不是 `%LOCALAPPDATA%` / `~/Library/Caches`。（另 `installer.nsh:94` 的 `ie4uinit.exe -show` 是 Win7/8 废弃参数，卸载确认页也缺数据永久删除警告。）
  2. **禁止持久化面板宽度**：将用户手动调整的面板宽度与临时窗口句柄混为一谈，重启即重置布局，桌面 IDE 体验差。
  3. **硬规定 Toast 3 秒自动消失**：错误 Toast 不保留/不悬停暂停，违反 WCAG 2.2.1。
  4. **制度化 4 步手工同步 IPC**：把本应单源自动生成的类型契约固化为人工流程。
  5. **文档失真**：宣称 TypeScript 5.9（`package.json` 仍写 `^5.3.3`）；宣称 `type-check` 覆盖全仓（`tsconfig.node.json` 漏掉 `vite.config.cloud-web.ts`）；3 份 ADR 引用的 `DESIGN_SYSTEM.md` 6.7/6.12–6.14 章节均已失效。

### R-02 `tests/ui/design-system.test.ts` 与 `eslint.config.js` 的盲区与误报
- **位置**：[tests/ui/design-system.test.ts](../../tests/ui/design-system.test.ts#L5-L374), [eslint.config.js](../../eslint.config.js#L37-L148)
- **问题**：
  - `design-system.test.ts` **完全跳过 `packages/cloud-ui/src/`** 与所有 `.ts` 文件、漏检 14 个 Tailwind 色系与 `ring-*`/`fill-*`/`rounded-t-lg`/`text-[1rem]`、对 `App.tsx`/`ChatPanel.tsx` 等大文件整文件豁免 `border-line`，却对原始源码跑正则导致注释里的 `#123`/`uppercase`/`dark:` 误报；
  - `eslint.config.js` 全局关闭 `@typescript-eslint/no-explicit-any`（放行 `frameReducer.ts` 7 处 `any`）、未开 `no-floating-promises`、AST 十六进制色值规则漏过 `'bg-[#ff0000]'` 和模板字面量、`eslint .` 未设 `--max-warnings 0` 令 `exhaustive-deps` 告警不阻断 CI。

### R-03 测试与 CI 的“假绿”盲区及配置瑕疵
- **位置**：[.github/workflows/ci.yml](../../.github/workflows/ci.yml), [.github/workflows/release.yml](../../.github/workflows/release.yml), [tests/electron/main-ipc.test.ts](../../tests/electron/main-ipc.test.ts#L31-L85), [tests/electron/aux-window.test.ts](../../tests/electron/aux-window.test.ts#L11), [tests/ui/renderer-components.test.tsx](../../tests/ui/renderer-components.test.tsx), [tsconfig.json](../../tsconfig.json), [electron/tsconfig.json](../../electron/tsconfig.json), [pi-bridge/tsconfig.json](../../pi-bridge/tsconfig.json)
- **问题**：
  1. **0 个 Playwright / Electron E2E 测试**：CI `verify` 跳过 Electron 二进制，`package-smoke` 打包 `--win --dir` 后从未启动一次 `.exe`；
  2. **PR CI 不在 Windows 跑 `npm test`**，跨平台回归拖延到打 `v*` 发版 tag 才暴露；
  3. **Mock 绕过安全门禁**：`main-ipc.test.ts` 与 `aux-window.test.ts` 中 `app.isReady: () => false` 直接放行 `isTrustedIpcSender`；`phase0-security-and-reliability.test.ts:116` 在 Windows 无软链权限时直接 `return` 通过；`renderer-components.test.tsx` 2,149 行手工 mock 50+ IPC；
  4. **TS/脚本配置缺口**：`tsconfig.node.json` 漏 `vite.config.cloud-web.ts`；根 `tsconfig.json` 把渲染层、Cloud Web 与 Node 测试混在一份 DOM 配置中；`electron/tsconfig.json` 在 Node 24 ESM 下用已废弃 `moduleResolution: "node"` 且缺 `noUnusedLocals`；`pi-bridge/tsconfig.json` 用 `Bundler` 解析直出 Node ESM（不校验 `.js` 扩展名）；`package.json` `format` 脚本漏 `packages/cloud-ui`、`apps/cloud` 与 `tests/**/*.tsx`；两份 `vite.config*.ts` 原样复制 `fontSubsetFilter()`。

---

## 七、社区 / 业界更优方案对照矩阵

| 功能域 | 当前实现 | 核心问题 | 社区 / 业界推荐方案 |
| --- | --- | --- | --- |
| **Agent 与插件运行边界** | 强绑 Electron 主进程 | 阻塞 UI、崩溃连坐、主进程无沙箱 RCE | **Electron `utilityProcess` + `MessageChannelMain`** |
| **远端自动工单隔离** | 正则 `task-guard.ts` + 可绕过 `pre-push` | 宿主机任意读与 RCE | **OS 沙箱 / 容器**（Linux `bubblewrap`/Landlock、macOS `sandbox-exec`、Windows 容器/WSL2） |
| **跨进程 Typed IPC** | 5 文件 4,400 行手工维护 + 字符串测试 | 类型漂移、错误模型割裂 | **单源契约**：`electron-trpc` / `@egoist/tipc` / Zod Channel Registry |
| **面板拆窗** | `window.open('about:blank')` + Portal | 破坏 Streamdown/xterm/焦点、重挂断流式控制 | **原生多 `BrowserWindow`**（同入口参数化加载 + 状态桥）或 `WebContentsView` |
| **文件系统监听** | `fs.watch({ recursive: true })` + 手写 `RepoWatcher` | `inotify` 耗尽、漏松散 refs/tags、误滤 `src/cache/` | **`@parcel/watcher`**（原生过滤与批量回调）或 **Chokidar v4** |
| **代码符号与仓库地图** | 正则提取 + 1,180 行手写画布 | 注释/字符串误命中、伪 60fps、劫持 Space | **`web-tree-sitter`**（WASM AST，对标 Aider）+ **`@xyflow/react` + `elkjs`（Worker）** |
| **Diff 引擎与查看器** | 16MB 同步手写 LCS DP | 主线程冻结、大文件退化、无高亮 | 直接复用包内 **Monaco `createDiffEditor`**；轻量场景用 **`diff` / `fast-diff`** |
| **Office / ZIP / XML** | 1,400 行手写 `zip`/`xml`/`ooxml` | 6 处可复现数据丢失与规格 Bug | **`fflate` / `yauzl` + `saxes`（或禁实体的 `fast-xml-parser`）** |
| **弹窗 / 浮层 / 命令面板** | 手写 `Modal` / `PopoverMenu` / `CommandPalette` | 7 处焦点/Escape/`inert`/双实例碰撞 | **Base UI / Radix UI** + **Floating UI** + **`cmdk`** |
| **状态与样式引擎** | Zustand v4.5 + React 19、Tailwind v3 | CJS shim、Store 泄漏、JS/CSS Token 分离 | **Zustand v5**（原生 React 19 + `useShallow`）+ Context 作用域 Store；**Tailwind v4**（`@theme`） |
| **多语言 i18n** | 97KB 单文件字典 + 4 套零散实现 | `{{...}}` 错配无报错、无复数、Cloud Web 无英文 | **`@inlang/paraglide-js`** 或强类型 **`i18next`** + 统一结构化错误码 |
| **云端 HTTP / 存储 / 备份** | 裸 `node:http` + 内存数组 JSON-SQLite + 裸 `tar` | 死索引、假 CAS、热备损坏 DB | **Hono（`@hono/zod-openapi`）** + 真实关系化 SQLite + **`sqlite3 .backup` / Litestream** |
| **系统代理与 WS 隧道** | 手写 HTTP CONNECT + `tls.connect` | 无超时、不支持 SOCKS/HTTPS 代理 | **`proxy-agent` / `https-proxy-agent` + `socks-proxy-agent`** |
| **Agent 扩展生态** | 仅主进程 CJS 插件，封闭 Agent 工具 | 安全高危且与生态脱节 | 引入受控 **MCP（Model Context Protocol）Client** |
| **质量与发布工程** | 0 E2E、单平台 PR 单测、无签名、无锁云端包 | 崩溃/跨平台问题与 Keychain 失效逃逸至发版 | **Playwright `_electron` 冒烟 E2E** + Windows PR 测试 + **Cosign/代码签名** + 锁文件打包 |

---

## 八、分阶段整改优先级清单

### P0 — 立即止血（安全漏洞、数据防丢与必现生产 Bug）

- [ ] **S-08**：`apps/cloud/src/http/routes.ts` 落实施行 `UserPrincipal` 范围约束，禁止 `device-client` 跨设备授权及篡改云端配置/提示词文档。
- [ ] **S-09 / S-10**：`electron/cloud/task-guard.ts` 补齐 `read`/`ls`/`grep`/`find` worktree 路径守卫、复用 fail-closed `canonicalizePath`、hook 失败拒绝派活；`task-report.ts` 修复 JSON 密钥正则、补充 `pk_`/PGP/URL 凭据规则，并对 `summary` 与 `milestone.text` 全链路脱敏。
- [ ] **S-01 / S-02 / S-03 / S-04 / S-05**：修插件哈希 3 处绕过（缺失 fail-closed、禁软链、全量哈希）；修 `pw-file://` 离线预览拦截 opaque `"null"` 及 SVG CSP、按域名缓存授权、`app-protocol.ts` 加 HTTP CSP 与 `setPermissionRequestHandler`；`fs:openExternally` 改安全扩展名白名单；`worktree-coordinator.ts` 改自动装依赖默认 `false` + `--ignore-scripts` 并校验 `pi/` 分支前缀；统一全仓敏感环境变量剥离清单。
- [ ] **S-06 / S-07**：`credentials-store.ts` / `models-store.ts` 写路径 JSON 解析失败立即抛错不再清库，统一收敛到单份 `atomic-json.ts` 并加跨进程锁；`FileExplorer` 新建文件改走 `flag: 'wx'` 原子接口。
- [ ] **S-12 / S-13 / S-14 / S-15**：`backup.sh` 改用 `sqlite3 .backup` + `umask 077`，`pi-cloud.service` 加 `UMask=0077`；`build-cloud-bundle.mjs` 按锁文件安装传递依赖，修复 `update.sh` 鉴权引号与原子切换；`device-agent.ts` 接 Zod 校验并关闭重配对旧连接；`link-store.ts` 禁远端 `http://`；修复 IPv6 限流、`/v1/setup` 引导口令与 Cookie CSRF。
- [ ] **B-01 / B-03 / B-08 / B-09 / B-13 / B-18 / B-19 / B-20 / B-21**：修 6 处 `{{...}}` i18n 占位符；接管 Streamdown 复制走 `copyText()` IPC；修复 `PI_OFFLINE` 被 `allowNetwork: true` 覆盖；修 `session-view.ts` 的 `custom_message` / `nestedCalls` / 活跃工具误判报错与 `getBranch()` 标题；修 `CloudSession.flushEvents()` `beginTurn()` 时序与失败重入队；修 `RepoWatcher` 子目录路径前缀；`TerminalManager` 改异步杀进程树并修复 POSIX `-pid`；`AutoUpdater` 确认退出后再拉起安装器；`ApprovalBroker` 主窗缺失立即拒绝。

### P1 — 架构瘦身、渲染性能与跨端一致性

- [ ] **拆解上帝对象与消除状态耦合（B-02 / A-04 / F-02）**：把流式发送/停止/排队抽离为独立 `ChatTurnController`（同步解决拆窗停不掉）；把 `AgentManager` 拆成 `SessionController` + `SessionRepository` + 轻宿主；将 `pi-bridge` 协议与预设拆出浏览器安全子路径并用 `z.infer` 统一类型、构建接入 Project References / Vitest alias。
- [ ] **彻底统一桌面与云端 UI + 替换手写浮层（A-06 / F-01 / F-03 / F-05）**：抽出共享 `@pi-workbench/ui`（基于 Base UI/Radix + Floating UI + `cmdk`），删除复制的 18 个原语及 ~1,500 行云端重复业务组件；从 Cloud Web 移除 10.3 MB CJK 字体并启用压缩、修复 iOS 安全区/16px 输入/错误色 `text-danger`/删除确认；修 `index.css` 滚动条、`color-scheme: dark` 与 `prefers-reduced-motion` Spinner。
- [ ] **止血渲染性能与产物体积（A-03 / B-04 / F-02 / F-03 / F-04）**：给 `WorkspaceView` 加 `React.memo` 并将 Toast/Session 订阅下沉至叶子组件；后台工作区改 `display: none` 或 Model/View 分离；Monaco 补齐 11 种语言映射并用 `createDiffEditor` 替代手写 16MB LCS；懒加载 `TerminalPanel` / KaTeX、去重 KaTeX chunk、清理无用 `quickjs-eval.wasm`；修 `RepoMapCanvas` 伪 60fps 与全局 `Space` 劫持；修复 `B-10`/`B-14`/`B-15`/`B-16`/`B-17`/`B-22`/`B-23` 并发与云端存储缺陷。
- [ ] **重塑云端存储与状态机（A-07 / B-14 / B-15 / B-17）**：`CloudStore` 弃用全表内存数组与死索引，启用缓存 Prepared Statement、真实 CAS 事务与 `PRAGMA user_version` 迁移并合入记忆/梦境表；修正心跳超时与 30–60s 重连宽限、补齐 WS 背压限流、延后工作树自动回收窗口。

### P2 — 长期演进、社区替换与规则门禁升级

- [ ] **隔离与生态演进（A-01 / A-02 / A-08 / A-09）**：桌面 Agent 与插件迁至 `utilityProcess` + `MessagePort`；远端工单引入真实 OS 沙箱/容器；拆窗评估迁至原生多 `BrowserWindow`；工作台运行态文件从 `.pi-workbench/` 迁至 `{appDir}/data/workspaces/<hash>/`；按需引入受控 MCP Client。
- [ ] **成熟依赖替代高危自研（A-05 / B-22 / F-04）**：以单源 Typed IPC 替代 5 文件手工胶水；以 `@parcel/watcher` 替代 `fs.watch`、`fflate` + `saxes` 替代手写 ZIP/XML、`web-tree-sitter` 替代正则符号、`proxy-agent` 替代手写 CONNECT；升级 Zustand v5、Tailwind v4 与编译期强类型 i18n。
- [ ] **规则修订与质量门禁加固（R-01 / R-02 / R-03 / F-06）**：修订 `AGENTS.md`（分离 Roaming 数据与 Local 缓存、允许持久化面板宽度、错误 Toast 不自动消失）与 `DESIGN_SYSTEM.md`（抬升功能字号 ≥ 12px、优化正文无衬线字体、消除规范自相矛盾）；补齐 Playwright `_electron` E2E、Windows PR 单测、三平台代码签名、移除绕过安全门禁的 mock、`tsconfig.node.json` 补齐 `vite.config.cloud-web.ts`、`eslint --max-warnings 0` 并用 AST/Tailwind 规则覆盖 `packages/cloud-ui`。
