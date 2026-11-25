# 供应商预设与鉴权（8 家）

> **面向**：实现 / 评审这套改造的人
> **什么时候读**：动供应商配置、模型能力、鉴权登录、`models.json`、设置页「供应商」、云端模型配置时
> **事实源**：本文是落地方案；进度看 [BACKLOG P-01](../progress/BACKLOG.md)
> **相关**：[agent-runtime](../agent/agent-runtime.md) · [paths-and-storage](../agent/paths-and-storage.md) · [ipc-and-trust](../agent/ipc-and-trust.md) · [cloud-agent](../agent/cloud-agent.md)

---

## 1. 背景与目标

现状：设置页只有「API 地址 + Key + 拉取模型」，底层写一个自造的 `pi-workbench` provider 到 `models.json`。结果：

- 供应商差异（`max_tokens` 字段名、思考格式、Anthropic 空 text 块、OpenAI responses 协议）全靠 URL 猜，**实际只有 `api.deepseek.com` + `deepseek-flash` 可用**；
- 模型能力（上下文、输出、图片、思考档位）靠用户手选，四档归一化把 `deepseek-flash` 从真实的 1M/384K 压成 256K/65.5K；
- 订阅登录（ChatGPT / Copilot 式 OAuth）完全不可用。

目标：改成**固定供应商预设**，只开放 8 家，能力与协议由 Pi 内置 catalog 提供，密钥与 OAuth token 统一走 safeStorage 加密存储，用户可对单个模型下调上下文 / 输出上限，并跟随 pi.dev 目录增量更新。

### 非目标

1. 8 家之外的厂商（volcengine / 腾讯 / StepFun / SiliconFlow / 本地 Ollama…）—— 需要自己维护 `compat`，另行立项；
2. 自定义端点 / 中转站 / 代理 URL —— 本次整体移除；
3. 手工编辑 `models.json` —— 不支持（该文件由应用生成，启动时覆盖）；
4. 同一会话内跨 provider 切换（一次只有一个 `activeProvider`）；
5. models.dev 的富模态数据（音频 / 视频 / PDF）—— 见 §8.3，独立增量。

---

## 2. 锁定的决策

| ID | 决策 | 说明 |
| --- | --- | --- |
| D1 | 白名单 8 家：`openai` `anthropic` `google` `xai` `deepseek` `xiaomi` `xiaomi-token-plan-cn` `openai-codex` | 全在 Pi 内置目录里，元数据与 `compat` 现成 |
| D2 | 配置写**新文件** `config/providers.json` + `config/credentials.json` | 旧 `loadApiConfig` 遇 `provider !== 'custom'` 会清空配置（`electron/ipc/api-config.ts:147-161`），原地升级会让回滚丢配置 |
| D3 | 密钥 / OAuth token 只存 `credentials.json`（`enc:`），**不写 `process.env`** | `CredentialStore` 优先级高于环境变量；终端与 bash 工具彻底拿不到 key |
| D4 | 每个 provider 只保留一种生效鉴权（`api_key` 或 `oauth`） | 避免"哪把钥匙在生效"的歧义 |
| D5 | 云端工单跟随 `activeProvider` / `activeModel`，且**允许 OAuth 凭证** | 与现有"复用用户当前配置"一致；订阅额度被自动任务消耗列为已知风险 |
| D6 | 目录刷新默认开（`pi.dev`），设置项可关，`PI_OFFLINE` 总开关 | 模型 / 上下文 / 价格跟随上游 |
| D7 | 会话内模型切换仍走既有 `setSessionModel` | 渲染层已实现，不重写 |
| D8 | 删除「自定义端点」整条链路（UI / `apiConfig:*` IPC / dev 代理 / Web mock） | 只做固定供应商时它是纯负担 |
| D9 | **上下文窗口可调**：默认 = catalog 真值（最高档），允许向下选；按模型存 | 老会话调小后超限由 SDK 自动压缩 / 溢出恢复处理（§3.7） |
| D10 | **输出上限可调**：上限 = catalog `maxTokens`，允许向下选；按模型存 | SDK 只按上下文余量 clamp，不会按目录上限兜底，必须我们双层夹住 |
| D11 | 换模型时思考档位**自动降级**到新模型支持的档位，不支持思考则 `off`，不报错 | SDK 自身会 `clampThinkingLevel`，UI 只需跟随 |
| D12 | 模型列表**以最近一次远端目录为准**（UI 过滤掉上游已删除的模型）；从未成功刷新 / 离线时回退内置快照 | 解决"上游删了但列表还在"的问题，见 §8.2 |
| D13 | `models.json` 完全由应用生成，启动时覆盖，不支持手工编辑 | 唯一可编辑的入口是设置页（写 `providers.json`） |
| D14 | 目录刷新只针对 8 家，且只对已配置凭证的 provider 发请求（SDK 行为：无凭证直接跳过网络） | 避免 42 家 × 4s 的启动噪音 |
| D15 | 云端控制台与桌面端**同构**：同一 8 家白名单、同一 catalog 校验；云端保留自己的 `apiKeyCipher` 加密 | 云端服务端不能用 OS 钥匙串，沿用现有 `encryptionKey` 方案 |
| D16 | 工单鉴权失败上报 `task_failed(reason: 'auth')`，本地同时通知 | 否则只剩"工单卡住" |
| D17 | 能力表展示 catalog 可读的全部字段（名称 / 上下文 / 输出 / 思考 / 输入模态 / 价格 / 缓存） | 用户明确要求"能拿到的都显示" |
| D18 | **云端也支持 OAuth**：`xai` device code；`anthropic` / `openai-codex` 走 SDK 的 headless 分支（`select` 里选 copy-code / device code）；`openai` 粘贴 redirect URL | 不复用我们的域名做回调，原因见 §3.8 |
| D19 | 云端 OAuth 凭证加密存服务端（`encryptionKey`），与桌面端凭证各自独立、互不同步 | 两端生命周期不同；同步会把设备密钥复制到服务器 |
| D20 | 云端旧配置整体丢弃、强制重配（不做"待重配"状态） | 反正要删自定义端点，保留半旧配置只会增加分支 |
| D21 | Agent 配置签名只含**身份指纹**：`api_key` 变化触发重建，OAuth token 刷新不触发 | 否则每次 token 刷新都会 dispose 正在跑的会话 |
| D22 | 打开会话时校验模型归属：不属于 `activeProvider` → **静默回落**到 active 模型，并同步 chat store 的 `sessionSettings.modelId` | 头部本来就显示 modelId，不同步会显示一个没在用的模型名 |
| D23 | 改 `contextWindow` / `maxTokens` 在**轮次边界**生效（不拒绝、不打断） | 与工作树切换、云端配置轮换同一语义 |
| D24 | 配置时做一次轻量 Key 探测（桌面端与云端各一次） | catalog 只能校验 provider/model，Key 错误要尽早暴露 |
| D25 | `models.json` 只写白名单内的 provider，过期 id 直接丢弃 | 未知 provider 会被当成"零模型 provider"重新注册（`getAllProviderModels(undefined) → []`），`getModel` 永远拿不到模型；残留的 `baseUrl` / `api` 还会覆盖内置定义 |
| D26 | 远端目录**只在其 `lastModified > getBuiltinModelDataGeneratedAt()` 时生效**（SDK 的 `isNewer()` 判据），`source` 与列表过滤必须用同一判据 | 否则远端比内置快照旧时，SDK 根本没用它，我们却按它过滤 → 显示一个变少的假列表 |
| D27 | 登录统一走 `ModelRuntime.login(providerId, type, interaction, options)`（内部写 store），并传 `agentName` + 稳定 `getDeviceId()`（**必须 UUID 格式**） | 自己实现会把凭证写丢；`openai` 缺 device id 直接抛错（`agentHostId()` 校验 UUID） |

