import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  Image,
  Loader2,
  Music,
  PanelLeftClose,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { useSettingsStore } from '../store/settingsStore'
import { localizeError } from '../i18n/errors'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { toast } from '../store/toastStore'
import {
  flattenVisibleTree,
  sortTreeEntries,
  sortTreeNodes,
  type ExplorerSortBy,
  type SortTreeOptions,
} from '../utils/fileTree'
import { persistAppSettings } from '../utils/persistSettings'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { VirtualRows } from './VirtualRows'
import { Button, EmptyState, IconButton, Input, MenuOption, Modal, PopoverMenu } from './ui'
import { dirname, joinPath } from '../utils/filePath'
import { onAppEvent } from '../utils/appEvents'
import { detectFileKind } from '../utils/fileKind'
import { openFileInEditor } from '../workspace/openFileInEditor'


interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface TreeNode extends FileEntry {
  isExpanded?: boolean
  children?: TreeNode[]
}

/** 刷新目录时保留已有节点的展开状态与已加载的子节点 */
function mergeTree(previous: TreeNode[], incoming: TreeNode[]): TreeNode[] {
  const byPath = new Map(previous.map((node) => [node.path, node]))
  return incoming.map((node) => {
    const existing = byPath.get(node.path)
    return existing
      ? { ...node, isExpanded: existing.isExpanded, children: existing.children }
      : node
  })
}

/** 按扩展名挑一个文件图标（与编辑区的类型分发保持一致） */
function fileIconFor(name: string) {
  const kind = detectFileKind(name)
  if (kind === 'image') return Image
  if (kind === 'video') return Film
  if (kind === 'audio') return Music
  if (kind === 'html') return Globe
  if (kind === 'markdown' || kind === 'pdf') return FileText
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|css)$/i.test(name)) return FileCode
  if (/\.json$/i.test(name)) return FileJson
  return FileIcon
}

interface CreateFileDialogState {
  isOpen: boolean
  fileName: string
  parentPath: string | null
}

