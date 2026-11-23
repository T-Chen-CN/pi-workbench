/**
 * 工单的「改动清单」（F-22 / F-36 的数据来源）。
 *
 * 事故：模型用 bash（`printf > hello.txt && git commit`）改文件时，工具轨迹里没有这条路径，
 * 提交之后 `git status --porcelain` 又是空的 —— 云端于是显示「没有检测到文件改动」，
 * 而分支上明明有一个提交。这里钉住三个来源：工具轨迹 / 未提交现场 / **已提交的 diff**。
 */

// @vitest-environment node

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

const { collectTaskChangedFiles, toWorktreeRelative } = await import('../electron/cloud/task-runner')

let tmpRoot = ''
let repo = ''

function git(args: string[], cwd = repo): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args]).then((result) => result.stdout.trim())
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-changed-'))
  repo = path.join(tmpRoot, 'repo')
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(path.join(repo, 'README.md'), '# repo\n')
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'e2e@example.com'])
  await git(['config', 'user.name', 'e2e'])
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'init'])
  // 工作树 = 从 main 开一条分支，模拟「一单元一树」
  await git(['checkout', '-q', '-b', 'pi/cloudunit'])
}, 120_000)

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('collectTaskChangedFiles', () => {
  it('bash 写完并提交：树是干净的，也要把提交里的文件算进清单', async () => {
    await fs.writeFile(path.join(repo, 'hello.txt'), 'hello from cloud\n')
    await git(['add', 'hello.txt'])
    await git(['commit', '-q', '-m', 'add hello.txt'])
    expect(await git(['status', '--porcelain'])).toBe('')

    const files = await collectTaskChangedFiles('main', repo, [])
    expect(files.map((file) => file.path)).toContain('hello.txt')
    expect(files.find((file) => file.path === 'hello.txt')?.kind).toBe('added')
  })

  it('未提交的改动照样算，且与已提交的合并去重', async () => {
    await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted\n')
    await fs.writeFile(path.join(repo, 'hello.txt'), 'hello again\n')

    const files = await collectTaskChangedFiles('main', repo, [])
    const paths = files.map((file) => file.path)
    expect(paths.filter((file) => file === 'hello.txt')).toHaveLength(1)
    expect(files.find((file) => file.path === 'hello.txt')?.kind).toBe('modified')
    expect(paths).toContain('wip.txt')
  })

  it('工具轨迹里记到的路径不会被丢掉（即使 git 看不见它）', async () => {
    const files = await collectTaskChangedFiles('main', repo, [
      { path: 'C:\\tmp\\ghost.txt', kind: 'modified' },
    ])
    // 反斜杠要归一成 /，否则前端按路径去重会失效
    expect(files.map((file) => file.path)).toContain('C:/tmp/ghost.txt')
  })

  it('没有 base（首次派活 / 分支被删）也不抛，退回未提交现场', async () => {
    const files = await collectTaskChangedFiles(undefined, repo, [])
    expect(files.map((file) => file.path)).toContain('wip.txt')
  })

  it('工具报绝对路径时归一成工作树相对路径，树外的（含跨盘符）直接丢弃', () => {
    expect(toWorktreeRelative(repo, path.join(repo, 'src', 'a.ts'))).toBe(path.join('src', 'a.ts'))
    expect(toWorktreeRelative(repo, 'src/a.ts')).toBe('src/a.ts')
    expect(toWorktreeRelative(repo, path.join(repo, '..', 'outside.txt'))).toBeNull()
    // Windows 跨盘符：path.relative 会原样返回绝对路径
    expect(toWorktreeRelative(repo, 'E:/second.txt')).toBeNull()
  })
})