---

## 3. 数据模型

### 3.1 `config/providers.json`（新，明文）

```json
{
  "version": 1,
  "activeProvider": "deepseek",
  "providers": {
    "deepseek": {
      "model": "deepseek-flash",
      "overrides": { "deepseek-flash": { "contextWindow": 262144, "maxTokens": 131072 } }
    },
    "openai": { "model": "gpt-6.2-sol" }
  }
}
```

- `providers` 只记录**已配置**的供应商；未出现的在 UI 里显示为未连接。
- **没有 `auth` 字段**：`CredentialStore` 每个 provider 只存一条凭证（SDK 契约），鉴权方式由凭证 `type` 派生（D4 不靠额外字段维持）。
- `model` 必须是该 provider catalog 内的 id；不存在时回落 catalog 首个模型并提示。
- `overrides` 按模型存用户下调值；缺省 = 用 catalog 真值。
- 不含任何密钥字段。

### 3.2 `config/credentials.json`（新，密文）

```json
{
  "version": 1,
  "entries": {
    "deepseek": { "type": "api_key", "secret": "enc:<base64>" },
    "openai": { "type": "oauth", "secret": "enc:<base64>" }
  }
}
```

`type` 必须**明文**旁挂：pi-ai 要求 `list()` 在不返回也不解密的前提下给出凭证类型（状态徽标、重建指纹都靠它）。`secret` 是整条 `Credential` 的序列化密文：

```ts
type Credential =
  | { type: 'api_key'; key?: string }
  | { type: 'oauth'; refresh: string; access: string; expires: number }
```

- 加解密复用 `electron/secret-crypto.ts`（Windows DPAPI / macOS Keychain / Linux libsecret；不可用则明文回退并警告）。
- 写盘走原子替换（临时文件 + fsync + rename），**不留 `.bak`**：旧密文没有回滚价值，而 OAuth 刷新会让写入变频繁。
- **应用级**文件，跨工作区共享；不能放 `{workspace}/.pi-workbench/`。

### 3.3 `data/agent/models.json`（派生，覆盖写）

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "deepseek": {
      "modelOverrides": {
        "deepseek-flash": { "contextWindow": 262144, "maxTokens": 131072 }
      }
    }
  }
}
```

每次 `AgentManager.initialize()` 从 `providers.json` 重新生成；无覆盖时写 `{ "providers": {} }`。旧的 `pi-workbench` provider 条目必须清掉，否则 `getModel` 会拿到陈旧模型。

### 3.4 `data/agent/models-store.json`（SDK 管理的目录缓存）

`FileModelsStore` 的格式是 `{ [providerId]: { models: [...], lastModified, checkedAt, etag } }`。

我们的用法：**注入自己的 `ModelsStore` 实现**（`pi-bridge/src/models-store.ts`），文件路径与格式保持不变，额外提供只读快照给 UI：

```ts
interface CatalogSnapshot {
  providerId: string
  checkedAt?: number
  ids: string[]        // 最近一次远端目录的模型 id（空 = 从未成功刷新）
}
```

这样"上游已删除的模型"就有唯一判据（§8.2），快照本身从 `read(providerId)` 派生，**不需要第二个文件**。

### 3.5 `config/api-config.json`（旧，只读一次）

启动迁移后改名 `config/api-config.json.legacy`，不删（回滚与排障用）。

### 3.6 与 SDK 的分工

| 关注点 | 归属 |
| --- | --- |
| provider 身份、`baseUrl`、`api`（responses / messages / generative-ai / codex-responses）、模型元数据、`compat` | Pi 内置 catalog + pi.dev 增量 |
| 凭证存储 | 我们的 `CredentialStore` 实现（注入 `ModelRuntime.create({ credentials })`） |
| OAuth 流程（回调服务、device code、token 刷新） | pi-ai（`provider.auth.oauth.login/refresh`） |
| 目录缓存 | 我们的 `ModelsStore`（格式兼容 SDK） |
| OAuth 的 `client_id` / `redirect_uri` | pi-ai 内建（见 §3.8），我们**不能**换成自己的域名 |
| 会话 / 历史 / 压缩 / 工具 | pi-bridge（不变） |

### 3.7 调小上下文后老会话的行为（D9）

SDK 自带两级处理，不需要我们造：

- **阈值压缩**：`shouldCompact` 按模型的 `contextWindow` 算阈值，会话接近上限时自动压缩（`agent-session.js` 的 compaction 流程）；
- **溢出恢复**：请求真的超限时报错被 `overflow recovery` 接住，压缩后自动 `continue()`（`agent-session.js:2346-2385`，带 `_overflowRecoveryAttempted` 只重试一次的保护）。

因此我们的责任只有两条：① 归一化时 `contextWindow ≤ catalog 值`、`maxTokens ≤ min(catalog maxTokens, contextWindow)`；② 调低时在 UI 上一次提示"会更早触发自动压缩"。

### 3.8 OAuth 的回调地址为什么改不了（回应"为什么还是 localhost"）

`redirect_uri` 由 **OAuth 应用注册**决定，而 pi-ai 用的是 pi 自己的应用凭证，硬编码在依赖里：

- `anthropic.js:11` `CLIENT_ID = decode(...)`（内建常量），`redirect_uri` 固定 `http://localhost:<port>/callback`；
- `openai-chatgpt.js:13` `DYNAMIC_CLIENT_ID = "dynamic_agent_client"`，回调 `http://127.0.0.1:<port>/...`；
- `openai-codex.js:22` `REDIRECT_URI = "http://localhost:1455/auth/callback"`；
- 唯一可配置的环境变量是 `PI_OAUTH_CALLBACK_HOST`（只改**监听主机**，不改 scheme / host / path）。

