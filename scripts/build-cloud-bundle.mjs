#!/usr/bin/env node
/**
 * 打云端运行包（apps/cloud 的 self-contained 产物）。
 *
 * 为什么不用 `npm ci` 在服务器上装：根 package.json 的 workspaces 里有 desktop 的
 * 原生依赖（node-pty），--omit=dev 仍会把它们算进来。这里只装云端真正需要的两个
 * 运行期依赖（ws + Pi SDK），pi-bridge 直接拷 dist。
 *
 * 产物：cache/cloud-bundle/ —— dist / web / node_modules / package.json
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stage = path.join(root, 'cache', 'cloud-bundle')

// Windows 上 npm 是 npm.cmd，execFileSync 直接 spawn 会 EINVAL，必须走 shell
function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 1) 编译产物（先 bridge 后 cloud，确保 cloud 编译针对最新的协议与类型）
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:bridge'])
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:cloud'])

// 2) 代码与静态资源
cpSync(path.join(root, 'apps', 'cloud', 'dist'), path.join(stage, 'dist'), { recursive: true })
cpSync(path.join(root, 'apps', 'cloud', 'web'), path.join(stage, 'web'), { recursive: true })

// 2b) 自托管 @fontsource 字体（与桌面端 src/main.tsx 完全一致，避免运行包缺少字体文件）
const FONT_PACKAGES = [
  { slug: 'instrument-serif', pkgPath: ['@fontsource', 'instrument-serif'], cssFiles: ['400.css', '400-italic.css'] },
  { slug: 'noto-serif-sc', pkgPath: ['@fontsource-variable', 'noto-serif-sc'], cssFiles: ['index.css'] },
  { slug: 'noto-sans', pkgPath: ['@fontsource-variable', 'noto-sans'], cssFiles: ['index.css'] },
  { slug: 'noto-sans-sc', pkgPath: ['@fontsource-variable', 'noto-sans-sc'], cssFiles: ['index.css'] },
  { slug: 'geist-mono', pkgPath: ['@fontsource-variable', 'geist-mono'], cssFiles: ['index.css'] },
]
const fontsRoot = path.join(stage, 'web', 'fonts')
mkdirSync(fontsRoot, { recursive: true })
const combinedFontsCss = []
for (const pkg of FONT_PACKAGES) {
  const sourceDir = path.join(root, 'node_modules', ...pkg.pkgPath)
  const filesDir = path.join(sourceDir, 'files')
  if (!existsSync(filesDir)) continue
  const targetDir = path.join(fontsRoot, pkg.slug)
  mkdirSync(path.join(targetDir, 'files'), { recursive: true })
  cpSync(filesDir, path.join(targetDir, 'files'), { recursive: true })
  for (const cssFile of pkg.cssFiles) {
    const cssPath = path.join(sourceDir, cssFile)
    if (!existsSync(cssPath)) continue
    const raw = readFileSync(cssPath, 'utf8')
    combinedFontsCss.push(
      raw.replace(/url\(\s*['"]?\.\/files\/([^'")]+)['"]?\s*\)/g, `url('/fonts/${pkg.slug}/$1')`)
    )
  }
}
writeFileSync(path.join(fontsRoot, 'fonts.css'), combinedFontsCss.join('\n') + '\n')

// 3) 运行期依赖
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'pi-cloud-runtime',
      private: true,
      type: 'module',
      dependencies: {
        '@earendil-works/pi-ai': '^1.3.0',
        '@earendil-works/pi-coding-agent': '^1.3.0',
        ws: '^8.18.0',
      },
    },
    null,
    2
  ) + '\n'
)
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage)

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
console.log(`bundle ready: ${stage}`)
