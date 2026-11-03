/**
 * 云端控制台页：dashboard 的全屏宿主。
 *
 * 页面上除报错/引导外没有任何装饰 —— 边界即整块内容区，原生 `WebContentsView`
 * 铺满它。加载中与失败态的提示放在页签栏（原生层之外），这里只负责占位与边界上报。
 */

import React, { useEffect, useRef } from 'react'
import { Link, MonitorOff, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { AppView } from '../types/navigation'
import { Button, Caption, EmptyState } from './ui'

export const CloudConsoleView: React.FC<{
  active: boolean
  onNavigate: (view: AppView) => void
}> = ({ active, onNavigate }) => {
  const { t } = useI18nStore()
  const config = useCloudStore((state) => state.config)
  const dashboard = useCloudStore((state) => state.dashboard)
  const openDashboard = useCloudStore((state) => state.openDashboard)
  const reloadDashboard = useCloudStore((state) => state.reloadDashboard)
  const setDashboardBounds = useCloudStore((state) => state.setDashboardBounds)
  const hostRef = useRef<HTMLDivElement | null>(null)

  const ready = config.hasToken

  // 进入本页即打开（离开只是把原生层藏起来，视图留着，回来是热的）
  useEffect(() => {
    if (!active || !ready) return
    if (dashboard.visible) return
    void openDashboard()
  }, [active, ready, dashboard.visible, openDashboard])

  // 原生层的位置由这里实测上报：切页 / 改窗口大小 / 报错时都要同步
  useEffect(() => {
    const element = hostRef.current
    if (!element) return
    const push = () => {
      const rect = element.getBoundingClientRect()
      void setDashboardBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: active && ready && !dashboard.error && rect.width > 0 && rect.height > 0,
      })
    }
    push()
    // 测试环境（jsdom）没有 ResizeObserver：退化成只用窗口 resize
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(push) : null
    observer?.observe(element)
    window.addEventListener('resize', push)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', push)
    }
  }, [active, ready, dashboard.visible, dashboard.error, setDashboardBounds])

  return (
    <div
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 ${active ? 'visible' : 'pointer-events-none invisible'}`}
    >
      <div ref={hostRef} className="absolute inset-0 bg-sunken">
        {!ready && (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState
              icon={MonitorOff}
              title={t('cloudConsoleNeedsConnection')}
              description={t('cloudConsoleNeedsConnectionHint')}
              action={
                <Button
                  size="sm"
                  icon={Link}
                  variant="primary"
                  onClick={() => onNavigate('cloud-connection')}
                >
                  {t('cloudGoToConnection')}
                </Button>
              }
            />
          </div>
        )}
        {ready && dashboard.error && (
          <div className="flex h-full items-center justify-center p-8">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <MonitorOff size={20} className="text-danger" />
              <p className="m-0 type-subtitle text-ink">{t('cloudConsoleFailed')}</p>
              <Caption className="break-words text-ink-muted">{dashboard.error}</Caption>
              <Button size="sm" icon={RefreshCw} onClick={() => void reloadDashboard()}>
                {t('cloudRetry')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
