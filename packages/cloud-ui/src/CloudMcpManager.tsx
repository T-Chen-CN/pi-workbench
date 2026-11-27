import React, { useCallback, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import {
  translate,
  type Language,
  type TranslationKey,
  type TranslationParams,
} from '@pi-workbench/i18n'
import {
  Button,
  Caption,
  Card,
  CardHeader,
  DataText,
  EmptyState,
  Field,
  IconButton,
  Input,
  Label,
  Modal,
  Select,
  StatusText,
  type StatusTone,
} from '@pi-workbench/ui'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_SECRET_MASK,
  mcpServerIdSchema,
  type McpServerInput,
  type McpServerStatus,
  type McpTestResult,
  type McpToolInfo,
  type McpTransportType,
} from 'pi-bridge/mcp'
import { CloudConfirmDangerModal } from './ConfirmDangerModal'

export interface CloudMcpMutationResult {
  ok: boolean
  error?: string
}

export interface CloudMcpManagerProps {
  language?: Language
  servers: McpServerStatus[]
  loading?: boolean
  busyId?: string | null
  onRefresh: () => Promise<void> | void
  onSave: (input: McpServerInput) => Promise<CloudMcpMutationResult>
  onToggle: (server: McpServerStatus, enabled: boolean) => Promise<CloudMcpMutationResult>
  onDelete: (id: string) => Promise<CloudMcpMutationResult>
  onTest: (payload: { id?: string; config?: McpServerInput }) => Promise<McpTestResult>
}

interface KeyValuePair {
  id: string
  key: string
  value: string
}

interface McpFormState {
  editingId: string | null
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  command: string
  argsText: string
  cwd: string
  url: string
  timeoutMs: string
  envPairs: KeyValuePair[]
  headerPairs: KeyValuePair[]
}

let pairCounter = 1
function nextPairId(): string {
  pairCounter += 1
  return `cloud-mcp-kv-${pairCounter}`
}

function recordToPairs(rec?: Record<string, string>): KeyValuePair[] {
  if (!rec) return []
  return Object.entries(rec).map(([key, value]) => ({
    id: nextPairId(),
    key,
    value,
  }))
}

function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const key = pair.key.trim()
    if (!key) continue
    out[key] = pair.value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 按 shell 惯例切分命令参数（支持单/双引号包裹含空格的片段） */
function parseArgsText(raw: string): string[] | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const args: string[] = []
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1].replace(/\\(["\\])/g, '$1'))
    } else if (match[2] !== undefined) {
      args.push(match[2])
    } else if (match[3] !== undefined) {
      args.push(match[3])
    }
  }
  return args.length > 0 ? args : undefined
}

function formatArgsText(args?: string[]): string {
  if (!args || args.length === 0) return ''
  return args
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/["\\]/g, '\\$&')}"` : arg))
    .join(' ')
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function deriveUniqueServerId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 56)
  const base = slug && mcpServerIdSchema.safeParse(slug).success ? slug : 'cloud-mcp'
  if (!existingIds.has(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 58)}-${suffix}`
    if (!existingIds.has(candidate) && mcpServerIdSchema.safeParse(candidate).success) {
      return candidate
    }
  }
  return `mcp-${Date.now().toString(36)}`
}

function createEmptyForm(): McpFormState {
  return {
    editingId: null,
    id: '',
    name: '',
    enabled: true,
    transport: 'http',
    command: '',
    argsText: '',
    cwd: '',
    url: '',
    timeoutMs: String(MCP_DEFAULT_TIMEOUT_MS),
    envPairs: [],
    headerPairs: [],
  }
}

function formFromServer(server: McpServerStatus): McpFormState {
  return {
    editingId: server.id,
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command ?? '',
    argsText: formatArgsText(server.args),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    timeoutMs: String(server.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS),
    envPairs: recordToPairs(server.envMasked),
    headerPairs: recordToPairs(server.headersMasked),
  }
}

function serverSummaryText(server: McpServerStatus): string {
  if (server.transport === 'stdio') {
    const args = server.args?.length ? ` ${formatArgsText(server.args)}` : ''
    return `${server.command ?? ''}${args}`.trim()
  }
  return server.url ?? ''
}

