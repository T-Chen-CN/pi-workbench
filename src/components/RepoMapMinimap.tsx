/**
 * 画布小地图：右下角的缩略图 + 视口框，点 / 拖可把视口挪过去。
 *
 * 用 SVG 画矩形（节点可能上百个，SVG 比 div 便宜），数据全部由父组件预算好的
 * 世界坐标矩形传入；这里不做布局计算。
 */

import React from 'react'
import type { Rect } from '../utils/repoMapLayout'

export const MINIMAP_WIDTH = 168
export const MINIMAP_HEIGHT = 104
const MINIMAP_PADDING = 6

export interface RepoMapMinimapProps {
  /** 可见节点的世界坐标矩形 */
  nodes: Rect[]
  /** 当前视口在世界坐标里的矩形 */
  viewport: Rect
  onNavigate: (world: { x: number; y: number }) => void
}

export const RepoMapMinimap: React.FC<RepoMapMinimapProps> = ({ nodes, viewport, onNavigate }) => {
  const all = [...nodes, viewport]
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of all) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const scale = Math.min(
    (MINIMAP_WIDTH - MINIMAP_PADDING * 2) / width,
    (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / height
  )
  const offsetX = MINIMAP_PADDING + (MINIMAP_WIDTH - MINIMAP_PADDING * 2 - width * scale) / 2
  const offsetY = MINIMAP_PADDING + (MINIMAP_HEIGHT - MINIMAP_PADDING * 2 - height * scale) / 2
  const project = (rect: Rect) => ({
    x: offsetX + (rect.x - left) * scale,
    y: offsetY + (rect.y - top) * scale,
    width: Math.max(1, rect.width * scale),
    height: Math.max(1, rect.height * scale),
  })

  const navigate = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    const localX = event.clientX - bounds.left
    const localY = event.clientY - bounds.top
    onNavigate({
      x: left + (localX - offsetX) / scale,
      y: top + (localY - offsetY) / scale,
    })
  }

  return (
    <div
      data-testid="repo-map-minimap"
      role="presentation"
      aria-hidden="true"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
      className="absolute bottom-3 right-3 cursor-pointer border border-rule-control bg-panel/95 shadow-print"
      onPointerDown={(event) => {
        // jsdom / 老浏览器没有 pointer capture：拿不到就直接响应这一次点击
        event.currentTarget.setPointerCapture?.(event.pointerId)
        navigate(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) navigate(event)
      }}
    >
      <svg width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} className="block">
        {nodes.map((rect, index) => {
          const projected = project(rect)
          return (
            <rect
              key={index}
              x={projected.x}
              y={projected.y}
              width={projected.width}
              height={projected.height}
              className="fill-rule-divide"
            />
          )
        })}
        {(() => {
          const projected = project(viewport)
          return (
            <rect
              x={projected.x}
              y={projected.y}
              width={projected.width}
              height={projected.height}
              className="fill-none stroke-accent"
              strokeWidth={1}
            />
          )
        })()}
      </svg>
    </div>
  )
}
