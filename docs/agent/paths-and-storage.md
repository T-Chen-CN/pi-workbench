# 路径与持久化

> **面向**：要改数据目录、落盘格式、工作区状态恢复的人
> **什么时候读**：新增数据文件 / 目录、动 `app-paths.ts` 或启动顺序之前
> **什么时候要改**：目录布局、持久化字段、启动期顺序约束变化时

> 严格两目录架构与可选便携版的完整约束：唯一数据目录怎么算、启动顺序为什么不能动、哪些状态落盘、哪些只在内存。
> 打包相关的安装版 / 便携版布局见 [BUILD_AND_PACKAGE §6](../guides/BUILD_AND_PACKAGE.md)。

## 1. 应用目录（严格两目录 + 可选便携模式）

唯一实现是 `electron/app-paths.ts` 的 `resolveAppPaths()`（对外暴露 `getAppDir()` / `getInstallDir()` / `isPortableMode()`），按顺序判断：

| 场景 | 数据目录 `getAppDir()` | 说明 |
| --- | --- | --- |
| 开发模式（`!app.isPackaged`） | `app.getAppPath()`（仓库根） | 不依赖 `process.cwd()` |
| 打包版传入 `--data-dir=<path>` | 指定目录（便携模式） | 便于测试或自定义隔离 |
| 打包版（非 macOS）程序同级存在 `portable` 标记文件 | 可执行文件 / `.AppImage` 同级目录（便携模式） | Windows 便携 `.zip` 默认携带该空文件 |
| **打包版默认（标准两目录模式）** | `path.join(app.getPath('appData'), 'pi-workbench')` | Windows `%APPDATA%\pi-workbench` · macOS `~/Library/Application Support/pi-workbench` · Linux `~/.config/pi-workbench` |

**禁止**：在别处重新实现目录解析；把运行期数据散落到 `~/.pi`、`%LOCALAPPDATA%` 或 `node_modules`、`dist*`、`release`（全机严格保持「程序目录 + 唯一数据目录」两处，便携版为单目录）。

启动时 `main.ts` 的 `initAppDirectories()` 在 `getAppDir()` 内创建并维护四个子目录：

```
{dataDir}/config/   settings.json、providers.json、credentials.json、web-search.json、device-id、last-run-version.json、migrations.json
{dataDir}/cache/    drafts/（崩溃恢复草稿）、temp/（含 Web dev 模式的 web-agent/，可随时删）、pi-workbench-updater/（差分更新缓存）
{dataDir}/data/     agent/（模型与会话）、profile/（Chromium userData）、workspaces.db、cloud/
{dataDir}/logs/     main.log、renderer.log、agent.log
```

## 2. 启动期顺序约束（改了会静默出错）

1. **旧版（≤0.11.2）升级迁移必须最早同步执行**：`migrateLegacyInstallDirSync()` 必须在建立 `FileLogger`、`app.setPath('userData')` 与打开 `workspaces.db` 之前运行，把旧安装目录内的 `config/ data/ logs/ cache/drafts/` 合并复制到标准数据目录（不覆盖目标已有文件），完成后写 `config/.migrated-from-install-dir` 并尽力归档旧目录到 `.legacy-data-backup/`。
2. `app.setPath('userData', '{dataDir}/data/profile')` **必须早于** `app.requestSingleInstanceLock()`。
   否则单实例锁会直接在 `<appData>/pi-workbench` 根目录建 Chromium 锁文件，与 `data/profile/` 分叉。
3. `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` **必须在任何 Pi SDK 模块加载之前**赋值。
   赋值发生在 `electron/app-paths.ts` 的模块顶层，而 `main.ts` 的第一条 import 就是它 —— 这条依赖顺序不能拆。
   默认值是 `~/.pi/agent`，一旦漏设，崩溃日志、扩展加载器、认证存储都会落到用户主目录。
4. `electron/legacy-paths.ts` 只在打包版执行启动回收：`~/.pi` 合并进 `{dataDir}/data/agent` 后删除（检测到独立 Pi CLI 时保留）；清理旧版留在 `%LOCALAPPDATA%\Pi-Workbench-Update` 与 `%LOCALAPPDATA%\pi-workbench-updater` 的多余目录；**绝不删除 `<appData>/pi-workbench`**。
5. 文件日志（`FileLogger`）**必须早于** `requestSingleInstanceLock()` 建立：锁被拒绝时要在 `logs/main.log` 留下
   `[Boot] Another instance holds the single instance lock`，否则「已有实例没退干净」在用户侧只表现为「双击没反应」，
   且事后没有任何现场证据。
