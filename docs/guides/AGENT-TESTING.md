# Pi Agent 测试清单

> **面向**：要手动验收 Agent 功能的人
> **什么时候读**：改了 Agent 初始化 / 对话 / 工具 / 会话恢复之后
> **什么时候要改**：验收步骤与实际行为不一致时（当前能力以 STATUS 为准）

> **历史说明（2026-10-26）**：本清单记录 Phase 1 的验收步骤。关闭工作区后运行时释放，但标签与草稿会落盘并在重新打开时恢复；Agent 修改以消息内变更卡展示。当前功能以 [STATUS.md](../progress/STATUS.md) 为准。

适用于 Phase 1 完成后的验收测试。支持 Electron 与纯 Web（开发模式）两种环境。

---

## 🚀 启动

```bash
npm install

# Electron（完整功能：Agent + 文件系统 + 真实工作区）
npm run dev

# 或仅 Web（开发调试：Agent 由 Vite dev 中间件承载，工作目录固定为项目根目录）
npm run web:dev
```

`npm run dev` 会先自动构建 `pi-bridge` 与主进程（`predev`），无需手动 build。

---

## ✅ 测试项

### 1. 模型拉取

**步骤**:
1. 打开 Settings（右上角 ⚙️）
2. Provider 选择 `Custom (OpenAI-compatible)`（或 Anthropic / OpenAI）
3. 填写 API URL（如 `https://api.deepseek.com/v1`）与 API Key
4. 点击 **Fetch Available Models**

**预期**:
- ✅ 模型下拉出现供应商真实返回的模型（数量显示在 "Model (N available)"）
- ✅ 成功时右上角出现绿色 Toast
- ✅ Key/URL 错误时出现红色 Toast，包含 HTTP 状态和供应商原始错误

### 2. 保存配置

**步骤**: 选择模型后点击 **Save Configuration**

**预期**:
- ✅ Toast "API configuration saved"
- ✅ Electron 模式下生成 `config/api-config.json`，其中 `apiKey` 为 `enc:` 开头的密文
- ✅ `data/agent/models.json` 中不含明文 Key（应为 `"apiKey": "$PI_WORKBENCH_API_KEY"`）

### 3. Agent 初始化

**步骤**:
1. 点击 **打开项目** 选择工作区（Electron）
2. 观察聊天面板标题

**预期**:
- ✅ 头部标题为「Pi Agent 对话」，不显示常态「就绪」文字或状态点（仅初始化期间把标题替换为「初始化中…」）
- ✅ 未配置时显示 "API Configuration Required"，点击 Go to Settings 能打开设置面板
- ✅ 控制台无 `preload-error`；Electron 启动日志包含 `[Main] Preload check: window.electronAPI = object`

### 4. 基础对话

输入: `Hello, can you help me?`

**预期**:
- ✅ 收到真实模型回复（观察耗时与供应商后台的调用记录）
- ✅ 消息追加到历史并自动滚动
- ✅ 加载期间显示 "Thinking..."

### 5. 工具调用

输入: `List the files in the current directory and summarize this project`

**预期**:
- ✅ Agent 调用 read/bash 工具并给出基于真实文件内容的回答
- ✅ Electron 模式下的工具操作作用于所选工作区

### 6. 错误透传

**步骤**: 故意把 API Key 改为无效值并保存，然后发送一条消息

**预期**:
- ✅ 聊天面板显示 `Error: 401 ...`（供应商原始错误），而不是 "no text response"

### 7. 配置变更生效

**步骤**: 修改模型 → Save

**预期**:
- ✅ ChatPanel 自动重新初始化（`api-config-saved` 事件），标题模型名更新

### 8. 最近工作区与状态隔离

**步骤**:
1. 打开工作区 A，进行一段对话
2. 关闭项目，观察欢迎页
3. 点击“最近打开”中的工作区 A 重新打开

**预期**:
- ✅ 欢迎页列出最近打开的工作区（最多 10 个，来自 `data/workspaces.db`），可直接点击打开
- ✅ 关闭后运行时释放，打开的文件与会话标签、草稿保留在磁盘
- ✅ 重新打开后标签、草稿与会话历史全部恢复，不会串到其他工作区

### 9. 会话持久化

**步骤**: 进行一次对话 → 完全退出应用 → 重新启动并打开同一工作区

**预期**:
- ✅ 聊天历史自动恢复（来自 Pi 会话文件），无需重新提问
- ✅ Agent 能理解上一轮上下文（追问“刚才那个文件叫什么”）

### 10. Agent 修改与 Diff

