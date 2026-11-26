import React, { useEffect, useRef, useState } from 'react'
import { Button, Caption, DataText, Field, Input, Modal, Select, Textarea } from '../../../src/components/ui'
import { Card, CardHeader, StatusText } from '../../../src/components/patterns'
import {
  ACTIVE_TASK_STATUSES,
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

export const TaskCard: React.FC<{
  tasks: WebTaskItem[]
  devices: CloudDeviceRow[]
  stoppingTaskIds: Record<string, true>
  answerDrafts: Record<string, string>
  instructionDrafts: Record<string, string>
  onAnswerDraft: (taskId: string, value: string) => void
  onInstructionDraft: (taskId: string, value: string) => void
  onSendAnswer: (taskId: string, text: string) => void
  onSendInstruction: (taskId: string, text: string) => void
  onStopTask: (taskId: string) => void
}> = ({
  tasks,
  devices,
  stoppingTaskIds,
  answerDrafts,
  instructionDrafts,
  onAnswerDraft,
  onInstructionDraft,
  onSendAnswer,
  onSendInstruction,
  onStopTask,
}) => {
  return (
    <Card density="compact">
      <CardHeader title="工单" status={<Caption className="text-ink-muted">{tasks.length}</Caption>} />
      {tasks.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">还没有工单</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0">
          {tasks.map((task) => {
            const active = (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)
            const spec = task.spec || {}
            const device = devices.find((item) => item.id === spec.deviceId)
            const offline = device ? !device.online : false
            const stopping = Boolean(stoppingTaskIds[task.id])
            const changedFiles = task.result?.changedFiles || task.progress?.changedFiles || []
            const attentionFiles = changedFiles.filter((file) => Boolean(file.attention))
            const normalFiles = changedFiles.filter((file) => !file.attention)
            const secretHits = task.result?.secretHits || task.progress?.secretHits || []
            const hasDetails =
              Boolean(task.result?.summary) || changedFiles.length > 0 || secretHits.length > 0

            return (
              <li
                key={task.id}
                className="flex flex-col gap-1.5 border-b border-rule-divide pb-2.5 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate type-value text-ink">
                    {spec.title || task.id}
                  </span>
                  <span
                    className={`flex-shrink-0 type-caption ${
                      task.status === 'failed'
                        ? 'text-danger'
                        : task.status === 'waiting_human'
                          ? 'text-warning'
                          : 'text-ink-muted'
                    }`}
                  >
                    {stopping ? '正在停止…' : TASK_STATUS_LABELS[task.status] || task.status}
                  </span>
                </div>
                <DataText className="truncate text-ink-muted">
                  {spec.deviceId || ''} · {spec.repo?.workspacePath || ''}
                </DataText>
                {task.progress?.summary && (
                  <Caption className="text-ink-muted">{task.progress.summary}</Caption>
                )}
                {task.status === 'waiting_human' && task.question && (
                  <div className="flex flex-col gap-1.5 border border-rule-hairline bg-sunken p-2">
                    <Caption className="text-warning">终端在等你回答</Caption>
                    <span className="type-value text-ink">{task.question.text}</span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        placeholder="回答"
                        value={answerDrafts[task.id] || ''}
                        onChange={(event) => onAnswerDraft(task.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.nativeEvent.isComposing &&
                            event.keyCode !== 229
                          ) {
                            const text = (answerDrafts[task.id] || '').trim()
                            if (text) onSendAnswer(task.id, text)
                          }
                        }}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => {
                          const text = (answerDrafts[task.id] || '').trim()
                          if (text) onSendAnswer(task.id, text)
                        }}
                      >
                        发送
                      </Button>
                    </div>
                  </div>
                )}
                {task.status === 'running' && !offline && (
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="向运行中工单追加指令…"
                      value={instructionDrafts[task.id] || ''}
                      onChange={(event) => onInstructionDraft(task.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229
                        ) {
                          const text = (instructionDrafts[task.id] || '').trim()
                          if (text) onSendInstruction(task.id, text)
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-shrink-0"
                      onClick={() => {
                        const text = (instructionDrafts[task.id] || '').trim()
                        if (text) onSendInstruction(task.id, text)
                      }}
                    >
                      追加指令
                    </Button>
                  </div>
                )}
                {hasDetails && (
                  <details className="type-caption text-ink-muted">
                    <summary className="cursor-pointer select-none">结果与改动清单</summary>
                    <div className="mt-1.5 flex flex-col gap-1 border-l border-rule-hairline pl-2.5">
                      {task.result?.summary && (
                        <p className="m-0 whitespace-pre-wrap type-caption text-ink">
                          {task.result.summary}
                        </p>
                      )}
                      {attentionFiles.length > 0 && (
                        <DataText className="text-warning">
                          注意：
                          {attentionFiles
                            .map((file) => `${file.path} (${file.attention})`)
                            .join(', ')}
                        </DataText>
                      )}
                      {normalFiles.length > 0 && (
                        <DataText className="text-ink-muted">
                          普通：{normalFiles.map((file) => file.path).join(', ')}
                        </DataText>
                      )}
                      {secretHits.length > 0 && (
                        <DataText className="text-danger">
                          疑似密钥（仅报位置）：
                          {secretHits
                            .map((hit) => `${hit.path}:${hit.line} (${hit.kind})`)
                            .join(', ')}
                        </DataText>
                      )}
                    </div>
                  </details>
                )}
                {task.error && <DataText className="text-danger">{task.error}</DataText>}
                {active && (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={stopping || offline}
                      onClick={() => onStopTask(task.id)}
                    >
                      {stopping ? '正在停止…' : offline ? '设备离线，工单已取消' : '停止工单'}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export const UnitCard: React.FC<{
  units: CloudUnitRow[]
  onCloseUnit: (unitId: string) => void
}> = ({ units, onCloseUnit }) => {
  const visible = units.slice(0, 8)
  return (
    <Card density="compact">
      <CardHeader title="工作单元" />
      {visible.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">
          还没有工作单元（派活后自动创建，一个单元一个工作树）
        </Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
          {visible.map((unit) => {
            const closed = typeof unit.closedAt === 'number'
            const closing = !closed && Boolean(unit.closeRequestedAt)
            const dirty = !closed && Boolean(unit.dirtyAt)
            const label = closed ? '已结束' : closing ? '回收中…' : dirty ? '有未提交改动' : '使用中'
            return (
              <li
                key={unit.unitId}
                className="flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <DataText className="min-w-0 truncate text-ink">
                    {unit.branch || unit.unitId}
                  </DataText>
                  <Caption className={dirty ? 'flex-shrink-0 text-warning' : 'flex-shrink-0 text-ink-muted'}>
                    {label}
                  </Caption>
                </div>
                <DataText className="truncate text-ink-muted">
                  {unit.worktreePath || unit.workspacePath || ''}
                </DataText>
                {!closed && (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={closing}
                      onClick={() => onCloseUnit(unit.unitId)}
                    >
                      {closing ? '回收中…' : '结束并回收'}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
          <li className="type-caption text-ink-muted">
            工作树干净时工单结束就自动回收；这里只为脏树保留手动入口
          </li>
        </ul>
      )}
    </Card>
  )
}

export const DeviceCard: React.FC<{
  devices: CloudDeviceRow[]
  pairCode: WebPairCode | null
  onGeneratePairCode: () => Promise<void>
  onRemoveDevice: (deviceId: string) => Promise<void>
}> = ({ devices, pairCode, onGeneratePairCode, onRemoveDevice }) => {
  const [generating, setGenerating] = useState(false)

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
                  onClick={() => void onRemoveDevice(device.id)}
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
    </Card>
  )
}

export const AuthCard: React.FC<{
  authorizations: CloudAuthorizationRow[]
  onRevoke: (id: string) => Promise<void>
}> = ({ authorizations, onRevoke }) => (
  <Card density="compact">
    <CardHeader title="已确认的授权" />
    {authorizations.length === 0 ? (
      <Caption className="mt-2 block text-ink-muted">还没有授权：确认方案之后才允许派活</Caption>
    ) : (
      <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
        {authorizations.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="type-value text-ink">
                额度 {item.used}/{item.quota}
              </span>
              <Caption className="text-ink-muted">至 {formatTime(item.expiresAt)}</Caption>
            </div>
            <Caption className="text-ink-muted">{item.confirmedSummary}</Caption>
            <div className="flex flex-col gap-0.5">
              {item.items.map((target, idx) => (
                <DataText key={`${target.deviceId}-${target.workspacePath}-${idx}`} className="truncate text-ink-muted">
                  {target.deviceId} → {target.workspacePath}
                </DataText>
              ))}
            </div>
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void onRevoke(item.id)}
              >
                撤销
              </Button>
            </div>
          </li>
        ))}
      </ul>
    )}
  </Card>
)

export const NoticeCard: React.FC<{ notices: CloudNotice[] }> = ({ notices }) => (
  <Card density="compact">
    <CardHeader title="最近提示" />
    {notices.length === 0 ? (
      <Caption className="mt-2 block text-ink-muted">暂无提示</Caption>
    ) : (
      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        {notices.slice(0, 6).map((notice, idx) => (
          <li
            key={`${notice.at}-${idx}`}
            className={`type-caption ${
              notice.level === 'error'
                ? 'text-danger'
                : notice.level === 'warn'
                  ? 'text-warning'
                  : 'text-ink-muted'
            }`}
          >
            {formatTime(notice.at)} {notice.text}
          </li>
        ))}
      </ul>
    )}
  </Card>
)

export const ConfigCard: React.FC<{
  config: WebCloudConfig | null
  draft: WebConfigDraft | null
  models: WebCatalogModel[]
  feedback: string
  onDraftChange: React.Dispatch<React.SetStateAction<WebConfigDraft | null>>
  onModelsChange: (models: WebCatalogModel[]) => void
  onFeedbackChange: (message: string) => void
  onReloadAuxiliary: () => Promise<void>
  request: WebRequestFn
}> = ({
  config,
  draft,
  models,
  feedback,
  onDraftChange,
  onModelsChange,
  onFeedbackChange,
  onReloadAuxiliary,
  request,
}) => {
  const [saving, setSaving] = useState(false)
  const catalogReqRef = useRef(0)

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
      onFeedbackChange('供应商与模型都要选')
      return
    }
    if (!body.apiKey && !config?.apiKeyMasked) {
      onFeedbackChange('首次配置要填 API Key')
      return
    }
    if (!body.apiKey) {
      onFeedbackChange('这里需要重新填一次 Key（云端不保存明文可回填的那份）')
      return
    }
    setSaving(true)
    try {
      const result = await request<{ warning?: string; error?: string }>('PUT', '/v1/cloud-config', body)
      if (!result.ok) {
        onFeedbackChange(result.payload?.error || '保存失败')
        return
      }
      onFeedbackChange(
        result.payload?.warning
          ? `已保存，下一轮生效（${result.payload.warning}）`
          : '已保存，下一轮生效'
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
              onFeedbackChange('')
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
        {feedback && <Caption className="text-accent">{feedback}</Caption>}
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
  const [memoryFeedback, setMemoryFeedback] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<CloudMemoryKind>('fact')
  const [editContent, setEditContent] = useState('')
  const [editTags, setEditTags] = useState('')

  const [selectedDoc, setSelectedDoc] = useState<'AGENTS.md' | 'SOUL.md'>('AGENTS.md')
  const [docSaving, setDocSaving] = useState(false)
  const [docFeedback, setDocFeedback] = useState('')

  const [dreamRunning, setDreamRunning] = useState(false)
  const [dreamFeedback, setDreamFeedback] = useState('')

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
        setMemoryFeedback('已添加手工记忆')
      } else {
        setMemoryFeedback(res.payload?.error || `保存失败 (HTTP ${res.status})`)
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
        setMemoryFeedback('已保存（已升为手工保护）')
      } else {
        setMemoryFeedback(res.payload?.error || `保存失败 (HTTP ${res.status})`)
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
        setDocFeedback(`已保存 ${saved.name}`)
      } else {
        setDocFeedback(res.payload?.error || `保存失败 (HTTP ${res.status})`)
      }
    } finally {
      setDocSaving(false)
    }
  }

  const runDream = async () => {
    if (dreamRunning) return
    setDreamRunning(true)
    setDreamFeedback('正在整理记忆…')
    try {
      const res = await request<{ dream?: { summary?: string }; error?: string }>('POST', '/v1/dreams/run', {})
      if (res.ok) {
        await onRefresh()
        setDreamFeedback(res.payload?.dream?.summary || '梦境整理完成')
      } else {
        setDreamFeedback(res.payload?.error || `整理失败 (HTTP ${res.status})`)
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
          {memoryFeedback && <Caption className="text-accent">{memoryFeedback}</Caption>}
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
                        rows={3}
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                      />
                      <Input
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
                          onClick={async () => {
                            const res = await request(
                              'DELETE',
                              `/v1/memories/${encodeURIComponent(item.id)}`
                            )
                            if (res.ok) {
                              onMemoriesChange(memories.filter((m) => m.id !== item.id))
                            }
                          }}
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
                    setDocFeedback('')
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
            rows={10}
            value={currentDocValue}
            placeholder={
              selectedDoc === 'SOUL.md'
                ? '定义云端 Agent 的人格、语气与沟通风格…'
                : '定义云端 Agent 必须遵守的长期工作约定与规则…'
            }
            onChange={(event) => onDocDraftChange(selectedDoc, event.target.value)}
          />
          {docFeedback && <Caption className="text-accent">{docFeedback}</Caption>}
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
          {dreamFeedback && <Caption className="text-accent">{dreamFeedback}</Caption>}
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
}> = ({ open, devices, onClose, onSubmit }) => {
  const [planText, setPlanText] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [quota, setQuota] = useState('5')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    const firstDevice = devices[0]
    const nextDeviceId = firstDevice?.id ?? ''
    setDeviceId(nextDeviceId)
    const gitWorkspaces = (firstDevice?.workspaces || []).filter((ws) => ws.isGit)
    setWorkspacePath(gitWorkspaces[0]?.path ?? '')
  }, [open, devices])

  const selectedDevice = devices.find((item) => item.id === deviceId)
  const gitWorkspaces = (selectedDevice?.workspaces || []).filter((ws) => ws.isGit)

  const handleConfirm = () => {
    const trimmed = planText.trim()
    if (!trimmed) {
      setError('请填写方案原文')
      return
    }
    if (!deviceId || !workspacePath) {
      setError('请选择设备与仓库')
      return
    }
    const ok = onSubmit({
      planText: trimmed,
      items: [{ deviceId, workspacePath }],
      quota: Math.max(1, Math.min(50, Number(quota) || 5)),
    })
    if (ok) {
      setPlanText('')
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="确认方案并授权派活"
      size="md"
      closeLabel="关闭"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm}>
            确认
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <Caption className="text-ink-muted">
          授权范围是「设备 × 仓库」，换设备或换仓库必须重新确认。
        </Caption>
        <Field label="方案原文" htmlFor="confirm-plan-text">
          <Textarea
            id="confirm-plan-text"
            rows={4}
            value={planText}
            placeholder="方案原文（会写进会话记录）"
            onChange={(event) => setPlanText(event.target.value)}
            autoFocus
          />
        </Field>
        <Field label="设备" htmlFor="confirm-plan-device">
          <Select
            id="confirm-plan-device"
            value={deviceId}
            onChange={(event) => {
              const nextId = event.target.value
              setDeviceId(nextId)
              const nextDevice = devices.find((item) => item.id === nextId)
              const nextRepos = (nextDevice?.workspaces || []).filter((ws) => ws.isGit)
              setWorkspacePath(nextRepos[0]?.path ?? '')
            }}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.id})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="仓库（仅 git）" htmlFor="confirm-plan-repo">
          <Select
            id="confirm-plan-repo"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
          >
            {gitWorkspaces.map((ws) => (
              <option key={ws.path} value={ws.path}>
                {ws.name} — {ws.path}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="工单额度" htmlFor="confirm-plan-quota">
          <Input
            id="confirm-plan-quota"
            type="number"
            min={1}
            max={50}
            value={quota}
            onChange={(event) => setQuota(event.target.value)}
          />
        </Field>
        {error && <Caption className="text-danger">{error}</Caption>}
      </div>
    </Modal>
  )
}
