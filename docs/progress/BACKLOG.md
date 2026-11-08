# 任务清单（Backlog）

> **面向**：要挑下一个任务的人与 agent
> **唯一任务表**：所有待办、平台验收、"已决定不做"都在本文件；想知道某件事做了没，也只查这里。
> **什么时候改**：新增 / 关闭 / 范围变化。完成项在 §2 只留一行，实现细节交给 `git log` 与 Release 页。
> **相关**：[项目状态](./STATUS.md)（一页快照）· [云端 Agent 方案](../requirements/CLOUD_AGENT.md) · [设计系统](../design/DESIGN_SYSTEM.md)

---

## 1. 维护规则

- 完成一项：§2 状态改 ✅ 并写日期，正文条目删除（细节查提交与 Release 说明）。
- 编号不复用；放弃的移到 §5，并写清为什么。
- 发版前提：三平台 CI 绿、没有未完成的 P0 / P1 项、真实供应商冒烟通过。

## 2. 总览

### 未完成

| ID | 项目 | 优先级 | 状态 |
| --- | --- | --- | --- |
| R-23 | 输出预算与截断的完整处理（详见 §3） | P0 | 🟡 部分完成（2026-11-06） |
| V-01 | macOS 手动验收（universal dmg） | 发布前 | ⬜ 未做 |
| V-02 | Linux 手动验收（AppImage） | 发布前 | ⬜ 未做 |
| C-08 ~ C-12 | 云端后置：屏幕接管 / Kanban / 拆窗 / IM / 对外写 MCP 门 | 后置 | ⬜ 未排期 |
| H3 | 云端工作区派活（`local_*` 工具 / 任务邮箱） | P1–P3 | ✅ 全部落地（插件 0.3.1 + 桌面）并真机验收：急停 / 云端取消 / 幂等 / 断线重放 / 本地反问 / 租约重投 / 重连接回 / A2A 端点 / 轨迹可查。不做清单（push webhook、强提醒、逐条直播、跨设备重投）见 §10 —— [WORKSPACE_DISPATCH](../requirements/WORKSPACE_DISPATCH.md) §15 |

### 已交付（只留一行，细节在 git）

- 2026-10-23 ~ 10-31 经项目所有者手动验收：R-03 分支切换 · R-04 结构化计划 · R-05 压缩分隔线 · R-06 模型能力提示 · R-08 图片附件 · R-09 `path:line` 跳转 · R-10 三格式导出 · R-13 模板与技能 · R-15 空状态建议 · R-16 子 Agent 活动 · R-19 重试倒计时 · R-20 工具结果查看器 · R-21 任意位置 / 格式附件（只给路径）· R-22 PDF / Office 可读与只读预览。
- 已移除：R-02 排队消息跨重启持久化（2026-10-28 项目所有者决定，排队消息只存内存）。

## 3. R-23 输出预算与截断的完整处理 🟡

**现状**：`length`（输出撞上限）已不再落进成功分支，也不再写占位文案；剩下的是"防"与"续写后续动作"两头的收尾。

**已做**（0.7.7 ~ 0.7.9，详见 `agent-runtime` §6）：

- 检：`stopReason === 'length'` 单独分支，`success:false` + `errorCode`（`output-truncated` / `empty-response`）+ `outputLimit`。
- 呈现：两类文案分开（有正文被切 / 只有思考）；`AgentUsage.reasoning` 透出，气泡显示「思考 N」。
- 修：空正文不进 `runtime.messageHistory`；catalog 退回供应商硬上限，推荐值交给档位。
- 档位：设置页「输出上限」下拉（自动 / 16K / 32K / 64K / 128K / 256K），落 `api-config.json` 的 `maxTokens`；三层归一化（渲染层 / 主进程 / bridge）必须同步改。
- **刻意不做**：自动提升上限重试、降低思考强度——出问题就如实报错。

**剩余子项**：

- **B4（修）** 区分「可续写截断」与「确定性截断」的后续动作（现在两者都只报错）。
- **B7（防）** 长上下文下 `clampMaxTokensToContext` 压到临界值时提前提示。
- **B8（防）** 标题生成、压缩摘要等轻任务单独预算或关思考。
- **B9（回归）** 补 SDK 自动压缩重试的联动用例（现有四组：`length + thinking-only`、`length + 部分正文`、空正文不落 history、`usage.reasoning`）。
- **思考强度 ↔ 预算联动** 接 `reasoning_effort`（DeepSeek 支持 `none/low/high/max`），让档位驱动思考深度而不只是调 `max_tokens`。当前 `model-config.ts` 生成的模型对象没有 `compat.thinkingFormat`，`openai-completions.js:670` 的 deepseek 分支从不执行。

**关键事实**：pi-ai 的 `buildBaseOptions`（`simple-options.js:26`）强制 `options?.maxTokens ?? model.maxTokens`，**请求体永远带 `max_tokens`**——「不传、让供应商决定」在现有 SDK 下不可行；唯一绕过点是 `onPayload`（`openai-completions.js:188`），但 pi-bridge 未暴露。

