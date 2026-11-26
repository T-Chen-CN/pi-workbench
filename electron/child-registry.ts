/**
 * 主进程子进程登记与兜底回收。
 *
 * 为什么需要：Windows 上 `child.kill()` 只终止直接子进程，而
 * `npm install` / PTY shell / git 都会再派生子进程；应用退出后这些孙进程
 * 会留在任务管理器里（并可能占用工作区文件）。这里登记 pid，退出时用
 * `taskkill /T /F` 收整棵树。
 *
 * 约定：
 * - 只登记「退出时必须回收」的进程；故意脱离的（shell-refresh 的 detached
 *   子进程）不要登记。
 * - `killProcessTree` 是最后手段，可能在进程已退出时被调用，失败不抛错。
 */
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type ChildGroup = 'pty' | 'install' | 'git'

export interface TrackedChild {
  pid: number
  group: ChildGroup
  /** 优雅终止（可选）：先尝试它，killProcessTree 兜底剩下的进程树 */
  kill?: () => void
}

export interface KillProcessTreeDeps {
  platform?: NodeJS.Platform
  execFileSync?: (file: string, args: string[], options: Record<string, unknown>) => unknown
  execFileAsync?: (file: string, args: string[], options: Record<string, unknown>) => Promise<unknown>
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

export interface KillAllResult {
  killed: number
  failed: number
}

/** 结束整棵进程树；返回是否成功发出终止信号 */
export function killProcessTree(pid: number, deps: KillProcessTreeDeps = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const platform = deps.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const exec = deps.execFileSync ?? execFileSync
      exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
      })
      return true
    }
    const kill = deps.kill ?? process.kill
    kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/** 异步结束整棵进程树：避免退出时同步 taskkill 阻塞事件循环与看门狗 */
export async function killProcessTreeAsync(
  pid: number,
  deps: KillProcessTreeDeps = {}
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const platform = deps.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const exec = deps.execFileAsync ?? ((file, args, opts) => execFileAsync(file, args, opts))
      await exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 1200,
      })
      return true
    }
    const kill = deps.kill ?? process.kill
    kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

export class ChildRegistry {
  private readonly children = new Map<number, TrackedChild>()

  /** 登记进程；返回注销函数（进程自己退出时调用，可重复调用） */
  register(child: TrackedChild): () => void {
    this.children.set(child.pid, child)
    return () => this.unregister(child.pid)
  }

  unregister(pid: number): void {
    this.children.delete(pid)
  }

  list(): TrackedChild[] {
    return [...this.children.values()]
  }

  size(): number {
    return this.children.size
  }

  /**
   * 回收全部已登记进程。先清空登记表再动手：终止过程中触发的 exit 回调
   * 会重复注销，这里不依赖回调顺序。
   */
  killAll(deps: KillProcessTreeDeps = {}): KillAllResult {
    const snapshot = [...this.children.values()]
    this.children.clear()
    let killed = 0
    let failed = 0
    for (const child of snapshot) {
      // 先收整棵进程树再调用优雅 kill：Windows 上根进程若先退出，taskkill /T 将找不到孙进程
      const ok = killProcessTree(child.pid, deps)
      try {
        child.kill?.()
      } catch {
        // 进程可能已经退出
      }
      if (ok) killed += 1
      else failed += 1
    }
    return { killed, failed }
  }

  /** 并行异步回收全部已登记进程树，避免同步 taskkill 卡住退出看门狗 */
  async killAllAsync(deps: KillProcessTreeDeps = {}): Promise<KillAllResult> {
    const snapshot = [...this.children.values()]
    this.children.clear()
    let killed = 0
    let failed = 0
    await Promise.all(
      snapshot.map(async (child) => {
        const ok = await killProcessTreeAsync(child.pid, deps)
        try {
          child.kill?.()
        } catch {
          // 进程可能已经退出
        }
        if (ok) killed += 1
        else failed += 1
      })
    )
    return { killed, failed }
  }
}

/** 应用级单例：主进程所有需要兜底回收的子进程都登记在这里 */
export const childRegistry = new ChildRegistry()
