# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.12.0**（2026-11-28） |
| 阶段 | 本地 Agent 工作台与云端 Agent 完成 Phase A–F 全面升级：安全边界与云端 SQLite 关系化、性能/体积瘦身与后台休眠、6 大手写底层替换、Zustand 5 / `@pi-workbench/{ui,i18n,cloud-ui}` / 单源 Typed IPC / 上帝文件拆解 / 严格门禁与 Playwright E2E、`utilityProcess` 进程隔离与原生多 `BrowserWindow` 拆窗，以及全栈统一 MCP 服务器接入（桌面全局/项目级 SHA-256 信任 + 云端远程/本地 stdio 与双端共享管理 UI） |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 5 + Tailwind 3 + Monaco 0.57 + Zod 4 + i18next + Playwright (`_electron`) |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（独立 Electron `utilityProcess` + 直连 `MessagePort` 流式；重 CPU 非 Agent 解析走 `worker_threads`） |
| 质量门槛 | 全仓 9 份 `type-check` · `eslint . --max-warnings 0`（含 `no-explicit-any` / `no-floating-promises` / `jsx-a11y` / 跨包边界 / AST 色值）· `npm test` · `design-system`（AST）· `build` / `build:cloud` · Playwright `_electron` 冒烟（本地与打包版）全绿 |
| 云端 Agent | **P0/P1 + Phase A/B/D/F 全面收口：Node 24 `node:sqlite` (WAL) v3 关系化索引 + 记忆/梦境/加密 MCP 表入库 + 生产首启口令 + 锁全量传递依赖不可变发布 + Cloud Web 体积降至 8.11 MiB（br/gzip + 中英切换）+ `@pi-workbench/cloud-ui` 去重与双端 Cloud MCP 管理**；剩余仅 P2（`P-02` 云端 OAuth 登录） |

## 正在做 / 下一步

- **供应商预设的真实凭证手工验收**（[BACKLOG](./BACKLOG.md) P-03）：0.11.0 发布时未执行，需补 8 家 API Key、4 条 OAuth、容量下调在轮次边界生效、会话模型静默回落各一次。
- **架构待单独讨论项**（[BACKLOG](./BACKLOG.md) `D-02`）：托管工作树存放位置（当前保持仓库内 `.pi-workbench/worktrees/`）。
- **云端 OAuth 登录**（[BACKLOG](./BACKLOG.md) P-02，P2）与 **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）。

## 已交付（一行一项，细节在 git）

- **Phase F · 统一 MCP 接入（2026-11-28）**：基于 `@modelcontextprotocol/sdk` 落地 `pi-bridge` `McpClientHost` 与浏览器安全 `pi-bridge/mcp` 子路径（`stdio` / Streamable HTTP / SSE、`readOnlyHint` 权限分类、`allowMcpTools` 策略、128 KB 截断与脱敏）；桌面端落地 `safeStorage` 加密全局配置、只读项目配置发现与 SHA-256 指纹 fail-closed 信任，贯通 `utilityProcess`、云端派活工单与设置页 `McpSettings`；云端落地 SQLite v3 `mcp_servers` 加密表、`/v1/mcp*` REST、远程 HTTP/SSE + 云主机本地 `stdio`（`pi-cloud.service` 兼容 `/opt/pi-cloud/mcp`）、轮次边界热重载及 `@pi-workbench/cloud-ui` `CloudMcpManager`（Web 与桌面 `CloudView` 共享管理）；远端工单 OS/Docker 沙箱按所有者决定不实施并归档至 BACKLOG §4。

