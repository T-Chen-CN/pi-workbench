import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '',
  },
}))

import {
  REPO_MAP_CACHE_VERSION,
  extractExports,
  extractHeadComment,
  repoMapCachePath,
  roleForPath,
  scanRepoMap
} from '../electron/repo-map'

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  run(['init', '-b', 'main'], dir)
  run(['config', 'user.email', 'test@example.com'], dir)
  run(['config', 'user.name', 'Test'], dir)
}

async function commitAll(dir: string): Promise<void> {
  run(['add', '-A'], dir)
  run(['commit', '-m', 'snapshot'], dir)
}

let tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'pi-repomap-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  tempDirs = []
})

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('roleForPath', () => {
  it.each([
    ['tests/file-tree.test.ts', 'test'],
    ['src/store/editorStore.ts', 'state'],
    ['src/components/FileView.tsx', 'component'],
    ['electron/ipc/git.ts', 'ipc'],
    ['electron/main.ts', 'ipc'],
    ['src/types/electron.d.ts', 'type'],
    ['src/index.css', 'style'],
    ['docs/README.md', 'doc'],
    ['AGENTS.md', 'doc'],
    ['package-lock.json', 'config'],
    ['.github/workflows/build.yml', 'config'],
    ['build/icon.ico', 'asset'],
    ['src/utils/fileKind.ts', 'util'],
    ['scripts/make-tray-icon.js', 'util'],
    ['LICENSE', 'other']
  ])('%s → %s', (input, expected) => {
    expect(roleForPath(input)).toBe(expected)
  })
})

describe('extractHeadComment', () => {
  it('takes a block comment and strips the leading asterisks', () => {
    const head = '/**\n * 统一入口。\n * 第二行。\n */\nexport const a = 1\n'
    expect(extractHeadComment(head)).toBe('统一入口。 第二行。')
  })

  it('takes a single-line block comment', () => {
    expect(extractHeadComment('/* 一句话说明 */\nexport const a = 1\n')).toBe('一句话说明')
  })

  it('takes consecutive line comments and stops at code', () => {
    const head = '// 第一行\n// 第二行\nconst a = 1\n// 不是首部注释\n'
    expect(extractHeadComment(head)).toBe('第一行 第二行')
  })

  it('skips shebang and blank lines', () => {
    expect(extractHeadComment('#!/usr/bin/env node\n\n# 构建脚本\nprint(1)\n')).toBe('构建脚本')
  })

  it('skips the import block and takes the first flush-left comment', () => {
    const head = [
      'import { a } from "b"',
      '',
      '// 模块职责：把事件合并成批次',
      'export function batch() {}'
    ].join('\n')
    expect(extractHeadComment(head)).toBe('模块职责：把事件合并成批次')
  })

  it('ignores indented field comments (not a file-level description)', () => {
    const head = 'export interface S {\n  /** 字段说明 */\n  a: string\n}\n'
    expect(extractHeadComment(head)).toBeUndefined()
  })

  it('skips pure directive comments', () => {
    const head =
      '// eslint-disable-next-line\n// @ts-expect-error\n// 真正的说明\nexport const a = 1\n'
    expect(extractHeadComment(head)).toBe('真正的说明')
  })

  it('returns undefined when the file has no comment block', () => {
    expect(extractHeadComment('const a = 1\nexport { a }\n')).toBeUndefined()
  })

  it('caps the comment length', () => {
    const comment = `// ${'很长'.repeat(200)}`
    const result = extractHeadComment(comment)
    expect(result).toBeTruthy()
    expect(result!.length).toBeLessThanOrEqual(161)
    expect(result!.endsWith('…')).toBe(true)
  })
})

describe('extractExports', () => {
  it('collects top-level exported names', () => {
    const head = [
      'export function handleIpc() {}',
      'export const useEditorStore = 1',
      'export interface EditorStore {}',
      'export default main'
    ].join('\n')
    expect(extractExports(head)).toEqual(['handleIpc', 'useEditorStore', 'EditorStore'])
  })

  it('understands commonjs assignments', () => {
    expect(extractExports('module.exports = { start, stop }\n')).toEqual(['start'])
  })

  it('returns an empty list for files without exports', () => {
    expect(extractExports('const a = 1\n')).toEqual([])
  })
})

