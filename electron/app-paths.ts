/** 便携式应用目录解析 */

import { app } from 'electron'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

export function getAppDir(): string {
  // AppImage：可执行文件位于只读挂载点，数据放在 .AppImage 文件旁边
  if (process.env.APPIMAGE) {
    return path.dirname(process.env.APPIMAGE)
  }
  if (!app.isPackaged) {
    // 开发模式：项目根目录（比 process.cwd() 更稳定，不依赖启动目录）
    return app.getAppPath()
  }
  if (process.platform === 'darwin') {
    // macOS 应用包内不可写，且会被更新整体替换。
    // 经项目所有者确认，macOS 使用系统标准数据目录作为便携式约束的例外。
    return path.join(app.getPath('appData'), 'pi-workbench')
  }
  // 生产模式：可执行文件所在目录
  return path.dirname(app.getPath('exe'))
}

/**
 * pi-bridge 构建产物的入口 URL。
 * 本模块与 main.js 同处 dist-electron（开发态在仓库根、打包后在 app.asar 根），
 * 因此退一级就是 pi-bridge 所在目录；不要在子目录模块里自行拼相对层级。
 */
export function getBridgeEntryUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return pathToFileURL(path.join(here, '..', 'pi-bridge', 'dist', 'index.js')).href
}

/**
 * Pi SDK 的全局 agent 目录。
 *
 * SDK 的 getAgentDir() 默认是 `~/.pi/agent`；必须在任何 SDK 模块加载之前通过
 * 环境变量固定到应用目录，否则崩溃日志、扩展加载器、认证存储等默认入口会在
 * 用户主目录下创建文件。本模块是主进程最先加载的模块之一，赋值在这里生效。
 */
export const piAgentDir = path.join(getAppDir(), 'data', 'agent')
process.env.PI_CODING_AGENT_DIR = piAgentDir
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(piAgentDir, 'sessions')
