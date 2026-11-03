# 云端 Agent 后端选型调研（2026-11-03）

> **性质**：临时报告。结论已并入 [CLOUD_AGENT.md](../requirements/CLOUD_AGENT.md) 与 [ADR-004](../decisions/ADR-004-cloud-agent-backend.md)，本文件保留的是选型过程与被否决项的证据。
> **上游**：需求 [CLOUD_AGENT](../requirements/CLOUD_AGENT.md) · 决策 [ADR-004](../decisions/ADR-004-cloud-agent-backend.md)

## 0. 结论

**选 Hermes Agent（Nous Research，MIT）作为云端后端**，Pi Workbench 做它的控制台，接入口为 **ACP（Agent Client Protocol）**。

推翻了两条先前假设：

| 先前假设 | 现实 |
| --- | --- |
| 从组件积木自研云端 Agent | 产品级项目已存在，自研 50 条能力是浪费 |
| 需要一个"更小的 Hermes 二开项目" | **不存在**——因为它本身就是那个精简版；最小化靠官方 profile 机制 |

---

## 1. 候选全景（产品级，非组件）

| 项目 | 星数（参考） | 许可 | 语言 | 定位 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **Hermes Agent**<br>`NousResearch/hermes-agent` | 259,651（2026-11 榜）；另有源记 95.6k / 61k | MIT | Python 3.14 + Node | 自改进型常驻 agent，多终端后端 | ✅ **选中** |
| OpenClaw | 386,192 | MIT | TS / Node 24 | trusted gateway + untrusted execution，policy as code | 🟡 备选（12 GB 仓库；teams 概念冗余） |
| OpenMuse<br>`CopilotKit/openmuse` | — | MIT | TS + Expo | Meta Muse 的开源替代，单 owner | 🟡 备选（alpha + 强制闭源 Intelligence） |
| ZeroClaw<br>`zeroclaw-labs/zeroclaw` | — | MIT / Apache-2.0 | Rust | 单二进制最小 agent | ❌ Rust 二开门槛；生态小 |
| NemoClaw<br>`NVIDIA/NemoClaw` | — | — | — | OpenClaw 企业分叉，OS 级沙箱 OpenShell，**支持 OpenClaw 与 Hermes 两种 agent** | 🟡 可选加固层 |
| AutoGPT | 187,900 | MIT | Python | 通用自主 agent | ❌ 与本形态不同 |
| dify | 160,200 | Apache-2.0（+ee） | Python/TS | 工作流平台 | ❌ 不是常驻 agent |
| OpenHands | 92,540 | MIT | Python | 编码 agent | ❌ 域太窄 |
| lobehub | 83,700 | Apache-2.0 | TS | 聊天客户端 | ❌ 无执行面 |

**星数说明**：Hermes 的数字在不同来源差异达 4 倍（61k / 95.6k / 259.7k），该品类榜单污染严重。**本决策不依赖星数**，依赖结构特征（见 §2）。

---

## 2. 为什么 Hermes 赢（结构性理由，非口碑）

| # | 理由 | 证据 |
| --- | --- | --- |
| 1 | **无闭源依赖** | OpenMuse 缺 `CPK_INTELLIGENCE_API_KEY` 则 API 起不来；Hermes 无此问题 |
| 2 | **执行面现成** | 六种终端后端：local / Docker / SSH / **Modal** / **Daytona** / Vercel Sandbox（+ 插件 Singularity）。Modal 与 Daytona 支持闲置休眠、按需唤醒 → 直接满足 C-A01/A03 |
| 3 | **有标准接入协议** | 仓库含 `acp_adapter/`。ACP 有 `session/request_permission` → 天然承载 C-C01 |
| 4 | **记忆闭环最强** | FTS5 会话检索 + LLM 摘要 + Honcho 用户建模 + 定期自我提醒沉淀 → 覆盖 C-G01/G02 |
| 5 | **技能自改进** | 从经验生成技能、使用中改进，兼容 agentskills.io 开放标准 → 覆盖 C-H01 |
| 6 | **定时任务内建** | cron + 投递到任意渠道 → 覆盖 C-H02 |
| 7 | **子代理可配限额** | 隔离子代理，每个可独立指定 provider / model / limits → 覆盖 C-I01 |
| 8 | **渠道最全** | Telegram / Discord / Slack / WhatsApp / Signal / Email / Mattermost → 覆盖 C-J02 |

