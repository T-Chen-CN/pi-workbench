/** 便携式应用目录解析 */

import { app } from 'electron'
import * as path from 'path'

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
