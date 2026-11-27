import React, { useEffect, useRef, useState } from 'react'
import { translate, type Language } from '@pi-workbench/i18n'
import {
  Button,
  Card,
  CardHeader,
  CloudAuthorizationCard,
  CloudConfigForm,
  CloudConfirmDangerModal,
  CloudConfirmPlanModal,
  CloudDeviceList,
  CloudMemoryManager,
  CloudNoticeCard,
  CloudTaskCard,
  CloudUnitCard,
  TaskResultSection,
  getCloudTaskStatusLabel,
} from '@pi-workbench/cloud-ui'
import type {
  CloudAuthorizationRow,
  CloudDeviceRow,
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudNotice,
  CloudUnitRow,
  RequestResult,
  WebCatalogModel,
  WebCloudConfig,
  WebConfigDraft,
  WebPairCode,
  WebTaskItem,
} from './cloudWebClient'

export type WebRequestFn = <T = unknown>(
  method: string,
  path: string,
  body?: unknown
) => Promise<RequestResult<T>>
export type WebSendFn = (frame: Record<string, unknown>) => boolean
export type FeedbackTone = 'info' | 'error'

export const TaskCard: React.FC<{
  tasks: WebTaskItem[]
  devices: CloudDeviceRow[]
  stoppingTaskIds: Record<string, true>
  answerDrafts: Record<string, string>
  instructionDrafts: Record<string, string>
  compact?: boolean
  language?: Language
  onAnswerDraft: (taskId: string, value: string) => void
  onInstructionDraft: (taskId: string, value: string) => void
  onSendAnswer: (taskId: string, text: string) => void
  onSendInstruction: (taskId: string, text: string) => void
  onStopTask: (taskId: string) => void
}> = ({ compact = false, language = 'zh', ...rest }) => (
  <CloudTaskCard
    {...rest}
    compact={compact}
    showCount
    language={language}
    labels={{ statusLabel: (status) => getCloudTaskStatusLabel(status, language) }}
    renderResult={(task) => (
      <TaskResultSection
        taskId={task.id}
        summary={task.result?.summary ?? (task.status === 'done' ? task.lastMilestone : undefined)}
        changedFiles={task.changedFiles ?? task.result?.changedFiles ?? []}
        secretHits={task.secretHits ?? task.result?.secretHits ?? []}
        compact={compact}
        language={language}
      />
    )}
  />
)

export const UnitCard: React.FC<{
  units: CloudUnitRow[]
  language?: Language
  onCloseUnit: (unitId: string) => void
}> = ({ units, language = 'zh', onCloseUnit }) => (
  <CloudUnitCard units={units} language={language} onCloseUnit={onCloseUnit} />
)

export const DeviceCard: React.FC<{
  devices: CloudDeviceRow[]
  pairCode: WebPairCode | null
  language?: Language
  onGeneratePairCode: () => Promise<void>
  onRemoveDevice: (deviceId: string) => Promise<void>
}> = ({ devices, pairCode, language = 'zh', onGeneratePairCode, onRemoveDevice }) => (
  <CloudDeviceList
    devices={devices}
    pairCode={pairCode}
    language={language}
    showCount
    showDetails
    onlineTone="success"
    onGeneratePairCode={onGeneratePairCode}
    onRemoveDevice={onRemoveDevice}
  />
)

export const AuthCard: React.FC<{
  authorizations: CloudAuthorizationRow[]
  language?: Language
  onRevoke: (id: string) => Promise<void>
}> = ({ authorizations, language = 'zh', onRevoke }) => {
  const [pendingRevoke, setPendingRevoke] = useState<CloudAuthorizationRow | null>(null)
  const [revoking, setRevoking] = useState(false)

  return (
    <>
      <CloudAuthorizationCard
        authorizations={authorizations}
        language={language}
        onRevoke={(id) => {
          const found = authorizations.find((item) => item.id === id)
          if (found) setPendingRevoke(found)
        }}
      />
      <CloudConfirmDangerModal
        open={Boolean(pendingRevoke)}
        language={language}
        title={translate(language, 'cloudWebRevokeAuthTitle')}
        description={
          pendingRevoke
            ? translate(language, 'cloudWebRevokeAuthConfirm', {
                used: pendingRevoke.used,
                quota: pendingRevoke.quota,
              })
            : ''
        }
        confirmLabel={translate(language, 'cloudWebRevokeAuthConfirmAction')}
        busy={revoking}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={async () => {
          if (!pendingRevoke || revoking) return
          setRevoking(true)
          try {
            await onRevoke(pendingRevoke.id)
            setPendingRevoke(null)
          } finally {
            setRevoking(false)
          }
        }}
      />
    </>
  )
}

export const NoticeCard: React.FC<{ notices: CloudNotice[]; language?: Language }> = ({
  notices,
  language = 'zh',
}) => <CloudNoticeCard notices={notices} withSeconds language={language} />

