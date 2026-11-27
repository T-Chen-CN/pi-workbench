# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.11.2+**（2026-11-27，Phase 0–2 深度整改在 main 就绪） |
| 阶段 | 本地 Agent 工作台与云端 Agent 完成安全止血、性能瘦身、SQLite / 共享 UI / Worker / Zod / 单一聊天投影 / 原生标题栏 / 按域目录重组与工程门禁升级 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 + Zod 4 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程；重 CPU 非 Agent 解析走 `worker_threads`） |
| 质量门槛 | 全仓 7 份 `type-check` · `lint`（含 `jsx-a11y` / 跨包边界 / AST 色值）· `npm test`（179 文件 / 1815 用例）· `design-system` · `build` / `build:cloud` 全绿 |
| 云端 Agent | **P0（C-01）与 P1（C-02 ~ C-07 / P-09）全部落地，已迁至 Node 24 `node:sqlite` (WAL) + `packages/cloud-ui` 共享包 + Zod 协议校验与能力协商**；剩余仅 P2（`P-02` 云端 OAuth 登录） |

## 正在做 / 下一步

- **供应商预设的真实凭证手工验收**（[BACKLOG](./BACKLOG.md) P-03）：0.11.0 发布时未执行，需补 8 家 API Key、4 条 OAuth、容量下调在轮次边界生效、会话模型静默回落各一次。
- **架构待单独讨论项**（[BACKLOG](./BACKLOG.md) `D-02`）：托管工作树存放位置（当前保持仓库内 `.pi-workbench/worktrees/`）。
- **云端 OAuth 登录**（[BACKLOG](./BACKLOG.md) P-02，P2）与 **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）。

## 已交付（一行一项，细节在 git）

- **D-01 两目录模型与便携 zip（2026-11-27）**：统一「程序安装目录 + `<appData>/pi-workbench` 唯一数据目录」（含更新缓存收口与旧安装目录无损迁移）、瘦身 `build/installer.nsh` 并移除 `installer-manifest` 脚本、设置页新增「打开数据目录」，Windows 发布同时产出 Setup `.exe` 与免安装 Portable `.zip`。
- **Phase 0–2 深度整改（2026-11-27）**：完成 12 项 P0 安全漏洞与数据防丢止血；完成前端瘦身、`packages/cloud-ui` 共享包抽离与云端 `node:sqlite` 持久化；完成 `worker_threads` 文档/地图卸载、`AgentManager` 拆分与 `deriveMessages` 单一聊天渲染投影、Zod IPC/云端协议校验与能力协商、原生 `titleBarOverlay` + 取消启动形变 + A11y / `RepoMapCanvas` / 虚拟化优化、ESLint `jsx-a11y` + 边界/AST 规则、全仓 `src/components/` 与 `tests/` 按域目录重组及 `DESIGN_SYSTEM.md` 瘦身。

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已整体移除**（代码与文档都不在仓库里，需要考古看 `git log`）。
- **0.11.2**：云端 Agent 全面进阶（P0 真派活闭环 + P1 全部落地：脱敏 diff 按需审查、多端已读同步与托盘角标、持久记忆压缩前抽取 / 梦境整理 / `AGENTS.md` 与 `SOUL.md` 双端可视化编辑、运行中工单直发追加指令、停滞看门狗与全站并发上限 8、改动清单 `attention` 分组与密钥位置告警、工单 worktree 独立 `pre-push` 守卫、离线期汇报汇总）；供应商设置接入独立 `models.dev` 富数据与目录自动刷新 / `PI_OFFLINE` 开关，修复 Google / xAI 无效 Key 400 误判；补齐压缩进行中状态与压缩期排队、上下文覆写同步已有会话与高并发派单竞态修复。
- **0.11.1**：新增「使用系统代理」热生效开关（主进程 `globalThis.fetch` 按开关走 Electron `net.fetch`）；修复远端模型目录缓存未加载与 D12/D26 下架过滤、配置校验放行远端新增模型，修正 Google（`x-goog-api-key`）与 Anthropic（`/v1/models`）Key 探测；合入 0.11.0 后 17 项安全边界、拆窗/终端流、pi-bridge 运行时与云端会话登出加固。
- **0.11.0**：模型配置改为固定供应商预设——8 家内置 provider（OpenAI / Anthropic / Google / xAI / DeepSeek / 小米 MiMo / 小米 Token 套餐 / OpenAI Codex），模型能力与协议来自 Pi catalog（内置快照 + pi.dev 增量），凭证改为 `config/credentials.json`（safeStorage）并支持 OAuth 登录（浏览器回调 / 设备码 / 粘贴回调地址），容量可按模型向下调且轮次边界生效；删除自定义端点链路（`apiConfig:*` IPC、dev 代理、`model-capabilities`），旧 `api-config.json` 首启迁移并归档 `.legacy`。
- **0.10.0**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划扩展保留，供下一代云端服务复用；升级首启清掉旧版留下的凭据类残留（`electron/legacy-cleanup.ts`，幂等 + 失败可重试）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-27（Phase 0–2 整改完成）