export const FileExplorer: React.FC<{
  workspacePath?: string
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  active?: boolean
}> = ({
  workspacePath,
  onCollapse,
  collapseButtonRef,
  panelId = 'file-panel',
  active = true,
}) => {
  const { t } = useI18nStore()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [createDialog, setCreateDialog] = useState<CreateFileDialogState>({
    isOpen: false,
    fileName: '',
    parentPath: null,
  })
  const [contextMenu, setContextMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const explorerSortBy = useSettingsStore((state) => state.explorerSortBy)
  const explorerFoldersFirst = useSettingsStore((state) => state.explorerFoldersFirst)
  const explorerSortReverse = useSettingsStore((state) => state.explorerSortReverse)
  const sortOptions = useMemo<SortTreeOptions>(
    () => ({
      by: explorerSortBy,
      foldersFirst: explorerFoldersFirst,
      reverse: explorerSortReverse,
    }),
    [explorerSortBy, explorerFoldersFirst, explorerSortReverse]
  )
  const editorStore = workspacePath ? editorStoreFor(workspacePath) : null
  const currentFilePath = useEditorStore(workspacePath, (state) => state.currentFile?.path)

  const flatRows = useMemo(() => flattenVisibleTree(tree), [tree])
  const { parentRef: treeScrollRef, virtualizer } = useVirtualRows({
    count: flatRows.length,
    estimateSize: 28,
  })

  // 保存最新树，供异步刷新读取（避免闭包拿到旧的展开状态）
  const treeRef = useRef<TreeNode[]>([])
  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  // 异步加载完成后读取最新排序选项，避免闭包拿到旧值
  const sortOptionsRef = useRef<SortTreeOptions>(sortOptions)
  useEffect(() => {
    sortOptionsRef.current = sortOptions
  }, [sortOptions])

  // 排序偏好变化时重排已加载的树，不必重新读取磁盘
  useEffect(() => {
    setTree((previous) => (previous.length > 0 ? sortTreeNodes(previous, sortOptions) : previous))
  }, [sortOptions])

  /** 递归刷新所有已展开目录的子节点，保持展开状态 */
  const refreshExpanded = useCallback(async function refresh(nodes: TreeNode[]): Promise<TreeNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (!node.isDirectory || !node.isExpanded) return node
        const result = await api.listDirectory(node.path)
        if (!result.success || !result.items) return node
        const merged = mergeTree(node.children ?? [], sortTreeEntries(result.items, sortOptionsRef.current))
        return { ...node, children: await refresh(merged) }
      })
    )
  }, [])

  const loadRootDirectory = useCallback(async (rootPath: string) => {
    try {
      setLoading(true)
      setError(null)
      const dirResult = await api.listDirectory(rootPath)
      if (dirResult.success && dirResult.items) {
        const merged = mergeTree(treeRef.current, sortTreeEntries(dirResult.items, sortOptionsRef.current))
        setTree(await refreshExpanded(merged))
      } else {
        setError(dirResult.error || 'Failed to list workspace directory')
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(localizeError(errorMsg))
      toast.error(t('loadWorkspaceFailed', { error: localizeError(errorMsg) }))
    } finally {
      setLoading(false)
    }
  }, [refreshExpanded, t])

  // Initialize tree when workspace changes
  useEffect(() => {
    if (workspacePath) {
      loadRootDirectory(workspacePath)
    }
  }, [workspacePath, loadRootDirectory])

  // 文件系统变化时刷新目录树（只在新增/删除/重命名时刷新，忽略编辑器保存）
  // 防抖合并批量事件，避免一次批量操作触发多次根目录重建
  useEffect(() => {
    if (!workspacePath) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void loadRootDirectory(workspacePath)
      }, 200)
    }
    const unsubscribe = api.onFsChanged((payload) => {
      if (payload.type !== 'rename') return
      const root = workspacePath.replace(/\\/g, '/')
      const changed = payload.path.replace(/\\/g, '/')
      if (changed !== root && !changed.startsWith(`${root}/`)) return
      scheduleRefresh()
    })
    // Agent 直接写盘时，渲染层在收到本轮修改后主动要求刷新
    const onManualRefresh = () => {
      if (active) scheduleRefresh()
    }
    const offRefresh = onAppEvent('pi:refresh-files', onManualRefresh)
    return () => {
      unsubscribe()
      offRefresh()
      if (timer) clearTimeout(timer)
    }
  }, [workspacePath, loadRootDirectory, active])

  const loadDirectory = async (path: string): Promise<FileEntry[]> => {
    try {
      const result = await api.listDirectory(path)
      if (!result.success || !result.items) {
        throw new Error(result.error || 'Failed to list directory')
      }
      return sortTreeEntries(result.items, sortOptionsRef.current)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      toast.error(t('loadDirectoryFailed', { error: localizeError(errorMsg) }))
      setError(localizeError(errorMsg))
      return []
    }
  }

  const toggleFolder = async (node: TreeNode) => {
    if (!node.isDirectory) return

    const updateNode = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.map(n => {
        if (n.path === node.path) {
          // Found the node to toggle
          if (n.isExpanded) {
            // Collapse
            return { ...n, isExpanded: false }
          } else {
            // Expand - load children if needed
            return { ...n, isExpanded: true }
          }
        }
        // Recursively update children
        if (n.children) {
          return { ...n, children: updateNode(n.children) }
        }
        return n
      })
    }

    // Load children if expanding and not loaded yet
    if (!node.isExpanded && !node.children) {
      const files = await loadDirectory(node.path)
      // Update the tree with loaded children
      const updateWithChildren = (nodes: TreeNode[]): TreeNode[] => {
        return nodes.map(n => {
          if (n.path === node.path) {
            return { ...n, children: files as TreeNode[], isExpanded: true }
          }
          if (n.children) {
            return { ...n, children: updateWithChildren(n.children) }
          }
          return n
        })
      }
      setTree((previous) => updateWithChildren(previous))
    } else {
      setTree((previous) => updateNode(previous))
    }
  }

  const handleFileClick = async (node: TreeNode) => {
    if (node.isDirectory) {
      return toggleFolder(node)
    }

    try {
      // 打开逻辑集中在 openFileInEditor：媒体走协议预览，二进制不会被当文本读入
      if (!workspacePath) throw new Error('No workspace selected')
      const outcome = await openFileInEditor(workspacePath, node.path, {
        skipLargeConfirm: false,
      })
      if (outcome.status === 'skipped' && outcome.reason === 'declined') return
      if (outcome.status === 'skipped' && outcome.error) {
        throw new Error(outcome.error)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('openFileFailed', { error: localizeError(errorMsg) }))
      setError(localizeError(errorMsg))
    }
  }

  const handleRename = async (node: TreeNode) => {
    setContextMenu(null)
    const newName = await promptDialog({
      title: t('rename'),
      message: t('renamePrompt'),
      defaultValue: node.name,
      confirmLabel: t('rename'),
    })
    if (!newName || newName === node.name) return

    try {
      const newPath = joinPath(dirname(node.path), newName)
      const result = await api.renamePath(node.path, newPath)
      if (!result.success) {
        throw new Error(result.error || 'Failed to rename')
      }

      // 关闭旧的编辑器标签（路径已失效）
      editorStore?.getState().removeOpenFile(node.path)
      toast.success(`${t('rename')}: ${newName}`)
      if (workspacePath) await loadRootDirectory(workspacePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('renameFailed', { error: localizeError(msg) }))
    }
  }

  const handleDelete = async (node: TreeNode) => {
    setContextMenu(null)
    if (
      !(await confirmDialog({
        message: t('deleteConfirm'),
        confirmLabel: t('delete'),
        danger: true,
      }))
    ) {
      return
    }

    try {
      const result = await api.deletePath(node.path)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete')
      }

      editorStore?.getState().removeOpenFile(node.path)
      toast.success(`${t('delete')}: ${node.name}`)
      if (workspacePath) await loadRootDirectory(workspacePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('deleteFailed', { error: localizeError(msg) }))
    }
  }

  const openCreateFileDialog = () => {
    setCreateDialog({
      isOpen: true,
      fileName: '',
      // 默认在工作区根目录创建
      parentPath: workspacePath ?? null,
    })
  }

  const handleCreateFile = async () => {
    if (!createDialog.fileName.trim()) {
      setError(t('fileNameEmpty'))
      return
    }

    if (!createDialog.parentPath) {
      setError(t('noWorkspaceSelected'))
      return
    }

    try {
      const filePath = joinPath(createDialog.parentPath, createDialog.fileName)
      const result = await api.writeFile(filePath, '')
      if (!result.success) {
        throw new Error(result.error || 'Failed to create file')
      }

      // Add to editor
      if (!workspacePath) throw new Error('No workspace selected')
      await openFileInEditor(workspacePath, filePath, { skipLargeConfirm: true })

      // Refresh the workspace tree
      if (workspacePath) {
        await loadRootDirectory(workspacePath)
      }

      // Close dialog
      setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
      setError(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('createFileFailed', { error: localizeError(errorMsg) }))
      setError(localizeError(errorMsg))
    }
  }

  const handleSortBy = (by: ExplorerSortBy) => {
    useSettingsStore.getState().setExplorerSortBy(by)
    void persistAppSettings({ explorerSortBy: by })
    setSortMenuOpen(false)
  }

  const handleFoldersFirstChange = () => {
    const next = !useSettingsStore.getState().explorerFoldersFirst
    useSettingsStore.getState().setExplorerFoldersFirst(next)
    void persistAppSettings({ explorerFoldersFirst: next })
  }

  const handleSortReverseChange = () => {
    const next = !useSettingsStore.getState().explorerSortReverse
    useSettingsStore.getState().setExplorerSortReverse(next)
    void persistAppSettings({ explorerSortReverse: next })
  }

  const renderRow = (node: TreeNode, depth: number) => {
    const active = currentFilePath === node.path
    const NodeIcon = node.isDirectory ? (node.isExpanded ? FolderOpen : Folder) : fileIconFor(node.name)

    return (
      <div
        key={node.path}
        role="treeitem"
        aria-selected={active}
        aria-expanded={node.isDirectory ? !!node.isExpanded : undefined}
        className={`flex h-7 cursor-pointer select-none items-center gap-1.5 border-l-2 pr-2 type-value transition-colors ${
          active
            ? 'border-accent bg-accent/[0.06] text-ink'
            : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => handleFileClick(node)}
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({ node, x: event.clientX, y: event.clientY })
        }}
      >
        <NodeIcon size={14} className="flex-shrink-0 text-ink-muted" />
        <span className="truncate">{node.name}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel">
      <div
        className={`flex h-[34px] flex-shrink-0 items-center justify-between border-b border-rule-divide pl-3 ${
          onCollapse ? 'pr-2' : 'pr-3'
        }`}
      >
        <h3 className="m-0 type-label text-ink-muted">
          {t('files')}
        </h3>
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={13} className="animate-spin text-ink-muted" />}
          {error && (
            <span title={error} className="text-warning">
              <AlertTriangle size={13} />
            </span>
          )}
          <div className="relative">
            <IconButton
              icon={ArrowUpDown}
              label={t('sortFiles')}
              size="sm"
              active={sortMenuOpen}
              aria-pressed={undefined}
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
              onClick={() => setSortMenuOpen((open) => !open)}
            />
            <PopoverMenu
              open={sortMenuOpen}
              onClose={() => setSortMenuOpen(false)}
              label={t('sortFiles')}
              placement="down"
              className="w-36 py-1"
            >
              <MenuOption
                selected={explorerSortBy === 'name'}
                onSelect={() => handleSortBy('name')}
              >
                {t('sortByName')}
              </MenuOption>
              <MenuOption
                selected={explorerSortBy === 'type'}
                onSelect={() => handleSortBy('type')}
              >
                {t('sortByType')}
              </MenuOption>
              <div role="separator" className="my-1 border-t border-rule-divide" />
              <MenuOption
                role="menuitemcheckbox"
                selected={explorerFoldersFirst}
                onSelect={handleFoldersFirstChange}
              >
                {t('sortFoldersFirst')}
              </MenuOption>
              <MenuOption
                role="menuitemcheckbox"
                selected={explorerSortReverse}
                onSelect={handleSortReverseChange}
              >
                {t('sortReverse')}
              </MenuOption>
            </PopoverMenu>
          </div>
          <IconButton
            icon={Plus}
            label={t('createNewFile')}
            size="sm"
            onClick={openCreateFileDialog}
          />
          {onCollapse && (
            <IconButton
              ref={collapseButtonRef}
              icon={PanelLeftClose}
              label={t('collapseSidebar')}
              size="sm"
              aria-controls={panelId}
              aria-expanded
              onClick={onCollapse}
            />
          )}
        </div>
      </div>

      {contextMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)}>
          <div
            className="absolute min-w-[150px] overflow-hidden border border-line bg-raised py-1 shadow-print"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
              onClick={() => handleRename(contextMenu.node)}
            >
              <Pencil size={13} className="text-ink-muted" />
              {t('rename')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-danger hover:bg-danger/10"
              onClick={() => handleDelete(contextMenu.node)}
            >
              <Trash2 size={13} />
              {t('delete')}
            </button>
          </div>
        </div>
      )}

      <Modal
        open={createDialog.isOpen}
        onClose={() => setCreateDialog({ isOpen: false, fileName: '', parentPath: null })}
        title={t('createFile')}
        size="sm"
        closeLabel={t('close')}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCreateDialog({ isOpen: false, fileName: '', parentPath: null })}
            >
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleCreateFile}>
              {t('create')}
            </Button>
          </>
        }
      >
        <div className="p-4">
          <Input
            type="text"
            placeholder={t('fileName')}
            value={createDialog.fileName}
            onChange={(e) => setCreateDialog({ ...createDialog, fileName: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFile()
              if (e.key === 'Escape')
                setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
            }}
            autoFocus
          />
        </div>
      </Modal>

      <div ref={treeScrollRef} className="flex-1 overflow-y-auto py-1" role="tree">
        {error && (
          <div className="mx-2 mb-1 border border-danger/30 bg-danger/5 px-2.5 py-1.5">
            <p className="m-0 type-caption text-danger">{error}</p>
          </div>
        )}
        {tree.length === 0 && !loading ? (
          <EmptyState compact icon={FolderOpen} title={t('noWorkspace')} />
        ) : (
          <VirtualRows
            virtualizer={virtualizer}
            items={flatRows}
            getKey={(row) => row.node.path}
            fallbackCount={40}
            renderItem={(row) => renderRow(row.node, row.depth)}
          />
        )}
      </div>
    </div>
  )
}
