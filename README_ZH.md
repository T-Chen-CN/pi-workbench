# Pi Workbench - 中文文档

> 基于 Electron + React 的轻量级 AI 辅助开发工作台

**版本**: 0.1.0  
**状态**: MVP 完成 ✅  
**最后更新**: 2026-10-20

---

## 📋 项目简介

Pi Workbench 是一个**轻量级桌面应用**，提供类似 Cursor IDE 的开发体验，集成 **Pi Agent** 作为智能助手内核。

### 核心特性

- ✅ **代码编辑**: Monaco Editor（VS Code 同款编辑器）
- ✅ **文件管理**: 完整的文件浏览和操作
- ✅ **AI 聊天**: Pi Agent 智能助手（目前为 Mock）
- ✅ **Diff 查看**: 代码变更对比
- ✅ **中英双语**: 完整的国际化支持
- ✅ **跨平台**: Windows / macOS / Linux

---

## 🚀 快速开始

### 环境要求

- Node.js 18+
- npm 或 pnpm

### 安装依赖

```bash
npm install
```

如果 npm 很慢，配置国内镜像：
```bash
npm config set registry https://registry.npmmirror.com
```

### 开发模式

```bash
# 完整开发环境（推荐）
npm run dev

# 仅浏览器开发（调试前端）
npm run web:dev

# 访问 http://localhost:5173
```

### 构建应用

```bash
# 构建所有
npm run build

# 打包桌面应用
npm run package          # 当前平台
npm run package:win      # Windows
npm run package:mac      # macOS
npm run package:linux    # Linux
```

---

## 💡 使用指南

### 1. 打开项目

1. 点击顶部的 **"打开项目"** 按钮
2. 选择一个项目文件夹
3. 左侧会显示项目的文件树

### 2. 编辑文件

1. 在左侧文件树中点击文件名
2. 文件会在中间编辑器中打开
3. 编辑完成后自动保存（2 秒防抖）
4. 点击标签页上的 **✕** 关闭文件

### 3. 创建新文件

> 功能开发中，即将上线

### 4. 与 AI 聊天

1. 在右侧聊天框输入问题
2. 按 Enter 键发送（Shift+Enter 换行）
3. AI 会回复代码相关问题（目前为 Mock 响应）
4. 支持多轮对话

### 5. 查看代码变更

1. 点击底部的 **"Diff"** 按钮
2. 选择 Split 或 Unified 视图
3. 高亮显示代码修改

---

## 📂 项目结构

```
pi-workbench/
├── electron/                     # Electron 主进程
│   ├── main.ts                  # 主进程入口、窗口管理、IPC
│   ├── preload.ts               # 预加载脚本、contextBridge
│   └── tsconfig.json
│
├── src/                         # React 渲染进程
│   ├── components/              # React 组件
│   │   ├── FileExplorer.tsx    # 文件浏览器
│   │   ├── MonacoEditor.tsx    # 代码编辑器
│   │   ├── ChatPanel.tsx       # 聊天面板
│   │   ├── DiffViewer.tsx      # Diff 查看器
│   │   ├── Editor.tsx          # 编辑器封装
│   │   ├── Settings.tsx        # 设置面板
│   │   ├── Toast.tsx           # 通知系统
│   │   └── IPCDebug.tsx        # IPC 调试
│   ├── store/                  # Zustand 状态管理
│   │   ├── editorStore.ts      # 编辑器状态
│   │   ├── chatStore.ts        # 聊天状态
│   │   ├── diffStore.ts        # Diff 状态
│   │   ├── errorStore.ts       # 错误处理
│   │   ├── i18nStore.ts        # 国际化
│   │   └── agentStore.ts       # Agent 状态
│   ├── api/                    # API 封装
│   │   ├── index.ts            # Electron IPC 封装
│   │   ├── diff.ts             # Diff 算法
│   │   └── piAgent.ts          # Pi Agent Mock
│   ├── types/                  # TypeScript 类型
│   │   ├── electron.d.ts       # Electron API 类型
│   │   └── index.ts            # 通用类型
│   ├── i18n/                   # 国际化
│   │   └── translations.ts     # 中英文翻译
│   ├── styles/                 # 样式
│   ├── App.tsx                 # 主应用组件
│   └── main.tsx                # React 入口
│
├── pi-bridge/                   # Pi Agent 桥接（待实现）
│   ├── src/
│   │   └── index.ts            # Agent 管理器
│   ├── package.json
│   └── tsconfig.json
│
├── docs/                        # 项目文档
│   ├── PROJECT_PLAN.md         # 项目方案
│   ├── README.md               # 文档导航
│   ├── architecture/           # 架构设计
│   ├── guides/                 # 开发指南
│   ├── progress/               # 项目进度
│   └── reports/                # 审查报告
│
├── dist/                        # Vite 构建输出
├── dist-electron/               # Electron 构建输出
├── release/                     # 应用打包输出
│
├── package.json                 # 项目依赖
├── tsconfig.json                # TypeScript 配置
├── vite.config.ts               # Vite 配置
├── electron-builder.yml         # 打包配置
├── tailwind.config.js           # Tailwind 配置
└── AGENTS.md                    # AI 助手开发指南
```