所以 `https://<我们的域名>/oauth/callback` 会被厂商以 `invalid_redirect_uri` 拒绝。要用自己的域名，必须：① 向每家重新申请 OAuth 应用（回调域名备案 + 审批）；② 自己实现授权码交换（SDK 不暴露 `client_id` 覆写）。这是独立工程，不进本次范围（§13）。

因此云端只能用两条免回调路径：

| provider | 云端流程 | 约束（实测代码） |
| --- | --- | --- |
| `xai` | **device code**（`auth.x.ai/oauth2/device/code` + 轮询） | 无回调、无线程依赖，最简单 |
| `openai-codex` | 先 `select` → 选 **device code (headless)** | 不选就走浏览器分支，云端拿不到回调 |
| `anthropic` | 先 `select` → 选 **copy code (headless)** | 同上；copy-code 分支不监听端口 |
| `openai` | loopback + **粘贴最终 redirect URL** | **必须**传 UUID `getDeviceId`（`agentHostId()` 非 UUID 直接抛）；登录会强绑回调端口，端口被占则硬失败 |

**硬需求**：`anthropic` / `openai-codex` 的 `login()` 第一步就是 `interaction.prompt({ type: 'select' })`（`anthropic.js:234-250`、`openai-codex.js:324-336`），所以鉴权 UI **必须渲染选项列表**，否则这两家直接抛 `Unknown ... login method`。云端把选项文案改成“浏览器登录 / 无浏览器登录（推荐）”，并默认后者。

约束：PKCE `verifier` 必须与授权码在同一进程内保存（云端存临时表）；流程不可跨实例迁移；同一容器内并发登录会互抢端口（1455），必须串行化。

### 3.9 凭证存储分层

`CredentialStore` 的实现必须在三处复用，因此拆成"纯 Node 内核 + 平台适配器"：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 内核 | `pi-bridge/src/credentials-store.ts` | 序列化、**按 provider 串行** + **全文件写入互斥**（不同 provider 的 `fn` 并行、落盘串行，否则后写用旧快照覆盖别的 provider）、原子写；加解密通过**注入**的 `encrypt/decrypt` 函数。`FileModelsStore` / `AuthStorage` / `FileAuthStorageBackend` 都**没有**从 `pi-coding-agent` 导出（`exports` 只有 `.` 和 `./rpc-entry`），锁与原子写必须自己实现 |
| 桌面适配 | `electron/credentials-store.ts` | 注入 `secret-crypto.ts`（safeStorage），路径 `config/credentials.json` |
| 云端适配 | `apps/cloud/src/agent/credentials-store.ts` | 注入 `encryptSecret/decryptSecret(encryptionKey)`，路径 `data/cloud/credentials.json` |

---

## 4. 运行时结构

```
renderer（设置页「供应商」/ 聊天头部模型下拉）
   │  providers:* / auth:*（10 个 invoke + auth:event 推送）
   ▼
electron/ipc/providers.ts ──► electron/providers-service.ts
   │                            ├── config/providers.json（active / overrides）
   │                            ├── electron/credentials-store.ts（CredentialStore）
   │                            └── AgentManager（重建 / 刷新目录 / catalog 视图）
   ▼
pi-bridge/AgentManager ──► ModelRuntime.create({
                             modelsPath,            // 派生 models.json
                             modelsStore,           // 我们的 ModelsStore 实例（§3.4）—— 不再传 modelsStorePath
                             credentials,           // 注入的 CredentialStore
                             allowModelNetwork: false,   // 启动不阻塞，就绪后后台 refresh(),
                             refreshOnCreate: false,
                             modelRefreshTimeoutMs, catalogBaseUrl  // 测试/离线注入
                           })
                             ├── 内置 42 家 provider catalog（只用 8 家）
                             ├── pi.dev /api/models/providers/:id（4h 节流 / ETag / 离线回落）
                             └── getModel(providerId, modelId)
```

`CredentialStore` 由主进程创建**单例**，同时注入本地工作区 Agent 与云端工单 Agent。

---

## 5. 文件级改动清单

### 5.1 新增

