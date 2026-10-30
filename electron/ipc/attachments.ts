/**
 * 附件文件选择（任意路径、任意格式）。
 *
 * 设计取舍（2026-10-30 需求）：
 * - 用户点选 / 拖入 / 粘贴附件这一个动作本身就是意图表达，不再有二次授权；
 * - 除图片外，主进程**不读文件内容**：只回传路径与元信息，内容由 Agent 用自己的
 *   read / bash 工具按路径读取。因此 `fs:readFile` 的工作区校验不需要放宽，
 *   渲染层也不会获得「传任意路径读内容」的能力；
 * - 图片必须走内容（视觉通道对路径无意义），所以在点选瞬间由主进程读取并编码。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { dialog, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import { mimeForPath } from '../file-protocol.js'

/** 内联读取图片的源文件上限：与渲染层 10MB 编码上限留出余量 */
const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024

/** 视觉通道支持的位图；其余图片格式（SVG / TIFF 等）按普通文件交路径 */
const BITMAP_MIME = /^image\/(png|jpe?g|webp|gif)$/i

export interface PickedAttachment {
  /** 绝对路径；文件可能位于工作区之外 */
  path: string
  name: string
  size: number
  /** 最后修改时间（ms），仅用于展示与模型判断新旧 */
  mtime: number
  mime: string
  /** 仅图片类型填充：base64（不含 data: 前缀） */
  data?: string
}

export interface AttachmentPickResult {
  success: boolean
  canceled: boolean
  files: PickedAttachment[]
  error?: string
}

export interface AttachmentsIpcContext {
  getMainWindow: () => BrowserWindow | null
  getLanguage: () => 'zh' | 'en'
}

const PICK_TITLE: Record<'zh' | 'en', string> = {
  zh: '选择附件文件',
  en: 'Select attachment files',
}

async function describeFile(targetPath: string): Promise<PickedAttachment | null> {
  try {
    const stats = await fs.stat(targetPath)
    if (!stats.isFile()) return null
    const mime = mimeForPath(targetPath)
    const entry: PickedAttachment = {
      path: targetPath,
      name: path.basename(targetPath),
      size: stats.size,
      mtime: Math.round(stats.mtimeMs),
      mime,
    }
    // 只有图片需要内容；其他格式一律只给路径，交给 Agent 按需读取
    if (BITMAP_MIME.test(mime) && stats.size <= MAX_INLINE_IMAGE_BYTES) {
      try {
        const buffer = await fs.readFile(targetPath)
        entry.data = buffer.toString('base64')
      } catch {
        // 读不到内容不影响附加：图片退化为仅路径
      }
    }
    return entry
  } catch {
    return null
  }
}

export function registerAttachmentsIpc(context: AttachmentsIpcContext): void {
  handleIpc('attachment:pick', async (): Promise<AttachmentPickResult> => {
    const win = context.getMainWindow()
    const options = {
      title: PICK_TITLE[context.getLanguage()],
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    }
    try {
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, canceled: true, files: [] }
      }
      const files: PickedAttachment[] = []
      for (const filePath of result.filePaths) {
        const entry = await describeFile(filePath)
        if (entry) files.push(entry)
      }
      return { success: true, canceled: false, files }
    } catch (error) {
      return {
        success: false,
        canceled: false,
        files: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
