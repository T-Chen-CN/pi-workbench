# 云端 Agent（apps/cloud）—— 实现与运维

> 需求与验收在 [CLOUD_AGENT_PI](../requirements/CLOUD_AGENT_PI.md)（v3.3，唯一需求源）。
> 本文只讲**怎么实现的、怎么部署、坏了怎么查**。设计与取舍去读需求文档的 D-01~D-34。

---

## 1. 组成

| 位置 | 角色 | 有没有 fs / bash |
| --- | --- | --- |
| `apps/cloud`（`@pi-workbench/cloud`） | 云端控制面 + 数据面 + **唯一的云端会话** | **没有**（工具白名单只有 6 个） |
| `pi-bridge/src/cloud-protocol.ts` | 协议契约（帧、状态机常量、事件载荷） | — |
| `electron/cloud/*` | 桌面端内置的终端执行器（device agent） | 有（工单在自己的 worktree 里跑） |
| `apps/cloud/web/*` | Web 客户端（纯 ESM，零构建） | — |
| `src/components/CloudView.tsx` | 桌面端云端页（独立视图） | — |

三端共用**一套帧格式**，渲染各自实现：桌面端不用 `chatStore` / `workspaceStore` / `diffStore`。

## 2. 进程与目录

```
浏览器 / 桌面端 ──WSS /client/ws──┐
                                  ├── Caddy :443 ──> 127.0.0.1:8787 (apps/cloud)
终端 device agent ─WSS /device/ws─┘
```

云端数据目录（`PI_CLOUD_DATA_DIR`，默认 `/var/lib/pi-cloud`）：

| 文件 / 目录 | 内容 |
| --- | --- |
| `accounts.json` | 唯一管理员：`scrypt` 哈希 + salt |
| `devices.json` | 设备记录；token 只存 `SHA-256(token + salt)` |
| `pairing.json` | 6 位一次性码（5 分钟，CAS 作废） |
| `config.json` | 云端模型配置；API Key 为 AES-256-GCM 密文（`v1.iv.tag.ct`） |
| `tasks.json` / `units.json` / `authorizations.json` | 工单、工作单元、授权台账 |
| `agent/` | 云端会话（Pi SDK 的 agentDir）：`sessions/*.jsonl` 是历史与导出的唯一真相源 |

桌面端只落两处：`{appDir}/config/cloud-link.json`（token，`safeStorage` 加密）与
`{appDir}/data/cloud/`（工单台账 `units.json` / `tasks.json`、工单会话独立 `agent/`）。

## 3. 关键实现点

### 3.1 云端会话（单会话）

- `initialize()` 之后用 `openSession()` 续**最近一个**会话 → 重启不丢上下文；从不 `createSession()`。
- 用户消息：空闲时 `chat()` 开轮；忙时 `steer()` 插话（单会话串行）。
- 工单事件：`sendCustomMessage({ customType: 'task-event', triggerTurn: true, deliverAs: 'followUp' })`，
  2 秒合并一次（`CloudSession.wake`）。**不冒充用户授权**：事件消息带 `details`，模型看到的是事件。
- `subscribeTrace` 是**常驻订阅**（PR1 的内核改造）：`sendCustomMessage` 起的轮次不经过 `chat()`，
  一次性 `onTrace` 收不到它的轨迹。
- 压缩前钩子 `session_before_compact` → `onSessionBeforeCompact`（P1 的记忆抽取挂这里）。

**配置轮换（F-13 / A-16）**：不在 `agent_settled` 里重建，而是放在**每个入口的 `ensureAgent()` 里**判定
（`say` / `flushEvents` / 快照都会先过它）：

