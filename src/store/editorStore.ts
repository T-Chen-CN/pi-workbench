// 带相等函数的 useStore：zustand v4 的 `useStore` 传 equalityFn 会报弃用警告
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { OpenFile, OpenFileInput, EditorState } from '../types'
import { defaultViewFor, detectFileKind, supportsSourceView, type FileViewMode } from '../utils/fileKind'

export interface EditorStore extends EditorState {
  /**
   * 编辑区当前显示工作区面板（标签条最左那枚固定标签）。
   * 这是运行期状态：不进 `EditorState`，也不写 editor-tabs.json。
   */
  panelActive: boolean
  setPanelActive: (active: boolean) => void
  /** 待定位的文件与行号（R-09），编辑器就绪后消费 */
  pendingReveal: { path: string; line: number } | null
  setCurrentFile: (file: OpenFile | null) => void
  addOpenFile: (file: OpenFileInput) => void
  revealLine: (path: string, line: number) => void
  consumeReveal: () => void
  removeOpenFile: (path: string) => void
  updateOpenFile: (path: string, changes: Partial<OpenFile>) => void
  /** 切换当前文件的阅读 / 源码视图（仅 Markdown 与 HTML 有效） */
  setFileView: (path: string, view: FileViewMode) => void
  toggleFileView: (path: string) => void
  /** 媒体文件外部变更后递增版本号，触发预览重新加载 */
  touchFile: (path: string) => void
  markDirty: (path: string) => void
  markClean: (path: string) => void
  reset: () => void
  hasDirtyFiles: () => boolean
}

/** 补齐 kind / view / version：老调用点不必关心视图细节 */
function normalizeOpenFile(file: OpenFileInput): OpenFile {
  const kind = file.kind ?? detectFileKind(file.name || file.path)
  return {
    ...file,
    kind,
    view: file.view ?? defaultViewFor(kind),
    version: file.version ?? 0,
  }
}

/** 每个打开的工作区各持有一份编辑器状态，切换工作区时互不覆盖 */
export function createEditorStore(): StoreApi<EditorStore> {
  return createStore<EditorStore>((set, get) => ({
    currentFile: null,
    openFiles: [],
    unsavedChanges: new Set(),
    pendingReveal: null,
    // 面板是预览区的默认内容：新工作区、重启后都先看到它
    panelActive: true,

    setPanelActive: (active) => set({ panelActive: active }),

    setCurrentFile: (file) => set({ currentFile: file }),

    revealLine: (path, line) =>
      set({ pendingReveal: { path, line: Math.max(1, Math.floor(line)) } }),

    consumeReveal: () => set({ pendingReveal: null }),

    addOpenFile: (input) =>
      set((state) => {
        const file = normalizeOpenFile(input)
        const exists = state.openFiles.find((f) => f.path === file.path)
        if (exists) return { currentFile: exists }
        const newDirty = new Set(state.unsavedChanges)
        newDirty.delete(file.path)
        return {
          openFiles: [...state.openFiles, file],
          currentFile: file,
          unsavedChanges: newDirty,
        }
      }),

    removeOpenFile: (path) =>
      set((state) => {
        const newFiles = state.openFiles.filter((f) => f.path !== path)
        const newDirty = new Set(state.unsavedChanges)
        newDirty.delete(path)
        let currentFile = state.currentFile
        if (currentFile?.path === path) {
          currentFile = newFiles[newFiles.length - 1] || null
        }
        return {
          openFiles: newFiles,
          currentFile,
          unsavedChanges: newDirty,
          // 不存在「没有文件打开」的空状态：最后一个文件关掉就回面板
          ...(currentFile ? {} : { panelActive: true }),
        }
      }),

    updateOpenFile: (path, changes) =>
      set((state) => {
        const newFiles = state.openFiles.map((f) =>
          f.path === path ? { ...f, ...changes } : f
        )
        const currentFile =
          state.currentFile?.path === path
            ? { ...state.currentFile, ...changes }
            : state.currentFile

        return {
          openFiles: newFiles,
          currentFile,
        }
      }),

    setFileView: (path, view) =>
      set((state) => {
        const target = state.openFiles.find((file) => file.path === path)
        if (!target || !supportsSourceView(target.kind) || target.view === view) return {}
        const apply = (file: OpenFile): OpenFile =>
          file.path === path ? { ...file, view } : file
        return {
          openFiles: state.openFiles.map(apply),
          currentFile: state.currentFile ? apply(state.currentFile) : null,
        }
      }),

    toggleFileView: (path) => {
      const target = get().openFiles.find((file) => file.path === path)
      if (!target || !supportsSourceView(target.kind)) return
      get().setFileView(path, target.view === 'reading' ? 'source' : 'reading')
    },

    touchFile: (path) =>
      set((state) => {
        const apply = (file: OpenFile): OpenFile =>
          file.path === path ? { ...file, version: file.version + 1 } : file
        return {
          openFiles: state.openFiles.map(apply),
          currentFile: state.currentFile ? apply(state.currentFile) : null,
        }
      }),

    markDirty: (path) =>
      set((state) => {
        const newDirty = new Set(state.unsavedChanges)
        newDirty.add(path)
        return {
          unsavedChanges: newDirty,
          openFiles: state.openFiles.map((file) =>
            file.path === path ? { ...file, isDirty: true } : file
          ),
          currentFile:
            state.currentFile?.path === path
              ? { ...state.currentFile, isDirty: true }
              : state.currentFile,
        }
      }),

    markClean: (path) =>
      set((state) => {
        const newDirty = new Set(state.unsavedChanges)
        newDirty.delete(path)
        return {
          unsavedChanges: newDirty,
          openFiles: state.openFiles.map((file) =>
            file.path === path ? { ...file, isDirty: false } : file
          ),
          currentFile:
            state.currentFile?.path === path
              ? { ...state.currentFile, isDirty: false }
              : state.currentFile,
        }
      }),

    reset: () =>
      set({
        currentFile: null,
        openFiles: [],
        unsavedChanges: new Set(),
        pendingReveal: null,
        panelActive: true,
      }),

    hasDirtyFiles: () => {
      const state = get()
      return state.openFiles.some((file) => file.isDirty) || state.unsavedChanges.size > 0
    },
  }))
}

