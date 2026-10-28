# 路径与持久化

> **面向**：要改数据目录、落盘格式、工作区状态恢复的人
> **什么时候读**：新增数据文件 / 目录、动 `app-paths.ts` 或启动顺序之前
> **什么时候要改**：目录布局、持久化字段、启动期顺序约束变化时

> 便携式架构的完整约束：应用目录怎么算、启动顺序为什么不能动、哪些状态落盘、哪些只在内存。
> 打包相关的目录布局见 [BUILD_AND_PACKAGE §6](../guides/BUILD_AND_PACKAGE.md)。

## 1. 应用目录

唯一实现是 `electron/app-paths.ts` 的 `getAppDir()`，按顺序判断：

| 场景 | 结果 |
| --- | --- |
| `process.env.APPIMAGE` 存在 | `.AppImage` 文件所在目录（AppImage 挂载点只读） |
| 开发模式（`!app.isPackaged`） | `app.getAppPath()`，即仓库根（**不是** `process.cwd()`） |
| macOS 打包版 | `~/Library/Application Support/pi-workbench` |
| Windows / Linux 打包版 | `path.dirname(app.getPath('exe'))` |

macOS 例外是经项目所有者确认的：`.app` 包内不可写、且自动更新会整体替换。

**禁止**：在别处重新实现目录解析；用 `app.getPath('userData' | 'home' | 'documents' | 'appData')` 当数据目录（macOS 例外除外）；把运行时数据写进 `node_modules`、`dist*`、`release`。

启动时 `main.ts` 的 `initAppDirectories()` 创建并维护四个目录：

```
{appDir}/config/   settings.json、api-config.json、web-search.json、last-run-version.json
{appDir}/cache/    drafts/（崩溃恢复草稿）、temp/（含 Web dev 模式的 web-agent/，可随时删）、{updaterCacheDirName}/（Linux 更新包）
{appDir}/data/     agent/（模型与会话）、profile/（Chromium userData）、workspaces.db
{appDir}/logs/     main.log、renderer.log、agent.log
```

## 2. 启动期顺序约束（改了会静默出错）

1. `app.setPath('userData', '{appDir}/data/profile')` **必须早于** `app.requestSingleInstanceLock()`。
   否则单实例锁先在默认 userData（`%APPDATA%\pi-workbench`）建目录与锁文件，违反便携式约束。
2. `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` **必须在任何 Pi SDK 模块加载之前**赋值。
   赋值发生在 `electron/app-paths.ts` 的模块顶层，而 `main.ts` 的第一条 import 就是它 —— 这条依赖顺序不能拆。
   默认值是 `~/.pi/agent`，一旦漏设，崩溃日志、扩展加载器、认证存储都会落到用户主目录。
3. `electron/legacy-paths.ts` 只在打包版执行启动回收：`~/.pi` 合并进 `{appDir}/data/agent` 后删除（检测到独立 Pi CLI 时保留）；删除旧默认 userData 与安装器在 `%LOCALAPPDATA%` 的差分副本。
4. 安装目录必须可写：安装器在目录页拒绝 `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%SystemRoot%` 及其子目录，且 `allowElevation: false`。
5. 新增任何运行时数据目录 → 必须加进 `scripts/lib/installer-manifest.js` 的 `PROTECTED_TOP_LEVEL`，否则更新时会被当程序文件删除（NSIS 侧读生成的清单，不要改卸载分支）。

## 3. 持久化文件清单

| 文件 | 写者 | 内容 / 恢复语义 |
| --- | --- | --- |
| `config/settings.json` | `app:saveSettings` | 语言、主题、自动保存、`closeToTray`、`permissionLevel`、通知开关、快捷键 |
| `config/api-config.json` | `apiConfig:*` | provider / apiUrl / apiKey（`enc:` + safeStorage）/ 模型与容量 |
| `config/web-search.json` | `webSearch:*` | 当前 provider + 各 provider 的 Key（`enc:`） |
| `config/last-run-version.json` | `shell-refresh.ts` | 仅在版本变化时刷新 shell / 图标缓存 |
| `data/workspaces.db` | `workspace-store.ts` | `node:sqlite`，表 `workspaces(path, opened_at, open_count)`；**最近工作区的唯一来源**，渲染层不再保存 `recentWorkspaces` |
| `data/agent/models.json` | `model-config.ts` | Pi 模型配置；Key 只写变量名 `$PI_WORKBENCH_API_KEY`，不落盘 |
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

## 4. 多工作区与运行期状态

- 每个打开的工作区各挂一套常驻视图（`WorkspaceView`）和按工作区隔离的 editor / diff store；切换标签或返回首页只切 `visibility: hidden` + `inert`，**不卸载、不 reset**。
- 运行期状态全部保留：Monaco 撤销栈与滚动、聊天草稿 / 附件 / 滚动、终端进程与缓冲区、文件树展开、面板宽度与收起状态、流式输出。
- **关闭工作区标签是唯一回收运行时的入口**：确认未保存文件与运行中任务 → 写 `editor-tabs.json` → dispose Agent、终端与文件监听 → 卸载视图。`chat-tabs.json`、`editor-tabs.json` 与草稿都**不删除**。
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

- ❌ 在 `~/.pi`、`%APPDATA%`、`%LOCALAPPDATA%`、`~/Documents` 保存应用数据（唯一例外：Windows 更新包缓存在 `%LOCALAPPDATA%\Pi-Workbench-Update`，理由见 [BUILD_AND_PACKAGE §4.1](../guides/BUILD_AND_PACKAGE.md)）。
- ❌ 用 `.env` 文件（位置不明确，违反便携式约束）。
- ❌ 让渲染进程通过 `workspace:init` 自行注册任意目录：工作区根目录只能由主进程批准（原生选择器的结果，或从 `workspaces.db` 载入的最近工作区）。
