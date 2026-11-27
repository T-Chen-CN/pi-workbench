/**
 * 原子 JSON 持久化（复用 `pi-bridge/atomic-json` 统一实现，保持主进程导出签名稳定）。
 */
export {
  readJsonAsyncWithBackup,
  readJsonWithBackup,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
  type JsonReadResult,
  type JsonWriteOptions,
} from 'pi-bridge/atomic-json'