6. 数据目录不可写时由 `ensureAppDirWritable()` 给出清晰提示；设置页「关于」提供 `app:openDataDir` 一键打开数据目录。

## 2.1 退出顺序（改了会留下僵尸进程）

唯一真退出入口是 `app.on('will-quit')`。顺序与超时由 `electron/shutdown.ts` 强制：

| 阶段 | 行为 | 上界 |
| --- | --- | --- |
| `before-quit` | 置 `quitting`（关闭按钮不再收托盘）+ 武装「退出卡住」看门狗（进入 `will-prevent-unload` 未保存弹窗时自动暂停，确认后恢复） | 10 s 后 `app.exit(0)` |
| `will-quit` | `preventDefault()` → `runShutdownSteps()` 顺序清理 | 7.5 s 看门狗，超时直接 `app.exit(0)` |
| 清理完成后 | **`app.exit(0)`**，不再二次 `app.quit()` | — |

清理顺序（依赖反序，每步独立超时，超时只记警告并继续）：
`approval-broker → cloud-device → agents → worktree-deps → workspace-tasks(watchers/repoSync/plugins) → terminals → child-processes → workers → workspace-store → logger-flush → tray`。

- 托盘**最后**销毁：清理变慢时用户还能从托盘重新触发退出，而不是只能开任务管理器。
- 子进程（PTY shell、`npm install`）登记在 `electron/child-registry.ts`，退出时先杀整棵进程树（Windows `taskkill /T /F` / Unix `-pid` 进程组）再补杀根进程，避免先杀父导致孤儿孙进程逃逸；故意脱离的（`shell-refresh` 的 `detached` 子进程）不登记。
- `workspace-store.ts` 开启 SQLite `PRAGMA journal_mode = WAL` 与 `busy_timeout`；`logger.ts`（缓冲批写 + 退出 `flush`）与 `draft-store.ts`（`listAsync` / `removeAsync` / `clearAsync`）均为异步 I/O，不阻塞 Electron GUI 主线程；重 CPU 的文档解析与仓库地图扫描走 `worker_threads`（`electron/worker-runner.ts`）。
- 不要再写成 `will-quit` 里 `preventDefault()` 后 `app.quit()`：那依赖上游事件状态机的二次 quit 行为
  （electron#33643），一旦没生效就是无窗口、无托盘、仍握着单实例锁的僵尸进程。
- 新增清理步骤 → 必须给 `timeoutMs`，并在 `tests/electron/shutdown.test.ts` 覆盖超时路径。

## 3. 持久化文件清单

| 文件 | 写者 | 内容 / 恢复语义 |
| --- | --- | --- |
| `config/settings.json` | `app:saveSettings` | 语言、主题、自动保存、`closeToTray`、`useSystemProxy`、`permissionLevel`、通知开关、快捷键 |
| `config/providers.json` | `providers:*` | active provider、每家的选中模型与按模型的下调容量；无密钥 |
| `config/credentials.json` | `providers:*` / 登录流程 | 每 provider 一份凭证（`api_key` 或 `oauth`），值为 `enc:` + safeStorage；**唯一密钥落盘点** |
| `config/device-id` | `electron/device-id.ts` | OAuth 上报的稳定 UUID（OpenAI 会校验格式） |
| `config/api-config.legacy.json` | 启动迁移 | 旧配置归档（迁移成功后改名，不再读取） |
| `config/web-search.json` | `webSearch:*` | 当前 provider + 各 provider 的 Key（`enc:`） |
| `config/last-run-version.json` | `shell-refresh.ts` | 仅在版本变化时刷新 shell / 图标缓存 |
| `config/migrations.json` | `electron/legacy-cleanup.ts` | 已执行的一次性迁移：`{applied: { [id]: 时间戳 }}`。**删了等于让迁移重跑**，而迁移是幂等的，所以代价只是白做一次 |
| `data/workspaces.db` | `workspace-store.ts` | `node:sqlite`，表 `workspaces(path, opened_at, open_count)`；**最近工作区的唯一来源**，渲染层不再保存 `recentWorkspaces` |
| `data/agent/models.json` | `model-config.ts` | 由应用整体覆盖生成：只含 8 家白名单 provider 的 `modelOverrides`，不含 baseUrl / api / apiKey |
| `data/agent/models-store.json` | `models-store.ts` | 远端目录缓存（SDK 格式），`source` 与列表过滤共用一个判据 |
| `data/agent/web-search.json` | `ipc/web-search.ts` | 下发给扩展的 `$PI_WORKBENCH_WEB_SEARCH_KEY_<PROVIDER>` 变量名 |
| `data/agent/sessions/*.jsonl` | Pi SDK | 会话记录（按 cwd 过滤），历史与导出的唯一真相源 |
| `data/agent/session-extras/<id>.json` | `AgentManager` | 会话 sidecar：`title`（标题备份）、`plan`（结构化计划，不进模型上下文、压缩后保留）、`permission`（会话权限，`null` 表示首次打开时从全局默认档生成）、`branchLeaves`（分支切换恢复）、`thinkingDurations` |
| `data/profile/` | Chromium | userData（localStorage、GPU / 代码缓存）。可安全清空的只有 `Cache/`、`Code Cache/` |
| `logs/{main,renderer,agent}.log` | `logger.ts` / SDK | 5 MB 轮转，保留 `.1` |
| `cache/drafts/<sha1>.json` | `draft-store.ts` | 崩溃恢复草稿；单条 ≤ 2,000,000 **字符**（`MAX_DRAFT_CHARS`，中文约 4–6 MB）、每工作区 ≤ 100 条；正常保存后删除 |