1. 比 `runningConfigStamp` 与磁盘配置的 `updatedAt`；相同就直接返回（最常见路径零成本）。
2. 本轮在跑（`session.isBusy()`）就**不动**，等下一轮开始前再生效 —— 绝不打断进行中的轮次。
3. 换配是“**先探测、再拆、后建 + 失败回滚**”：`dispose()` 之前先 `probeConfig()` 打一次供应商
   `/models`（纯 HTTP，不碰运行时）。
   - 探测失败（连不上 / 401 / 模型不在清单）→ **不拆**，`failedConfigStamp` 记下这份，推一条
     “新配置不可用…已保留原配置运行”的 notice，旧实例毫发无伤。
   - 为什么必须探测：`initialize()` 只校验“模型 id 在本地 models.json 里”，而那份文件正是按
     apiConfig 生成的 —— 任何 Key 都能初始化成功，不探测就会出现“错 Key 报已生效、下一句话才炸”。
   - 探测通过后仍可能建不起来（结构性失败）→ 用内存里的 `lastGoodConfig` 重建并推回退 notice。
   - **首次建运行时（`ensureAgent` 冷启）不探测**：拉历史要经过这里，不能依赖供应商可达。
   为什么不“先起临时实例验证再切”：`initialize()` 会写进程级 Provider Key，校验失败释放会把环境
   还原成**进程原值**而不是旧 Key，反而毒掉旧实例（§3.1 的引用计数）。
4. 同一份坏配置只试一次（`failedConfigStamp`），不会每个入口都拆一次运行时。

`cloud-session` 因此多了一个 `ready` 屏障：重建窗口里运行时与 `sessionId` 都不可用，
用户消息与事件唤醒必须先 `await` 它，否则会撞到已 dispose 的会话。

### 3.2 工单

- 状态机：`queued → assigned → running → waiting_human ⇄ running → done | failed | cancelled`；
  终态先落者胜，后到的终态只作 `ignored` 附注。
- 单设备并发 1、全站活跃工单并发上限 8（`CLOUD_MAX_CONCURRENT_SESSIONS`，A-21 / D-15）：超出上限保持 `queued`（`dispatchedAt: null`，不计 ACK 超时）并推送可读排队提示；任意工单进终态后按 FIFO 补投同设备与全站队首。`queued` 60 秒未接单、`waiting_human` 2 小时未回答 → 超时收敛；
  **设备离线 → 未完成工单直接 `cancelled(device-offline)`，不续跑**（F-21）。
- **停滞看门狗（C-02）**：终端跟踪 `tool_start` / `tool_update` / `tool_end`，同一工具连续 10 分钟无输出增量上报 `task_stalled`（同一停滞只报一次），工单运行期每 60 s 发 `task_heartbeat`（只刷新设备在线时间，不重置静默计时）；云端 `sweepTimeouts()` 对 20 分钟无进度事件的 `running` 工单主动唤醒一轮 `get_task` 检查（同一静默只报一次）。
- 幂等：`idempotencyKey`（`workUnitId` + 内容摘要），重复派活返回同一张工单。
- 派活强制校验（G9）：`authorizationId` × 设备 × 仓库（路径归一化后比较）× 额度 × 有效期。
  同一工作单元追加的工单不扣额度（O-06）。已结束 / 正在回收的单元拒绝新工单（`unit-closed`）。
- **改动清单**（`task_result.changedFiles`）= 工具轨迹 ∪ `git status --porcelain` ∪ `git diff --name-status <base>...HEAD`。
  第三个不能省：模型常用 bash（`printf > f && git commit`）改文件，工具轨迹里没有它、提交后 status 又是空的，
  少了它就会在云端显示「没有检测到文件改动」而分支上明明有提交。工具报的路径必须归一化到工作树相对路径，
  树外的（含 Windows 跨盘符，`path.relative` 会原样返回绝对路径）一律丢弃。

### 3.2.1 工作树回收（F-19a / A-43 / A-46）

**干净就自动回收，脏才手动**。判定放在云端，因为只有它知道该单元还有没有后续工单：

