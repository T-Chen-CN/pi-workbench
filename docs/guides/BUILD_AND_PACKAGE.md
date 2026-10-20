# 构建与打包指南

**适用版本**: 0.1.0（Phase 5 完成，Phase 6 持续）
**最后更新**: 2026-10-21

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

- 发布前先把 `package.json` 的 `version` 提升到目标版本。
- 推送 `v*` 标签（例如 `git tag v0.1.1 && git push origin v0.1.1`）会触发
  `.github/workflows/release.yml`：在 Windows runner 上构建 NSIS 安装包并上传到 GitHub Release。
- 打包版本通过 `electron-updater` 检查 GitHub Release；CI 与打包冒烟使用
  `--publish never`，不会误发布。
- 本地验证打包：`npx electron-builder --win --dir --publish never`。
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

应用在可执行文件所在目录（开发模式为项目根目录）创建并维护：

```
{appDir}/
├── config/          # settings.json, api-config.json（API Key 经 safeStorage 加密）
├── cache/           # 临时文件、Web dev 模式 Agent 数据
├── data/            # Agent 模型配置与会话（data/agent/）
└── logs/            # 预留
```

工作区级数据：`{workspace}/.pi-workbench/`

卸载 / 迁移时整体拷贝应用目录即可。

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
