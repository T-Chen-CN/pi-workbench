# 📚 Pi Workbench 文档中心

欢迎来到 Pi Workbench 项目文档。

## 🚀 快速开始

### 环境要求
- Node.js 18+
- npm 或 pnpm

### 安装和运行

```bash
# 安装依赖
npm install

# 构建 pi-bridge
npm run build:bridge

# 启动开发环境
npm run dev
```

应用将在 Vite 开发服务器和 Electron 窗口中同时启动。

---

## 📁 文档导航

### 📋 项目规划
- **[项目方案](./PROJECT_PLAN.md)** - 完整的项目方案、技术架构和开发路线图 ⭐

### 🏗️ 架构和设计
- **[项目结构](./architecture/PROJECT_STRUCTURE.md)** - 了解项目的代码组织和架构

### 🔧 开发指南
- **[构建和打包](./guides/BUILD_AND_PACKAGE.md)** - 如何构建应用和打包发布

### 📊 项目信息
- **[项目状态](./progress/STATUS.md)** - 当前的功能状态和进度

### 📋 审查报告
- **[管理审查总结](./reports/MANAGEMENT_REVIEW_SUMMARY.md)** - 项目文件管理审查
- **[完整审查报告](./reports/FILE_AND_GIT_MANAGEMENT_REPORT.md)** - 详细分析
- **[文件结构分析](./reports/FILE_STRUCTURE_ANALYSIS.md)** - 结构改进方案
- **[Git 配置指南](./reports/GIT_CONFIGURATION_GUIDE.md)** - Git 配置建议

---

## 🎯 按任务查找

| 我想... | 查看文档 |
|--------|---------|
| 了解项目全貌和规划 | [PROJECT_PLAN.md](./PROJECT_PLAN.md) ⭐ |
| 了解项目结构 | [PROJECT_STRUCTURE.md](./architecture/PROJECT_STRUCTURE.md) |
| 构建和发布应用 | [BUILD_AND_PACKAGE.md](./guides/BUILD_AND_PACKAGE.md) |
| 查看功能状态 | [STATUS.md](./progress/STATUS.md) |
| 了解文件管理 | [审查报告](./reports/) |

---

## 💡 开发常见问题

### 如何启动开发环境？

**完整开发环境**（推荐）:
```bash
npm run dev
```

**仅浏览器开发**（UI 调试）:
```bash
npm run web:dev
```

**分离模式**:
```bash
# Terminal 1: 启动 Vite
npm run web:dev

# Terminal 2: 启动 Electron
npm run electron:dev
```

### 如何打包应用？

```bash
npm run build          # 构建所有
npm run package        # 打包当前平台
npm run package:win    # Windows
npm run package:mac    # macOS
npm run package:linux  # Linux
```

输出目录：`release/`

### 项目使用了哪些技术？

- **桌面框架**: Electron 28
- **前端**: React 19 + TypeScript
- **编辑器**: Monaco Editor
- **构建**: Vite 5
- **状态管理**: Zustand
- **样式**: TailwindCSS

---

## 🔗 相关链接

- [主项目 README](../README.md)
- [中文 README](../README_ZH.md)
- [Electron 官方文档](https://www.electronjs.org/docs/latest/)
- [React 官方文档](https://react.dev/)

---

**文档版本**: 1.0  
**最后更新**: 2026-10-20  
**项目版本**: 0.1.0

需要帮助？查看相关文档或在项目中提交 issue。
