/**
 * 画布上的一张卡：目录卡（点开浮层）或文件卡（点击打开）。
 *
 * 纯展示组件：位置由 `style.left/top` 给（世界坐标），拖动时父组件直接改这个元素的
 * transform，不经过 React；这里只负责 LOD 结构（描述 / 角色标签在缩小时由 CSS 隐藏）。
 */

import React from 'react'
import {
  Braces,
  ChevronRight,
  Cpu,
  Database,
  File as FileIcon,
  FileText,
  FlaskConical,
  Folder,
  Image as ImageIcon,
  LayoutTemplate,
  Palette,
  Settings2,
  Wrench,
} from 'lucide-react'
import type { RepoMapRole } from '../types/electron'
import { NODE_SIZES, type CanvasNodeInput, type Point } from '../utils/repoMapLayout'

const ROLE_ICONS: Record<RepoMapRole, React.ComponentType<{ size?: number; className?: string }>> = {
  component: LayoutTemplate,
  state: Database,
  ipc: Cpu,
  util: Wrench,
  type: Braces,
  style: Palette,
  test: FlaskConical,
  doc: FileText,
  config: Settings2,
  asset: ImageIcon,
  other: FileIcon,
}

export interface RepoMapNodeCardProps {
  node: CanvasNodeInput
  point: Point
  name: string
  /** 文件卡：一句话职责（可能为空字符串） */
  description: string
  /** 文件夹卡：文件数标签（可由 i18n 拼好） */
  countLabel: string
  role: RepoMapRole
  roleLabel: string
  /** 搜索命中 / 未命中（未命中会淡出） */
  matched: boolean
  dimmed: boolean
  /** 上浮链上的卡片：抬到画布之上（阴影 + 更亮的底） */
  elevated?: boolean
  /** 抬升层级：越深越靠上（z-index / 阴影 / 视觉上移都按这个梯度） */
  depth?: number
  /** 当前焦点层（最深那一层）：只有它全亮、可点、拿强调边 */
  emphasized?: boolean
  /** 上浮链打开时，底层卡片压暗且不可点 */
  muted?: boolean
  /**
   * 当前层的「锚卡」：链尾那张被点开的文件夹卡。
   * 它是唯一拿到 `bg-raised` + `accent` 描边 + 左侧 2px 竖条的卡片 ——
   * 父/子的颜色区分由角色决定（不看 depth），所以每一层长得完全一样。
   */
  anchor?: boolean
  /** 目录卡：点开这个目录的浮层 */
  onOpenFolder: (path: string) => void
  /** 文件卡：在编辑器打开 */
  onOpenFile: (path: string) => void
  onPointerDown?: (event: React.PointerEvent<HTMLElement>, node: CanvasNodeInput) => void
}

/** 「退后」档的不透明度：底层与所有祖先层共用这一个值 */
const RECESSED_OPACITY = 0.4

/** 搜索命中的 6% accent 叠层：单独一层，避免与角色底色抢同一个 `bg-*` */
const HitTint = () => (
  <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-accent/[0.06]" />
)

const CARD_BASE =
  'repo-map-card group absolute flex flex-col justify-between overflow-hidden rounded-sm ' +
  'border px-2.5 py-2 text-left transition-colors ' +
  'hover:border-accent focus-visible:border-accent focus-visible:outline-none'

