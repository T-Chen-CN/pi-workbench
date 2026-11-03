/** 云端事件桥：主进程推来的 SSE 帧 / 连接状态 / 控制台加载结果写回 store */

import { useEffect } from 'react'
import { cloudApi } from '../api/cloud'
import { useCloudStore } from '../store/cloudStore'

export function useCloudBridge(): void {
  const applyFrame = useCloudStore((state) => state.applyFrame)
  const applyStatus = useCloudStore((state) => state.applyStatus)
  const setDashboardError = useCloudStore((state) => state.setDashboardError)
  const settleDashboard = useCloudStore((state) => state.settleDashboard)

  useEffect(() => {
    const offEvent = cloudApi.onEvent((frame) => applyFrame(frame))
    const offStatus = cloudApi.onStatus((payload) => applyStatus(payload))
    const offFailed = cloudApi.onDashboardLoadFailed((payload) =>
      setDashboardError(payload.description || String(payload.code))
    )
    // 一次加载收尾：清掉加载态；成功时顺带清掉上一次的错误（重试成功要能自愈）
    const offLoaded = cloudApi.onDashboardLoaded(() => settleDashboard())
    return () => {
      offEvent()
      offStatus()
      offFailed()
      offLoaded()
    }
  }, [applyFrame, applyStatus, setDashboardError, settleDashboard])
}
