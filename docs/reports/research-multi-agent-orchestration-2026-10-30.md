# 调研报告：多 Agent 编排 / 跨项目顶层 Agent（2026-10-30）

> **性质**：调研记录，不是需求文档。对应需求见 [TOP_LEVEL_AGENT_BRIEF](../requirements/TOP_LEVEL_AGENT_BRIEF.md) / [TOP_LEVEL_AGENT](../requirements/TOP_LEVEL_AGENT.md)。
> **问题**：我们要做的"首页顶层 Agent 指挥任意已记录工作区"这件事，别人怎么做？多 Agent 并行与工作树隔离的真实实现是什么样？
> **方法**：只读调研，读一手来源（官方文档、官方博客、规范原文、开源仓库、社区报障帖），未改动任何代码或需求文档。
> **声明**：标注 `[确认]` 的有一手来源；`[推断]` 是我从产品行为反推的结论。

---

## 1. 先回答你问的 "Dot"

**Dot 不是 Codex 的功能，是 OpenAI 在 DevDay 2026（2026-09-29）发布的独立产品品类 `Dots`。** `[确认]`

- 定位：**always-on AI agent**，不是问答式会话。跑在**它自己的云电脑**上，按计划或事件触发，人离线时也继续干。
- 底座：GPT-6 Astra；接 4,000+ 应用（插件生态）；先给 Pro 200 / Business Premium。
- 与 Codex 的关系：**Dot 是 Codex 上面的那一层**。官方 10 月更新写"dots can start Codex work and follow up on existing threads"。

社区里有一篇非常有价值的报障帖（2026-10-14，OpenAI 官方论坛 `Dots` 分类），把**用户期望的结构**画清楚了，也暴露了**当前失败点**：`[确认]`

```
我 → Dot → 常驻的「本地项目协调者」线程 → 专业子线程（设计/营销/排查…） → 可选 subagent
```

- 期望：Dot 把"看下 Example App 现在什么状态、缺什么、安排改进"转给本地协调者线程，协调者复用/新建专业线程，汇总后回报 Dot；人能在桌面 App 里直接打开任意一层介入。
- **实际失败**：Dot 无法向已存在的**本地** Codex 线程投递后续指令，报 `CloudThreadNotFoundError`（它去云端查线程，本地线程查不到）。另有独立限制：Dot 的创建工具"只能创建云端托管任务，不能创建原生本地桌面线程"。
- **对我们的意义**：这类需求最常见的塌方点不是编排逻辑，而是**跨边界的会话身份**（云端 orchestrator ↔ 本地 session）。我们全本地、单进程，天然没这个洞；反过来说，将来若接云端，会撞同一面墙。

---

## 2. 逐个对象

### 2.1 OpenAI Codex app（桌面端）`[确认]`

- 定位就是"agent 指挥中心"：多 agent 并行，**thread 按 project 分组**，各自保留上下文。
- 隔离：**内置 worktree**，每个 agent 在自己的 worktree + feature branch 上改，互不冲突；CLI 侧同样"一任务一 worktree"。
- 权限：默认沙箱限制在项目文件夹/分支 + 缓存 web 搜索，越界要**逐次授权**。
- 复用机制：**skills**（把工具+约定打包成可复用能力）、**automations**（重复工作 + 审阅队列）。
- 关键观察：**没有"跨项目的顶层 agent"**。thread 永远属于某个 project；想跨项目只能人自己切。这正是我们要补的空档。

### 2.2 OpenAI Symphony（开源规范，最值得读的一份）`[确认]`

`SPEC.md` 是纯文本规范（参考实现 Elixir），把"issue tracker 变成 agent 控制面"。

