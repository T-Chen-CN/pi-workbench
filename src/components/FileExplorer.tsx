import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AlertTriangle,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Loader2,
  PanelLeftClose,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { toast } from '../store/toastStore'
import { flattenVisibleTree } from '../utils/fileTree'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { VirtualRows } from './VirtualRows'
import { Button, EmptyState, IconButton, Input, Modal } from './ui'
import { dirname, joinPath } from '../utils/filePath'
import { onAppEvent } from '../utils/appEvents'

/** 超过该大小的文件打开前先确认，避免 Monaco 卡顿 */
const LARGE_FILE_BYTES = 5 * 1024 * 1024

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

/** 目录优先、名称排序 */
function sortEntries(items: FileEntry[]): TreeNode[] {
  return [...items].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return b.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** 按扩展名挑一个文件图标 */
function fileIconFor(name: string) {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) return FileCode
  if (/\.json$/i.test(name)) return FileJson
  if (/\.(md|markdown|txt)$/i.test(name)) return FileText
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name)) return Image
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
  const [createDialog, setCreateDialog] = useState<CreateFileDialogState>({
    isOpen: false,
    fileName: '',
    parentPath: null,
  })
  const [contextMenu, setContextMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
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

  /** 递归刷新所有已展开目录的子节点，保持展开状态 */
  const refreshExpanded = useCallback(async function refresh(nodes: TreeNode[]): Promise<TreeNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (!node.isDirectory || !node.isExpanded) return node
        const result = await api.listDirectory(node.path)
        if (!result.success || !result.items) return node
        const merged = mergeTree(node.children ?? [], sortEntries(result.items))
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
        const merged = mergeTree(treeRef.current, sortEntries(dirResult.items))
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
      return sortEntries(result.items)
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
      const info = await api.stat(node.path)
      if (info?.success && typeof info.size === 'number' && info.size > LARGE_FILE_BYTES) {
        const proceed = await confirmDialog({
          message: t('openLargeFileConfirm', {
            name: node.name,
            size: `${(info.size / 1024 / 1024).toFixed(1)} MB`,
          }),
        })
        if (!proceed) return
      }

      const result = await api.readFile(node.path)
      if (!result.success || typeof result.content !== 'string') {
        throw new Error(result.error || 'Failed to read file')
      }
      editorStore?.getState().addOpenFile({
        path: node.path,
        name: node.name,
        content: result.content,
        isDirty: false,
        isSaving: false,
      })
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
      editorStore?.getState().addOpenFile({
        path: filePath,
        name: createDialog.fileName,
        content: '',
        isDirty: false,
        isSaving: false,
      })

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
