/**
 * 聊天底部状态栏（窄订阅 + React.memo）：
 * 权限模式、模型选择、思考深度、上下文环形仪表与手动压缩入口，
 * 内置宽度自适应 ResizeObserver（窄宽度自动收起 token 数字与权限文字）。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, Minimize2 } from 'lucide-react'
import { useChatStore } from '../../store/chatStore'
import { useI18nStore } from '../../store/i18nStore'
import {
  DEFAULT_SESSION_PERMISSION,
  THINKING_LABEL_KEYS,
  THINKING_LEVELS,
  formatTokenCount,
} from '../../utils/chatPanelShared'
import {
  SESSION_MODE_ICON,
  SESSION_MODE_ICON_CLASS,
  SESSION_MODE_LABEL_KEY,
  SESSION_MODE_ORDER,
} from '../../utils/sessionModePresentation'
import { CATEGORY_LABEL_KEYS } from './ApprovalCard'
import { Meter, RingMeter } from '../ui/patterns'
import { Caption, DataText, Label, MenuOption, PopoverMenu, Spinner, Value } from '../ui/ui'
import type { ModelCapabilityInfo, SessionMode } from '../../types/electron'
import type { ChatTranslate } from './chatTurnController'

export interface ChatStatusBarProps {
  activeKey: string | null
  activeSessionId: string
  initialized: boolean
  availableModels: string[]
  modelCapabilities: ModelCapabilityInfo[]
  selectedModelCapability: ModelCapabilityInfo | null
  modelCapabilityText: string | null
  onSessionModeChange: (mode: SessionMode) => void
  onResetPermissionGrants: () => void
  onModelChange: (modelId: string) => void | Promise<void>
  onThinkingChange: (level: string) => void | Promise<void>
  onCompact: () => void | Promise<void>
  t?: ChatTranslate
}

export const ChatStatusBar: React.FC<ChatStatusBarProps> = React.memo(function ChatStatusBar({
  activeKey,
  activeSessionId,
  initialized,
  availableModels,
  modelCapabilities,
  selectedModelCapability,
  modelCapabilityText,
  onSessionModeChange,
  onResetPermissionGrants,
  onModelChange,
  onThinkingChange,
  onCompact,
  t: tProp,
}) {
  const { t: storeT, language } = useI18nStore(
    useShallow((state) => ({ t: state.t, language: state.language }))
  )
  const t = tProp ?? storeT

  const { sessionSettings, contextUsage, sessionStats, isLoading, isCompacting } = useChatStore(
    useShallow((state) => {
      const conv = activeKey ? state.conversations[activeKey] : undefined
      return {
        sessionSettings: conv?.sessionSettings ?? null,
        contextUsage: conv?.contextUsage ?? null,
        sessionStats: conv?.sessionStats ?? null,
        isLoading: conv?.isLoading ?? false,
        isCompacting: conv?.isCompacting ?? false,
      }
    })
  )

  const [statusMenu, setStatusMenu] = useState<
    'permission' | 'model' | 'thinking' | 'context' | null
  >(null)
  const closeStatusMenu = useCallback(() => setStatusMenu(null), [])

  const statusStripRef = useRef<HTMLDivElement>(null)
  const contextTokensRef = useRef<HTMLSpanElement>(null)
  const contextTokensWidthRef = useRef(0)
  const [showContextTokens, setShowContextTokens] = useState(true)
  const permissionLabelRef = useRef<HTMLSpanElement>(null)
  const permissionLabelWidthRef = useRef(0)
  const [showPermissionLabel, setShowPermissionLabel] = useState(true)

  useEffect(() => {
    setStatusMenu(null)
  }, [activeSessionId])

  const sessionPermission = sessionSettings?.permission ?? DEFAULT_SESSION_PERMISSION
  const SessionModeIcon = SESSION_MODE_ICON[sessionPermission.mode]

  const contextPercent = contextUsage?.percent ?? null
  const contextPercentRounded = contextPercent == null ? null : Math.round(contextPercent)
  const autoCompactAt = contextUsage?.autoCompactPercent ?? 85
  const contextTone: 'accent' | 'warning' | 'danger' =
    contextPercent == null
      ? 'accent'
      : contextPercent >= autoCompactAt
        ? 'danger'
        : contextPercent >= Math.max(0, autoCompactAt - 10)
          ? 'warning'
          : 'accent'
  const contextTokensText = contextUsage
    ? `${
        contextUsage.tokens != null ? formatTokenCount(contextUsage.tokens) : '—'
      } / ${formatTokenCount(contextUsage.contextWindow)}`
    : '—'
  const contextRemaining =
    contextUsage && contextUsage.tokens != null
      ? Math.max(0, contextUsage.contextWindow - contextUsage.tokens)
      : null

  /** 文案或档位变化后重新测量，避免沿用旧宽度一直把文字收着 */
  useEffect(() => {
    permissionLabelWidthRef.current = 0
    setShowPermissionLabel(true)
  }, [language, sessionPermission.mode])

  /**
   * 状态行 token 数字与权限文字自适应：放不下先收起 token 数字，再把权限档位文字收成图标。
   */
  useLayoutEffect(() => {
    const strip = statusStripRef.current
    if (!strip) return
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0
      const children = Array.from(strip.children) as HTMLElement[]
      let needed = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
      if (children.length > 1) needed += gap * (children.length - 1)

      if (showPermissionLabel) {
        const label = permissionLabelRef.current
        if (label) {
          const parent = label.parentElement
          const parentGap = parent
            ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0
            : 0
          permissionLabelWidthRef.current = label.getBoundingClientRect().width + parentGap
        }
      }

      if (showContextTokens) {
        const tokens = contextTokensRef.current
        if (tokens) {
          const parent = tokens.parentElement
          const parentGap = parent
            ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0
            : 0
          contextTokensWidthRef.current = tokens.getBoundingClientRect().width + parentGap
        }
      }

      if (needed > strip.clientWidth + 0.5) {
        if (showContextTokens) setShowContextTokens(false)
        else if (showPermissionLabel) setShowPermissionLabel(false)
        return
      }

      if (
        !showPermissionLabel &&
        permissionLabelWidthRef.current > 0 &&
        needed + permissionLabelWidthRef.current <= strip.clientWidth
      ) {
        setShowPermissionLabel(true)
        return
      }

      if (
        !showContextTokens &&
        contextTokensWidthRef.current > 0 &&
        needed + contextTokensWidthRef.current <= strip.clientWidth
      ) {
        setShowContextTokens(true)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [
    showContextTokens,
    showPermissionLabel,
    sessionSettings,
    contextUsage,
    contextPercentRounded,
    language,
    sessionPermission.mode,
  ])

  if (!sessionSettings && !contextUsage) return null

  return (
    <div
      ref={statusStripRef}
      data-testid="chat-status-bar"
      className="mt-1 flex min-w-0 items-center gap-1 whitespace-nowrap"
    >
      {sessionSettings && (
        <span className="relative flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={statusMenu === 'permission'}
            aria-label={t('sessionModeLabel')}
            disabled={!initialized || isLoading}
            title={
              showPermissionLabel
                ? undefined
                : t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])
            }
            onClick={() =>
              setStatusMenu((current) => (current === 'permission' ? null : 'permission'))
            }
            className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              statusMenu === 'permission'
                ? 'bg-hover text-ink'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <SessionModeIcon
              size={12}
              className={SESSION_MODE_ICON_CLASS[sessionPermission.mode]}
              aria-hidden="true"
            />
            {showPermissionLabel && (
              <span ref={permissionLabelRef} className="type-caption">
                {t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])}
              </span>
            )}
            <ChevronDown
              size={10}
              aria-hidden="true"
              className={`transition-transform ${
                statusMenu === 'permission' ? 'rotate-180' : ''
              }`}
            />
          </button>
          <PopoverMenu
            open={statusMenu === 'permission'}
            onClose={closeStatusMenu}
            label={t('sessionModeLabel')}
            className="w-44 py-1"
          >
            {SESSION_MODE_ORDER.map((mode) => {
              const ModeIcon = SESSION_MODE_ICON[mode]
              return (
                <MenuOption
                  key={mode}
                  selected={mode === sessionPermission.mode}
                  onSelect={() => {
                    closeStatusMenu()
                    onSessionModeChange(mode)
                  }}
                >
                  <span className="flex items-center gap-2">
                    <ModeIcon
                      size={14}
                      className={SESSION_MODE_ICON_CLASS[mode]}
                      aria-hidden="true"
                    />
                    <span>{t(SESSION_MODE_LABEL_KEY[mode])}</span>
                  </span>
                </MenuOption>
              )
            })}
            {sessionPermission.grants.length > 0 && (
              <>
                <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                  <span className="block type-caption text-ink-muted">
                    {t('permissionGrants', {
                      categories: sessionPermission.grants
                        .map((category) => t(CATEGORY_LABEL_KEYS[category]))
                        .join(t('listSeparator')),
                    })}
                  </span>
                </div>
                <MenuOption
                  onSelect={() => {
                    closeStatusMenu()
                    onResetPermissionGrants()
                  }}
                >
                  {t('permissionResetGrants')}
                </MenuOption>
              </>
            )}
          </PopoverMenu>
        </span>
      )}

      {sessionSettings && (
        <span className="text-ink-subtle" aria-hidden="true">
          ·
        </span>
      )}

      {sessionSettings && (
        <span className="relative flex min-w-24 items-center">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={statusMenu === 'model'}
            aria-label={t('modelLabel')}
            disabled={isLoading}
            onClick={() => setStatusMenu((current) => (current === 'model' ? null : 'model'))}
            className={`flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              statusMenu === 'model'
                ? 'bg-hover text-ink'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <span className="max-w-28 truncate type-data text-ink">
              {sessionSettings.modelId ?? '—'}
            </span>
            <ChevronDown
              size={10}
              aria-hidden="true"
              className={`transition-transform ${statusMenu === 'model' ? 'rotate-180' : ''}`}
            />
          </button>
          <PopoverMenu
            open={statusMenu === 'model'}
            onClose={closeStatusMenu}
            label={t('modelLabel')}
            className="w-56 py-1"
          >
            {availableModels.length === 0 && sessionSettings.modelId && (
              <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                {sessionSettings.modelId}
              </MenuOption>
            )}
            {availableModels.length > 0 &&
              sessionSettings.modelId &&
              !availableModels.includes(sessionSettings.modelId) && (
                <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                  {sessionSettings.modelId}
                </MenuOption>
              )}
            {availableModels.map((model) => {
              const capability = modelCapabilities.find((item) => item.id === model)
              const unavailable = capability?.available === false
              return (
                <MenuOption
                  key={model}
                  variant="data"
                  selected={model === sessionSettings.modelId}
                  disabled={unavailable}
                  meta={unavailable ? t('modelUnavailable') : undefined}
                  title={unavailable ? t('modelUnavailableHint') : undefined}
                  onSelect={() => {
                    closeStatusMenu()
                    void onModelChange(model)
                  }}
                >
                  {model}
                </MenuOption>
              )
            })}
            {modelCapabilityText && (
              <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                <Caption className="block text-ink-muted">{modelCapabilityText}</Caption>
              </div>
            )}
          </PopoverMenu>
        </span>
      )}

      {sessionSettings && (
        <span className="text-ink-subtle" aria-hidden="true">
          ·
        </span>
      )}

      {sessionSettings && (
        <span className="relative flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={statusMenu === 'thinking'}
            aria-label={t('thinkingLabel')}
            disabled={isLoading || selectedModelCapability?.reasoning === false}
            title={
              selectedModelCapability?.reasoning === false
                ? t('modelThinkingUnavailable')
                : undefined
            }
            onClick={() =>
              setStatusMenu((current) => (current === 'thinking' ? null : 'thinking'))
            }
            className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              statusMenu === 'thinking'
                ? 'bg-hover text-ink'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <span className="type-caption">
              {t('thinkingLabel')}{' '}
              {t(
                THINKING_LABEL_KEYS[
                  (sessionSettings.thinkingLevel ?? 'medium') as (typeof THINKING_LEVELS)[number]
                ] ?? 'thinkingMedium'
              )}
            </span>
            <ChevronDown
              size={10}
              aria-hidden="true"
              className={`transition-transform ${statusMenu === 'thinking' ? 'rotate-180' : ''}`}
            />
          </button>
          <PopoverMenu
            open={statusMenu === 'thinking'}
            onClose={closeStatusMenu}
            label={t('thinkingLabel')}
            className="w-36 py-1"
          >
            {THINKING_LEVELS.map((level) => {
              const supported =
                !selectedModelCapability ||
                selectedModelCapability.thinkingLevels.length === 0 ||
                selectedModelCapability.thinkingLevels.includes(level)
              return (
                <MenuOption
                  key={level}
                  selected={level === (sessionSettings.thinkingLevel ?? 'medium')}
                  disabled={!supported}
                  meta={<span className="type-data">{level}</span>}
                  onSelect={() => {
                    closeStatusMenu()
                    void onThinkingChange(level)
                  }}
                >
                  {t(THINKING_LABEL_KEYS[level])}
                </MenuOption>
              )
            })}
          </PopoverMenu>
        </span>
      )}

      {sessionSettings && contextUsage && (
        <span className="text-ink-subtle" aria-hidden="true">
          ·
        </span>
      )}

      {contextUsage && (
        <span className="relative flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={statusMenu === 'context'}
            aria-label={t('contextUsageLabel')}
            onClick={() => setStatusMenu((current) => (current === 'context' ? null : 'context'))}
            className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors ${
              statusMenu === 'context'
                ? 'bg-hover text-ink'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <RingMeter
              value={contextPercent}
              size={14}
              strokeWidth={2}
              tone={contextTone}
              label={t('contextUsageLabel')}
            />
            <span
              className={`type-data ${
                contextPercent != null && contextPercent >= 95
                  ? 'text-danger'
                  : contextPercent != null && contextPercent >= 80
                    ? 'text-warning'
                    : 'text-ink'
              }`}
            >
              {contextPercentRounded != null ? `${contextPercentRounded}%` : '—'}
            </span>
            {showContextTokens && (
              <span ref={contextTokensRef} className="flex-shrink-0 type-data text-ink-muted">
                {contextTokensText} tok
              </span>
            )}
            <ChevronDown
              size={10}
              aria-hidden="true"
              className={`transition-transform ${statusMenu === 'context' ? 'rotate-180' : ''}`}
            />
          </button>
          <PopoverMenu
            open={statusMenu === 'context'}
            onClose={closeStatusMenu}
            role="dialog"
            label={t('contextUsageLabel')}
            className="w-64"
          >
            <div className="px-3 pb-2 pt-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label className="text-ink">{t('contextUsageLabel')}</Label>
                <Caption className="text-ink-muted">{t('contextScope')}</Caption>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <Value className="text-ink">
                  {contextPercentRounded != null
                    ? t('contextUsed', { percent: contextPercentRounded })
                    : '—'}
                </Value>
                <DataText className="text-ink-muted">{contextTokensText} tok</DataText>
              </div>
              <Meter
                value={contextPercent ?? 0}
                label={t('contextUsageLabel')}
                tone={contextTone}
                className="mt-2"
              />
              <div className="mt-2.5 flex gap-6 border-t border-rule-divide pt-2.5">
                <div className="flex flex-col gap-0.5">
                  <Caption className="text-ink-muted">{t('contextRemaining')}</Caption>
                  <DataText className="text-ink">
                    {contextRemaining != null ? `${formatTokenCount(contextRemaining)} tok` : '—'}
                  </DataText>
                </div>
                <div className="flex flex-col gap-0.5">
                  <Caption className="text-ink-muted">{t('contextSessionTotal')}</Caption>
                  <DataText className="text-ink">
                    {sessionStats
                      ? `${formatTokenCount(sessionStats.tokens)} tok${
                          sessionStats.cost > 0 ? ` · $${sessionStats.cost.toFixed(2)}` : ''
                        }`
                      : '—'}
                  </DataText>
                </div>
              </div>
              {contextUsage.autoCompactPercent != null && (
                <Caption className="mt-2 block text-ink-muted">
                  {t('contextAutoCompactHint', {
                    percent: contextUsage.autoCompactPercent,
                  })}
                </Caption>
              )}
              {contextUsage.tokens == null && (
                <Caption className="mt-2 block text-ink-muted">{t('contextUnknownHint')}</Caption>
              )}
            </div>
            <button
              type="button"
              disabled={isLoading || isCompacting}
              onClick={() => {
                closeStatusMenu()
                void onCompact()
              }}
              className="flex w-full items-center gap-2 border-t border-rule-divide px-3 py-2 text-left type-value text-ink transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCompacting ? (
                <Spinner size={12} />
              ) : (
                <Minimize2
                  size={13}
                  aria-hidden="true"
                  className="flex-shrink-0 text-ink-muted"
                />
              )}
              {isCompacting ? t('compactingContext') : t('compactContext')}
            </button>
          </PopoverMenu>
        </span>
      )}
    </div>
  )
})