| 文件 | 内容 |
| --- | --- |
| `electron/credentials-store.ts` | 薄适配：`createCredentialStore({ path, encrypt, decrypt })` 注入 `secret-crypto.ts`，内核在 `pi-bridge`（§3.9） |
| `electron/providers-config.ts` | `config/providers.json` 读写、`setActive`、`setOverrides`、`migrateLegacyApiConfig()` |
| `pi-bridge/src/provider-presets.ts` | 8 家白名单（id / 显示名）+ catalog 视图助手（`ModelView` 组装、生效值归一化）；**坐在这里而不是 `electron/`**，否则 `apps/cloud` 无法复用 |
| `electron/providers-service.ts` | 组合层：供应商视图、模型视图、登录/登出、刷新目录、切 active 后触发重建 |
| `electron/auth-flow.ts` | `AuthInteraction`（`prompt` / `notify`）桥到渲染层；`auth_url` → `shell.openExternal`；`device_code` 透传；`AbortController` 取消 |
| `electron/ipc/providers.ts` | 10 个 invoke + `auth:event` 推送（见 §6） |
| `pi-bridge/src/credentials-store.ts` | `CredentialStore` 内核：序列化 / 单队列串行 / 原子写，`encrypt`/`decrypt` 函数注入（§3.9） |
| `pi-bridge/src/models-store.ts` | 文件型 `ModelsStore` + `snapshot()`（§3.4）；按 provider 原子写（SDK 的 `FileModelsStore` 未导出，锁要自己实现） |
| `apps/cloud/src/agent/credentials-store.ts` | 云端适配器：注入 `encryptionKey`，文件 `data/cloud/credentials.json` |
| `apps/cloud/src/agent/oauth-login.ts` | 云端 OAuth：同一个 `AuthInteraction` 桥接到 HTTP + 前端轮询；`select` 默认选 headless 分支；PKCE 临时表 + 登录串行化（§3.8） |
| `src/components/ProviderAuthPanel.tsx` | 单个供应商卡片：状态 / 鉴权按钮 / 模型下拉 / 登出 |
| `src/components/ModelCapabilityTable.tsx` | 模型能力表：名称 · 上下文 · 输出 · 思考 · 输入 · 价格 · 缓存；上下文 / 输出为下拉 |
| `tests/credentials-store.test.ts` | 串行 / 加解密往返 / `list` 不解密 / delete / 坏文件 / 双适配器同内核 |
| `tests/providers-config.test.ts` | 迁移矩阵、active 切换、overrides 归一化、未知 provider |
| `tests/providers-service.test.ts` | 供应商视图合并、远端优先过滤、刷新 |
| `tests/models-store.test.ts` | 快照读写、格式兼容、损坏回落 |
| `tests/settings-providers.test.tsx` | 设置页交互（jsdom + mock electronAPI） |

### 5.2 修改

| 文件 | 改动 |
| --- | --- |
| `pi-bridge/src/types.ts` | `AgentConfig.apiConfig` → `{ providerId, modelId, overrides? }`；新增 `credentials`、`allowModelNetwork?`；删 `ApiModelEntry` / `CONTEXT_WINDOW_OPTIONS` / `MAX_TOKENS_OPTIONS` / `maxTokensSource` |
| `pi-bridge/src/model-config.ts` | 删 `KNOWN_MODEL_METADATA` / `PAIRED_MAX_TOKENS` / `resolveMaxTokens*` / 四档归一化；`writeModelsConfig` 只写 `modelOverrides` |
| `pi-bridge/src/agent-manager.ts` | 注入 `credentials` + `modelsStore`；`ModelRuntime.create` 去 `authPath`、**不传 `modelsStorePath`**、`refreshOnCreate: false`；后台 `refresh({ allowNetwork, providers: 白名单 })`；`getModel(providerId, modelId)`；`outputLimit()` ← 生效 `maxTokens`；`getModelCapabilities()` ← catalog；纯图片占位判定改 `model.api === 'anthropic-messages'`；新增 `getProviderCatalog()` / `refreshCatalog()` / `getAuthStatus()` |
| `pi-bridge/src/environment.ts` | 删 `acquireProviderEnv` / `releaseProviderEnv` / `PROVIDER_ENV_KEYS` |
| `pi-bridge/src/session-title.ts` | 改用 `models.streamSimple(model, context, …)`；删两条手写 `fetch`；失败回退首条用户消息 |
| `electron/ipc/api-config.ts` | **删除**（三个频道整体移除），旧文件只在迁移时只读 |
| `electron/ipc/agent.ts` | 新 `apiConfig` 形状 + 注入 store；**会话运行时不再写死 provider**（D22）：`createRuntime` / `setSessionModel` / `getModelCapabilities` 全改 `activeProvider`；旧模型回落时回写 chat store |
| `electron/agent-config-key.ts` | 签名改 `{ providerId, modelId, credentialFingerprint, overrides }`；指纹只含身份（`api_key` → sha256 前 12 位，`oauth` → 固定 `'oauth'`），**不含** token / 过期时间（D21） |
| `electron/cloud/task-runner.ts` | `getApiConfig()` 新形状；`managerKey` 同上；共享同一 `CredentialStore`；鉴权失败 → `task_failed(reason:'auth')`（D16） |
| `electron/ipc/cloud.ts` | 设备侧 `getApiConfig` 不再读明文 `apiKey`：`provider/model` 来自 `providers.json`，凭证由 `CredentialStore` 解 → 只影响本机工单，**不上报云端** |
| `electron/terminal-manager.ts` / `electron/worktree-deps.ts` | 敏感 env 名单去掉 `PI_WORKBENCH_API_KEY`（不再写入） |
| `electron/main.ts` | 启动顺序：`createCredentialStore()` → 迁移 → 注册 IPC；日志脱敏断言 |
| `electron/preload.cts` / `src/types/electron.d.ts` / `src/api/index.ts` | 新频道四步 + Web mock 改为"仅桌面端"占位 |
| `src/components/Settings.tsx` | 「API 配置」段整体替换为「供应商」 |
| `src/components/WelcomeScreen.tsx` / `src/hooks/useChatPanelState.ts` / `src/hooks/useChatSessions.ts` | 旧 `apiConfigGet` 调用改 `providers:list`；模型下拉数据源改动 |
| `src/i18n/translations.ts` | 新增 / 删除文案 key（zh + en） |
| `src/components/CloudView.tsx` | 云端供应商配置对齐（8 家 + catalog 模型 + overrides） |
| `apps/cloud/src/agent/provider-models.ts` | 探测改为 catalog 校验（白名单 + 模型存在），`/models` 探测保留用于 Key 有效校验（D24） |
| `apps/cloud/src/http/routes.ts` / `apps/cloud/src/main.ts` | 云端配置只接受 `{provider, model}` + `auth` 方式；`apiKey` 仍走 `apiKeyCipher`，OAuth token 走云端凭证文件（D19）；旧配置直接丢弃（D20）。`main.ts:476` 的 `agent.initialize({ apiConfig: { provider, apiUrl, apiKey, selectedModel } })` 改 `{ providerId, modelId }` 并注入云端 `CredentialStore` + `ModelsStore` |
| `src/utils/model-capabilities.ts` | **删除**（档位常量与自动推导由 catalog 取代）；渲染层改用 `providers:models` 返回值 |
| `tests/main-ipc.test.ts:963-975` | **删除**两条跨层常量一致性断言（模块已不存在） |
| `docs/guides/AGENT-TESTING.md` / `README.md` / `README.en.md` / `docs/PROJECT_PLAN.md:148` / `docs/agent/ipc-and-trust.md` §4 | 配置步骤、决策表、频道计数（19 域 / 127 handler）同步更新 |
| `tests/agent-manager.test.ts` / `session-title.test.ts` / `agent-extension-injection.test.ts` / `settings-update.test.tsx` / `main-ipc.test.ts` / `cloud-config-*.test.ts` / `cloud-task-agent-settings.test.ts` / `model-capabilities.test.ts` | 按新形状改写或删除 |

