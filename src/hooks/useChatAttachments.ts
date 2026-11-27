/** 聊天输入区附件、图像预处理与符号扫描子 Hook */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { editorStoreFor } from '../store/editorStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { formatBytes } from '../utils/formatBytes'
import { extractSymbols, sliceSymbol, type ExtractedSymbol } from '../utils/symbols'
import { isPathInside } from '../utils/filePath'
import {
  ALLOWED_IMAGE_TYPES,
  ImagePrepareError,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  base64ToFile,
  prepareImageFile,
} from '../utils/imageAttachment'
import { MAX_ATTACHMENTS } from '../utils/chatPanelShared'

/** 「附加符号」全文扫描的防抖窗口：停手后才重算一次 */
const SYMBOL_SCAN_DEBOUNCE_MS = 400
const EMPTY_SYMBOLS: ExtractedSymbol[] = []

export interface UseChatAttachmentsOptions {
  workspacePath: string
  viewRoot?: string
  editorRoot: string
  activeKey: string | null
  imagesAllowed: boolean
  /** 仅在符号选择浮层实际打开时扫描当前文件符号，避免背景工作区每次按键后 400ms 跑全文正则 */
  symbolsActive: boolean
  t: (key: any, params?: Record<string, string | number>) => string
  setShowAttachMenu: (open: boolean) => void
  setAttachMode: (mode: 'files' | 'symbols') => void
}