**唯一的劣势是体积**：默认捆绑 **118 个技能**（v0.10.0）。已有官方解法（§3）。

---

## 3. 体积问题：没有"精简二开项目"，但有官方解

### 3.1 为什么不存在

- 外部评价普遍把 Hermes 定位为"**OpenClaw 的精简重写**"（注意：理念重写，非代码 fork——Hermes 是 Python，OpenClaw 是 TS）。既然它是"更小的那个"，就不会有"更小的 Hermes"。
- 上游自己做过大瘦身：据腾讯云文章，**v0.15 实现 76% 代码瘦身、4500× 搜索加速、63% 冷启动提升**。
- 官方 **Issue #19986** 标题即：`Make non-core bundled skills optional and keep the default install minimal` —— 社区在推动，方向一致。
- 社区已在自救：博客《Clean Up Bloated Skills & Plugins in Hermes》、视频《I Deleted 49 Skills From My Hermes Agent》。

### 3.2 官方最小化三板斧

| 手段 | 命令 | 效果 |
| --- | --- | --- |
| 停播种 | `hermes skills opt-out` | 写 `.no-bundled-skills` 标记 |
| 删已播种 | `hermes skills opt-out --remove` | 删未改动的捆绑技能（118 → 0） |
| 反悔 | `hermes skills opt-in --sync` | 移除标记并重新播种 |
| 最小实例 | `hermes profile create <name>` | 目录仅 6 类文件 |
| 最小资源 | 1 GB 内存 + 1 核 | 官方 Docker 要求 |

### 3.3 为什么不 fork

fork 会失去 `hermes profile update` 升级路径（更新时保留 config / 记忆 / 会话 / 密钥）。而 profile 只有 6 类文件，本身已是"最小二开"。上游修技能体积问题时我们直接受益。

---

## 4. 被否决项的许可证风险（红线清单）

| 项目 | 许可 | 处理 |
| --- | --- | --- |
| KasmVNC | **GPL-2.0** | 避开 |
| Skyvern / Windmill | **AGPL-3.0** | 避开 |
| nanoMuse | **GPL-3.0** | 避开 |
| Restate | BSL（非 OSS） | 避开 |
| Nango | Elastic 2.0 | 避开 |
| n8n | Sustainable Use | 避开 |
| Langfuse / Infisical / Phoenix | MIT 核心 + `ee/` | 可用核心，勿碰 `ee/` |
| **Selkies / OpenBao** | **MPL-2.0** | 可安全嵌入 |
| **Daytona** | — | ⚠ **2026-06 已停止开源维护**（Hermes 仍支持其后端，但不宜作为唯一依赖） |

---

## 5. 保留参考：自研六件事的现成语义

这些是 Hermes **不做**的部分（[CLOUD_AGENT §3](../requirements/CLOUD_AGENT.md)），下列项目的实现值得直接抄。

### 5.1 open-duet 的三个拒绝语义（比我们原文档更精确）

`backend/app/computers/screen.py`（202 行）中：

| 常量 | 含义 | 为什么重要 |
| --- | --- | --- |
| `BUSY_REFUSAL` | 另一会话正占用 → **不排队、不重放** | 对应我们 C-E07 |
| `FRESH_REFUSAL` | 屏幕已变化 → 重新截图再决策，**禁止重放旧输入** | 同上 |
| `CONTROL_REFUSAL` | 人已接管 → **不重试**，停下并告知在等待 | 对应 C-C02 与 S-08 |

仓库：Apache-2.0，576 源文件，`backend/app/computers/` 4,595 行（`service.py` 945 / `screen.py` 202 / `policy.py` 58）。

### 5.2 OpenMuse 的耐久语义

- **"No hidden retry occurs after an uncertain external write"** → 直接就是我们 C-E03 + C-E07 的一句话定义
- **stored review**：每个对外写（发送、日历变更）单独复核 → C-C01 的参考形态
- **SQL leases recover interrupted work** → C-E02 的参考
- 缺点：alpha；无图形桌面（只有 Playwright Chromium + Docker 终端）；默认向 PostHog 发遥测

### 5.3 其他可复用件（仅在需要时）

