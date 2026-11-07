/**
 * 云端控制台页：dashboard 的全屏宿主。
 *
 * 页面上除报错/引导外没有任何装饰 —— 边界即整块内容区，原生 `WebContentsView`
 * 铺满它。加载中与失败态的提示放在页签栏（原生层之外），这里只负责占位与边界上报。
 *
 * 注意「卸载」：切到本地工作区时整个云视图会被摘掉（`App.tsx`），谁也不会再推边界。
 * 所以卸载时必须显式上报一次 `visible: false`，否则原生层会留在屏幕上盖住别的页面。
 */

import React, { useEffect, useRef } from 'react'
import { Link, MonitorOff, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { AppView } from '../types/navigation'
import type { CloudDashboardBounds } from '../types/cloud'
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
  /** 最近一次上报的矩形：卸载时用同一块区域发 `visible:false` */
  const lastRectRef = useRef<CloudDashboardBounds | null>(null)

  const ready = config.hasDeviceToken

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
      const bounds: CloudDashboardBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: active && ready && !dashboard.error && rect.width > 0 && rect.height > 0,
      }
      lastRectRef.current = bounds
      void setDashboardBounds(bounds)
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

  // 只在卸载时收尾（deps 是稳定的 store action）：组件被摘掉后没人再来推边界，
  // 主进程那头就会把控制台停在最后的状态上 —— 表现为它盖住当前页面
  useEffect(() => {
    return () => {
      void setDashboardBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        ...(lastRectRef.current ?? {}),
        visible: false,
      })
    }
  }, [setDashboardBounds])

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