export function useChatAttachments(options: UseChatAttachmentsOptions) {
  const {
    workspacePath,
    viewRoot,
    editorRoot,
    activeKey,
    imagesAllowed,
    symbolsActive,
    t,
    setShowAttachMenu,
    setAttachMode,
  } = options

  /** 正在预处理（缩放 / 编码）的图片数量 */
  const [imageProcessing, setImageProcessing] = useState(0)
  /** 同一计数的同步镜像：发送路径需要在事件回调里立即判断，不等渲染 */
  const imageProcessingRef = useRef(0)

  /**
   * 「附加符号」要扫全文：未打开符号选择器时不订阅 editorStore、不启动定时器、不执行正则扫描。
   * 打开后立即按当前文件计算，编辑期间以 `SYMBOL_SCAN_DEBOUNCE_MS` 防抖刷新。
   */
  const [symbolTick, setSymbolTick] = useState(0)
  useEffect(() => {
    if (!symbolsActive) return
    const store = editorStoreFor(editorRoot)
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = store.subscribe(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setSymbolTick((tick) => tick + 1)
      }, SYMBOL_SCAN_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [editorRoot, symbolsActive])

  const currentSymbols = useMemo(() => {
    if (!symbolsActive) return EMPTY_SYMBOLS
    void symbolTick
    const file = editorStoreFor(editorRoot).getState().currentFile
    return file ? extractSymbols(file.content, file.name) : EMPTY_SYMBOLS
  }, [editorRoot, symbolsActive, symbolTick])

  /** 附加单个符号（函数 / 类等）作为上下文 */
  const attachSymbol = (symbol: ExtractedSymbol) => {
    // 切片取当下的正文（符号列表是防抖后的快照，可能比文件旧）
    const file = editorStoreFor(editorRoot).getState().currentFile
    if (!activeKey || !file) return
    useChatStore.getState().addAttachment(activeKey, {
      kind: 'snippet',
      path: file.path,
      name: `${file.name}#${symbol.name}`,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      content: sliceSymbol(file.content, symbol),
    })
    setShowAttachMenu(false)
    setAttachMode('files')
  }

  /** 图像附件：统一预处理（长边 2048）后进入附件区，不写入上下文文本 */
  const addImageFiles = (files: File[]): void => {
    const key = activeKey
    if (!key) return
    if (!imagesAllowed) {
      toast.error(t('modelImageDisabled'))
      return
    }
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    void (async () => {
      imageProcessingRef.current += 1
      setImageProcessing((count) => count + 1)
      try {
        const existing = useChatStore.getState().conversations[key]?.attachments ?? []
        let imageCount = existing.filter((attachment) => attachment.kind === 'image').length
        // 图片与文件共用同一条消息的总量上限
        let attachmentCount = existing.length
        let totalChars = existing.reduce(
          (total, attachment) =>
            attachment.kind === 'image' ? total + (attachment.data?.length ?? 0) : total,
          0
        )

        for (const file of imageFiles) {
          if (attachmentCount >= MAX_ATTACHMENTS) {
            toast.error(t('attachmentLimit', { count: MAX_ATTACHMENTS }))
            break
          }
          if (imageCount >= MAX_IMAGE_COUNT) {
            toast.error(t('imageLimit', { count: MAX_IMAGE_COUNT }))
            break
          }
          try {
            const prepared = await prepareImageFile(file)
            if (totalChars + prepared.data.length > MAX_TOTAL_IMAGE_BASE64_CHARS) {
              toast.error(t('imageTotalTooLarge'))
              break
            }
            useChatStore.getState().addAttachment(key, {
              kind: 'image',
              path: '',
              name:
                prepared.name ||
                `image-${Date.now()}.${prepared.mimeType.split('/')[1] || 'png'}`,
              mimeType: prepared.mimeType,
              data: prepared.data,
              size: prepared.size,
            })
            imageCount += 1
            attachmentCount += 1
            totalChars += prepared.data.length
          } catch (error) {
            const code = error instanceof ImagePrepareError ? error.code : 'encodeFailed'
            if (code === 'unsupported') toast.error(t('imageUnsupported'))
            else if (code === 'tooLarge') {
              toast.error(t('imageTooLarge', { size: formatBytes(MAX_IMAGE_OUTPUT_BYTES) }))
            } else if (code === 'tooManyPixels') toast.error(t('imageTooManyPixels'))
            else toast.error(t('imageEncodeFailed'))
          }
        }
      } finally {
        imageProcessingRef.current = Math.max(0, imageProcessingRef.current - 1)
        setImageProcessing((count) => Math.max(0, count - 1))
      }
    })()
  }

  /** 粘贴截图作为图像附件 */
  const handlePaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    )
    if (files.length === 0) return
    event.preventDefault()
    addImageFiles(files)
  }

  /** 拖入 / 选中的文件统一转成附件：补元信息、去重、守住总量上限 */
  const attachFiles = useCallback(
    (
      key: string,
      files: Array<{
        path: string
        name: string
        size?: number
        mime?: string
        mtime?: number
      }>
    ) => {
      const store = useChatStore.getState()
      const existing = store.conversations[key]?.attachments ?? []
      const seen = new Set(existing.map((attachment) => attachment.path))
      let count = existing.length
      let overflow = false
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          overflow = true
          break
        }
        if (seen.has(file.path)) continue
        seen.add(file.path)
        count += 1
        store.addAttachment(key, {
          kind: 'file',
          path: file.path,
          name: file.name,
          size: file.size,
          mime: file.mime,
          mtime: file.mtime,
          // 工作区外的文件同样能附加，只在 UI 与 prompt 里标明来源
          external: !isPathInside(viewRoot ?? workspacePath, file.path),
        })
      }
      if (overflow) toast.error(t('attachmentLimit', { count: MAX_ATTACHMENTS }))
    },
    [t, viewRoot, workspacePath]
  )

  /** 原生文件选择：任意位置、任意格式；除图片外只拿路径 */
  const handlePickFiles = async () => {
    setShowAttachMenu(false)
    if (!activeKey) return
    const result = await api.pickAttachments()
    if (!result.success) {
      toast.error(t('attachmentPickFailed'))
      return
    }
    if (result.canceled || result.files.length === 0) return

    // 图片走视觉通道，其余文件只交路径
    const images: File[] = []
    const plain: Array<{ path: string; name: string; size?: number; mime?: string; mtime?: number }> = []
    for (const file of result.files) {
      // 只把视觉通道支持的位图当图片；SVG 之类仍按普通文件交路径
      if (ALLOWED_IMAGE_TYPES.has(file.mime) && file.data) {
        try {
          images.push(base64ToFile(file.data, file.name, file.mime))
          continue
        } catch {
          // 解码失败就退化为普通文件附件
        }
      }
      plain.push({
        path: file.path,
        name: file.name,
        size: file.size,
        mime: file.mime,
        mtime: file.mtime,
      })
    }
    attachFiles(activeKey, plain)
    if (images.length > 0) addImageFiles(images)
  }

  /** 拖入文件作为附件 */
  const handleDropFiles = (event: React.DragEvent) => {
    event.preventDefault()
    if (!activeKey) return
    const images: File[] = []
    const plain: Array<{ path: string; name: string; size?: number; mime?: string; mtime?: number }> = []
    for (const file of Array.from(event.dataTransfer.files)) {
      // 只有位图走视觉通道；SVG 等其他图片格式按普通文件附加（模型可读源码）
      if (ALLOWED_IMAGE_TYPES.has(file.type)) {
        images.push(file)
        continue
      }
      const target = api.getPathForFile(file)
      if (!target) continue
      plain.push({
        path: target,
        name: file.name,
        size: file.size,
        mime: file.type || undefined,
        mtime: file.lastModified || undefined,
      })
    }
    attachFiles(activeKey, plain)
    if (images.length > 0) addImageFiles(images)
  }

  return {
    imageProcessing,
    imageProcessingRef,
    currentSymbols,
    attachSymbol,
    addImageFiles,
    handlePaste,
    attachFiles,
    handlePickFiles,
    handleDropFiles,
  }
}