- 控制面 = 任务队列（Linear），不是会话列表。**围绕交付物组织，而不是围绕 session/PR。**
- **每个 issue 一个确定性的 workspace，跨 run 保留**（下次还回同一个目录）。
- **有界并发**（bounded concurrency）+ **单一权威编排状态**（orchestrator 是唯一修改调度状态的组件）。
- **内部 claim 状态机**（`Unclaimed` / `Claimed` / …），与 tracker 状态解耦；issue 状态变化要能**停掉在跑的 run**。
- **成功 = 到达 workflow 定义的交接态**（例如 `Human Review`），不一定是 `Done`。
- 失败教训写在博客里，非常有价值：
  - 人同时管 3–5 个会话就到顶，"human attention 才是瓶颈"。
  - **"把 agent 当成状态机里的刚性节点行不通"** —— 后来改成给 agent **目标（objective）而不是状态转移**，并给工具（gh CLI、读 CI 日志的 skill）。
  - 缺了交互式纠偏能力（不能在飞行中 nudge），于是把纠偏沉淀成 **guardrails + skills + WORKFLOW.md**（把流程写成文档让 agent 自己遵守）。
  - 安全边界：workspace 路径必须在 root 下；**coding agent 的 cwd 必须是该 issue 的 workspace**；**tracker 凭据只在宿主进程用，不传给子 agent**（用 dynamic tool call 代理）；hook 属于"完全可信配置"。
  - 结果：部分团队 landed PR +500%。

### 2.3 Claude Code：subagents 与 agent teams（两层）`[确认]`

| | subagents | agent teams（实验性） |
| --- | --- | --- |
| 范围 | 单 session 内 | 跨 session，一个当 lead |
| 上下文 | 独立 context window，**结束只回摘要** | 各自独立 context，**可互相直接通信** |
| 任务 | 父级派一次性子任务 | **共享任务列表 + 依赖 + 文件锁**，依赖完成自动解锁 |
| 权限 | frontmatter 的 `tools` / `disallowedTools` / `permissionMode` / `maxTurns` / model 路由 | teammate 继承 lead 的权限模式（`dontAsk` 除外） |
| 恢复 | 可 resume，未完成会标记 | 已知限制：session 恢复、任务协调、关闭行为 |

teammate 机制里三条与我们的设计直接相关：

1. **审批卡会浮到 lead 会话里**（teammate 的请求不被吞掉）。
2. **agent 不能替用户批准**，也不能把审批转交给别的 agent 来绕过检查；plan 审批也是显式流程。
3. 空闲/任务事件有 hook（`TeammateIdle` / `TaskCreated` / `TaskCompleted`），**靠事件唤醒而不是轮询**。
4. 官方自己建议：能用 subagents 就别上 teams；3–5 个 teammate 是甜点。

### 2.4 Cursor：worktree 即隔离原语 `[确认]`

- 并行 agent **默认基于 git worktree**，每个 agent 独立 checkout；只有 Agents Window 有原生 worktree UI。
- 配置：`.cursor/worktrees.json`，`setup-worktree-unix` / `setup-worktree-windows` / `setup-worktree` 三个 key，值为**顺序执行的命令数组**或脚本 —— 解决"新 worktree 没 node_modules / .env"这个必然踩的坑。
- `/best-of-n`：同一任务多模型并行，各自 worktree，最后 `/apply-worktree` 把选中的结果合回主 checkout。
- 方向：把 **control plane 变成主界面**（Glass）`[推断]`——和"首页 = 指挥台"同路。

### 2.5 Devin：coordinator + Managed Devins（与 A1 最像）`[确认]`

- coordinator session 拆解任务，委派给多个 managed Devin，**各自独立 VM** 并行。
- coordinator 负责：定范围、监控进度、**解决冲突**、汇总结果。**子会话完成或需要输入时自动唤醒 coordinator，不轮询。**
- 默认 **"Auto-approve child sessions" 是开的**（可改为每个 batch 都要人审）。
- 成本：给每个子会话 **ACU 上限**；可以 sleep / terminate 子会话，防止跑飞。
- **并行能不能成立取决于切分**：官方要求不同子会话尽量在**不同分支 / 不同包 / 不同仓库切片**，否则冲突。