const stores = new Map<string, StoreApi<EditorStore>>()
const EMPTY_STORE = createEditorStore()

/** 取（必要时创建）某个工作区的编辑器 store；工作区为空时返回共享空 store */
export function editorStoreFor(workspacePath: string | null | undefined): StoreApi<EditorStore> {
  if (!workspacePath) return EMPTY_STORE
  let store = stores.get(workspacePath)
  if (!store) {
    store = createEditorStore()
    stores.set(workspacePath, store)
  }
  return store
}

/** 工作区被显式关闭后释放其编辑器状态 */
export function disposeEditorStore(workspacePath: string): void {
  stores.delete(workspacePath)
}

/** 仅供测试：清空所有工作区的编辑器 store */
export function resetEditorStores(): void {
  stores.clear()
}

export function useEditorStore(workspacePath: string | null | undefined): EditorStore
export function useEditorStore<T>(
  workspacePath: string | null | undefined,
  selector: (state: EditorStore) => T,
  /** 可选相等函数：选择器返回新对象 / 新数组时用它收窄重渲染（内容变化不再触发 UI 更新） */
  isEqual?: (a: T, b: T) => boolean
): T
export function useEditorStore<T>(
  workspacePath: string | null | undefined,
  selector?: (state: EditorStore) => T,
  isEqual?: (a: T, b: T) => boolean
): EditorStore | T {
  const store = editorStoreFor(workspacePath)
  return useStoreWithEqualityFn(store, selector ?? ((state) => state as unknown as T), isEqual)
}

/** 只关心「哪些标签开着」：编辑正文不算变化，避免每次按键重渲染标签条 / 附件菜单 */
export function sameOpenFileTabs(
  a: readonly OpenFile[],
  b: readonly OpenFile[]
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (
      a[index].path !== b[index].path ||
      a[index].name !== b[index].name ||
      a[index].kind !== b[index].kind ||
      a[index].isDirty !== b[index].isDirty ||
      a[index].isSaving !== b[index].isSaving
    ) {
      return false
    }
  }
  return true
}
