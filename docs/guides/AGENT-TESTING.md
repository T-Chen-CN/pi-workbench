# Pi Agent 测试清单

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
- ✅ 显示 `● Ready` 与欢迎消息 `Pi Agent (<模型名>) is ready!`
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

---

## 🔧 常见问题

| 现象 | 排查 |
|---|---|
| 点击 Fetch 无反应 | 查看 DevTools Console 是否有 `[API] window.electronAPI is undefined`（说明 preload 未加载） |
| Fetch 返回空列表 | 供应商 `/models` 不支持或 Base URL 少了 `/v1`；看红色 Toast 的 HTTP 错误 |
| Agent 显示初始化失败 | 检查 `models.json` 是否生成、模型是否在拉取列表中 |
| Electron 模式读不到配置 | 确认 `config/api-config.json` 存在；Web 模式的配置在 localStorage，不同步 |

---

## 📁 关键文件

| 文件 | 说明 |
|---|---|
| `config/api-config.json` | API 配置（Key 加密） |
| `data/agent/models.json` | Agent 模型配置（不含明文 Key） |
| `cache/temp/web-agent/` | Web dev 模式的临时 Agent 数据（可随时删除） |
| `pi-bridge/src/agent-manager.ts` | Agent 初始化与对话实现 |
| `electron/main.ts` | IPC：`apiConfig:*`、`agent:*` |
