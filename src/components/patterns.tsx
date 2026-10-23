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
  className?: string
}

/** 细线进度条：用于下载进度等线性过程，不使用动画或发光 */
export const Meter: React.FC<MeterProps> = ({ value, label, className = '' }) => {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
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
        className="block h-full bg-accent transition-all duration-150"
        style={{ width: `${percent}%` }}
      />
    </span>
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
