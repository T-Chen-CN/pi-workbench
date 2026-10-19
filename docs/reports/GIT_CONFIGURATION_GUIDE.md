# Git 配置修复指南

## 问题总结

| 问题 | 当前状态 | 建议 |
|-----|---------|------|
| **分支名称** | master (不符合现代标准) | 改为 main |
| **远程仓库** | 无配置 | 关联到 GitHub/GitLab |
| **默认分支** | master | 改为 main |
| **文件追踪** | 项目规划文件未跟踪 | 决定是否跟踪 |

---

## 🔧 修复步骤

### 方案 A：迁移到 main 分支 (推荐)

#### 步骤 1：本地重命名分支

```bash
# 查看当前分支
git branch -v
# 输出应该显示: * master

# 重命名 master 为 main
git branch -M master main

# 验证
git branch -v
# 输出应该显示: * main
```

#### 步骤 2：更新 Git 配置 (本地)

```bash
# 查看当前的初始分支设置
git symbolic-ref refs/remotes/origin/HEAD

# 如果需要，设置 main 作为初始分支（推送后自动生效）
```

#### 步骤 3：准备推送 (可选 - 如果有远程仓库)

```bash
# 关联远程仓库
git remote add origin https://github.com/your-username/pi-workbench.git

# 推送新的 main 分支
git push -u origin main

# 删除远程的 master 分支（如果之前推送过）
git push origin --delete master
```

#### 步骤 4：验证配置

```bash
# 检查本地分支
git branch -l

# 检查远程分支（如果有远程仓库）
git branch -r
```

**预期输出:**
```
* main
  remotes/origin/main
```

---

### 方案 B：保持 master，更新文档

如果你不想改变分支名称，则更新相关文档：

#### 修改 README.md

**当前内容:**
```markdown
Main branch (you will usually use this for PRs): main
```

**改为:**
```markdown
Main branch (you will usually use this for PRs): master
```

#### 更新本地 Git 配置

```bash
# 查看 git config 中是否有 init.defaultBranch 设置
git config --local init.defaultBranch

# 设置（可选）
git config --local init.defaultBranch master
```

---

## 🌐 关联远程仓库

### 如果尚未初始化远程

```bash
# 方式 1: GitHub
git remote add origin https://github.com/YOUR_USERNAME/pi-workbench.git

# 方式 2: GitLab
git remote add origin https://gitlab.com/YOUR_USERNAME/pi-workbench.git

# 方式 3: Gitee (码云)
git remote add origin https://gitee.com/YOUR_USERNAME/pi-workbench.git

# 方式 4: 自托管
git remote add origin https://git.example.com/pi-workbench.git

# 验证
git remote -v
# 输出应该显示:
# origin  https://github.com/YOUR_USERNAME/pi-workbench.git (fetch)
# origin  https://github.com/YOUR_USERNAME/pi-workbench.git (push)
```

### 如果已有远程但名称不同

```bash
# 查看现有远程
git remote -v

# 重命名
git remote rename old-name origin

# 或更改 URL
git remote set-url origin https://github.com/YOUR_USERNAME/pi-workbench.git
```

---

## 📝 项目规划文件处理

### 选项 1：跟踪版本控制（推荐用于协作）

```bash
# 方式 A: 放在 docs/planning/ 目录
mkdir -p docs/planning
mv 项目方案.md docs/planning/PROJECT_PLAN.md
mv 项目方案-精简版.md docs/planning/PROJECT_PLAN_SIMPLIFIED.md

# 添加到 Git
git add docs/planning/
git add .gitignore  # 如果更新了规则

# 提交
git commit -m "docs: Add project planning documents to version control

- Move PROJECT_PLAN.md and PROJECT_PLAN_SIMPLIFIED.md to docs/planning/
- Enable tracking of project planning documents for team collaboration
- Update .gitignore to track these documents

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### 选项 2：保持本地（不跟踪）

```bash
# 添加到 .gitignore
echo "项目方案*.md" >> .gitignore

# 提交更改
git add .gitignore
git commit -m "chore: Add project planning files to gitignore

- Exclude 项目方案.md and 项目方案-精简版.md from version control
- These are local development documents not needed for repository

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### 选项 3：混合方案

```bash
# 跟踪简化版（共享规划），忽略完整版（个人工作）
echo "项目方案.md" >> .gitignore

git add 项目方案-精简版.md .gitignore
git commit -m "docs: Track simplified project plan, ignore detailed version

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## 📌 .claude 配置文件处理

### Claude Code 配置

`.claude/launch.json` 包含 Claude Code 特定的启动配置：

```bash
# 查看内容
cat .claude/launch.json
```

### 选项 1：跟踪（便于团队共享配置）

```bash
# 添加到 .gitignore 的排除列表
# (从 .gitignore 中移除 .claude/ 条目，或创建更精细的规则)

git add .claude/
git commit -m "chore: Track Claude Code configuration

- Add .claude/launch.json for shared development configuration
- Allows team members to use consistent Claude Code setup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### 选项 2：忽略（保持个人配置）

当前 `.gitignore` 中**没有**包含 `.claude/` 规则。

如果想忽略它：

