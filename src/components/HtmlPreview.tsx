import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { filePreviewUrl } from '../utils/fileKind'
import { Caption, IconButton } from './ui'
import type { OpenFile } from '../types'

/** 源码保存后延迟刷新，避免连续输入时反复重载 iframe */
const RELOAD_DEBOUNCE_MS = 500

/**
 * HTML 阅读视图。
 *
 * 用 `pw-file://` 直出文件本身（而不是 srcDoc），这样相对路径的图片、样式与脚本
 * 才能按原始目录结构解析。iframe 不带 `allow-same-origin`：
 * 文档运行在不透明源里，拿不到父窗口与 Electron API，脚本仍可执行。
 */
export const HtmlPreview: React.FC<{ file: OpenFile }> = ({ file }) => {
  const { t } = useI18nStore()
  const [reloadKey, setReloadKey] = useState(0)
  const lastPathRef = useRef(file.path)
  const lastContentRef = useRef(file.content)

  useEffect(() => {
    if (file.path !== lastPathRef.current) {
      lastPathRef.current = file.path
      lastContentRef.current = file.content
      setReloadKey(0)
      return
    }
    if (file.content === lastContentRef.current) return
    lastContentRef.current = file.content
    const timer = setTimeout(() => setReloadKey((value) => value + 1), RELOAD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [file.content, file.path])

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
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
        className="min-h-0 w-full flex-1 border-0 bg-surface"
      />
    </div>
  )
}
