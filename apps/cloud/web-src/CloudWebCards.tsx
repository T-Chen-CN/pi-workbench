import React, { useEffect, useRef, useState } from 'react'
import {
  Button,
  Caption,
  Card,
  CardHeader,
  CloudAuthorizationCard,
  CloudConfirmPlanModal,
  CloudNoticeCard,
  CloudTaskCard,
  CloudUnitCard,
  DataText,
  Field,
  Input,
  Modal,
  Select,
  StatusText,
  Textarea,
} from '@pi-workbench/cloud-ui'
import { TaskResultSection } from '../../../src/components/cloud/TaskResultSection'
import {
  MEMORY_KIND_LABELS,
  PROVIDER_PRESETS,
  TASK_STATUS_LABELS,
  formatTime,
  formatTokens,
  parseTagsInput,
  type CloudAuthorizationRow,
  type CloudDeviceRow,
  type CloudDocItem,
  type CloudDreamItem,
  type CloudMemoryItem,
  type CloudMemoryKind,
  type CloudNotice,
  type CloudUnitRow,
  type RequestResult,
  type WebCatalogModel,
  type WebCloudConfig,
  type WebConfigDraft,
  type WebPairCode,
  type WebTaskItem,
} from './cloudWebClient'

export type WebRequestFn = <T = any>(method: string, path: string, body?: unknown) => Promise<RequestResult<T>>
export type WebSendFn = (frame: Record<string, unknown>) => boolean
export type FeedbackTone = 'info' | 'error'
type FeedbackState = { text: string; tone: FeedbackTone } | null