| 工单进终态时 | 动作 |
| --- | --- |
| `result.worktreeClean === true` 且该 `unitId` **无非终态工单** | 自动下发 `close_unit`（无需用户点击） |
| 干净但同单元还有排队/待派工单 | **不动**（此时删树会让下一张从 base 重开、丢掉上一张的 commit） |
| 脏树 / 没上报 `worktreeClean` | 保留，等用户手动“结束工作单元” |

终端侧两个前提（都是踩过的坑）：

- **收到工单先回 `assigned`**，再建工作树 / 建会话。准备阶段失败（未配 API Key 最常见）时云端只有
  `queued → failed` 这一条路，不回 `assigned` 会让工单永远挂在“执行中”并堵住 FIFO。
- 准备阶段失败也要带 `worktreeClean`：工作树已经建好却不上报脏标记，云端就不会发 `close_unit`，
  那棵树会一直躺在磁盘上直到桌面端重启（启动 sweep 才补报 `unit_state`）。

配对握手：请求时只写 `closeRequestedAt`，**收到 `unit_closed` 回执才写 `closedAt`**；`dirty` 时
`closedAt` 保持 null 并写 `dirtyAt`（= 待清理，清理后可再结束一次）；回执带 `error`（删树失败）时
只清 `closeRequestedAt`、什么都不写——单元仍是未结束状态，可以重试。

回收的三种结果由 `coordinator.release('cloud:<unitId>')` 自身决定：脏树保留 / 干净且无新提交
删工作树与分支 / 有提交只删目录并保留 `pi/*` 分支（commit 存活）。

**人工入口**（同一个 `requestUnitClose`）：`POST /v1/units/:id/close`（Web）· 客户端帧 `close_unit`
（桌面端云端页“工作单元”分区）· Git 视图里 `cloud:*` 工作树的「云端 / 结束并回收」（同一个帧，只是换了入口，
因为用户在 Git 面板里才看得到这棵树）。单元里还有非终态工单时返回 `task-running`，提示先停工单——
不去 auto-abort，否则 abort 那一刻还没落盘的文件会被当成脏树留下。

**兜底**：设备启动 / 重连时 `sweepUnits()` 对本地台账里每个单元跑一次 `git status --porcelain`，
发 `unit_state`；干净且已收敛的单元会被云端自动回收。覆盖“离线被取消 / 进程被杀”漏掉的那些。

### 3.3 终端执行器（`electron/cloud`）

- **一个工作单元一个 worktree**：`coordinator.bind('cloud:<unitId>', 'new', base)`，一条合成绑定；
  工单会话用 `createSession(worktreePath)` 建在工作树里，**自己不 bind**（G12）。
- 工单会话的 AgentManager 用**独立 agentDir**（`data/cloud/agent`），不进用户会话列表（D-24），
  但 `apiConfig` 复用用户当前配置（SDK 的 Key 是进程级串写的）。
- **压缩参数写在 `data/cloud/agent/settings.json`**（`compaction.reserveTokens 8192` / `keepRecentTokens 12000`）：
  `models.json` 的 `contextWindow` 只有四档，写别的值会被静默回落成 128k，想让工单更早压缩只能改这里。
  只覆盖这三个键，其它字段原样保留；模型配置同步只写 `models.json`，不会覆盖它。
- 装配：`builtinExtensions: { plan: false, worktree: false }` +
  `toolAllowlist: ['read','ls','grep','find','edit','write','bash']` + 权限 `mode: 'auto'`（G3）。
- 守卫（G8 / D-32，`task-guard.ts`）：`write` / `edit` 的绝对路径必须落在工作树内；
  `bash` / `powershell` 拦 `git push`、`curl … | sh`、工作树外的 `rm -rf`。
  **handler 自己 catch**：`tool_call` 分发循环没有 try/catch，抛错会掀掉整轮。守卫是
  **挡误伤与注入的主流路径，不是安全边界**（D-20：路径限制可被 bash 绕过，所以不做路径级硬限制）。