- **Phase A–E 整体架构升级与 59 项纯 Bug 修复（2026-11-28）**：
  - **59 项纯代码 Bug 修复**（`8fd5ec1`..`cdd1a28`）：补齐 5 套回归测试，修复 `pi-bridge`、`electron/`、云端栈与渲染层全部确定性缺陷。
  - **Phase A · 安全、SQLite 正规化、运维与自动清理**（`51f7c99`..`33da37f`）：插件全量 SHA-256 与拒软链、`fs:openExternally` 白名单、HTTP CSP/权限 fail-closed、环境变量全量清洗、启动纯自动缓存与日志轮转、远端读工具守卫与脱敏、云端首启口令/IPv6 `/64` 限流/PHC scrypt/Cookie CSRF/WS 背压/SQLite `user_version` 迁移与记忆入库、锁传递依赖不可变发布与热备。
  - **Phase B · 性能瘦身、后台休眠、排版与宽度持久化**（`1e390ae`..`e832c4b`）：Cloud Web 去除 10.3 MB CJK 字体（`web-dist` 18.49 → 8.11 MiB）+ br/gzip + 移动端适配；非活跃工作区 `display: none` 休眠 DOM/PDF/FS 而不中断后台 Agent 与 PTY；消除级联重渲染、懒加载 KaTeX/Terminal、移除 `quickjs-eval.wasm`、热路径 O(1)；面板宽度持久化、错误 Toast 8s 悬停/聚焦暂停、Paper & Ink 功能文字底线抬至 `≥ 12px`。
  - **Phase C · 6 大手写底层替换**（`7c4d4fe`..`5c54329`）：`fflate`（ZIP64/CRC32）+ `saxes`（XML）、`https/socks-proxy-agent`（HTTP/HTTPS/SOCKS4/5）、`chokidar` v4、Monaco `createDiffEditor` + `fast-diff`、`web-tree-sitter` WASM AST（9 种语言按需分发）、`@base-ui/react` + `@floating-ui/react` + `cmdk`。
  - **Phase D · 底座统一、上帝文件拆解与门禁升级**（`75388d9`..`771ff47`）：Zustand v5 + `<WorkspaceStoresProvider>`、抽离 `@pi-workbench/ui` 与 `@pi-workbench/i18n`（`i18next` 覆盖三端，Cloud Web 支持中英切换）、去重 `CloudView` 与 Cloud Web、`pi-bridge` NodeNext + 子路径 + 统一 `atomic-json`、单源 Typed IPC 契约（`electron/ipc/contract.ts` + esbuild `preload.cjs`）、拆解 `AgentManager`（`SessionController`/`SessionRepository`）与 `ChatPanel`/`useChatPanelState`（`chatTurnController` + 5 子组件）、`eslint . --max-warnings 0`（`no-explicit-any` + `no-floating-promises`）+ AST 设计系统测试 + Playwright `_electron` 冒烟 E2E。
  - **Phase E · `utilityProcess` 进程隔离与原生多 `BrowserWindow` 拆窗**（`fa3dd73`..`788e379`）：Agent 与工作区插件迁入独立 `utilityProcess`（受控凭证 RPC、直连 `MessagePort` 流式、崩溃自愈与 `childRegistry` 集成）；面板拆窗彻底告别 `about:blank` Portal，改为原生子 `BrowserWindow` + `panel:detach`/`panel:dock`/`sync:broadcast` 跨窗桥（主窗收托盘拆窗保留、关窗回位、重启回位仅保留宽度，修订 ADR-001）。

