# 🎨 CSS 到 TailwindCSS 迁移计划

**状态**: ✅ 已完成（2026-10-20；执行结果见 [CSS_MIGRATION_COMPLETED.md](./reports/CSS_MIGRATION_COMPLETED.md)）

**归档说明**: 本文件为历史计划；当前样式规范以 [DESIGN_SYSTEM.md](./design/DESIGN_SYSTEM.md) 为准。
**优先级**: 🟡 中  
**预计工作量**: 4-8 小时  
**目标完成**: 已完成

> 本文保留为原始计划。组件级 `.css` 已全部删除并迁移到 Tailwind 与设计 token；
> `src/index.css` 刻意保留，作为 `@tailwind` 入口与 Paper / Ink token 的载体。

---

## 📊 当前 CSS 使用情况

### 代码统计
```
src/App.css ........................ 781 行 (全局 + 组件混合)
src/styles/ChatPanel.css ........... 128 行 (ChatPanel 组件)
src/styles/DiffViewer.css .......... 145 行 (DiffViewer 组件)
src/styles/Settings.css ........... 68 行 (Settings 组件)
src/index.css ...................... 44 行 (@tailwind + CSS 变量)
─────────────────────────────────────────────────
总计: 1,166 行 CSS

TailwindCSS 配置:
✅ tailwind.config.js - 已配置
✅ PostCSS - 已配置
⚠️ 但实际使用率 < 5%（大多是手写 CSS）
```

### CSS 类统计
```bash
# 全局类定义
106 个类在 src/App.css 中
28 个类在 src/styles/ChatPanel.css 中
18 个类在 src/styles/DiffViewer.css 中
12 个类在 src/styles/Settings.css 中
─────────────────────────
总计: ~164 个自定义 CSS 类
```

### 问题分析
```
❌ CSS 变量依赖 (--bg-primary 等)
❌ 响应式设计分散在 CSS 中
❌ 没有统一的设计系统
❌ 难以维护和修改
❌ 体积冗余 (~1,100 行可以削减)
```

---

## 🎯 迁移目标

### 定量目标
| 指标 | 当前 | 目标 | 改进 |
|------|------|------|------|
| CSS 行数 | 1,166 | < 200 | ↓ 83% |
| CSS 文件数 | 5 | 1 | ↓ 80% |
| 自定义类 | 164 | < 20 | ↓ 88% |
| 代码体积 | ~35KB | ~7KB | ↓ 80% |

### 定性目标
- ✅ 完全使用 TailwindCSS 原子化类
- ✅ 删除所有 .css 组件文件
- ✅ 保持 100% 视觉一致性
- ✅ 改进响应式设计
- ✅ 提高开发效率

---

## 📋 迁移阶段

### 阶段 1: 分析和规划 (1-2 小时)

**任务**:
- [x] 审计所有 CSS 类的使用情况
- [x] 创建 Tailwind 类名映射表
- [x] 识别特殊样式需要保留
- [x] 制定迁移顺序

**输出物**:
- CSS 类使用统计表
- 迁移优先级列表
- 保留项清单

**验证**:
```bash
# 生成 CSS 类使用报告
grep -oE '\.[a-zA-Z0-9-]+' src/App.css src/styles/*.css | sort | uniq -c
```

---

### 阶段 2: 基础布局迁移 (1-2 小时)

**目标组件**: App.tsx, 主布局框架

**CSS 迁移示例**:
```css
/* 旧: src/App.css */
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
  gap: 16px;
}

.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  background: var(--bg-primary);
}

.workspace {
  display: grid;
  grid-template-columns: 250px 1fr 300px;
  width: 100%;
  height: 100%;
  gap: 1px;
  background: var(--border);
}
```

```typescript
/* 新: 使用 TailwindCSS */
export default function App() {
  return (
    <div className="flex flex-col h-screen bg-white dark:bg-[#1e1e1e]">
      <header className="flex justify-between items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] gap-4 flex-shrink-0">
        <h1 className="text-lg font-semibold">Pi Workbench</h1>
        {/* ... */}
      </header>

      <main className="flex-1 overflow-hidden flex bg-white dark:bg-[#1e1e1e]">
        <div className="grid grid-cols-[250px_1fr_300px] w-full h-full gap-px bg-gray-300 dark:bg-gray-700">
          {/* ... */}
        </div>
      </main>
    </div>
  )
}
```

**迁移清单**:
- [x] App 布局 (.app)
- [x] Header (.header)
- [x] Main (.main)
- [x] Workspace (.workspace)
- [x] Sidebar (.sidebar)

**验证方式**:
```bash
npm run dev
# 视觉对比：所有布局应该完全一样
```

---

### 阶段 3: 组件样式迁移 (2-3 小时)

#### 3.1 ChatPanel 迁移
**文件**: `src/components/ChatPanel.tsx` + `src/styles/ChatPanel.css`

**工作量**: 1 小时

**当前 CSS 统计**:
```bash
wc -l src/styles/ChatPanel.css  # 128 行
grep "^\." src/styles/ChatPanel.css | wc -l  # 28 个类
```

**迁移策略**:
- 所有样式转换为 className 中的 Tailwind 类
- 删除 `import '../styles/ChatPanel.css'`
- 验证所有状态（加载、错误、滚动等）

---

