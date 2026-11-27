import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

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
} from '../../electron/repo-map'
import { extractExportsAst } from '../../electron/tree-sitter-exports'

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

  it('uses tree-sitter AST exports in scanRepoMap and ignores commented fake exports', async () => {
    const dir = await makeTempDir()
    await initRepo(dir)
    await fs.writeFile(
      path.join(dir, 'fake-only.ts'),
      ['/*', 'export function fakeInComment() {}', '*/', 'const internal = 1'].join('\n')
    )
    await fs.writeFile(
      path.join(dir, 'service.py'),
      ['# def fake(): pass', 'def _private():', '    pass', 'class PublicApi:', '    pass', 'def run():', '    return 1'].join('\n')
    )
    await fs.writeFile(
      path.join(dir, 'server.go'),
      ['package main', '// func Fake() {}', 'func helper() {}', 'type Server struct {}', 'func Start() {}'].join('\n')
    )
    await fs.writeFile(
      path.join(dir, 'lib.rs'),
      ['/* pub fn fake() {} */', 'fn hidden() {}', 'pub struct Engine {}', 'pub fn launch() {}'].join('\n')
    )
    await commitAll(dir)

    const result = await scanRepoMap(dir)
    expect(result.success).toBe(true)

    const fakeOnly = result.files.find((file) => file.path === 'fake-only.ts')!
    expect(fakeOnly.exports).toBeUndefined()

    const py = result.files.find((file) => file.path === 'service.py')!
    expect(py.exports).toEqual(['PublicApi', 'run'])

    const go = result.files.find((file) => file.path === 'server.go')!
    expect(go.exports).toEqual(['Server', 'Start'])

    const rs = result.files.find((file) => file.path === 'lib.rs')!
    expect(rs.exports).toEqual(['Engine', 'launch'])
  })
})

describe('extractExportsAst (web-tree-sitter)', () => {
  it('skips fake declarations inside comments and string/template literals across TS, Python, Go, Rust, Java, and C++', async () => {
    const tsSource = [
      '/*',
      'export function fakeBlock() {}',
      '*/',
      '// export const fakeLine = 1',
      'const tpl = `export class FakeTpl {}`',
      'export function realA() {}',
      'export interface RealB {}',
      'export const realC = 1',
      'export class IgnoredFourth {}',
    ].join('\n')
    expect(await extractExportsAst(tsSource, 'index.ts')).toEqual(['realA', 'RealB', 'realC'])

    const tsOnlyComment = '/* export function fakeOnly() {} */\nconst hidden = 1\n'
    expect(await extractExportsAst(tsOnlyComment, 'empty.ts')).toEqual([])

    const cjsSource = '// module.exports = { fake }\nmodule.exports = { start, stop }\n'
    expect(await extractExportsAst(cjsSource, 'legacy.cjs')).toEqual(['start', 'stop'])

    const pySource = [
      '"""',
      'def fake_doc(): pass',
      '"""',
      '# class FakeComment: pass',
      'def _secret(): pass',
      'class Runner:',
      '    pass',
      'def execute():',
      '    return 1',
    ].join('\n')
    expect(await extractExportsAst(pySource, 'runner.py')).toEqual(['Runner', 'execute'])

    const goSource = [
      'package api',
      '// func FakeExport() {}',
      'const raw = `type FakeRaw struct{}`',
      'func internalHelper() {}',
      'type Client struct{}',
      'func Dial() {}',
    ].join('\n')
    expect(await extractExportsAst(goSource, 'client.go')).toEqual(['Client', 'Dial'])

    const rsSource = [
      '/* pub struct FakeStruct {} */',
      'const S: &str = "pub fn fake_str() {}";',
      'struct Private {}',
      'pub struct App {}',
      'pub enum Mode { Fast }',
      'pub trait Plugin {}',
    ].join('\n')
    expect(await extractExportsAst(rsSource, 'app.rs')).toEqual(['App', 'Mode', 'Plugin'])

    const javaSource = [
      '// public class FakeJava {}',
      'class PackageLocal {}',
      'public interface Store {}',
      'public record Item(String id) {}',
    ].join('\n')
    expect(await extractExportsAst(javaSource, 'Store.java')).toEqual(['Store', 'Item'])

    const cppSource = [
      '/* class FakeCpp {}; */',
      'const char* s = "int fake_fn() { return 0; }";',
      'class Engine { void run() {} };',
      'struct Vec2 { int x; };',
      'int* allocate(int n) { return nullptr; }',
    ].join('\n')
    expect(await extractExportsAst(cppSource, 'engine.cpp')).toEqual(['Engine', 'Vec2', 'allocate'])

    expect(await extractExportsAst('puts 1', 'script.rb')).toBeNull()
  })
})

