# 任务清单（Backlog）

> **面向**：要挑下一个任务的人与 agent
> **唯一任务表**：所有待办、平台验收、"已决定不做"都在本文件；想知道某件事做了没，也只查这里。
> **什么时候改**：新增 / 关闭 / 范围变化。完成项在 §2 只留一行，实现细节交给 `git log` 与 Release 页。
> **相关**：[项目状态](./STATUS.md)（一页快照）· [设计系统](../design/DESIGN_SYSTEM.md)

---

## 1. 维护规则

- 完成一项：§2 状态改 ✅ 并写日期，正文条目删除（细节查提交与 Release 说明）。
- 编号不复用；放弃的移到 §4，并写清为什么。
- 发版前提：三平台 CI 绿、**本版范围内**没有未完成的 P0 / P1、真实供应商冒烟通过。
- 跨版本的 P0 / P1 不阻塞发版，但每次发版必须在 §2 记一条「本版不阻塞」：日期 + 条目 + 理由，否则按未决处理。

## 2. 总览

### 未完成

| ID | 项目 | 优先级 | 状态 |
| --- | --- | --- | --- |
| P-01 | 供应商预设与鉴权（8 家）：固定 provider + safeStorage 凭证 + OAuth 登录 | P1 | 🟡 桌面端随 0.11.0 发布（P0–P5 配置部分，`71a572c`→`5278080`）：凭证文件存储 / 旧配置迁移 / 运行时切 catalog / 协议与回落修正 / 设置页 + OAuth 登录（`providers:*` IPC）。方案见 [provider-presets](../architecture/provider-presets.md)，剩下的是 P-02 / P-03 |
| P-02 | 云端 OAuth 登录（D18 / D19） | P2 | ⬜ 未做：服务端 auth flow（`start` / `events` / `answer` / `cancel`）+ 临时状态表（PKCE verifier、device code，**不可跨实例**）+ 云端配置页登录 UI + 成功凭证写回 `CloudConfigRecord.credentialCipher`。四条路径各一次：`xai` device code · `anthropic` copy-code · `openai-codex` device code · `openai` 粘贴回调 URL |
| P-03 | 供应商预设的真实凭证手工验收（发布前必做） | P1 | ⬜ 未做（清单见 [provider-presets §11.2](../architecture/provider-presets.md)）：8 家 × api_key 各一次；4 条 OAuth（含验证 `openai` 粘贴回调 `client_id` 换 token 与各家订阅策略）；下调上下文/输出上限在**轮次边界**生效且不打断；换模型档位自动降级；会话模型回落不弹提示；云端配置页 Key 只回掩码 |
| S-01 | 工作区级 `.pi/extensions` / `.pi/settings.json` 显式信任机制 | P2 | ⬜ 未做：阶段 0 已默认以 `projectTrusted: false` + `noExtensions: true` 封堵打开不可信仓库即执行扩展的 RCE 风险；后续按需评估是否增加类似 VS Code Workspace Trust 的按工作区显式弹窗授权与持久化信任开关 |
| D-02 | 托管工作树存放位置（仓库内 `.pi-workbench/worktrees/` vs 仓库外独立缓存目录） | P2 | ⬜ 待单独讨论：暂保持 `.pi-workbench/worktrees/` 不变（兼顾项目所在盘空间与直观查找）；后续按需评估是否开放目录选项 |
| V-01 | macOS 手动验收（universal dmg） | 发布前 | ⬜ 未做 |
| V-02 | Linux 手动验收（AppImage） | 发布前 | ⬜ 未做 |

**2026-11-28 发版不阻塞记录（0.12.1 桌面端）**：同 0.12.0（热修复打包版 `@pi-workbench/i18n` 启动缺失与 NSIS 覆盖迁移抢救，未变更待办范围）：P-03 · P-02 · S-01 · D-02 · V-01 / V-02。