---

## 🔧 技术栈

### 桌面框架
- **Electron 28** - 成熟的跨平台桌面框架

### 前端技术
- **React 19** - 最新的 UI 框架
- **Vite 5** - 快速的构建工具和 HMR
- **TypeScript** - 类型安全
- **TailwindCSS** - 原子化 CSS
- **Zustand** - 轻量级状态管理
- **Monaco Editor** - VS Code 编辑器内核

### 后端技术（主进程）
- **TypeScript** - 类型安全的 Node.js
- **Node.js fs/promises** - 异步文件操作
- **Electron IPC** - 进程间通信

### 计划集成
- **@earendil-works/pi-agent-core** - Pi Agent 运行时
- **@earendil-works/pi-ai** - LLM API 封装
- **Anthropic Claude** - AI 模型

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+O | 打开项目 |
| Ctrl+S | 保存当前文件 |
| Ctrl+W | 关闭当前标签页 |
| Ctrl+Z | 撤销编辑 |
| Ctrl+Y | 重做编辑 |
| Enter | 发送聊天消息 |
| Shift+Enter | 聊天输入框中换行 |
| F12 | 打开开发者工具 |

---

## 📊 界面介绍

### 布局结构

```
┌─────────────────────────────────────────────┐
│  标题栏 - 打开项目 | 设置 | 语言切换        │
├──────────┬──────────────────────────────────┤
│          │  编辑器标签页                     │
│  文件    ├──────────────────────────────────┤
│  浏览器  │                                  │
│          │  Monaco Editor                   │
│  200px   │  代码编辑区域                     │
│          │                                  │
├──────────┼──────────────────────────────────┤
│          │  聊天面板（可折叠）               │
│          │  与 Pi Agent 对话                │
└──────────┴──────────────────────────────────┘
```

### 左侧：文件浏览器
- 显示项目目录树
- 点击文件打开到编辑器
- 展开/折叠文件夹
- 支持深层级嵌套

### 中间：代码编辑器
- Monaco Editor（VS Code 同款）
- 支持 40+ 种编程语言
- 语法高亮和智能提示
- 多标签页支持
- 自动保存（2 秒防抖）

### 右下：聊天面板
- 与 Pi Agent 对话（目前为 Mock）
- 多轮对话支持
- 消息历史记录
- 自动滚动

---

## 🛠️ 常见操作

### 切换语言

点击顶部的 **"English"** 或 **"中文"** 按钮

### 查看 Diff

1. 修改文件后
2. 点击底部的 **"Diff"** 按钮
3. 选择查看模式（Split / Unified）

