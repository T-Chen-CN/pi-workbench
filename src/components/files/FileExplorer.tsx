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
  Presentation,
  Table2,
  Trash2
} from 'lucide-react'
import { api } from '../../api'
import { useEditorStore, editorStoreFor } from '../../store/editorStore'
import { useI18nStore } from '../../store/i18nStore'
import { usePanelContextMenu } from '../panels/PanelContextMenu'
import { readPanelUi, writePanelUi } from '../../panelHost/panelUiState'
import { PanelDragHandle } from '../panels/PanelDragHandle'
import { useSettingsStore } from '../../store/settingsStore'
import { localizeError } from '../../i18n/errors'
import { confirmDialog, promptDialog } from '../../store/dialogStore'
import { toast } from '../../store/toastStore'
import {
  flattenVisibleTree,
  sortTreeEntries,
  sortTreeNodes,
  type ExplorerSortBy,
  type SortTreeOptions
} from '../../utils/fileTree'
import { persistAppSettings } from '../../utils/persistSettings'
import { useVirtualRows } from '../../hooks/useVirtualRows'
import { VirtualRows } from '../ui/VirtualRows'
import { Button, EmptyState, IconButton, Input, MenuOption, Modal, PopoverMenu } from '../ui/ui'
import { dirname, isPathInside, joinPath, samePath } from '../../utils/filePath'
import { onAppEvent } from '../../utils/appEvents'
import { detectFileKind } from '../../utils/fileKind'
import { openFileInEditor } from '../../workspace/openFileInEditor'


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
    return existing ? { ...node, isExpanded: existing.isExpanded, children: existing.children } : node
  })
}

/** 已展开路径 → 只带 isExpanded 的骨架树，交给 loadRootDirectory 回填真实条目 */
function buildExpandedSkeleton(paths: string[], rootPath: string): TreeNode[] {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const roots: TreeNode[] = []
  const byPath = new Map<string, TreeNode>()

  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, '/')
    if (normalized === root || !normalized.startsWith(`${root}/`)) continue
    // 节点路径必须逐字复用 listDirectory 的写法（Windows 是反斜杠），
    // 否则 mergeTree 按路径对不上，展开状态会在回填时丢掉
    const base = raw.slice(0, root.length)
    const separator = raw.includes('\\') ? '\\' : '/'
    const segments = normalized.slice(root.length + 1).split('/')
    let parent: TreeNode | null = null
    let current = base
    for (const segment of segments) {
      current = `${current}${separator}${segment}`
      let node = byPath.get(current)
      if (!node) {
        node = {
          name: segment,
          path: current,
          isDirectory: true,
          isExpanded: true,
          children: []
        }
        byPath.set(current, node)
        if (parent) parent.children?.push(node)
        else roots.push(node)
      }
      parent = node
    }
  }
  return roots
}

