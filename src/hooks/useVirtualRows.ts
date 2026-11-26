import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export interface UseVirtualRowsOptions {
  count: number
  /** 预估行高；动态行高时作为初始值，渲染后由 measureElement 校正 */
  estimateSize: number
  overscan?: number
  /** 稳定行身份键：切换会话或增删行时防止复用旧行高缓存引发跳动/重叠 */
  getItemKey?: (index: number) => string | number
}

/**
 * 竖向虚拟列表基础 hook。
 *
 * 固定行高（文件树、Diff）直接使用 estimateSize；
 * 动态行高（聊天消息）在行元素上挂 `ref={virtualizer.measureElement}`。
 */
export function useVirtualRows({
  count,
  estimateSize,
  overscan = 8,
  getItemKey,
}: UseVirtualRowsOptions) {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    ...(getItemKey ? { getItemKey } : {}),
    // 首帧（以及 jsdom 等无 ResizeObserver 的环境）先按一个视口估算，避免空渲染
    initialRect: { width: 0, height: 800 },
  })

  return { parentRef, virtualizer }
}
