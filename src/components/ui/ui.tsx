import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react'
import { Check, ChevronDown, Loader2, X, type LucideIcon } from 'lucide-react'
import { useHostDocument } from '../../panelHost/HostContext'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ControlSize = 'sm' | 'md'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium rounded-sm transition-colors select-none ' +
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
  iconClassName?: string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: Icon,
      label,
      variant = 'ghost',
      active = false,
      size = 'md',
      iconClassName,
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
      <Icon size={size === 'sm' ? 14 : 16} className={iconClassName} />
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
 * Anchored popover powered by Floating UI (`useFloating` + `offset` + `flip` + `shift` + `autoUpdate`).
 * The trigger and this popover live inside the same relatively-positioned wrapper, so the menu
 * anchors to its parent wrapper automatically without requiring callers to wire refs.
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
  const menuRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const {
    refs,
    floatingStyles,
    placement: resolvedPlacement,
  } = useFloating({
    open,
    placement: placement === 'up' ? 'top-start' : 'bottom-start',
    strategy: 'absolute',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip(), shift({ padding: 4 })],
  })
  const { setFloating, setReference } = refs

  const setMenuNode = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node
      setFloating(node)
      setReference(node?.parentElement ?? null)
    },
    [setFloating, setReference]
  )

  useEffect(() => {
    if (!open) return
    const doc = menuRef.current?.ownerDocument ?? document
    const activeEl = doc.activeElement
    // 跨拆窗 Realm 时 `instanceof HTMLElement` 永远为 false，改用能力判断以支持拆窗内焦点恢复
    const previousFocus =
      activeEl && typeof (activeEl as HTMLElement).focus === 'function'
        ? (activeEl as HTMLElement)
        : null
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
      onCloseRef.current()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        onCloseRef.current()
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
    // 捕获阶段监听：保证位于 Modal 内的 PopoverMenu 优先消费 Escape，不连带关掉外层弹窗
    doc.addEventListener('keydown', onKeyDown, true)

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
      doc.removeEventListener('keydown', onKeyDown, true)
      if (restoreFocus && previousFocus && doc.body.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [open, role])

  if (!open) return null

  return (
    <div
      ref={setMenuNode}
      role={role}
      aria-label={label}
      data-placement={resolvedPlacement}
      tabIndex={role === 'dialog' ? -1 : undefined}
      style={floatingStyles}
      className={`z-20 border border-line bg-raised shadow-print focus:outline-none ${className}`}
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
  /** 叠加在 DiffViewer / CommandPalette 之上的全局对话框需传更高层级（如 z-[60]） */
  zIndexClass?: string
}

const MODAL_SIZES = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
}

/** 按宿主文档维护模态栈：嵌套弹窗（如 Settings → UpdateDialog、DiffViewer → DialogHost）按 Esc 只关最顶层 */
const modalStacks = new WeakMap<Document, Array<symbol>>()
/** 栈顶变更订阅：让非栈顶 Modal 退让 Base UI 的 aria-hidden 标记，避免互相隐藏顶层弹窗 */
const modalStackListeners = new WeakMap<Document, Set<() => void>>()
/** 记录因打开模态框而被加上 inert 的 body 直接子节点，栈清空时精确恢复 */
const modalInertNodes = new WeakMap<Document, Set<Element>>()

function notifyModalStack(doc: Document): void {
  const listeners = modalStackListeners.get(doc)
  if (!listeners) return
  for (const listener of listeners) {
    listener()
  }
}

function subscribeModalStack(doc: Document, listener: () => void): () => void {
  let listeners = modalStackListeners.get(doc)
  if (!listeners) {
    listeners = new Set()
    modalStackListeners.set(doc, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function pushModalToken(doc: Document, token: symbol): void {
  const stack = modalStacks.get(doc) ?? []
  const wasEmpty = stack.length === 0
  stack.push(token)
  modalStacks.set(doc, stack)
  if (wasEmpty && doc.body) {
    const marked = new Set<Element>()
    for (const child of Array.from(doc.body.children)) {
      if (
        child.hasAttribute('data-modal-portal') ||
        child.hasAttribute('data-toast-portal') ||
        child.hasAttribute('inert')
      ) {
        continue
      }
      child.setAttribute('inert', '')
      marked.add(child)
    }
    modalInertNodes.set(doc, marked)
  }
  notifyModalStack(doc)
}

function removeModalToken(doc: Document, token: symbol): void {
  const stack = modalStacks.get(doc)
  if (!stack) return
  const index = stack.lastIndexOf(token)
  if (index >= 0) stack.splice(index, 1)
  if (stack.length === 0) {
    const marked = modalInertNodes.get(doc)
    if (marked) {
      for (const el of marked) {
        el.removeAttribute('inert')
      }
      marked.clear()
    }
  }
  notifyModalStack(doc)
}

function isTopModalToken(doc: Document, token: symbol): boolean {
  const stack = modalStacks.get(doc)
  return Boolean(stack && stack[stack.length - 1] === token)
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getVisibleFocusables(container: HTMLElement, doc: Document): HTMLElement[] {
  const view = doc.defaultView ?? window
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = view.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

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
  const hostDocument = useHostDocument()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const tokenRef = useRef<symbol | null>(null)
  const [isTopModal, setIsTopModal] = useState(true)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 维护宿主文档的模态栈与背景 inert：确保无论是嵌套还是同级挂载的多层 Modal，
  // 只有栈顶 Modal 开启 Base UI 模态隔离，按 Escape / 点遮罩只关闭最顶层，且关闭时同步恢复焦点。
  useLayoutEffect(() => {
    if (!open) {
      tokenRef.current = null
      setIsTopModal(true)
      return
    }
    const activeEl = hostDocument.activeElement
    const previousFocus =
      activeEl && typeof (activeEl as HTMLElement).focus === 'function'
        ? (activeEl as HTMLElement)
        : null
    const token = Symbol('modal')
    tokenRef.current = token
    const syncTop = () => setIsTopModal(isTopModalToken(hostDocument, token))
    const unsubscribe = subscribeModalStack(hostDocument, syncTop)
    pushModalToken(hostDocument, token)

    const raf = hostDocument.defaultView?.requestAnimationFrame(() => {
      const container = dialogRef.current
      if (!container) return
      if (!container.contains(hostDocument.activeElement)) {
        const first = getVisibleFocusables(container, hostDocument)[0]
        ;(first ?? container).focus()
      }
    })

    return () => {
      if (raf !== undefined) hostDocument.defaultView?.cancelAnimationFrame(raf)
      unsubscribe()
      removeModalToken(hostDocument, token)
      if (tokenRef.current === token) tokenRef.current = null
      if (previousFocus && hostDocument.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [open, hostDocument])

  return (
    <Dialog.Root
      open={open}
      modal={isTopModal}
      disablePointerDismissal={!isTopModal}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return
        if (eventDetails.reason === 'focus-out') {
          eventDetails.cancel()
          return
        }
        const token = tokenRef.current
        if (eventDetails.reason === 'escape-key') {
          const nativeEvent = eventDetails.event as KeyboardEvent | undefined
          if (nativeEvent?.defaultPrevented || !token || !isTopModalToken(hostDocument, token)) {
            eventDetails.cancel()
            if (!nativeEvent?.defaultPrevented) {
              eventDetails.allowPropagation()
            }
            return
          }
        } else if (eventDetails.reason === 'outside-press') {
          if (!token || !isTopModalToken(hostDocument, token)) {
            eventDetails.cancel()
            return
          }
        }
        onCloseRef.current()
      }}
    >
      <Dialog.Portal
        data-modal-portal="true"
        container={hostDocument.body ?? undefined}
      >
        <Dialog.Backdrop
          forceRender
          className={`fixed inset-0 ${zIndexClass} bg-overlay/35`}
        />
        <Dialog.Viewport
          className={`fixed inset-0 ${zIndexClass} flex items-center justify-center p-6`}
        >
          <Dialog.Popup
            ref={dialogRef}
            aria-modal="true"
            initialFocus={false}
            finalFocus={false}
            className={`relative flex max-h-[85vh] w-full ${MODAL_SIZES[size]} flex-col overflow-hidden border border-line bg-raised shadow-print focus:outline-none`}
          >
            {title && (
              <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-rule-divide px-5">
                <Dialog.Title className="m-0 type-subtitle text-ink">
                  {title}
                </Dialog.Title>
                <Dialog.Close
                  render={<IconButton icon={X} label={closeLabel} size="sm" />}
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            {footer && (
              <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-rule-divide px-5 py-3">
                {footer}
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const Spinner: React.FC<{ size?: number; className?: string }> = ({
  size = 14,
  className = '',
}) => <Loader2 size={size} className={`animate-spin ${className}`} />