### 5.3 删除

| 位置 | 说明 |
| --- | --- |
| `apiConfig:fetchModels`（主进程 + preload + d.ts + api 层） | 不再从端点拉模型 |
| `vite.config.*` 的 `/__pi/fetch-models` dev 代理 | 失效即删 |
| `src/api/index.ts` 的 `apiConfigSave` / `apiConfigFetchModels` mock | 同上 |
| `api-config.json` 的 `models[]` / 四档上下文 / 输出档位 / `image` 相关类型与归一化 | 由 catalog + overrides 取代 |
| `KNOWN_MODEL_METADATA` / `PAIRED_MAX_TOKENS` / `LEGACY_DEFAULT_IMAGE_MODELS` | 历史包袱 |
| `electron/main.ts:492` 的 `getActiveProviderApiKey()` 清理路径 | 不再往 env 写 key，这段连同 `ipc/api-config.ts` 一起删 |
| `src/utils/model-capabilities.ts` + `tests/model-capabilities.test.ts` | 与 bridge 三方对齐的档位常量，已无意义 |

### 5.4 依赖变更（已批准）

`pi-bridge/package.json` 目前只声明 `@earendil-works/pi-coding-agent`，而 `pi-coding-agent` 的 `index.d.ts` **不转导任何 pi-ai 类型**（已核实：无 `from "@earendil-works/pi-ai"` 再导出）。实现 `CredentialStore` / `ModelsStore` 与 D26 的判据需要：

- `pi-bridge` 直接声明 `@earendil-works/pi-ai`（版本范围与 `pi-coding-agent` 要求的一致）；
- 无需新增安装：它已在依赖树里，只是未声明，属 AGENTS.md 的 "新增依赖" 审批项。

不批的退路：本地结构类型 + 放宽判据（`stored.lastModified > 0` 即认作远端），代价是 SDK 升级时静默漂移与 §8.2 的限定场景误过滤。`apps/cloud` 不动依赖，catalog 与白名单均经 `pi-bridge` 再导出。

---

## 6. IPC 契约

域：`providers`（6）、`auth`（4 + 1 推送事件）。全部走 `handleIpc()`，按 `ipc-and-trust.md` 四步登记。

> 云端 Web 控制台**不走**这套 IPC：`apps/cloud` 用自己的 HTTP 路由（`/v1/cloud-config/*`）实现同一语义（供应商列表 / 模型列表 / 登录 / 登出）。两端共享的是白名单常量与 catalog 视图结构，不是传输层。

| 频道 | 参数 | 返回 |
| --- | --- | --- |
| `providers:list` | — | `{ success, activeProvider, activeModel, providers: ProviderView[] }` |
| `providers:models` | `(providerId)` | `{ success, models: ModelView[], directory: { checkedAt?, source: 'remote' \| 'bundled' } }` |
| `providers:setActive` | `(providerId, modelId)` | `{ success }` / `{ success:false, code:'AGENT_BUSY' \| 'MODEL_UNKNOWN' \| 'NOT_CONNECTED', workspaces? }` |
| `providers:setOverrides` | `(providerId, modelId, { contextWindow?, maxTokens? })` | `{ success, effective: { contextWindow, maxTokens }, pending?: boolean }`（超上限时按上限回落；运行中保存返回 `pending: true`，下一轮边界重建 Agent 生效，D23） |
| `providers:refresh` | `(providerId?)` | `{ success, checkedAt, added, removed }`（未配置凭证的 provider 直接跳过）。`added` / `removed` 由**我们对比刷新前后 store 条目自己算**：SDK 的 `refresh()` 只返回 `{ aborted, errors }`；必须传 `force: true`（否则 4h 节流让按钮看起来没反应）与 `providers: [8 家]` |
| `providers:forget` | `(providerId)` | `{ success }`（清配置 + 删凭证） |
| `auth:login` | `(providerId, method: 'api_key' \| 'oauth', key?)` | `api_key` 同步 `{ success }`；`oauth` → `{ success, pending: true, loginId }` |
| `auth:answer` | `(loginId, requestId, value)` | `{ success }` |
| `auth:cancel` | `(loginId)` | `{ success }` |
| `auth:logout` | `(providerId)` | `{ success }` |
| `auth:event`（main → renderer） | `{ loginId, providerId, type, payload }` | `type` 与 SDK 对齐：`info`（带 links）/ `auth_url` / `device_code` / `progress` / `prompt` / `done` / `error`；`prompt` 带 `kind: 'text' \| 'secret' \| 'select' \| 'manual_code'` + `placeholder?` + `options?` |

