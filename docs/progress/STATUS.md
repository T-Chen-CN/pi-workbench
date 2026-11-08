# 项目状态

> **面向**：想知道「现在做到哪一步」的人与 agent
> **什么时候读**：每次开工前
> **任务与待办**：[BACKLOG](./BACKLOG.md)（唯一任务表）
> **本文件不含条目列表，也不记历史**：历史看 `git log` 与 [Release 页](https://github.com/T-Chen-CN/pi-workbench/releases)

## 当前

| 项 | 值 |
| --- | --- |
| 版本 | **0.8.0**（2026-11-08） |
| 阶段 | 云端 Agent 主链路已完成并发布；Phase 6 持续优化 |
| 技术栈 | Electron 44 + React 19 + TypeScript 5.9 + Vite 5 + Zustand 4 + Tailwind 3 + Monaco 0.57 |
| Agent SDK | `@earendil-works/pi-coding-agent` 1.3.0（跑在主进程） |
| 质量门槛 | `type-check` · `lint` · `npm test`（152 文件 / 1817 用例）· `design-system` 全绿 |
| 网关插件 | `pi-workbench-gateway` **0.1.1**（独立公开仓库，已真机上线） |

## 正在做 / 下一步

- **云端事件通知已接进系统通知**（审批 / 澄清 / 终态，点击定位到卡）；下一步候选见 [BACKLOG](./BACKLOG.md) §6。
- **R-23 剩余子项**：B4 续写截断的后续动作、B7 上下文临界预警、B8 轻任务预算、`reasoning_effort` 联动——见 [BACKLOG](./BACKLOG.md) §3。
- **平台手动验收** V-01（macOS dmg）/ V-02（Linux AppImage）尚未做。
- **云端后置**：C-08 CDP 屏幕接管 → C-09 Kanban → C-10 拆窗 → C-11 IM / 语音 / 遥测 → C-12 对外写 MCP 门；H3 工作区派活单独立项。见 [CLOUD_AGENT §9.4](../requirements/CLOUD_AGENT.md)。

## 已交付（一行一项，细节在 git）

- **v0.1 ~ v0.7.9**：本地 Agent 工作台——编辑器 / 会话与分支 / 终端 / Git 与工作树 / 阅读视图 / 面板拆窗 / 托盘常驻 / 自动更新与三平台发布。
- **v0.8.0**：云端 Agent——一次性连接码配对、会话与 SSE、审批闭环、内嵌控制台、任务与媒体，全部经自建网关插件（含设备身份、心跳、审计、`fsguard`）。
- **0.8.0 之后（未发版）**：云端审批 / 澄清 / 终态接进系统通知，点击直落那张卡；`hub.` 插件 0.1.1（白名单撤掉 `fork`）；云端验收结项（AC-14 Hermes 0.22.6→0.23.0 保留数据、AC-15 出网、AC-19 反代穿透，2026-11-08 真机通过）。
- **云端并行**：不同会话可各跑一轮（上限 2）；每帧带会话归属，切走的那轮在后台继续，会话行标「有轮次在跑」。
- **已知边界**：Hermes 0.23 的 gateway 多路复用（`hermes gateway migrate --multiplex`）**暂时不能用** —— 宿主进程不读 profile 的 `.env`、也不起 profile 的 api_server，插件会变成没有管理密钥、没有上游的空壳（2026-11-08 实迁后当场回滚，配方见 [CLOUD_AGENT §7.5](../requirements/CLOUD_AGENT.md)）。

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-08
