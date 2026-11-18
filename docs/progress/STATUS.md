# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.9.1** 已发布；主线在 0.10.0（云端 Agent 移除） |
| 阶段 | 本地 Agent 工作台稳定期；云端 Agent 换内核（Pi）尚未开工 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程） |
| 质量门槛 | `type-check` · `lint` · `npm test`（130 文件 / 1402 用例）· `design-system` 全绿 |
| 云端 Agent | **Hermes 实现已于 0.10.0 移除**（代码 / 文档 / 网关插件）；替代方案见 [CLOUD_AGENT_LESSONS](../archive/CLOUD_AGENT_LESSONS.md) |

## 正在做 / 下一步

- **云端 Agent 换内核**：以 Pi Agent 为基础自维护的常驻服务，方案未定稿（见 [BACKLOG](./BACKLOG.md) 的 C-01）；旧实现的全部结论已归档，动手前必读。
- **R-23 剩余子项**：B4 续写截断的后续动作、B7 上下文临界预警、B8 轻任务预算、`reasoning_effort` 联动——见 [BACKLOG](./BACKLOG.md) §3。
- **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）尚未做。

## 已交付（一行一项，细节在 git）

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0 ~ v0.9.1**：云端 Agent 的 Hermes 实现（配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体、云端工作区派活 H3），**已在 0.10.0 整体移除**：代码在 `legacy/cloud-hermes-0.9.1` 标签与 `archive/cloud-hermes` 分支，结论在 [archive/CLOUD_AGENT_LESSONS](../archive/CLOUD_AGENT_LESSONS.md)。
- **0.10.0（未发布）**：移除云端 Agent 的桌面层 / 派活 / 网关插件 / 相关文档与文案，主线只保留本地 Agent 能力；`electron/approval-broker.ts` 与 pi-bridge 的审批 / 计划 / 反问扩展保留，供下一代云端服务复用。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-11