```ts
interface ProviderView {
  id: string
  name: string
  // 从 catalog 派生：auth.apiKey?.login 存在 → 'api_key'；auth.oauth 存在 → 'oauth'（含 loginLabel）
  authMethods: Array<'api_key' | 'oauth'>   // 实测 openai-codex 只有 oauth，google / deepseek / xiaomi* 只有 api_key
  // connected ← getProviderAuthStatus(id).configured（同步，不刷新 OAuth）
  connected: boolean
  // credentialType ← listCredentials() 的 CredentialInfo.type（不解密）
  credentialType?: 'api_key' | 'oauth'
  subscription?: boolean    // isUsingSubscription(id)
  active: boolean
  model?: string
  models: ModelView[]
}
interface ModelView {
  id: string
  name: string
  contextWindow: number      // catalog 真值（上限）
  maxTokens: number          // catalog 真值（上限）
  effective: { contextWindow: number; maxTokens: number }  // 叠加 overrides 后
  reasoning: boolean
  thinkingLevels: string[]
  input: Array<'text' | 'image'>
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  promptCache?: { short?: number; long?: number }
  source: 'remote' | 'bundled'
}
```

错误码：`PROVIDER_UNKNOWN` / `MODEL_UNKNOWN` / `NOT_CONNECTED` / `AGENT_BUSY` / `AUTH_CANCELLED` / `AUTH_TIMEOUT` / `STORAGE_UNAVAILABLE`。

**复用而不重造**：`AGENT_BUSY` 判定（`setRunningAgentsProvider`）、会话内 `setSessionModel`、`setSessionThinking`、`api-config-saved` 重建通路（改名 `providers-changed`）、`agent:session-title` 广播。

登录流程统一走 `runtime.login(providerId, type, interaction, { agentName: 'Pi Workbench', getDeviceId })`：凭证落盘由 SDK 调 `CredentialStore.modify` 完成，我们只实现 `AuthInteraction`（`prompt` / `notify`）到 IPC 的桥。`getDeviceId()` 必须返回**稳定**安装 id（首次生成后落盘），OpenAI / Codex 用它做 agent host id。

---

## 7. 设置页规格

「API 配置」段替换为「供应商」：

1. **供应商列表**（8 行，未启用折叠在「其他供应商」下）：`名称 · 状态徽标（未连接 / API Key / 订阅）· 当前模型 · [鉴权] [登出]`
2. **鉴权弹层**（`ProviderAuthPanel`）
   - `api_key`：密码框 + 保存（写 store，不写 env）
   - `oauth`：等待态，按 `auth:event` 渲染**四种**界面（打开链接 / device code + 倒计时 / 文本输入 / 选项列表）；`manual_code` 带粘贴提示与示例，`select` 必选（anthropic / codex 不给选就报错）
   - 同一 provider 支持两种时给「API Key / 订阅登录」切换（D4）
3. **模型表**（`ModelCapabilityTable`，复用 `SettingsTable`）
   列：名称 · 上下文 · 输出 · 思考 · 输入 · 价格（in/out/cache）· 缓存
   - 上下文、输出两列为下拉：档位 = 固定阶梯（32K/64K/128K/256K/512K/1M 与 8K…256K）∩ ≤ catalog 值，末位是 catalog 真值标「最高（推荐）」
   - 改动即写 `providers.json.overrides`，`providers:setOverrides` 返回生效值；会话运行中则标"下一轮生效"（D23）
   - 调低上下文时一次性提示「会更早触发自动压缩」
4. **目录信息**：`目录：2026-11-24 更新 · [刷新]`；失败显示上次成功时间；`source: bundled` 时提示「当前使用内置快照」
5. **开关**：`自动更新模型目录`（D6）
6. 安全提示：safeStorage 不可用时红字「当前系统无法加密存储密钥，密钥将以明文保存」

约束：只用 `ui.tsx` / `patterns.tsx` 组件与 token；必须过 `tests/design-system.test.ts`。

---

## 8. 模型目录与能力展示

### 8.1 catalog 能提供的字段

每个模型实际携带：`id` `name` `api` `baseUrl` `provider` `reasoning` `thinkingLevelMap` `input`（`text` / `image`）`cost`（input/output/cacheRead/cacheWrite）`promptCache` `contextWindow` `maxTokens` `compat` `inputLimits`。

**没有**：音频 / 视频 / PDF 模态、`deprecated` 状态、描述文案、发布时间。

### 8.2 「刷新 = 替换列表」怎么做到（回应"为什么 SDK 层面救不了"）

SDK 的远端目录是**叠加**在打包快照上的（`mergeModels(baseline, remote)` 按 id 覆盖，不删 baseline），因为 `getModels()` 永远从 baseline 开始。要做到"以远端为准"，由我们这层实现：

1. 注入自己的 `ModelsStore`（§3.4），拿到每个 provider 最近一次远端目录的 `ids`、`lastModified` 与 `checkedAt`；
2. **生效判据必须与 SDK 一致（D26）**：`isNewer = stored.lastModified > getBuiltinModelDataGeneratedAt()`（该函数从 `@earendil-works/pi-ai/providers/all` 导出，当前值 2026-10-15）。只有为真时才算 `source: 'remote'` 并按 `ids` 过滤；否则全量回退内置快照；
3. `getProviderCatalog()` 组装 `ModelView` 时应用上面两条；
4. `providers:refresh`（`force: true`）成功后立刻重算视图 → 上游删掉的模型从列表消失。

