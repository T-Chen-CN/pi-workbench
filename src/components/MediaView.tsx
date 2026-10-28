import React, { useState } from 'react'
import { ExternalLink, Minimize2, Maximize2 } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { filePreviewUrl } from '../utils/fileKind'
import { Button, Caption, IconButton } from './ui'
import type { OpenFile } from '../types'

/** 媒体预览：图片 / 视频 / 音频共用一套工具条与错误降级 */
export const MediaView: React.FC<{ file: OpenFile }> = ({ file }) => {
  const { t } = useI18nStore()
  const [failed, setFailed] = useState(false)
  const [fit, setFit] = useState(true)
  const src = filePreviewUrl(file.path, file.version)

  const openExternal = async () => {
    const result = await api.openPathExternally(file.path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="media-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide bg-panel px-3 py-1">
        <Caption className="truncate text-ink-muted">{file.name}</Caption>
        <div className="ml-auto flex items-center gap-1">
          {file.kind === 'image' && (
            <IconButton
              icon={fit ? Maximize2 : Minimize2}
              label={fit ? t('imageActualSize') : t('imageFitWindow')}
              size="sm"
              active={!fit}
              onClick={() => setFit((value) => !value)}
            />
          )}
          <IconButton
            icon={ExternalLink}
            label={t('openExternally')}
            size="sm"
            onClick={openExternal}
          />
        </div>
      </div>

      {failed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="type-reading text-ink-muted">{t('mediaPlaybackFailed')}</p>
          <Button size="sm" icon={ExternalLink} onClick={openExternal}>
            {t('openExternally')}
          </Button>
        </div>
      ) : file.kind === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img
            src={src}
            alt={file.name}
            onError={() => setFailed(true)}
            className={`block ${fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}`}
          />
        </div>
      ) : file.kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-sunken p-4">
          <video
            src={src}
            controls
            onError={() => setFailed(true)}
            className="max-h-full max-w-full"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8">
          <audio src={src} controls onError={() => setFailed(true)} className="w-full max-w-[480px]" />
          <Caption className="text-ink-muted">{file.name}</Caption>
        </div>
      )}
    </div>
  )
}

/**
 * PDF 预览：优先使用 Chromium 内置查看器（webPreferences.plugins）。
 * 内置查看器不可用时降级为系统默认程序，避免为它引入 pdf.js。
 */
export const PdfPreview: React.FC<{ file: OpenFile }> = ({ file }) => {
  const { t } = useI18nStore()
  const [failed, setFailed] = useState(false)

  const openExternal = async () => {
    const result = await api.openPathExternally(file.path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }

  if (failed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
        <p className="type-reading text-ink-muted">{t('previewUnavailableDescription')}</p>
        <Button size="sm" icon={ExternalLink} onClick={openExternal}>
          {t('openExternally')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="pdf-preview">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide bg-panel px-3 py-1">
        <Caption className="truncate text-ink-muted">{file.name}</Caption>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={ExternalLink}
            label={t('openExternally')}
            size="sm"
            onClick={openExternal}
          />
        </div>
      </div>
      <iframe
        title={file.name}
        src={filePreviewUrl(file.path, file.version)}
        onError={() => setFailed(true)}
        className="min-h-0 w-full flex-1 border-0 bg-surface"
      />
    </div>
  )
}
