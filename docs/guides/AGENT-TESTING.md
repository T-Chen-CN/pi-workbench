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
