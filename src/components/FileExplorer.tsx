import React, { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'

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
    const newName = window.prompt(t('renamePrompt'), node.name)
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
    if (!window.confirm(t('deleteConfirm'))) return

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

    return (
      <div key={node.path}>
        <div
          className="flex items-center gap-2 px-2 py-1 hover:bg-gray-200 dark:hover:bg-[#2d2d30] cursor-pointer select-none"
          style={{ paddingLeft: `${depth * 16}px` }}
          onClick={() => handleFileClick(node)}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ node, x: event.clientX, y: event.clientY })
          }}
        >
          {node.isDirectory && (
            <span className="text-base">
              {node.isExpanded ? '📂' : '📁'}
            </span>
          )}
          {!node.isDirectory && <span className="text-base">📄</span>}
          <span className="text-gray-900 dark:text-gray-100">{node.name}</span>
        </div>
        {node.isDirectory && node.isExpanded && node.children && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1, newVisited))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#1e1e1e] border-r border-gray-200 dark:border-gray-700 w-64 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h3 className="text-base font-semibold m-0 text-gray-900 dark:text-gray-100">{t('files')}</h3>
        <div className="flex items-center gap-2">
          <button
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-[#2d2d30] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer border-none bg-none text-sm"
            onClick={openCreateFileDialog}
            title={t('createNewFile')}
          >
            ✚
          </button>
          {loading && <span className="text-base">⌛</span>}
          {error && <span className="text-base">⚠️</span>}
        </div>
      </div>

      {contextMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)}>
          <div
            className="absolute bg-white dark:bg-[#252526] border border-gray-300 dark:border-gray-600 rounded shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-[#2d2d30] border-none bg-none cursor-pointer"
              onClick={() => handleRename(contextMenu.node)}
            >
              {t('rename')}
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-[#2d2d30] border-none bg-none cursor-pointer"
              onClick={() => handleDelete(contextMenu.node)}
            >
              {t('delete')}
            </button>
          </div>
        </div>
      )}

      {createDialog.isOpen && (
        <div className="fixed inset-0 z-50">
          <div className="fixed inset-0 bg-black/50 cursor-pointer" onClick={() => setCreateDialog({ isOpen: false, fileName: '', parentPath: null })} />
          <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#1e1e1e] border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-6 z-50 w-96">
            <h4 className="text-lg font-semibold mb-4 m-0 text-gray-900 dark:text-gray-100">{t('createFile')}</h4>
            <input
              type="text"
              placeholder={t('fileName')}
              value={createDialog.fileName}
              onChange={(e) =>
                setCreateDialog({ ...createDialog, fileName: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile()
                if (e.key === 'Escape')
                  setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
              }}
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-[#252526] text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={handleCreateFile} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 border-none cursor-pointer font-medium">
                {t('create')}
              </button>
              <button
                onClick={() =>
                  setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
                }
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded hover:bg-gray-300 dark:hover:bg-gray-600 border-none cursor-pointer font-medium"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-700/50">
            <p className="text-red-700 dark:text-red-400 text-sm m-0">{error}</p>
          </div>
        )}
        {tree.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500 dark:text-gray-400">{t('noWorkspace')}</div>
        ) : (
          <div>
            {tree.map((node) => renderNode(node))}
          </div>
        )}
      </div>
    </div>
  )
}
