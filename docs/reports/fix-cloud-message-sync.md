# 云端会话「最新消息同步不过来」修复方案

> 类型：临时分析报告（评审后移入 `docs/decisions/` 或删除）
> 状态：**P0 已实现**（P1 未做）；验证：`type-check` / `lint` / `npm test`（165 文件 1963 用例）全绿
> 日期：2026-11（会话内产出）

## 1. 症状

- **A**：会话里自己发消息，回复跑到一半/刚跑完，**最后几条消息不出现，或者出现后突然消失**。
- **C**：会话聊得比较久（几十轮以上）之后，最新几条就是没有；**关掉重开也可能还是没有**。

用户明确否定了"给聊天界面加分页"的方向：**历史消息不可变，不该整段重拉再替换**。

## 2. 根因

### 2.1 四处取历史全都写死 `offset: 0`

| 位置 | 现状 | 后果 |
| --- | --- | --- |
| `src/store/cloudStore.ts:708` 打开会话 | `limit: 200, offset: 0` | 永远只拿最老的一页 |
| `electron/cloud/runner.ts:445` 接回 run 铺历史 | `limit: 500, offset: 0` | 重建的时间线缺尾部 |
| `electron/cloud/runner.ts:496` 跑完收尾重拉 | `limit: 500, offset: 0` | 用最老的 500 条**整段替换**时间线 |
| `electron/ipc/cloud-agent.ts:1068` 导出会话 | `limit: 500, offset: 0` | 导出的文档缺最新内容 |

上游 `GET /api/sessions/{id}/messages?limit=&offset=` 是顺序分页（`pagination: {limit, offset, returned}`）。从 0 开始取 = 取最老的一页；会话超过 200 条后，最新消息落在页外 → **C**，且重开走的是同一条请求，所以重开也未必有。

### 2.2 收尾重拉是「整段替换」

`runner.reconcile()` 在 `await listMessages()` 期间，实时帧已经渲染到界面；历史回来以 `{ kind: 'parts', parts }` 整段替换（`cloudStore.ts` 的 `parts` 分支），把**刚到的消息顶掉** → **A**。代码注释已承认这个风险，但只在 `historyFirst` 那条路径做了缓冲。

### 2.3 两个信号一直没人用

- `hasMore`：IPC 返回、类型声明（`src/types/cloud.ts:437`），渲染层**一个字段都不读**。
- `messageCount`：会话列表早就带回总条数（`remote.ts:219`），**没有任何地方用它算 offset**。

## 3. 目标行为

1. 打开长会话，**第一屏就是最新一段**。
2. 一轮正常跑完，时间线**不被替换**，最新消息不会消失。
3. 只有"时间线本来就残缺"（断流 / 重启接回 / 漏帧）时才用历史重建，且重建的也是**尾部**。
4. 导出文档包含最新消息。
5. 不新增任何分页 UI。

## 4. 方案（P0，必修）

### 4.1 主进程：提供「取尾部」的能力

`electron/cloud/remote.ts`

- 新增 `getSession(sessionId)` → `GET /api/sessions/{id}`，取 `message_count`。
- 新增 `listMessageTail({ sessionId, limit })`：
  1. `pageSize = clamp(limit, 1, 500)`；
  2. `count = getSession().messageCount`；`offset = max(0, count - pageSize)`；
  3. 请求该页；**返回空**（`count` 与实际行数口径不一致）→ 回退 `offset: 0`；
  4. 若原始行按时间戳是**降序**，翻转成升序（对分页方向不敏感，不赌一边）；
  5. 返回 `{ parts, hasMore: offset > 0, offset }`。
- 新增 `listAllMessages({ sessionId })`：按 `offset` 从 `count - pageSize` 起往前翻（每页 500，上限 20 页）用于导出全量。

> `mapMessages` 会丢空文本行、把工具行合并成 `t:<callId>`，所以 `parts.length ≠ returned`。水位/offset 一律用 `pagination.offset + returned`，不要用 `parts.length`。

### 4.2 runner：干净收尾不再整段替换时间线

`electron/cloud/runner.ts`