- **全局代码与文档清理（2026-11-28）**：移除无引用遗留模块（`electron/window-morph.ts`、`electron/text-sanitize.ts`）、孤立 IPC（`git:listAllWorktrees`）、8 个死 i18n 文案键与 3 份早期云端可行性/PoC 报告，修复 27 处文档断链并同步全仓 `README` / 架构 / 运维文档。
- **D-01 两目录模型与便携 zip（2026-11-27）**：统一「程序安装目录 + `<appData>/pi-workbench` 唯一数据目录」（含更新缓存收口与旧安装目录无损迁移）、瘦身 `build/installer.nsh` 并移除 `installer-manifest` 脚本、设置页新增「打开数据目录」，Windows 发布同时产出 Setup `.exe` 与免安装 Portable `.zip`。
- **Phase 0–2 深度整改（2026-11-27）**：完成 12 项 P0 安全漏洞与数据防丢止血；完成前端瘦身、`packages/cloud-ui` 共享包抽离与云端 `node:sqlite` 持久化；完成 `worker_threads` 文档/地图卸载、`AgentManager` 拆分与 `deriveMessages` 单一聊天渲染投影、Zod IPC/云端协议校验与能力协商、原生 `titleBarOverlay` + 取消启动形变 + A11y / `RepoMapCanvas` / 虚拟化优化、ESLint `jsx-a11y` + 边界/AST 规则、全仓 `src/components/` 与 `tests/` 按域目录重组及 `DESIGN_SYSTEM.md` 瘦身。

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已整体移除**（代码与文档都不在仓库里，需要考古看 `git log`）。
- **0.12.0**：严格两目录模型 + Windows 免安装便携 `.zip`（含 ≤0.11.2 旧数据无损迁移）；59 项全栈 Bug 修复；Phase A–E 架构升级（安全边界与自动缓存维护、云端 SQLite v3 关系化与记忆入库、Cloud Web 瘦身至 8.11 MiB + 中英切换、后台工作区休眠不中断 Agent、面板宽度持久化与错误 Toast 悬停暂停、6 大手写底层替换、Zustand 5 / `@pi-workbench/{ui,i18n,cloud-ui}` / 单源 Typed IPC / `eslint --max-warnings 0` / Playwright `_electron` 冒烟、Agent `utilityProcess` 进程隔离与原生多 `BrowserWindow` 拆窗）；Phase F 统一 MCP 接入（桌面全局加密 + 项目级 SHA-256 信任 + 派活工单继承 + 云端远程/本地 `stdio` MCP 与双端共享管理 UI）。
- **0.11.2**：云端 Agent 全面进阶（P0 真派活闭环 + P1 全部落地：脱敏 diff 按需审查、多端已读同步与托盘角标、持久记忆压缩前抽取 / 梦境整理 / `AGENTS.md` 与 `SOUL.md` 双端可视化编辑、运行中工单直发追加指令、停滞看门狗与全站并发上限 8、改动清单 `attention` 分组与密钥位置告警、工单 worktree 独立 `pre-push` 守卫、离线期汇报汇总）；供应商设置接入独立 `models.dev` 富数据与目录自动刷新 / `PI_OFFLINE` 开关，修复 Google / xAI 无效 Key 400 误判；补齐压缩进行中状态与压缩期排队、上下文覆写同步已有会话与高并发派单竞态修复。
- **0.11.1**：新增「使用系统代理」热生效开关（主进程 `globalThis.fetch` 按开关走 Electron `net.fetch`）；修复远端模型目录缓存未加载与 D12/D26 下架过滤、配置校验放行远端新增模型，修正 Google（`x-goog-api-key`）与 Anthropic（`/v1/models`）Key 探测；合入 0.11.0 后 17 项安全边界、拆窗/终端流、pi-bridge 运行时与云端会话登出加固。
- **0.11.0**：模型配置改为固定供应商预设——8 家内置 provider（OpenAI / Anthropic / Google / xAI / DeepSeek / 小米 MiMo / 小米 Token 套餐 / OpenAI Codex），模型能力与协议来自 Pi catalog（内置快照 + pi.dev 增量），凭证改为 `config/credentials.json`（safeStorage）并支持 OAuth 登录（浏览器回调 / 设备码 / 粘贴回调地址），容量可按模型向下调且轮次边界生效；删除自定义端点链路（`apiConfig:*` IPC、dev 代理、`model-capabilities`），旧 `api-config.json` 首启迁移并归档 `.legacy`。
- **0.10.0**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划扩展保留，供下一代云端服务复用；升级首启清掉旧版留下的凭据类残留（`electron/legacy-cleanup.ts`，幂等 + 失败可重试）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-28（0.12.0 发版）