const ConfirmDangerModal: React.FC<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => Promise<void> | void
}> = ({ open, title, description, confirmLabel, busy = false, onCancel, onConfirm }) => (
  <Modal
    open={open}
    onClose={() => {
      if (!busy) onCancel()
    }}
    title={title}
    size="sm"
    closeLabel="关闭"
    footer={
      <>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          disabled={busy}
          onClick={() => void onConfirm()}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    <div className="px-5 py-4">
      <p className="m-0 whitespace-pre-wrap break-words type-body text-ink">{description}</p>
    </div>
  </Modal>
)

export const TaskCard: React.FC<{
  tasks: WebTaskItem[]
  devices: CloudDeviceRow[]
  stoppingTaskIds: Record<string, true>
  answerDrafts: Record<string, string>
  instructionDrafts: Record<string, string>
  compact?: boolean
  onAnswerDraft: (taskId: string, value: string) => void
  onInstructionDraft: (taskId: string, value: string) => void
  onSendAnswer: (taskId: string, text: string) => void
  onSendInstruction: (taskId: string, text: string) => void
  onStopTask: (taskId: string) => void
}> = ({ compact = false, ...rest }) => (
  <CloudTaskCard
    {...rest}
    compact={compact}
    showCount
    labels={{ statusLabel: (status) => TASK_STATUS_LABELS[status] || status }}
    renderResult={(task) => (
      <TaskResultSection
        taskId={task.id}
        summary={task.result?.summary ?? (task.status === 'done' ? task.lastMilestone : undefined)}
        changedFiles={task.changedFiles ?? task.result?.changedFiles ?? []}
        secretHits={task.secretHits ?? task.result?.secretHits ?? []}
        compact={compact}
        language="zh"
      />
    )}
  />
)

export const UnitCard: React.FC<{
  units: CloudUnitRow[]
  onCloseUnit: (unitId: string) => void
}> = ({ units, onCloseUnit }) => <CloudUnitCard units={units} onCloseUnit={onCloseUnit} />

export const DeviceCard: React.FC<{
  devices: CloudDeviceRow[]
  pairCode: WebPairCode | null
  onGeneratePairCode: () => Promise<void>
  onRemoveDevice: (deviceId: string) => Promise<void>
}> = ({ devices, pairCode, onGeneratePairCode, onRemoveDevice }) => {
  const [generating, setGenerating] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<CloudDeviceRow | null>(null)
  const [removing, setRemoving] = useState(false)

  return (
    <Card density="compact">
      <CardHeader title="设备" status={<Caption className="text-ink-muted">{devices.length}</Caption>} />
      {devices.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">还没有设备</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <StatusText tone={device.online ? 'success' : 'muted'} dot>
                  {device.name}
                </StatusText>
                <DataText className="flex-shrink-0 text-ink-muted">{device.platform}</DataText>
              </div>
              <DataText className="truncate text-ink-muted">{device.id}</DataText>
              {(device.workspaces || []).length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {device.workspaces.map((ws) => (
                    <DataText key={ws.path} className="truncate text-ink-muted">
                      {ws.name}
                      {ws.isGit ? '' : '（非 git，不可派活）'}
                    </DataText>
                  ))}
                </div>
              )}
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger/10 hover:text-danger"
                  onClick={() => setPendingRemove(device)}
                >
                  移除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-col gap-2 border-t border-rule-divide pt-3">
        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={generating}
            onClick={async () => {
              setGenerating(true)
              try {
                await onGeneratePairCode()
              } finally {
                setGenerating(false)
              }
            }}
          >
            生成配对码
          </Button>
        </div>
        {pairCode ? (
          <div className="flex flex-col gap-1 border border-rule-hairline bg-sunken px-3 py-2">
            <span className="type-title text-accent">{pairCode.code}</span>
            <Caption className="text-ink-muted">
              5 分钟内有效：{formatTime(pairCode.expiresAt)}
            </Caption>
            <Caption className="text-ink-muted">
              在桌面端「云端 → 连接云端」里填入这个码。
            </Caption>
          </div>
        ) : (
          <Caption className="text-ink-muted">生成一次性 6 位码，把一台设备接进来。</Caption>
        )}
      </div>
      <ConfirmDangerModal
        open={Boolean(pendingRemove)}
        title="移除设备"
        description={
          pendingRemove
            ? `确定要移除设备「${pendingRemove.name}」（${pendingRemove.id}）吗？移除后该设备将断开连接，需要重新配对才能接入。`
            : ''
        }
        confirmLabel="确认移除"
        busy={removing}
        onCancel={() => setPendingRemove(null)}
        onConfirm={async () => {
          if (!pendingRemove || removing) return
          setRemoving(true)
          try {
            await onRemoveDevice(pendingRemove.id)
            setPendingRemove(null)
          } finally {
            setRemoving(false)
          }
        }}
      />
    </Card>
  )
}

export const AuthCard: React.FC<{
  authorizations: CloudAuthorizationRow[]
  onRevoke: (id: string) => Promise<void>
}> = ({ authorizations, onRevoke }) => {
  const [pendingRevoke, setPendingRevoke] = useState<CloudAuthorizationRow | null>(null)
  const [revoking, setRevoking] = useState(false)

  return (
    <>
      <CloudAuthorizationCard
        authorizations={authorizations}
        onRevoke={(id) => {
          const found = authorizations.find((item) => item.id === id)
          if (found) setPendingRevoke(found)
        }}
      />
      <ConfirmDangerModal
        open={Boolean(pendingRevoke)}
        title="撤销授权"
        description={
          pendingRevoke
            ? `确定要撤销这条授权（额度 ${pendingRevoke.used}/${pendingRevoke.quota}）吗？撤销后云端无法继续使用该授权派发新工单。`
            : ''
        }
        confirmLabel="确认撤销"
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

export const NoticeCard: React.FC<{ notices: CloudNotice[] }> = ({ notices }) => (
  <CloudNoticeCard notices={notices} withSeconds />
)

export const ConfigCard: React.FC<{
  config: WebCloudConfig | null
  draft: WebConfigDraft | null
  models: WebCatalogModel[]
  feedback: string
  feedbackTone?: FeedbackTone
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
    const nextModels = result.ok && Array.isArray(result.payload?.models) ? result.payload.models : []
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
  const capabilityText = selectedModel
    ? [
        `上下文 ${formatTokens(selectedModel.contextWindow)}`,
        `输出 ${formatTokens(selectedModel.maxTokens)}`,
        selectedModel.reasoning ? '支持思考' : '不支持思考',
        selectedModel.vision ? '图片输入' : '纯文本',
      ].join(' · ')
    : ''

  const handleSave = async () => {
    if (saving) return
    const body = {
      providerId: effectiveDraft.providerId.trim(),
      model: (effectiveDraft.model || selectedModel?.id || '').trim(),
      apiKey: effectiveDraft.apiKey.trim(),
    }
    if (!body.providerId || !body.model) {
      updateFeedback('供应商与模型都要选', 'error')
      return
    }
    if (!body.apiKey && !config?.apiKeyMasked) {
      updateFeedback('首次配置要填 API Key', 'error')
      return
    }
    if (!body.apiKey) {
      updateFeedback('这里需要重新填一次 Key（云端不保存明文可回填的那份）', 'error')
      return
    }
    setSaving(true)
    try {
      const result = await request<{ warning?: string; error?: string }>('PUT', '/v1/cloud-config', body)
      if (!result.ok) {
        updateFeedback(result.payload?.error || '保存失败', 'error')
        return
      }
      updateFeedback(
        result.payload?.warning
          ? `已保存，下一轮生效（${result.payload.warning}）`
          : '已保存，下一轮生效',
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
      <CardHeader title="云端模型配置" />
      <div className="mt-3 flex flex-col gap-3">
        <Caption className="text-ink-muted">
          只支持 8 家内置供应商；模型能力来自 Pi catalog。Key 加密落盘，只回末四位，设备端的 Key 不会上传到这里。
        </Caption>
        <Field label="供应商" htmlFor="cloud-config-provider">
          <Select
            id="cloud-config-provider"
            value={effectiveDraft.providerId}
            onChange={(event) => {
              const nextProvider = event.target.value
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
          >
            {PROVIDER_PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="API Key" htmlFor="cloud-config-apikey">
          <Input
            id="cloud-config-apikey"
            type="password"
            autoComplete="off"
            value={effectiveDraft.apiKey}
            placeholder={
              config?.apiKeyMasked
                ? `已保存：${config.apiKeyMasked}（保存变更时需重新填入 Key）`
                : 'sk-...'
            }
            onChange={(event) =>
              onDraftChange({ ...effectiveDraft, apiKey: event.target.value })
            }
          />
        </Field>
        <Field label={`模型（catalog 内 ${models.length} 个）`} htmlFor="cloud-config-model">
          {models.length === 0 ? (
            <Caption className="text-ink-muted">目录里没有这个供应商的模型</Caption>
          ) : (
            <Select
              id="cloud-config-model"
              value={effectiveDraft.model || selectedModel?.id || ''}
              onChange={(event) =>
                onDraftChange({ ...effectiveDraft, model: event.target.value })
              }
            >
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {capabilityText && <Caption className="text-ink-muted">{capabilityText}</Caption>}
        {feedback && (
          <Caption className={effectiveFeedbackTone === 'error' ? 'text-danger' : 'text-accent'}>
            {feedback}
          </Caption>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
            保存
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadCatalog(effectiveDraft.providerId)}
          >
            刷新目录
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
              退出登录
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

export const MemoryTab: React.FC<{
  memories: CloudMemoryItem[]
  docs: CloudDocItem[]
  dreams: CloudDreamItem[]
  busy: boolean
  docDrafts: Record<string, string>
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
  onDocDraftChange,
  onClearDocDraft,
  onMemoriesChange,
  onDocsChange,
  onRefresh,
  request,
}) => {
  const [kind, setKind] = useState<CloudMemoryKind>('fact')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [memoryFeedback, setMemoryFeedback] = useState<FeedbackState>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<CloudMemoryKind>('fact')
  const [editContent, setEditContent] = useState('')
  const [editTags, setEditTags] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CloudMemoryItem | null>(null)
  const [deletingMemory, setDeletingMemory] = useState(false)

  const [selectedDoc, setSelectedDoc] = useState<'AGENTS.md' | 'SOUL.md'>('AGENTS.md')
  const [docSaving, setDocSaving] = useState(false)
  const [docFeedback, setDocFeedback] = useState<FeedbackState>(null)

  const [dreamRunning, setDreamRunning] = useState(false)
  const [dreamFeedback, setDreamFeedback] = useState<FeedbackState>(null)

  const currentDocMeta = docs.find((doc) => doc.name === selectedDoc)
  const currentDocValue =
    selectedDoc in docDrafts ? docDrafts[selectedDoc] : (currentDocMeta?.content ?? '')

  const addMemory = async () => {
    if (submitting) return
    const trimmed = content.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const res = await request<{ memory?: CloudMemoryItem; error?: string }>('POST', '/v1/memories', {
        kind,
        content: trimmed,
      })
      if (res.ok && res.payload?.memory) {
        setContent('')
        onMemoriesChange([res.payload.memory, ...memories])
        setMemoryFeedback({ text: '已添加手工记忆', tone: 'info' })
      } else {
        setMemoryFeedback({
          text: res.payload?.error || `保存失败 (HTTP ${res.status})`,
          tone: 'error',
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const saveEdit = async (id: string) => {
    if (submitting) return
    const nextContent = editContent.trim()
    if (!nextContent) return
    setSubmitting(true)
    try {
      const res = await request<{ memory?: CloudMemoryItem; error?: string }>(
        'PATCH',
        `/v1/memories/${encodeURIComponent(id)}`,
        {
          kind: editKind,
          content: nextContent,
          tags: parseTagsInput(editTags),
        }
      )
      if (res.ok && res.payload?.memory) {
        const updated = res.payload.memory
        onMemoriesChange(memories.map((m) => (m.id === id ? updated : m)))
        setEditingId(null)
        setMemoryFeedback({ text: '已保存（已升为手工保护）', tone: 'info' })
      } else {
        setMemoryFeedback({
          text: res.payload?.error || `保存失败 (HTTP ${res.status})`,
          tone: 'error',
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const saveDoc = async () => {
    if (docSaving) return
    setDocSaving(true)
    try {
      const res = await request<{ doc?: CloudDocItem; error?: string }>(
        'PUT',
        `/v1/cloud-docs/${encodeURIComponent(selectedDoc)}`,
        { content: currentDocValue }
      )
      if (res.ok && res.payload?.doc) {
        const saved = res.payload.doc
        const nextDocs = docs.some((d) => d.name === saved.name)
          ? docs.map((d) => (d.name === saved.name ? saved : d))
          : [...docs, saved]
        onDocsChange(nextDocs)
        onClearDocDraft(saved.name)
        setDocFeedback({ text: `已保存 ${saved.name}`, tone: 'info' })
      } else {
        setDocFeedback({
          text: res.payload?.error || `保存失败 (HTTP ${res.status})`,
          tone: 'error',
        })
      }
    } finally {
      setDocSaving(false)
    }
  }

  const runDream = async () => {
    if (dreamRunning) return
    setDreamRunning(true)
    setDreamFeedback({ text: '正在整理记忆…', tone: 'info' })
    try {
      const res = await request<{ dream?: { summary?: string }; error?: string }>('POST', '/v1/dreams/run', {})
      if (res.ok) {
        await onRefresh()
        setDreamFeedback({ text: res.payload?.dream?.summary || '梦境整理完成', tone: 'info' })
      } else {
        setDreamFeedback({
          text: res.payload?.error || `整理失败 (HTTP ${res.status})`,
          tone: 'error',
        })
      }
    } finally {
      setDreamRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="结构化长期记忆"
          action={
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onRefresh()}>
              {busy ? '刷新中…' : '刷新'}
            </Button>
          }
        />
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="w-28 flex-shrink-0">
              <Select
                aria-label="记忆分类"
                value={kind}
                onChange={(event) => setKind(event.target.value as CloudMemoryKind)}
              >
                {(Object.entries(MEMORY_KIND_LABELS) as Array<[CloudMemoryKind, string]>).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  )
                )}
              </Select>
            </div>
            <Input
              aria-label="新增长期记忆内容"
              placeholder="手工记录一条长期记忆（不会被自动抽取或梦境覆盖）…"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault()
                  void addMemory()
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              className="flex-shrink-0"
              disabled={submitting || !content.trim()}
              onClick={() => void addMemory()}
            >
              新增记忆
            </Button>
          </div>
          {memoryFeedback && (
            <Caption className={memoryFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
              {memoryFeedback.text}
            </Caption>
          )}
          {memories.length === 0 ? (
            <Caption className="text-ink-muted">
              还没有保存任何长期记忆。对话压缩前会自动提炼，也可以手工新增。
            </Caption>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {memories.map((item) => {
                const kindText = MEMORY_KIND_LABELS[item.kind] || item.kind
                const sourceText =
                  item.source === 'manual' ? '手工' : item.source === 'dream' ? '梦境' : '自动'
                if (editingId === item.id) {
                  return (
                    <li
                      key={item.id}
                      className="mem-edit-box flex flex-col gap-2 border border-rule-hairline bg-sunken p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="type-label text-ink-muted">
                          编辑记忆（保存后自动升为手工保护）
                        </span>
                        <div className="w-28 flex-shrink-0">
                          <Select
                            aria-label="编辑记忆分类"
                            value={editKind}
                            onChange={(event) => setEditKind(event.target.value as CloudMemoryKind)}
                          >
                            {(
                              Object.entries(MEMORY_KIND_LABELS) as Array<[CloudMemoryKind, string]>
                            ).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </div>
                      <Textarea
                        aria-label="编辑记忆内容"
                        rows={3}
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                      />
                      <Input
                        aria-label="编辑记忆标签"
                        placeholder="标签（逗号分隔，可选）"
                        value={editTags}
                        onChange={(event) => setEditTags(event.target.value)}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={submitting}
                          onClick={() => void saveEdit(item.id)}
                        >
                          保存
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={submitting}
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </li>
                  )
                }
                return (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1 border-b border-rule-divide pb-2.5 last:border-b-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <Caption className="text-ink-muted">
                        {kindText} · {sourceText}
                        {item.pinned ? ' · 已置顶' : ''}
                      </Caption>
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingId(item.id)
                            setEditKind(item.kind || 'fact')
                            setEditContent(item.content || '')
                            setEditTags(Array.isArray(item.tags) ? item.tags.join(', ') : '')
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            const res = await request<{ memory?: CloudMemoryItem }>(
                              'PATCH',
                              `/v1/memories/${encodeURIComponent(item.id)}`,
                              { pinned: !item.pinned }
                            )
                            if (res.ok && res.payload?.memory) {
                              const updated = res.payload.memory
                              onMemoriesChange(memories.map((m) => (m.id === item.id ? updated : m)))
                            }
                          }}
                        >
                          {item.pinned ? '取消置顶' : '置顶'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-danger/10 hover:text-danger"
                          onClick={() => setPendingDelete(item)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                    <p className="m-0 whitespace-pre-wrap type-body text-ink">{item.content}</p>
                    {Array.isArray(item.tags) && item.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="border border-rule-control bg-sunken px-1.5 py-0.5 type-data text-ink-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="云端留存文档（实时生效）"
          action={
            <div className="flex items-center gap-1">
              {(['AGENTS.md', 'SOUL.md'] as const).map((name) => (
                <Button
                  key={name}
                  variant={selectedDoc === name ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => {
                    setSelectedDoc(name)
                    setDocFeedback(null)
                  }}
                >
                  {name}
                </Button>
              ))}
            </div>
          }
        />
        <div className="mt-3 flex flex-col gap-2.5">
          <Caption className="text-ink-muted">
            {currentDocMeta?.updatedAt
              ? `上次保存：${new Date(currentDocMeta.updatedAt).toLocaleString()}`
              : '尚未创建（保存后立即对下一轮生效）'}
          </Caption>
          <Textarea
            aria-label={`编辑 ${selectedDoc} 文档内容`}
            rows={10}
            value={currentDocValue}
            placeholder={
              selectedDoc === 'SOUL.md'
                ? '定义云端 Agent 的人格、语气与沟通风格…'
                : '定义云端 Agent 必须遵守的长期工作约定与规则…'
            }
            onChange={(event) => onDocDraftChange(selectedDoc, event.target.value)}
          />
          {docFeedback && (
            <Caption className={docFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
              {docFeedback.text}
            </Caption>
          )}
          <div>
            <Button variant="primary" size="sm" disabled={docSaving} onClick={() => void saveDoc()}>
              {docSaving ? '保存中…' : '保存文档'}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="梦境整理记录"
          action={
            <Button variant="secondary" size="sm" disabled={dreamRunning} onClick={() => void runDream()}>
              {dreamRunning ? '整理中…' : '立即整理（梦境）'}
            </Button>
          }
        />
        <div className="mt-3 flex flex-col gap-2">
          {dreamFeedback && (
            <Caption className={dreamFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
              {dreamFeedback.text}
            </Caption>
          )}
          {dreams.length === 0 ? (
            <Caption className="text-ink-muted">
              还没有梦境整理记录（空闲 ≥30 分钟且无活跃工单时自动运行，也可手动触发）
            </Caption>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {dreams.map((dream) => (
                <li
                  key={dream.id}
                  className="flex flex-col gap-0.5 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <DataText className="text-ink-muted">{formatTime(dream.at)}</DataText>
                    <Caption className="text-ink-muted">
                      {dream.trigger === 'manual' ? '手动' : '空闲自动'}
                    </Caption>
                    <DataText className="ml-auto text-ink-muted">
                      +{dream.added} / -{dream.removed}
                    </DataText>
                  </div>
                  <span className="type-value text-ink">{dream.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <ConfirmDangerModal
        open={Boolean(pendingDelete)}
        title="删除长期记忆"
        description={
          pendingDelete
            ? `确定要删除这条长期记忆吗？删除后无法恢复。\n「${pendingDelete.content.slice(0, 80)}${
                pendingDelete.content.length > 80 ? '…' : ''
              }」`
            : ''
        }
        confirmLabel="确认删除"
        busy={deletingMemory}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete || deletingMemory) return
          setDeletingMemory(true)
          try {
            const res = await request<{ error?: string }>(
              'DELETE',
              `/v1/memories/${encodeURIComponent(pendingDelete.id)}`
            )
            if (res.ok) {
              onMemoriesChange(memories.filter((m) => m.id !== pendingDelete.id))
              setPendingDelete(null)
            } else {
              setMemoryFeedback({
                text: res.payload?.error || `删除失败 (HTTP ${res.status})`,
                tone: 'error',
              })
              setPendingDelete(null)
            }
          } finally {
            setDeletingMemory(false)
          }
        }}
      />
    </div>
  )
}

export const ConfirmPlanModal: React.FC<{
  open: boolean
  devices: CloudDeviceRow[]
  onClose: () => void
  onSubmit: (payload: {
    planText: string
    items: Array<{ deviceId: string; workspacePath: string }>
    quota: number
  }) => boolean
}> = ({ open, devices, onClose, onSubmit }) => (
  <CloudConfirmPlanModal
    open={open}
    devices={devices}
    showDeviceIdInOption
    showRepoPathInOption
    onClose={onClose}
    onSubmit={onSubmit}
  />
)