工作区级（`{workspaceDir}/.pi-workbench/`）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `version` / `enabledPlugins` / `pluginsConfigured` |
| `chat-tabs.json` | `{ open: string[], active: string \| null }`：打开的会话与激活项 |
| `editor-tabs.json` | `{ version: 1, open, active, root }`：打开的文件（只存相对路径，上限 50）、当前文件 |
| `sessions-meta.json` | `pinned` / `archived` 会话 id 列表 |
| `session-git.json` | `{ version: 1, worktrees, sessions }`：会话 ↔ 工作树绑定（见 [git-and-worktrees](git-and-worktrees.md)） |
| `plugins/` | 工作区插件（见 [agent-runtime](agent-runtime.md) 之外的插件约束） |
| `worktrees/` | 托管工作树 checkout 目录 |
| `terminal-{id}.log` | 每个终端的输出尾巴（Agent 可附加为上下文；超限截断） |

**所有 JSON 落盘都走 `electron/atomic-json.ts`**：临时文件 → fsync → rename；覆盖前把旧文件复制为 `.bak`，读取时主文件损坏则回退备份。自己 `writeFile` 覆盖这些文件会破坏崩溃恢复。

例外：`cache/drafts/` 用同一模块的**异步**写（`writeJsonAtomicAsync`）且不留 `.bak`。主进程的 Node 事件循环就是浏览器 UI 线程，同步 `fsync` + 回读解析上一份全文（草稿里就是整篇文档）会把窗口事件与输入法合成一起卡住；草稿是可再生的缓存，临时文件 + rename 已经足够。

## 4. 多工作区与运行期状态

- 每个打开的工作区各挂一套常驻视图（`WorkspaceView`）和按工作区隔离的 editor / diff store；切换标签或返回首页只切 `visibility: hidden` + `inert`，**不卸载、不 reset**。
- 运行期状态全部保留：Monaco 撤销栈与滚动、聊天草稿 / 附件 / 滚动、终端进程与缓冲区、文件树展开、面板宽度与收起状态、流式输出。
- **关闭工作区标签是唯一回收运行时的入口**：确认未保存文件与运行中任务 → 写 `editor-tabs.json` → dispose Agent、终端与文件监听 → 卸载视图 → 释放按工作区的 store（`editor` / `diff` / 仓库地图扫描缓存 `repoMapStore.reset`）。`chat-tabs.json`、`editor-tabs.json` 与草稿都**不删除**。
- 退出应用 / 重启：运行时全部回收，**不自动恢复工作区标签**；固定状态仍在磁盘，下次从最近项目打开时恢复。

| 状态 | 是否落盘 |
| --- | --- |
| 打开的文件与顺序、当前文件 | ✅ `editor-tabs.json` |
| 打开的会话与激活项、置顶 / 归档 | ✅ `chat-tabs.json`、`sessions-meta.json` |
| 未保存的编辑器内容 | ✅ `cache/drafts/` |
| 会话 ↔ 工作树绑定 | ✅ `session-git.json` |
| 会话权限模式与授权、结构化计划、分支选中叶子 | ✅ `data/agent/session-extras/` |
| 面板宽度、终端开关、面板宿主、窗口句柄 | ❌ 运行期 |

## 5. 禁止清单

- ❌ 在 `~/.pi`、`%LOCALAPPDATA%`、`~/Documents` 散落额外应用目录（所有运行期文件包括更新缓存均收口在 `getAppDir()` 唯一数据目录内）。
- ❌ 用 `.env` 文件（位置不明确）。
- ❌ 让渲染进程通过 `workspace:init` 自行注册任意目录：工作区根目录只能由主进程批准（原生选择器的结果，或从 `workspaces.db` 载入的最近工作区）。
