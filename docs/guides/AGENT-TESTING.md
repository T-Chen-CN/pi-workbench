# Pi Agent 测试清单

本文件提供测试 Phase 1 Pi Agent 集成功能的步骤和预期结果。

---

## 🚀 启动应用

```bash
# 安装依赖（如果还没有）
npm install

# 启动开发服务器
npm run dev
```

应用应该在新窗口中打开。

---

## ✅ 测试项目

### 1. API Key 配置 ✅

**步骤**:
1. 在侧边栏找到 Settings 图标并点击
2. 滚动到 "API Keys" 部分
3. 在 "Anthropic Claude" 输入框中输入你的 API Key
   - 如果没有，请前往 https://console.anthropic.com/account/keys 创建
4. 点击 "Save Settings" 按钮

**预期结果**:
- ✅ Toast 通知："Settings saved successfully"
- ✅ API Key 输入框旁边显示绿色的 "✓" 图标

**验证存储**:
- 检查 `config/api-keys.json` 文件是否存在（加密的）
- 重新打开应用，Settings 中应该记住之前的配置

---

### 2. Agent 初始化 ✅

**步骤**:
1. 打开 Chat Panel（如果尚未打开）
2. 观察面板标题

**预期结果**:
- ✅ 如果配置了 API Key，应该看到 "● Ready" 绿色标记
- ✅ 看到欢迎消息：
  ```
  Pi Agent
  Pi Agent is ready! How can I help you with your code today?
  [时间戳]
  ```
- ❌ 如果未配置 API Key，应该看到：
  ```
  API Key Required
  Please configure your Anthropic API key in Settings to use Pi Agent.
  [Go to Settings] 按钮
  ```

---

### 3. 基础对话测试 ✅

**测试 1: 简单问候**

输入: `Hello, can you help me?`

**预期结果**:
- ✅ Agent 回复类似: "Hello! Yes, I'm Pi Agent..."
- ✅ 消息显示在聊天历史中
- ✅ 自动滚动到最新消息

---

**测试 2: 文件读取**

输入: `Read the package.json file`

**预期结果**:
- ✅ Agent 回复包含 package.json 的内容
- ✅ 提到项目名称 "pi-workbench"
- ✅ 提到版本 "0.1.0"

---

**测试 3: 文件写入**

输入: `Create a new file called test.txt with content "Hello from Pi Agent"`

**预期结果**:
- ✅ Agent 回复确认文件已创建
- ✅ 在项目根目录出现 `test.txt` 文件
- ✅ 文件内容为 "Hello from Pi Agent"

验证:
```bash
cat test.txt
# 应该输出: Hello from Pi Agent
```

---

**测试 4: 文件编辑**

输入: `Edit test.txt and change "Hello" to "Greetings"`

**预期结果**:
- ✅ Agent 回复确认已编辑
- ✅ 文件内容变为 "Greetings from Pi Agent"
- ✅ 如果打开了 Diff Viewer，应该显示差异

验证:
```bash
cat test.txt
# 应该输出: Greetings from Pi Agent
```

---

**测试 5: Bash 命令（Mock）**

输入: `Run the command: echo "Test"`

**预期结果**:
- ⚠️ 当前返回 Mock 输出（因为 bash 工具未完全实现）
- ✅ Agent 回复类似: "Executed: echo \"Test\"\nOutput: [mock output]"

---

### 4. 错误处理测试 ✅

**测试 1: 无效的文件路径**

输入: `Read the file /nonexistent/file.txt`

**预期结果**:
- ✅ Agent 回复包含错误信息
- ✅ 不会崩溃应用

---

**测试 2: 无 API Key（如果测试）**

步骤:
1. 删除 `config/api-keys.json`
2. 重启应用
3. 打开 Chat Panel

**预期结果**:
- ✅ 显示 "API Key Required" 提示
- ✅ 提供 "Go to Settings" 按钮

---

### 5. UI 状态测试 ✅