| 用途 | 项目 | 许可 | 备注 |
| --- | --- | --- | --- |
| 沙箱 | microsandbox 8,920 / agent-sandbox / E2B embed | Apache-2.0 | Hermes 已自带后端，仅在需要更强隔离时 |
| 远程桌面 | Neko 22,594 / Selkies | Apache-2.0 / MPL-2.0 | 若 C-B01 要走视频流而非截图 |
| 浏览器自动化 | browser-use 119,897 / Stagehand 25,916 / cua 31,626 | MIT | C-F04 兜底 |
| 记忆 | mem0 68,310 / Graphiti 32,464 | Apache-2.0 | Hermes 自带，不重复引入 |
| 耐久执行 | DBOS 1,427 / Hatchet 8,218 / Temporal 24,149 | MIT | C-E03 若自建可用 |
| 授权 | OpenFGA 6,083 / Obot 1,155 | Apache-2.0 / MIT | 单用户不需要 |
| 秘钥 | OpenBao | MPL-2.0 | 仅在需要独立 vault 时 |

---

## 6. 遗留风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| ACP 成熟度未知 | `acp_adapter/` 存在，但 `request_permission` 与工具事件流是否完整未验证 | **P0 先做一天穿刺**；退路是 Gateway 协议或本地 REST |
| 体积 | 118 个捆绑技能 | profile + opt-out（§3.2） |
| 星数噪声 | 同一项目三个数量级不同的数字 | 不用星数做判据 |
| Daytona 已停维护 | Hermes 支持但其上游停了 | 主用 Modal，Daytona 作备选 |
| 遥测 | Hermes 与 OpenMuse 都默认开 | 明确关闭并写入验收（AC-15） |
| 跨语言 | Python 后端 | 只走协议，不读源码 |

---

## 7. 核查与更正（2026-11-03）

上面 §1–§6 是**选型阶段**的判断。方案落成后逐条核对官方文档与仓库，结论并入 [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md)、[ADR-005](../decisions/ADR-005-cloud-agent-control-plane.md) 与 [ADR-006](../decisions/ADR-006-cloud-agent-api-control-plane.md)。**本节是证据，前面各节与本节冲突时以本节为准。**

### 7.1 核实为真

| 说法 | 核实 |
| --- | --- |
| Hermes Agent 存在、MIT、Nous Research | ✅ `NousResearch/hermes-agent`，**260,003 星**，Python，仓库 **1.38 GB**（OpenClaw 393,794 星 / **12.4 GB**），2026-11-03 GitHub API |
| `acp_adapter/` 存在且实现审批 | ✅ 文件：`entry/server/session/events/permissions/tools/auth`；`permissions.py` 映射 `allow_once→once`、`allow_always→always`、reject→`deny`；**超时与桥接失败一律 deny** |
| 工具事件能映射到 parts | ✅ `tool_progress_callback` + `step_callback` → `session/update`；`patch`/`write_file`→diff，`terminal`→命令文本；工具 ID 按名 FIFO 配对 |
| session 持久、跨重启恢复 | ✅ 落 `~/.hermes/state.db`（SessionDB），`session/{new,load,resume,fork,list,cancel}` |
| profile 机制与最小化命令 | ✅ `hermes profile create`、`distribution.yaml`、`hermes skills opt-out [--remove]` / `opt-in --sync` |
| 六种终端后端 | ✅ local / Docker / SSH / Modal / Daytona / Vercel + Singularity 插件 |
| 星数噪音 | ✅ 报告里 61k / 95.6k / 259.7k 的差异属实，实际 260k；决策不依赖星数仍然正确 |

### 7.2 更正（会改变方案的部分）

