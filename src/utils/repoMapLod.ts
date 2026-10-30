/** 缩放档位：决定卡片显示多少信息（CSS 按 data 属性切换） */
export function lodForZoom(zoom: number): 'full' | 'compact' | 'tiny' {
  if (zoom >= 0.6) return 'full'
  if (zoom >= 0.35) return 'compact'
  return 'tiny'
}
