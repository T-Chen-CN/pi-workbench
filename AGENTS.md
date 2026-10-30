# Pi Workbench —— Agent 开发指南

> 给 AI 编码代理的项目说明。规范原文在 `docs/`，从这里按指针进入。

**一句话**：轻量级 AI 辅助开发工作台 —— Electron 桌面应用，内嵌 Pi Agent 作为编码助手。
**栈**：Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57。**Node ≥ 24**（`node:sqlite`、构建脚本依赖）。
**阶段**：Phase 6 持续优化（见 [STATUS](docs/progress/STATUS.md)）。

---

## 1. 命令

```bash
npm run dev        # Vite + Electron（predev 会自动构建 pi-bridge 与主进程/preload）
npm test           # Vitest 全量
npx vitest run tests/<file>.test.ts   # 单个文件（加 -t "<名称>" 只跑一条）
npm run lint       # ESLint
npm run type-check # tsc --noEmit + tsconfig.node.json
npm run build      # 渲染层 + bridge + 主进程
```

- 只能用 **npm**（`package-lock.json` 是唯一锁文件）。
- 改 `tailwind.config.js`（新增颜色 / 工具类）后**必须重启 `npm run dev`**：Tailwind 只在服务器启动时读配置，CSS HMR 不会生成新类。
- **不要**提交 `dist/` `dist-electron/` `pi-bridge/dist/` `release/`：均已 gitignore，由命令重建。

## 2. 仓库地图

| 位置 | 规则 |
| --- | --- |
| `electron/` | 主进程。**IPC 一律写在 `electron/ipc/<域>.ts`，用 `handleIpc()` 注册**；不要在 `main.ts` 里直接 `ipcMain.handle`（会跳过来源校验） |
| `electron/ipc/register.ts` | `handleIpc` + `isTrustedIpcSender`：只接受主窗口与登记过的辅助窗口主框架，ready 之后 fail-closed |
| `src/` | 渲染进程分层：`components/`（扁平，**禁建子目录**）· `store/`（一域一个 Zustand store）· `hooks/` · `utils/` · `workspace/` · `panelHost/` · `theme/` · `pdf/` · `api/`（IPC 封装 + 浏览器 mock 回退） |
| `pi-bridge/` | 独立的 Agent 桥接包（`AgentManager`），有自己的 `package.json` / `tsconfig`；改完要 `npm run build:bridge` |
| `tests/` | 扁平目录，文件名与源码同名（`src/utils/fileTree.ts` → `tests/file-tree.test.ts`）；`tests/design-system.test.ts` 是强制门槛 |
| `docs/` | 规范原文，`docs/README.md` 是唯一索引 |

文件级完整目录见 [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md)。

## 3. 边界：Never / Ask first / Always

**Never**
- 渲染进程直接碰 Node / fs（`nodeIntegration` 关闭，只能走 `window.electronAPI`）。
- 把 `app.getPath('userData' | 'home' | 'documents' | 'appData')` 当数据目录（macOS 打包版是唯一例外）。
- API Key 明文进仓库、配置、日志或工作区（只允许 `enc:` + safeStorage）。
- 引入 Tauri / Redux / CSS Modules / Webpack；用 emoji 当图标；写 `gray-*` `blue-*` `red-*` 调色板类或 `dark:` 变体。
- 在组件里硬编码颜色、任意字号、`uppercase`、`tracking-[…]`、`leading-[…]`。

**Ask first**
- 改 [DESIGN_SYSTEM](docs/design/DESIGN_SYSTEM.md)（设计唯一事实源，新增例外必须先确认）。
- 新增 / 升级依赖、改 `package.json` 的 `build` 段、改 `.github/workflows`。
- 新增运行时数据目录（必须同步 `PROTECTED_TOP_LEVEL`，否则更新会把目录当程序文件删掉）。
- 改会话记录格式、`session-git.json` 格式、IPC 频道名（都有落盘或跨进程兼容约束）。

