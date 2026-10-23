/**
 * 检查点存储（AF-03）
 *
 * 每轮 prompt 前建立一个检查点；写入 / 编辑工具在替换文件前把旧内容记入检查点。
 * 数据存放在应用数据目录（`{appDir}/data/checkpoints/<workspace-hash>/`），
 * 不写入用户工作区。bash 等外部副作用不在检查点范围内。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

export interface CheckpointFile {
  /** 工作区内的绝对路径 */
  path: string
  /** 修改前的内容；null 表示该文件在修改前不存在（回退时删除） */
  oldContent: string | null
}

export interface CheckpointRecord {
  version: 1
  id: string
  sessionId: string
  workspaceDir: string
  createdAt: number
  /** 检查点时刻的会话叶子节点；回退对话时导航到这里 */
  leafId: string | null
  files: CheckpointFile[]
}

export interface CheckpointSummary {
  id: string
  sessionId: string
  createdAt: number
  fileCount: number
}

export const MAX_CHECKPOINTS_PER_WORKSPACE = 20

function workspaceKey(workspaceDir: string): string {
  return createHash('sha1').update(workspaceDir).digest('hex').slice(0, 16)
}

export class CheckpointStore {
  private readonly workspaceDirPath: string

  constructor(baseDir: string, workspaceDir: string) {
    this.workspaceDirPath = path.join(baseDir, workspaceKey(workspaceDir))
  }

  private filePathFor(record: Pick<CheckpointRecord, 'id' | 'createdAt'>): string {
    return path.join(this.workspaceDirPath, `${record.createdAt}-${record.id}.json`)
  }

  async save(record: CheckpointRecord): Promise<void> {
    if (record.files.length === 0) return
    await fs.mkdir(this.workspaceDirPath, { recursive: true })
    const target = this.filePathFor(record)
    const temp = `${target}.tmp`
    await fs.writeFile(temp, JSON.stringify(record), 'utf-8')
    await fs.rename(temp, target)
  }

  /** 最近的检查点在前；可按会话过滤 */
  async list(sessionId?: string): Promise<CheckpointSummary[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.workspaceDirPath)
    } catch {
      return []
    }

    const summaries: CheckpointSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(this.workspaceDirPath, entry), 'utf-8')
        ) as CheckpointRecord
        if (record.version !== 1) continue
        if (sessionId && record.sessionId !== sessionId) continue
        summaries.push({
          id: record.id,
          sessionId: record.sessionId,
          createdAt: record.createdAt,
          fileCount: record.files.length,
        })
      } catch {
        // 跳过损坏的检查点文件
      }
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt)
  }

  async load(id: string): Promise<CheckpointRecord | null> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.workspaceDirPath)
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') || !entry.includes(`-${id}.json`)) continue
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(this.workspaceDirPath, entry), 'utf-8')
        ) as CheckpointRecord
        if (record.id === id) return record
      } catch {
        // ignore
      }
    }
    return null
  }

  /** 只保留最近 N 个检查点 */
  async prune(keep = MAX_CHECKPOINTS_PER_WORKSPACE): Promise<void> {
    const summaries = await this.list()
    for (const stale of summaries.slice(keep)) {
      const target = path.join(this.workspaceDirPath, `${stale.createdAt}-${stale.id}.json`)
      await fs.rm(target, { force: true })
    }
  }

  async remove(id: string): Promise<void> {
    const record = await this.load(id)
    if (!record) return
    await fs.rm(this.filePathFor(record), { force: true })
  }
}