#### 3.2 DiffViewer 迁移
**文件**: `src/components/DiffViewer.tsx` + `src/styles/DiffViewer.css`

**工作量**: 1 小时

**注意项**:
- Diff 行号样式
- 添加/删除/修改行的颜色
- 代码块对比样式

---

#### 3.3 Settings 迁移
**文件**: `src/components/Settings.tsx` + `src/styles/Settings.css`

**工作量**: 30 分钟

**包含**:
- 模态框背景
- 设置面板
- 语言选择按钮

---

### 阶段 4: 验证和清理 (30 分钟 - 1 小时)

**任务清单**:
- [x] 全屏浏览器测试（不同分辨率）
- [x] 深色模式验证
- [x] 响应式设计测试
- [x] 性能检查（CSS 文件大小）
- [x] 删除所有 .css 文件（组件级已删除；`src/index.css` 作为 @tailwind 入口与 token 载体保留）
- [x] 删除 CSS 导入语句（仅保留 `index.css` 与第三方组件 CSS）

**验证命令**:
```bash
# 确保没有 .css 文件导入
grep -r "import.*\.css" src/ --include="*.tsx" --include="*.ts"
# 结果应该为空（除了 src/index.css）

# 检查编译
npm run build

# 检查应用启动
npm run dev
```

**最终清理**:
```bash
rm -f src/App.css src/styles/*.css
# 保留: src/index.css（包含 @tailwind 指令）
```

---

## 🛠️ 工具和资源

### Tailwind 文档
- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [Tailwind 暗色模式](https://tailwindcss.com/docs/dark-mode)
- [响应式设计](https://tailwindcss.com/docs/responsive-design)

### CSS 到 Tailwind 转换工具
```bash
# 检查特定样式的 Tailwind 等价物
# 例: flex-direction: column → flex-col

# VS Code 扩展推荐
# - Tailwind CSS IntelliSense
# - PostCSS Language Support
```

### 设计系统（当前）
```css
/* 当前 CSS 变量 */
--bg-primary: #ffffff (#1e1e1e dark)
--bg-secondary: #f5f5f5 (#252526 dark)
--text-primary: #333333 (#e0e0e0 dark)
--text-secondary: #666666 (#999999 dark)
--border: #e0e0e0 (#3e3e42 dark)
--accent: #007acc

/* 转换为 Tailwind：*/
bg-white dark:bg-[#1e1e1e]
bg-gray-50 dark:bg-[#252526]
text-gray-900 dark:text-gray-200
text-gray-600 dark:text-gray-400
border-gray-200 dark:border-gray-700
bg-blue-600
```

---

## 📅 实施时间表

### 推荐计划
```
【第 1 周 - 阶段 1】2-4 小时
├─ 分析 CSS 使用情况
├─ 创建迁移映射表
└─ 确认迁移顺序

【第 2 周 - 阶段 2】1-2 小时
├─ 迁移主布局
├─ 迁移 Header/Footer
└─ 验证整体布局

【第 2 周 - 阶段 3】2-3 小时
├─ 迁移 ChatPanel
├─ 迁移 DiffViewer
└─ 迁移 Settings

【第 3 周 - 阶段 4】30-60 分钟
├─ 全面测试
├─ 删除 CSS 文件
└─ 最终验证
```

**总计**: 4-8 小时（2-3 周内完成）

---

## 🚀 快速开始

要启动迁移，按以下步骤：

1. 创建新分支
```bash
git checkout -b refactor/css-to-tailwind
```

2. 从阶段 1 开始
```bash
# 审计 CSS 使用情况
grep -oE '\.[a-zA-Z0-9-]+' src/**/*.css | sort | uniq -c > css-audit.txt
```

3. 逐个组件迁移
```bash
# 迁移完一个组件后立即提交
git add src/components/ChatPanel.tsx src/styles/ChatPanel.css
git commit -m "refactor: Migrate ChatPanel to TailwindCSS"
```

4. 最终提交
```bash
git push origin refactor/css-to-tailwind
# 创建 PR 进行审查
```

---

## 📊 进度跟踪

### 完成指标
```
[x] 阶段 1: CSS 审计和规划
[x] 阶段 2: 基础布局迁移
[x] 阶段 3: 组件迁移
  [x] ChatPanel
  [x] DiffViewer
  [x] Settings
[x] 阶段 4: 验证和清理
```

### 质量检查
```
[x] 视觉一致性 100%
[x] 暗色模式正常
[x] 响应式设计正常
[x] TypeScript 无错误
[x] npm run build 成功
[x] npm run dev 正常启动
```

---

## 💡 注意事项

### 不要做的事
❌ 一次性全部迁移（容易出错）  
❌ 在迁移时修改其他内容  
❌ 删除 src/index.css（保留 @tailwind）  
❌ 保留任何 .css 文件导入  

### 要做的事
✅ 逐个组件迁移  
✅ 边迁移边测试  
✅ 每个完成的组件立即提交  
✅ 定期运行 npm run dev 验证  

---

## 🔄 回滚计划

如果迁移出现问题：

```bash
# 查看 git 历史
git log --oneline

# 回滚到某个提交
git revert <commit-hash>

# 或完全回滚分支
git reset --hard origin/main
```

---

**创建时间**: 2026-10-20  
**更新**: 按实际迁移进度更新  
**负责人**: 待分配