- `ask_cloud`：上报问题后**结束本轮**，回答到达再起一轮（不做阻塞等待）。
- 崩溃恢复（G6）：启动时把台账里残留的 `running` 工单改判 `interrupted` 并上报；
  退出前把在跑的工单标 `interrupted` 并尽量把队列冲出去。
- 工单结束会当场判一次工作树是否干净（`git status --porcelain`，ignored 文件不算脏 → 装了依赖也算干净），
  写进 `task_result.worktreeClean`；停止 / 失败 / 退出也带上，服务端据此自动回收。
- `closeUnit(unitId)`：走 `coordinator.release('cloud:<unitId>')`，成功后删 `units.json` 台账；
  脏树保留台账，方便清理后再结束一次；
  脏树那次回执已把绑定删掉，所以再次结束会先 `bind()` 重挂（否则 `release()` 只会空转并错报“已回收”）。
  **不手写 `git worktree remove`**：`release()` 内部有串行队列并会终止依赖安装。

### 3.4 通道与恢复

- 心跳 25 秒；服务端 60 秒收不到 → 判离线；客户端/设备都是 `seq` 递增 + `lastAckSeq` 续传，
  增量溢出（2000 条 / 24 小时）→ 回整份快照。
- **解绑（F-08 / A-15）**：服务端在 WS **升级阶段**回 `HTTP/1.1 401`，拿不到 WS 关闭码，
  所以两个客户端都监听 `unexpected-response` 并按 401/403 判「已被云端移除」：
  `durableStop` + 状态 `error` + `revoked: true`，**不再重连**；`open()` / `start()` 才会重新武装。
  云端页据此显示横幅并给「解除配对」入口（否则桌面端只能重装才能重新配对）。
- **重连对账（F-21 / A-13 / A-41）**：`hello` 带 `runningTasks`（终端**认为**在跑的工单）。
  服务端只纠正不该继续跑的：已落终态的（离线判定 / 用户停止 / 超时）回 `task_cancel`
  并带原 `terminalReason`；服务端没有记录的孤儿回 `reason: unknown-task`（它已无法汇报，
  留着只会堵住单设备 FIFO）。还在跑的工单不会被这条机制打扰。
- 设备离线期间的帧进有界队列（1000 条），重连后补发；终态工单会清掉它的待投递项。
  `close_unit` 也走这条队列：设备离线时回收请求不会丢，重连后补发。
- 单元相关帧：`close_unit`（服务端→设备，`reason: converged | user-close | sweep`）、
  `unit_closed`（设备→服务端，回收回执）、`unit_state`（设备→服务端，启动/重连的工作树状态）。
- 协议版本不符直接拒绝（`v !== 1`）。服务端置 `fatal` 的错误帧，桌面端客户端通道同样进终止态
  （`fatal: true`，停掉退避定时器 + 云端页常驻横幅），否则旧客户端会无限重连而提示只活在空对话里（F-47 / A-27）。
- Web 控制台的登录态是 30 天固定期限的签名 cookie，**不续期**。过期后 WS 升级被 401 拒、浏览器只给 1006，
  所以握手失败时先回查 `/v1/me`：未登录即回登录页并提示「登录已过期」，不得停在「正在重连…」（REST 401 同路径）。

### 3.5 安全

- 一机一 token（同一 token 开 `/client/ws` 与 `/device/ws`），云端只存加盐哈希。
- 授权入口两端都有：Web 的「确认方案并授权」弹层 + 桌面端云端页同一个弹层
  （`AuthorizeDialog` → 帧 `confirm_plan`）。这个动作本身不派活，只落「设备 × 仓库 + 额度」凭据。
- 配对码 6 位一次性；`/v1/pair` 每来源 5 次 / 5 分钟 + 全局熔断 20 次 / 5 分钟；
  所有凭据类失败对外同一个错误码（不透露「码是否存在 / 过期 / 用过」）。
- 账号类操作（建账号、登录、生成配对码、移除设备）只认 cookie 会话；
  设备 token 只够**改云端模型配置、读快照与授权**（桌面端没有 cookie）。