**Always**
- 新增 IPC 四步：`electron/ipc/<域>.ts` 用 `handleIpc` → `electron/preload.cts` 暴露 → `src/types/electron.d.ts` 补类型 → `src/api/index.ts` 封装（同时补 Web mock）。
- 文件写 / 删 / 改只允许发生在受信任工作区与 `{appDir}/cache/`；校验用 `realpath` + `path.relative`（`electron/workspace-trust.ts`）。
- 落盘 JSON 走 `electron/atomic-json.ts` 的原子写（临时文件 + fsync + rename，旧文件留 `.bak`）；**不要自己 `writeFile` 覆盖**这些状态文件。
- 状态更新不可变；按工作区隔离的状态用 `xxxStoreFor(workspacePath)` 工厂，不要放全局单例。

## 4. 架构铁律（动手前读对应文档）

| 铁律 | 细节 |
| --- | --- |
| Pi Agent 只在主进程运行；禁止子进程 / Worker / HTTP 服务承载 Agent | [agent-runtime](docs/agent/agent-runtime.md) |
| 权限是安全边界：`readonly` 用 `deny` 而不是 `ask`；审批超时与通道缺失一律拒绝（fail-closed）；会话是权限的唯一权威 | [agent-runtime](docs/agent/agent-runtime.md) |
| 历史与导出的唯一真相源是会话记录（JSONL + `parentId` 分支），不是压缩后的 `session.messages` | [ADR-003](docs/decisions/ADR-003-session-record-single-source.md) |
| 便携式目录 `{appDir}/{config,cache,data,logs}`；`setPath('userData')` 必须早于单实例锁；Pi SDK 目录靠环境变量固定 | [paths-and-storage](docs/agent/paths-and-storage.md) |
| 退出只在 `will-quit` 收尾：每步超时 + 看门狗 `app.exit(0)`，不再二次 `app.quit()`；托盘最后销毁；子进程登记 `child-registry` 统一收树 | [paths-and-storage](docs/agent/paths-and-storage.md) |
| 多工作区是常驻视图：切换只 `visibility: hidden` + `inert`，不卸载不 reset；关闭标签是唯一回收入口 | [paths-and-storage](docs/agent/paths-and-storage.md) |
| 更新只替换程序文件：`config/ data/ logs/ cache/` 受保护，删除靠 `installer-manifest` 清单 | [BUILD_AND_PACKAGE §4.1](docs/guides/BUILD_AND_PACKAGE.md) |
| 面板可拆成独立窗口（`window.open('about:blank')` + React portal）；主窗口 `X` 默认收托盘，不是退出 | [panels-and-windows](docs/agent/panels-and-windows.md) |
| Git 工作树会话：切换在**轮次边界**生效，绑定关系写 `.pi-workbench/session-git.json` | [git-and-worktrees](docs/agent/git-and-worktrees.md) |

## 5. 交互约定

- 文件树单击即打开（无双击确认）；自动保存 2 秒防抖；Toast 3 秒自动消失。
- 聊天贴底：距底 < 64px 才跟随流式输出；主动发送 / 重试 / 编辑重发 / 插话一律恢复跟随并贴到真实底部（`src/hooks/chatScroll.ts`）。
- 面板宽度、终端开关、窗口句柄、面板宿主属于运行期状态，**不落盘**；会话的权限模式与授权、结构化计划、分支选中叶子会随会话落盘（`data/agent/session-extras/`）。

## 6. 验证矩阵（收尾前按改动区域执行）

| 改动范围 | 必须跑 |
| --- | --- |
| `src/` 任意 | 对应单文件 vitest → 收尾 `npm test` + `npm run lint` |
| `electron/` | `npm run type-check` + 相关 `tests/{main-ipc,*-manager,updater,...}.test.ts` |
| `pi-bridge/` | `npm run build:bridge` + `tests/{session-*,agent-*}.test.ts` |
| UI / 样式 | `tests/design-system.test.ts` + Paper / Ink 两套截图 + 1024 / 1440 宽度 |
| 打包 / 更新 / NSIS | `npx electron-builder --win --dir --publish never` |