/**
 * 将 `McpServerStatus` 还原为带掩码的 `McpServerInput`，供启停切换直接提交 `PUT /v1/mcp/:id`，
 * 服务端经 `mergeMaskedSecretRecord` 自动保留原加密密钥。
 */
export function cloudMcpStatusToInput(
  server: McpServerStatus,
  enabled: boolean
): McpServerInput {
  if (server.transport === 'stdio') {
    return {
      id: server.id,
      name: server.name,
      enabled,
      transport: 'stdio',
      command: server.command ?? '',
      ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.envMasked ? { env: { ...server.envMasked } } : {}),
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      source: 'cloud',
    }
  }
  return {
    id: server.id,
    name: server.name,
    enabled,
    transport: server.transport,
    url: server.url ?? '',
    ...(server.headersMasked ? { headers: { ...server.headersMasked } } : {}),
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    source: 'cloud',
  }
}

function runtimeStatusPresentation(
  server: McpServerStatus,
  t: (key: TranslationKey, params?: TranslationParams) => string
): { tone: StatusTone; label: string } {
  if (!server.enabled) {
    return { tone: 'muted', label: t('mcpStateDisabled') }
  }
  if (server.state === 'connected') {
    return { tone: 'success', label: t('mcpStateConnected', { count: server.tools.length }) }
  }
  if (server.state === 'connecting') {
    return { tone: 'warning', label: t('mcpStateConnecting') }
  }
  if (server.state === 'error') {
    return { tone: 'danger', label: t('mcpStateError') }
  }
  return { tone: 'accent', label: t('mcpStateStandby') }
}

const ToolsPreviewList: React.FC<{
  tools: McpToolInfo[]
  readOnlyLabel: string
  heading: string
}> = ({ tools, readOnlyLabel, heading }) => {
  if (tools.length === 0) return null
  return (
    <div className="mt-2 border-t border-rule-divide pt-2">
      <Caption className="block text-ink-muted">{heading}</Caption>
      <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-1.5 p-0">
        {tools.map((tool) => (
          <li
            key={tool.qualifiedName}
            title={tool.description || tool.qualifiedName}
            className="inline-flex items-center gap-1.5 rounded-sm border border-rule-hairline bg-sunken px-2 py-0.5"
          >
            <DataText className="text-ink">{tool.name}</DataText>
            {tool.readOnly && <Caption className="text-accent">{readOnlyLabel}</Caption>}
          </li>
        ))}
      </ul>
    </div>
  )
}

const TestResultBanner: React.FC<{
  result: McpTestResult
  t: (key: TranslationKey, params?: TranslationParams) => string
}> = ({ result, t }) => (
  <div className="mt-2 rounded-sm border border-rule-hairline bg-panel px-2.5 py-2">
    <div className="flex items-center gap-1.5">
      {result.ok ? (
        <CheckCircle2 size={13} className="flex-shrink-0 text-success" aria-hidden="true" />
      ) : (
        <AlertCircle size={13} className="flex-shrink-0 text-danger" aria-hidden="true" />
      )}
      <span className={`type-caption ${result.ok ? 'text-success' : 'text-danger'}`}>
        {result.ok
          ? result.tools.length > 0
            ? t('mcpTestSuccess', { count: result.tools.length, latency: result.latencyMs })
            : t('mcpTestNoTools', { latency: result.latencyMs })
          : t('mcpTestFailed', { error: result.error || t('unknownError') })}
      </span>
    </div>
    {result.ok && result.tools.length > 0 && (
      <ToolsPreviewList
        tools={result.tools}
        readOnlyLabel={t('mcpToolReadOnly')}
        heading={t('mcpToolsDiscovered', { count: result.tools.length })}
      />
    )}
  </div>
)

/**
 * 桌面端 `CloudView` 与云端 Web 控制台共用的云端 MCP 服务器管理组件。
 * 零桌面 store / Electron / fetch 耦合，支持远程 HTTP/SSE 与云主机本地 stdio 服务器。
 */