- Web 客户端零 XSS：只用 `textContent` / DOM 构造，静态文件走白名单（`src/http/static.ts`）。
- 云端 API Key 加密落盘、接口只回末四位；Web / 桌面端写的是同一份配置。

### 3.5.1 对话气泡归谁画

**用户消息也由服务端广播**（`say()` → `message_start(role:user)` + `message_end(text)`，
`messageId = u-<clientMessageId>`）：多端必须看到同一份对话，只靠发起端本地乐观追加的话，
换台设备（或 Web 页）就只看得到 Agent 说的话。发起的端按 id 去重，不会画两遍。

客户端两条约定：收到 `message_start` 先占位（用户行 `streaming:false`），`message_end` **按 id** 收尾，
按 id 找不到才回退到「最后一条 streaming 的 assistant」——启动时加载的历史消息用的是 `h-<序号>` 这类 id。

桌面端 `cloudStore.init()` 必须在已配对时**重新打开客户端通道**：快照（含历史）只在开通道后下发，
不开就是「重启后历史全没了」，而服务端其实一直有。

**游标只有一处定义**：`pi-bridge/src/cloud-protocol.ts` 的 `normalizeResumeCursor()` —— 只有正整数才算
「我收到哪了」，`0` / 负数 / `NaN` / 空串一律归为「没有游标」，此时必须回整份快照；照 0 去重放日志
只会把旧事件播一遍，快照里的消息一条都到不了客户端。三处都用它：服务端 upgrade 解析、
`Hub.sendInitial/resumeClient`（会话层再兜一次）。拼参数用 `clientCursorQuery(lastSeq)`，游标为空时
返回空串（不能拼出 `?lastAckSeq=0`）。Web 客户端是零构建纯 ESM，import 不了协议模块，只能自己写
同样两行（`apps/cloud/web/app.js` 的 `connect()`），改规则时两边一起改。

**`resume(0)` 就是「给我一份快照」**（`buildSnapshotRequest()`）：桌面端 `CloudClientBridge.open()`
在连接已活着时（渲染层重载、云端页重新挂载）主动发这一帧——主进程的 socket 和游标还在，但渲染层
store 已经清空，不复用又不补快照就一直白屏。

服务端同理：`buildSnapshot()` 里先 `ensureAgent()` 再取历史。云端会话是懒初始化的（只在 say / 派活时起），
进程刚重启、还没人说话时 `sessionId` 还是 null，历史就会被投影成空——历史明明躺在 `agentDir/sessions/` 里。
`listen()` 成功后会立刻 `void ensureAgent()` 预热，所以这一句在正常路径上只是兜底，不会把首屏卡在
SDK 初始化上；配置解密失败时才每次快照都往 hub 推一条 `missing-cloud-config` 提示。

### 3.6 拉模型清单（`POST /v1/cloud-config/models`）

浏览器直连供应商的 `/models` 会被 CORS 挡，所以由云端代跑一次，客户端只拿到 id 列表：

- 请求体 `{ provider, apiUrl, apiKey }`，三项都可省：省了就回退到**已保存**的配置（解密后用），
  所以「先保存再刷新列表」也能用；只回 `{ models, provider, apiUrl }`，不回显 Key、不回传供应商响应原文。
- 鉴权头与桌面端一致：`anthropic` → `x-api-key` + `anthropic-version`，其余 → `Bearer`。
- 兼容 `{ data: [{ id }] }` / `{ models: [...] }` / `[...]` 三种形状，去重后排序。
- **SSRF 面**：设备 token 也能让它请求任意 http(s) 地址（单管理员部署的取舍），因此只允许 http(s)、
  15 秒超时、响应截断 256KB；失败统一回 502 + `provider-unreachable` / `provider-error`。
- 两边界面同一口径：拿到列表用下拉，拿到空列表或失败就允许手填（不是所有代理商都实现 `/models`）。

