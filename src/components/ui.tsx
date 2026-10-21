import React, { useEffect } from 'react'
import { ChevronDown, Loader2, X, type LucideIcon } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ControlSize = 'sm' | 'md'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-sm transition-colors select-none ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

const BUTTON_SIZES: Record<ControlSize, string> = {
  sm: 'h-7 px-2.5 type-label',
  md: 'h-8 px-3 type-label',
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-transparent text-ink border border-rule-control hover:bg-hover',
  ghost: 'text-ink-muted hover:text-ink hover:bg-hover',
  danger: 'border border-danger text-danger hover:bg-danger/10',
}

type TextPrimitiveProps = React.HTMLAttributes<HTMLSpanElement>

export const Label: React.FC<TextPrimitiveProps> = ({ className = '', ...rest }) => (
  <span className={`type-label ${className}`} {...rest} />
)

export const Value: React.FC<TextPrimitiveProps> = ({ className = '', ...rest }) => (
  <span className={`type-value ${className}`} {...rest} />
)

export const Caption: React.FC<TextPrimitiveProps> = ({ className = '', ...rest }) => (
  <span className={`type-caption ${className}`} {...rest} />
)

export const DataText: React.FC<TextPrimitiveProps> = ({ className = '', ...rest }) => (
  <span className={`type-data ${className}`} {...rest} />
)

export const Eyebrow: React.FC<TextPrimitiveProps> = ({ className = '', ...rest }) => (
  <span className={`type-eyebrow ${className}`} {...rest} />
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ControlSize
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
  ...rest
}) => (
  <button
    type="button"
    className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    disabled={disabled || loading}
    {...rest}
  >
    {loading ? (
      <Loader2 size={size === 'sm' ? 13 : 14} className="animate-spin" />
    ) : (
      Icon && <Icon size={size === 'sm' ? 13 : 14} />
    )}
    {children}
  </button>
)

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  variant?: 'ghost' | 'secondary'
  active?: boolean
  size?: ControlSize
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  label,
  variant = 'ghost',
  active = false,
  size = 'md',
  className = '',
  ...rest
}) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active || undefined}
    title={label}
    className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${
      active
        ? 'bg-active text-ink'
        : variant === 'secondary'
          ? BUTTON_VARIANTS.secondary
          : BUTTON_VARIANTS.ghost
    } ${className}`}
    {...rest}
  >
    <Icon size={size === 'sm' ? 14 : 16} />
  </button>
)

const CONTROL_BASE =
  'w-full rounded-sm bg-sunken border border-rule-control text-ink type-body ' +
  'placeholder:text-ink-muted transition-colors focus:outline-none ' +
  'focus:border-accent ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => (
    <input ref={ref} className={`${CONTROL_BASE} h-8 px-2.5 ${className}`} {...rest} />
  )
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className = '', ...rest }, ref) => (
  <textarea ref={ref} className={`${CONTROL_BASE} px-2.5 py-1.5 resize-none ${className}`} {...rest} />
))
Textarea.displayName = 'Textarea'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

export const Select: React.FC<SelectProps> = ({ className = '', children, ...rest }) => (
  <div className="relative">
    <select
      className={`${CONTROL_BASE} h-8 pl-2.5 pr-8 appearance-none cursor-pointer ${className}`}
      {...rest}
    >
      {children}
    </select>
    <ChevronDown
      size={14}
      aria-hidden="true"
      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted"
    />
  </div>
)

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
      <label
        htmlFor={htmlFor}
        className="type-label text-ink-muted"
      >
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
      <p
        className={`m-0 text-ink ${
          compact ? 'type-project' : 'type-subtitle'
        }`}
      >
        {title}
      </p>
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
}

const MODAL_SIZES = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeLabel = 'Close',
}) => {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-overlay/35" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative flex max-h-[85vh] w-full ${MODAL_SIZES[size]} flex-col overflow-hidden border border-line bg-raised shadow-print`}
      >
        {title && (
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-rule-divide px-5">
            <h2 className="m-0 type-subtitle text-ink">{title}</h2>
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