### 调试 IPC

1. 点击底部的 **"IPC Debug"** 按钮
2. 查看所有 IPC 调用记录

### 打开开发者工具

按 **F12** 或在菜单中选择

---

## 🐛 故障排除

### 问题：页面无法加载

**解决方案**：
```bash
# 清理缓存并重新安装
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### 问题：npm 安装很慢

**解决方案**：配置国内镜像
```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### 问题：端口 5173 被占用

**Windows 解决方案**：
```bash
# 查看占用进程
netstat -ano | findstr :5173

# 杀死进程（根据 PID）
taskkill /PID <PID> /F
```

**macOS/Linux 解决方案**：
```bash
# 查看占用进程
lsof -i :5173

# 杀死进程
kill -9 <PID>
```

### 问题：编辑器不显示内容

**解决方案**：
1. 刷新页面（Ctrl+R）
2. 或重启应用

### 问题：文件树无法展开

**解决方案**：检查文件夹权限，确保应用有读取权限

---

## 📚 文档资源

### 核心文档
- **[项目方案](docs/PROJECT_PLAN.md)** - 完整的项目规划和路线图
- **[项目结构](docs/architecture/PROJECT_STRUCTURE.md)** - 架构详解
- **[开发指南](AGENTS.md)** - AI 助手开发约束
- **[构建打包](docs/guides/BUILD_AND_PACKAGE.md)** - 打包发布流程
- **[项目状态](docs/progress/STATUS.md)** - 功能进度追踪

### 官方文档
- [Electron 文档](https://www.electronjs.org/zh/docs/latest/)
- [React 文档](https://zh-hans.react.dev/)
- [Vite 文档](https://cn.vitejs.dev/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)

---

## 🚧 开发路线图

### ✅ Phase 0: MVP（已完成 - 2026-10-20）

- ✅ 文件管理（浏览、读写）
- ✅ Monaco Editor 集成
- ✅ 多标签页支持
- ✅ 聊天面板（Mock Agent）
- ✅ Diff 查看器
- ✅ 中英文国际化
- ✅ Toast 通知系统

### 🔄 Phase 1: Pi Agent 真实集成（进行中）

- [ ] 安装 Pi 核心模块
- [ ] 实现 Agent Manager
- [ ] 配置 Anthropic Claude API
- [ ] 集成工具系统（read/write/edit/bash）
- [ ] 流式响应支持

### 📋 Phase 2: 工作区管理

- [ ] 多工作区支持
- [ ] 工作区级 Agent 实例
- [ ] 会话持久化
- [ ] 快速切换工作区

### 📋 Phase 3: 终端集成

- [ ] 集成 xterm.js
- [ ] Bash 命令执行
- [ ] PTY 支持

### 📋 Phase 4: 插件系统（简化版）

- [ ] 从 `.pi-workbench/plugins/` 加载插件
- [ ] 插件热重载
- [ ] 简单的 TypeScript SDK

---

## 🤝 贡献指南

### 开发规范

- 使用 TypeScript 严格模式
- 遵循 Electron 安全最佳实践
- 所有文件系统操作通过 IPC
- 使用 Zustand 管理状态（不是 Redux）
- 使用 TailwindCSS 编写样式
- 提交前运行 `npm run type-check`

### Commit Message 格式

```
<type>(<scope>): <subject>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

**Type**: feat, fix, docs, refactor, style, test, chore  
**Scope**: agent, editor, file, ui, ipc

---

## 📞 联系方式

- **项目地址**: [GitHub](https://github.com/your-org/pi-workbench)
- **问题反馈**: [GitHub Issues](https://github.com/your-org/pi-workbench/issues)

---

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

---

**版本**: 0.1.0  
**状态**: MVP 完成 ✅  
**架构**: Electron 28 + React 19  
**最后更新**: 2026-10-20  

🚀 **让我们开始吧！**
