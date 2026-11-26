# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.11.1**（2026-11-26） |
| 阶段 | 本地 Agent 工作台稳定期；模型配置改为 8 家固定供应商 + OAuth（0.11.x）；云端 Agent 已部署运行，剩 P1/P2 待办 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程） |
| 质量门槛 | `type-check` · `lint` · `npm test`（171 文件 / 1724 用例）· `design-system` 全绿 |
| 云端 Agent | **P0（C-01）与 P1（C-02 ~ C-07 / P-09）全部落地**：`https://tchen-xiaoxiao.com`（systemd + Caddy + `pi-warp-proxy` + 每日备份），支持脱敏 diff 按需审查、多端已读未读同步与托盘角标、压缩前记忆抽取 + 梦境整理 + `AGENTS.md`/`SOUL.md` 双端可视化编辑、运行中工单 `task_message` 追加指令；剩余仅 P2（`P-02` 云端 OAuth 登录） |

## 正在做 / 下一步

- **供应商预设的真实凭证手工验收**（[BACKLOG](./BACKLOG.md) P-03）：0.11.0 发布时未执行，需补 8 家 API Key、4 条 OAuth、容量下调在轮次边界生效、会话模型静默回落各一次。
- **云端 OAuth 登录**（[BACKLOG](./BACKLOG.md) P-02，P2）：4 条 OAuth 路径接入云端配置页。
- **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）尚未做。

## 已交付（一行一项，细节在 git）

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已整体移除**（代码与文档都不在仓库里，需要考古看 `git log`）。
- **0.11.1**：新增「使用系统代理」热生效开关（主进程 `globalThis.fetch` 按开关走 Electron `net.fetch`）；修复远端模型目录缓存未加载与 D12/D26 下架过滤、配置校验放行远端新增模型，修正 Google（`x-goog-api-key`）与 Anthropic（`/v1/models`）Key 探测；合入 0.11.0 后 17 项安全边界、拆窗/终端流、pi-bridge 运行时与云端会话登出加固。
- **0.11.0**：模型配置改为固定供应商预设——8 家内置 provider（OpenAI / Anthropic / Google / xAI / DeepSeek / 小米 MiMo / 小米 Token 套餐 / OpenAI Codex），模型能力与协议来自 Pi catalog（内置快照 + pi.dev 增量），凭证改为 `config/credentials.json`（safeStorage）并支持 OAuth 登录（浏览器回调 / 设备码 / 粘贴回调地址），容量可按模型向下调且轮次边界生效；删除自定义端点链路（`apiConfig:*` IPC、dev 代理、`model-capabilities`），旧 `api-config.json` 首启迁移并归档 `.legacy`。
- **0.10.0**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划扩展保留，供下一代云端服务复用；升级首启清掉旧版留下的凭据类残留（`electron/legacy-cleanup.ts`，幂等 + 失败可重试）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-26（0.11.1 发版）
