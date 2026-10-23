/**
 * 生成 NSIS 卸载器使用的“安装器自有文件”清单。
 *
 * 更新时旧版卸载器只删除清单里的路径；config/data/logs/cache 等运行时数据
 * 永远不会进入清单。真正卸载时由安装脚本额外清理数据目录与安装器生成的文件。
 */

import fs from 'node:fs'
import path from 'node:path'

export const PROTECTED_TOP_LEVEL = Object.freeze(['config', 'data', 'logs', 'cache'])
export const MANIFEST_FILES = 'installer-manifest.files.txt'
export const MANIFEST_DIRS = 'installer-manifest.dirs.txt'
export const MANIFEST_DIR = 'resources'

const MAX_ENTRY_LENGTH = 200
// NSIS 的 FileRead 会把行尾换行一并读入；固定用 CRLF，卸载脚本统一去掉末尾两个字符
const LINE_ENDING = '\r\n'
// electron-builder 在用户 afterPack 之后才写入，更新时不应删除
const EXCLUDED_RELATIVE = new Set([`${MANIFEST_DIR}\\app-update.yml`])
const EXCLUDED_FILES = new Set([MANIFEST_FILES, MANIFEST_DIRS])

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const depthOf = (entry) => entry.split('\\').length

export function validateManifestEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Installer manifest entry must be a non-empty string')
  }
  if (entry.length > MAX_ENTRY_LENGTH) {
    throw new Error(`Installer manifest entry is too long (${entry.length}): ${entry}`)
  }
  // NSIS 的 FileRead 按系统代码页读取；程序文件路径都是可打印 ASCII
  if (!/^[\x20-\x7E]+$/.test(entry)) {
    throw new Error(`Installer manifest entry must be printable ASCII: ${entry}`)
  }
  if (entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
    throw new Error(`Installer manifest entry must be relative: ${entry}`)
  }
  if (entry.split('\\').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Installer manifest entry contains an invalid segment: ${entry}`)
  }
}

function isProtected(entry) {
  return PROTECTED_TOP_LEVEL.includes(entry.split('\\')[0].toLowerCase())
}

function toEntry(rootDir, absolutePath) {
  const relative = path.relative(rootDir, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to record a path outside the app directory: ${absolutePath}`)
  }
  const entry = relative.split(path.sep).join('\\')
  validateManifestEntry(entry)
  return entry
}

export function buildInstallerManifest(rootDir) {
  const root = path.resolve(rootDir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`App directory does not exist: ${root}`)
  }

  const files = []
  const dirs = []

  const walk = (currentDir) => {
    for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, dirent.name)
      const entry = toEntry(root, absolutePath)
      if (isProtected(entry)) continue
      if (dirent.isDirectory()) {
        dirs.push(entry)
        walk(absolutePath)
        continue
      }
      if (EXCLUDED_FILES.has(dirent.name) || EXCLUDED_RELATIVE.has(entry)) continue
      files.push(entry)
    }
  }

  walk(root)

  files.sort(byName)
  dirs.sort((a, b) => depthOf(b) - depthOf(a) || byName(a, b))
  return { files, dirs }
}

export function writeInstallerManifest(appOutDir) {
  const resourcesDir = path.join(appOutDir, MANIFEST_DIR)
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Resources directory not found in app output: ${resourcesDir}`)
  }

  const { files, dirs } = buildInstallerManifest(appOutDir)
  const filesPath = path.join(resourcesDir, MANIFEST_FILES)
  const dirsPath = path.join(resourcesDir, MANIFEST_DIRS)
  const toContent = (entries) =>
    entries.length > 0 ? `${entries.join(LINE_ENDING)}${LINE_ENDING}` : ''
  fs.writeFileSync(filesPath, toContent(files), 'utf8')
  fs.writeFileSync(dirsPath, toContent(dirs), 'utf8')
  return { files: files.length, dirs: dirs.length, filesPath, dirsPath }
}
