import React from 'react'
import { Search, X, type LucideIcon } from 'lucide-react'
import { Caption, DataText, Label, Value } from './ui'

export type StatusTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'

const TONE_CLASSES: Record<StatusTone, string> = {
  default: 'text-ink',
  muted: 'text-ink-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

export interface CardProps {
  children: React.ReactNode
  className?: string
  density?: 'default' | 'compact'
}

export const Card: React.FC<CardProps> = ({ children, className = '', density = 'default' }) => (
  <div
    className={`rounded border border-rule-hairline bg-raised ${
      density === 'compact' ? 'p-3' : 'p-4'
    } ${className}`}
  >
    {children}
  </div>
)

export interface CardHeaderProps {
  title: React.ReactNode
  status?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

export const CardHeader: React.FC<CardHeaderProps> = ({
  title,
  status,
  action,
  className = '',
}) => (
  <div
    className={`flex items-center justify-between gap-3 border-b border-rule-divide pb-2 ${className}`}
  >
    <Label className="text-ink">{title}</Label>
    {status ?? action}
  </div>
)

export interface SectionHeaderProps {
  title: React.ReactNode
  count?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  count,
  action,
  className = '',
}) => (
  <div
    className={`flex flex-none items-baseline justify-between gap-4 border-b border-rule-divide pb-2 ${className}`}
  >
    <span className="flex items-baseline gap-2.5">
      <Label className="text-ink">{title}</Label>
      {count !== undefined && (
        <Caption className="text-ink-muted">{count}</Caption>
      )}
    </span>
    {action}
  </div>
)

export interface StatProps {
  label: React.ReactNode
  value: React.ReactNode
  className?: string
}

export const Stat: React.FC<StatProps> = ({ label, value, className = '' }) => (
  <div className={`min-w-0 ${className}`}>
    <Label className="text-ink-muted">{label}</Label>
    <Value className="mt-1 block truncate text-ink" title={typeof value === 'string' ? value : undefined}>
      {value}
    </Value>
  </div>
)

export const StatGrid: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div className={`grid grid-cols-2 gap-x-4 gap-y-3 ${className}`}>{children}</div>
)

export interface StatusTextProps {
  tone?: StatusTone
  dot?: boolean
  children: React.ReactNode
  className?: string
}

export const StatusText: React.FC<StatusTextProps> = ({
  tone = 'muted',
  dot = false,
  children,
  className = '',
}) => (
  <Label className={`inline-flex items-center gap-1.5 ${TONE_CLASSES[tone]} ${className}`}>
    {dot && <span className="h-1 w-1 rounded-full bg-current" aria-hidden="true" />}
    {children}
  </Label>
)

export interface QuickActionProps {
  icon: LucideIcon
  label: React.ReactNode
  onClick: () => void
  className?: string
}

