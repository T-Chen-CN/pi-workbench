/**
 * 仓库地图后台工作线程：
 * 把 `git ls-files`、批量文件头扫描、导出正则解析与 `.pi-workbench/repo-map.json` 读写
 * 移出 Electron GUI 主线程。
 */

import { parentPort } from 'worker_threads'
import { scanRepoMap, type RepoMapScanOptions } from './repo-map.js'
import type { WorkerRequestMessage, WorkerResponseMessage } from './worker-runner.js'

if (!parentPort) {
  throw new Error('repo-map-worker must run inside a worker_threads Worker')
}
const port = parentPort

port.on('message', (msg: WorkerRequestMessage) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'req') return
  void (async () => {
    try {
      if (msg.method !== 'scan') {
        throw new Error(`Unknown repo-map-worker method: ${msg.method}`)
      }
      const { workspaceDir, options } = msg.payload as {
        workspaceDir: string
        options?: RepoMapScanOptions
      }
      const result = await scanRepoMap(workspaceDir, options)
      const res: WorkerResponseMessage = { type: 'res', id: msg.id, ok: true, result }
      port.postMessage(res)
    } catch (error) {
      const res: WorkerResponseMessage = {
        type: 'res',
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      port.postMessage(res)
    }
  })()
})
