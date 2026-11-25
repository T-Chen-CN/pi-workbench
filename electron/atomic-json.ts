/**
 * 原子 JSON 持久化（复用 `pi-bridge` 的统一实现，保持主进程导出签名稳定）。
 */
import {
  readJsonWithBackup,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
  type JsonReadResult,
  type JsonWriteOptions,
} from 'pi-bridge/dist/atomic-json.js'

export { readJsonWithBackup, writeJsonAtomicAsync, writeJsonAtomicSync }
export type { JsonReadResult, JsonWriteOptions }

/** 异步串行原子写 JSON（默认带 .bak 与 fsync，不阻塞主进程 UI 线程） */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeJsonAtomicAsync(filePath, value)
}
