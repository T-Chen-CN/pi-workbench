import React, { useMemo, useState } from 'react'
import { Pencil, Pin, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { translate, type Language, type TranslationKey } from '@pi-workbench/i18n'
import {
  Button,
  Caption,
  Card,
  CardHeader,
  DataText,
  Input,
  Select,
  Spinner,
  Tab,
  Textarea,
} from '@pi-workbench/ui'
import { CloudConfirmDangerModal } from './ConfirmDangerModal'
import { formatCloudTime, parseCloudTagsInput } from './format'
import type { CloudDocItem, CloudDreamItem, CloudMemoryItem, CloudMemoryKind } from './types'

export const CLOUD_MEMORY_KINDS: readonly CloudMemoryKind[] = [
  'fact',
  'preference',
  'project',
  'decision',
  'todo',
] as const

const MEMORY_KIND_KEY: Record<CloudMemoryKind, TranslationKey> = {
  fact: 'cloudMemoryKindFact',
  preference: 'cloudMemoryKindPreference',
  project: 'cloudMemoryKindProject',
  decision: 'cloudMemoryKindDecision',
  todo: 'cloudMemoryKindTodo',
}

export function getCloudMemoryKindLabel(kind: CloudMemoryKind, language: Language = 'zh'): string {
  const key = MEMORY_KIND_KEY[kind]
  return key ? translate(language, key) : kind
}

export interface CloudMemoryMutationResult {
  ok: boolean
  error?: string
}

export interface CloudMemoryDreamResult {
  ok: boolean
  summary?: string
  error?: string
}

type FeedbackState = { text: string; tone: 'info' | 'error' } | null

export interface CloudMemoryManagerProps {
  memories: CloudMemoryItem[]
  docs: CloudDocItem[]
  dreams: CloudDreamItem[]
  docDrafts: Record<string, string>
  loading?: boolean
  language?: Language
  /** `tabs` 用于桌面端弹窗；`cards` 用于云端 Web 独立标签页 */
  layout?: 'tabs' | 'cards'
  confirmDelete?: boolean
  showKindFilter?: boolean
  onDocDraftChange: (name: 'AGENTS.md' | 'SOUL.md', content: string) => void
  onRefresh: () => Promise<void>
  onAddMemory: (input: {
    kind: CloudMemoryKind
    content: string
  }) => Promise<CloudMemoryMutationResult>
  onUpdateMemory: (input: {
    id: string
    kind?: CloudMemoryKind
    content?: string
    tags?: string[]
    pinned?: boolean
  }) => Promise<CloudMemoryMutationResult>
  onDeleteMemory: (id: string) => Promise<CloudMemoryMutationResult>
  onSaveDoc: (input: {
    name: 'AGENTS.md' | 'SOUL.md'
    content: string
  }) => Promise<CloudMemoryMutationResult>
  onRunDream: () => Promise<CloudMemoryDreamResult>
}

/**
 * 桌面端 CloudView 记忆弹窗与云端 Web 记忆页共用的记忆 / 留存文档 / 梦境整理管理组件。
 * 零桌面 store / Electron / fetch 耦合，全部操作通过回调注入。
 */
export const CloudMemoryManager: React.FC<CloudMemoryManagerProps> = ({
  memories,
  docs,
  dreams,
  docDrafts,
  loading = false,
  language = 'zh',
  layout = 'cards',
  confirmDelete = true,
  showKindFilter = false,
  onDocDraftChange,
  onRefresh,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
  onSaveDoc,
  onRunDream,
}) => {
  const [tab, setTab] = useState<'memories' | 'docs' | 'dreams'>('memories')
  const [kindFilter, setKindFilter] = useState<'all' | CloudMemoryKind>('all')
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

  const filteredMemories = useMemo(
    () => (kindFilter === 'all' ? memories : memories.filter((item) => item.kind === kindFilter)),
    [memories, kindFilter]
  )

  const currentDocMeta = docs.find((doc) => doc.name === selectedDoc)
  const currentDocValue =
    selectedDoc in docDrafts ? docDrafts[selectedDoc] : (currentDocMeta?.content ?? '')

  const sourceLabel = (source: CloudMemoryItem['source']): string =>
    source === 'manual'
      ? translate(language, 'cloudMemorySourceManual')
      : source === 'dream'
        ? translate(language, 'cloudMemorySourceDream')
        : translate(language, 'cloudMemorySourceAuto')

  const handleAddMemory = async () => {
    if (submitting) return
    const trimmed = content.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const res = await onAddMemory({ kind, content: trimmed })
      if (res.ok) {
        setContent('')
        setMemoryFeedback({ text: translate(language, 'cloudWebMemoryAdded'), tone: 'info' })
      } else if (res.error) {
        setMemoryFeedback({ text: res.error, tone: 'error' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const startEdit = (item: CloudMemoryItem) => {
    setEditingId(item.id)
    setEditKind(item.kind || 'fact')
    setEditContent(item.content || '')
    setEditTags(Array.isArray(item.tags) ? item.tags.join(', ') : '')
  }

  const handleSaveEdit = async (id: string) => {
    if (submitting) return
    const trimmed = editContent.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const res = await onUpdateMemory({
        id,
        kind: editKind,
        content: trimmed,
        tags: parseCloudTagsInput(editTags),
      })
      if (res.ok) {
        setEditingId(null)
        setMemoryFeedback({ text: translate(language, 'cloudWebMemoryEditSaved'), tone: 'info' })
      } else if (res.error) {
        setMemoryFeedback({ text: res.error, tone: 'error' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleTogglePin = async (item: CloudMemoryItem) => {
    const res = await onUpdateMemory({ id: item.id, pinned: !item.pinned })
    if (!res.ok && res.error) {
      setMemoryFeedback({ text: res.error, tone: 'error' })
    }
  }

  const handleDeleteDirect = async (id: string) => {
    const res = await onDeleteMemory(id)
    if (res.ok) {
      if (editingId === id) setEditingId(null)
    } else if (res.error) {
      setMemoryFeedback({ text: res.error, tone: 'error' })
    }
  }

  const handleSaveDoc = async () => {
    if (docSaving) return
    setDocSaving(true)
    try {
      const res = await onSaveDoc({ name: selectedDoc, content: currentDocValue })
      if (res.ok) {
        setDocFeedback({
          text: translate(language, 'cloudWebDocsSavedName', { name: selectedDoc }),
          tone: 'info',
        })
      } else if (res.error) {
        setDocFeedback({ text: res.error, tone: 'error' })
      }
    } finally {
      setDocSaving(false)
    }
  }

  const handleRunDream = async () => {
    if (dreamRunning) return
    setDreamRunning(true)
    setDreamFeedback({
      text: translate(language, 'cloudWebDreamsRunningFeedback'),
      tone: 'info',
    })
    try {
      const res = await onRunDream()
      if (res.ok) {
        setDreamFeedback({
          text: res.summary || translate(language, 'cloudWebDreamsDone'),
          tone: 'info',
        })
      } else if (res.error) {
        setDreamFeedback({ text: res.error, tone: 'error' })
      }
    } finally {
      setDreamRunning(false)
    }
  }

  const isTabs = layout === 'tabs'

  const memorySectionBody = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="w-28 flex-shrink-0">
          <Select
            aria-label={translate(language, 'cloudWebMemoryKindAria')}
            value={kind}
            onChange={(event) => setKind(event.target.value as CloudMemoryKind)}
          >
            {CLOUD_MEMORY_KINDS.map((value) => (
              <option key={value} value={value}>
                {getCloudMemoryKindLabel(value, language)}
              </option>
            ))}
          </Select>
        </div>
        <Input
          aria-label={translate(language, 'cloudWebMemoryAddAria')}
          placeholder={translate(
            language,
            isTabs ? 'cloudMemoryAddPlaceholder' : 'cloudWebMemoryAddHint'
          )}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229 &&
              !submitting &&
              content.trim()
            ) {
              event.preventDefault()
              void handleAddMemory()
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          className="flex-shrink-0"
          disabled={submitting || !content.trim()}
          onClick={() => void handleAddMemory()}
        >
          {translate(language, 'cloudMemoryAdd')}
        </Button>
      </div>

      {showKindFilter && memories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={translate(language, 'cloudWebMemoryKindFilterAria')}>
          <Button
            variant={kindFilter === 'all' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setKindFilter('all')}
          >
            {translate(language, 'cloudWebMemoryKindFilterAll')}
          </Button>
          {CLOUD_MEMORY_KINDS.map((value) => (
            <Button
              key={value}
              variant={kindFilter === value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setKindFilter(value)}
            >
              {getCloudMemoryKindLabel(value, language)}
            </Button>
          ))}
        </div>
      )}

      {!isTabs && memoryFeedback && (
        <Caption className={memoryFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
          {memoryFeedback.text}
        </Caption>
      )}

      {filteredMemories.length === 0 ? (
        <Caption className="text-ink-muted">
          {translate(language, isTabs ? 'cloudMemoryEmpty' : 'cloudWebMemoryEmptyLong')}
        </Caption>
      ) : (
        <ul
          className={
            isTabs
              ? 'm-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0'
              : 'm-0 flex list-none flex-col gap-2.5 p-0'
          }
        >
          {filteredMemories.map((item) => {
            const kindText = getCloudMemoryKindLabel(item.kind, language)
            const sourceText = sourceLabel(item.source)

            if (editingId === item.id) {
              return (
                <li
                  key={item.id}
                  className="mem-edit-box flex flex-col gap-2 border border-rule-hairline bg-sunken p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="type-label text-ink-muted">
                      {translate(
                        language,
                        isTabs ? 'cloudMemoryEditHint' : 'cloudWebMemoryEditHeader'
                      )}
                    </span>
                    <div className="w-28 flex-shrink-0">
                      <Select
                        aria-label={translate(language, 'cloudWebMemoryEditKindAria')}
                        value={editKind}
                        onChange={(event) => setEditKind(event.target.value as CloudMemoryKind)}
                      >
                        {CLOUD_MEMORY_KINDS.map((value) => (
                          <option key={value} value={value}>
                            {getCloudMemoryKindLabel(value, language)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <Textarea
                    aria-label={translate(language, 'cloudWebMemoryEditContentAria')}
                    rows={3}
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                  />
                  <Input
                    aria-label={translate(language, 'cloudWebMemoryEditTagsAria')}
                    placeholder={translate(language, 'cloudMemoryTagsPlaceholder')}
                    value={editTags}
                    onChange={(event) => setEditTags(event.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={submitting || !editContent.trim()}
                      onClick={() => void handleSaveEdit(item.id)}
                    >
                      {translate(language, 'cloudSave')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={submitting}
                      onClick={() => setEditingId(null)}
                    >
                      {translate(language, 'cancel')}
                    </Button>
                  </div>
                </li>
              )
            }

            return (
              <li
                key={item.id}
                className={
                  isTabs
                    ? 'flex flex-col gap-1.5 rounded border border-rule-divide bg-panel px-3 py-2'
                    : 'flex flex-col gap-1 border-b border-rule-divide pb-2.5 last:border-b-0 last:pb-0'
                }
              >
                <div className="flex items-center gap-2">
                  <Caption className="text-ink-muted">
                    {kindText} · {sourceText}
                    {item.pinned ? ` · ${translate(language, 'cloudWebMemoryPinnedTag')}` : ''}
                  </Caption>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startEdit(item)}
                      title={translate(language, 'cloudMemoryEdit')}
                      aria-label={translate(language, 'cloudMemoryEdit')}
                    >
                      {isTabs ? <Pencil size={12} aria-hidden="true" /> : translate(language, 'cloudMemoryEdit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleTogglePin(item)}
                      title={translate(
                        language,
                        item.pinned ? 'cloudMemoryUnpin' : 'cloudMemoryPin'
                      )}
                      aria-label={translate(
                        language,
                        item.pinned ? 'cloudMemoryUnpin' : 'cloudMemoryPin'
                      )}
                    >
                      {isTabs ? (
                        <Pin
                          size={12}
                          aria-hidden="true"
                          className={item.pinned ? 'text-accent' : undefined}
                        />
                      ) : (
                        translate(language, item.pinned ? 'cloudMemoryUnpin' : 'cloudMemoryPin')
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={isTabs ? undefined : 'text-danger hover:bg-danger/10 hover:text-danger'}
                      onClick={() => {
                        if (confirmDelete) setPendingDelete(item)
                        else void handleDeleteDirect(item.id)
                      }}
                      title={translate(language, 'delete')}
                      aria-label={translate(language, 'delete')}
                    >
                      {isTabs ? <Trash2 size={12} aria-hidden="true" /> : translate(language, 'delete')}
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
  )

  const docSwitcher = (
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
  )

  const docEditorBody = (
    <div className="flex flex-col gap-2.5">
      {isTabs ? (
        <div className="flex items-center gap-2">
          {docSwitcher}
          <Caption className="ml-auto text-ink-muted">
            {currentDocMeta?.updatedAt
              ? new Date(currentDocMeta.updatedAt).toLocaleString()
              : translate(language, 'cloudDocUnsaved')}
          </Caption>
        </div>
      ) : (
        <Caption className="text-ink-muted">
          {currentDocMeta?.updatedAt
            ? translate(language, 'cloudWebDocsLastSaved', {
                time: new Date(currentDocMeta.updatedAt).toLocaleString(),
              })
            : translate(language, 'cloudWebDocsUnsavedHint')}
        </Caption>
      )}
      <Textarea
        aria-label={translate(language, 'cloudWebDocsEditorAria', { name: selectedDoc })}
        rows={isTabs ? 12 : 10}
        value={currentDocValue}
        placeholder={
          isTabs
            ? translate(language, 'cloudDocPlaceholder')
            : selectedDoc === 'SOUL.md'
              ? translate(language, 'cloudWebDocsSoulPlaceholder')
              : translate(language, 'cloudWebDocsAgentsPlaceholder')
        }
        onChange={(event) => onDocDraftChange(selectedDoc, event.target.value)}
      />
      {!isTabs && docFeedback && (
        <Caption className={docFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
          {docFeedback.text}
        </Caption>
      )}
      <div className={isTabs ? 'flex justify-end' : ''}>
        <Button variant="primary" size="sm" disabled={docSaving} onClick={() => void handleSaveDoc()}>
          {isTabs && docSaving ? <Spinner size={13} /> : null}
          {docSaving && !isTabs
            ? translate(language, 'saving')
            : translate(language, 'cloudDocSave')}
        </Button>
      </div>
    </div>
  )

  const dreamsBody = (
    <div className="flex flex-col gap-2.5">
      {isTabs && (
        <div className="flex items-center justify-between">
          <Caption className="text-ink-muted">
            {dreams.length === 0 ? translate(language, 'cloudDreamsEmpty') : ''}
          </Caption>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRunDream()}
            disabled={dreamRunning}
          >
            {dreamRunning ? <Spinner size={13} /> : <Sparkles size={13} aria-hidden="true" />}
            {translate(language, 'cloudMemoryRunDream')}
          </Button>
        </div>
      )}
      {!isTabs && dreamFeedback && (
        <Caption className={dreamFeedback.tone === 'error' ? 'text-danger' : 'text-accent'}>
          {dreamFeedback.text}
        </Caption>
      )}
      {dreams.length === 0 ? (
        !isTabs ? (
          <Caption className="text-ink-muted">
            {translate(language, 'cloudWebDreamsEmptyHint')}
          </Caption>
        ) : null
      ) : (
        <ul
          className={
            isTabs
              ? 'm-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0'
              : 'm-0 flex list-none flex-col gap-2 p-0'
          }
        >
          {dreams.map((dream) => (
            <li
              key={dream.id}
              className={
                isTabs
                  ? 'flex flex-col gap-1 rounded border border-rule-divide bg-panel px-3 py-2'
                  : 'flex flex-col gap-0.5 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0'
              }
            >
              <div className="flex items-center gap-2">
                <DataText className="text-ink-muted">
                  {isTabs
                    ? new Date(dream.at).toLocaleString()
                    : formatCloudTime(dream.at, true)}
                </DataText>
                <Caption className="text-ink-muted">
                  {isTabs ? '· ' : ''}
                  {translate(
                    language,
                    dream.trigger === 'manual' ? 'cloudDreamTriggerManual' : 'cloudDreamTriggerIdle'
                  )}
                </Caption>
                <DataText className="ml-auto text-ink-muted">
                  +{dream.added} / -{dream.removed}
                </DataText>
              </div>
              <p className="m-0 type-body text-ink">{dream.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const deleteConfirmModal = confirmDelete ? (
    <CloudConfirmDangerModal
      open={Boolean(pendingDelete)}
      language={language}
      title={translate(language, 'cloudWebMemoryDeleteTitle')}
      description={
        pendingDelete
          ? translate(language, 'cloudWebMemoryDeleteConfirm', {
              preview: `${pendingDelete.content.slice(0, 80)}${
                pendingDelete.content.length > 80 ? '…' : ''
              }`,
            })
          : ''
      }
      confirmLabel={translate(language, 'cloudWebMemoryDeleteConfirmAction')}
      busy={deletingMemory}
      onCancel={() => setPendingDelete(null)}
      onConfirm={async () => {
        if (!pendingDelete || deletingMemory) return
        setDeletingMemory(true)
        try {
          const res = await onDeleteMemory(pendingDelete.id)
          if (res.ok) {
            if (editingId === pendingDelete.id) setEditingId(null)
            setPendingDelete(null)
          } else {
            if (res.error) setMemoryFeedback({ text: res.error, tone: 'error' })
            setPendingDelete(null)
          }
        } finally {
          setDeletingMemory(false)
        }
      }}
    />
  ) : null

  if (isTabs) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2 border-b border-rule-divide">
          <div
            role="tablist"
            aria-label={translate(language, 'cloudMemorySection')}
            className="flex items-center gap-1"
          >
            <Tab
              size="sm"
              active={tab === 'memories'}
              label={`${translate(language, 'cloudMemoryItemsTab')} (${memories.length})`}
              onSelect={() => setTab('memories')}
            />
            <Tab
              size="sm"
              active={tab === 'docs'}
              label={translate(language, 'cloudMemoryDocsTab')}
              onSelect={() => setTab('docs')}
            />
            <Tab
              size="sm"
              active={tab === 'dreams'}
              label={`${translate(language, 'cloudMemoryDreamsTab')} (${dreams.length})`}
              onSelect={() => setTab('dreams')}
            />
          </div>
          <div className="ml-auto pb-1">
            <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={loading}>
              {loading ? <Spinner size={13} /> : <RefreshCw size={13} aria-hidden="true" />}
              {translate(language, 'cloudRefresh')}
            </Button>
          </div>
        </div>

        {tab === 'memories' && memorySectionBody}
        {tab === 'docs' && docEditorBody}
        {tab === 'dreams' && dreamsBody}
        {deleteConfirmModal}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={translate(language, 'cloudWebMemoryTitle')}
          action={
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => void onRefresh()}
            >
              {loading
                ? translate(language, 'cloudWebMemoryRefreshing')
                : translate(language, 'cloudRefresh')}
            </Button>
          }
        />
        <div className="mt-3">{memorySectionBody}</div>
      </Card>

      <Card>
        <CardHeader title={translate(language, 'cloudWebDocsTitle')} action={docSwitcher} />
        <div className="mt-3">{docEditorBody}</div>
      </Card>

      <Card>
        <CardHeader
          title={translate(language, 'cloudWebDreamsTitle')}
          action={
            <Button
              variant="secondary"
              size="sm"
              disabled={dreamRunning}
              onClick={() => void handleRunDream()}
            >
              {dreamRunning
                ? translate(language, 'cloudWebDreamsRunning')
                : translate(language, 'cloudMemoryRunDream')}
            </Button>
          }
        />
        <div className="mt-3">{dreamsBody}</div>
      </Card>

      {deleteConfirmModal}
    </div>
  )
}