export const RepoMapNodeCard = React.memo(function RepoMapNodeCard({
  node,
  point,
  name,
  description,
  countLabel,
  role,
  roleLabel,
  matched,
  dimmed,
  elevated = false,
  depth = 0,
  emphasized = false,
  muted = false,
  anchor = false,
  onOpenFolder,
  onOpenFile,
  onPointerDown,
}: RepoMapNodeCardProps) {
  const size = NODE_SIZES[node.kind]
  /** 一层 4px 的视觉上移 + 阴影加重：越深越「近」 */
  const STEP_PX = 4
  // 「退后」只有一档：底层与所有祖先层完全一致（同样的压暗、同样的不可点）
  const recessed = !emphasized && (muted || elevated)
  const elevationStyle: React.CSSProperties = elevated
    ? {
        zIndex: 2 + depth,
        transform: depth > 0 ? `translateY(-${depth * STEP_PX}px)` : undefined,
        boxShadow: `calc(5px + ${depth}px) calc(6px + ${depth}px) 0 rgb(var(--shadow-color) / var(--shadow-alpha))`
      }
    : {}
  const style: React.CSSProperties = {
    left: point.x,
    top: point.y,
    width: size.width,
    height: size.height,
    zIndex: elevated ? 2 + depth : 1,
    opacity: recessed ? RECESSED_OPACITY : undefined,
    pointerEvents: recessed ? 'none' : undefined,
    ...elevationStyle,
  }
  // 底色与描边只由「角色 + 临时态」决定：锚卡最亮并拿 accent 边，其余卡一律 panel +
  // 普通描边（底层与各层子项同款）；深度只由 z-index / 4px 上移 / 阴影表达。
  // 搜索命中的 6% accent 用叠层而不是第二个 bg-* 类：底色与 tint 不会再互相顶掉。
  const stateClass = [
    anchor ? 'bg-raised' : 'bg-panel',
    anchor || matched ? 'border-accent' : 'border-rule-control',
    dimmed && !elevated ? 'opacity-25' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (node.kind === 'folder') {
    return (
      <button
        type="button"
        data-testid="repo-map-folder"
        data-path={node.path}
        data-kind="folder"
        data-role={anchor ? 'anchor' : 'folder'}
        data-elevated={elevated ? 'true' : 'false'}
        data-depth={elevated ? depth : undefined}
        data-emphasized={emphasized ? 'true' : 'false'}
        style={style}
        aria-label={`${node.path} — ${countLabel}`}
        title={node.path}
        className={`${CARD_BASE} repo-map-card--folder ${stateClass}`}
        tabIndex={recessed ? -1 : undefined}
        onClick={() => {
          if (!recessed) onOpenFolder(node.path)
        }}
        onPointerDown={(event) => onPointerDown?.(event, node)}
      >
        {matched && !anchor && <HitTint />}
        {anchor && (
          <span
            aria-hidden="true"
            data-anchor-bar="true"
            className="pointer-events-none absolute left-0 top-0 h-full w-0.5 bg-accent"
          />
        )}
        <span className="flex w-full items-center gap-1.5">
          <ChevronRight size={12} className="flex-shrink-0 text-ink-muted" />
          <Folder size={12} className="flex-shrink-0 text-ink-muted" />
          <span className="type-value min-w-0 flex-1 truncate text-ink">{name}</span>
        </span>
        <span className="repo-map-card__meta type-caption truncate pl-[26px] text-ink-subtle">
          {countLabel}
        </span>
      </button>
    )
  }

  const Icon = ROLE_ICONS[role] ?? FileIcon
  return (
    <button
      type="button"
      data-testid="repo-map-card"
      data-path={node.path}
      data-kind="file"
      data-role={anchor ? 'anchor' : 'file'}
      data-elevated={elevated ? 'true' : 'false'}
      data-depth={elevated ? depth : undefined}
      data-emphasized={emphasized ? 'true' : 'false'}
      style={style}
      aria-label={description ? `${name} — ${description}` : name}
      title={node.path}
      className={`${CARD_BASE} ${stateClass}`}
      tabIndex={recessed ? -1 : undefined}
      onClick={() => {
        if (!recessed) onOpenFile(node.path)
      }}
      onPointerDown={(event) => onPointerDown?.(event, node)}
    >
      {matched && !anchor && <HitTint />}
      {anchor && (
        <span
          aria-hidden="true"
          data-anchor-bar="true"
          className="pointer-events-none absolute left-0 top-0 h-full w-0.5 bg-accent"
        />
      )}
      <span className="flex w-full items-center gap-1.5">
        <Icon size={12} className="flex-shrink-0 text-ink-muted" />
        <span className="type-value min-w-0 flex-1 truncate text-ink">{name}</span>
      </span>
      <span className="repo-map-card__desc type-caption w-full truncate text-ink-muted">
        {description}
      </span>
      <span className="repo-map-card__role type-caption w-fit flex-shrink-0 border border-rule-control px-1.5 text-ink-subtle">
        {roleLabel}
      </span>
    </button>
  )
})
