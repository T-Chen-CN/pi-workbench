/**
 * Paper & Ink 轻量共享原语（零 zustand / i18nStore / panelStore / Electron 依赖）。
 * 供 `@pi-workbench/cloud-ui` 卡片与云端 Web 控制台直接使用，彻底断开 Web 对桌面端 store 与翻译表的依赖。
 */

import React, { useEffect, useId, useRef } from 'react'
import { Loader2, X, type LucideIcon } from 'lucide-react'

export type CloudButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type CloudControlSize = 'sm' | 'md'
export type CloudStatusTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium rounded-sm transition-colors select-none ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

const BUTTON_SIZES: Record<CloudControlSize, string> = {
  sm: 'h-7 px-2.5 type-label',
  md: 'h-8 px-3 type-label',
}

const BUTTON_VARIANTS: Record<CloudButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-transparent text-ink border border-rule-control hover:bg-hover',
  ghost: 'text-ink-muted hover:text-ink hover:bg-hover',
  danger: 'border border-danger text-danger hover:bg-danger/10',
}

const TONE_CLASSES: Record<CloudStatusTone, string> = {
  default: 'text-ink',
  muted: 'text-ink-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

const DOT_CLASSES: Record<CloudStatusTone, string> = {
  default: 'bg-ink',
  muted: 'bg-ink-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

const INPUT_BASE =
  'w-full bg-surface text-ink border border-rule-control rounded-sm type-value ' +
  'placeholder:text-ink-subtle transition-colors ' +
  'focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed'

type TextProps = React.HTMLAttributes<HTMLSpanElement>

export const Label: React.FC<TextProps> = ({ className = '', ...rest }) => (
  <span className={`type-label ${className}`} {...rest} />
)

export const Value: React.FC<TextProps> = ({ className = '', ...rest }) => (
  <span className={`type-value ${className}`} {...rest} />
)

export const Caption: React.FC<TextProps> = ({ className = '', ...rest }) => (
  <span className={`type-caption ${className}`} {...rest} />
)

export const DataText: React.FC<TextProps> = ({ className = '', ...rest }) => (
  <span className={`type-data ${className}`} {...rest} />
)

export const Eyebrow: React.FC<TextProps> = ({ className = '', ...rest }) => (
  <span className={`type-eyebrow ${className}`} {...rest} />
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CloudButtonVariant
  size?: CloudControlSize
  icon?: LucideIcon
  loading?: boolean
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    {...rest}
  >
    {loading ? (
      <Loader2 size={size === 'sm' ? 12 : 14} className="animate-spin" />
    ) : Icon ? (
      <Icon size={size === 'sm' ? 12 : 14} />
    ) : null}
    {children}
  </button>
)

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  size?: CloudControlSize
  active?: boolean
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon: Icon, label, size = 'md', active = false, className = '', type = 'button', ...rest }, ref) => {
    const box = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
    const iconSize = size === 'sm' ? 13 : 15
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={`inline-flex ${box} items-center justify-center rounded-sm transition-colors ${
          active ? 'bg-active text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink'
        } disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        {...rest}
      >
        <Icon size={iconSize} />
      </button>
    )
  }
)
IconButton.displayName = 'CloudIconButton'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => (
    <input ref={ref} className={`${INPUT_BASE} h-8 px-2.5 ${className}`} {...rest} />
  )
)
Input.displayName = 'CloudInput'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className = '', ...rest }, ref) => (
  <textarea ref={ref} className={`${INPUT_BASE} resize-y px-2.5 py-2 ${className}`} {...rest} />
))
Textarea.displayName = 'CloudTextarea'

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className = '', ...rest }, ref) => (
  <select ref={ref} className={`${INPUT_BASE} h-8 px-2 ${className}`} {...rest} />
))
Select.displayName = 'CloudSelect'

export interface FieldProps {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
  className?: string
}

export const Field: React.FC<FieldProps> = ({ label, hint, htmlFor, children, className = '' }) => (
  <div className={`flex flex-col gap-1.5 ${className}`}>
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="type-label text-ink-muted">
        {label}
      </label>
      {hint && <span className="type-caption text-ink-muted">{hint}</span>}
    </div>
    {children}
  </div>
)

export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  compact?: boolean
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}) => (
  <div
    className={`flex flex-col items-center justify-center text-center ${
      compact ? 'gap-2 p-4' : 'gap-3 p-8'
    }`}
  >
    <Icon size={compact ? 16 : 20} className="text-ink-muted" />
    <div className="flex flex-col gap-1.5">
      <p className={`m-0 text-ink ${compact ? 'type-project' : 'type-subtitle'}`}>{title}</p>
      {description && (
        <p className={`m-0 max-w-xs ${compact ? 'type-body' : 'type-reading'} text-ink-muted`}>
          {description}
        </p>
      )}
    </div>
    {action}
  </div>
)

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
  closeLabel?: string
  zIndexClass?: string
}

const MODAL_SIZES = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeLabel = 'Close',
  zIndexClass = 'z-40',
}) => {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const previousFocus = document.activeElement as HTMLElement | null
    const raf = window.requestAnimationFrame(() => {
      const container = dialogRef.current
      if (!container) return
      if (!container.contains(document.activeElement)) {
        const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ;(first ?? container).focus()
      }
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div className={`fixed inset-0 ${zIndexClass} flex items-center justify-center p-6`}>
      <div className="absolute inset-0 bg-overlay/35" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[85vh] w-full ${MODAL_SIZES[size]} flex-col overflow-hidden border border-line bg-raised shadow-print focus:outline-none`}
      >
        {title && (
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-rule-divide px-5">
            <h2 id={titleId} className="m-0 type-subtitle text-ink">
              {title}
            </h2>
            <IconButton icon={X} label={closeLabel} onClick={onClose} size="sm" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-rule-divide px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export const Spinner: React.FC<{ size?: number; className?: string }> = ({
  size = 14,
  className = '',
}) => <Loader2 size={size} className={`animate-spin ${className}`} />

export const Card: React.FC<{
  children: React.ReactNode
  className?: string
  density?: 'default' | 'compact'
}> = ({ children, className = '', density = 'default' }) => (
  <div
    className={`rounded border border-rule-hairline bg-raised ${
      density === 'compact' ? 'p-3' : 'p-4'
    } ${className}`}
  >
    {children}
  </div>
)

export const CardHeader: React.FC<{
  title: React.ReactNode
  status?: React.ReactNode
  action?: React.ReactNode
  className?: string
}> = ({ title, status, action, className = '' }) => (
  <div
    className={`flex items-center justify-between gap-3 border-b border-rule-divide pb-2 ${className}`}
  >
    <Label className="text-ink">{title}</Label>
    {status ?? action}
  </div>
)

export const StatusText: React.FC<{
  tone?: CloudStatusTone
  dot?: boolean
  children: React.ReactNode
  className?: string
}> = ({ tone = 'muted', dot = false, children, className = '' }) => (
  <span className={`inline-flex items-center gap-1.5 type-label ${TONE_CLASSES[tone]} ${className}`}>
    {dot && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />}
    {children}
  </span>
)

export const Tab: React.FC<{
  active: boolean
  label: React.ReactNode
  onSelect: () => void
  size?: 'sm' | 'md'
  className?: string
}> = ({ active, label, onSelect, size = 'md', className = '' }) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onSelect}
    className={`relative flex flex-shrink-0 items-center whitespace-nowrap border-b-2 transition-colors ${
      size === 'sm' ? 'px-2.5 py-1.5 type-caption' : 'px-3 py-2 type-label'
    } ${
      active
        ? 'border-accent text-ink'
        : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
    } ${className}`}
  >
    {label}
  </button>
)