| 原说法 | 实际 | 影响 |
| --- | --- | --- |
| 「ACP 走 stdio 还是 socket，默认 SSH 隧道」 | ACP **只有 stdio**，agent 是 client 的**子进程**；适配器 `use_unstable_protocol=True` | 远程只能 `ssh` 包一层子进程；协议可能带不稳定性，版本要钉 |
| 「gateway 关闭，入口只有 Pi Workbench」 | `hermes acp` 是 **gateway daemon 的 viewer**，工具在 daemon 进程执行；daemon 未运行 → `Gateway inaccessible: not_ready`（issue #9272） | daemon 必须常驻，只能关渠道 |
| 「Modal/Daytona 拿休眠唤醒」 | 容器后端下 **dangerous 命令检查被跳过**（"the container itself is the security boundary"） | **与「不可逆操作必须批准」互斥**，默认改用 `ssh` 后端 |
| 「审批 = 动作级审批的载体」 | 审批只覆盖 **dangerous shell 命令**（约 35 条模式）；`write_file`/`patch` **无审批路径**；per-tool 策略是 open issue **#33905**；`approvals.mode: smart` 会用辅助 LLM 自动放行 | C-C01 不能只靠 `request_permission`，必须自建执行器门 |
| 「`execute_code` 有把关」 | 本地会话（含 **ACP editor**）里"viewer 提交的轮次**没有整脚本审批**"，Python 级文件/进程操作不问 | **必须** `agent.disabled_toolsets: [code_execution]` |
| 「Hermes 与 OpenMuse 都默认开遥测」 | Hermes **默认无遥测**；遥测是第三方 opt-in 插件（nujovich/hermes-telemetry） | S-10 前提更正，风险降级 |
| 「`eventCursor` 可重放增量」 | ACP **无事件游标**：只有 `session/load`（整段重放，需 `loadSession`）与 `session/resume`（不重放） | §5.3 改写；AC-07 降级 |
| 「云端计算机 = 一个可休眠的实体机」 | 文件工具与 browser 在 **gateway 主机**执行，只有 `terminal` 可能落沙箱；agent 进程常驻不休眠 | C-A02/A03 语义收窄；"休眠唤醒"不是必需能力 |

### 7.3 新发现（原报告漏掉的利好与风险）

| 项 | 内容 | 影响 |
| --- | --- | --- |
| ✅ **gateway 认证 HTTP/WS 控制面** | `session.resume`（返回 **pending admissions**）、`approval.respond`、`clarify.request/respond/settled`、`session.control.read`、`process.list`、`subagent.list/tail`、`session.mutate`（revision 冲突保护）；认证 = 静态 token / OAuth bearer / Host / route token，本地 bootstrap 是「同 OS 用户」边界而非远程 OAuth 旁路 | **接入口径改为「WS 主 / ACP 备」**，断线补齐有了正解 |
| ✅ **Kanban** | SQLite 持久任务板，跨 profile 共享，多 agent lane，CLI + Dashboard（Desktop 尚无） | C-E01 从「自研任务模型」降为「视图」 |
| ✅ **`approvals.deny` + `approvals suggest`** | fnmatch glob，**在 yolo 与 `mode: off` 之前生效**，含解混淆；`suggest` 从历史挖掘白名单提案 | C-D05 直接可用；C-C01 的"策略层"有了落点 |
| ✅ **credential vault** | 支付卡等敏感值「填进页面」而非进模型上下文；`.env` 读拒绝；终端输出 redactor | S-03 有基础（MCP token 仍待验证） |
| ✅ **`multiplex_profiles`** | 一 daemon 服务多 profile，各自 session authority 与账本 | C-A04 的正解 |
| ⚠ **官方 Hermes Desktop** | Electron + React，2026-06-02 起公开预览，同一 agent core | **战略风险**：我们做的是第二个控制台，差异化必须落在"与本地工作区同窗 + 本地/云端并存" |
| ⚠ **硬闸只有 MCP `spend_limit`** | token/时长/调用次数无硬熔断；`/usage`、telemetry 是统计不是闸 | C-E04 受约束（Q11） |
| ⚠ **`write_file` 无审批** | 只有保护路径 denylist + 可选 `HERMES_WRITE_SAFE_ROOT` | S-04 承认缺口 |

### 7.4 证据链接

- Hermes ACP：[Host Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) · [ACP Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals)
- Hermes 安全：[Security（容器跳过审批 / 审批覆盖面 / `execute_code` / 文件写入）](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- Hermes 控制面：[Gateway Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)
- Hermes 其他：[Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) · [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) · [Profile Distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions) · [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- ACP 规范：[Overview](https://agentclientprotocol.com/protocol/v1/overview) · [Session Setup（`session/load` 重放 / `session/resume`）](https://agentclientprotocol.com/protocol/v1/session-setup)
- 未决项：[Per-tool approval policies #33905](https://github.com/NousResearch/hermes-agent/issues/33905) · [最小化安装 #19986](https://github.com/NousResearch/hermes-agent/issues/19986) · [gateway not_ready #9272](https://github.com/multica-ai/multica/issues/9272)