**测试 1: 加载状态**

步骤:
1. 发送一个需要较长时间处理的请求
2. 观察 UI

**预期结果**:
- ✅ 显示 "Pi Agent: Thinking..." 消息
- ✅ 输入框被禁用
- ✅ Send 按钮被禁用

---

**测试 2: 多轮对话**

步骤:
1. 发送: `What is your name?`
2. 等待回复
3. 发送: `Can you remember what I asked you?`

**预期结果**:
- ✅ 两次回复都显示在聊天历史中
- ✅ 自动滚动
- ✅ Agent 能回忆之前的对话

---

### 6. 便携式架构验证 ✅

**测试**:
1. 检查所有配置文件的位置
2. 验证没有使用系统标准路径

**检查项**:
```bash
# API Keys 应该在应用目录
ls config/api-keys.json  # ✅ 存在

# 不应该在系统 AppData 目录
# Windows: C:\Users\xxx\AppData\Roaming\pi-workbench  # ❌ 不应存在
# macOS: ~/Library/Application Support/pi-workbench  # ❌ 不应存在
```

---

## 🐛 已知问题

### 临时限制

1. **Bash 工具 Mock**
   - 当前 `bash` 工具返回 mock 输出
   - 计划在后续版本实现真实命令执行

2. **工作区路径硬编码**
   - 当前使用 `process.cwd()` 作为工作区
   - Phase 2 将实现真正的工作区管理

3. **没有会话持久化**
   - 关闭应用后聊天历史丢失
   - Phase 2 将实现会话存储

---

## 📊 性能基准

### 预期响应时间

| 操作 | 预期时间 |
|------|---------|
| Agent 初始化 | < 2 秒 |
| 简单对话 | < 3 秒 |
| 文件读取 | < 5 秒 |
| 文件写入 | < 5 秒 |
| 文件编辑 | < 7 秒 |

如果超过预期时间，检查：
- 网络连接
- API Key 是否有效
- Anthropic API 状态

---

## 🔧 故障排除

### Agent 初始化失败

**症状**: 显示 "● Initializing..." 很久不变

**排查步骤**:
1. 打开 DevTools (F12)
2. 查看 Console 错误
3. 检查 Terminal 中的主进程日志
4. 验证 API Key 是否正确

**常见原因**:
- API Key 无效或过期
- 网络连接问题
- Anthropic API 服务故障

---

### 文件操作失败

**症状**: Agent 回复 "Failed to read/write file"

**排查步骤**:
1. 检查文件路径是否正确
2. 验证文件权限
3. 查看主进程日志

---

### Toast 不显示

**症状**: 保存设置后没有通知

**排查步骤**:
1. 检查 Toast 组件是否在 App.tsx 中
2. 查看 errorStore 状态
3. DevTools Console 是否有错误

---

## ✅ 测试完成标准

完成以下所有测试后，Phase 1 集成被认为成功：

- [ ] API Key 配置成功保存和加载
- [ ] Agent 初始化成功（显示 "Ready"）
- [ ] 能够进行基础对话
- [ ] 能够读取文件
- [ ] 能够写入新文件
- [ ] 能够编辑现有文件
- [ ] 错误处理正常
- [ ] UI 状态正确更新
- [ ] 便携式架构验证通过

---

## 📋 测试报告模板

测试完成后，请记录：

```
测试日期: YYYY-MM-DD
测试环境: Windows/macOS/Linux
Node 版本: vX.X.X
测试人: [姓名]

通过的测试:
- [x] API Key 配置
- [x] Agent 初始化
- [x] 文件读取
- ...

失败的测试:
- [ ] Bash 命令执行（预期失败，Mock）

发现的问题:
1. [描述问题]
2. [描述问题]

性能数据:
- Agent 初始化: X.X 秒
- 简单对话: X.X 秒
- 文件操作: X.X 秒

备注:
[其他观察或建议]
```

---

**下一步**: 完成测试后，启动 Phase 2 开发