**参考**：OpenRouter Reasoning Tokens（`max_output_tokens` 必须大于思考预算）· OpenAI `incomplete_details.reason=max_output_tokens` · AWS Bedrock 扩展思考（`budget_tokens < max_tokens`）· vLLM `thinking_token_budget` · oh-my-pi #2774（确定性截断不重试、抛可操作错误）· AstrBot #9035（空壳入历史导致 400）。

## 4. 平台验收（发布前）

- **V-01 macOS（universal dmg）** 覆盖：安装与首次启动、通知权限申请、通知点击前置、文件树刷新、终端、自动更新的「检查后引导下载」。记录：系统版本、是否签名（当前未签名，需手动覆盖安装）、失败截图。
- **V-02 Linux（AppImage）** 覆盖：便携目录写权限、通知服务（依赖桌面环境）、文件树刷新、终端、自动更新。记录：发行版与桌面环境、是否需要额外依赖。

## 5. 已决定不做（保留备查）

- **2026-10-24 项目所有者决定**：R-07 成本对比与预算细化 · R-11 通知安静时段与阈值 · R-12 消息间键盘导航 · R-14 全量快捷键自定义 · R-17 插件面板级 UI / 菜单 / 状态项 · R-18 符号选择改用语言服务（维持正则实现）。
- **2026-11-08 项目所有者决定**：顶层 Agent 跨工作区编排（首页常驻顶层会话 + 派发子会话 + 委派授权 + headless 工作区）不做。理由：编排带来的复杂度在于授权、预算与工作区隔离，而单机工作台的跨工作区需求已能用「多工作区常驻视图 + 工作树会话」直接覆盖；要跨机协作走云端 Agent。原需求草案（`TOP_LEVEL_AGENT.md` / `TOP_LEVEL_AGENT_BRIEF.md`）已删除，恢复看 `git log`。
- **更早的边界**：B-02 脱敏 thinking 占位（取决于供应商是否返回 `redacted`）· B-03 旧会话过程轨迹补造（无 `parts` 的旧会话按普通文本显示）· 转 DSH 内核（2026-10-23 放弃）。

## 6. 云端 Agent

> 唯一方案、协议、验收与安全边界：[CLOUD_AGENT](../requirements/CLOUD_AGENT.md)。本节只记状态，不维护第二份云端任务表。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Phase 1：桌面端配对 | ✅ | 一次性连接码、`cloud:gateway:pair`、配置白名单、旧入口删除 |
| Phase 2：网关插件 | ✅ | `pi-workbench-gateway` P0–P5，`hermes plugins install` 装到真机，G0 全绿 |
| Phase 3：应用联调 | ✅ | G1 真机通过（配对 / 对话 / SSE / 审批回执 / 插话 / 注销再配对 / 两种异常态），随 0.8.0 发布 |
| 云端事件通知 | ✅ | 0.8.0 之后补：审批 / 澄清 / 终态投递系统通知，按 `requestId` / `runId` 去重，点击切云端页并定位那张卡（[CLOUD_AGENT §3.9](../requirements/CLOUD_AGENT.md)） |
| AC-14 / AC-15 / AC-19 | ✅ | 2026-11-08 真机结项：Hermes v0.22.6→v0.23.0 后设备库 / 审计 / 会话全保留且不用重新配对；运行时唯一对外连接是模型 API；反代实测 200/401/404/拒 WS/308。详见 [CLOUD_AGENT §8.4](../requirements/CLOUD_AGENT.md) |
| 任务页新建 / 编辑 / 删除 | ✅ | 编辑与删除要插件 0.1.2（放行 `PATCH` / `DELETE /api/jobs/{id}`） |
| gateway 多路复用（0.23） | ⛔ 等上游 | 2026-11-08 实迁失败并回滚：宿主进程不读 profile 的 `.env`、不起 profile 的 api_server → 插件无密钥、无上游。回滚配方见 [CLOUD_AGENT §7.5](../requirements/CLOUD_AGENT.md)；上游补齐（或评估把密钥移到宿主 `.env` 的安全代价）后再试 |
| 多会话并行跑 | ✅ | 不同会话各跑一轮（上限 2，同网关 SSE 并发）；帧带会话归属，切走的那轮在后台继续并留「有轮次在跑」标记 |
| 终态保真 | ✅ | `run.completed` 的 `usage` / `runtime.provider·model` / `partial` / `interrupted` 都落到脚注，截断与打断不再显示成正常结束 |
| C-08 ~ C-12 / H3 | ⬜ 后置 | 见 §2 与 [CLOUD_AGENT §9.4](../requirements/CLOUD_AGENT.md) |
| 停止按钮 / 跨重启接回 | ⛔ 不单独立项 | 2026-11-08 项目所有者决定不做真机验收 |

---

**维护者**: Pi Workbench Team
**最后更新**: 2026-11-08