**步骤**: 让 Agent 创建一个文件，例如
`Create a file named hello.txt containing hello world`

**预期**:
- ✅ 文件真实写入工作区
- ✅ 出现 Toast “Agent modified 1 file(s)”
- ✅ 助手消息内出现本轮变更卡，点开可查看该文件的 Diff

### 11. 文件操作与监听

**步骤**:
1. 在文件树中右键文件 → 重命名 / 删除
2. 在编辑器打开一个文件，在外部修改并保存

**预期**:
- ✅ 重命名/删除成功，目录树自动刷新，失效的编辑器标签被关闭
- ✅ 外部修改后编辑器内容自动同步（本地无未保存修改时）
- ✅ 外部删除后对应标签自动关闭

### 12. 未保存保护

**步骤**: 修改文件后在 2 秒内关闭标签 / 关闭工作区 / 关闭窗口

**预期**:
- ✅ 出现确认提示；取消后修改保留
- ✅ 标签页的未保存圆点正确显示

---

## ☁️ 云端单入口（G1）验收 —— 逐条手点

> 什么时候跑：改过网关插件（独立仓库 [T-Chen-CN/pi-workbench-plugin](https://github.com/T-Chen-CN/pi-workbench-plugin)，不在本仓库）、`electron/cloud*`、连接页之后。
> 插件侧先跑 `python -m unittest discover -s tests -t .` + `hermes plugins validate .`；本清单是**真机**那一步。
> 判据出处：[CLOUD_AGENT_DEVICES §20.2](../requirements/CLOUD_AGENT_DEVICES.md)。
> 全部通过 = 本地与云端只剩一条门（设备 token 是唯一凭据）。

### 0. 前置（每次开工 30 秒）

| 检查 | 命令 / 位置 | 应该是 |
| --- | --- | --- |
| 云端网关活着 | `curl -s https://hub.tchen-xiaoxiao.com/v1/hub/health` | `status:ok`、`upstreamOk:true`、`adminKeyConfigured:true` |
| 本机已配对 | 连接页「云端网关」卡 | `这台设备已配对` + `chat / dispatch` + 上游版本 `0.22.6` |
| 首次 / 重新配对 | 服务器生成一次性连接码 | 把 `https://hub.…/#pair=XXXXX-XXXXX` 粘到连接页「连接码」并点「配对并连接」；管理密钥不进入桌面端（插件 Phase 2 完成后可用） |
| 记录起点 | 连接页设备卡的 `deviceId` | 抄下来（后面每一步都要能和云端审计对上） |
| 清空干扰 | 关闭其他正在跑的会话 | 避免事件流串台 |

**云端留痕（出问题先看这里）**

```bash
ssh … 'tail -f ~/.hermes/profiles/pi-cloud/plugin-data/pi-workbench/audit.jsonl'
```

每条带 `deviceId` / `path` / `status` / `ip`；本机侧对着 `logs/main.log`（`[Cloud]` 前缀）看。

---

### 1. 自检：三条通道各自可达

**步骤**
1. 连接页点「刷新状态」。
2. 打开云端「自检」（诊断）页。

**预期**
- ✅ 网关卡显示已配对、上游在线，并且有一行 **「心跳正常 · 刚刚同步」**（30s 一拍）。
- ✅ 在云端 `audit.jsonl` 里能看到 `POST /v1/devices/me/heartbeat` 200（约每 30s 一条）。
- ✅ 自检里 API / dashboard / SSE 三项都绿；显示的上游版本是 `0.22.6`。
- ❌ 若「已配对但上游没响应」→ 是 Hermes 进程问题，不是网关（跳到 §12-B）。

---

### 2. 纯文本对话（最小闭环）

**步骤**
1. 新建一条云端会话。
2. 发：`只回复两个字：收到`

**预期**
- ✅ 文字**流式**出现（不是一次性蹦出来）；状态从「思考中」到「完成」。
- ✅ 云端审计出现 `http.post /v1/runs` 202 与 `http.get /v1/runs/<id>/events` 200。
- ❌ 一次性出现 = SSE 被缓冲了（查 Caddy `flush_interval -1`、插件 `X-Accel-Buffering: no`）。

---

### 3. 工具调用（工具卡 + 结果回填）

> 提醒：云端 Agent 的**工具在 VPS 上执行**，不是本机。看结果就行，别去本机文件树找文件。

**步骤**
发：`列出当前工作目录的文件名，最多 10 个`

**预期**
- ✅ 出现工具卡，参数可见，结果展开后是真实文件名。
- ✅ 卡片状态从「运行中」变「完成」；时间线顺序不乱。
- ℹ️ 工具**失败**时卡片是红的，而且上游 `tool.completed` 只回 `error:true` + 空 `preview`
  （2026-11-06 实测：`ls /root/nonexistent-dir` → `error:true, preview:""`）。所以卡片里会显示
  「上游只回了失败状态，没带错误内容（多半是命令退出码不是 0）」——**这是上游的粒度，不是我没渲染**。
  想看真实报错就看结果回填（§2 说的时间线校正帧会重拉历史）。

---

### 4. 审批三档（安全边界）

> ⚠️ **先说清上游语义**：Hermes 的 `approvals.mode: manual` 只对**危险 shell 命令**
> （`rm -r*`、`mkfs`、`dd`、`kill`、`shutdown`…）和**少数敏感文件路径**（如 `~/.ssh/config`）
> 要审批；**普通文件写入不弹审批**（`tools/file_tools.py` 只对敏感路径走审批门）。
> 所以「创建文件没要我批准」是上游设计，不是本项目的 bug。想看审批卡，要用危险命令。

**步骤**（同一条会话里依次做）
1. 发：`在 /tmp 下建一个目录 g1-probe，然后用 rm -rf 把它删掉`
2. 审批卡出现时点 **`once`**（仅这次）
3. 再发同一句，这次点 **`session`**（本会话内不再问）
4. 再发同一句，这次点 **`deny`**（拒绝）
5. 另开一条**新会话**，再发同一句 —— 审批卡应该**重新出现**（`session` 不跨会话）

**预期**
- ✅ `once`：命令真的执行（工具卡回执可见 `rm -rf` 结果）。
- ✅ `session`：**同一会话**再发同一句，**不再弹审批**；**新会话仍弹**。
- ✅ `deny`：工具卡显示被拒 / `BLOCKED`，目录**还在**（`ssh … 'ls -d /tmp/g1-probe'`）。
- ✅ 每一步云端审计都有对应 `approval` 记录；本机 `logs/main.log` 有回执日志。
- ❌ 点 `deny` 却执行了 → 立刻停手，这是安全问题（看审计里 `decision` 字段）。

---

### 5. 插话（steer）

**步骤**
1. 发一条会长一点的请求：`写一段 300 字的说明，主题是这个项目为什么用 Electron`
2. 在**还在输出时**，在输入框发：`改成 100 字，用英文`

**预期**
- ✅ 输入框发送后出现「已插入」回执，不是新开一轮。
- ✅ 输出方向改变；时间线**不重复**（同一段文字不会出现两遍）。

---

### 6. 停止

**步骤**
1. 发：`一直数下去，每秒一行，不要停`（或任意长任务）
2. 3 秒后点「停止」。

**预期**
- ✅ 立刻停止输出，状态变「已停止」；按钮不再转圈。
- ✅ 云端审计有 `http.post /v1/runs/<id>/stop`。
- ❌ 停了还在出字 → 事件流没断开（插件 `stream()` 未跟随客户端断开）。

---

### 7. 跨重启接回（耐久性）

**步骤**
1. 发一条长任务（同上）。
2. 输出到一半，**直接关掉应用**（不是停轮次）。
3. 等 10 秒，重新 `npm run dev`，打开刚才那条会话。

**预期**
- ✅ 自动接回：历史先补齐，然后继续接收增量。
- ✅ **历史不重复**（旧文字不会出现两遍）；审批卡如果当时没处理，会补出来。
- ❌ 时间线重放整轮 = `Last-Event-ID` 没顶到上限（看 `electron/cloud/runner.ts` 的 attach 分支）。

---

### 8. 图片（dashboard 侧通道经网关）

**步骤**
1. 粘一张图发送，让它描述图片内容。
2. 再让它把刚才那张图**读回**（或触发读回操作）。

**预期**
- ✅ 上传成功、模型能看到图；读回时图片正常显示。
- ✅ 这一步**不需要**控制台令牌 —— 现在用设备 token 经网关转发。
- ❌ 401 → 设备 token 已失效 / 未配对；旧 `dashboardToken` 会在连接页读取配置时自动清掉，不再是干扰源。

---

### 9. 会话管理（`/api/sessions*` 透明代理）

**步骤**：刷新列表 → 搜索关键字 → 改名一条 → 打开另一条 → 删除一条（先确认能新建）。

**预期**
- ✅ 列表分页正常、搜索命中、改名后列表与标题都变、删除后消失。
- ✅ 审计里能看到 `GET/PATCH/DELETE /api/sessions…`。

---

### 10. 任务页（`/api/jobs*`）

**步骤**：打开任务页 → 触发一次任务（或查看历史）→ 暂停 / 继续。

**预期**
- ✅ 任务列表能读出来；操作有回执、状态跟着变。

---

### 11. 失败语义 A：网关挂掉

**步骤**

```bash
ssh … 'sudo systemctl stop hermes-gateway-pi-cloud'   # 先停网关
```

然后在应用里发一条消息。

**预期**
- ✅ 明确报「**网关不可用 / 连不上网关**」，**不是**含糊的网络错误，也**不是**悄悄成功。
- ✅ 界面其余部分可用（不白屏）。

恢复：

```bash
ssh … 'sudo systemctl start hermes-gateway-pi-cloud'
```

---

### 12. 失败语义 B：只停 Hermes 上游

**步骤**

```bash
ssh … 'sudo systemctl restart hermes-gateway-pi-cloud'   # 先确保网关在
ssh … 'HERMES_HOME=… hermes --profile pi-cloud gateway stop'  # 或停 api_server
```

再发一条消息。

**预期**
- ✅ 报「**Hermes 异常 / 上游没响应**」，与 A 的文案**不同**（能区分是哪一层坏了）。
- ✅ 网关自己的 `/v1/hub/health` 仍返回 200，但 `upstreamOk:false`。

---

### 13. 注销 → 拒绝 → 再登记

**步骤**
1. 网关卡点「注销这台设备」。
2. 发一条消息。
3. 再填管理密钥点「登记这台设备」。
4. 再发一条消息。

**预期**
- ✅ 注销后卡变成未登记态；**会话区立刻变成不可用**（顶部提示「已注销，需重新登记」，能力与会话清空）。
- ✅ 发消息**明确失败**（本地只有网关一条路，没有任何直连残留）。
- ✅ 再登记立刻恢复（同一 `deviceId`，token 换了：云端审计里 `rotated:true`）。
- ✅ 旧 token 已失效（可让旧设备再请求一次验证 401 `device_revoked`）。

---

### 14. 收尾：审计对账

**步骤**：把本次所有操作的 `deviceId` 与云端 `audit.jsonl` 对一遍。

**预期**
- ✅ 每条请求都有 `deviceId`（不该是 `null`，除 `register` 那一条）。
- ✅ 没有出现绝对路径泄露（`path` 只有 URL 路径，没有本机文件系统路径）。
- ✅ 拒绝/限流类错误也留在审计里。

---

### G1 通过标准

12 项（第 2–10 项 + 11/12/13 三条语义）全绿 = **G1 通过**。

任何一项不绿，先按表定位到底是哪一层：

| 现象 | 大概率在哪 |
| --- | --- |
| 完全连不上、超时 | Caddy / 网关进程 / DNS |
| 401 / 403 | 设备 token、scope、审计里看 `device_revoked` / `scope_required` |
| 502 / timeout | Hermes 上游（api_server 端口、进程） |
| 一次蹦完、不流式 | SSE 缓冲（Caddy `flush_interval`、插件头部） |
| 卡片重复、时间线乱 | `Last-Event-ID` / 重订阅逻辑（`runner.ts`） |
| 图片 401 | dashboard 侧通道凭据（现在应是设备 token） |

---

## 🔧 常见问题

| 现象 | 排查 |
|---|---|
| 点击 Fetch 无反应 | 查看 DevTools Console 是否有 `[API] window.electronAPI is undefined`（说明 preload 未加载） |
| Fetch 返回空列表 | 供应商 `/models` 不支持或 Base URL 少了 `/v1`；看红色 Toast 的 HTTP 错误 |
| Agent 显示初始化失败 | 检查 `models.json` 是否生成、模型是否在拉取列表中 |
| Electron 模式读不到配置 | 确认 `config/api-config.json` 存在；Web 模式没有 `safeStorage`，配置走 `src/api/index.ts` 的 mock，存在 **localStorage**（与 Electron 的 `config/*.json` 不同步） |

---

## 📁 关键文件

| 文件 | 说明 |
|---|---|
| `config/api-config.json` | API 配置（Key 加密） |
| `data/agent/models.json` | Agent 模型配置（不含明文 Key） |
| `data/agent/sessions/` | Pi 会话文件（对话历史与上下文） |
| `config/settings.json` | 应用设置（最近工作区在 `data/workspaces.db`） |
| `cache/temp/web-agent/` | Web dev 模式的临时 Agent 数据（可随时删除） |
| `pi-bridge/src/agent-manager.ts` | Agent 初始化与对话实现 |
| `electron/ipc/api-config.ts`、`electron/ipc/agent.ts` | IPC：`apiConfig:*`、`agent:*` |