渲染层测试用 `// @vitest-environment jsdom`；Monaco / xterm 用 `vi.mock` 替身。改交互后补或改用例 —— 测试是这类改动的唯一回归网。

## 7. 决策表

| 场景 | 选择 |
| --- | --- |
| 状态要不要落盘 | 跨重启要恢复 → 落盘；面板宽度 / 终端开关 / 窗口句柄 → 不落盘；会话级偏好（权限、计划、分支叶子）→ 写会话 extras |
| 状态放 store 还是组件 | 跨组件或跨工作区共享 → store；单组件生命周期 → `useState` |
| 逻辑放 `electron/` 还是 `src/` | 需要 fs / 子进程 / safeStorage / PTY → 主进程 + IPC；纯展示与交互 → 渲染层 |
| 新会话还是新工作树 | 换任务但同一工作目录 → 新会话；要隔离文件改动或并行分支 → 工作树会话 |
| 写规则还是写检查 | 能被 lint / tsc / 测试强制的 → 写检查；否则写 `docs/` 并在此登记 |
| 文档放哪 | 项目规范 → `docs/` + 登记进 `docs/README.md`；临时分析 → 见 [reporting](docs/agent/reporting.md) |

## 8. 提交

```
<type>(<scope>): <subject>

<body>
```

- type：`feat` `fix` `docs` `refactor` `style` `test` `chore`；scope：`agent` `editor` `file` `ui` `ipc` `git` `panel` `docs`。
- 改构建命令 / 目录结构 / IPC 约定的提交，**必须同 PR 更新对应文档**（含本文件）。

## 9. 参考文档

| 文档 | 什么时候读 |
| --- | --- |
| [PROJECT_PLAN](docs/PROJECT_PLAN.md) | 理解设计取舍：定位、进程模型、模块边界、技术决策记录 |
| [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md) | 找文件、查 IPC 频道表、看进程模型与数据流 |
| [DESIGN_SYSTEM](docs/design/DESIGN_SYSTEM.md) | 任何颜色 / 字体 / 间距 / 组件 / 主题改动（强制） |
| [BUILD_AND_PACKAGE](docs/guides/BUILD_AND_PACKAGE.md) | 打包、自动更新、数据目录、打包故障排查 |
| [paths-and-storage](docs/agent/paths-and-storage.md) | 落盘位置、启动顺序、持久化文件清单、多工作区状态 |
| [ipc-and-trust](docs/agent/ipc-and-trust.md) | 新增 IPC、来源校验、preload 与 API 层、Web 调试桥 |
| [agent-runtime](docs/agent/agent-runtime.md) | 会话、权限审批、计划模式、工具白名单、标题、压缩、导出、联网 |
| [git-and-worktrees](docs/agent/git-and-worktrees.md) | Git 视图、会话工作树、仓库同步、GitHub 关联 |
| [panels-and-windows](docs/agent/panels-and-windows.md) | 面板拆出窗口、辅助窗口、托盘常驻、通知 |
| [AGENT_TRACE](docs/architecture/AGENT_TRACE.md) | 流式事件协议与思考 / 工具轨迹数据模型 |
| [GIT_WORKTREE_SESSIONS](docs/requirements/GIT_WORKTREE_SESSIONS.md) | 工作树会话的完整需求与验收场景 |
| [AGENT-TESTING](docs/guides/AGENT-TESTING.md) | Agent 功能手动验收步骤 |
| [reporting](docs/agent/reporting.md) | 什么时候该写报告、写到哪、怎么清理 |
| [STATUS](docs/progress/STATUS.md) · [BACKLOG](docs/progress/BACKLOG.md) | 当前进度与待办 |

---

**维护**：目标 ≤ 160 行。能从代码、`package.json`、`docs/` 读出来的，写指针不写副本。
