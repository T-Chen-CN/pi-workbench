/**
 * 更新后的 shell 缓存刷新。
 *
 * 自动更新只替换安装目录里的文件，系统仍会沿用旧图标与桌面项：
 * - Windows：Explorer 图标缓存、快捷方式与任务栏固定项
 * - macOS：Finder / Dock 图标、LaunchServices 注册
 * - Linux：桌面菜单（.desktop）与图标主题缓存
 *
 * 主进程启动时对比上次运行的版本，只有版本变化才执行一次平台刷新；
 * 命令全部 detached 执行、失败静默，不阻塞窗口创建。Windows 安装器里还有
 * 一道 SHChangeNotify + ie4uinit，与应用侧互为兜底。
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAppDir } from './app-paths.js'

export interface RefreshCommand {
  command: string
  args: string[]
}

const VERSION_FILE = 'last-run-version.json'
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export function shouldRefresh(lastVersion: string | null, currentVersion: string): boolean {
  return lastVersion !== currentVersion
}

/**
 * 按平台给出需要执行的刷新命令。纯函数，便于测试；Linux 上只在目录存在时
 * 才调用对应工具，避免在精简系统里报错。
 */
export function platformRefreshCommands(
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv,
  home: string,
  dirExists: (dir: string) => boolean = (dir) => fs.existsSync(dir)
): RefreshCommand[] {
  if (platform === 'win32') {
    // 重建 Explorer 的图标缓存库。SHChangeNotify 需要调用 Win32 API，
    // 应用侧做不到，由安装器（build/installer.nsh）负责。
    const systemRoot = env.SystemRoot ?? 'C:\\Windows'
    return [{ command: path.win32.join(systemRoot, 'System32', 'ie4uinit.exe'), args: ['-show'] }]
  }

  if (platform === 'darwin') {
    // process.execPath = <name>.app/Contents/MacOS/<name>，退三级即 bundle 根目录
    const bundle = path.posix.resolve(execPath, '..', '..', '..')
    return [
      { command: '/usr/bin/touch', args: ['-m', bundle] },
      { command: LSREGISTER, args: ['-f', bundle] },
    ]
  }

  if (platform === 'linux') {
    const commands: RefreshCommand[] = []
    // AppImage：部分桌面环境按文件 mtime 缓存图标
    if (env.APPIMAGE) commands.push({ command: '/usr/bin/touch', args: [env.APPIMAGE] })

    const applicationsDir = path.posix.join(home, '.local', 'share', 'applications')
    if (dirExists(applicationsDir)) {
      commands.push({ command: 'update-desktop-database', args: [applicationsDir] })
    }

    const iconThemeDir = path.posix.join(home, '.local', 'share', 'icons', 'hicolor')
    if (dirExists(iconThemeDir)) {
      commands.push({ command: 'gtk-update-icon-cache', args: ['-f', '-t', iconThemeDir] })
    }

    return commands
  }

  return []
}

function readLastRunVersion(filePath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { version?: unknown }
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

function runCommand({ command, args }: RefreshCommand): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => {
      console.warn(`[ShellRefresh] ${command} failed:`, error)
    })
    child.unref()
  } catch (error) {
    console.warn(`[ShellRefresh] ${command} failed:`, error)
  }
}

/**
 * 打包版首次运行新版本时执行一次；开发模式不做任何事，
 * 避免改动开发者自己的 shell 缓存。返回是否真的执行了刷新，便于测试与日志。
 */
export function refreshShellCachesIfUpdated(): boolean {
  if (!app.isPackaged) return false

  const currentVersion = app.getVersion()
  const versionFile = path.join(getAppDir(), 'config', VERSION_FILE)
  if (!shouldRefresh(readLastRunVersion(versionFile), currentVersion)) return false

  const commands = platformRefreshCommands(
    process.platform,
    process.execPath,
    process.env,
    os.homedir()
  )
  if (commands.length > 0) {
    console.log('[ShellRefresh] Refreshing shell caches after update to', currentVersion)
    for (const command of commands) runCommand(command)
  }

  // 记录放在命令之后：命令本身是异步的，这里只表示“本版本已处理过”，
  // 中途退出不会留下“已刷新”的假记录。
  try {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true })
    fs.writeFileSync(
      versionFile,
      `${JSON.stringify({ version: currentVersion, refreshedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8'
    )
  } catch (error) {
    console.warn('[ShellRefresh] Failed to record refreshed version:', error)
  }

  return commands.length > 0
}
