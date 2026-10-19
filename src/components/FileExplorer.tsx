import React, { useState, useEffect } from 'react'
import { api } from '../api'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { handleError } from '../store/errorStore'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface TreeNode extends FileEntry {
  isExpanded?: boolean
  children?: TreeNode[]
}

interface CreateFileDialogState {
  isOpen: boolean
  fileName: string
  parentPath: string | null
}

export const FileExplorer: React.FC<{ workspacePath?: string }> = () => {
  const { t } = useI18nStore()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<CreateFileDialogState>({
    isOpen: false,
    fileName: '',
    parentPath: null,
  })
  const { addOpenFile } = useEditorStore.getState()

  // Initialize tree on mount
  useEffect(() => {
    loadRootDirectory()
  }, [])

  const loadRootDirectory = async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await api.openDirectoryDialog()
      if (!result.success || result.canceled || !result.path) {
        setLoading(false)
        return
      }
      const dirResult = await api.listDirectory(result.path)
      if (dirResult.success && dirResult.items) {
        const sortedFiles = dirResult.items.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return b.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setTree(sortedFiles as TreeNode[])
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      handleError(err, 'Load workspace', (msg) => console.error(msg))
    } finally {
      setLoading(false)
    }
  }

  const loadDirectory = async (path: string): Promise<FileEntry[]> => {
    try {
      const result = await api.listDirectory(path)
      if (!result.success || !result.items) {
        throw new Error(result.error || 'Failed to list directory')
      }
      return result.items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return b.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      handleError(error, `Load directory: ${path}`, (msg) => console.error(msg))
      setError(errorMsg)
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
      setTree(updateWithChildren(tree))
    } else {
      setTree(updateNode(tree))
    }
  }

  const handleFileClick = async (node: TreeNode) => {
    if (node.isDirectory) {
      return toggleFolder(node)
    }

    try {
      const result = await api.readFile(node.path)
      if (!result.success || !result.content) {
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
      handleError(err, `Open file: ${node.name}`, (msg) => console.error(msg))
      setError(errorMsg)
    }
  }

  const openCreateFileDialog = () => {
    setCreateDialog({
      isOpen: true,
      fileName: '',
      parentPath: tree.length > 0 ? tree[0].path : null,
    })
  }

  const handleCreateFile = async () => {
    if (!createDialog.fileName.trim()) {
      setError('File name cannot be empty')
      return
    }

    if (!createDialog.parentPath) {
      setError('No workspace selected')
      return
    }

    try {
      const filePath = `${createDialog.parentPath}/${createDialog.fileName}`
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

      // Refresh parent directory in tree
      await refreshDirectory(createDialog.parentPath)

      // Close dialog
      setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
      setError(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      handleError(err, `Create file: ${createDialog.fileName}`, (msg) => console.error(msg))
      setError(errorMsg)
    }
  }

  const refreshDirectory = async (dirPath: string) => {
    // Immutably update the tree by resetting the target directory
    const updateNode = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.map(node => {
        if (node.path === dirPath && node.isDirectory) {
          // Reset this directory node
          return { ...node, children: undefined, isExpanded: false }
        }
        if (node.children) {
          // Recursively update children
          return { ...node, children: updateNode(node.children) }
        }
        return node
      })
    }

    setTree(updateNode(tree))
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
      <div key={node.path} className="tree-item">
        <div
          className="tree-item-content"
          style={{ paddingLeft: `${depth * 16}px` }}
          onClick={() => handleFileClick(node)}
        >
          {node.isDirectory && (
            <span className="tree-icon">
              {node.isExpanded ? '📂' : '📁'}
            </span>
          )}
          {!node.isDirectory && <span className="tree-icon">📄</span>}
          <span className="tree-label">{node.name}</span>
        </div>
        {node.isDirectory && node.isExpanded && node.children && (
          <div className="tree-children">
            {node.children.map((child) => renderNode(child, depth + 1, newVisited))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="file-explorer">
      <div className="explorer-header">
        <h3>{t('files')}</h3>
        <div className="explorer-controls">
          <button
            className="btn-new-file"
            onClick={openCreateFileDialog}
            title={t('createNewFile')}
          >
            ✚
          </button>
          {loading && <span className="loading">⌛</span>}
          {error && <span className="error-indicator">⚠️</span>}
        </div>
      </div>

      {createDialog.isOpen && (
        <div className="create-file-dialog">
          <div className="dialog-overlay" onClick={() => setCreateDialog({ isOpen: false, fileName: '', parentPath: null })} />
          <div className="dialog-content">
            <h4>{t('createFile')}</h4>
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
            />
            <div className="dialog-actions">
              <button onClick={handleCreateFile} className="btn-primary">
                {t('create')}
              </button>
              <button
                onClick={() =>
                  setCreateDialog({ isOpen: false, fileName: '', parentPath: null })
                }
                className="btn-secondary"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="explorer-content">
        {error && (
          <div className="error-message">
            <p>{error}</p>
          </div>
        )}
        {tree.length === 0 && !loading ? (
          <div className="empty-state">{t('noWorkspace')}</div>
        ) : (
          <div className="tree">
            {tree.map((node) => renderNode(node))}
          </div>
        )}
      </div>
    </div>
  )
}
