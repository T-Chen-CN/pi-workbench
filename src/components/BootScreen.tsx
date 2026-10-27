import React from 'react'
import { BrandSeal } from './BrandSeal'
import { Spinner } from './ui'
import { useI18nStore } from '../store/i18nStore'

interface BootScreenProps {
  /** 叠在已挂载的工作台之上，用于放大结束后的淡出 */
  overlay?: boolean
}

/**
 * 启动页的 React 版本：与 index.html 里的静态页保持同一套视觉。
 * 静态页负责 React 首帧之前的那段空白，这个组件接管之后到主界面出现之前的遮罩。
 */
export const BootScreen: React.FC<BootScreenProps> = ({ overlay = false }) => {
  const { t } = useI18nStore()

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex h-screen flex-col bg-surface text-ink ${
        overlay ? 'fixed inset-0 z-50' : ''
      }`}
    >
      <div className="app-drag h-[var(--titlebar-height)] flex-shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center">
        <BrandSeal size={44} />
        <span className="mt-5 type-brand text-ink">Pi Workbench</span>
        <span className="mt-3 flex items-center gap-1.5 type-label text-ink-muted">
          <Spinner size={14} className="text-accent" />
          {t('bootStarting')}
        </span>
      </div>
    </div>
  )
}
