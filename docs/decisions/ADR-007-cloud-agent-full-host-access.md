# ADR-007 云端 Agent 放开整机权限、本地改双页面（修订 ADR-005/006 的终端后端与前端形态）

> **面向**：准备云上部署、写云端两个页面、动审批策略与审计的人
> **什么时候读**：读 [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md) 之前；改 `approvals` / 终端后端 / 云端页面结构之前
> **什么时候要改**：不修改正文；权限口径或云端前端形态再次变化时写新 ADR

- **状态**: 已采纳（2026-11-03）
- **影响范围**: 云端 Hermes profile（`terminal.backend`、`platform_toolsets.api_server`、`approvals.deny`、`.env` 权限认知）、腾讯云控制台（安全组 / 快照）、`src/components/cloud/*`、`src/store/cloudStore.ts`、`electron/cloud/*`、`src/api/cloud.ts`
- **修订**: [ADR-005](ADR-005-cloud-agent-control-plane.md) 的**终端后端**（ssh 到受限用户 → 宿主级权限 + 软限制）；[ADR-006](ADR-006-cloud-agent-api-control-plane.md) 的**探针数量**（5 → 4）、**用量/预算归属**（接现成 usage → 首期不做）；本 ADR 另定**云端前端形态**（原由 ADR-005 的「本地侧两件改造」隐含）
- **相关文档**: [CLOUD_AGENT v5](../requirements/CLOUD_AGENT.md)、[ADR-004](ADR-004-cloud-agent-backend.md)、[ADR-005](ADR-005-cloud-agent-control-plane.md)、[ADR-006](ADR-006-cloud-agent-api-control-plane.md)、[DESIGN_SYSTEM](../design/DESIGN_SYSTEM.md)、[AGENT_TRACE](../architecture/AGENT_TRACE.md)、[ipc-and-trust](../agent/ipc-and-trust.md)

## 背景

ADR-005/006 定下的隔离与前端形态有两条假设，在实施前被否掉：

| 原假设 | 现实要求 |
| --- | --- |
| 用受限 OS 用户 `piagent` + `terminal.backend: ssh` 做硬隔离，让 agent 够不到自己的 `approvals.deny` 与 `.env` | **不需要**。要求是 Hermes **具备接管整台服务器的能力**（装包、改服务、查日志），软限制即可。硬隔离会把「能干什么」变成一道道要预先开洞的墙，运维成本远大于收益 |
| 云端前端可以复用工作区的 `ChatPanel` / `chatStore`（先把 transcript 表现层剥出来），云端板块像一个「panel」 | **不共用**。云端是**两个独立页面**（会话页 / 配置页），首页按钮进入，与本地 Agent 的工作区前端毫无关系 |
| 预算是必须的闸（读 `usage` → 到线 `/stop`） | **不存在消费上限**，不做熔断；`usage` 首期连展示都不做 |

三条合起来的结果：安全叙事的重心从「主机内隔离」移动到「**主机外的硬边界**」+「审批软限制 + 事后可发现可还原」。

## 决策

**一、Hermes 拿整机权限；隔离只做软限制。**

| 事项 | 决定 |
| --- | --- |
| OS 用户 | 不建 `piagent`；Hermes 与 daemon 同用户运行，必要时给无密码 sudo |
| 终端后端 | `terminal.backend: local`（默认）。仍然**拒绝**容器类后端——它们会整层关闭危险命令审批 |
| api_server 工具集 | `[file, web, skills, terminal]`——放开终端，否则「接管整机」无从谈起 |
| 软限制 | `mode: manual` + `approvals.deny`（必须覆盖系统级：`sudo` / `systemctl` / `crontab` / `authorized_keys` / `iptables` / `ufw` / `useradd`）+ `command_allowlist` |
| 硬边界 | 全部移到云控制台：**安全组**（唯一入站白名单）、**快照 + 自动备份**、**provider 侧额度告警** |

**二、本地做两个独立页面，靠首页按钮进入。**