### 2.6 Orchestrator.inc（开源 Apache-2.0，产品形态最接近我们）`[确认]`

- 桌面端（mac/Win/Linux）+ 移动端，适配 30+ agent（Claude Code / Codex / …），定位"从 task 到 merged PR"。
- 流程：plan → run → supervise，**保留人工审批门**；仓库里带 `.agents/skills` / `.claude/skills`（`SKILL.md` + scripts）的复用结构。
- 对我们的意义：**"桌面应用 + 多 agent + 多仓库 + 审批门"这个组合已被验证有人要**。

### 2.7 其它，一句话各自要点 `[确认]/[推断]`

- **Conductor**（macOS）：本地多 agent 并行 + 各自 worktree + dashboard + diff-first review，适合同仓库 3–8 个并行 feature。
- **Jules**（Google）：异步云 agent，**先出计划再写码**，回传带推理与日志的 PR。
- **GitHub Copilot coding agent**：assign issue → Actions 里出 draft PR，自审 loop，可接 Slack/Jira/Linear。
- **Tembo / Progress Forge / RoadCrewAO**：企业向，卖点是**审批门 + 治理 + 审计**，不是并行度。
- **Vibe Kanban**：已停止维护 —— 反面教材：**不要把一个第三方编排器当成基础设施**。`[推断]`
- **Addy Osmani《The Code Agent Orchestra》**（横向总结，方法论层面最完整）：
  - 三档：Tier 1 进程内、Tier 2 本地编排器、Tier 3 云异步；"conductor（单 agent 实时指导）→ orchestrator（多 agent 异步协调）"。
  - **verification 才是瓶颈，不是 generation**；所以要有 **quality gate + 专职 reviewer**。
  - 子 agent 回报要写成文件（如 `DATA.md`），**不要把完整上下文塞回父级**。
  - 护栏：`MAX_ITERATIONS` + reflection 循环 + **token 预算（到 85% 就暂停）** + 明确的 kill criteria。
  - **AGENTS.md 必须人工 curation**，让 LLM 自己写没有收益。

---

## 3. 横向对比

| | 编排者住在哪 | 隔离靠什么 | 任务从哪来 | 谁批准 | 子→父怎么回报 | 跨项目 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex app | 桌面 App，thread 属于 project | git worktree | 人手动开 thread | 沙箱越界逐次授权 | thread 本身 | ✗ |
| Symphony | issue tracker（外部） | 每 issue 固定 workspace | tracker 队列 + DAG 依赖 | 交接态 `Human Review` | 状态 + proof-of-work | ✗（单 tracker） |
| Claude Code teams | lead session | 同目录（靠 git 分支约定） | 共享任务列表 + 依赖锁 | 继承 lead 权限；**agent 不能代批** | 摘要 + 事件 | ✗ |
| Cursor | Agents Window | git worktree（带 setup 脚本） | 人发起 / best-of-n 扇出 | 逐次 / 人审 diff | diff + 应用回主分支 | ✗ |
| Devin | coordinator session（云） | 独立 VM | 人委派 | 默认自动批准子会话 | 唤醒 + 汇总 | ✓（同账号多 repo） |
| Dots | 云电脑（常驻） | 云主机 | 计划 / 触发 / 人 | App 权限 + 内置护栏 | 会话消息 | ✓（本轮目标） |
| **我们（拟）** | **主进程内的顶层会话** | **会话工作树 / 无界面工作区** | **顶层拆解 + 人直接下任务** | **委派授权 + 逐次卡片** | **结构化汇报 + 事件唤醒** | **✓（多工作区）** |

## 4. 九条可复用的规律

