/**
 * 崩溃恢复草稿。
 *
 * 编辑器在内容变化后把未保存内容写入 {appDir}/cache/drafts/ 下的小 JSON 文件；
 * 正常保存后删除对应草稿。应用异常退出后，下次打开工作区可以恢复这些内容。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { readJsonWithBackup, writeJsonAtomicSync } from './atomic-json.js'

export interface DraftRecord {
  workspace: string
  path: string
  content: string
  updatedAt: number
}

const MAX_DRAFT_CHARS = 2_000_000
const MAX_DRAFTS_PER_WORKSPACE = 100

export class DraftStore {
  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true })
  }

  private fileFor(workspace: string, filePath: string): string {
    const key = createHash('sha1')
      .update(`${workspace}\0${filePath}`)
      .digest('hex')
      .slice(0, 24)
    return path.join(this.rootDir, `${key}.json`)
  }

  save(workspace: string, filePath: string, content: string): void {
    const truncated =
      content.length > MAX_DRAFT_CHARS ? content.slice(0, MAX_DRAFT_CHARS) : content
    const record: DraftRecord = {
      workspace,
      path: filePath,
      content: truncated,
      updatedAt: Date.now(),
    }
    writeJsonAtomicSync(this.fileFor(workspace, filePath), record)
  }

  remove(workspace: string, filePath: string): void {
    try {
      fs.rmSync(this.fileFor(workspace, filePath), { force: true })
    } catch {
      // ignore
    }
  }

  list(workspace: string): DraftRecord[] {
    let files: string[] = []
    try {
      files = fs.readdirSync(this.rootDir).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }

    const records: DraftRecord[] = []
    for (const name of files) {
      const result = readJsonWithBackup<DraftRecord>(path.join(this.rootDir, name))
      if (!result.data || result.data.workspace !== workspace) continue
      if (typeof result.data.path !== 'string' || typeof result.data.content !== 'string') continue
      records.push(result.data)
    }

    return records
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DRAFTS_PER_WORKSPACE)
  }

  clear(workspace: string): void {
    for (const draft of this.list(workspace)) {
      this.remove(workspace, draft.path)
    }
  }
}
