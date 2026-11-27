/**
 * 崩溃恢复草稿。
 *
 * 编辑器在内容变化后把未保存内容写入 {appDir}/cache/drafts/ 下的小 JSON 文件；
 * 正常保存后删除对应草稿。应用异常退出后，下次打开工作区可以恢复这些内容。
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { readJsonWithBackup, writeJsonAtomicAsync } from './atomic-json.js'

export interface DraftRecord {
  workspace: string
  path: string
  content: string
  updatedAt: number
}

const MAX_DRAFT_CHARS = 2_000_000
const MAX_DRAFTS_PER_WORKSPACE = 100

export class DraftStore {
  /** 同文件异步写/删串行队列，防止在途 save() 在 remove() 之后复活已删草稿 */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly workspaceClearGenerations = new Map<string, number>()

  constructor(private readonly rootDir: string) {
    try {
      fs.mkdirSync(rootDir, { recursive: true })
    } catch (error) {
      // 安装目录不可写时不让主进程在模块加载阶段崩溃；后续写入会失败并由 IPC 返回错误
      console.warn('[Drafts] Failed to create draft directory:', error)
    }
  }

  private fileFor(workspace: string, filePath: string): string {
    const key = createHash('sha1')
      .update(`${workspace}\0${filePath}`)
      .digest('hex')
      .slice(0, 24)
    return path.join(this.rootDir, `${key}.json`)
  }

  private keyFor(file: string): string {
    return process.platform === 'win32' ? file.toLowerCase() : file
  }

  private bumpGeneration(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, next)
    return next
  }

  private bumpWorkspaceClearGeneration(workspace: string): number {
    const next = (this.workspaceClearGenerations.get(workspace) ?? 0) + 1
    this.workspaceClearGenerations.set(workspace, next)
    return next
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.catch(() => undefined)
    this.queues.set(key, tail)
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  /**
   * 写一份草稿（异步原子写）。
   *
   * 两条硬要求：
   * 1. 不能同步落盘：主进程线程就是浏览器 UI 线程，`fsync` 会连带卡住窗口事件与输入法合成；
   * 2. 不留 `.bak`：写 `.bak` 要先回读并解析上一份全文（草稿里就是整篇文档），
   *    等于每次保存多一遍全文 I/O。草稿是可再生的缓存，临时文件 + rename 已足够。
   */
  async save(workspace: string, filePath: string, content: string): Promise<void> {
    // 超长草稿不做截断保存：截断内容一旦被恢复并保存，会破坏原文件
    if (content.length > MAX_DRAFT_CHARS) {
      console.warn(
        `[Drafts] Skipping draft for ${filePath}: content exceeds ${MAX_DRAFT_CHARS} characters`
      )
      await this.removeAsync(workspace, filePath)
      return
    }
    const file = this.fileFor(workspace, filePath)
    const key = this.keyFor(file)
    const gen = this.bumpGeneration(key)
    const wsGen = this.workspaceClearGenerations.get(workspace) ?? 0
    const record: DraftRecord = {
      workspace,
      path: filePath,
      content,
      updatedAt: Date.now(),
    }
    const isStale = () =>
      this.generations.get(key) !== gen ||
      (this.workspaceClearGenerations.get(workspace) ?? 0) !== wsGen

    await this.enqueue(key, async () => {
      if (isStale()) return
      await writeJsonAtomicAsync(file, record, { backup: false, fsync: false })
      // 同步 remove()/clear() 若在写盘 await 期间发生，必须立刻回收刚落盘的文件防止复活
      if (isStale()) {
        await fsp.rm(file, { force: true }).catch(() => undefined)
      }
    })
  }

  remove(workspace: string, filePath: string): void {
    const file = this.fileFor(workspace, filePath)
    const key = this.keyFor(file)
    const gen = this.bumpGeneration(key)
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // ignore
    }
    if (this.queues.has(key)) {
      void this.enqueue(key, async () => {
        if (this.generations.get(key) !== gen) return
        try {
          await fsp.rm(file, { force: true })
        } catch {
          // ignore
        }
      })
    }
  }

  async removeAsync(workspace: string, filePath: string): Promise<void> {
    const file = this.fileFor(workspace, filePath)
    const key = this.keyFor(file)
    const gen = this.bumpGeneration(key)
    await this.enqueue(key, async () => {
      if (this.generations.get(key) !== gen) return
      try {
        await fsp.rm(file, { force: true })
      } catch {
        // ignore
      }
    })
  }

  list(workspace: string): DraftRecord[] {
    return this.allForWorkspace(workspace).slice(0, MAX_DRAFTS_PER_WORKSPACE)
  }

  /** 异步读取工作区草稿，避免打开工作区时在主线程同步扫描全部草稿文件 */
  async listAsync(workspace: string): Promise<DraftRecord[]> {
    const all = await this.allForWorkspaceAsync(workspace)
    return all.slice(0, MAX_DRAFTS_PER_WORKSPACE)
  }

  private async readDraftAsync(filePath: string): Promise<DraftRecord | null> {
    for (const candidate of [filePath, `${filePath}.bak`]) {
      try {
        const raw = await fsp.readFile(candidate, 'utf-8')
        const parsed = JSON.parse(raw) as DraftRecord
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.workspace === 'string' &&
          typeof parsed.path === 'string' &&
          typeof parsed.content === 'string'
        ) {
          return parsed
        }
      } catch {
        // 主文件损坏或不存在时尝试 .bak
      }
    }
    return null
  }

  private async allForWorkspaceAsync(workspace: string): Promise<DraftRecord[]> {
    let files: string[] = []
    try {
      files = (await fsp.readdir(this.rootDir)).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const loaded = await Promise.all(
      files.map((name) => this.readDraftAsync(path.join(this.rootDir, name)))
    )
    const records: DraftRecord[] = []
    for (const item of loaded) {
      if (!item || item.workspace !== workspace) continue
      records.push(item)
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 不截断的工作区草稿集合（清理时使用） */
  private allForWorkspace(workspace: string): DraftRecord[] {
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

    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  clear(workspace: string): void {
    this.bumpWorkspaceClearGeneration(workspace)
    for (const draft of this.allForWorkspace(workspace)) {
      this.remove(workspace, draft.path)
    }
  }

  async clearAsync(workspace: string): Promise<void> {
    this.bumpWorkspaceClearGeneration(workspace)
    const drafts = await this.allForWorkspaceAsync(workspace)
    await Promise.all(drafts.map((draft) => this.removeAsync(workspace, draft.path)))
  }
}
