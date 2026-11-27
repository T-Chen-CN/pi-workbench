import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { DraftStore } from '../../electron/draft-store'
import { FileLogger } from '../../electron/logger'
import { createWorkspaceStore } from '../../electron/workspace-store'
import { WorkerClient, disposeAllWorkers } from '../../electron/worker-runner'

const tempDirs: string[] = []

afterEach(async () => {
  await disposeAllWorkers()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('Phase 2 Milestone 2 workers and async I/O', () => {
  it('enables WAL mode on workspace-store sqlite database', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ws-wal-'))
    tempDirs.push(dir)
    const dbPath = path.join(dir, 'workspaces.db')
    const store = createWorkspaceStore(dbPath)
    store.recordOpen('/repo/a')
    expect(store.listRecent()).toEqual(['/repo/a'])
    store.close()

    const requireHere = createRequire(import.meta.url)
    const { DatabaseSync } = requireHere('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }
    db.close()
    expect(row.journal_mode?.toLowerCase()).toBe('wal')
  })

  it('supports async DraftStore listAsync/removeAsync/clearAsync with .bak recovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-async-'))
    tempDirs.push(dir)
    const store = new DraftStore(path.join(dir, 'drafts'))
    await store.save('/ws/a', '/ws/a/a.ts', 'hello async')
    expect(await store.listAsync('/ws/a')).toMatchObject([{ content: 'hello async' }])

    const files = await fs.readdir(path.join(dir, 'drafts'))
    const primary = path.join(dir, 'drafts', files[0])
    await fs.copyFile(primary, `${primary}.bak`)
    await fs.writeFile(primary, '{ invalid', 'utf-8')
    expect(await store.listAsync('/ws/a')).toMatchObject([{ content: 'hello async' }])

    await store.clearAsync('/ws/a')
    expect(await store.listAsync('/ws/a')).toEqual([])
  })

  it('flushes FileLogger asynchronously without losing lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-logger-async-'))
    tempDirs.push(dir)
    const logger = new FileLogger({ logDir: dir, maxBytes: 120 })
    logger.write('INFO', ['async-line-one-filling-buffer'])
    logger.write('WARN', ['async-line-two-triggers-rotation'])
    logger.write('INFO', ['async-line-three-after-rotate'])
    await logger.flushAsync()
    logger.close()

    const current = await fs.readFile(path.join(dir, 'main.log'), 'utf-8')
    const backup = await fs.readFile(path.join(dir, 'main.log.1'), 'utf-8')
    expect(backup).toContain('async-line-one-filling-buffer')
    expect(current).toContain('async-line-three-after-rotate')
  })

  it('runs worker_threads RPC + host callbacks and executes compiled repo-map/documents workers when built', async () => {
    // 1. 始终验证 WorkerClient 的真实 worker_threads RPC + 反向回调协议（不依赖预构建产物）
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-worker-rpc-'))
    tempDirs.push(tmp)
    const echoWorker = path.join(tmp, 'echo-worker.mjs')
    await fs.writeFile(
      echoWorker,
      `
      import { parentPort } from 'worker_threads'
      const pending = new Map()
      parentPort.on('message', (msg) => {
        if (msg.type === 'cb-res') {
          pending.get(msg.callId)?.(msg.result)
          pending.delete(msg.callId)
          return
        }
        if (msg.type === 'req') {
          pending.set(1, (cbVal) => {
            parentPort.postMessage({ type: 'res', id: msg.id, ok: true, result: { echoed: msg.payload, cbVal } })
          })
          parentPort.postMessage({ type: 'cb', callId: 1, name: 'double', payload: msg.payload })
        }
      })
      `,
      'utf-8'
    )
    const echoClient = new WorkerClient(pathToFileURL(echoWorker), 'echo-test')
    const rpcRes = await echoClient.call<{ echoed: number; cbVal: number }>('ping', 21, {
      onCallback: async (name, val) => (name === 'double' ? Number(val) * 2 : 0),
    })
    expect(rpcRes).toEqual({ echoed: 21, cbVal: 42 })

    // 2. 当 dist-electron 已构建时，直接验证真实编译后的 repo-map-worker 与 documents-worker 零 electron 依赖可运行
    const repoMapWorkerPath = path.resolve(process.cwd(), 'dist-electron', 'repo-map-worker.js')
    const docsWorkerPath = path.resolve(
      process.cwd(),
      'dist-electron',
      'documents',
      'documents-worker.js'
    )
    const repoClient = new WorkerClient(pathToFileURL(repoMapWorkerPath), 'repo-map-test')
    const docsClient = new WorkerClient(pathToFileURL(docsWorkerPath), 'docs-test')
    if (!repoClient.isWorkerAvailable() || !docsClient.isWorkerAvailable()) return

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-worker-repo-'))
    tempDirs.push(repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    await fs.writeFile(path.join(repo, 'index.ts'), 'export function greet() { return 1 }\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const scan = await repoClient.call<{ success: boolean; isRepo: boolean; total: number }>(
      'scan',
      { workspaceDir: repo, options: {} }
    )
    expect(scan.success).toBe(true)
    expect(scan.isRepo).toBe(true)
    expect(scan.total).toBe(1)

    const pdfPath = path.join(repo, 'sample.pdf')
    await fs.writeFile(pdfPath, '%PDF-1.4\n%EOF\n', 'utf-8')
    const preview = await docsClient.call<{ kind: string; format?: string }>('preview', pdfPath)
    expect(preview).toEqual({ kind: 'pdf', format: 'pdf' })
  })
})