export const QuickAction: React.FC<QuickActionProps> = ({
  icon: Icon,
  label,
  onClick,
  className = '',
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 border-b border-rule-divide pb-0.5 font-normal text-ink-muted transition-colors hover:border-ink hover:text-ink type-label ${className}`}
  >
    <Icon size={11} aria-hidden="true" />
    {label}
  </button>
)

export interface ListRowProps {
  icon?: LucideIcon
  title: React.ReactNode
  subtitle?: React.ReactNode
  trailing?: React.ReactNode
  onClick?: () => void
  titleVariant?: 'project' | 'value'
  className?: string
  titleAttr?: string
}

export const ListRow: React.FC<ListRowProps> = ({
  icon: Icon,
  title,
  subtitle,
  trailing,
  onClick,
  titleVariant = 'value',
  className = '',
  titleAttr,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`group flex w-full items-center gap-3 border-b border-rule-divide py-2.5 text-left transition-colors hover:bg-hover ${className}`}
  >
    {Icon && <Icon size={14} className="flex-shrink-0 text-ink-muted" aria-hidden="true" />}
    <span className="min-w-0 flex-1">
      <span
        className={`block truncate ${
          titleVariant === 'project' ? 'type-project' : 'type-value'
        } text-ink transition-colors group-hover:text-accent`}
        title={titleAttr}
      >
        {title}
      </span>
      {subtitle && (
        <DataText className="block truncate text-ink-muted">{subtitle}</DataText>
      )}
    </span>
    {trailing}
  </button>
)

export interface LegendRowProps {
  icon: LucideIcon
  iconClassName?: string
  title: string
  description: string
  meta?: string
}

/** 非交互图例行：用于解释模式等固定选项 */
export const LegendRow: React.FC<LegendRowProps> = ({
  icon: Icon,
  iconClassName = 'text-ink-muted',
  title,
  description,
  meta,
}) => (
  <div className="flex items-start gap-2.5 border-b border-rule-divide py-2.5 last:border-b-0">
    <Icon size={14} className={`mt-0.5 flex-shrink-0 ${iconClassName}`} aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="type-label text-ink">{title}</span>
        {meta && <span className="flex-shrink-0 type-caption text-ink-subtle">{meta}</span>}
      </div>
      <span className="mt-0.5 block type-caption text-ink-muted">{description}</span>
    </div>
  </div>
)

export interface SettingsTableColumn {
  label: string
  /** 列宽与对齐；表头与数据行必须用同一组类名 */
  className?: string
}

export interface SettingsTableProps {
  columns: SettingsTableColumn[]
  children: React.ReactNode
  className?: string
}

/** 设置页能力表：列头 + 行内控件；不用表格语义的卡片式两列表，因为需要第三列开关 */
export const SettingsTable: React.FC<SettingsTableProps> = ({
  columns,
  children,
  className = '',
}) => (
  <div className={`border border-rule-hairline bg-raised ${className}`}>
    <div className="flex items-center gap-3 border-b border-rule-divide bg-panel px-3 py-1.5">
      {columns.map((column) => (
        <Label key={column.label} className={`text-ink-muted ${column.className ?? ''}`}>
          {column.label}
        </Label>
      ))}
    </div>
    {children}
  </div>
)

export interface SettingsTableRowProps {
  /** 当前生效项；只做底色区分，不动文字颜色 */
  selected?: boolean
  children: React.ReactNode
  className?: string
}

export const SettingsTableRow: React.FC<SettingsTableRowProps> = ({
  selected = false,
  children,
  className = '',
}) => (
  <div
    className={`flex items-center gap-3 border-b border-rule-divide px-3 py-1 last:border-b-0 ${
      selected ? 'bg-active' : ''
    } ${className}`}
  >
    {children}
  </div>
)

export const KeyCap: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <kbd
    className={`type-key inline-flex h-5 min-w-5 items-center justify-center border border-rule-control bg-sunken px-1 text-ink-muted ${className}`}
  >
    {children}
  </kbd>
)

export interface MeterProps {
  /** 0–100 */
  value: number
  label?: string
  /** 进度色：默认 accent；接近上限时用 warning / danger */
  tone?: 'accent' | 'warning' | 'danger'
  className?: string
}

/** 细线进度条：用于下载进度等线性过程，不使用动画或发光 */
export const Meter: React.FC<MeterProps> = ({ value, label, tone = 'accent', className = '' }) => {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
  const toneClass =
    tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-accent'
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
      className={`block h-1 w-full overflow-hidden bg-sunken ${className}`}
    >
      <span
        className={`block h-full ${toneClass} transition-all duration-150`}
        style={{ width: `${percent}%` }}
      />
    </span>
  )
}

export interface RingMeterProps {
  /** 0–100；null 表示未知，仅绘制轨道 */
  value: number | null
  size?: number
  strokeWidth?: number
  /** 进度色：默认 accent；接近上限时用 warning / danger */
  tone?: 'accent' | 'warning' | 'danger'
  label?: string
  className?: string
}

/** 圆环进度：用于状态行的上下文占用，尺寸与图标同尺度 */
export const RingMeter: React.FC<RingMeterProps> = ({
  value,
  size = 14,
  strokeWidth = 2,
  tone = 'accent',
  label,
  className = '',
}) => {
  const percent = value == null ? null : Math.max(0, Math.min(100, Math.round(value)))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = percent == null ? circumference : circumference * (1 - percent / 100)
  const toneClass =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-accent'
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label={label}
      data-testid="ring-meter"
      className={`block flex-shrink-0 ${toneClass} ${className}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-rule-divide"
      />
      {percent != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  )
}

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  className?: string
}