export const ConfigCard: React.FC<{
  config: WebCloudConfig | null
  draft: WebConfigDraft | null
  models: WebCatalogModel[]
  feedback: string
  feedbackTone?: FeedbackTone
  language?: Language
  onDraftChange: React.Dispatch<React.SetStateAction<WebConfigDraft | null>>
  onModelsChange: (models: WebCatalogModel[]) => void
  onFeedbackChange: (message: string, tone?: FeedbackTone) => void
  onReloadAuxiliary: () => Promise<void>
  request: WebRequestFn
}> = ({
  config,
  draft,
  models,
  feedback,
  feedbackTone,
  language = 'zh',
  onDraftChange,
  onModelsChange,
  onFeedbackChange,
  onReloadAuxiliary,
  request,
}) => {
  const [saving, setSaving] = useState(false)
  const [localFeedbackTone, setLocalFeedbackTone] = useState<FeedbackTone>('info')
  const catalogReqRef = useRef(0)

  const effectiveFeedbackTone = feedbackTone ?? localFeedbackTone
  const updateFeedback = (message: string, tone: FeedbackTone = 'info') => {
    setLocalFeedbackTone(tone)
    onFeedbackChange(message, tone)
  }

  const effectiveDraft: WebConfigDraft = draft ?? {
    providerId: config?.providerId || 'deepseek',
    model: config?.model || '',
    apiKey: '',
  }

  const loadCatalog = async (providerId: string) => {
    const reqId = ++catalogReqRef.current
    const result = await request<{ models?: WebCatalogModel[] }>(
      'GET',
      `/v1/cloud-config/catalog?providerId=${encodeURIComponent(providerId)}`
    )
    if (reqId !== catalogReqRef.current) return
    const nextModels =
      result.ok && Array.isArray(result.payload?.models) ? result.payload.models : []
    onModelsChange(nextModels)
    if (nextModels.length > 0) {
      // 函数式更新：只补默认模型，绝不覆盖拉取期间用户已输入的 API Key
      onDraftChange((prev) => {
        const base: WebConfigDraft = prev ?? {
          providerId,
          model: config?.model || '',
          apiKey: '',
        }
        if (base.providerId !== providerId) return base
        if (nextModels.some((item) => item.id === base.model)) return base
        return { ...base, model: nextModels[0].id }
      })
    }
  }

  useEffect(() => {
    if (!draft) {
      onDraftChange(effectiveDraft)
    }
    if (models.length === 0) {
      void loadCatalog(effectiveDraft.providerId)
    }
    // 仅在首次挂载且缺少目录缓存时拉取，避免覆盖用户已填草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedModel = models.find((item) => item.id === effectiveDraft.model) ?? models[0]

  const handleSave = async () => {
    if (saving) return
    const body = {
      providerId: effectiveDraft.providerId.trim(),
      model: (effectiveDraft.model || selectedModel?.id || '').trim(),
      apiKey: effectiveDraft.apiKey.trim(),
    }
    if (!body.providerId || !body.model) {
      updateFeedback(translate(language, 'cloudWebConfigProviderModelRequired'), 'error')
      return
    }
    if (!body.apiKey && !config?.apiKeyMasked) {
      updateFeedback(translate(language, 'cloudWebConfigFirstKeyRequired'), 'error')
      return
    }
    if (!body.apiKey) {
      updateFeedback(translate(language, 'cloudWebConfigReenterKeyRequired'), 'error')
      return
    }
    setSaving(true)
    try {
      const result = await request<{ warning?: string; error?: string }>(
        'PUT',
        '/v1/cloud-config',
        body
      )
      if (!result.ok) {
        updateFeedback(
          result.payload?.error || translate(language, 'cloudWebConfigSaveFailed'),
          'error'
        )
        return
      }
      updateFeedback(
        result.payload?.warning
          ? translate(language, 'cloudWebConfigSavedWarning', { warning: result.payload.warning })
          : translate(language, 'cloudSaved'),
        'info'
      )
      // 落盘成功后清空 draft：Key 不再留在页面状态里
      onDraftChange(null)
      await onReloadAuxiliary()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader title={translate(language, 'cloudConfigTitle')} />
      <CloudConfigForm
        className="mt-3"
        idPrefix="cloud-config"
        providerId={effectiveDraft.providerId}
        model={effectiveDraft.model || selectedModel?.id || ''}
        apiKey={effectiveDraft.apiKey}
        apiKeyMasked={config?.apiKeyMasked}
        models={models}
        feedback={feedback}
        feedbackTone={effectiveFeedbackTone}
        language={language}
        showModelCountInLabel
        onProviderChange={(nextProvider) => {
          const nextDraft: WebConfigDraft = {
            ...effectiveDraft,
            providerId: nextProvider,
            model: '',
          }
          onDraftChange(nextDraft)
          onModelsChange([])
          updateFeedback('', 'info')
          void loadCatalog(nextProvider)
        }}
        onModelChange={(nextModel) => onDraftChange({ ...effectiveDraft, model: nextModel })}
        onApiKeyChange={(nextKey) => onDraftChange({ ...effectiveDraft, apiKey: nextKey })}
        actions={
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {translate(language, 'cloudSave')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadCatalog(effectiveDraft.providerId)}
            >
              {translate(language, 'cloudFetchModels')}
            </Button>
            <div className="ml-auto">
              <Button
                variant="ghost"
                size="sm"
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={async () => {
                  await request('POST', '/v1/logout')
                  window.location.reload()
                }}
              >
                {translate(language, 'cloudWebLogout')}
              </Button>
            </div>
          </div>
        }
      />
    </Card>
  )
}

export const MemoryTab: React.FC<{
  memories: CloudMemoryItem[]
  docs: CloudDocItem[]
  dreams: CloudDreamItem[]
  busy: boolean
  docDrafts: Record<string, string>
  language?: Language
  onDocDraftChange: (name: string, content: string) => void
  onClearDocDraft: (name: string) => void
  onMemoriesChange: (next: CloudMemoryItem[]) => void
  onDocsChange: (next: CloudDocItem[]) => void
  onRefresh: () => Promise<void>
  request: WebRequestFn
}> = ({
  memories,
  docs,
  dreams,
  busy,
  docDrafts,
  language = 'zh',
  onDocDraftChange,
  onClearDocDraft,
  onMemoriesChange,
  onDocsChange,
  onRefresh,
  request,
}) => (
  <CloudMemoryManager
    memories={memories}
    docs={docs}
    dreams={dreams}
    docDrafts={docDrafts}
    loading={busy}
    language={language}
    layout="cards"
    confirmDelete
    showKindFilter
    onDocDraftChange={(name, val) => onDocDraftChange(name, val)}
    onRefresh={onRefresh}
    onAddMemory={async ({ kind, content }) => {
      const res = await request<{ memory?: CloudMemoryItem; error?: string }>(
        'POST',
        '/v1/memories',
        { kind, content }
      )
      if (res.ok && res.payload?.memory) {
        onMemoriesChange([res.payload.memory, ...memories])
        return { ok: true }
      }
      return {
        ok: false,
        error:
          res.payload?.error ||
          translate(language, 'cloudWebMemorySaveFailedHttp', { status: res.status }),
      }
    }}
    onUpdateMemory={async ({ id, kind, content, tags, pinned }) => {
      const body: Record<string, unknown> = {}
      if (kind !== undefined) body.kind = kind
      if (content !== undefined) body.content = content
      if (tags !== undefined) body.tags = tags
      if (pinned !== undefined) body.pinned = pinned
      const res = await request<{ memory?: CloudMemoryItem; error?: string }>(
        'PATCH',
        `/v1/memories/${encodeURIComponent(id)}`,
        body
      )
      if (res.ok && res.payload?.memory) {
        const updated = res.payload.memory
        onMemoriesChange(memories.map((m) => (m.id === id ? updated : m)))
        return { ok: true }
      }
      return {
        ok: false,
        error:
          res.payload?.error ||
          translate(language, 'cloudWebMemorySaveFailedHttp', { status: res.status }),
      }
    }}
    onDeleteMemory={async (id) => {
      const res = await request<{ error?: string }>(
        'DELETE',
        `/v1/memories/${encodeURIComponent(id)}`
      )
      if (res.ok) {
        onMemoriesChange(memories.filter((m) => m.id !== id))
        return { ok: true }
      }
      return {
        ok: false,
        error:
          res.payload?.error ||
          translate(language, 'cloudWebMemoryDeleteFailedHttp', { status: res.status }),
      }
    }}
    onSaveDoc={async ({ name, content }) => {
      const res = await request<{ doc?: CloudDocItem; error?: string }>(
        'PUT',
        `/v1/cloud-docs/${encodeURIComponent(name)}`,
        { content }
      )
      if (res.ok && res.payload?.doc) {
        const saved = res.payload.doc
        const nextDocs = docs.some((d) => d.name === saved.name)
          ? docs.map((d) => (d.name === saved.name ? saved : d))
          : [...docs, saved]
        onDocsChange(nextDocs)
        onClearDocDraft(saved.name)
        return { ok: true }
      }
      return {
        ok: false,
        error:
          res.payload?.error ||
          translate(language, 'cloudWebMemorySaveFailedHttp', { status: res.status }),
      }
    }}
    onRunDream={async () => {
      const res = await request<{ dream?: { summary?: string }; error?: string }>(
        'POST',
        '/v1/dreams/run',
        {}
      )
      if (res.ok) {
        await onRefresh()
        return { ok: true, summary: res.payload?.dream?.summary }
      }
      return {
        ok: false,
        error:
          res.payload?.error ||
          translate(language, 'cloudWebDreamsFailedHttp', { status: res.status }),
      }
    }}
  />
)

export const ConfirmPlanModal: React.FC<{
  open: boolean
  devices: CloudDeviceRow[]
  language?: Language
  onClose: () => void
  onSubmit: (payload: {
    planText: string
    items: Array<{ deviceId: string; workspacePath: string }>
    quota: number
  }) => boolean
}> = ({ open, devices, language = 'zh', onClose, onSubmit }) => (
  <CloudConfirmPlanModal
    open={open}
    devices={devices}
    language={language}
    showDeviceIdInOption
    showRepoPathInOption
    onClose={onClose}
    onSubmit={onSubmit}
  />
)
