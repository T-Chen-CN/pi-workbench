# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.10.0**（2026-11-11） |
| 阶段 | 本地 Agent 工作台稳定期；云端 Agent P0 代码落地，待服务器部署与公网验收 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程） |
| 质量门槛 | `type-check` · `lint` · `npm test`（143 文件 / 1532 用例）· `design-system` 全绿 |
| 云端 Agent | **P0 代码 + 部署已落地**：`https://tchen-xiaoxiao.com`（systemd + Caddy + 每日备份，release 软链可回滚），公网自检 32/32 通过；剩「用户建号 + 推模型配置」与真派活人工走查 |

## 正在做 / 下一步

- **云端 Agent（开发调度）P0**：需求 v3.2（[CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md)），实现与运维见 [cloud-agent](../agent/cloud-agent.md)。已完成：PR1 内核注入点（扩展可剔除 / 工具白名单 / 权限入参 / 常驻 trace / 压缩前钩子）、PR2 协议契约、`apps/cloud`（控制面 + 双 WS + 单会话 + 六工具 + 状态机 + 事件唤醒）、终端执行器（G6/G7/G8/G10/G12 + `ask_cloud`）、桌面端云端页与状态栏指示器、Web 完整客户端、运维件（systemd / Caddy / 每日备份 / 自包含打包脚本）。**已部署**：`tchen-xiaoxiao.com`（Caddy → 127.0.0.1:8787、`/opt/pi-cloud` 多版本软链、每日备份、开机自启）；`apps/cloud/scripts/acceptance.mjs` 公网 32/32 通过。**待办**：① 项目所有者建管理员账号并从 Web 控制台推模型配置；② 真派活闭环人工走查（A-19/A-20/A-21，需真实供应商 Key）；③ P1 项（记忆抽取 / 梦境 / 已读未读 / diff 回传 / 托盘角标，A-25）。
- **R-23 剩余子项**：B4 续写截断的后续动作、B7 上下文临界预警、B8 轻任务预算、`reasoning_effort` 联动——见 [BACKLOG](./BACKLOG.md) §3。
- **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）尚未做。

## 已交付（一行一项，细节在 git）

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已整体移除**（代码与文档都不在仓库里，需要考古看 `git log`）。
- **0.10.0**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划扩展保留，供下一代云端服务复用；升级首启清掉旧版留下的凭据类残留（`electron/legacy-cleanup.ts`，幂等 + 失败可重试）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-21