**Web 客户端的两条铁律**：

1. **渲染函数只负责构造并返回节点**。`renderAside()` 曾经写成「去 `querySelector('aside')` 原地替换」——
   可页面里的 `<aside>` 本来就由它生成，于是它永远返回 `undefined`、整栏静默不渲染，
   连带「点生成配对码没反应，切个页面才出现」这类现象。
2. **输入必须存 state，不能只靠 DOM**：整页 `render()` 在收到任何 WS 帧（流式输出）时都会重跑，
DOM 会被重建一次。值只挂在 input 上，等于「说一句话就把刚填的 Key / URL 抹掉」，
拉模型时再整页 render 一次更是必丢。所以配置卡：输入从 `state.configDraft` 回填、`oninput` 立刻写回，
拉模型只做局部更新（换模型字段 + 状态行），保存成功才清 draft。
`tests/cloud-web-config-form.test.ts` 把这两条钉住了（Web 客户端零构建不导出函数，只能做源码断言）；
`tests/cloud-web-app.test.ts` 用 jsdom 起**真实**Web 客户端（打桩 fetch / WebSocket）跑行为：
右栏必须渲染、点配对码当场出现、拉模型不抹输入、流式帧重渲染后草稿与 Key 仍在。

## 4. 本机运行

```bash
npm install                      # 根 workspaces 含 apps/cloud
npm run build:bridge && npm run build:cloud

PI_CLOUD_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
PI_CLOUD_COOKIE_SECRET=dev-secret PI_CLOUD_DATA_DIR=./cache/pi-cloud-dev \
PI_CLOUD_PORT=8787 npm run cloud:start
```

打开 `http://127.0.0.1:8787/` → 建管理员账号 → 生成 6 位配对码 → 桌面端「云端 → 连接云端」填入。
`NODE_ENV !== 'production'` 时 cookie 不带 `Secure`（本机 http 调试）；生产口径不变。

## 5. 部署（`/opt/pi-cloud`）

