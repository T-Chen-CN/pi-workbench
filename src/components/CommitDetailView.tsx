/** 提交详情：在编辑器区覆盖显示提交信息、文件列表与 patch */

import React, { useEffect } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { IconButton, Spinner } from './ui'

interface CommitDetailViewProps {
  workspacePath: string
  active?: boolean
  onClose: () => void
}

export const CommitDetailView: React.FC<CommitDetailViewProps> = ({
  workspacePath,
  active = true,
  onClose,
}) => {
  const { t, language } = useI18nStore()
  const detail = useGitStore((state) => state.byWorkspace[workspacePath]?.commitDetail ?? null)
  const pending = useGitStore((state) => state.byWorkspace[workspacePath]?.detailPending ?? null)

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onClose])

  const locale = language === 'zh' ? 'zh-CN' : 'en-US'
  const date = detail ? new Date(detail.commit.date) : null

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface">
      <div className="flex h-[34px] flex-none items-center gap-1.5 border-b border-rule-divide bg-panel px-2.5">
        <IconButton icon={ArrowLeft} label={t('gitDetailBack')} size="sm" onClick={onClose} />
        <span className="min-w-0 truncate type-label text-ink">
          {detail ? `${t('gitCommitColumn')} ${detail.commit.shortSha}` : t('gitView')}
        </span>
        <span className="flex-1" />
        <IconButton icon={X} label={t('close')} size="sm" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {!detail ? (
          <div className="flex items-center gap-2 type-caption text-ink-muted">
            <Spinner size={12} />
            <span className="type-data text-ink-subtle">{pending?.slice(0, 7) ?? ''}</span>
          </div>
        ) : (
          <article className="mx-auto flex max-w-4xl flex-col">
            <h2 className="break-words type-subtitle text-ink">{detail.commit.subject}</h2>
            {detail.body && (
              <p className="mt-2 whitespace-pre-wrap break-words type-reading text-ink-muted">
                {detail.body}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-rule-hairline pb-3 type-caption text-ink-muted">
              <span className="type-value text-ink">{detail.commit.author}</span>
              <span aria-hidden="true">·</span>
              <span>{date && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale) : ''}</span>
              <span aria-hidden="true">·</span>
              <span className="type-data text-ink-subtle" title={detail.commit.sha}>
                {detail.commit.shortSha}
              </span>
              {detail.commit.parents.length > 0 && (
                <span className="type-data text-ink-subtle">
                  {detail.commit.parents.slice(0, 2).map((parent) => parent.slice(0, 7)).join(' · ')}
                </span>
              )}
            </div>

            <section className="mt-3">
              <div className="type-label text-ink-muted">
                {t('gitDetailFiles', { count: detail.files.length })}
              </div>
              <div className="mt-1 flex flex-col">
                {detail.files.length === 0 && (
                  <span className="type-caption text-ink-muted">{t('gitDetailNoFiles')}</span>
                )}
                {detail.files.map((file) => (
                  <div
                    key={`${file.status}:${file.path}`}
                    className="flex h-6 min-w-0 items-center gap-2"
                  >
                    <span className="w-3 flex-none type-data text-accent">{file.status}</span>
                    <span className="truncate type-data text-ink">{file.path}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-3">
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-hairline bg-sunken p-2 type-code text-ink-muted">
                {detail.patch}
              </pre>
              {detail.truncated && (
                <div className="mt-1 type-caption text-warning">{t('gitPatchTruncated')}</div>
              )}
            </section>
          </article>
        )}
      </div>
    </div>
  )
}