局限（写进 UI 文案）：从未成功刷新 / 离线的机器仍显示内置快照；下架模型在重装或清空缓存后可能重新出现一次，直到再次刷新。pi.dev 返回的 `Last-Modified` 比内置快照旧时（`lastModified <= generatedAt`），SDK 直接忽略远端——此时必须显示 `source: 'bundled'`，不能按远端过滤。

### 8.3 models.dev 富数据（独立增量，本次不做）

用户已确认可以引入，但必须**解耦**：

- 独立数据源与独立缓存（不与 Pi catalog 混写）；
- 独立映射（`models.dev` 的 `modalities` / `capabilities` / `benchmarks` → 我们的展示字段）；
- 失败不影响主流程（拿不到就只显示 catalog 字段）；
- 需求单独立项（BACKLOG 新条目），不改动本次的 `providers.json` / `models.json` 形状。

---

## 9. 迁移与回滚

### 9.1 启动迁移（幂等）

1. 若 `config/providers.json` 存在 → 跳过。
2. 读旧 `config/api-config.json`（`readJsonWithBackup`）：
   - `provider === 'custom'` 且 `apiUrl` 含 `deepseek.com` → `activeProvider='deepseek'`，模型取 `selectedModel`（不在 catalog 则取首个）；
   - 含 `anthropic.com` → `anthropic`；含 `api.openai.com` → `openai`；
   - 其他 URL → **不猜**：写空 `providers`，UI 引导重新选择；
   - 旧 `apiKey` 解密后写入 credentials store（`auth: 'api_key'`）。
3. 旧文件改名 `config/api-config.json.legacy`。
4. `data/agent/auth.json` 若存在且非空 → 逐条导入后删除。
5. `data/agent/models.json` 重写为覆盖后结果（清掉旧 `pi-workbench`）。

### 9.2 回滚

删 `config/providers.json` + `config/credentials.json`，把 `api-config.json.legacy` 改回原名，装回旧版本即可。`models.json` 由旧版本启动时自动重写。

---

## 10. 阶段拆解（每阶段可独立合并）

> 用户已确认：中间期不发版，P2 与 P4 分开提交导致的"设置页暂不可配"可接受。

### P0 · 凭据存储（S）— 已完成

- 交付：`pi-bridge/src/credentials-store.ts`（内核，注入 `encrypt/decrypt`）+ `electron/credentials-store.ts`（safeStorage 适配）+ `tests/credentials-store.test.ts`（14 条）。零行为变化。
- 验收：`npx vitest run tests/credentials-store.test.ts` + `npm run build:bridge` + `npm run type-check` + `npm run lint` 全绿。
- 关键：`modify` 串行且返回 post-write 值（OAuth 刷新在 `modify` 内跑，双刷会让 token 失效）；不同 provider 的写入必须全局串行，否则会互相覆盖（已由用例锁定）。

### P1 · 配置与迁移（M）— 已完成
- 交付：`pi-bridge/src/provider-presets.ts`（白名单 + catalog 容量口径）/ `pi-bridge/src/providers-config.ts`（配置读写 + 迁移）/ `electron/providers-config.ts`（适配层）/ `providerConfigKey` + `tests/providers-config.test.ts`（17 条）。
- 验收：`tests/providers-config.test.ts` + `build:bridge` + `type-check` + `lint` 全绿。
- 关键：本阶段**不接线**（`main.ts` / IPC 仍走旧 `api-config`，零行为变化）；迁移调用点、`.legacy` 改名与 `models.json` 覆盖在 P2 一起生效，避免中间提交把应用变成不可配置。

### P2 · 运行时切内置 provider（L，断点）
- 交付：`types.ts` / `model-config.ts` / `agent-manager.ts` / `models-store.ts` / `environment.ts`。
- 验收：`npm run build:bridge` + `tests/agent-manager*.test.ts` + `tests/models-store.test.ts`；手工跑一轮 DeepSeek（工具调用 + 图片 + 截断文案）。
- 关键：`models.json` 必须整体覆盖（清旧 provider，D25）；`modelsStore` 注入而不依赖 `modelsStorePath`。

### P3 · 协议假设修正 + 交互细化（M）
- 交付：标题生成改 `streamSimple`；纯图片占位改 `model.api`；env 注入清理；`getModelCapabilities` 改 catalog；换模型的思考档位自动降级（D11）；overrides 归一化与上限夹取（D9/D10）；会话模型归属校验与静默回落（D22，含 chat store 回写）。
- 验收：`tests/session-title.test.ts`（四种 api 的路径）、`tests/agent-manager.test.ts`（能力/上限/档位降级/回落）。
- 关键：标题请求显式 `reasoning: 'off'` + 小 `maxTokens`；回落时必须同步 `sessionSettings.modelId`。

### P4 · 鉴权与 UI（L）
- 交付：`providers-service.ts` / `auth-flow.ts` / `ipc/providers.ts` / preload / d.ts / api 层 + Web mock / `Settings.tsx` / `ProviderAuthPanel.tsx` / `ModelCapabilityTable.tsx` / i18n。
- 验收：`tests/settings-providers.test.tsx` + `tests/main-ipc.test.ts` + `tests/design-system.test.ts`；Paper/Ink 双主题 + 1024/1440 截图；手工 OAuth 清单（§11.2）。
- 关键：登录可取消；`auth:event` 只推受信窗口。

### P5 · 云端与工单对齐（M）
- 交付：`task-runner.ts`（D16）、`ipc/cloud.ts`（不再读明文 key）、`apps/cloud`（白名单 + catalog 校验 + Key 探测保留 + 旧配置丢弃 + 云端凭证存储 + **云端 OAuth 登录 UI**）、`CloudView.tsx`。
- 验收：`npm run build:cloud` + `tests/cloud-config-*.test.ts` + `tests/cloud-task-agent-settings.test.ts`；手工：`xai` device code、`anthropic` copy-code、`openai-codex` device code、`openai` 粘贴 URL 各 × 1。
- 关键：云端凭证与桌面端各自独立（D19）；PKCE verifier 存服务端临时表，不可跨实例。

