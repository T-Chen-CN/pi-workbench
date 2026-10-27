import React from 'react'
import { Search, type LucideIcon } from 'lucide-react'
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
