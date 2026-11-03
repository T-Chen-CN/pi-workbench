/** 云端事件桥：主进程推来的 SSE 帧 / 连接状态 / 控制台加载失败写回 store */

import { useEffect } from 'react'
import { cloudApi } from '../api/cloud'
import { useCloudStore } from '../store/cloudStore'

export function useCloudBridge(): void {
  const applyFrame = useCloudStore((state) => state.applyFrame)
  const applyStatus = useCloudStore((state) => state.applyStatus)
  const setDashboardError = useCloudStore((state) => state.setDashboardError)

  useEffect(() => {
    const offEvent = cloudApi.onEvent((frame) => applyFrame(frame))
    const offStatus = cloudApi.onStatus((payload) => applyStatus(payload))
    const offDashboard = cloudApi.onDashboardLoadFailed((payload) =>
      setDashboardError(payload.description || String(payload.code))
    )
    return () => {
      offEvent()
      offStatus()
      offDashboard()
    }
  }, [applyFrame, applyStatus, setDashboardError])
}