export const CloudMcpManager: React.FC<CloudMcpManagerProps> = ({
  language = 'zh',
  servers,
  loading = false,
  busyId = null,
  onRefresh,
  onSave,
  onToggle,
  onDelete,
  onTest,
}) => {
  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
    [language]
  )

  const [refreshing, setRefreshing] = useState(false)
  const [localBusyId, setLocalBusyId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({})
  const [feedback, setFeedback] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<McpFormState>(createEmptyForm)
  const [savingForm, setSavingForm] = useState(false)
  const [testingForm, setTestingForm] = useState(false)
  const [formTestResult, setFormTestResult] = useState<McpTestResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<McpServerStatus | null>(null)
  const [deleting, setDeleting] = useState(false)

  const openAddModal = () => {
    setForm(createEmptyForm())
    setFormError(null)
    setFormTestResult(null)
    setFormOpen(true)
  }

  const openEditModal = (server: McpServerStatus) => {
    setForm(formFromServer(server))
    setFormError(null)
    setFormTestResult(null)
    setFormOpen(true)
  }

  const buildInputFromForm = ():
    | { ok: true; input: McpServerInput }
    | { ok: false; error: string } => {
    const name = form.name.trim()
    if (!name) {
      return { ok: false, error: t('mcpValidationNameRequired') }
    }

    const existingIds = new Set(servers.map((item) => item.id))
    let resolvedId: string
    if (form.editingId) {
      resolvedId = form.editingId
    } else if (form.id.trim()) {
      const checked = mcpServerIdSchema.safeParse(form.id.trim())
      if (!checked.success) {
        return {
          ok: false,
          error: checked.error.issues[0]?.message || t('mcpFieldIdHint'),
        }
      }
      resolvedId = checked.data
    } else {
      resolvedId = deriveUniqueServerId(name, existingIds)
    }

    const parsedTimeout = Number.parseInt(form.timeoutMs.trim(), 10)
    const timeoutMs = Number.isFinite(parsedTimeout)
      ? Math.min(120_000, Math.max(1_000, parsedTimeout))
      : MCP_DEFAULT_TIMEOUT_MS

    if (form.transport === 'stdio') {
      const command = form.command.trim()
      if (!command) {
        return { ok: false, error: t('mcpValidationCommandRequired') }
      }
      const args = parseArgsText(form.argsText)
      const cwd = form.cwd.trim() || undefined
      const env = pairsToRecord(form.envPairs)
      return {
        ok: true,
        input: {
          id: resolvedId,
          name,
          enabled: form.enabled,
          transport: 'stdio',
          command,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
          timeoutMs,
          source: 'cloud',
        },
      }
    }

    const url = form.url.trim()
    if (!url || !isValidHttpUrl(url)) {
      return { ok: false, error: t('mcpValidationUrlRequired') }
    }
    const headers = pairsToRecord(form.headerPairs)
    return {
      ok: true,
      input: {
        id: resolvedId,
        name,
        enabled: form.enabled,
        transport: form.transport,
        url,
        ...(headers ? { headers } : {}),
        timeoutMs,
        source: 'cloud',
      },
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const handleSaveForm = async () => {
    const built = buildInputFromForm()
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    setSavingForm(true)
    try {
      const res = await onSave(built.input)
      if (!res.ok) {
        const message = res.error || t('unknownError')
        setFormError(message)
        setFeedback({ text: t('mcpSaveFailed', { error: message }), tone: 'error' })
        return
      }
      setFeedback({ text: t('mcpSaved'), tone: 'info' })
      setFormOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFormError(message)
      setFeedback({ text: t('mcpSaveFailed', { error: message }), tone: 'error' })
    } finally {
      setSavingForm(false)
    }
  }

  const handleTestForm = async () => {
    const built = buildInputFromForm()
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    setTestingForm(true)
    setFormTestResult(null)
    try {
      const result = await onTest({ config: built.input })
      setFormTestResult(result)
    } catch (error) {
      setFormTestResult({
        ok: false,
        tools: [],
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTestingForm(false)
    }
  }

  const handleToggle = async (server: McpServerStatus, enabled: boolean) => {
    setLocalBusyId(server.id)
    setFeedback(null)
    try {
      const res = await onToggle(server, enabled)
      if (!res.ok) {
        setFeedback({
          text: t('mcpToggleFailed', { error: res.error || t('unknownError') }),
          tone: 'error',
        })
      }
    } catch (error) {
      setFeedback({
        text: t('mcpToggleFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
        tone: 'error',
      })
    } finally {
      setLocalBusyId(null)
    }
  }

  const handleTestServer = async (server: McpServerStatus) => {
    setTestingId(server.id)
    try {
      const result = await onTest({ id: server.id })
      setTestResults((prev) => ({ ...prev, [server.id]: result }))
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [server.id]: {
          ok: false,
          tools: [],
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        },
      }))
    } finally {
      setTestingId(null)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await onDelete(deleteTarget.id)
      if (!res.ok) {
        setFeedback({
          text: t('mcpDeleteFailed', { error: res.error || t('unknownError') }),
          tone: 'error',
        })
        return
      }
      setFeedback({ text: t('mcpDeleted'), tone: 'info' })
      setDeleteTarget(null)
    } catch (error) {
      setFeedback({
        text: t('mcpDeleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
        tone: 'error',
      })
    } finally {
      setDeleting(false)
    }
  }

  const updatePair = (
    field: 'envPairs' | 'headerPairs',
    pairId: string,
    patch: Partial<Pick<KeyValuePair, 'key' | 'value'>>
  ) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].map((item) => (item.id === pairId ? { ...item, ...patch } : item)),
    }))
  }

  const removePair = (field: 'envPairs' | 'headerPairs', pairId: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].filter((item) => item.id !== pairId),
    }))
  }

  const addPair = (field: 'envPairs' | 'headerPairs') => {
    setForm((prev) => ({
      ...prev,
      [field]: [...prev[field], { id: nextPairId(), key: '', value: '' }],
    }))
  }

  return (
    <Card>
      <CardHeader
        title={`${t('mcpCloudSection')}${servers.length > 0 ? ` (${servers.length})` : ''}`}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              loading={refreshing || loading}
              onClick={() => void handleRefresh()}
            >
              {t('mcpRefresh')}
            </Button>
            <Button size="sm" variant="primary" icon={Plus} onClick={openAddModal}>
              {t('mcpAddServer')}
            </Button>
          </div>
        }
      />

      <div className="mt-3 flex flex-col gap-3">
        <Caption className="block text-ink-muted">{t('mcpCloudHint')}</Caption>

        {feedback && (
          <p
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            className={`m-0 type-caption ${feedback.tone === 'error' ? 'text-danger' : 'text-accent'}`}
          >
            {feedback.text}
          </p>
        )}

        {loading && servers.length === 0 ? (
          <p className="m-0 type-caption text-ink-muted">{t('loading')}</p>
        ) : servers.length === 0 ? (
          <EmptyState
            compact
            icon={Plug}
            title={t('mcpCloudEmpty')}
            description={t('mcpCloudEmptyDesc')}
            action={
              <Button size="sm" icon={Plus} onClick={openAddModal}>
                {t('mcpAddServer')}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {servers.map((server) => {
              const statusView = runtimeStatusPresentation(server, t)
              const testRes = testResults[server.id]
              const summary = serverSummaryText(server)
              const isBusy = busyId === server.id || localBusyId === server.id
              return (
                <div
                  key={server.id}
                  className="rounded-sm border border-rule-hairline bg-panel px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="type-value text-ink">{server.name}</span>
                        <DataText className="text-ink-muted">{server.id}</DataText>
                        <span className="rounded-sm border border-rule-hairline bg-sunken px-1.5 py-0.5 type-data text-ink-muted">
                          {server.transport}
                        </span>
                        <StatusText dot tone={statusView.tone}>
                          {statusView.label}
                        </StatusText>
                      </div>
                      {summary && (
                        <DataText className="mt-1 block break-all text-ink-muted">
                          {summary}
                        </DataText>
                      )}
                      {server.cwd && (
                        <DataText className="mt-0.5 block break-all text-ink-muted">
                          cwd: {server.cwd}
                        </DataText>
                      )}
                      {server.error && (
                        <p className="m-0 mt-1 type-caption text-danger">{server.error}</p>
                      )}
                    </div>

                    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-1.5 px-1.5 type-caption text-ink">
                        <input
                          type="checkbox"
                          className="h-3 w-3 accent-[rgb(var(--accent))]"
                          checked={server.enabled}
                          disabled={isBusy}
                          aria-label={`${server.name} ${server.enabled ? t('mcpDisable') : t('mcpEnable')}`}
                          onChange={(event) => void handleToggle(server, event.target.checked)}
                        />
                        {server.enabled ? t('mcpEnable') : t('mcpDisable')}
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={Play}
                        loading={testingId === server.id}
                        disabled={isBusy}
                        onClick={() => void handleTestServer(server)}
                      >
                        {testingId === server.id ? t('mcpTesting') : t('mcpTestConnection')}
                      </Button>
                      <IconButton
                        size="sm"
                        icon={Pencil}
                        label={`${t('mcpEditServer')} ${server.name}`}
                        disabled={isBusy}
                        onClick={() => openEditModal(server)}
                      />
                      <IconButton
                        size="sm"
                        icon={Trash2}
                        label={`${t('mcpDeleteServer')} ${server.name}`}
                        disabled={isBusy}
                        onClick={() => setDeleteTarget(server)}
                      />
                    </div>
                  </div>

                  {!testRes && server.tools.length > 0 && (
                    <ToolsPreviewList
                      tools={server.tools}
                      readOnlyLabel={t('mcpToolReadOnly')}
                      heading={t('mcpToolsDiscovered', { count: server.tools.length })}
                    />
                  )}
                  {testRes && <TestResultBanner result={testRes} t={t} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新增 / 编辑云端 MCP 服务器弹窗 */}
      <Modal
        open={formOpen}
        onClose={() => {
          if (!savingForm) setFormOpen(false)
        }}
        title={form.editingId ? t('mcpEditServer') : t('mcpAddServer')}
        size="md"
        closeLabel={t('cancel')}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={Play}
              loading={testingForm}
              disabled={savingForm}
              onClick={() => void handleTestForm()}
            >
              {testingForm ? t('mcpTesting') : t('mcpTestConnection')}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={savingForm}
                onClick={() => setFormOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={savingForm}
                onClick={() => void handleSaveForm()}
              >
                {savingForm ? t('saving') : t('mcpSaveServer')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('mcpFieldName')} htmlFor="cloud-mcp-form-name">
              <Input
                id="cloud-mcp-form-name"
                value={form.name}
                placeholder={t('mcpFieldNamePlaceholder')}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </Field>
            <Field
              label={t('mcpFieldId')}
              hint={t('mcpFieldIdHint')}
              htmlFor="cloud-mcp-form-id"
            >
              <Input
                id="cloud-mcp-form-id"
                className="type-code"
                value={form.id}
                disabled={Boolean(form.editingId)}
                placeholder={t('mcpFieldIdPlaceholder')}
                onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('mcpFieldTransport')} htmlFor="cloud-mcp-form-transport">
              <Select
                id="cloud-mcp-form-transport"
                value={form.transport}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    transport: event.target.value as McpTransportType,
                  }))
                }
              >
                <option value="http">{t('mcpTransportHttp')}</option>
                <option value="sse">{t('mcpTransportSse')}</option>
                <option value="stdio">{t('mcpTransportStdio')}</option>
              </Select>
            </Field>
            <Field
              label={t('mcpFieldTimeout')}
              hint={t('mcpFieldTimeoutHint')}
              htmlFor="cloud-mcp-form-timeout"
            >
              <Input
                id="cloud-mcp-form-timeout"
                type="number"
                min={1000}
                max={120000}
                step={1000}
                value={form.timeoutMs}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, timeoutMs: event.target.value }))
                }
              />
            </Field>
          </div>

          {form.transport === 'stdio' ? (
            <>
              <Caption className="block text-ink-muted">{t('mcpCloudStdioHint')}</Caption>
              <Field label={t('mcpFieldCommand')} htmlFor="cloud-mcp-form-command">
                <Input
                  id="cloud-mcp-form-command"
                  className="type-code"
                  value={form.command}
                  placeholder={t('mcpFieldCommandPlaceholder')}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, command: event.target.value }))
                  }
                />
              </Field>
              <Field
                label={t('mcpFieldArgs')}
                hint={t('mcpFieldArgsHint')}
                htmlFor="cloud-mcp-form-args"
              >
                <Input
                  id="cloud-mcp-form-args"
                  className="type-code"
                  value={form.argsText}
                  placeholder={t('mcpFieldArgsPlaceholder')}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, argsText: event.target.value }))
                  }
                />
              </Field>
              <Field label={t('mcpFieldCwd')} htmlFor="cloud-mcp-form-cwd">
                <Input
                  id="cloud-mcp-form-cwd"
                  className="type-code"
                  value={form.cwd}
                  placeholder={t('mcpCloudCwdPlaceholder')}
                  onChange={(event) => setForm((prev) => ({ ...prev, cwd: event.target.value }))}
                />
              </Field>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Label className="text-ink-muted">{t('mcpFieldEnv')}</Label>
                    <Caption className="ml-2 text-ink-muted">{t('mcpFieldEnvHint')}</Caption>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Plus}
                    onClick={() => addPair('envPairs')}
                  >
                    {t('mcpAddPair')}
                  </Button>
                </div>
                {form.envPairs.map((pair, idx) => (
                  <div key={pair.id} className="flex items-center gap-2">
                    <Input
                      className="type-code flex-1"
                      aria-label={`${t('mcpFieldEnv')} ${t('mcpKeyPlaceholder')} ${idx + 1}`}
                      value={pair.key}
                      placeholder={t('mcpKeyPlaceholder')}
                      onChange={(event) =>
                        updatePair('envPairs', pair.id, { key: event.target.value })
                      }
                    />
                    <Input
                      className="type-code flex-1"
                      type={pair.value === MCP_SECRET_MASK ? 'text' : 'password'}
                      aria-label={`${t('mcpFieldEnv')} ${t('mcpValuePlaceholder')} ${idx + 1}`}
                      value={pair.value}
                      placeholder={t('mcpValuePlaceholder')}
                      onChange={(event) =>
                        updatePair('envPairs', pair.id, { value: event.target.value })
                      }
                    />
                    <IconButton
                      size="sm"
                      icon={X}
                      label={t('mcpRemovePair')}
                      onClick={() => removePair('envPairs', pair.id)}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <Field label={t('mcpFieldUrl')} htmlFor="cloud-mcp-form-url">
                <Input
                  id="cloud-mcp-form-url"
                  className="type-code"
                  value={form.url}
                  placeholder={t('mcpFieldUrlPlaceholder')}
                  onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                />
              </Field>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Label className="text-ink-muted">{t('mcpFieldHeaders')}</Label>
                    <Caption className="ml-2 text-ink-muted">{t('mcpFieldHeadersHint')}</Caption>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Plus}
                    onClick={() => addPair('headerPairs')}
                  >
                    {t('mcpAddPair')}
                  </Button>
                </div>
                {form.headerPairs.map((pair, idx) => (
                  <div key={pair.id} className="flex items-center gap-2">
                    <Input
                      className="type-code flex-1"
                      aria-label={`${t('mcpFieldHeaders')} ${t('mcpKeyPlaceholder')} ${idx + 1}`}
                      value={pair.key}
                      placeholder={t('mcpKeyPlaceholder')}
                      onChange={(event) =>
                        updatePair('headerPairs', pair.id, { key: event.target.value })
                      }
                    />
                    <Input
                      className="type-code flex-1"
                      type={pair.value === MCP_SECRET_MASK ? 'text' : 'password'}
                      aria-label={`${t('mcpFieldHeaders')} ${t('mcpValuePlaceholder')} ${idx + 1}`}
                      value={pair.value}
                      placeholder={t('mcpValuePlaceholder')}
                      onChange={(event) =>
                        updatePair('headerPairs', pair.id, { value: event.target.value })
                      }
                    />
                    <IconButton
                      size="sm"
                      icon={X}
                      label={t('mcpRemovePair')}
                      onClick={() => removePair('headerPairs', pair.id)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          <label className="flex items-center gap-2 type-value text-ink">
            <input
              type="checkbox"
              className="h-3 w-3 accent-[rgb(var(--accent))]"
              checked={form.enabled}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, enabled: event.target.checked }))
              }
            />
            {t('mcpEnabledLabel')}
          </label>

          {formError && <p className="m-0 type-caption text-danger">{formError}</p>}
          {formTestResult && <TestResultBanner result={formTestResult} t={t} />}
        </div>
      </Modal>

      {/* 删除云端 MCP 服务器危险确认弹窗 */}
      <CloudConfirmDangerModal
        open={Boolean(deleteTarget)}
        title={t('mcpDeleteConfirmTitle')}
        description={
          deleteTarget
            ? t('mcpCloudDeleteConfirmBody', { name: deleteTarget.name, id: deleteTarget.id })
            : ''
        }
        confirmLabel={t('delete')}
        busy={deleting}
        language={language}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </Card>
  )
}
