/** 虚拟列表渲染样板：有虚拟项时绝对定位，无测量环境时退化为前 N 条 */

import React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

export interface VirtualRowsProps<T> {
  virtualizer: Virtualizer<HTMLDivElement, Element>
  items: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  getKey: (item: T, index: number) => React.Key
  /** 无法测量（jsdom / 首帧）时渲染的前 N 条 */
  fallbackCount?: number
  /** 动态行高时挂 measureElement */
  measure?: boolean
  rowClassName?: string
  rowStyle?: React.CSSProperties
  contentStyle?: React.CSSProperties
}

export function VirtualRows<T>({
  virtualizer,
  items,
  renderItem,
  getKey,
  fallbackCount = 30,
  measure = false,
  rowClassName,
  rowStyle,
  contentStyle,
}: VirtualRowsProps<T>) {
  if (virtualizer.getVirtualItems().length === 0) {
    return (
      <div style={contentStyle}>
        {items.slice(0, fallbackCount).map((item, index) => (
          <div key={getKey(item, index)} className={rowClassName} style={rowStyle}>
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        position: 'relative',
        width: '100%',
        ...contentStyle,
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        if (item === undefined) return null
        return (
          <div
            key={getKey(item, virtualRow.index)}
            data-index={virtualRow.index}
            ref={measure ? virtualizer.measureElement : undefined}
            className={rowClassName}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              ...rowStyle,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        )
      })}
    </div>
  )
}