### P6 · 跟随上游 + 文档收尾（S）
- 交付：`allowModelNetwork` 打开（限 8 家）、`providers:refresh` 接线、目录时间与 `source` 展示、两个开关。
- 文档：本文 + `agent-runtime.md`（输出上限/档位改写为 catalog + overrides）、`paths-and-storage.md`（新增三个文件，注明应用级共享）、`PROJECT_STRUCTURE.md` §5 频道表、`README` 配置章节（五步 → 三步）、`docs/README.md`、BACKLOG 状态。
- 验收：`npm test` + `npm run lint` + `npx electron-builder --win --dir --publish never`。

---

## 11. 测试与验收

### 11.1 自动化

| 层 | 用例 |
| --- | --- |
| 存储 | 串行写、并发 `modify` 不丢更新、加解密往返、`list` 不解密、坏 JSON 回落 |
| 配置 | 迁移矩阵、未知 provider、模型不存在回落、overrides 归一化（超上限回落）、**OAuth token 刷新不触发重建 / 换 api_key 触发重建** |
| 目录 | `ModelsStore` 快照读写、远端优先过滤（含 `lastModified <= generatedAt` 时回退）、离线回退 bundled、损坏文件回落。**不得联外网**：`ModelRuntime.create({ catalogBaseUrl })` 指向本地 stub，或 `PI_OFFLINE` |
| 运行时 | `getModel(providerId, modelId)`、`outputLimit` = 生效值、能力字段、纯图片占位在 4 种 api 下的行为 |
| 标题 | 4 种 api 的 `streamSimple` 路径 + 超时 + 空结果回退 |
| IPC | 10 个频道成功/错误码、`auth:event` 只推受信窗口、`AGENT_BUSY` |
| UI | 供应商状态、鉴权弹层四态（含 `select` / `manual_code`）、模型表两列下拉、目录时间与 `source`、safeStorage 警告 |
| 云端 | provider 白名单校验、catalog 探针、轮换、`task_failed(auth)`、`select` 默认 headless、登录串行化、device-id 缺失报错 |

### 11.2 手工验收（发布前；本轮开发阶段留清单）

每家一轮带工具调用的对话 + 思考档位切换 + 图片（catalog 含 image 的模型）+ 截断提示 + 调小上下文后自动压缩。

| 供应商 | 路径 |
| --- | --- |
| deepseek / google / xiaomi / xiaomi-token-plan-cn | API Key |
| openai / anthropic / xai | API Key **和** OAuth 各一次 |
| openai-codex | 仅 OAuth |

补充：断网启动 → `source: bundled` 可用；`PI_OFFLINE=1` 不请求 pi.dev；safeStorage 不可用时警告可见；调小上下文后长会话触发一次自动压缩并继续。

---

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| catalog 随依赖漂移（能力/价格静默变化） | 对 8 家模型做快照断言测试，升级 `pi-ai` 时显式 review |
| 远端优先过滤导致"列表为空" | 仅在 `checkedAt` 存在时过滤；否则 bundled 兜底 + UI 标注来源 |
| 订阅凭证跑工单（D5）被限流 / 超额 | 计费归属提示 + D16 的 `task_failed(auth)` 上报 + 云端展示失败原因 |
| safeStorage 不可用 | 沿用 `secret-crypto.ts` 明文回退 + UI 红字 + 文档 |
| OAuth 回调受限 | 桌面端 `callback-server` 用 `port: 0`；云端只用 device code / 粘贴回填（§3.8）；登录可取消 |
| 并发刷新 token 双刷 | store 单队列串行 + `modify` 返回 post-write 值 |
| 旧版本回滚丢配置 | D2 新文件 + `.legacy` 备份 |
| 旧会话模型不在当前 provider | 静默回落到 `activeModel` + 同步 `sessionSettings.modelId`（D22），不改写历史 |
| 云端持有用户订阅 token（D19） | 与 `apiKeyCipher` 同级加密；控制台可随时登出；运维文档写明服务器被攻破的影响面 |
| 云端粘贴式 OAuth 的 UX（§3.8） | 界面必须把"打开链接 → 复制地址栏 → 粘回"写成三步；优先推荐 device code 两家 |
| `apps/cloud` 不直接依赖 `@earendil-works/pi-ai` | catalog / 白名单 / 凭证内核全部从 `pi-bridge` 再导出（否则新增依赖）+ 避开两份 catalog 版本不一致 |
| OAuth 刷新失败（`invalid_grant`） | SDK 保留旧凭证并报 `ModelsError` code `oauth`；setting 页必须从“已连接”切到“需重新登录”，否则用户只看到会话报错 |
| 云端并发登录抢端口 | `openai` 的浏览器分支强绑 `CALLBACK_PORT`（1455），同容器内并发登录会 EADDRINUSE 硬失败；云端必须串行化登录并明确提示 |
| 调小上下文导致老会话频繁压缩 | 一次性提示 + `overflow recovery` 兜底（§3.7） |
| 用户手工改 `models.json` | 不支持（D13）：启动覆盖 + 文档写明 |

---

## 13. 遗留问题（不阻塞本次）

1. **D12 的"删除同步"**：远端快照只覆盖已成功刷新的 provider；清缓存后可能短暂回退旧列表。
2. **models.dev 富数据**（§8.3）需要独立条目与独立评审。
3. `openai` 与 `openai-codex` 是两套独立凭证，ChatGPT 订阅额度在上游如何共享不在我们控制范围内，UI 只做说明。
4. **自建 OAuth 应用（用自己的域名做回调）**：需要向每家厂商申请 client_id + 备案回调域名，并自行实现授权码交换（SDK 不暴露 client_id 覆写）。若将来做成，云端 UX 可去掉粘贴步骤（§3.8）。
