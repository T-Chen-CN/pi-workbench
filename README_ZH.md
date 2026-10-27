# Pi Workbench - 中文文档

> 基于 Electron + React 的轻量级 AI 辅助开发工作台

**版本**: 0.6.2
**状态**: Phase 6 持续
**最后更新**: 2026-10-27

---

## 📋 项目简介

Pi Workbench 是一个轻量级桌面应用，提供类似 Cursor IDE 的开发体验，集成 **Pi Agent** 作为智能助手内核。

### 核心特性

- ✅ **代码编辑**：Monaco Editor，多标签、2 秒防抖自动保存
- ✅ **文件管理**：浏览、新建、重命名、删除，文件监听自动刷新
- ✅ **AI 聊天**：真实 Pi Agent（read / write / edit / bash 工具）
- ✅ **Diff 查看**：Agent 修改以消息内变更卡展示，可逐文件查看 Diff 并还原
- ✅ **多供应商**：任意 OpenAI 兼容端点（DeepSeek、网关等）
- ✅ **模型拉取**：从供应商真实获取模型列表并选择
- ✅ **安全存储**：API Key 使用 Electron `safeStorage` 加密
- ✅ **会话持久化**：按工作区恢复历史对话
- ✅ **便携式**：所有数据在应用目录内（macOS 打包版例外：`~/Library/Application Support/pi-workbench`）
- ✅ **中英文国际化**

---

## 🔧 技术栈

| 层级     | 技术                            | 版本              |
| -------- | ------------------------------- | ----------------- |
| 桌面框架 | Electron                        | 44.9.1（Node 24） |
| 前端     | React + TypeScript              | 19 / 5.9          |
| 构建     | Vite                            | 5.4               |
| 编辑器   | Monaco Editor                   | 0.57              |
| 状态管理 | Zustand                         | 4.5               |
| 样式     | TailwindCSS                     | 3.4               |
| Agent    | @earendil-works/pi-coding-agent | 1.3               |
| 测试     | Vitest                          | 2.1               |

---

## 📦 环境要求

- **Node.js ≥ 24**（Electron 44 内置 Node 24；工作区记录使用 node:sqlite）
- npm
- Git for Windows（可选，启用 Agent 的 bash 工具）

---

## 🚀 快速开始

```bash
npm install

# 开发（自动构建 pi-bridge 与主进程，然后启动 Vite + Electron）
npm run dev

# 仅 Web 调试（Agent 由 Vite dev 中间件承载）
npm run web:dev
```

### 质量检查

```bash
npm run type-check
npm test
npm run lint
npm run build
```

### 打包

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

输出目录：`release/`。详见 [构建与打包指南](docs/guides/BUILD_AND_PACKAGE.md)。

---

## ⚙️ 配置

打开 **Settings**：

1. 选择 **Provider**（Anthropic / OpenAI / Custom）
2. 填写 **API URL**（如 `https://api.deepseek.com/v1`）
3. 填写 **API Key**
4. 点击 **Fetch Available Models** 并选择模型
5. 点击 **Save Configuration**

API Key 通过 Electron `safeStorage` 加密后写入 `config/api-config.json`；
`data/agent/models.json` 仅引用环境变量，不包含明文 Key。

---

## 📂 目录结构

```
electron/        Electron 主进程（main.ts、preload.cts）
src/             React 渲染进程（components、store、api、i18n）
pi-bridge/       Pi Agent 桥接层（AgentManager，主进程内运行）
tests/           Vitest 单元测试
docs/            项目文档
```

更完整的架构说明见 [docs/architecture/PROJECT_STRUCTURE.md](docs/architecture/PROJECT_STRUCTURE.md)。

---

## 💾 数据位置（便携式）

```
{应用目录}/config/    settings.json、api-config.json（Key 加密）
{应用目录}/cache/     临时文件
{应用目录}/data/      Agent 模型配置与会话
{应用目录}/logs/      日志
```

工作区数据：`{工作区}/.pi-workbench/`

整体拷贝应用目录即可迁移，无外部路径依赖。

---

## 📚 文档

- [项目方案](docs/PROJECT_PLAN.md)
- [项目结构](docs/architecture/PROJECT_STRUCTURE.md)
- [构建与打包](docs/guides/BUILD_AND_PACKAGE.md)
- [Agent 测试清单](docs/guides/AGENT-TESTING.md)
- [项目状态](docs/progress/STATUS.md)
- [待开发清单（已收尾）](docs/progress/BACKLOG.md)
- [v1 功能方案（已归档）](docs/progress/ROADMAP.md)
- [Phase 1 完成报告](docs/progress/PHASE-1-COMPLETE.md)

English README: [README.md](README.md)

---

## 📄 许可证

见 [LICENSE](LICENSE)。
