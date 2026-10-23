import { writeInstallerManifest } from './lib/installer-manifest.js'

/**
 * electron-builder afterPack：把 Windows 安装目录里属于安装器的文件写成清单，
 * 供 NSIS 卸载器在更新时按清单删除，保留 config/data/logs/cache。
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const result = writeInstallerManifest(context.appOutDir)
  console.log(
    `[installer-manifest] ${result.files} files, ${result.dirs} dirs -> ${result.filesPath}`
  )
}
