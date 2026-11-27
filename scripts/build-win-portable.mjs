#!/usr/bin/env node
/**
 * 基于 `release/win-unpacked/` 生成 Windows 免安装便携版 zip。
 *
 * 产物：`release/Pi-Workbench-Portable-<version>-win-x64.zip`
 * 内部包含完整程序文件 + 根级空标记文件 `portable`：
 * 解压到任意可写目录后双击 `Pi Workbench.exe`，应用自动以单目录便携模式运行
 * （数据落在同级 `config/ data/ cache/ logs/`，不走 NSIS 自动覆盖更新）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const unpackedDir = path.join(root, 'release', 'win-unpacked')

if (!existsSync(unpackedDir)) {
  console.error(`Missing ${unpackedDir}; run electron-builder --win first.`)
  process.exit(1)
}

const stageDir = path.join(root, 'cache', 'win-portable-stage')
const archivePath = path.join(
  root,
  'release',
  `Pi-Workbench-Portable-${pkg.version}-win-x64.zip`
)

rmSync(stageDir, { recursive: true, force: true })
rmSync(archivePath, { force: true })
mkdirSync(stageDir, { recursive: true })

cpSync(unpackedDir, stageDir, { recursive: true })
// 根级 portable 空标记文件：electron/app-paths.ts 启动时据此启用单目录便携模式
writeFileSync(path.join(stageDir, 'portable'), '', 'utf8')

if (process.platform === 'win32') {
  // Windows 10/11 与 GitHub windows-latest 内置 bsdtar（System32\tar.exe），
  // `-a` 按 .zip 后缀直接产出标准 zip，比 PowerShell Compress-Archive 更快且不依赖模块自动加载。
  execFileSync('tar.exe', ['-a', '-cf', archivePath, '.'], { cwd: stageDir, stdio: 'inherit' })
} else {
  execFileSync('zip', ['-qr', archivePath, '.'], { cwd: stageDir, stdio: 'inherit' })
}

rmSync(stageDir, { recursive: true, force: true })

if (!existsSync(archivePath)) {
  console.error(`Failed to produce portable zip: ${archivePath}`)
  process.exit(1)
}
console.log(`Portable archive ready: ${archivePath}`)
