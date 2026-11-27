#!/usr/bin/env node
/**
 * 打云端运行包（apps/cloud 的 self-contained 产物）。
 *
 * 为什么不直接对根 package.json 跑 `npm ci`：根 workspaces 里包含桌面端原生依赖
 * （node-pty 等），--omit=dev 仍会把它们算进来。这里从根 package-lock.json 精确裁剪出
 * 云端运行期依赖及其完整传递闭包（保留每个包的精确 version / resolved / SHA-512 integrity），
 * 生成独立 `package-lock.json` 后用 `npm ci --omit=dev --ignore-scripts` 安装，
 * 确保传递依赖 100% 确定性且经完整性校验；pi-bridge 直接拷 dist。
 *
 * 产物：cache/cloud-bundle/ —— dist / web / node_modules / package.json / package-lock.json
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLOUD_RUNTIME_DEPS = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'ws',
  'zod',
]

// Windows 上 npm 是 npm.cmd，execFileSync 直接 spawn 会 EINVAL，必须走 shell
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

/** 按 npm 嵌套提升规则从 ownerKey 逐级向上解析依赖在 rootLock.packages 中的键 */
function resolvePackageKeyInLock(allPackages, ownerKey, depName) {
  let cursor = ownerKey
  while (cursor) {
    const candidate = `${cursor}/node_modules/${depName}`
    if (Object.prototype.hasOwnProperty.call(allPackages, candidate)) return candidate
    const idx = cursor.lastIndexOf('/node_modules/')
    if (idx === -1) break
    cursor = cursor.slice(0, idx)
  }
  const topLevel = `node_modules/${depName}`
  if (Object.prototype.hasOwnProperty.call(allPackages, topLevel)) return topLevel
  return null
}

/**
 * 从根 package-lock.json（v3）裁剪出指定根依赖的完整传递闭包，
 * 为云端运行包生成独立的 package.json 与带 SHA-512 integrity 的 package-lock.json。
 */
