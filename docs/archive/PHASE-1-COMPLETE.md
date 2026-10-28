# Phase 1 完成报告：Pi Agent 真实集成

> **面向**：追溯 Phase 1 实现细节的人
> **什么时候读**：排查 Agent 集成的历史行为差异时
> **什么时候要改**：不再修改（归档文件，历史内容以 Git 为准）

**日期**: 2026-10-20
**状态**: ✅ 完成
**目标**: 用真实 Pi Agent 替换 Mock，打通"模型配置 → Agent 初始化 → 对话"的完整链路

---

## 📋 实际实现

### 1. 依赖与环境

```json
{
  "@earendil-works/pi-coding-agent": "^1.3.0",
  "@earendil-works/pi-ai": "^1.3.0"
}
```

> 注：早期规划中的 `pi-agent-core` / `pi-durable` 并未使用，实际集成的是 `pi-coding-agent` SDK。

**⚠️ Electron 必须 ≥ 39**：Pi SDK 要求 Node ≥ 22.19，而 Electron 28 内置 Node 18。
本项目已升级到 **Electron 44.9.1（Node 24）** 与 electron-builder 26。
（国内网络下载 Electron 二进制可依赖仓库内 `.npmrc` 中的 `electron_mirror` 配置。）

### 2. AgentManager（`pi-bridge/src/agent-manager.ts`）

- 运行在 **Electron 主进程**，与 `electron/main.ts` 同进程
- `initialize(config)`：
  - 将用户的 Provider / Base URL / 模型写入 `{appDir}/data/agent/models.json`
  - API Key 以环境变量插值 `$PI_WORKBENCH_API_KEY` 引用，**不写入磁盘**
  - 通过 `ModelRuntime` 解析出自定义 provider（`pi-workbench/<model>`）并显式选中
  - `createAgentSession()` 创建会话，自带 read / write / edit / bash 工具
- `chat(message)`：
  - 调用 `session.prompt()` 并等待完成
  - 读取最后一条 assistant 消息
  - **正确透传供应商错误**（`stopReason: 'error'` 时的 `errorMessage`）

### 3. 统一 API 配置（替代旧版多 API Key）

- 配置结构：`provider` + `apiUrl` + `apiKey` + `availableModels` + `selectedModel`
- 存储位置：`{appDir}/config/api-config.json`
- **API Key 加密**：Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret），存储格式 `enc:<base64>`；系统不支持时回退明文并告警
- `apiConfig:fetchModels`：真实请求供应商 `/models` 端点
  - Anthropic：`x-api-key` + `anthropic-version`
  - OpenAI / 自定义：`Authorization: Bearer`
  - URL 归一化、HTTP 错误透传、兼容 `data` / `models` / 数组三种返回格式

### 4. Settings UI（`src/components/Settings.tsx`）

- Provider 下拉（Anthropic / OpenAI / Custom）
- API URL + API Key 输入
- "Fetch Available Models" → 真实拉取并填入模型下拉
- Save 后持久化，并通过 `api-config-saved` 事件通知 ChatPanel 重新初始化 Agent
- 全量接入全局 Toast 反馈（成功 / 失败 / 错误详情）

### 5. ChatPanel（`src/components/ChatPanel.tsx`）

- 打开工作区后自动读取配置并初始化 Agent
- 显示 Ready / Initializing 状态
- 未配置时引导打开 Settings（事件驱动，不再是 alert 占位）
- 初始化序号保护：避免 React StrictMode 双重挂载导致重复初始化

### 6. IPC / preload

- preload 以 **CommonJS**（`preload.cts` → `preload.cjs`）单独编译，兼容 sandbox
- 主进程注册 `preload-error` 与开发自检日志，`window.electronAPI` 缺失不再静默
- 开发模式自检确认：`window.electronAPI = object`，`apiConfigFetchModels = function`

### 7. 纯 Web 调试支持（仅开发环境）

`vite.config.ts` 提供两个仅 `serve` 生效的中间件：

- `/__pi/fetch-models`：代浏览器请求供应商模型列表（规避 CORS）
- `/__pi/agent/{init,chat,dispose}`：在 Vite 的 Node 进程里运行同一套 `AgentManager`

渲染进程 `piAgentAPI` 自动选择：Electron → IPC；Web dev → HTTP 桥接。

---

## ✅ 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run type-check` | ✅ 通过 |
| `npm run build`（renderer + main + preload + bridge） | ✅ 通过 |
| Agent 初始化（真实 DeepSeek 配置） | ✅ `pi-workbench/deepseek-chat` |
| 请求到达供应商 | ✅ 无效 Key 返回真实 401 并透传到 UI |
| Web UI 端到端对话 | ✅ 真实模型回复 |
| Electron IPC 端到端（开发版） | ✅ 保存加密配置 / 初始化 / 401 透传 |
| **打包应用端到端（asar）** | ✅ 初始化 / 真实请求 / 错误透传 |
| 模型拉取 | ✅ 真实返回模型列表 |
| 配置保存 | ✅ 加密写入 `config/api-config.json` |

---

## ⚠️ 已知限制（进入 Phase 2 处理）

1. **无流式输出**：`chat()` 等待整轮完成才返回，长回答时 UI 只有 "Thinking..."。→ **Phase 2 已解决**（主进程推送 `text_delta` 增量）。
2. **单 Agent 实例**：同一时间只服务一个工作区；多工作区并行需要 Phase 2 的实例管理。→ **Phase 2 已解决**（2026-10-21 支持同工作区多会话与多工作区并行）。
3. **Web 桥接仅限开发环境**：生产构建的纯 Web 版本没有 Agent，必须使用 Electron。（保持现状，属设计选择）

> 会话持久化、Diff 联动、文件监听、工作区生命周期等已在「Phase 1 加固」中完成，
> 详见 [STATUS.md](../progress/STATUS.md)。

---

## 🔒 架构约束符合性（按实际实现）

| 约束 | 状态 | 说明 |
|------|------|------|
| Agent 运行在主进程 | ✅ | `electron/main.ts` 中动态加载 AgentManager |
| 不新增子进程/Worker 运行 Agent | ✅ | 同进程运行 |
| 所有应用数据在应用目录 | ✅ | `config/`、`data/`、`cache/`、`logs/` |
| API Key 加密存储 | ✅ | Electron safeStorage；Web dev 模式为 localStorage（仅开发） |
| 不使用 `.env` 文件 | ✅ | 配置文件 + 环境变量（进程内） |
| Agent 文件操作走 IPC | ⚠️ 已调整 | pi-coding-agent 内置工具在主进程直接操作文件系统，不经过渲染进程 IPC；安全边界仍是主进程 |

---

## 🚀 使用方式

### Electron

```bash
npm run dev     # 自动先构建 bridge + main/preload，再启动 Vite + Electron
```

1. 打开项目文件夹
2. Settings → 选择 Provider、填写 URL/Key → Fetch → 选模型 → Save
3. 在 ChatPanel 中对话

### 纯 Web 调试

```bash
npm run web:dev
```

配置保存在浏览器 localStorage；模型拉取和 Agent 对话通过 Vite dev 中间件真实执行。

---

**下一步**: Phase 2（工作区管理与会话持久化）。建议优先处理流式输出与会话恢复。
