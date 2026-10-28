import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, X, type LucideIcon } from 'lucide-react'
import { useHostDocument } from '../panelHost/HostContext'

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

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: Icon,
      label,
      variant = 'ghost',
      active = false,
      size = 'md',
      className = '',
      ...rest
    },
    ref
  ) => (
    <button
      ref={ref}
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
)
IconButton.displayName = 'IconButton'

/**
 * 浮在内容之上的图标按钮（编辑器右下角等）。
 *
 * 常态半透明：不遮挡太多正文，又能一直看见；要点击时靠 hover / focus 升为实心。
 * 底色只用 token 的不透明度变体（`bg-raised/90`），不使用 backdrop-filter。
 */
export interface OverlayButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon
  label: string
}

export const OverlayButton = React.forwardRef<HTMLButtonElement, OverlayButtonProps>(
  ({ icon: Icon, label, className = '', ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={
        'inline-flex h-7 w-7 items-center justify-center rounded-sm border border-rule-control ' +
        'bg-raised/90 text-ink-muted shadow-print transition-colors ' +
        'hover:border-line hover:bg-raised hover:text-ink ' +
        'focus-visible:border-line focus-visible:bg-raised focus-visible:text-ink ' +
        className
      }
      {...rest}
    >
      <Icon size={14} />
    </button>
  )
)

OverlayButton.displayName = 'OverlayButton'

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

export interface PopoverMenuProps {
  open: boolean
  onClose: () => void
  /** aria-label for the popover; also used to name the menu */
  label: string
  /** `menu` adds arrow-key navigation; `dialog` is a free-form panel */
  role?: 'menu' | 'dialog'
  /** 默认向上展开；位于面板顶部的触发器改为向下展开 */
  placement?: 'up' | 'down'
  className?: string
  children: React.ReactNode
}

/**
 * Anchored popover that opens away from its trigger. The trigger and this
 * popover live inside the same relatively-positioned wrapper, so the menu stays
 * next to the control it belongs to instead of floating elsewhere. The menu is
 * clamped inside the nearest clipping container so it never runs off a panel.
 */
export const PopoverMenu: React.FC<PopoverMenuProps> = ({
  open,
  onClose,
  label,
  role = 'menu',
  placement = 'up',
  className = '',
  children,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)
  /** Horizontal offset from the anchor; null until measured */
  const [offset, setOffset] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setOffset(null)
      return
    }
    const menu = menuRef.current
    const anchor = menu?.parentElement
    if (!menu || !anchor) return

    // 面板可能被拆到辅助窗口：测量、裁剪与监听都落在它自己的 document 上
    const doc = menu.ownerDocument
    const view = doc.defaultView
    const anchorRect = anchor.getBoundingClientRect()
    const width = menu.getBoundingClientRect().width

    let clipLeft = 0
    let clipRight = doc.documentElement.clientWidth
    let node: HTMLElement | null = anchor.parentElement
    while (node) {
      const style = (view ?? window).getComputedStyle(node)
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const rect = node.getBoundingClientRect()
        clipLeft = rect.left
        clipRight = rect.right
        break
      }
      node = node.parentElement
    }

    let left = anchorRect.left
    if (left + width > clipRight - 4) {
      left = Math.max(clipLeft + 4, anchorRect.right - width)
    }
    setOffset(left - anchorRect.left)
  }, [open, role, label])

  useEffect(() => {
    if (!open) return
    const doc = menuRef.current?.ownerDocument ?? document
    const previousFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null
    let restoreFocus = true

    const isMenu = role === 'menu'
    const items = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role^="menuitem"]:not([disabled])'
        ) ?? []
      )

    const onPointerDown = (event: MouseEvent) => {
      const menu = menuRef.current
      if (!menu) return
      const anchor = menu.parentElement
      const target = event.target as Node
      // Clicks on the trigger toggle the popover themselves.
      if (anchor && anchor.contains(target)) return
      restoreFocus = false
      onClose()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (!isMenu) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const entries = items()
      if (entries.length === 0) return
      event.preventDefault()
      const current = entries.indexOf(doc.activeElement as HTMLButtonElement)
      let next = 0
      if (event.key === 'End') next = entries.length - 1
      else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % entries.length
      else if (event.key === 'ArrowUp')
        next = current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length
      entries[next].focus()
    }

    doc.addEventListener('mousedown', onPointerDown)
    doc.addEventListener('keydown', onKeyDown)

    if (isMenu) {
      const checked = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role^="menuitem"][aria-checked="true"]:not([disabled])'
      )
      ;(checked ?? items()[0])?.focus()
    } else {
      menuRef.current?.focus()
    }

    return () => {
      doc.removeEventListener('mousedown', onPointerDown)
      doc.removeEventListener('keydown', onKeyDown)
      if (restoreFocus && previousFocus && doc.body.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [open, onClose, role])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      role={role}
      aria-label={label}
      tabIndex={role === 'dialog' ? -1 : undefined}
      style={{ left: offset ?? 0 }}
      className={`absolute z-20 border border-line bg-raised shadow-print focus:outline-none ${
        placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
      } ${className}`}
    >
      {children}
    </div>
  )
}

export interface MenuOptionProps {
  selected?: boolean
  disabled?: boolean
  onSelect: () => void
  /** `radio` 用于互斥选项，`checkbox` 用于独立开关 */
  role?: 'menuitemradio' | 'menuitemcheckbox'
  /** `data` renders the label in mono for ids and model names */
  variant?: 'value' | 'data'
  meta?: React.ReactNode
  title?: string
  children: React.ReactNode
}

export const MenuOption: React.FC<MenuOptionProps> = ({
  selected = false,
  disabled = false,
  onSelect,
  role = 'menuitemradio',
  variant = 'value',
  meta,
  title,
  children,
}) => (
  <button
    type="button"
    role={role}
    aria-checked={selected}
    disabled={disabled}
    title={title}
    onClick={onSelect}
    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span
      className={`min-w-0 flex-1 truncate text-ink ${
        variant === 'data' ? 'type-data' : 'type-value'
      }`}
    >
      {children}
    </span>
    {meta && <span className="type-caption flex-shrink-0 text-ink-muted">{meta}</span>}
    <Check
      size={12}
      aria-hidden="true"
      className={`flex-shrink-0 text-accent ${selected ? 'opacity-100' : 'opacity-0'}`}
    />
  </button>
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
  const hostDocument = useHostDocument()
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    hostDocument.addEventListener('keydown', onKeyDown)
    return () => hostDocument.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, hostDocument])

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