export function buildPrunedLockfile(rootLock, rootNames = CLOUD_RUNTIME_DEPS) {
  if (!rootLock || typeof rootLock !== 'object' || rootLock.lockfileVersion !== 3) {
    throw new Error('Root package-lock.json must be lockfileVersion 3')
  }
  const allPackages = rootLock.packages
  if (!allPackages || typeof allPackages !== 'object') {
    throw new Error('Root package-lock.json is missing packages map')
  }

  const pinnedDependencies = {}
  const visited = new Set()
  const required = new Set()
  const queue = []

  const enqueue = (key, isRequired) => {
    const wasVisited = visited.has(key)
    const wasRequired = required.has(key)
    visited.add(key)
    if (isRequired) required.add(key)
    if (!wasVisited || (isRequired && !wasRequired)) {
      queue.push(key)
    }
  }

  for (const name of rootNames) {
    const key = `node_modules/${name}`
    const entry = allPackages[key]
    if (!entry || typeof entry.version !== 'string' || !entry.version) {
      throw new Error(`Missing locked version for ${name} in package-lock.json`)
    }
    pinnedDependencies[name] = entry.version
    enqueue(key, true)
  }

  while (queue.length > 0) {
    const ownerKey = queue.shift()
    const entry = allPackages[ownerKey]
    const ownerIsRequired = required.has(ownerKey)

    const traverseMap = (depMap, isOptionalEdge) => {
      if (!depMap || typeof depMap !== 'object') return
      for (const depName of Object.keys(depMap)) {
        const resolvedKey = resolvePackageKeyInLock(allPackages, ownerKey, depName)
        if (!resolvedKey) {
          if (isOptionalEdge) continue
          throw new Error(`Missing transitive dependency "${depName}" required by "${ownerKey}" in package-lock.json`)
        }
        enqueue(resolvedKey, ownerIsRequired && !isOptionalEdge)
      }
    }

    traverseMap(entry.dependencies, false)
    traverseMap(entry.optionalDependencies, true)

    if (entry.peerDependencies && typeof entry.peerDependencies === 'object') {
      const peerMeta = entry.peerDependenciesMeta ?? {}
      for (const peerName of Object.keys(entry.peerDependencies)) {
        if (peerMeta[peerName]?.optional) continue
        const resolvedKey = resolvePackageKeyInLock(allPackages, ownerKey, peerName)
        if (!resolvedKey) {
          throw new Error(`Missing non-optional peer dependency "${peerName}" required by "${ownerKey}" in package-lock.json`)
        }
        enqueue(resolvedKey, ownerIsRequired)
      }
    }
  }

  const version =
    typeof rootLock.version === 'string' && rootLock.version ? rootLock.version : '0.0.0'
  const packageJson = {
    name: 'pi-cloud-runtime',
    version,
    private: true,
    type: 'module',
    dependencies: pinnedDependencies,
  }

  const prunedPackages = {
    '': {
      name: 'pi-cloud-runtime',
      version,
      private: true,
      dependencies: pinnedDependencies,
    },
  }

  const sortedKeys = [...visited].sort()
  for (const key of sortedKeys) {
    const original = allPackages[key]
    if (original.link) {
      throw new Error(`Unexpected workspace link "${key}" in cloud runtime dependency closure`)
    }
    if (typeof original.version !== 'string' || !original.version) {
      throw new Error(`Missing version for "${key}" in package-lock.json`)
    }
    if (typeof original.resolved !== 'string' || !original.resolved) {
      throw new Error(`Missing resolved URL for "${key}" in package-lock.json`)
    }
    if (typeof original.integrity !== 'string' || !original.integrity) {
      throw new Error(`Missing integrity hash for "${key}" in package-lock.json`)
    }
    const cloned = { ...original }
    delete cloned.dev
    delete cloned.devOptional
    if (required.has(key)) {
      delete cloned.optional
    } else {
      cloned.optional = true
    }
    prunedPackages[key] = cloned
  }

  const packageLock = {
    name: 'pi-cloud-runtime',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: prunedPackages,
  }

  return {
    packageJson,
    packageLock,
    pinnedDependencies,
    packageCount: sortedKeys.length,
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const stage = path.join(root, 'cache', 'cloud-bundle')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // 1) 编译产物（先 bridge 后 cloud，确保 cloud 编译针对最新的协议与类型）
  run(npmCmd, ['run', 'build:bridge'], root)
  run(npmCmd, ['run', 'build:cloud'], root)

  // 2) 代码与静态资源（apps/cloud/web-dist 已由 Vite 内联并打包全部 @fontsource 与 KaTeX 字体）
  cpSync(path.join(root, 'apps', 'cloud', 'dist'), path.join(stage, 'dist'), { recursive: true })
  cpSync(path.join(root, 'apps', 'cloud', 'web-dist'), path.join(stage, 'web'), { recursive: true })

  // 3) 运行期依赖：从根 package-lock.json 提取带完整性哈希的完整传递闭包并用 npm ci 离线校验安装
  const rootLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf-8'))
  const { packageJson, packageLock, pinnedDependencies, packageCount } = buildPrunedLockfile(
    rootLock,
    CLOUD_RUNTIME_DEPS
  )

  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(path.join(stage, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`)

  run(npmCmd, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage)

  // 4) pi-bridge（只拷产物与清单）
  const bridgeTarget = path.join(stage, 'node_modules', 'pi-bridge')
  mkdirSync(bridgeTarget, { recursive: true })
  cpSync(path.join(root, 'pi-bridge', 'package.json'), path.join(bridgeTarget, 'package.json'))
  cpSync(path.join(root, 'pi-bridge', 'dist'), path.join(bridgeTarget, 'dist'), { recursive: true })

  // 5) 运维件
  cpSync(path.join(root, 'apps', 'cloud', 'deploy'), path.join(stage, 'deploy'), { recursive: true })

  if (!existsSync(path.join(stage, 'dist', 'main.js'))) {
    console.error('bundle is missing dist/main.js')
    process.exit(1)
  }
  console.log(
    `bundle ready: ${stage} (deps: ${JSON.stringify(pinnedDependencies)}, locked packages: ${packageCount})`
  )
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
