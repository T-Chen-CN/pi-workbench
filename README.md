<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="Pi Workbench — 本地优先的 Agent 开发工作台" width="880">
  </picture>
</p>

# Pi Workbench

本地优先的桌面开发工作台：真实的编码 Agent 就在编辑器旁边，读写你的文件、执行命令，权限模式由你决定。

[![CI](https://github.com/T-Chen-CN/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/T-Chen-CN/pi-workbench/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/T-Chen-CN/pi-workbench)](https://github.com/T-Chen-CN/pi-workbench/releases/latest)
[![许可证](https://img.shields.io/github/license/T-Chen-CN/pi-workbench)](LICENSE)
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2b2b2b)](#下载)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-2b2b2b)](package.json)

**简体中文** · [English](README.en.md) · [下载](#下载) · [文档](docs/README.md)

---

## 目录

1. [特性一览](#特性一览)
2. [下载](#下载)
3. [开始使用](#开始使用)
4. [配置](#配置)
5. [开发情况](#开发情况)
6. [工作原理](#工作原理)
7. [项目结构](#项目结构)
8. [参与贡献](#参与贡献)
9. [文档](#文档)
10. [许可证](#许可证)

---

## 特性一览

### Agent：把活干完，而不是给你一段代码

Agent 是主进程里的运行时，不是子进程或旁路的 HTTP 服务 —— 所以权限拦截与审批超时才有意义。它直接读写工作区的真实文件，每一次工具调用都要过会话模式。

<!-- 截图位：docs/assets/shot-agent.png（Ink 主题，工具轨迹展开 + 内联变更卡 + 审批卡） -->

- **四档会话权限**：只读 / 计划 / 询问 / 完全。需要决策的工具调用弹审批卡（允许一次 / 本会话 / 始终 / 拒绝），审批超时一律按拒绝处理。
- **计划模式**：只放行只读工具，Agent 必须先交计划卡（步骤、涉及文件、风险）；批准后会话原子切换到执行模式，计划随即变成可勾选的进度。
- **过程可见**：思考与工具调用按时间线展开，带耗时、参数与结果预览；`write` / `edit` 能直接打开对应 Diff。
- **像终端一样对话**：运行中可排队或插话，回复可重新生成并在分支间切换，用户消息可编辑后重发，压缩发生的那一轮留下分隔线。

### 文档：一个 `read` 读到底

不新增第二个读工具。PDF 与 Office 由内置 `read` 覆盖，模型只需要知道 `read` 能读一切。

<!-- 截图位：docs/assets/shot-docs.png（Paper 主题，Office / PDF 只读预览 + 附件 chip） -->

- **六种格式可读**：`.pdf` / `.docx` / `.xlsx` / `.pptx` / `.odt` / `.epub` 按魔数分流（不看扩展名），零新增依赖解析。
- **扫描件走视觉通道**：没有文本层的 PDF 渲染成图片交给模型；旧格式 `.doc` / `.xls` / `.ppt` 不猜测解析，直接给「另存为」指引。
- **编辑器侧阅读视图**：Markdown / HTML 直接渲染（Markdown 支持块级就地编辑），图片、音频、视频走本地只读协议，PDF 用自绘 pdf.js（翻页、50%–400% 缩放）。
- **Office 只读预览**：Word 版本版心、表格网格、幻灯片卡片、EPUB 章节各有独立排版。

### Git 与工作树：并行改，互不干扰

一个会话绑定一个工作树，每一轮都落在那里；换分支换任务不再需要搬文件。

<!-- 截图位：docs/assets/shot-worktree.png（Ink 主题，工作树 chip + Git 提交图） -->

- **全分支提交图**：ref 分类着色、合并标记、提交详情与逐文件 Diff。
- **会话绑定工作树**：切换只在轮次边界生效，绑定关系写进 `.pi-workbench/session-git.json`。
- **工作树依赖自动安装**：按 lockfile 识别 pnpm / bun / yarn / npm / uv，后台串行、硬超时，结果按 lockfile 哈希复用。
- **GitHub 关联**：Device Flow 登录（PAT 回退），显示当前分支的 PR 与 CI 状态。

### 工作台：面板能拆，关窗不退

多工作区、可拆面板、托盘常驻 —— 这些不是装饰，是为了让 Agent 在你去做别的事的时候继续跑。

<!-- 截图位：docs/assets/shot-panel.png（Ink 主题，主窗口 + 拆出的面板窗口） -->

- **多工作区常驻**：切标签只切换可见性，每个工作区的编辑器、Diff、终端与 Agent 会话都保留。
- **面板可拆成独立窗口**：文件树、Git、聊天、终端都能拆出去，共享同一份 store，终端保留 PTY 与 200KB 回放缓冲。
- **终端与插件**：xterm.js + node-pty，输出可一键附加为 Agent 上下文；命令面板 + 工作区插件（命令 / 钩子 / 热重载）。
- **收进托盘**：关窗后会话、文件监听、更新检查继续运行，真退出走托盘菜单。

### 本地优先：数据只在你自己的机器上

| 位置                         | 内容                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `{appDir}/config/`           | `settings.json`、`api-config.json`、`web-search.json`（Key 已加密） |
| `{appDir}/data/`             | `models.json`、会话记录、`workspaces.db`                            |
| `{appDir}/cache/`            | 临时文件、下载的更新包                                              |
| `{appDir}/logs/`             | `main.log`、`agent.log`（5MB 轮转）                                 |
| `{workspace}/.pi-workbench/` | 编辑器标签、会话标签、会话 extras、工作树绑定、终端日志、插件配置   |

- API Key 用 Electron `safeStorage` 加密成 `enc:<base64>`，明文不进磁盘、日志或工作区。
- 渲染进程开启 sandbox、无 Node 权限；每个 IPC 频道校验来源；文件操作限定在受信任工作区与 `{appDir}/cache/`。
- 无遥测、无账号、可完全离线；联网搜索是可选配置。
- macOS 因应用包只读，数据放在 `~/Library/Application Support/pi-workbench`。

---

## 下载

到 [最新 Release](https://github.com/T-Chen-CN/pi-workbench/releases/latest) 取对应平台的安装包。

| 平台    | 文件                                | 说明                                                               |
| ------- | ----------------------------------- | ------------------------------------------------------------------ |
| Windows | `Pi-Workbench-Setup-<版本>.exe`     | NSIS 安装包；升级只替换程序文件，保留 `config/ data/ logs/ cache/` |
| macOS   | `Pi-Workbench-<版本>-universal.dmg` | Universal 二进制（Apple Silicon + Intel）                          |
| Linux   | `Pi-Workbench-<版本>.AppImage`      | `chmod +x` 后直接运行                                              |

构建由 GitHub Actions 在版本标签上产出，**未做代码签名与公证**，因此首次启动会被 Windows SmartScreen 或 macOS Gatekeeper 拦一次，确认「仍要运行」即可。

更新策略：启动 12 秒后静默检查；Windows / Linux 后台下载但**绝不自动安装**，由你点确认；macOS 只检查并引导手动下载。升级只替换程序文件，不碰数据目录。

---

## 开始使用

### A. 下载即用

装上、打开、按下面「配置」填一次 API 信息即可。不需要 Node，不需要额外运行时。

### B. 从源码运行

```bash
npm install
npm run dev        # 先构建 bridge 与主进程，再启动 Vite + Electron
```

需要 **Node ≥ 24**（Electron 44 内置 Node 24，工作区历史使用 `node:sqlite`）；`bash` 工具需要系统里有 bash（Windows 装 Git for Windows）。

只调试界面与 Agent（浏览器模式，文件 / Git / 终端为 mock）：

```bash
npm run web:dev
```

### C. 自己打包

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

产物在 `release/`。构建、签名、自动更新与排错见 [BUILD_AND_PACKAGE](docs/guides/BUILD_AND_PACKAGE.md)。

### 质量门槛

```bash
npm run type-check
npm test           # 1200+ Vitest 用例
npm run lint
npm run build
```

---

## 配置

首次启动打开**设置**，五步走完即可开始：

1. **供应商** —— Anthropic、OpenAI，或任意 OpenAI 兼容端点（DeepSeek、中转站、本地服务）。
2. **API 地址** —— 例如 `https://api.deepseek.com/v1`。
3. **API Key** —— 经 `safeStorage` 以 `enc:<base64>` 存入 `config/api-config.json`，运行时通过环境变量交给 Agent。
4. **拉取可用模型** —— 取供应商真实模型列表，再按模型设置上下文窗口（64K / 128K / 256K / 1M）与图像能力。
5. **联网搜索**（可选）—— 十家服务商单选，Key 加密存入 `config/web-search.json`。

---

## 开发情况

| 项       | 现状                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| 当前版本 | `0.7.5`（2026-10-31）                                                                          |
| 发布     | 12 个 Release；三平台安装包与 `latest*.yml` 由 CI 在 tag 上产出                                |
| 阶段     | Phase 0–4 完成 · Phase 5（Fleet 后台任务）已于 2026-10-24 整体移除 · Phase 6 持续优化          |
| 质量     | type-check + lint + 1200+ Vitest 用例 + 全量 build；CI 另跑一次 Windows 打包冒烟               |
| 依赖     | Electron 44 · React 19 · TypeScript 5.9 · Monaco 0.57 · `@earendil-works/pi-coding-agent` 1.3  |
| 已知边界 | 未签名未公证；旧格式 Office 不解析；扫描件不做 OCR；Linux 托盘降级为最小化；平台手工验收仍未做 |

**接下来在做的**：跨工作区的顶层 Agent（派发子会话、委派授权、headless 工作区）仍处于需求草案阶段，见 [TOP_LEVEL_AGENT_BRIEF](docs/requirements/TOP_LEVEL_AGENT_BRIEF.md)。阶段明细与逐条记录在 [STATUS](docs/progress/STATUS.md)，停放项在 [BACKLOG](docs/progress/BACKLOG.md)。

---

## 工作原理

```
渲染进程（sandbox，无 Node）
  React + Zustand + Monaco
  window.electronAPI  ←  contextBridge  ←  preload
        │  IPC：全部经 handleIpc（来源校验、fail-closed）
主进程（Electron 44 / Node 24）
  fs · 对话框 · safeStorage · 文件监听 · PTY · PDF / OOXML 抽取
  AgentManager（pi-coding-agent）──HTTP──> 模型供应商
  read / write / edit / bash 直接作用于工作区
```

Agent 不跑在子进程、Worker 或 HTTP 服务里 —— 它是主进程内的运行时。这是权限拦截、审批超时、工作树绑定能成立的前提。

---

## 项目结构

```
electron/     主进程：IPC 各域、Agent 注册表、Git、文档抽取、终端、更新
src/          渲染层：components、stores、hooks、api（IPC 封装）、i18n、theme
pi-bridge/    AgentManager，pi-coding-agent 之上的会话、工具策略与标题
tests/        Vitest 用例（扁平，与源文件一一对应）
docs/         项目文档
examples/     插件示例（git-tools）
```

进程模型、数据流与 IPC 频道表见 [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md)。

---

## 参与贡献

- **报问题**：带上复现步骤，附 `logs/main.log` 与 `logs/agent.log` 的相关片段（密钥不会入日志）。
- **提 PR**：先跑 `npm run type-check` / `npm test` / `npm run lint` / `npm run build`；改 UI 还要过 `tests/design-system.test.ts`。
- **翻译**：界面文案在 `src/i18n/`，中英对齐即可。
- **写插件**：从 [examples/plugins/git-tools](examples/plugins/git-tools) 开始，命令与钩子见 [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md)。

给 AI agent 的项目约束见 [AGENTS.md](AGENTS.md)；对外文案规范见 [PUBLIC_COPY](docs/guides/PUBLIC_COPY.md)。

---

## 文档

- [文档索引](docs/README.md) —— 按任务查找
- [项目方案](docs/PROJECT_PLAN.md) —— 定位、进程模型与技术决策
- [项目结构](docs/architecture/PROJECT_STRUCTURE.md) —— 代码组织、数据流、IPC 频道
- [设计系统](docs/design/DESIGN_SYSTEM.md) —— 颜色、字体、间距、组件的唯一事实源
- [Agent 运行时](docs/agent/agent-runtime.md) —— 会话、权限、计划、工具策略、压缩、导出
- [Git 与工作树](docs/agent/git-and-worktrees.md) —— 工作树绑定、Git 视图、GitHub 关联
- [构建与打包](docs/guides/BUILD_AND_PACKAGE.md) —— 构建、发布、自动更新与排错
- [项目状态](docs/progress/STATUS.md) —— 各阶段完成情况

---

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方组件与许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

英文版：[README.en.md](README.en.md)
