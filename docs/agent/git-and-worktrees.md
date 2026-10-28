# Git 与工作树会话

> **面向**：要改 Git 视图、会话工作树、仓库同步的人
> **什么时候读**：动 `git-worktrees` / `worktree-coordinator` / `git:*` 频道之前
> **什么时候要改**：工作树绑定规则或 `session-git.json` 结构变化时

> Git 视图只读；会话可以绑定到独立工作树，改动隔离在 checkout 目录里。
> 完整需求、边界执行顺序与验收场景见 [GIT_WORKTREE_SESSIONS](../requirements/GIT_WORKTREE_SESSIONS.md)。

## 1. 模块分工

| 模块 | 职责 |
| --- | --- |
| `electron/git-worktrees.ts` | 工作树增删、`session-git.json` 读写、分支 / 提交 / merge / diff 等 git 命令封装 |
| `electron/worktree-coordinator.ts` | 每个工作区一个实例：绑定 / 解绑、生成 Agent 上下文、回收无主工作树；**所有写操作串行** |
| `electron/worktree-deps.ts` | 链接工作树的依赖：lockfile 探测 / 哈希、后台 `spawn` 安装（串行 + 超时 + 取消）、依赖状态机 |
| `electron/git-cache.ts` | Git 命令结果缓存（避免视图反复打 git） |
| `electron/repo-watcher.ts` | 仓库状态监听（分支、工作区改动）→ 推送渲染层 |
| `electron/repo-sync.ts` | 拉取 / 同步（`RepoSyncManager` 单例） |
| `electron/repo-autofetch.ts` | 定时 fetch（默认 60 秒间隔） |
| `electron/github-*.ts` | 凭据读取、OAuth 回调、设备码登录、设置装配 |
| `src/utils/commitGraph.ts` | 渲染层计算提交图 |

依赖安装的开关是设置项 `autoInstallWorktreeDeps`（默认 `true`）。审查点：它会执行仓库里的 install 脚本，所以必须可关；关掉后状态停在 `idle`，由工作树 chip 的按钮走 `git:installWorktreeDeps` 手动触发。`WorktreeDepsConfig.createInstaller` 是测试注入点（用例用假 `spawn`，绝不跑真实安装）。

**读与装是两条路径**（改这里很容易踩坑）：

- `statusFor()` 是**纯读**：只算状态，不启子进程。它被 `listWorktrees()` 与 Agent 上下文这类高频路径调用，一旦有副作用，光枚举工作树就会给所有工作树（包括用户自己 `git worktree add` 的、没有会话绑定的）装一遍依赖。
- `ensureInstalled()` 才会启动，只在**绑定工作树时**（`WorktreeCoordinator.bind`，覆盖新建 / 首次复用 / 会话恢复）与手动重试时调用，且受 `autoInstallWorktreeDeps` 约束。
- 安装**串行**：同时只跑一个，其余排队（磁盘 / 网络重活并行只会互相拖慢），排队中的任务被取消时不会启动。

## 2. 硬约束

1. **切换在轮次边界生效**：Agent 正在执行工具时不能换工作目录。绑定 / 解绑只在一个轮次结束后应用，避免半途换目录导致同一轮命令跨两个 checkout。
2. **工作树路径必须校验**：`resolveWorktreePath()` 用 `canonicalizePath` + `isPathInsideRoot` 确认目标仍在工作区内；`WORKTREE_DIR = '.pi-workbench/worktrees'`，托管工作树只放这里。
3. **`.pi-workbench/` 必须被 git 忽略**：`ensureWorktreeIgnored()` 写 `.git/info/exclude`（不改用户的 `.gitignore`，避免把应用状态混进版本库）。
4. **绑定落盘结构固定**（`.pi-workbench/session-git.json`，`version: 1`）：

```jsonc
{
  "version": 1,
  "worktrees": {
    "<id>": { "path", "managed", "branch", "base", "createdBySession", "createdAt", "installedLockfileHash" }
  },
  "sessions": { "<sessionId>": { "worktree": "<id or main>" } }
}
```

  `installedLockfileHash` 是 GIT-118 的产物：值形如 `pnpm:<sha1(lockfile 内容)>`，由 `WorktreeDepsManager` 在**安装成功后**经协调器的 `serialize()` + `saveSessionGit()` 写入，主进程不直接改这个文件。
  **哈希取的是工作树自己那份 lockfile**（`{worktree}/<lockfile>`），只有它不存在时才回退仓库根；包管理器与安装命令仍按仓库根决定。哈希必须跟安装走，否则工作树分支上的 lockfile 变化（切分支、Agent 加依赖）永远不触发重装，两个不同分支的工作树还会共用一个哈希。
  判定规则：哈希与当前 lockfile 一致 **且** 依赖目录（`node_modules` / `.venv`）存在 → `ready`，不再安装；否则下次绑定该工作树时重装。没有 lockfile 的仓库该字段保持 `null`，状态为 `none`。

  主工作树用 `MAIN_WORKTREE_KEY = 'main'`，**不写 worktrees 记录**。改这个结构属于「Ask first」：已有用户的文件在磁盘上。
5. **写操作串行**：两个会话并发绑定同一个空闲工作树会破坏隔离，协调器内部串行化所有写操作。
6. **无主工作树回收**：`git:cleanupOrphans` / `Coordinator.cleanup` 删除既没有会话绑定、也不是用户手动创建的工作树；删除前 `pruneWorktrees()`。
7. **Git 视图只读**：`GitView` 不做隐式写操作（不自动 fetch、不自动 checkout）；所有变更走用户显式操作。
8. **依赖状态落盘只写哈希**：`installing` / `failed` / `error` 只活在内存（重启后按哈希 + 目录重新判定）；错误截断到 2000 字符，只进日志与 Toast / Tooltip，不落盘。工作树被删除 / 遗忘 / 工作区关闭时，`WorktreeDepsManager.forget()` / `dispose()` 会 `kill` 在跑的安装进程。

## 3. 频道（22 invoke + 2 推送）

invoke：`git:repoInfo` `git:status` `git:branches` `git:log` `git:commitDetail` `git:commitStats` `git:diff` `git:listWorktrees` `git:listAllWorktrees` `git:sessionBinding` `git:bindWorktree` `git:releaseSession` `git:forgetWorktree` `git:installWorktreeDeps` `git:cleanupOrphans` `git:fetch` `git:checkout` `git:createBranch` `git:merge` `git:prStatus` `git:githubTokenStatus` `git:setGithubToken`

推送（main → renderer）：`git:changed`（refs / status 分层刷新）、`git:worktree-deps`（`{ workspaceDir, key, state, manager, error? }`）。工作树 chip 只收这一个事件做局部更新，不整表轮询。

## 4. GitHub 关联

- 优先设备码登录（`github-device-login.ts`，`pi-workbench://` 协议回调 + 轮询），备选个人访问令牌（PAT）。
- 凭据经 `secret-crypto.ts`（safeStorage）加密，只存在 `config/` 下，**不进工作区**。
- 用途：Git 视图展示 PR 与 CI 状态（`git:prStatus`），不参与任何写操作。
- 设置界面：`src/components/GithubSettings.tsx`；频道 `github:*`（7 个）。

## 5. 终端与工作树

拆出的终端跟随会话的工作树（cwd 用绑定的 checkout 路径）。切换工作树后**不要复用旧 PTY**：重新创建终端，否则命令还跑在旧目录里。
