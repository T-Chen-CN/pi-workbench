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

import { RepoSyncManager, type GitChangedPayload } from '../electron/repo-sync'

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  run(['init', '-b', 'main'], dir)
  run(['config', 'user.email', 'test@example.com'], dir)
  run(['config', 'user.name', 'Test'], dir)
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  run(['add', '.'], dir)
  run(['commit', '-m', 'init'], dir)
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for git:changed')
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** Windows 上 git / 文件监听释放句柄有延迟，删除临时目录需要重试 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

describe('RepoSyncManager', () => {
  let root = ''
  let manager: RepoSyncManager
  let sent: GitChangedPayload[]

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'pi-repo-sync-'))
    sent = []
    manager = new RepoSyncManager()
    manager.configure({
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (_channel: string, payload: GitChangedPayload) => sent.push(payload),
          },
        }) as never,
      logger,
    })
  })

  afterEach(async () => {
    manager.disposeAll()
    await removeTempDir(root)
  })

  it('broadcasts a refs change to the workspace that owns the repository', async () => {
    const workspace = path.join(root, 'ws')
    await initRepo(workspace)
    await manager.ensure(workspace)

    await fs.writeFile(path.join(workspace, 'b.txt'), 'two\n')
    run(['add', '.'], workspace)
    run(['commit', '-m', 'second'], workspace)

    await waitFor(() =>
      sent.some((payload) => payload.reason === 'watch' && payload.scopes.includes('refs'))
    )
    const payload = sent.find(
      (item) => item.reason === 'watch' && item.scopes.includes('refs')
    )
    expect(payload?.workspaceDir).toBe(workspace)
    expect(payload?.scopes).toContain('refs')
  })

  it('broadcasts after fetching new remote commits', async () => {
    const origin = path.join(root, 'origin.git')
    await fs.mkdir(origin, { recursive: true })
    run(['init', '--bare', '-b', 'main'], origin)

    const seed = path.join(root, 'seed')
    await initRepo(seed)
    run(['remote', 'add', 'origin', origin], seed)
    run(['push', '-u', 'origin', 'main'], seed)

    const workspace = path.join(root, 'ws')
    const other = path.join(root, 'other')
    run(['clone', origin, workspace], root)
    run(['clone', origin, other], root)
    run(['config', 'user.email', 'test@example.com'], other)
    run(['config', 'user.name', 'Test'], other)

    await manager.ensure(workspace)
    sent.length = 0

    await fs.writeFile(path.join(other, 'c.txt'), 'three\n')
    run(['add', '.'], other)
    run(['commit', '-m', 'remote change'], other)
    run(['push', 'origin', 'main'], other)

    const result = await manager.fetchNow(workspace, { force: true })
    expect(result.success).toBe(true)

    await waitFor(() => sent.some((payload) => payload.reason === 'fetch'))
    const payload = sent.find((item) => item.reason === 'fetch')
    expect(payload?.workspaceDir).toBe(workspace)
    expect(payload?.scopes).toContain('refs')
  })
})
