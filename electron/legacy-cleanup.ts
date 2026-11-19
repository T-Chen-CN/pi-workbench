/**
 * 一次性迁移：清理已被移除的功能留在盘上的运行时数据。
 *
 * 0.10.0 移除了云端 Agent（Hermes 版本），但旧版本在用户盘上留下过设备身份、
 * 加密的设备 token、审批审计与派活账本。新版没有任何代码再读它们，而它们属于
 * 凭据类数据，不能一直躺着 —— 在升级后的首次启动清一次。
 *
 * 纪律：
 * - **幂等**：`config/migrations.json` 记已执行的 id，重复启动直接短路（只多读一个小文件）。
 * - **不阻断启动**：任何一步失败只记警告；用户宁可留着残留，也不能打不开应用。
 * - **只删这里列出的路径**：全部由 appDir 拼出，不读用户输入、不跟随符号链接之外的路径。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { readJsonWithBackup, writeJsonAtomicSync } from './atomic-json.js'

export interface MigrationLog {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

/** 已执行迁移的记录：`{ applied: { [id]: 完成时间戳 } }` */
interface MigrationState {
  applied: Record<string, number>
}

const STATE_FILE = ['config', 'migrations.json'] as const

/** 迁移 id 一旦发布就不要改：改了等于让老用户重跑一遍 */
export const CLOUD_AGENT_REMOVED = 'cloud-agent-removed'

/**
 * 已删除功能的残留路径（相对 appDir）。
 *
 * 一份清单写死在这里，而不是从各自的旧模块里 import —— 那些模块已经删了，
 * 迁移代码不能反过来依赖被删掉的实现。
 */
const CLOUD_AGENT_LEFTOVERS: string[] = [
  // 云端连接、设备身份、接回缓存、未结算账本、审批审计
  path.join('data', 'cloud-agent'),
  // 工作区派活：白名单与账本
  path.join('data', 'agent', 'dispatch.json'),
  path.join('data', 'agent', 'dispatch.json.bak'),
  path.join('data', 'agent', 'dispatch-ledger.json'),
  path.join('data', 'agent', 'dispatch-ledger.json.bak'),
  // 派活轨迹
  path.join('cache', 'dispatch-traces'),
]

function readState(appDir: string): MigrationState {
  const result = readJsonWithBackup<MigrationState>(path.join(appDir, ...STATE_FILE))
  const applied = result.data?.applied
  if (!applied || typeof applied !== 'object') return { applied: {} }
  const cleaned: Record<string, number> = {}
  for (const [id, value] of Object.entries(applied)) {
    if (typeof value === 'number' && Number.isFinite(value)) cleaned[id] = value
  }
  return { applied: cleaned }
}

/** 删除一条相对路径（文件或目录）；不存在不算错 */
function removePath(appDir: string, relative: string): boolean {
  const target = path.join(appDir, relative)
  try {
    if (!fs.existsSync(target)) return false
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    throw new Error(`无法删除 ${relative}: ${String(error)}`)
  }
}

/**
 * 执行所有未完成的迁移，返回本次真正执行过的 id。
 *
 * 传 appDir 而不是让模块自己调 `getAppDir()`：迁移逻辑要能在纯单测里跑，
 * 不能把 Electron 的 app 依赖带进来。
 */
export function runLegacyCleanups(appDir: string, log: MigrationLog = console): string[] {
  const state = readState(appDir)
  const executed: string[] = []

  if (!state.applied[CLOUD_AGENT_REMOVED]) {
    try {
      const removed = CLOUD_AGENT_LEFTOVERS.filter((relative) => removePath(appDir, relative))
      state.applied[CLOUD_AGENT_REMOVED] = Date.now()
      writeJsonAtomicSync(path.join(appDir, ...STATE_FILE), state)
      executed.push(CLOUD_AGENT_REMOVED)
      log.info(
        `[Migration] ${CLOUD_AGENT_REMOVED}: cleaned ${removed.length} leftover path(s)`,
        removed
      )
    } catch (error) {
      // 不写标记：下次启动再试一次
      log.warn(`[Migration] ${CLOUD_AGENT_REMOVED} failed, will retry next launch:`, error)
    }
  }

  return executed
}