```bash
# 添加规则到 .gitignore
echo ".claude/" >> .gitignore

# 从 Git 中移除（如果已跟踪）
git rm -r --cached .claude/

# 提交
git commit -m "chore: Stop tracking Claude Code configuration

- Add .claude/ to .gitignore
- Keep development tool configurations local to each developer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### 推荐方案

保持跟踪有如下好处：
- ✅ 新开发者可快速设置
- ✅ 配置一致性
- ✅ 便于共享启动命令

---

## 🔄 完整修复工作流

### 一键式修复脚本

创建 `fix-git-config.sh`:

```bash
#!/bin/bash

set -e  # 出错立即退出

echo "🔧 开始 Git 配置修复..."

# 步骤 1: 重命名分支
echo "1️⃣  重命名分支: master → main"
git branch -M master main
echo "   ✓ 分支已重命名"

# 步骤 2: 整理文档
echo "2️⃣  创建文档目录结构..."
mkdir -p docs/{architecture,guides,progress,migration,planning}
echo "   ✓ 目录已创建"

# 步骤 3: 移动项目规划文件
echo "3️⃣  整理项目规划文件..."
if [ -f "项目方案.md" ]; then
  mv "项目方案.md" "docs/planning/PROJECT_PLAN.md"
  echo "   ✓ PROJECT_PLAN.md"
fi

if [ -f "项目方案-精简版.md" ]; then
  mv "项目方案-精简版.md" "docs/planning/PROJECT_PLAN_SIMPLIFIED.md"
  echo "   ✓ PROJECT_PLAN_SIMPLIFIED.md"
fi

# 步骤 4: 跟踪 .claude 配置
echo "4️⃣  跟踪 Claude Code 配置..."
git add .claude/ 2>/dev/null || echo "   ⚠️  .claude/ 不存在或已跟踪"

# 步骤 5: 提交更改
echo "5️⃣  提交修改..."
git add docs/ .gitignore

git commit -m "chore: Git configuration and documentation reorganization

Changes:
- Rename default branch from master to main
- Reorganize documentation into docs/ subdirectories
- Track Claude Code configuration in .claude/
- Move project planning documents to version control

This improves repository structure and aligns with modern Git practices.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" || echo "   ⚠️  没有需要提交的更改"

echo ""
echo "✅ Git 配置修复完成！"
echo ""
echo "后续步骤:"
echo "1. 如果有远程仓库，执行："
echo "   git push -u origin main"
echo ""
echo "2. 检查配置:"
git config --local -l | grep -E "^(user|core|init)" || true
```

### 运行修复

```bash
# 给脚本执行权限
chmod +x fix-git-config.sh

# 运行
./fix-git-config.sh
```

---

## ✅ 验证清单

运行此检查确保所有配置正确：

```bash
#!/bin/bash

echo "📋 Git 配置验证清单"
echo ""

# 检查分支
echo "✓ 当前分支:"
git branch --show-current

# 检查远程
echo ""
echo "✓ 远程仓库:"
git remote -v || echo "  (无远程配置)"

# 检查用户
echo ""
echo "✓ Git 用户:"
git config user.name
git config user.email

# 检查文件追踪
echo ""
echo "✓ 已跟踪文件数:"
git ls-files | wc -l

# 检查未跟踪文件
echo ""
echo "✓ 未跟踪文件:"
git status --porcelain

# 检查最近提交
echo ""
echo "✓ 最近 3 个提交:"
git log --oneline -3

echo ""
echo "验证完成 ✅"
```

---

## 📚 参考资源

### 官方文档
- [Git 分支管理](https://git-scm.com/book/en/v2/Git-Branching-Branch-Management)
- [GitHub: Renaming a branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/renaming-a-branch)
- [GitLab: Rename repository](https://docs.gitlab.com/ee/user/project/settings/repository.html)

### 推荐实践
- [GitHub: Naming conventions](https://github.com/settings/repositories)
- [Best practices for git](https://sethrobertson.github.io/GitBestPractices/)

---

## 🎯 决策矩阵

根据你的情况选择适合的方案：

| 情景 | 选择 | 命令 |
|-----|------|------|
| 个人项目 + GitHub | main | `git branch -M master main` |
| 团队项目 | main | `git branch -M master main` |
| 企业内部 | 按公司规定 | 参考团队指南 |
| 现有 master 工作流 | 保持 master | 更新文档 |
| 需要跟踪规划 | docs/planning/ | `git add docs/planning/` |
| 本地规划文件 | 忽略 | 更新 .gitignore |

---

## 🚀 推荐完整方案

结合所有最佳实践的推荐方案：

```bash
# 1. 重命名分支
git branch -M master main

# 2. 重新组织文档
mkdir -p docs/{architecture,guides,progress,migration,planning}

# 3. 移动和合并文档（见 FILE_STRUCTURE_ANALYSIS.md）
# ... (执行文档整理)

# 4. 跟踪规划文件
mkdir -p docs/planning
mv 项目方案*.md docs/planning/
git add docs/planning/

# 5. 跟踪 Claude 配置
git add .claude/

# 6. 统一提交
git commit -m "chore: Complete Git and documentation reorganization

Major changes:
- master → main branch
- Reorganized 23 documentation files into docs/ subdirectories
- Tracked project planning documents for team collaboration
- Tracked .claude/ configuration for shared dev setup

This aligns with modern Git standards and improves team collaboration.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"

# 7. 推送（如果有远程仓库）
git push -u origin main

# 8. 验证
git branch -v
git log --oneline -3
```

---

**最后更新**: 2026-10-20
