# 构建与打包指南

**适用版本**: 0.7.0（Phase 6 持续）
**最后更新**: 2026-10-27

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19** | Pi SDK 硬性要求（Electron 44 内置 Node 24） |
| npm | 10+ | 使用 npm workspaces（`pi-bridge`） |
| Git for Windows | 可选 | Agent 的 bash 工具需要 Git Bash（支持用户目录安装） |

> 国内网络下载 Electron 二进制可能失败。仓库内的 `.npmrc` 已配置 `electron_mirror`（npmmirror）。
> 若仍失败，可手动安装：
>
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
> ```

---

## 2. 开发运行

```bash
npm install
npm run dev
```

`npm run dev` 会通过 `predev` **自动先构建** `pi-bridge`（`pi-bridge/dist`）与 Electron 主进程（`dist-electron`），再并行启动：

- Vite dev server：`http://localhost:5173`
- Electron：加载该 dev server，并自动打开 DevTools

仅 Web 调试：

```bash
npm run web:dev
```

> Web 模式没有 Electron 主进程：文件系统与 Agent 由 Vite dev 中间件模拟/代理，仅用于界面与 Agent 调试。

---

## 3. 构建

```bash
npm run build
```

依次执行：

| 步骤 | 命令 | 产物 |
|---|---|---|
| 渲染进程 | `npm run build:renderer` | `dist/` |
| 主进程 + preload | `npm run build:main` | `dist-electron/main.js`、`dist-electron/preload.cjs` |
| Agent 桥接层 | `npm run build:bridge` | `pi-bridge/dist/`（已加入 `.gitignore`，构建时生成） |

单独构建某一层：

```bash
npm run build:renderer
npm run build:main
npm run build:bridge
```

**注意**：preload 使用独立 tsconfig 以 **CommonJS** 编译（`preload.cjs`），因为 Electron 的 sandbox preload 不支持 ESM。

---

## 4. 打包

```bash
npm run package          # 当前平台
npm run package:win      # Windows：NSIS 安装包
npm run package:mac      # macOS (DMG)
npm run package:linux    # Linux (AppImage)
```

输出目录：`release/`

Windows 产物：

- `Pi Workbench Setup <version>.exe` — NSIS 安装包（per-user、可选安装路径）

**构建配置只有一处**：`package.json` → `build` 字段（`electron-builder.yml` 已移除，避免两份配置互相覆盖）。

关键配置：

```jsonc
{
  "files": [
    "dist/**/*",
    "dist-electron/**/*",
    "pi-bridge/dist/**/*",     // AgentManager 必须打包
    "pi-bridge/package.json",
    "app-icon.png",
    "app-icon.ico"
  ],
  "win": {
    "target": ["nsis"],
    "icon": "app-icon.ico"      // Windows exe / 安装器需要 .ico
  }
}
```

> Windows 图标：`app-icon.png`（1024×1024）用于界面与 mac/linux；
> `app-icon.ico` 为 256×256 PNG-compressed ICO，供 exe 与 NSIS 安装器使用。
> NSIS 不接受 PNG 作为 installer icon，必须使用 `.ico`。

**依赖分组（体积约束）**：只有主进程运行时真正 `require` 的包放在 `dependencies`——`electron-updater`、`node-pty`、`pi-bridge`、`@earendil-works/pi-coding-agent`、`pi-web-access`。渲染依赖（`react`、`react-dom`、`monaco-editor`、`lucide-react`、`@xterm/*`、`@fontsource*`、markdown / 高亮栈、`zustand` 等）即使被 Vite 打包，也必须放在 `devDependencies`；放进 `dependencies` 会被 electron-builder 原样再打一份进 `app.asar`（实测约 156MB）。

**语言包**：`build.electronLanguages` 只保留 `en-US` 与 `zh-CN`，避免 55 个 Chromium 语言包（约 49MB）随包分发。安装向导语言同样限制为 `en_US` / `zh_CN`（`nsis.installerLanguages`），因此 `build/installer.nsh` 里的自定义 `LangString` 只需覆盖 1033 / 2052。

根依赖中必须保留：

- `pi-bridge`（workspace 包）
- `@earendil-works/pi-coding-agent`（其依赖会一并打包）

### 打包产物验证

```bash
# 仅生成解包目录，便于快速验证
npx electron-builder --dir --win

# 检查 asar 内容（根目录的 pi-bridge 必须存在）
npx asar list release/win-unpacked/resources/app.asar | grep "^.pi-bridge"
npx asar list release/win-unpacked/resources/app.asar | grep pi-coding-agent | head
```