describe('treeSitterAssets Vite plugin', () => {
  async function loadTreeSitterAssets() {
    const modUrl = pathToFileURL(path.resolve(process.cwd(), 'vite.config.ts')).href
    const mod = (await import(/* @vite-ignore */ modUrl)) as {
      treeSitterAssets: () => {
        generateBundle?: (this: {
          emitFile: (asset: { type: string; fileName: string; source: Uint8Array }) => void
        }) => Promise<void>
        configureServer?: (server: {
          middlewares: { use: (fn: (req: any, res: any, next: () => void) => Promise<void>) => void }
        }) => void
      }
    }
    return mod.treeSitterAssets()
  }

  it('emits tree-sitter.wasm and exactly the 9 curated grammar WASMs in generateBundle', async () => {
    const plugin = await loadTreeSitterAssets()
    const emitted: string[] = []
    await plugin.generateBundle!.call({
      emitFile(asset) {
        expect(asset.type).toBe('asset')
        expect(asset.source.byteLength).toBeGreaterThan(0)
        emitted.push(asset.fileName)
      },
    })

    expect(emitted).toEqual([
      'tree-sitter/tree-sitter.wasm',
      'tree-sitter/tree-sitter-typescript.wasm',
      'tree-sitter/tree-sitter-tsx.wasm',
      'tree-sitter/tree-sitter-javascript.wasm',
      'tree-sitter/tree-sitter-python.wasm',
      'tree-sitter/tree-sitter-go.wasm',
      'tree-sitter/tree-sitter-rust.wasm',
      'tree-sitter/tree-sitter-java.wasm',
      'tree-sitter/tree-sitter-cpp.wasm',
      'tree-sitter/tree-sitter-c.wasm',
    ])
  })

  it('serves allowed WASM files with application/wasm and rejects traversal or unlisted grammars', async () => {
    const plugin = await loadTreeSitterAssets()
    let middleware: ((req: any, res: any, next: () => void) => Promise<void>) | null = null
    plugin.configureServer!({
      middlewares: {
        use(fn) {
          middleware = fn
        },
      },
    })
    expect(middleware).toBeTruthy()

    const invoke = async (url: string) => {
      const headers: Record<string, string> = {}
      let statusCode = 200
      let body: unknown = null
      let calledNext = false
      await middleware!(
        { url },
        {
          set statusCode(code: number) {
            statusCode = code
          },
          get statusCode() {
            return statusCode
          },
          setHeader(k: string, v: string) {
            headers[k.toLowerCase()] = v
          },
          end(data: unknown) {
            body = data
          },
        },
        () => {
          calledNext = true
        }
      )
      return { statusCode, headers, body, calledNext }
    }

    const core = await invoke('/tree-sitter/tree-sitter.wasm')
    expect(core.statusCode).toBe(200)
    expect(core.headers['content-type']).toBe('application/wasm')
    expect(Buffer.isBuffer(core.body) && core.body.length > 0).toBe(true)

    const ts = await invoke('/tree-sitter/tree-sitter-typescript.wasm')
    expect(ts.statusCode).toBe(200)
    expect(ts.headers['content-type']).toBe('application/wasm')

    const unlisted = await invoke('/tree-sitter/tree-sitter-ruby.wasm')
    expect(unlisted.statusCode).toBe(404)

    const traversal = await invoke('/tree-sitter/..%2Fpackage.json')
    expect(traversal.statusCode).toBe(400)

    const unrelated = await invoke('/other/file.js')
    expect(unrelated.calledNext).toBe(true)
  })
})
