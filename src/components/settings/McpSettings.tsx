import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { MCP_DEFAULT_TIMEOUT_MS, MCP_SECRET_MASK } from 'pi-bridge/mcp'
import { api } from '../../api'
import { localizeError } from '../../i18n/errors'
import { useI18nStore } from '../../store/i18nStore'
import { toast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  McpServerSaveInput,
  McpServerStatus,
  McpTestResult,
  McpToolInfo,
  McpTransportType,
} from '../../types/electron'
import { Card, SectionHeader, StatusText, type StatusTone } from '../ui/patterns'
import {
  Button,
  Caption,
  DataText,
  EmptyState,
  Field,
  IconButton,
  Input,
  Label,
  Modal,
  Select,
} from '../ui/ui'

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
  return `kv-${pairCounter}`
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

function createEmptyForm(): McpFormState {
  return {
    editingId: null,
    id: '',
    name: '',
    enabled: true,
    transport: 'stdio',
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

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function serverSummaryText(server: McpServerStatus): string {
  if (server.transport === 'stdio') {
    const args = server.args?.length ? ` ${formatArgsText(server.args)}` : ''
    return `${server.command ?? ''}${args}`.trim()
  }
  return server.url ?? ''
}

function runtimeStatusPresentation(
  server: McpServerStatus,
  t: ReturnType<typeof useI18nStore.getState>['t']
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
            {tool.readOnly && (
              <Caption className="text-accent">{readOnlyLabel}</Caption>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const TestResultBanner: React.FC<{
  result: McpTestResult
  t: ReturnType<typeof useI18nStore.getState>['t']
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
          : t('mcpTestFailed', { error: localizeError(result.error) || t('unknownError') })}
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
 * 桌面端设置页：全局 MCP 服务器管理 + 当前工作区项目级 MCP 信任管理。
 */
export const McpSettings: React.FC = () => {
  const { t } = useI18nStore()
  const workspacePath = useWorkspaceStore((state) => state.workspacePath)

  const [globalServers, setGlobalServers] = useState<McpServerStatus[]>([])
  const [projectServers, setProjectServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({})

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<McpFormState>(createEmptyForm)
  const [savingForm, setSavingForm] = useState(false)
  const [testingForm, setTestingForm] = useState(false)
  const [formTestResult, setFormTestResult] = useState<McpTestResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<McpServerStatus | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadServers = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        const res = await api.mcpList(workspacePath ?? undefined)
        if (res.success) {
          setGlobalServers(res.global)
          setProjectServers(res.project)
        } else {
          toast.error(
            t('mcpLoadFailed', { error: localizeError(res.error) || t('unknownError') })
          )
        }
      } catch (error) {
        toast.error(t('mcpLoadFailed', { error: localizeError(String(error)) }))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [workspacePath, t]
  )

  useEffect(() => {
    void loadServers(true)
  }, [loadServers])

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

  const buildSaveInputFromForm = (): { ok: true; input: McpServerSaveInput } | { ok: false; error: string } => {
    const name = form.name.trim()
    if (!name) {
      return { ok: false, error: t('mcpValidationNameRequired') }
    }
    const parsedTimeout = Number.parseInt(form.timeoutMs.trim(), 10)
    const timeoutMs = Number.isFinite(parsedTimeout)
      ? Math.min(120_000, Math.max(1_000, parsedTimeout))
      : MCP_DEFAULT_TIMEOUT_MS
    const cleanId = (form.editingId ?? form.id).trim()

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
          ...(cleanId ? { id: cleanId } : {}),
          name,
          enabled: form.enabled,
          transport: 'stdio',
          command,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
          timeoutMs,
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
        ...(cleanId ? { id: cleanId } : {}),
        name,
        enabled: form.enabled,
        transport: form.transport,
        url,
        ...(headers ? { headers } : {}),
        timeoutMs,
      },
    }
  }

  const handleSaveForm = async () => {
    const built = buildSaveInputFromForm()
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    setSavingForm(true)
    try {
      const res = await api.mcpSaveGlobal(built.input)
      if (!res.success) {
        const message = localizeError(res.error) || t('unknownError')
        setFormError(message)
        toast.error(t('mcpSaveFailed', { error: message }))
        return
      }
      toast.success(t('mcpSaved'))
      setFormOpen(false)
      await loadServers(true)
    } catch (error) {
      const message = localizeError(String(error))
      setFormError(message)
      toast.error(t('mcpSaveFailed', { error: message }))
    } finally {
      setSavingForm(false)
    }
  }

  const handleTestForm = async () => {
    const built = buildSaveInputFromForm()
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    setTestingForm(true)
    setFormTestResult(null)
    try {
      const res = await api.mcpTest({
        scope: 'inline',
        config: built.input,
        ...(workspacePath ? { workspaceDir: workspacePath } : {}),
      })
      if (res.success && res.result) {
        setFormTestResult(res.result)
      } else {
        setFormTestResult({
          ok: false,
          tools: [],
          latencyMs: 0,
          error: res.error || t('unknownError'),
        })
      }
    } catch (error) {
      setFormTestResult({
        ok: false,
        tools: [],
        latencyMs: 0,
        error: String(error),
      })
    } finally {
      setTestingForm(false)
    }
  }

  const handleToggleGlobal = async (server: McpServerStatus, enabled: boolean) => {
    const key = `global:${server.id}`
    setBusyKey(key)
    try {
      const res = await api.mcpSetGlobalEnabled(server.id, enabled)
      if (!res.success) {
        toast.error(
          t('mcpToggleFailed', { error: localizeError(res.error) || t('unknownError') })
        )
        return
      }
      await loadServers(true)
    } catch (error) {
      toast.error(t('mcpToggleFailed', { error: localizeError(String(error)) }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleDeleteGlobal = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await api.mcpDeleteGlobal(deleteTarget.id)
      if (!res.success) {
        toast.error(
          t('mcpDeleteFailed', { error: localizeError(res.error) || t('unknownError') })
        )
        return
      }
      toast.success(t('mcpDeleted'))
      setDeleteTarget(null)
      await loadServers(true)
    } catch (error) {
      toast.error(t('mcpDeleteFailed', { error: localizeError(String(error)) }))
    } finally {
      setDeleting(false)
    }
  }

  const handleSetProjectTrust = async (server: McpServerStatus, enabled: boolean) => {
    if (!workspacePath) return
    const key = `project:${server.id}`
    setBusyKey(key)
    try {
      const res = await api.mcpSetProjectTrust(workspacePath, server.id, enabled)
      if (!res.success) {
        toast.error(
          t('mcpTrustFailed', { error: localizeError(res.error) || t('unknownError') })
        )
        return
      }
      toast.success(t('mcpTrustUpdated'))
      await loadServers(true)
    } catch (error) {
      toast.error(t('mcpTrustFailed', { error: localizeError(String(error)) }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleTestServer = async (scope: 'global' | 'project', server: McpServerStatus) => {
    const key = `${scope}:${server.id}`
    setTestingKey(key)
    try {
      const res =
        scope === 'global'
          ? await api.mcpTest({ scope: 'global', id: server.id })
          : workspacePath
            ? await api.mcpTest({ scope: 'project', workspaceDir: workspacePath, id: server.id })
            : { success: false, error: t('mcpProjectNoWorkspace') }
      if (res.success && res.result) {
        setTestResults((prev) => ({ ...prev, [key]: res.result as McpTestResult }))
      } else {
        setTestResults((prev) => ({
          ...prev,
          [key]: {
            ok: false,
            tools: [],
            latencyMs: 0,
            error: res.error || t('unknownError'),
          },
        }))
      }
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [key]: { ok: false, tools: [], latencyMs: 0, error: String(error) },
      }))
    } finally {
      setTestingKey(null)
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

  if (loading) {
    return <p className="m-0 type-value text-ink-muted">{t('loading')}</p>
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <p className="m-0 type-reading text-ink-muted">{t('mcpSettingsDesc')}</p>

      {/* 全局 MCP 服务器 */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t('mcpGlobalSection')}
          count={globalServers.length}
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                loading={refreshing}
                onClick={() => void loadServers(false)}
              >
                {t('mcpRefresh')}
              </Button>
              <Button size="sm" variant="primary" icon={Plus} onClick={openAddModal}>
                {t('mcpAddServer')}
              </Button>
            </div>
          }
        />
        <Caption className="text-ink-muted">{t('mcpGlobalHint')}</Caption>

        {globalServers.length === 0 ? (
          <Card density="compact">
            <EmptyState
              compact
              icon={Plug}
              title={t('mcpGlobalEmpty')}
              description={t('mcpGlobalEmptyDesc')}
              action={
                <Button size="sm" icon={Plus} onClick={openAddModal}>
                  {t('mcpAddServer')}
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-2.5">
            {globalServers.map((server) => {
              const key = `global:${server.id}`
              const statusView = runtimeStatusPresentation(server, t)
              const testRes = testResults[key]
              const summary = serverSummaryText(server)
              return (
                <Card key={server.id} density="compact">
                  <div className="flex items-start justify-between gap-3">
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
                      {server.error && (
                        <p className="m-0 mt-1 type-caption text-danger">{server.error}</p>
                      )}
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-1.5 px-1.5 type-caption text-ink">
                        <input
                          type="checkbox"
                          className="h-3 w-3 accent-[rgb(var(--accent))]"
                          checked={server.enabled}
                          disabled={busyKey === key}
                          aria-label={`${server.name} ${server.enabled ? t('mcpDisable') : t('mcpEnable')}`}
                          onChange={(event) => void handleToggleGlobal(server, event.target.checked)}
                        />
                        {server.enabled ? t('mcpEnable') : t('mcpDisable')}
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={Play}
                        loading={testingKey === key}
                        onClick={() => void handleTestServer('global', server)}
                      >
                        {testingKey === key ? t('mcpTesting') : t('mcpTestConnection')}
                      </Button>
                      <IconButton
                        size="sm"
                        icon={Pencil}
                        label={`${t('mcpEditServer')} ${server.name}`}
                        onClick={() => openEditModal(server)}
                      />
                      <IconButton
                        size="sm"
                        icon={Trash2}
                        label={`${t('mcpDeleteServer')} ${server.name}`}
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
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* 当前项目 MCP 服务器 */}
      <section className="flex flex-col gap-3">
        <SectionHeader title={t('mcpProjectSection')} count={projectServers.length} />
        <Caption className="text-ink-muted">{t('mcpProjectHint')}</Caption>

        {!workspacePath ? (
          <Card density="compact">
            <Caption className="block text-ink-muted">{t('mcpProjectNoWorkspace')}</Caption>
          </Card>
        ) : projectServers.length === 0 ? (
          <Card density="compact">
            <Caption className="block text-ink-muted">{t('mcpProjectEmpty')}</Caption>
          </Card>
        ) : (
          <div className="flex flex-col gap-2.5">
            {projectServers.map((server) => {
              const key = `project:${server.id}`
              const testRes = testResults[key]
              const summary = serverSummaryText(server)
              const isTrusted = server.trusted === true && server.enabled === true
              const isChanged = server.trustChanged === true
              const runtimeView = runtimeStatusPresentation(server, t)
              const TrustIcon = isChanged
                ? ShieldAlert
                : isTrusted
                  ? ShieldCheck
                  : ShieldOff
              const trustTone: StatusTone = isChanged
                ? 'warning'
                : isTrusted
                  ? 'success'
                  : 'muted'
              const trustLabel = isChanged
                ? t('mcpTrustChanged')
                : isTrusted
                  ? t('mcpTrustTrusted')
                  : t('mcpTrustUntrusted')

              return (
                <Card key={server.id} density="compact">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="type-value text-ink">{server.name}</span>
                        <DataText className="text-ink-muted">{server.id}</DataText>
                        <span className="rounded-sm border border-rule-hairline bg-sunken px-1.5 py-0.5 type-data text-ink-muted">
                          {server.transport}
                        </span>
                        <StatusText tone={trustTone}>
                          <TrustIcon size={12} aria-hidden="true" />
                          {trustLabel}
                        </StatusText>
                        {isTrusted && (
                          <StatusText dot tone={runtimeView.tone}>
                            {runtimeView.label}
                          </StatusText>
                        )}
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

                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      {isTrusted ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyKey === key}
                          onClick={() => void handleSetProjectTrust(server, false)}
                        >
                          {t('mcpRevokeTrust')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={busyKey === key}
                          onClick={() => void handleSetProjectTrust(server, true)}
                        >
                          {t('mcpApproveEnable')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={Play}
                        loading={testingKey === key}
                        onClick={() => void handleTestServer('project', server)}
                      >
                        {testingKey === key ? t('mcpTesting') : t('mcpTestConnection')}
                      </Button>
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
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* 新增 / 编辑全局 MCP 服务器弹窗 */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
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
              onClick={() => void handleTestForm()}
            >
              {testingForm ? t('mcpTesting') : t('mcpTestConnection')}
            </Button>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setFormOpen(false)}>
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
            <Field label={t('mcpFieldName')} htmlFor="mcp-form-name">
              <Input
                id="mcp-form-name"
                value={form.name}
                placeholder={t('mcpFieldNamePlaceholder')}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </Field>
            <Field
              label={t('mcpFieldId')}
              hint={t('mcpFieldIdHint')}
              htmlFor="mcp-form-id"
            >
              <Input
                id="mcp-form-id"
                className="type-code"
                value={form.id}
                disabled={Boolean(form.editingId)}
                placeholder={t('mcpFieldIdPlaceholder')}
                onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('mcpFieldTransport')} htmlFor="mcp-form-transport">
              <Select
                id="mcp-form-transport"
                value={form.transport}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    transport: event.target.value as McpTransportType,
                  }))
                }
              >
                <option value="stdio">{t('mcpTransportStdio')}</option>
                <option value="http">{t('mcpTransportHttp')}</option>
                <option value="sse">{t('mcpTransportSse')}</option>
              </Select>
            </Field>
            <Field
              label={t('mcpFieldTimeout')}
              hint={t('mcpFieldTimeoutHint')}
              htmlFor="mcp-form-timeout"
            >
              <Input
                id="mcp-form-timeout"
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
              <Field label={t('mcpFieldCommand')} htmlFor="mcp-form-command">
                <Input
                  id="mcp-form-command"
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
                htmlFor="mcp-form-args"
              >
                <Input
                  id="mcp-form-args"
                  className="type-code"
                  value={form.argsText}
                  placeholder={t('mcpFieldArgsPlaceholder')}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, argsText: event.target.value }))
                  }
                />
              </Field>
              <Field label={t('mcpFieldCwd')} htmlFor="mcp-form-cwd">
                <Input
                  id="mcp-form-cwd"
                  className="type-code"
                  value={form.cwd}
                  placeholder={t('mcpFieldCwdPlaceholder')}
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
              <Field label={t('mcpFieldUrl')} htmlFor="mcp-form-url">
                <Input
                  id="mcp-form-url"
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

      {/* 删除全局 MCP 服务器确认弹窗 */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={t('mcpDeleteConfirmTitle')}
        size="sm"
        closeLabel={t('cancel')}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={deleting}
              onClick={() => void handleDeleteGlobal()}
            >
              {t('delete')}
            </Button>
          </>
        }
      >
        <div className="p-5">
          <p className="m-0 type-body text-ink">
            {deleteTarget
              ? t('mcpDeleteConfirmBody', { name: deleteTarget.name, id: deleteTarget.id })
              : ''}
          </p>
        </div>
      </Modal>
    </div>
  )
}