describe('scanRepoMap', () => {
  it('reports non-git directories instead of failing', async () => {
    const dir = await makeTempDir()
    const result = await scanRepoMap(dir)
    expect(result).toMatchObject({ success: true, isRepo: false, total: 0 })
  })

  it('lists every tracked file with a role and a description', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.mkdir(path.join(dir, 'src', 'store'), { recursive: true })
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'src', 'store', 'editorStore.ts'),
      '// 每个工作区各持有一份编辑器状态\nexport function createEditorStore() {}\nexport const editorStoreFor = 1\n'
    )
    await fs.writeFile(path.join(dir, 'src', 'App.tsx'), 'export const App = () => null\n')
    await fs.writeFile(path.join(dir, 'tests', 'editor.test.ts'), 'export const t = 1\n')
    await fs.writeFile(path.join(dir, 'README.md'), '# 标题\n')
    await fs.writeFile(path.join(dir, 'package.json'), '{}\n')
    await fs.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    await commitAll(dir)
    // 提交之后再放一个未跟踪文件：它不该出现在面板里
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'nope\n')

    const result = await scanRepoMap(dir)

    expect(result.success).toBe(true)
    expect(result.isRepo).toBe(true)
    expect(result.truncated).toBe(false)
    // untracked.txt 不属于 git 跟踪范围
    expect(result.total).toBe(6)
    expect(result.described).toBe(6)
    expect(result.files.map((file) => file.path)).toEqual([
      'README.md',
      'logo.png',
      'package.json',
      'src/App.tsx',
      'src/store/editorStore.ts',
      'tests/editor.test.ts'
    ])

    const store = result.files.find((file) => file.path === 'src/store/editorStore.ts')!
    expect(store.role).toBe('state')
    expect(store.headComment).toContain('编辑器状态')
    expect(store.symbol).toBe('createEditorStore')
    expect(store.exports).toContain('editorStoreFor')

    expect(result.files.find((file) => file.path === 'src/App.tsx')!.role).toBe('component')
    expect(result.files.find((file) => file.path === 'tests/editor.test.ts')!.role).toBe('test')
    expect(result.files.find((file) => file.path === 'README.md')!.role).toBe('doc')
    expect(result.files.find((file) => file.path === 'package.json')!.role).toBe('config')

    const logo = result.files.find((file) => file.path === 'logo.png')!
    expect(logo.role).toBe('asset')
    expect(logo.binary).toBe(true)
    expect(logo.headComment).toBeUndefined()
  })

  it('writes a cache and reuses it on the next scan', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(path.join(dir, 'a.ts'), '// 甲\nexport const a = 1\n')
    await commitAll(dir)

    await scanRepoMap(dir)
    const cachePath = repoMapCachePath(dir)
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    expect(cached.version).toBe(REPO_MAP_CACHE_VERSION)
    expect(Object.keys(cached.files)).toEqual(['a.ts'])
    expect(cached.files['a.ts'].headComment).toBe('甲')

    // 内容不变、指纹不变：第二次扫描复用缓存（不重读文件内容）
    const second = await scanRepoMap(dir)
    expect(second.described).toBe(1)

    // 内容变了：指纹失配 → 描述跟着更新
    await fs.writeFile(path.join(dir, 'a.ts'), '// 乙\nexport const a = 2\n')
    const third = await scanRepoMap(dir)
    expect(third.files[0].headComment).toBe('乙')
  })

  it('rebuilds when the cache version or repo root does not match', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(path.join(dir, 'a.ts'), '// 甲\nexport const a = 1\n')
    await commitAll(dir)

    const cachePath = repoMapCachePath(dir)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: REPO_MAP_CACHE_VERSION - 1,
        repoRoot: '/elsewhere',
        updatedAt: 0,
        files: { 'a.ts': { role: 'util', binary: false, size: 1, mtimeMs: 1, headComment: '旧' } }
      })
    )

    const result = await scanRepoMap(dir)
    expect(result.files[0].headComment).toBe('甲')
  })

  it('ignores a corrupt cache instead of throwing', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1\n')
    await commitAll(dir)

    const cachePath = repoMapCachePath(dir)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, '{ not json')

    const result = await scanRepoMap(dir)
    expect(result.success).toBe(true)
    expect(result.described).toBe(1)
  })

  it('defers descriptions past the scan limit and fills them on demand', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(path.join(dir, 'a.ts'), '// 甲\nexport const a = 1\n')
    await fs.writeFile(path.join(dir, 'b.ts'), '// 乙\nexport const b = 1\n')
    await fs.writeFile(path.join(dir, 'c.ts'), '// 丙\nexport const c = 1\n')
    await commitAll(dir)

    const result = await scanRepoMap(dir, { limit: 1 })
    expect(result.truncated).toBe(true)
    expect(result.total).toBe(3)
    expect(result.described).toBe(0)
    // 降级模式下路径与分类照旧给全
    expect(result.files.every((file) => file.role === 'util')).toBe(true)
    expect(result.files.every((file) => file.headComment === undefined)).toBe(true)

    const filled = await scanRepoMap(dir, { paths: ['b.ts'], limit: 1 })
    expect(filled.total).toBe(3)
    expect(filled.described).toBe(1)
    expect(filled.files.find((file) => file.path === 'b.ts')!.headComment).toBe('乙')
  })

  it('force re-reads files even when fingerprints match', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(path.join(dir, 'a.ts'), '// 甲\nexport const a = 1\n')
    await commitAll(dir)
    await scanRepoMap(dir)

    // 篡改缓存里的注释，模拟「缓存与磁盘不一致」
    const cachePath = repoMapCachePath(dir)
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    cached.files['a.ts'].headComment = '被改过的缓存'
    await fs.writeFile(cachePath, JSON.stringify(cached))

    const reused = await scanRepoMap(dir)
    expect(reused.files[0].headComment).toBe('被改过的缓存')

    const forced = await scanRepoMap(dir, { force: true })
    expect(forced.files[0].headComment).toBe('甲')
  })
})