**2026-11-28 发版不阻塞记录（0.12.0 桌面端）**：P-03（供应商预设 8 家 API Key + 4 条 OAuth 真实凭证手工验收，待真账号逐项补测）· P-02（云端 OAuth，P2，云端继续使用 API Key）· S-01（仓库 `.pi/extensions` 信任弹窗，P2，当前默认 `projectTrusted: false` 安全关闭）· D-02（托管工作树目录位置，P2，保持 `.pi-workbench/worktrees/`）· V-01 / V-02（macOS dmg / Linux AppImage 真机手动验收，依赖对应平台真机）。

**2026-11-26 发版不阻塞记录（0.11.2 桌面端）**：P-03（供应商预设 8 家 API Key + 4 条 OAuth 真实凭证手工验收，待真机/真实账号逐项补测）· P-02（云端 OAuth，P2，云端继续使用 API Key）· V-01 / V-02（macOS dmg / Linux AppImage 真机手动验收，依赖对应平台真机）。

**2026-11-26 发版不阻塞记录（0.11.0 桌面端）**：R-23（输出截断的 B4/B7/`reasoning_effort` 联动，与本次配置链路改动无关，B8 标题预算已同版完成）· P-02（云端 OAuth 未做，云端继续用 API Key 配置，协议无变化）· C-01（云端真派活走查，需真实 Key，且生产补丁待部署）· C-03 / C-06（云端 P1 功能簇，桌面端不依赖）。P-03 保留 P1 并作为本次发版的冒烟项，**发布时未执行**，需在下一个版本前补上。

### 已交付（只留一行，细节在 git）

- 2026-11-28 **Phase F · 统一 MCP 接入（`pi-bridge` + 桌面端全局/项目级 + 云端 Agent 双端管理）**：在 `pi-bridge` 基于 `@modelcontextprotocol/sdk` 落地 `McpClientHost`（`stdio` / Streamable HTTP / SSE、环境清洗、子进程 PID 清理、128 KB 截断与脱敏、`readOnlyHint` 权限分类与 `allowMcpTools` 策略）及浏览器安全子路径 `pi-bridge/mcp`；桌面端落地 `safeStorage` 加密全局配置（`config/mcp.json`）、只读项目配置发现（`.pi-workbench/mcp.json` / `.mcp.json`）与 SHA-256 指纹 fail-closed 信任（`config/mcp-trust.json`），贯通 Agent `utilityProcess`、云端派活工单 worktree 与设置页 `McpSettings`；云端落地 SQLite v3 `mcp_servers` 表（AES-256-GCM 加密）、`/v1/mcp*` REST（含 CSRF 与掩码保留）、支持远程 HTTP/SSE 与云主机本地 `stdio`（`pi-cloud.service` 增加 `ReadOnlyPaths=-/opt/pi-cloud/mcp`）、轮次边界重载与共享 `@pi-workbench/cloud-ui` `CloudMcpManager`（Web 控制台与桌面 `CloudView` 双端同步管理）。
- 2026-11-28 **Phase A–E 全面架构升级与 59 项纯 Bug 修复**：完成 59 项纯代码 Bug 修复（5 commits）；完成 Phase A（安全边界与自动缓存清理、云端首启口令/SQLite 关系化与记忆入库、锁全量传递依赖不可变发布）、Phase B（Cloud Web 减重至 8.11 MiB + br/gzip、后台工作区休眠不中断 Agent、面板宽度持久化、错误 Toast 8s 暂停与 Paper & Ink `≥ 12px`）、Phase C（`fflate`+`saxes`、`https/socks-proxy-agent`、`chokidar` v4、Monaco `createDiffEditor`+`fast-diff`、`web-tree-sitter`、`@base-ui/react`+`@floating-ui/react`+`cmdk` 6 大替换）、Phase D（Zustand v5、`@pi-workbench/{ui,i18n,cloud-ui}` 统一与 Cloud Web 英文支持、单源 Typed IPC、`AgentManager`/`ChatPanel` 拆解、`eslint --max-warnings 0` 与 Playwright `_electron` 冒烟 E2E）及 Phase E（Agent 与插件 `utilityProcess` 进程隔离 + 直连 `MessagePort`、原生多 `BrowserWindow` 拆窗与 Q5 托盘/回位语义，修订 ADR-001）；199 文件 2,062 单测与本地/打包版 Electron E2E 全绿。