| 事项 | 决定 |
| --- | --- |
| 入口 | 首页常驻「云端 Hermes」按钮（不属于任何 `workspaceDir`） |
| 页面 | **会话页**（api_server，自研）与**配置页**（BrowserView 嵌 dashboard），彼此独立，不是同一个壳里的 tab |
| 切换 | 按钮切换；切走只 `hidden + inert`，不卸载、不 reset（与多工作区同规则） |
| 拆窗 | 后置到 P4；入口形态 P0 就定 |
| 前端复用 | **不复用** `ChatPanel` / `chatStore` / 工作区壳；样式只受 `DESIGN_SYSTEM` token 约束 |
| 数据模型 | SSE → parts **只对齐类型**（`text` / `thinking` / `tool` / `approval` / `clarify`），渲染组件各自实现 |

**三、删掉预算熔断与用量展示。**

C-E04 整条删除：没有服务端 `spend_limit`、也没有消费上限，客户端闸只是噪声。相应地 S-07 删除、AC-08 改用途（改为两页切换验收）、探针 5 → 4。花钱的防线交给 provider 侧额度告警。

## 备选方案

- **保留 `piagent` + ssh 后端（ADR-005 原案）**：安全强度最高，但把「让 agent 干一件系统级的事」变成改配置 + 开洞的循环，且要求 agent 在受限用户下还得能把活干完。**否决**：与「Hermes 要能接管整机」直接冲突。
- **给 agent 一个独立用户但仍共享 sudo**：只多一层目录权限摩擦，挡不住任何真实威胁（sudo 在手）。**否决**，不如把力气放在 S-09 告警与云侧快照上。
- **云端塞进工作区壳里，复用 `ChatPanel`**：要先从 1108 行组件里剥出 transcript 表现层，且两套会话语义（`sessionId` / `parentId` 分支 vs `run` / `surface`）强行共用会反复打架。**否决**：省下的 UI 工作量不值得引入这个耦合。
- **同页 tab 承载会话与配置**：配置页是低频操作，长期占屏不划算，且会诱使两个面共享路由与滚动容器。**否决**：两页独立。
- **保留预算熔断（哪怕只是展示）**：无上限需求 → 没有「到线」语义可定义，闸的价值为零。**否决**；`usage` 首期不做，以后要看再当纯展示加。

## 后果

- **工期**：10–12 周 → **9–11 周**（省掉受限用户步骤、transcript 解耦、预算闸与用量 UI）。P0 变成「入口 + 两页骨架 + 传输 + 事件映射」，且骨架不依赖云端即可合入 main。
- **安全边界降级，已登记为已知弱点**：agent 与 daemon 同用户 → 它能 `write_file` 改自己的 `approvals.deny` / `mode`，也能读 `.env`。原「绝对拦住」变成「**事后可发现（哈希告警）+ 可还原（版本化副本）+ 云侧兜底（快照）**」。
- **新增条款**：S-14（硬边界只能在主机外）、S-15（deny 覆盖系统级）；S-03 / S-09 / S-11 强度下调并写明原因；S-07 删除。
- **新增验收**：AC-21（软限制被破坏可发现且可还原）、AC-22（整机权限真能用，且审批记录完整）；AC-08 改用途；AC-01 入口口径改为「首页按钮 → 会话页」。
- **D0 清单变长、云控制台进入必做项**：安全组、快照、provider 额度告警（S-14）。这三样是本方案唯一「agent 触不到」的东西。
- **探针减到四个**：①capabilities ②危险命令 park/BLOCKED ③dashboard 配置面 ④双进程并存。「`usage` 含 cache token」那条随之删除。
- **前端形态确定**：`PanelId` / `panelStore` 不需要现在就动（页面与工作区并列而非加入 union），拆窗留到 P4 再评估。

## 修订记录

| 日期 | 变化 |
| --- | --- |
| 2026-11-03 | 初次采纳（修订 ADR-005 的终端后端、ADR-006 的探针与用量归属；确定云端前端为两个独立页面） |
