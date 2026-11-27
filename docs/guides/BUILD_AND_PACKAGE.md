# 构建与打包指南

> **面向**：要构建、打包、发布或动自动更新逻辑的人
> **什么时候读**：跑 `npm run package:*`、动 NSIS / 更新机制 / 数据目录之前
> **什么时候要改**：构建脚本、打包配置、更新机制或受保护目录清单变化时

**最后更新**: 2026-11-27

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 24** | Electron 44 内置 Node 24；构建脚本与 node:sqlite 依赖 |
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

`npm install` / `npm ci` 会通过根 `package.json` 的 `prepare` **自动构建** `pi-bridge`（`pi-bridge/dist`）。
主进程、`apps/cloud` 与测试都用裸导入 `pi-bridge`，走 `node_modules` 解析到 `dist/index.d.ts`；该目录 gitignore，
不建就 `type-check` / `test` 直接报 `TS2307`（干净检出与 CI 都是这条路径）。

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

依次执行（**顺序不可颠倒**）：

| 步骤 | 命令 | 产物 |
|---|---|---|
| 渲染进程 | `npm run build:renderer` | `dist/` |
| Agent 桥接层 | `npm run build:bridge` | `pi-bridge/dist/`（已加入 `.gitignore`，构建时生成） |
| 主进程 + preload | `npm run build:main` | `dist-electron/main.js`、`dist-electron/preload.cjs` |

**为什么这个顺序**：主进程编译时引用 `pi-bridge/dist` 的类型，桥接层必须先构建；`package.json` 的 `build` 脚本已经按此顺序串联。

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
npm run package              # 当前平台
npm run package:win          # Windows：NSIS 安装包（标准两目录）
npm run package:win:portable # Windows：免安装便携版 .zip（单目录，自带 portable 标记）
npm run package:mac          # macOS (DMG)
npm run package:linux        # Linux (AppImage)
```

输出目录：`release/`

Windows 产物：

- `Pi-Workbench-Setup-<version>.exe` — NSIS 安装包（per-user、可选安装路径、严格两目录）
- `Pi-Workbench-Portable-<version>-win-x64.zip` — 免安装便携压缩包（解压即用、根级自带 `portable` 标记，由 `scripts/build-win-portable.mjs` 生成）

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
    "app-icon.ico",
    "tray-template.png",        // macOS 菜单栏托盘模板图，缺了托盘没有图标
    "tray-template@2x.png"
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

- 发布前先把 `package.json` 的 `version` 提升到目标版本。README 的版本号**只出现在 banner 的右侧数据栏与徽章里**（徽章自动，banner 需同步改 `docs/assets/banner-light.svg` / `banner-dark.svg` 的那一行 `vX.Y.Z`）。
- 推送 `v*` 标签（例如 `git tag v0.7.4 && git push origin v0.7.4`）会触发
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
- **Windows 安装版与便携版的卸载/更新职责分离（[build/installer.nsh](../../build/installer.nsh)）**：
  - 安装版程序文件与用户数据彻底解耦：更新与卸载直接走 `electron-builder` 标准 `$INSTDIR` 清理流程，不再维护 `afterPack` 清单脚本，也不存在更新误删用户数据的风险；
  - 真正卸载（`${ifNot} ${isUpdated}`）时，卸载欢迎页提供「保留用户配置与会话数据（`%APPDATA%\pi-workbench`）」勾选框（默认勾选，静默卸载同样保留）；取消勾选时一并删除该数据目录；
  - 便携版 `.zip` 内置空 `portable` 标记文件，`UpdateController` 自动禁用自动安装（`canAutoInstall = false`），检查到新版时引导用户前往 Release 页手动下载替换程序文件，绝不跑 NSIS 覆盖便携目录。
- 产物文件名必须与更新清单一致：`win` / `mac` / `linux` 都配置了无空格的 `artifactName`。GitHub 会把资产名里的空格替换成点，若使用默认命名，`latest.yml` 中的连字符文件名会 404，自动更新直接失效。
- **统一更新缓存与差分更新**：三平台标准模式统一使用 `{dataDir}/cache/pi-workbench-updater/`（Windows 为 `%APPDATA%\pi-workbench\cache\pi-workbench-updater\`，已在 `$INSTDIR` 之外，NSIS 卸载器不会误杀）。`customInstall` 写入差分基准 `installer.exe` 与 `pi-workbench-updater.flag` 标记，同时删掉 `electron-builder` 在 `%LOCALAPPDATA%\pi-workbench-updater` 生成的重复副本与旧版 `%LOCALAPPDATA%\Pi-Workbench-Update`，保证全机严格两目录；新版本首启按标记只清理 `pending/` 残留，保留差分基准与同级 `drafts/` / `temp/`。
- 启动期迁移与回收：旧版（≤0.11.2）升级到标准两目录版时，`migrateLegacyInstallDirSync()` 在建日志/打开数据库前同步将旧安装目录内的 `config/ data/ logs/ cache/drafts/` 迁入 `%APPDATA%\pi-workbench`；`electron/legacy-paths.ts` 继续合并 `~/.pi` 到 `{dataDir}/data/agent`（检测到独立 Pi CLI 时保留）并清理旧 `%LOCALAPPDATA%` 残留。
- Windows 安装版更新设置 `installDirectory = getInstallDir()`（程序安装目录而非数据目录），安装器始终带 `/D=`，不依赖注册表 `InstallLocation`。
- 协议注册：`build.protocols` 在安装时注册 `pi-workbench://`，应用内 `setAsDefaultProtocolClient` 作为兜底。
- CI 与打包冒烟使用 `--publish never`，不会误发布；`release.yml` 在 Windows 同时产出 Setup `.exe` 与 Portable `.zip`。
- 本地验证打包：`npx electron-builder --win --dir --publish never`（再跑 `node scripts/build-win-portable.mjs` 验便携 zip）。
- CI 的 `package-smoke` job 每次 push / PR 都会执行一次未压缩打包，防止打包配置回归。

---

## 5. 质量检查

```bash
npm run type-check   # 全仓 7 份 tsconfig
npm test             # Vitest 单元测试
npm run lint         # ESLint（含 jsx-a11y、跨包边界、AST 色值护栏）
npm run format       # Prettier（会重排源码，按需执行）
```

CI（`.github/workflows/ci.yml`）在 push / PR 时执行：`npm ci` → `build:bridge` → `type-check` → `build:cloud` → `test` → `lint` → `build`。

---

## 6. 数据目录模型（严格两目录 + 可选便携版）

- **安装版（默认，三平台一致）**：
  - 程序目录：安装位置（仅放程序文件，更新整包替换）；
  - 唯一数据目录：Windows `%APPDATA%\pi-workbench` · macOS `~/Library/Application Support/pi-workbench` · Linux `~/.config/pi-workbench`，集中维护 `config/`、`cache/`、`data/`、`logs/`（具体文件清单见 [agent/paths-and-storage §3](../agent/paths-and-storage.md)）。应用内「设置 → 关于」提供「打开数据目录」按钮一键直达。
- **便携版（Windows `.zip` 或同级放 `portable` 标记）**：程序与 `config/`、`cache/`、`data/`、`logs/` 同处一个目录，适合免安装绿色使用（注：本机密钥仍绑定当前 OS 用户）。
- 工作区级配置：`{workspace}/.pi-workbench/`（随项目存放，仅存轻量工作区配置与索引）。

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
