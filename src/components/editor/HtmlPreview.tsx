import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCw } from 'lucide-react'
import { useI18nStore } from '../../store/i18nStore'
import { api } from '../../api'
import { toast } from '../../store/toastStore'
import { localizeError } from '../../i18n/errors'
import { filePreviewUrl } from '../../utils/fileKind'
import { Caption, IconButton } from '../ui/ui'
import type { OpenFile } from '../../types'

/** 落盘完成后短防抖再刷新 iframe，避免连续保存闪烁 */
const RELOAD_DEBOUNCE_MS = 150

/**
 * HTML 阅读视图。
 *
 * 用 `pw-file://` 直出文件本身（而不是 srcDoc），这样相对路径的图片、样式与脚本
 * 才能按原始目录结构解析。iframe 不带 `allow-same-origin`：
 * 文档运行在不透明源里，拿不到父窗口与 Electron API，脚本仍可执行。
 */
export const HtmlPreview: React.FC<{ file: OpenFile; visible?: boolean }> = ({
  file,
  visible = true,
}) => {
  const t = useI18nStore((state) => state.t)
  const [reloadKey, setReloadKey] = useState(0)
  const lastPathRef = useRef(file.path)
  const lastContentRef = useRef(file.content)
  const wasDirtyRef = useRef(file.isDirty)
  const pendingFlushRef = useRef(false)
  const pendingReloadRef = useRef(false)

  useEffect(() => {
    if (file.path !== lastPathRef.current) {
      lastPathRef.current = file.path
      lastContentRef.current = file.content
      wasDirtyRef.current = file.isDirty
      pendingFlushRef.current = false
      pendingReloadRef.current = false
      setReloadKey(0)
      return
    }
    const contentChanged = file.content !== lastContentRef.current
    if (contentChanged) {
      lastContentRef.current = file.content
    }
    const justSaved = wasDirtyRef.current && !file.isDirty
    wasDirtyRef.current = file.isDirty

    // 草稿尚未落盘（isDirty=true）时不刷 pw-file://，避免反复读到磁盘旧内容
    if (file.isDirty) {
      if (contentChanged) pendingFlushRef.current = true
      return
    }
    const shouldReload = justSaved || pendingFlushRef.current || contentChanged
    if (!shouldReload) return
    pendingFlushRef.current = false

    // 源码编辑且预览隐藏时不后台重建 iframe，切回预览时补刷一次
    if (!visible) {
      pendingReloadRef.current = true
      return
    }
    const timer = setTimeout(() => setReloadKey((value) => value + 1), RELOAD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [file.content, file.path, file.isDirty, visible])

  useEffect(() => {
    if (!visible || file.isDirty || !pendingReloadRef.current) return
    pendingReloadRef.current = false
    setReloadKey((value) => value + 1)
  }, [visible, file.isDirty])

  const openExternal = async () => {
    const result = await api.openPathExternally(file.path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="html-preview">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide bg-panel px-3 py-1">
        <Caption className="truncate text-ink-muted">{file.name}</Caption>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={RotateCw}
            label={t('previewReload')}
            size="sm"
            onClick={() => setReloadKey((value) => value + 1)}
          />
          <IconButton
            icon={ExternalLink}
            label={t('openExternally')}
            size="sm"
            onClick={openExternal}
          />
        </div>
      </div>
      <iframe
        key={`${file.path}-${file.version}-${reloadKey}`}
        title={file.name}
        src={filePreviewUrl(file.path, file.version + reloadKey)}
        sandbox="allow-scripts allow-forms"
        className="min-h-0 w-full flex-1 border-0 bg-surface"
      />
    </div>
  )
}
