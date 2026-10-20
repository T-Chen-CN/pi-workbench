import React, { useState, useEffect, useCallback, useRef } from 'react'
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
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { toast } from '../store/toastStore'
import { Button, EmptyState, IconButton, Input, Modal } from './ui'

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

export const FileExplorer: React.FC<{ workspacePath?: string }> = ({ workspacePath }) => {
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
  const { addOpenFile } = useEditorStore.getState()
  const currentFilePath = useEditorStore((state) => state.currentFile?.path)

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
    const unsubscribe = api.onFsChanged((payload) => {
      if (payload.type !== 'rename') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void loadRootDirectory(workspacePath)
      }, 200)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [workspacePath, loadRootDirectory])

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
      addOpenFile({
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

  const dirname = (targetPath: string): string => {
    const index = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
    return index > 0 ? targetPath.slice(0, index) : targetPath
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
      useEditorStore.getState().removeOpenFile(node.path)
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

      useEditorStore.getState().removeOpenFile(node.path)
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

  // 简单的跨平台路径拼接（渲染进程不能使用 Node 的 path 模块）
  const joinPath = (dir: string, name: string): string => {
    const trimmed = dir.replace(/[\\/]+$/, '')
    const sep = trimmed.includes('\\') ? '\\' : '/'
    return `${trimmed}${sep}${name}`
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
      addOpenFile({
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

  const renderNode = (node: TreeNode, depth: number = 0, visited = new Set<string>()) => {
    // Prevent infinite recursion - max depth and cycle detection
    if (depth > 20 || visited.has(node.path)) {
      console.warn('FileExplorer: Max depth or cycle detected', node.path)
      return null
    }

    // Mark this path as visited for cycle detection
    const newVisited = new Set(visited)
    newVisited.add(node.path)

    const active = currentFilePath === node.path
    const NodeIcon = node.isDirectory ? (node.isExpanded ? FolderOpen : Folder) : fileIconFor(node.name)

    return (
      <div key={node.path}>
        <div
          role="treeitem"
          aria-selected={active}
          aria-expanded={node.isDirectory ? !!node.isExpanded : undefined}
          className={`flex h-7 cursor-pointer select-none items-center gap-1.5 border-l-2 pr-2 text-[12.5px] transition-colors ${
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
          <NodeIcon
            size={14}
            className={`flex-shrink-0 ${node.isDirectory ? 'text-ink-muted' : 'text-ink-subtle'}`}
          />
          <span className="truncate">{node.name}</span>
        </div>
        {node.isDirectory && node.isExpanded && node.children && (
          <div role="group">
            {node.children.map((child) => renderNode(child, depth + 1, newVisited))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel">
      <div className="flex h-[34px] flex-shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="m-0 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-subtle">
          {t('files')}
        </h3>
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={13} className="animate-spin text-ink-subtle" />}
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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-hover"
              onClick={() => handleRename(contextMenu.node)}
            >
              <Pencil size={13} className="text-ink-subtle" />
              {t('rename')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
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

      <div className="flex-1 overflow-y-auto py-1" role="tree">
        {error && (
          <div className="mx-2 mb-1 border border-danger/30 bg-danger/5 px-2.5 py-1.5">
            <p className="m-0 text-[11px] leading-relaxed text-danger">{error}</p>
          </div>
        )}
        {tree.length === 0 && !loading ? (
          <EmptyState compact icon={FolderOpen} title={t('noWorkspace')} />
        ) : (
          tree.map((node) => renderNode(node))
        )}
      </div>
    </div>
  )
}