- `reconcile()` 增加 `clean` 入参：`terminal === true` 且本轮**无重订、无断流错、非接回** → 历史**只用于核对审计**（`auditToolOutcome`：工具退出码 / 审批结果），**不推 `parts` 全量帧**。→ A 消失。
- 审计不能省：实时帧的 `preview` 可能为空（"空预览不落盘"是既有约定），历史才是权威 —— 所以历史仍拉一次，只是不推给界面。
- `clean === false`（断流 / 接回 / 漏帧）→ 用 `listMessageTail` 重建（此时时间线残缺，替换才是正确语义），并保留 `reattach` 分隔线。
- `degraded` 的判定点：`historyFirst`（接回）、流内抛错、`attempt >= MAX_STREAM_RETRIES`、以及"还要再订一次"。

### 4.3 渲染层：打开会话取尾部

`src/store/cloudStore.ts`

- `openSession` 改为 `cloudApi.listMessages({ sessionId, limit: MESSAGES_PAGE_SIZE, tail: true })`。
- 记录 `partsHasMore = result.hasMore === true`（本期只记录不渲染，为 P1 留口）。

### 4.4 IPC / 类型

- `electron/ipc/cloud-agent.ts`：`cloud:messages:list` 入参增加 `tail?: boolean`；`tail` 时走 `listMessageTail`。
- `cloud:session:export`：改走 `listAllMessages`（导出要完整，不是一屏）。
- `src/types/electron.d.ts`、`src/api/cloud.ts`：补 `tail`，并补 Web mock 分支。

## 5. 派生项（P1，可以先不做）

| 项 | 触发 | 说明 |
| --- | --- | --- |
| 会话开着时别处新增（网页 / 另一台设备 / cron） | 窗口聚焦 / 收到终态帧 | 记「已同步水位」`sessionSync[sessionId]`（内存），只请求 `offset = 水位` 之后的行，用新帧类型 `partsAppend` 追加（`upsertPart` 合并）。因为只追加**之后**的新行，不会与已显示内容重叠，天然没有去重问题。 |
| 服务端改 / 删消息、分支回滚 | 用户显式点「重新加载」 | 增量永远看不到这类变化，保留一个全量重建入口兜底。 |
| 「加载更早」 | 用户向上翻 | 用户明确不要，除非后续提。 |

## 6. 测试

| 文件 | 用例 |
| --- | --- |
| `tests/cloud-remote.test.ts`（+6） | 短会话一次请求；满页跳尾部 `offset=700`；取不到总数回退第一页；尾部空页回退；降序翻成升序；**降序部署不往回跳**；`listAllMessages` 多页拼齐 |
| `tests/cloud-runner.test.ts` | 干净终态**不**推 `parts` 帧；断流重订后才推；历史仍被拉一次（审计）；接回"历史先铺、增量在后" |
| `tests/cloud-store.test.ts` | `openSession` 传 `tail: true`；`partsHasMore` 落 state；切换会话重置 |
| `tests/cloud-agent-ipc.test.ts` | `cloud:messages:list` 的 `tail` 走尾部（1200 条 → offset 700）；干净收尾不推历史帧但确实请求过历史 |

## 7. 验收

- 造一个 >200 条的会话（或拿现有长会话）：打开 → 最新几条在场；再发一轮 → 跑完不消失；导出 md → 含最新内容。
- **限制**：dev 设备未配对、网关侧 `/api/config` 502，真机验证需要一次配对，或临时加一条诊断日志打印 `messageCount / offset / returned / 首尾时间戳` 供人工核对后再删。

## 8. 风险与回滚

| 风险 | 处置 |
| --- | --- |
| `message_count` 与实际行数口径不同 → 取到空页 | 回退 `offset: 0`，退化为当前行为，不会更糟 |
| 上游其实是降序分页 | 时间戳翻转；无时间戳则保持原序并 `warn` 一次（行为等同现状） |
| 跳过历史导致工具结果缺失 | 只在 `clean === true` 时跳过；断流/接回仍重建 |
| 回滚 | 改动集中在 remote / runner / cloud-agent IPC / cloudStore 四处 + 一个入参 `tail`，`tail` 缺省 `false` 即回到旧行为 |

## 9. 影响面

改动 6 个文件（4 实现 + 2 类型/API），新增 1 个测试文件、改 3 个既有测试，不碰 UI、不碰设计系统。