/** 按扩展名挑一个文件图标（与编辑区的类型分发保持一致） */
function fileIconFor(name: string) {
  const kind = detectFileKind(name)
  if (kind === 'image') return Image
  if (kind === 'video') return Film
  if (kind === 'audio') return Music
  if (kind === 'html') return Globe
  if (kind === 'sheet') return Table2
  if (kind === 'slide') return Presentation
  if (kind === 'markdown' || kind === 'word' || kind === 'epub' || kind === 'pdf') return FileText
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
}> = React.memo(function FileExplorer({
  workspacePath,
  onCollapse,
  collapseButtonRef,
  panelId = 'file-panel',
  active = true,
}) {
  const t = useI18nStore((state) => state.t)
  const panelMenu = usePanelContextMenu('files')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [createDialog, setCreateDialog] = useState<CreateFileDialogState>({
    isOpen: false,
    fileName: '',
    parentPath: null
  })
  const [contextMenu, setContextMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const explorerSortBy = useSettingsStore((state) => state.explorerSortBy)
  const explorerFoldersFirst = useSettingsStore((state) => state.explorerFoldersFirst)
  const explorerSortReverse = useSettingsStore((state) => state.explorerSortReverse)
  const sortOptions = useMemo<SortTreeOptions>(
    () => ({
      by: explorerSortBy,
      foldersFirst: explorerFoldersFirst,
      reverse: explorerSortReverse
    }),
    [explorerSortBy, explorerFoldersFirst, explorerSortReverse]
  )
  const editorStore = workspacePath ? editorStoreFor(workspacePath) : null
  const currentFilePath = useEditorStore(workspacePath, (state) => state.currentFile?.path)

  const flatRows = useMemo(() => flattenVisibleTree(tree), [tree])
  const { parentRef: treeScrollRef, virtualizer } = useVirtualRows({
    count: flatRows.length,
    estimateSize: 28
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

  // 右键菜单支持按 Esc 关闭，必须监听当前宿主 document 以兼容拆出的独立窗口
  useEffect(() => {
    if (!contextMenu) return
    const doc = treeScrollRef.current?.ownerDocument ?? document
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setContextMenu(null)
    }
    doc.addEventListener('keydown', onKeyDown)
    return () => doc.removeEventListener('keydown', onKeyDown)
  }, [contextMenu, treeScrollRef])

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

  const loadSeqRef = useRef(0)

  const loadRootDirectory = useCallback(
    async (rootPath: string) => {
      const seq = ++loadSeqRef.current
      try {
        setLoading(true)
        setError(null)
        const dirResult = await api.listDirectory(rootPath)
        if (loadSeqRef.current !== seq) return
        if (dirResult.success && dirResult.items) {
          const merged = mergeTree(treeRef.current, sortTreeEntries(dirResult.items, sortOptionsRef.current))
          const refreshed = await refreshExpanded(merged)
          if (loadSeqRef.current !== seq) return
          setTree(refreshed)
        } else {
          setError(
            localizeError(dirResult.error || '') ||
              useI18nStore.getState().t('loadWorkspaceFailed', { error: '' })
          )
        }
      } catch (err) {
        if (loadSeqRef.current !== seq) return
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(localizeError(errorMsg))
        toast.error(
          useI18nStore.getState().t('loadWorkspaceFailed', { error: localizeError(errorMsg) })
        )
      } finally {
        if (loadSeqRef.current === seq) setLoading(false)
      }
    },
    [refreshExpanded]
  )

  // 拆窗重建时把展开的目录与滚动位置带过来（面板在另一个 document 里重挂）
  const restoreRef = useRef<{ scrollTop: number } | null>(null)
  // 首轮加载完成前不写回状态：拆出/回位过快时，空树会把好的快照盖掉
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!workspacePath) return
    const saved = readPanelUi<{ expanded: string[]; scrollTop: number }>(workspacePath, 'files')
    if (!saved) return
    restoreRef.current = { scrollTop: saved.scrollTop }
    if (saved.expanded.length > 0) {
      const skeleton = buildExpandedSkeleton(saved.expanded, workspacePath)
      treeRef.current = skeleton
      setTree(skeleton)
    }
  }, [workspacePath])

  useEffect(() => {
    if (!workspacePath) return
    // 卸载后 ref 已被清空：先抓住滚动容器
    const scrollEl = treeScrollRef.current
    return () => {
      if (!hydratedRef.current) return
      const expanded: string[] = []
      const walk = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          if (node.isDirectory && node.isExpanded) expanded.push(node.path)
          if (node.children) walk(node.children)
        }
      }
      walk(treeRef.current)
      writePanelUi(workspacePath, 'files', {
        expanded,
        scrollTop: scrollEl?.scrollTop ?? 0
      })
    }
  }, [workspacePath, treeScrollRef])

  const activeRef = useRef(active)
  activeRef.current = active
  const pendingFsRefreshRef = useRef(false)

  // Initialize tree when workspace changes
  useEffect(() => {
    pendingFsRefreshRef.current = false
    if (workspacePath) {
      void loadRootDirectory(workspacePath).then(() => {
        hydratedRef.current = true
      })
    }
  }, [workspacePath, loadRootDirectory])

  // 首帧加载完成后回到上次的滚动位置
  useEffect(() => {
    if (loading || !restoreRef.current) return
    const { scrollTop } = restoreRef.current
    restoreRef.current = null
    const frame = requestAnimationFrame(() => {
      if (treeScrollRef.current) treeScrollRef.current.scrollTop = scrollTop
    })
    return () => cancelAnimationFrame(frame)
  }, [loading, treeScrollRef])

  // 文件系统变化时刷新目录树（只在新增/删除/重命名时刷新，忽略编辑器保存）；
  // 非激活工作区仅记录待刷新标记，不立刻在后台递归发 listDirectory IPC，回到前台再单次合并刷新
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
      const norm = (value: string) => {
        const unix = value.replace(/\\/g, '/').replace(/\/+$/, '')
        return /^[A-Za-z]:\//.test(unix) ? unix.toLowerCase() : unix
      }
      const root = norm(workspacePath)
      const changed = norm(payload.path)
      if (changed !== root && !changed.startsWith(`${root}/`)) return
      if (!activeRef.current) {
        pendingFsRefreshRef.current = true
        return
      }
      scheduleRefresh()
    })
    // Agent 直接写盘时，渲染层在收到本轮修改后主动要求刷新
    const onManualRefresh = () => {
      if (!activeRef.current) {
        pendingFsRefreshRef.current = true
        return
      }
      scheduleRefresh()
    }
    const offRefresh = onAppEvent('pi:refresh-files', onManualRefresh)
    return () => {
      unsubscribe()
      offRefresh()
      if (timer) clearTimeout(timer)
    }
  }, [workspacePath, loadRootDirectory])

  // 后台休眠期间积攒的文件树变更在切回前台时一次性补刷
  useEffect(() => {
    if (!active || !workspacePath || !pendingFsRefreshRef.current) return
    pendingFsRefreshRef.current = false
    void loadRootDirectory(workspacePath)
  }, [active, workspacePath, loadRootDirectory])

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
      return nodes.map((n) => {
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
        return nodes.map((n) => {
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

  const closeAffectedEditorTabs = (node: TreeNode) => {
    const store = editorStore?.getState()
    if (!store) return
    const matches = store.openFiles.filter((file) =>
      node.isDirectory ? isPathInside(node.path, file.path) : samePath(node.path, file.path)
    )
    for (const file of matches) {
      store.removeOpenFile(file.path)
    }
  }

  const handleRename = async (node: TreeNode) => {
    setContextMenu(null)
    const newName = await promptDialog({
      title: t('rename'),
      message: t('renamePrompt'),
      defaultValue: node.name,
      confirmLabel: t('rename')
    })
    if (!newName || newName === node.name) return

    try {
      const newPath = joinPath(dirname(node.path), newName)
      const result = await api.renamePath(node.path, newPath)
      if (!result.success) {
        throw new Error(result.error || 'Failed to rename')
      }

      // 关闭旧的编辑器标签（含目录改名后失效的所有子文件标签）
      closeAffectedEditorTabs(node)
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
        danger: true
      }))
    ) {
      return
    }

    try {
      const result = await api.deletePath(node.path)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete')
      }

      closeAffectedEditorTabs(node)
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
      parentPath: workspacePath ?? null
    })
  }

  const creatingFileRef = useRef(false)

  const handleCreateFile = async () => {
    if (creatingFileRef.current) return
    const trimmedName = createDialog.fileName.trim()
    if (!trimmedName) {
      setError(t('fileNameEmpty'))
      return
    }

    if (!createDialog.parentPath) {
      setError(t('noWorkspaceSelected'))
      return
    }

    creatingFileRef.current = true
    try {
      const filePath = joinPath(createDialog.parentPath, trimmedName)
      const result = await api.createFile(filePath)
      if (!result.success) {
        const detail =
          result.code === 'EEXIST' ? 'File already exists' : result.error || 'Failed to create file'
        throw new Error(detail)
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
    } finally {
      creatingFileRef.current = false
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

  const focusRowAt = useCallback(
    (index: number) => {
      const target = flatRows[index]
      if (!target) return
      setFocusedPath(target.node.path)
      virtualizer.scrollToIndex(index, { align: 'auto' })
      const scrollEl = treeScrollRef.current
      if (!scrollEl) return
      const doc = scrollEl.ownerDocument
      ;(doc.defaultView ?? window).requestAnimationFrame(() => {
        const items = scrollEl.querySelectorAll<HTMLElement>('[role="treeitem"]')
        for (const item of items) {
          if (item.dataset.path === target.node.path) {
            item.focus()
            break
          }
        }
      })
    },
    [flatRows, virtualizer, treeScrollRef]
  )

  const activeFocusPath = useMemo(() => {
    if (focusedPath && flatRows.some((row) => row.node.path === focusedPath)) return focusedPath
    if (currentFilePath && flatRows.some((row) => row.node.path === currentFilePath)) return currentFilePath
    return flatRows[0]?.node.path ?? null
  }, [focusedPath, currentFilePath, flatRows])

  const renderRow = (node: TreeNode, depth: number, rowIndex: number) => {
    const active = currentFilePath === node.path
    const isTabbable = activeFocusPath === node.path
    const NodeIcon = node.isDirectory ? (node.isExpanded ? FolderOpen : Folder) : fileIconFor(node.name)

    return (
      <div
        key={node.path}
        data-path={node.path}
        role="treeitem"
        tabIndex={isTabbable ? 0 : -1}
        aria-selected={active}
        aria-expanded={node.isDirectory ? !!node.isExpanded : undefined}
        className={`flex h-7 cursor-pointer select-none items-center gap-1.5 border-l-2 pr-2 type-value transition-colors ${
          active
            ? 'border-accent bg-accent/[0.06] text-ink'
            : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onFocus={() => setFocusedPath(node.path)}
        onClick={() => {
          setFocusedPath(node.path)
          handleFileClick(node)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleFileClick(node)
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (rowIndex + 1 < flatRows.length) focusRowAt(rowIndex + 1)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (rowIndex > 0) focusRowAt(rowIndex - 1)
            return
          }
          if (event.key === 'Home') {
            event.preventDefault()
            if (flatRows.length > 0) focusRowAt(0)
            return
          }
          if (event.key === 'End') {
            event.preventDefault()
            if (flatRows.length > 0) focusRowAt(flatRows.length - 1)
            return
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            if (node.isDirectory) {
              if (!node.isExpanded) {
                handleFileClick(node)
              } else if (rowIndex + 1 < flatRows.length && flatRows[rowIndex + 1].depth > depth) {
                focusRowAt(rowIndex + 1)
              }
            }
            return
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            if (node.isDirectory && node.isExpanded) {
              handleFileClick(node)
            } else if (depth > 0) {
              for (let i = rowIndex - 1; i >= 0; i -= 1) {
                if (flatRows[i].depth < depth) {
                  focusRowAt(i)
                  break
                }
              }
            }
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          const ownerWin = event.currentTarget.ownerDocument.defaultView ?? window
          const x = Math.min(event.clientX, Math.max(8, ownerWin.innerWidth - 168))
          const y = Math.min(event.clientY, Math.max(8, ownerWin.innerHeight - 96))
          setContextMenu({ node, x, y })
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
        onContextMenu={panelMenu.onContextMenu}
        className={`flex h-[34px] flex-shrink-0 items-center justify-between border-b border-rule-divide pl-3 ${
          onCollapse ? 'pr-2' : 'pr-3'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <PanelDragHandle panel="files" />
          <h3 className="m-0 type-label text-ink-muted">{t('files')}</h3>
        </div>
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
              <MenuOption selected={explorerSortBy === 'name'} onSelect={() => handleSortBy('name')}>
                {t('sortByName')}
              </MenuOption>
              <MenuOption selected={explorerSortBy === 'type'} onSelect={() => handleSortBy('type')}>
                {t('sortByType')}
              </MenuOption>
              <div role="separator" className="my-1 border-t border-rule-divide" />
              <MenuOption role="menuitemcheckbox" selected={explorerFoldersFirst} onSelect={handleFoldersFirstChange}>
                {t('sortFoldersFirst')}
              </MenuOption>
              <MenuOption role="menuitemcheckbox" selected={explorerSortReverse} onSelect={handleSortReverseChange}>
                {t('sortReverse')}
              </MenuOption>
            </PopoverMenu>
          </div>
          <IconButton icon={Plus} label={t('createNewFile')} size="sm" onClick={openCreateFileDialog} />
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
        <div className="fixed inset-0 z-50">
          <div
            aria-hidden="true"
            className="absolute inset-0"
            onClick={() => setContextMenu(null)}
          />
          <div
            role="menu"
            tabIndex={-1}
            aria-label={contextMenu.node.name}
            className="absolute min-w-[150px] overflow-hidden border border-line bg-raised py-1 shadow-print"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
              onClick={() => handleRename(contextMenu.node)}
            >
              <Pencil size={13} className="text-ink-muted" />
              {t('rename')}
            </button>
            <button
              type="button"
              role="menuitem"
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
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                void handleCreateFile()
              }
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
            renderItem={(row, index) => renderRow(row.node, row.depth, index)}
          />
        )}
      </div>
      {panelMenu.menu}
    </div>
  )
})
