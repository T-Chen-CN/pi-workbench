# 项目状态

本文件汇总项目的进度和完成状态。

## 最新状态

**更新时间**: 2026-10-20

- ✅ **Phase 0: MVP** — Electron 框架、文件管理、编辑器、Diff、国际化
- ✅ **便携式架构** — 所有应用数据自包含在应用目录内
- ✅ **Phase 1: Pi Agent 集成** — 真实 Agent 可用（模型拉取 / 对话 / 工具）
- ⏳ **Phase 2-6** — 待开发

## 当前版本

- **版本**: 0.1.0
- **框架**: Electron 44 + React 19 + TypeScript
- **Agent**: `@earendil-works/pi-coding-agent` 1.3.0
- **状态**: Phase 1 完成，Electron 与纯 Web（开发模式）均可真实对话

## 功能清单

### ✅ Phase 0: MVP（2026-10-20 完成）

- 桌面应用框架（Electron 44）
- 代码编辑器（Monaco Editor，自动保存 2s 防抖）
- 文件浏览器与多标签页
- Diff 查看器（Split / Unified）
- 聊天面板、设置面板
- 中英文国际化
- Toast 通知系统（全局 store）
- IPC 调试工具

### ✅ 便携式架构（2026-10-20 完成）

- 应用目录结构初始化（`config/`、`cache/`、`data/`、`logs/`）
- `getAppDir()` 路径管理（生产 = 可执行文件目录，开发 = 项目根目录）
- 应用配置 / 工作区配置管理 API
- 路径规范文档

### ✅ Phase 1: Pi Agent 真实集成（2026-10-20 完成）

- 统一 OpenAI 兼容的 API 配置：Provider + URL + Key + 拉取模型 + 选择模型
- 真实调用供应商 `/models` 拉取模型列表（Anthropic / OpenAI / 任意兼容端点）
- API Key 使用 Electron `safeStorage` 加密存储于 `{appDir}/config/api-config.json`
- AgentManager 在主进程运行，基于 `pi-coding-agent` SDK
- 自动生成 `data/agent/models.json`，支持 DeepSeek 等兼容端点
- read / write / edit / bash 工具可用
- 供应商错误（401、限流等）原样透传到聊天面板
- preload 采用 CommonJS 编译（sandbox 兼容），并提供启动自检
- 纯 Web 开发模式：Vite 中间件提供模型拉取代理与 Agent 桥接
- 已知限制：无流式输出（见 Phase 1 报告）

详细报告：[Phase 1 完成报告](./PHASE-1-COMPLETE.md)

### ✅ Phase 1 加固（2026-10-20）

- 工作区生命周期闭环：打开时初始化 `.pi-workbench/`、切换/关闭时释放 Agent 并清空编辑器/聊天/Diff 状态
- 最近打开工作区列表（`config/settings.json`），欢迎页可直接打开
- 会话持久化：按工作区恢复 Pi 会话与聊天历史（跨重启）
- Agent 编辑捕获：write/edit 工具前后内容对比 → 自动打开 DiffViewer
- 文件操作补齐：重命名、删除；递归文件监听（300ms 防抖）
- 外部文件变化：未被本地修改时自动同步编辑器内容，删除时关闭标签
- 未保存保护：关闭标签 / 关闭工作区 / 关闭窗口均提示
- 修复 `markDirty` 未更新 `isDirty` 的问题（未保存圆点现在正确显示）
- 删除死代码：`Editor.tsx`、`errorStore`、旧 Mock IPC
- 工程化：Vitest 单元测试、ESLint、Prettier、GitHub Actions CI
- `pi-bridge/dist` 移出版本库（构建时生成）

### ⏳ 待实现

#### Phase 2: 工作区与对话体验（进行中）

- ✅ 最近打开列表（JSON，`config/settings.json`）
- ✅ 工作区生命周期（初始化 / 切换清理 / 关闭）
- ✅ 会话持久化与恢复（Pi 会话 + UI 历史）
- ✅ 主进程文件日志（`{appDir}/logs/main.log`，5MB 轮转并保留 `.1` 备份；渲染进程日志待补）
- ✅ 流式输出（Electron：主进程推送 `text_delta` 增量；Web dev 模式仍整轮返回）
- ✅ Agent 修改审阅：本轮全部文件修改进入队列，可逐项保留或还原为修改前内容（修改已落盘，属事后审阅）
- ⏳ 上下文选择（文件 / 符号注入对话）
- ⏳ 多工作区并行 + 工作区级 Agent 实例
- ⏳ 工作区数据库（SQLite，`{appDir}/data/workspaces.db`，视 Fleet 规模再评估）

#### Phase 3: 终端集成（预计 1 周）

- xterm.js + node-pty
- Bash 命令执行与日志
- 终端与 Agent 工具联动

#### Phase 4: 工作台插件系统（预计 1-2 周）

- 插件清单与主进程加载器（只扩展工作台，不扩展 Pi Agent）
- 命令 / 菜单 / 钩子 / 状态项贡献点
- 启用禁用与热重载
- 示例插件（Git）

#### Phase 5: Fleet 任务系统（预计 2-3 周）

- Git worktree 管理
- 后台 Agent 任务队列与监控

#### Phase 6: 优化和完善（持续）

- 性能优化、撤销/重做、快捷键、主题系统、崩溃恢复、自动更新
- 已完成：构建分包、生产 CSP、主进程测试覆盖

## 最近提交

详见 git 提交历史。

---

**更新时间**: 2026-10-20