1. **控制面围绕交付物组织，不围绕会话。** Symphony 的原话大意是：我们围绕 coding session 和 merged PR 设计，其实那只是手段。我们的任务模型必须是"交付物 + 完成定义"，不是"会话列表"。`[确认]`
2. **人是瓶颈，不是模型。** 3–5 个并行会话就到人的极限（Symphony 与 Claude teams 都是这个数）。顶层 Agent 的价值是**减少人需要同时盯的东西**，不是提高并行数。**如果它让人更忙，方向就错了。**
3. **隔离优先于串行。** 同仓库并行的行业标准答案不是排队，是 **worktree / 容器 / VM**。我们已有会话工作树 → 应作为并发的默认手段，串行只用于"就地改"。
4. **子 agent 的回报要压缩成工件。** 摘要 + 证据，不回灌完整上下文（Claude subagents、Addy 的 `DATA.md`、Symphony 的 proof-of-work 三处一致）。
5. **事件唤醒，不轮询。** Devin（子会话完成或需要输入即唤醒）与 Claude（idle hook）都不靠 sleep 轮询。
6. **给目标，不要给状态机。** Symphony 明确说刚性状态转移失败过；Devin / Claude 都用"目标 + 工具 + 上下文"。任务卡应是**目标 + 验收标准 + 边界**，不是"步骤 1/2/3"。`[确认]`
7. **审批不能被代转。** Claude Code 明确：agent 不能替用户批准，也不能把审批转给别的 agent 来绕过检查。委派授权只能是**用户 → 子会话**的单向、可撤销、有期限的授予。
8. **人工关卡放在交付点。** 计划审批（Jules / Cursor）、交接态（Symphony `Human Review`）、best-of-n 选优（Cursor）、变更审阅（Tembo）——都在"改完、合入前"，而不是每次读写。
9. **成本要能掐。** Devin 的 ACU 上限、Addy 的 85% 预算暂停 + kill criteria。任务没有预算上限，迟早会有一个跑飞的晚上。

## 5. 对我们方案的影响

### 5.1 五个决定：4 个有先例，1 个建议修正

| 我们的决定 | 行业对照 | 结论 |
| --- | --- | --- |
| A1 编排型（顶层不直接读写） | Devin coordinator、Claude lead、Symphony、Dots→协调者 | **保持**。主流形态，且避免顶层上下文被文件内容污染。 |
| B 全部已记录工作区 + 可新增 | Dots / Cursor / Devin 都支持多项目 | **保持**。新增工作区必须走确认卡。 |
| C 顶层住在首页 | Cursor 把 control plane 做成主界面 | **保持**，但受规律 2 约束：首页要能一眼看出"谁在跑、谁在等我"，否则只是换个地方加班。 |
| D 委派授权 | Devin 默认自动批准子会话；Claude teammate 继承 lead 权限 | **保持**，加两条：① 用户显式设定永远优先于委派；② 委派不可跨会话再转授。 |
| E 不依赖打开 | Symphony 全是无界面工作区 | **保持**。并抄它的"确定性 workspace + 跨 run 保留"：同一工作区永远映射到同一个固定目录。 |
| **单写者串行（Q1）** | 无人靠串行，都靠隔离 | **建议修正**：git 仓库内并发任务默认各给一个工作树；非 git 或用户选"就地"时才排队。串行是兜底，不是默认。 |

### 5.2 需求文档缺的 6 件事（按重要性）

1. **结构化汇报格式**（现在只在"汇报"里一句带过）。应是 P1 的一等公民：`改了什么 / 证据（测试输出、命令、截图）/ 没做什么 / 风险 / 建议下一步`。没它，顶层只能转述子会话的自评，可靠性是假的。
2. **顶层如何被唤醒**（文档里完全没有）。至少三种触发：子任务完成、子任务需要输入（审批 / 提问）、子任务失败。不能靠顶层 sleep 轮询 —— SDK 侧对应 `agent_settled` 一类事件。
3. **任务依赖（DAG）**。现在任务彼此独立，"先 A 后 B"只能靠顶层干等。至少支持 `blockedBy`，让未阻塞的任务自动开跑。
4. **交付关卡**。每个任务需要"完成定义 + 人工确认（看 diff / 看证据）"，而不是子会话说完成就算完成。
5. **预算与熔断**。任务级 token / 时长上限 + 到线暂停 + 显式 kill。
6. **失败的处理**。失败比成功常见：任务卡要有 `失败原因 + 已产生的副作用 + 能否重试`，且**重试不得自动覆盖上一次的改动**。