export const SearchField: React.FC<SearchFieldProps> = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = '',
}) => (
  <div
    className={`flex h-7 flex-shrink-0 items-center gap-1.5 border border-rule-control bg-panel px-2 transition-colors focus-within:border-accent ${className}`}
  >
    <Search size={12} className="flex-shrink-0 text-ink-muted" aria-hidden="true" />
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="min-w-0 flex-1 bg-transparent type-value text-ink placeholder:text-ink-muted focus:outline-none"
    />
  </div>
)

/* ------------------------------------------------------------------
   标签条（Tab）

   可点区域 = 可视矩形：点击处理在标签本体上，内边距长在标签本体上，
   文字层 pointer-events-none，关闭按钮用 data-tab-aux 标记并阻断冒泡。
   禁止把点击处理留在「无 handler 的 wrapper 里的内层小按钮」上。
------------------------------------------------------------------- */

export interface TabProps {
  active?: boolean
  /** roving tabindex：标签条里恰好一个 0；无激活项时由调用方指定首个 */
  tabbable?: boolean
  size?: 'md' | 'sm'
  leading?: React.ReactNode
  label: React.ReactNode
  trailing?: React.ReactNode
  labelClassName?: string
  title?: string
  ariaLabel?: string
  busy?: boolean
  onSelect: () => void
  /** 提供即渲染关闭按钮（24px 命中区，图标 10px）；中键同样关闭 */
  onClose?: () => void
  closeLabel?: string
  className?: string
}

const TAB_SIZES = {
  md: 'h-[34px]',
  sm: 'h-8',
}

export const Tab = React.forwardRef<HTMLDivElement, TabProps>(function Tab(
  {
    active = false,
    tabbable,
    size = 'md',
    leading,
    label,
    trailing,
    labelClassName = '',
    title,
    ariaLabel,
    busy = false,
    onSelect,
    onClose,
    closeLabel,
    className = '',
  },
  ref
) {
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      title={title}
      tabIndex={(tabbable ?? active) ? 0 : -1}
      data-tab=""
      onClick={(event) => {
        // 次级动作自己阻断冒泡之外再兜一层：将来漏写 stopPropagation 也不会误切标签
        if ((event.target as HTMLElement).closest('[data-tab-aux]')) return
        onSelect()
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !onClose) return
        event.preventDefault()
        onClose()
      }}
      onKeyDown={handleTabListKeyDown}
      className={`group flex ${TAB_SIZES[size]} flex-shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-rule-divide pl-3 pr-1 type-label transition-colors focus-visible:outline-offset-[-2px] ${
        active
          ? 'bg-surface text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
          : 'text-ink-muted hover:bg-hover hover:text-ink'
      } ${className}`}
    >
      {/* 文字与装饰不接触指针事件：整块矩形都落到标签本体 */}
      <span className="pointer-events-none flex min-w-0 items-center gap-1.5">
        {leading}
        <span className={`truncate ${labelClassName}`}>{label}</span>
        {trailing}
      </span>
      {onClose && (
        <button
          data-tab-aux=""
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className={`ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center text-ink-muted transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 ${
            active ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </div>
  )
})

/**
 * 标签条键盘模型（WAI-ARIA APG Tabs，自动激活）：←/→ 循环、Home/End 到两端、
 * Enter / Space 激活当前项。焦点移动后直接派发 click，选中逻辑仍只有标签条自己那一份。
 */
export function handleTabListKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const { key } = event
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(key)) return
  // 关闭按钮等次级控件自己处理按键，不参与标签间移动
  if ((event.target as HTMLElement).closest('[data-tab-aux]')) return
  const strip = event.currentTarget.parentElement
  if (!strip) return
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'))
  const index = tabs.indexOf(event.currentTarget as HTMLElement)
  if (index < 0) return

  let next = index
  if (key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  else if (key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (key === 'Home') next = 0
  else if (key === 'End') next = tabs.length - 1

  event.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}

/** 标签条横向滚动：滚轮直接横移，标签条上的滚动条因此可以隐藏（不占 34px 高度） */
export function handleTabStripWheel(event: React.WheelEvent<HTMLElement>): void {
  if (event.deltaY === 0 || event.deltaX !== 0) return
  const strip = event.currentTarget
  if (strip.scrollWidth <= strip.clientWidth) return
  strip.scrollLeft += event.deltaY
}