- 2026-11-27 **D-01 严格两目录模型 + Windows 安装版/便携版双发行包**：三平台打包版统一采用「程序安装目录 + 唯一数据目录 `<appData>/pi-workbench`」（更新缓存同步收口到 `{dataDir}/cache/pi-workbench-updater/`，彻底消除 `%LOCALAPPDATA%` 第 3 目录）；新增旧版安装目录同步无损迁移（`migrateLegacyInstallDirSync`）与设置页「打开数据目录」（`app:openDataDir`）；`build/installer.nsh` 瘦身移除 244 行清单卸载脚本与 `afterPack` manifest 脚本；新增 `scripts/build-win-portable.mjs` 与 `release.yml` Windows 便携 `.zip`（根级 `portable` 标记，引导手动更新不跑 NSIS）并修正 `release.yml` 构建测试顺序。
- 2026-11-27 **Phase 0–2 深度审计整改与架构演进（安全止血 + 前端/云端瘦身 + 架构与工程治理升级）**：完成全仓 12 项 P0 安全封堵与数据防丢修复；完成云端 `node:sqlite` (WAL) 持久化迁移、`packages/cloud-ui` 共享包抽离与前端/产物瘦身；完成 Phase 2 全部既定里程碑——剩余并发/插件哈希/云端记忆与梦境回滚加固、`electron/documents/*` 与 `repo-map.ts` 迁入 `worker_threads` + 热路径异步化、`AgentManager` 按域拆分 + `pi-bridge/src/session-view.ts` 单一聊天渲染投影（持久化 `entryId` + 轮末自愈 + 多步聚合 `usage`）、高危 IPC 与云端 WS 协议 Zod 校验与能力协商、Windows/Linux 原生 `titleBarOverlay`（恢复 Win11 Snap Layouts）+ 取消 1 秒启动形变 + `prefers-reduced-motion` + A11y / `RepoMapCanvas` / 前端虚拟化优化、ESLint `jsx-a11y` + 跨包边界 + AST 色值门禁、全仓 `src/components/`（10 域）与 `tests/`（6 域）按业务域重组，以及 `DESIGN_SYSTEM.md` 瘦身与文档同步（便携目录 `D-01` 与托管工作树位置 `D-02` 按所有者要求保留待单独讨论）。
- 2026-11-26 **C-03 云端 Agent P1 功能簇（全部落地并上线验证）**：落地脱敏结果 diff 回传（终端 `collectTaskDiff` 排除敏感/二进制/锁文件、命中密钥脱敏、按 32KB/128KB 上限裁剪，云端 `get_task({ includeDiff: true })` 按需拉取，不推 UI / 不塞 `done` 唤醒帧）；落地多端已读未读同步（F-52，`mark_read` / `POST /v1/read` / `read_state` 广播，Web 标题与标签角标 + 桌面端状态栏角标 + 托盘 Tooltip / `setBadgeCount` / Windows `setOverlayIcon`）；落地云端持久记忆（`${dataDir}/memory/`，`session_before_compact` 压缩前自动抽取、`before_agent_start` 预算内 Top-K 注入、空闲 30m 梦境整理与手工记忆硬保护、白名单留存文档 `AGENTS.md` / `SOUL.md` 在 Web 与桌面端透明可查可编辑，覆盖 A-25）；打磨运行中/提问中工单 `task_message` 直达追加指令与终端确认里程碑，并补齐并发压测（10 设备 20 工单并发上限 8 + FIFO 补发、配额原子防超发、220 事件风暴重连补齐），同时修复并发 `tryDispatch` 落盘与极速回包的竞态。
- 2026-11-26 **P-05 & P-07（SDK 实测收口与探测修复 + models.dev 独立富数据）**：实测 8 家 `/models` 端点（全部存在；修复桌面端对 Google / xAI 无效 Key 返回 HTTP 400 的误放行并避免误判地区受限）、核实并单测钉住 `clampMaxTokensToContext` 边界与 `openai` 粘贴回调解析；落地完全解耦于 Pi catalog 的 `models.dev` 富数据模块与 `cache/models-dev.json`（ETag / 12h TTL / `PI_OFFLINE` 与失败静默降级），在供应商设置页展示模型价格、多模态、知识截止、发布时间、开源权重与废弃状态。
- 2026-11-26 **C-01 云端 Agent（P0 部署与真派活闭环验收完成）**：最新版本（含 0.11.0 预设供应商、C-02/C-04/C-05/C-06/C-07/P-09 与授权提示增强、Key 探测报错透出、Web 重渲染模型下拉修复）部署至自托管云端实例，本地自包含包 35/35 + 30 个云端测试文件 211/211 全绿；线上完成真实 Google 模型对话、配对、确认授权、隔离 worktree 派活执行、里程碑实时唤醒、结果汇报、干净工作树自动回收、服务重启重连与安全/真相源隔离全项复核。
- 2026-11-26 **C-02 & C-07（工单停滞看门狗 + 全站并发上限 + F-23 语义对齐）**：落地终端工具 10 分钟无输出增量上报 `task_stalled`（同一停滞只报一次）、工单运行期 60 s `task_heartbeat`（刷新设备活跃但不洗白静默计时）、云端 20 分钟无事件主动唤醒巡检；落地全站并发上限（默认 8，超出排队提示并在终态按 FIFO 补投，A-21 / D-15）；将需求 F-23 / A-10 对齐到非阻塞 `ask_cloud` 实现并补齐单测。
- 2026-11-26 **P-04 / P-06 / P-10（模型目录跟随开关、来源展示与凭证提示）**：新增 `autoRefreshCatalog` 设置项与 `PI_OFFLINE` 总开关，统一接入主进程与工单执行器；`providers:list` 透出目录 `source`（`remote` / `bundled`）与更新时间；设置页增加自动更新开关、远端/内置快照与下架移除说明，以及 `openai` / `openai-codex` 独立凭证说明。
- 2026-11-26 **P-09 & C-06（云端汇报/守卫收口 + 回收竞态修复）**：修复 `CloudTaskRunner.runStart()` 准备期失败先发帧再清 `starting` 导致的 `closeUnit` 偶发竞态；落地改动清单 `attention` 分组与 diff 疑似密钥扫描（只报位置不打印值，F-36 / A-29）、工单 worktree 独立 `pre-push` hook（`extensions.worktreeConfig` 隔离主工作树，D-32 / A-44）、重连快照「你离开期间…」离线汇总（F-51 / A-23）、桌面端状态栏与 Web 顶栏细化指示器与停止入口（4.6 / A-08）。
- 2026-11-26 **R-23 输出预算与截断**：0.7.7–0.7.9 落地截断报错、用量拆分、历史防污染与上限下调；0.11.0 升 Pi SDK 1.3.0 与切官方 catalog 后，自动压缩留白（`reserveTokens`）、`isRecoverableLength` 单次压缩重试、压缩摘要预算、标题 512 token 预算与 `thinkingFormat` / `reasoning_effort` 已全部原生覆盖；补齐溢出压缩重试联动回归并修复看门狗挂载时序。
- 2026-11-22 **解绑识别 / 重连对账 / 桌面端授权入口**（F-08 · A-15 · A-13 · A-41 · F-21 · D-11 · F-16 / F-17 / F-18）：升级阶段 401 → `revoked` 并停止重连 + 桌面端「解除配对」；`hello` 带 `runningTasks`，服务端对已落终态 / 孤儿工单回 `task_cancel`（终端不再把已取消的活干完）；桌面端补 `confirm_plan` 入口。同类小修：工单 agentDir 的 `compaction` 参数、systemd `LimitNOFILE`。
- 2026-11-21 **C-04 / C-05**：云端配置轮换在轮次边界生效（F-13 / A-16）· 工作单元工作树回收（F-19a / G12 / A-42 / A-43 / A-46：干净即自动回收、脏树保留手动）。
- 2026-10-23 ~ 10-31 经项目所有者手动验收：R-03 分支切换 · R-04 结构化计划 · R-05 压缩分隔线 · R-06 模型能力提示 · R-08 图片附件 · R-09 `path:line` 跳转 · R-10 三格式导出 · R-13 模板与技能 · R-15 空状态建议 · R-16 子 Agent 活动 · R-19 重试倒计时 · R-20 工具结果查看器 · R-21 任意位置 / 格式附件（只给路径）· R-22 PDF / Office 可读与只读预览。
- 已移除：R-02 排队消息跨重启持久化（2026-10-28 项目所有者决定，排队消息只存内存）。
- 已移除：云端 Agent 的 Hermes 实现（0.8.0–0.9.1，2026-11-11 决定换 Pi 内核，代码与文档整体移除）。