建议在打包后手动冒烟测试一次：启动应用 → 打开工作区 → 配置 API → Fetch 模型 → 对话。

---

## 4.1 发布与自动更新（GitHub Releases）

- 发布前先把 `package.json` 的 `version` 提升到目标版本（当前 `0.7.0`）。
- 推送 `v*` 标签（例如 `git tag v0.7.0 && git push origin v0.7.0`）会触发
  `.github/workflows/release.yml`：
  1. `verify-version` 校验标签与 `package.json` 版本一致，不一致直接失败；
  2. `build` 在 Windows / macOS / Linux 三个 runner 上构建 NSIS、universal dmg、AppImage；
  3. `publish` 汇总产物并上传到同一个 GitHub Release（含 `latest.yml` / `latest-linux.yml` / blockmap）。
- 当前**不签名、不公证**：
  - Windows 用户首次运行安装包可能看到 SmartScreen 提示；
  - macOS 应用未签名，**不能自动安装更新**，应用只检查版本并打开 Release 页面，用户下载 dmg 后拖入 Applications 覆盖安装；
  - Linux AppImage 可正常自动更新（要求 AppImage 文件所在目录可写）。
- 更新行为：启动 12 秒后静默检查，此后每 12 小时复查一次（下载中或已下载待安装时跳过）；Windows / Linux 自动下载、不自动安装；下载完成后弹窗，拒绝则下次启动再提示。
- 更新后的图标 / 桌面菜单缓存：更新只替换文件，系统仍会沿用旧图标，因此有两道刷新：
  - Windows 安装器的 `customInstall` 末尾调用 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 并执行
    `ie4uinit.exe -show`，让 Explorer 重新读取图标、关联和快捷方式；
  - 应用侧 `electron/shell-refresh.ts` 在打包版启动时对比 `{appDir}/config/last-run-version.json`，
    只有版本变化才执行一次平台刷新：macOS `touch` 应用包 + `lsregister -f`，Linux `touch` AppImage +
    `update-desktop-database` + `gtk-update-icon-cache`（目录存在时），Windows 再跑一次 `ie4uinit`；
  - 固定到任务栏 / 开始菜单的条目仍可能沿用 Explorer 会话里的缓存，需要重启资源管理器；Dock 图标
    必要时手动 `killall Dock`。这些属于用户侧操作，安装器与应用都不代劳。
- **Windows 更新时的文件删除由自定义 NSIS 卸载器接管**（`build/installer.nsh` 的 `customRemoveFiles`）：
  - 打包时 `scripts/after-pack-manifest.js`（`afterPack`）把安装器自己的文件写成清单，放在
    `resources/installer-manifest.files.txt` / `installer-manifest.dirs.txt`（相对路径、CRLF）；
  - 更新时只删除清单内的程序文件，`config/`、`data/`、`logs/`、`cache/` 原地保留（`cache/` 里还有
    正在运行的更新安装包）；清单缺失时不删除任何文件；
  - 真正卸载时，卸载欢迎页提供「保留配置与会话数据」勾选框（默认勾选，静默卸载同样保留）：
    勾选时保留 `config/`、`data/`、`logs/`、`cache/`，只删程序文件与安装器生成的文件
    （`Uninstall Pi Workbench.exe`、`uninstallerIcon.ico`、`resources/app-update.yml`、
    `resources/elevate.exe`、`.write-probe`）；取消勾选才删除这四个目录。
  - 受保护目录清单由 `afterPack` 生成为 `resources/installer-manifest.protected.txt`，
    卸载器按文件删除；**新增运行时数据目录只需加入 `scripts/lib/installer-manifest.js` 的
    `PROTECTED_TOP_LEVEL`**。写在安装目录其他位置的文件会被当作程序文件在更新时删除。
  - 首个带该脚本的版本需要手动安装（旧版卸载器不受新脚本控制），此后自动更新才会保住数据。
