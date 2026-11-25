/**
 * 稳定设备 ID（UUID）。OAuth 登录时作为 `agentHostId` 上报，
 * OpenAI 会校验 UUID 格式，格式不对直接拒绝登录（D27）。
 */

import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import { writeJsonAtomic, writeJsonAtomicSync } from './atomic-json.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 读现有 ID；没有或格式不对就生成一个并落盘（同一次安装永远是同一个 ID） */
export async function deviceId(filePath: string): Promise<string> {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && UUID_PATTERN.test(parsed.id)) return parsed.id
    } catch {
      // 坏文件按「没有」处理，重写一份
    }
  }
  const id = randomUUID()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await writeJsonAtomic(filePath, { id })
  return id
}

const cache = new Map<string, string>()

/**
 * 同步版本：SDK 的 `LoginOptions.getDeviceId` 是同步回调，不能等 IO。
 * 首次调用读盘 / 生成并落盘，之后走内存缓存。
 */
export function deviceIdSync(filePath: string): string {
  const cached = cache.get(filePath)
  if (cached) return cached
  let id: string | null = null
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && UUID_PATTERN.test(parsed.id)) id = parsed.id
    } catch {
      // 坏文件按「没有」处理
    }
  }
  if (!id) {
    id = randomUUID()
    writeJsonAtomicSync(filePath, { id })
  }
  cache.set(filePath, id)
  return id
}
