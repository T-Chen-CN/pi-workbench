/**
 * 会话级模型、思考深度、权限模式、上下文压缩、统计预算与会话元数据（置顶/归档/导出）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { useChatStore, conversationKey, type SessionSettings } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import { localizeError } from '../i18n/errors'
import type {
  ExportSessionFormat,
  ModelCapabilityInfo,
  SessionMeta,
  SessionMode,
  SessionPermission,
  SessionSummary,
} from '../types/electron'
import { DEFAULT_SESSION_PERMISSION, formatTokenCount } from '../utils/chatPanelShared'
import type { useI18nStore } from '../store/i18nStore'

export interface UseChatSessionConfigParams {
  workspacePath: string
  activeSessionId: string | null
  activeKey: string | null
  initialized: boolean
  isLoading: boolean
  configVersion: number
  sessionSettings: SessionSettings | null
  configuredImageModels: string[]
  language: 'zh' | 'en'
  t: ReturnType<typeof useI18nStore.getState>['t']
}

export function useChatSessionConfig(params: UseChatSessionConfigParams) {
  const {
    workspacePath,
    activeSessionId,
    activeKey,
    initialized,
    isLoading,
    configVersion,
    sessionSettings,
    configuredImageModels,
    language,
    t,
  } = params

  const [availableModels, setAvailableModels] = useState<string[]>([])
  /** 模型能力提示（R-06） */
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilityInfo[]>([])
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({ pinned: [], archived: [] })
  const budgetWarnedKeysRef = useRef(new Set<string>())

  const selectedModelCapability =
    modelCapabilities.find((item) => item.id === sessionSettings?.modelId) ?? null
  const imagesAllowed = selectedModelCapability
    ? selectedModelCapability.vision
    : Boolean(
        sessionSettings?.modelId && configuredImageModels.includes(sessionSettings.modelId)
      )

  /** 模型菜单底部的能力脚注 */
  const modelCapabilityText = selectedModelCapability
    ? selectedModelCapability.available === false
      ? t('modelUnavailableHint')
      : [
          t('modelContextWindow', {
            tokens: formatTokenCount(selectedModelCapability.contextWindow),
          }),
          selectedModelCapability.reasoning ? t('modelSupportsThinking') : t('modelNoThinking'),
          selectedModelCapability.vision ? t('modelSupportsVision') : t('modelNoVision'),
        ]
          .filter(Boolean)
          .join(' · ')
    : null

  /** 读取上下文占用（每轮结束与会话切换后刷新） */
  const refreshContextUsage = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getContextUsage(workspacePath, sessionId)
      if (result.success) {
        useChatStore.getState().setContextUsage(key, result.usage ?? null)
      }
    },
    [workspacePath]
  )

  /** 读取会话级模型与思考级别 */
  const refreshSessionSettings = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getSessionSettings(workspacePath, sessionId)
      if (result.success) {
        useChatStore.getState().setSessionSettings(key, {
          modelId: result.modelId,
          thinkingLevel: result.thinkingLevel,
          permission: result.permission,
        })
      }
    },
    [workspacePath]
  )

  /** 读取会话累计用量并检查预算 */
  const refreshSessionStats = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getSessionStats(workspacePath, sessionId)
      if (!result.success || !result.stats) return
      useChatStore.getState().setSessionStats(key, result.stats)
      const budget = useSettingsStore.getState().budgetUsd
      if (budget > 0 && result.stats.cost >= budget && !budgetWarnedKeysRef.current.has(key)) {
        budgetWarnedKeysRef.current.add(key)
        toast.warning(
          t('budgetExceeded', {
            cost: result.stats.cost.toFixed(2),
            budget: budget.toFixed(2),
          })
        )
      }
    },
    [workspacePath, t]
  )

  useEffect(() => {
    if (!initialized || !activeSessionId) return
    void refreshContextUsage(activeSessionId)
    void refreshSessionSettings(activeSessionId)
    void refreshSessionStats(activeSessionId)
  }, [
    initialized,
    activeSessionId,
    configVersion,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
  ])

  useEffect(() => {
    let cancelled = false
    void api.providersList().then((result) => {
      if (cancelled || !result.success) return
      const active = result.providers?.find((provider) => provider.active)
      setAvailableModels((active?.models ?? []).map((model) => model.id))
    })
    return () => {
      cancelled = true
    }
  }, [configVersion])

  useEffect(() => {
    if (!initialized) return
    let cancelled = false
    void piAgentAPI.getModelCapabilities(workspacePath).then((result) => {
      if (cancelled) return
      if (result.success && result.models) setModelCapabilities(result.models)
      // 会话记录的模型已不在当前供应商目录里：主进程已静默回落，
      // 这里把 chat store 对齐到实际生效的模型，避免头部显示一个用不了的 id（D22）
      const selected = result.selected
      if (!result.success || !selected || !activeKey) return
      const current = useChatStore.getState().conversations[activeKey]?.sessionSettings
      if (current?.modelId && current.modelId !== selected) {
        useChatStore.getState().setSessionSettings(activeKey, { ...current, modelId: selected })
      }
    })
    return () => {
      cancelled = true
    }
  }, [initialized, workspacePath, configVersion, activeKey])

  const handleModelChange = async (modelId: string) => {
    if (!activeSessionId || !activeKey || !modelId || isLoading) return
    const prevModelId = useChatStore.getState().conversations[activeKey]?.sessionSettings?.modelId
    useChatStore.getState().setSessionSettings(activeKey, {
      ...(useChatStore.getState().conversations[activeKey]?.sessionSettings ?? {}),
      modelId,
    })
    const result = await piAgentAPI.setSessionModel(workspacePath, activeSessionId, modelId)
    if (!result.success) {
      const latest = useChatStore.getState().conversations[activeKey]?.sessionSettings ?? null
      if (latest) {
        useChatStore.getState().setSessionSettings(activeKey, { ...latest, modelId: prevModelId })
      }
      toast.error(t('modelSwitchFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    void refreshContextUsage(activeSessionId)
  }

  const handleThinkingChange = async (level: string) => {
    if (!activeSessionId || !activeKey || !level || isLoading) return
    if (selectedModelCapability?.reasoning === false) {
      toast.error(t('modelThinkingUnavailable'))
      return
    }
    const prevLevel =
      useChatStore.getState().conversations[activeKey]?.sessionSettings?.thinkingLevel
    useChatStore.getState().setSessionSettings(activeKey, {
      ...(useChatStore.getState().conversations[activeKey]?.sessionSettings ?? {}),
      thinkingLevel: level,
    })
    const result = await piAgentAPI.setSessionThinking(workspacePath, activeSessionId, level)
    if (!result.success) {
      const latest = useChatStore.getState().conversations[activeKey]?.sessionSettings ?? null
      if (latest) {
        useChatStore
          .getState()
          .setSessionSettings(activeKey, { ...latest, thinkingLevel: prevLevel })
      }
      toast.error(t('thinkingSwitchFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** 修改会话模式：模式或额外授权，成功后同步状态行 */
  const applySessionPermission = async (next: SessionPermission): Promise<boolean> => {
    const sessionId = activeSessionId
    const key = activeKey
    if (!sessionId || !key) return false
    const prevPermission = useChatStore.getState().conversations[key]?.sessionSettings?.permission
    useChatStore.getState().setSessionSettings(key, {
      ...(useChatStore.getState().conversations[key]?.sessionSettings ?? {}),
      permission: next,
    })
    const result = await piAgentAPI.setSessionPermission(workspacePath, sessionId, next)
    if (!result.success || !result.permission) {
      const latest = useChatStore.getState().conversations[key]?.sessionSettings ?? null
      if (latest) {
        useChatStore
          .getState()
          .setSessionSettings(key, { ...latest, permission: prevPermission })
      }
      toast.error(t('permissionSetFailed', { error: localizeError(result.error ?? '') }))
      return false
    }
    useChatStore.getState().setSessionSettings(key, {
      ...(useChatStore.getState().conversations[key]?.sessionSettings ?? {}),
      permission: result.permission,
    })
    return true
  }

  /** 切换模式会清空本会话的额外授权（后端同样会归一化） */
  const handleSessionModeChange = (nextMode: SessionMode) => {
    if (isLoading) return
    void applySessionPermission({ mode: nextMode, grants: [] })
  }

  const handleResetPermissionGrants = () => {
    const permission = sessionSettings?.permission ?? DEFAULT_SESSION_PERMISSION
    void applySessionPermission({ mode: permission.mode, grants: [] })
  }

  /** 手动压缩上下文；运行中或已在压缩中不允许重复触发 */
  const handleCompact = async () => {
    const sessionId = activeSessionId
    if (!sessionId || isLoading) return
    const key = conversationKey(workspacePath, sessionId)
    if (useChatStore.getState().conversations[key]?.isCompacting) return
    const confirmed = await confirmDialog({ message: t('compactConfirm') })
    if (!confirmed) return
    const current = useChatStore.getState().conversations[key]
    if (current?.isLoading || current?.isCompacting) return
    useChatStore.getState().ensureConversation(key)
    useChatStore.getState().setCompacting(key, true)
    try {
      const result = await piAgentAPI.compactContext(workspacePath, sessionId)
      if (result.success) {
        useChatStore.getState().appendCompactionPart(
          key,
          {
            type: 'compaction',
            id: `compaction-${result.entryId ?? result.timestamp ?? Date.now()}`,
            entryId: result.entryId,
            timestamp: result.timestamp ?? Date.now(),
            tokensBefore: result.tokensBefore,
          },
          { beforePendingTurn: true }
        )
        toast.info(t('compactDone'))
        void refreshContextUsage(sessionId)
      } else {
        toast.error(t('compactFailed', { error: localizeError(result.error ?? '') }))
      }
    } finally {
      useChatStore.getState().setCompacting(key, false)
    }
  }

  /** 会话置顶 / 归档元数据 */
  useEffect(() => {
    let cancelled = false
    if (typeof api.getSessionMeta !== 'function') return
    void api.getSessionMeta(workspacePath).then((result) => {
      if (cancelled || !result.success || !result.meta) return
      setSessionMeta(result.meta)
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath, configVersion])

  const persistSessionMeta = async (next: SessionMeta) => {
    setSessionMeta(next)
    if (typeof api.setSessionMeta !== 'function') return
    const result = await api.setSessionMeta(workspacePath, next)
    if (!result.success) {
      const detail = 'error' in result && typeof result.error === 'string' ? result.error : ''
      toast.error(t('sessionMetaFailed', { error: localizeError(detail) }))
    }
  }

  const togglePin = (session: SessionSummary) => {
    const pinned = sessionMeta.pinned.includes(session.id)
      ? sessionMeta.pinned.filter((id) => id !== session.id)
      : [...sessionMeta.pinned, session.id]
    void persistSessionMeta({ ...sessionMeta, pinned })
  }

  const toggleArchive = (session: SessionSummary) => {
    const archived = sessionMeta.archived.includes(session.id)
      ? sessionMeta.archived.filter((id) => id !== session.id)
      : [...sessionMeta.archived, session.id]
    void persistSessionMeta({ ...sessionMeta, archived })
  }

  /** 导出会话（R-10）：Markdown / HTML / 原始 JSONL，由主进程写盘 */
  const exportSession = async (session: SessionSummary, format: ExportSessionFormat = 'md') => {
    const result = await piAgentAPI.exportSession(workspacePath, session.id, format, language)
    if (result.success && !result.canceled) {
      toast.info(t('exportDone'))
    } else if (!result.success) {
      toast.error(t('exportFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  return {
    availableModels,
    modelCapabilities,
    sessionMeta,
    selectedModelCapability,
    imagesAllowed,
    modelCapabilityText,
    budgetWarnedKeysRef,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
    handleModelChange,
    handleThinkingChange,
    applySessionPermission,
    handleSessionModeChange,
    handleResetPermissionGrants,
    handleCompact,
    togglePin,
    toggleArchive,
    exportSession,
  }
}