- 产物文件名必须与更新清单一致：`win` / `mac` / `linux` 都配置了无空格的 `artifactName`。GitHub 会把资产名里的空格替换成点，若使用默认命名，`latest.yml` 中的连字符文件名会 404，自动更新直接失效。
- 安装包缓存：Windows 使用 `%LOCALAPPDATA%\Pi-Workbench-Update`（安装目录之外）；Linux 使用 `{appDir}/cache/{updaterCacheDirName}`。Windows 的缓存必须在安装目录外——electron-builder 的卸载器按 `$INSTDIR` 路径前缀结束进程，安装器若从安装目录内启动会被误杀。
- 外部缓存清理：安装器的 `customInstall` 写入 `%LOCALAPPDATA%\Pi-Workbench-Update.flag`，新版本启动时清理缓存中的下载残留并删除标记（带重试，保留差分基准）；真正卸载时一并删除。
- 安装器副本清理：electron-builder 安装器会把自身复制到 `%LOCALAPPDATA%\pi-workbench-updater\installer.exe`；`customInstall` 在安装完成后删除该副本与目录，应用启动时兜底清理存量。
- 差分更新：electron-updater 在 Windows 从 `{baseCachePath}/{updaterCacheDirName}/installer.exe` 读取旧安装包做块级差分。`customInstall` 把本次安装的安装包复制到 `%LOCALAPPDATA%\Pi-Workbench-Update\pi-workbench-updater\installer.exe`；启动清理与“无更新”清理只删除 `pending/` 等下载残留，保留该文件与 `current.blockmap`。每个安装常驻一份安装包大小的磁盘；基准过期或损坏时会被 sha512 校验拦下并自动回退全量下载。该机制从“由带复制步骤的安装器安装的版本”开始生效：从旧安装器升级的那一次仍是全量，之后的一次更新开始走差分。
- 启动期回收：`electron/legacy-paths.ts` 会合并 `~/.pi` 到 `{appDir}/data/agent` 后删除（检测到独立 Pi CLI 时保留），并删除旧默认 userData（`%APPDATA%\pi-workbench` 等）。`app.setPath('userData')` 必须早于单实例锁，Pi SDK 目录通过环境变量固定到应用目录。
- Windows 更新会设置 `installDirectory = appDir`，安装器始终带 `/D=`，不依赖注册表 `InstallLocation`。
- 安装目录必须可写：安装器在目录页拒绝 `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%SystemRoot%` 及子目录（`.onVerifyInstDir`），并设置 `allowElevation: false`，不会为装进受保护目录而提权。
- 协议注册：`build.protocols` 在安装时注册 `pi-workbench://`，应用内 `setAsDefaultProtocolClient` 作为兜底。
- CI 与打包冒烟使用 `--publish never`，不会误发布。
- 本地验证打包：`npx electron-builder --win --dir --publish never`（macOS / Linux 需在对应系统上执行）。
- CI 的 `package-smoke` job 每次 push / PR 都会执行一次未压缩打包，防止打包配置回归。

---

## 5. 质量检查

```bash
npm run type-check   # TypeScript（严格模式）
npm test             # Vitest 单元测试
npm run lint         # ESLint（含 react-hooks 规则）
npm run format       # Prettier（会重排源码，按需执行）
```

CI（`.github/workflows/ci.yml`）在 push / PR 时执行：`npm ci` → type-check → test → lint → build。

---

## 6. 便携式数据目录

Windows / Linux（AppImage 放在 `.AppImage` 文件旁边）在可执行文件所在目录创建并维护：

```
{appDir}/
├── config/          # settings.json, api-config.json（API Key 经 safeStorage 加密）
├── cache/           # 临时文件、Web dev 模式 Agent 数据、更新安装包缓存（cache/{updaterCacheDirName}）
├── data/            # Agent 模型配置与会话（data/agent/）、Chromium profile（data/profile）
└── logs/            # main.log / renderer.log / agent.log
```

Windows 安装目录必须可写：如果安装到 `C:\Program Files` 等位置，启动时会弹窗提示重新安装到用户可写目录。

**macOS 例外**：应用包内不可写且会被更新替换，打包版数据目录为
`~/Library/Application Support/pi-workbench`（同上结构）。这是经项目所有者确认的便携式例外。

工作区级数据：`{workspace}/.pi-workbench/`

卸载 / 迁移时整体拷贝应用目录即可（macOS 为上述 Application Support 目录）。

---

## 7. 常见问题

| 问题 | 处理 |
|---|---|
| `Electron failed to install` / 下载超时 | 使用 ELECTRON_MIRROR（见上）或重试 |
| 端口 5173 被占用 | 结束占用进程；`vite.config.ts` 中 `strictPort: true` 会直接报错 |
| 启动后 Fetch 无反应 | 检查 DevTools 是否出现 `window.electronAPI is undefined`（preload 加载失败） |
| Agent 初始化失败 `Unexpected token 'with'` | Electron 版本过低（内置 Node < 22），必须使用 Electron ≥ 39 |
| Windows 下 Agent bash 工具不可用 | 安装 Git for Windows；AgentManager 会自动把用户目录下的 Git Bash 加入 PATH |
| 打包后 Agent 初始化失败 | 确认 `pi-bridge/dist` 与 `@earendil-works/pi-coding-agent` 已进入 asar（见上） |