## 3. 平台验收（发布前）

- **V-01 macOS（universal dmg）** 覆盖：安装与首次启动、通知权限申请、通知点击前置、文件树刷新、终端、自动更新的「检查后引导下载」。记录：系统版本、是否签名（当前未签名，需手动覆盖安装）、失败截图。
- **V-02 Linux（AppImage）** 覆盖：便携目录写权限、通知服务（依赖桌面环境）、文件树刷新、终端、自动更新。记录：发行版与桌面环境、是否需要额外依赖。

## 4. 已决定不做（保留备查）

- **2026-11-28 项目所有者决定**：`F-01` 远端工单可选 OS/Docker 沙箱不做。理由：本地自托管工单已运行在受信任工作区独立 git worktree 并配有 `task-guard` 与工具/权限护栏，叠加 OS/Docker 沙箱会显著抬高跨平台部署、依赖缓存与容器维护门槛且收益不成正比；Phase F 聚焦于全栈统一 MCP 接入（已同日交付）。
- **2026-11-26 项目所有者决定**：P-08 自建 OAuth 应用（用自己域名做回调）暂不做。理由：需向各家厂商逐个申请审批第三方 `client_id` 与回调域名（部分厂商不对第三方开放自助申请），且 `@earendil-works/pi-ai` 不暴露 `client_id` 覆写，继续复用 SDK 内置 OAuth。
- **2026-10-24 项目所有者决定**：R-07 成本对比与预算细化 · R-11 通知安静时段与阈值 · R-12 消息间键盘导航 · R-14 全量快捷键自定义 · R-17 插件面板级 UI / 菜单 / 状态项 · R-18 符号选择改用语言服务（维持正则实现）。
- **2026-11-08 项目所有者决定**：顶层 Agent 跨工作区编排（首页常驻顶层会话 + 派发子会话 + 委派授权 + headless 工作区）不做。理由：编排带来的复杂度在于授权、预算与工作区隔离，而单机工作台的跨工作区需求已能用「多工作区常驻视图 + 工作树会话」直接覆盖。原需求草案（`TOP_LEVEL_AGENT.md` / `TOP_LEVEL_AGENT_BRIEF.md`）已删除，恢复看 `git log`。
- **2026-11-11 项目所有者决定**：云端 Agent 不再建立在第三方 Agent（Hermes）之上，改为以 Pi Agent 为基础自维护的常驻服务；旧的桌面端云端层、网关插件与派活实现整体移除，不做双轨。
- **更早的边界**：B-02 脱敏 thinking 占位（取决于供应商是否返回 `redacted`）· B-03 旧会话过程轨迹补造（无 `parts` 的旧会话按普通文本显示）· 转 DSH 内核（2026-10-23 放弃）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-28
