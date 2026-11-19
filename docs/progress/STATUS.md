# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.10.0**（2026-11-11） |
| 阶段 | 本地 Agent 工作台稳定期；云端 Agent 换内核（Pi）尚未开工 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程） |
| 质量门槛 | `type-check` · `lint` · `npm test`（131 文件 / 1407 用例）· `design-system` 全绿 |
| 云端 Agent | **旧实现（Hermes）已整体移除**；替代方案（Pi 内核 + 工单级委派）**需求 v3.2 与部署基线均定稿**，开工前置 PoC（V1 双实例并发 / V2 压缩前历史）**已于 2026-11-20 跑通**，未开工 |

## 正在做 / 下一步

- **云端 Agent（开发调度）**：需求 v3.2 定稿（[CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md)），服务器基线已验证，未开工。方向：云端只做调度 + 汇报（无 `fs` / `bash`），终端执行，工单级委派；三端可见（桌面端独立云端页 + Web 完整客户端），云端**单会话** + 记忆 / 知识库 / 梦境维护长内容；服务器 `43.160.211.128`（Ubuntu 26.04 · Node 24 · Caddy + systemd），WS 往返 p50 ≈ 54 ms。P0 约 27 人日（PoC 已花 0.5，剩 ≈ 26.5），开工前需补 §4.0 的 G1–G3、G6–G12（G5 已取消）；**V1/V2 PoC 已于 2026-11-20 通过**（双实例并发 30 轮互不干扰、一实例 `dispose` 不打断另一实例回合、`session_before_compact` 拿到完整 `branchEntries`，`process.env` Key 串写已实测确认为硬约束），见[实测报告](../reports/cloud-agent-poc-verification-2026-11-20.md)。
- **R-23 剩余子项**：B4 续写截断的后续动作、B7 上下文临界预警、B8 轻任务预算、`reasoning_effort` 联动——见 [BACKLOG](./BACKLOG.md) §3。
- **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）尚未做。

## 已交付（一行一项，细节在 git）

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已整体移除**（代码与文档都不在仓库里，需要考古看 `git log`）。
- **0.10.0**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划扩展保留，供下一代云端服务复用；升级首启清掉旧版留下的凭据类残留（`electron/legacy-cleanup.ts`，幂等 + 失败可重试）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-11
