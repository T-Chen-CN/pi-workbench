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
| 质量门槛 | `type-check` · `lint` · `npm test`（168 文件 / 1694 用例）· `design-system` 全绿 |
| 云端 Agent | **P0 代码 + 部署已落地并在线上运行**：`https://tchen-xiaoxiao.com`（systemd + Caddy + 每日备份，release 软链可回滚），`/v1/health` 返回 `ok/hasAccount/ready` 全为 true（账号与云端模型配置已就位），公网自检 34/34；**2026-11-22 补丁**：解绑识别（A-15）、重连对账（A-13/A-41）、桌面端「确认方案并授权」入口（D-11）、工单压缩参数与 `LimitNOFILE`；**2026-11-26 收口**：C-06（改动清单 `attention` 分组、diff 密钥扫描、离线期汇报、状态栏/Web 细化指示器与停止入口、工单 worktree 专属 `pre-push` hook）、C-02（工单停滞看门狗）与 C-07（全站并发上限与 F-23 对齐）。剩真派活人工走查 + 重新部署 + P1 待办（C-03） |

## 正在做 / 下一步

- **云端 Agent（开发调度）P0**：需求 v3.3（[CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md)），实现与运维见 [cloud-agent](../agent/cloud-agent.md)。已完成：PR1 内核注入点（扩展可剔除 / 工具白名单 / 权限入参 / 常驻 trace / 压缩前钩子）、PR2 协议契约、`apps/cloud`（控制面 + 双 WS + 单会话 + 六工具 + 状态机 + 事件唤醒）、终端执行器（G6/G7/G8/G10/G12 + `ask_cloud`）、桌面端云端页与状态栏指示器、Web 完整客户端、运维件（systemd / Caddy / 每日备份 / 自包含打包脚本）。**已部署**：`tchen-xiaoxiao.com`（Caddy → 127.0.0.1:8787、`/opt/pi-cloud` 多版本软链、每日备份、开机自启）；`apps/cloud/scripts/acceptance.mjs` 公网 34/34 通过。**2026-11-21 两项 P0 口子已修**（C-04 配置轮换在轮次边界生效；C-05 工作单元工作树回收：干净即自动回收、脏树保留手动，含启动兜底），见 [BACKLOG](./BACKLOG.md) §2 已交付。**2026-11-22 补齐**：换配前先探测供应商 `/models`（错 Key 不再谎报已生效、旧运行时不被拆）；终端收单先回 `assigned` 且准备阶段失败也报 `worktreeClean`（否则工单永远挂在执行中、工作树漏回收）；客户端首包顺序修正（快照不会被事件抢先）；**解绑识别**（升级阶段的 401 转成 `durableStop` + `revoked`，不再无限重连，并新增桌面端「解除配对」）；**重连对账**（`hello` 带 `runningTasks`，服务端对已落终态 / 孤儿工单回 `task_cancel`，终端不再把已取消的活干完）；**桌面端「确认方案并授权」入口**（此前只有 Web 能授权，桌面端派不出活）。**待重新部署**：上表那四项与 C-06 / C-02 / C-07、`LimitNOFILE` 属代码变更，生产环境还停在 `20261122163607` 那一版（回滚点 `20261122022111`）。剩余待办：① 真派活闭环人工走查（A-19/A-20/A-21，需真实供应商 Key）；② P1 项（C-03，含 A-25）。
- **供应商预设的真实凭证手工验收**（[BACKLOG](./BACKLOG.md) P-03）：0.11.0 发布时未执行，需补 8 家 API Key、4 条 OAuth、容量下调在轮次边界生效、会话模型静默回落各一次。
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