### 5.3 三个「不用做」

- **不用做轮询调度器**（Symphony 那种 tracker 轮询）：触发源是人 + 顶层，事件驱动足够。
- **不用做跨机器 / 云端编排**：Dots 的社区报障说明跨边界会话身份是主要失败源；本地单进程是优势，别自己拆掉。
- **不用做状态机化的任务流转**：给目标 + 验收标准比给状态转移稳，并且能复用现有的"结构化计划"。

## 6. 风险清单（别人踩过的坑）

| 坑 | 证据 | 对策 |
| --- | --- | --- |
| 跨边界会话续接失败 | Dots 向本地 Codex 线程投递 → `CloudThreadNotFoundError` | 会话身份保持全本地；接入外部协议前先验"续接可用性" |
| 并行写冲突 | Claude teams 明写同目录并发风险；Devin 要求不同 branch / 包 / 切片 | 工作树默认隔离 + 同工作区写入串行兜底 |
| 编排状态丢失 | Symphony 强调"单一权威编排状态"、重启后对账 | 任务落盘 + 重启对账（已定：重启 = 暂停，不自动续跑） |
| 人变忙而不是变闲 | Symphony：人管 3–5 个就到顶 | 首页只暴露"需要你决策的事"，其余折叠 |
| 成本失控 | Devin ACU 上限、Addy 预算熔断 | 任务级预算 + 到线暂停 |
| 依赖第三方编排器 | Vibe Kanban 停止维护 | 编排逻辑留在主进程，不引外部服务 |
| 把实验性功能当稳定用 | Claude agent teams 明标实验性，恢复 / 协调 / 关闭都有已知问题 | "重启 = 暂停"是保守但正确的选择，放开要单独开关 |

## 7. 待拍板的三件事

1. **Q1 改不改**：同工作区并发时默认给工作树（而不是排队），认不认？
2. **汇报格式要不要升到 P1**：结构化汇报（改了什么 / 证据 / 风险）进第一阶段？
3. **要不要独立"验收"步骤**：任务完成 = 子会话汇报 + 人看 diff 确认，还是子会话汇报即完成？

## 8. 来源

- OpenAI Dots：[DevDay 2026 报道](https://commonthreadco.com/blogs/coachs-corner/openai-devday-2026-dots-agents-team-tasks-ecommerce) · [ChatGPT Learn 2026-10-09 更新](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026)（直连抓取失败，仅见社区引用原文） · [社区报障帖 2026-10-14](https://community.openai.com/t/dot-cannot-continue-an-existing-local-codex-thread-cloudthreadnotfounderror-blocks-project-coordination/1406288)
- OpenAI Symphony：[博客](https://openai.com/index/open-source-codex-orchestration-symphony) · [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)
- Anthropic Claude Code：[agent teams](https://docs.claude.com/en/docs/claude-code/agent-teams) · [subagents](https://docs.claude.com/en/docs/claude-code/sub-agents)
- Cursor：[worktrees](https://cursor.com/docs/configuration/worktrees)
- Devin：[advanced capabilities](https://docs.devin.ai/essential-guidelines/advanced-capabilities)
- Orchestrator.inc：[agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)
- Addy Osmani：[The Code Agent Orchestra](https://addyo.substack.com/p/the-code-agent-orchestra)
- Conductor / Vibe Kanban / Tembo / Jules / Copilot coding agent：产品文档与对比文章，未逐条记录 URL。

---

**维护**：临时调研报告。结论被吸收进需求文档或 ADR 后可删除（见 [reporting](../agent/reporting.md)）。