```bash
# 0) 本机打包（self-contained：dist + web + node_modules + deploy）
node scripts/build-cloud-bundle.mjs

# 1) 传上去
ssh -i <key> ubuntu@<host> 'sudo mkdir -p /opt/pi-cloud/releases && sudo chown $USER /opt/pi-cloud/releases'
STAMP=$(date +%Y%m%d%H%M%S)
tar czf - -C cache/cloud-bundle . | ssh -i <key> ubuntu@<host> "tar xzf - -C /opt/pi-cloud/releases/$STAMP"

# 2) 账号与目录（一次性）
sudo useradd --system --home /var/lib/pi-cloud --shell /usr/sbin/nologin pi-cloud
sudo install -d -o pi-cloud -g pi-cloud /var/lib/pi-cloud /var/backups/pi-cloud
sudo install -m 600 deploy/env.example /etc/pi-cloud/env   # 填 PI_CLOUD_ENC_KEY / COOKIE_SECRET

# 3) 单元、Caddy、备份
sudo install -m 644 deploy/pi-cloud.service /etc/systemd/system/
sudo install -m 755 deploy/backup.sh /opt/pi-cloud/backup.sh
sudo install -m 644 deploy/pi-cloud-backup.service deploy/pi-cloud-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-cloud pi-cloud-backup.timer
# Caddyfile.snippet 贴进站点块后：sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

本机打包脚本产出的是**自包含**运行包（`dist` + `web` + `node_modules` + `deploy`），服务器不跑 `npm install`：
根 `package.json` 的 workspaces 带着桌面端的原生依赖（`node-pty`），即使 `--omit=dev` 也会被算进来。

**已踩过的三个坑（照抄会省一轮）**：

1. **node 路径**：单元里写 `ExecStart=/usr/bin/env node …`。apt 装在 `/usr/bin/node`，nodejs.org tarball 在
   `/usr/local/bin/node`；systemd 服务的 `PATH` 含 `/usr/local/bin`，写死绝对路径在两种装法里必砸一个。
2. **Caddy 日志目录**：站点块带 `log` 时，`/var/log/caddy` 必须存在且属主是运行 Caddy 的用户，否则 reload 直接 400。
3. **`sudo caddy validate` 会以 root 创建那个日志文件**（0600 root:root），之后 caddy 用户再也打不开 →
   reload 一直失败。validate 之后把该文件删掉（`sudo rm -f /var/log/caddy/*.log`）再 reload。

切换版本（`current` 软链 + 健康检查 + 自动回滚）：

```bash
sudo ln -sfn /opt/pi-cloud/releases/$STAMP /opt/pi-cloud/current
sudo systemctl restart pi-cloud
for i in $(seq 1 15); do
  curl -fsS http://127.0.0.1:8787/v1/health && break || sleep 1
done || { sudo ln -sfn /opt/pi-cloud/releases/$PREV /opt/pi-cloud/current && sudo systemctl restart pi-cloud; }
```

回滚就是把 `current` 指回上一条 release 再 `restart`；更新只替换 `releases/`，不碰数据目录。

### 5.1 验收脚本

`apps/cloud/scripts/acceptance.mjs` 跑一遍**不依赖真实模型**的 F / A 项（账号、配对、双通道、快照、
Key 掩码、协议拒绝、授权台账），32 条断言：

```bash
node apps/cloud/scripts/acceptance.mjs https://<域名>
```

前提：目标实例**还没建过账号**（脚本第一步会建临时账号）。跑完想恢复出厂：
`systemctl stop pi-cloud` → 清空 `PI_CLOUD_DATA_DIR` → `start`。

需要真实模型才能验的部分（真派活、里程碑、`ask_cloud` 追问、结果回流）在桌面端配对后手动走
[AGENT-TESTING](../guides/AGENT-TESTING.md) 的云端段。

### 5.2 现网记录

| 项 | 值 |
| --- | --- |
| 域名 / 反代 | `tchen-xiaoxiao.com` → Caddy → `127.0.0.1:8787` |
| 代码 | `/opt/pi-cloud/releases/<ts>` + `current` 软链 |
| 数据 | `/var/lib/pi-cloud`（属主 `pi-cloud`） |
| 配置 / 密钥 | `/etc/pi-cloud/env`（`0600 root:root`） |
| 单元 | `pi-cloud.service`（`Restart=always`、`ProtectSystem=strict`、`LimitNOFILE=65536`）· `pi-cloud-backup.timer`（每日 03:20 UTC） |
| 日志 | `journalctl -u pi-cloud` · `/var/log/caddy/pi-cloud.log`（20MiB × 5） |
| 备份 | `/var/backups/pi-cloud/pi-cloud-<ts>.tar.gz`，留 7 天 |

## 6. 排障

| 现象 | 先看 |
| --- | --- |
| 配对一直失败 | `journalctl -u pi-cloud`；确认 `PI_CLOUD_ENC_KEY` 没换过（换了要重新推模型配置） |
| 「获取可用模型」报 502 | 供应商不实现 `/models` 或该 Base URL 不是 v1 根；直接手填模型名即可 |
| 设备显示在线但收不到工单 | 服务端 `devices.json` 的 `workspaces` 是否为仓库根、`isGit` 是否为 true |
| 工单卡在 `queued` | 终端日志 `[Cloud Task]`；60 秒后会被判超时 |
| 工单失败「not a git repository」 | 非 git 目录不接受派活（G10），先 `git init` |
| 显示「设备离线，工单已取消」 | 正常语义：离线即刻取消，不排队等回来 |
| Web 打不开 / 401 | Caddy 反代与 cookie 的 `Secure` 口径；`/v1/health` 是否能从服务器本机访问 |
| 备份里没有会话记录 | `backup.sh` 排除了 `workspace` / `cache`，但包含 `agent/`；检查 `PI_CLOUD_DATA_DIR` |
