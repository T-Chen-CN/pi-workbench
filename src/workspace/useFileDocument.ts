/**
 * 文件文档层：保存、自动保存、崩溃恢复草稿与外部变更同步。
 *
 * 这些职责原先写在 MonacoEditor 里，但 Markdown 阅读视图的块级编辑不经过
 * Monaco，必须抽到视图之上，否则在阅读视图里的修改不会自动保存。
 *
 * 预览类（图片 / 音视频 / PDF / 二进制）不参与文本逻辑：
 * 外部变更只递增 version，交给 `pw-file://` 地址刷新。
 */

import { useCallback, useEffect, useRef } from 'react'
import { api } from '../api'
import { editorStoreFor } from '../store/editorStore'
import { useSettingsStore } from '../store/settingsStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { isEditableKind, isStreamedKind } from '../utils/fileKind'
import type { OpenFile } from '../types'

/** 未保存内容写入草稿的防抖时间 */
const DRAFT_DEBOUNCE_MS = 500

export interface FileDocument {
  /** 立即保存（Ctrl+S 与自动保存都走这里） */
  save: (pathOverride?: string) => Promise<void>
}

type Timer = ReturnType<typeof setTimeout>

export interface FileDocumentOptions {
  /** 工作区根：草稿按工作区隔离 */
  workspacePath: string
  /** store 根：Git 工作树绑定后可能不同于工作区根 */
  root: string
  /** 只有可见工作区响应快捷键，避免多个常驻视图同时抢 Ctrl+S */
  active?: boolean
}

export function useFileDocument({
  workspacePath,
  root,
  active = true,
}: FileDocumentOptions): FileDocument {
  const store = editorStoreFor(root)
  const saveTimers = useRef(new Map<string, Timer>())
  const draftTimers = useRef(new Map<string, Timer>())
  /** 每个文件最近一次已排程保存的内容，避免重复触发 */
  const scheduledContent = useRef(new Map<string, string>())
  const saveRef = useRef<(pathOverride?: string) => Promise<void>>(async () => undefined)

  const clearTimers = useCallback((filePath: string) => {
    const pendingSave = saveTimers.current.get(filePath)
    if (pendingSave) {
      clearTimeout(pendingSave)
      saveTimers.current.delete(filePath)
    }
    const pendingDraft = draftTimers.current.get(filePath)
    if (pendingDraft) {
      clearTimeout(pendingDraft)
      draftTimers.current.delete(filePath)
    }
    scheduledContent.current.delete(filePath)
  }, [])

  /** 内容变化后按设置排程自动保存 */
  const scheduleSave = useCallback(
    (filePath: string) => {
      const previous = saveTimers.current.get(filePath)
      if (previous) clearTimeout(previous)
      const { autoSave, autoSaveDelay } = useSettingsStore.getState()
      if (!autoSave) return
      saveTimers.current.set(
        filePath,
        setTimeout(() => {
          saveTimers.current.delete(filePath)
          if (useSettingsStore.getState().autoSave) {
            void saveRef.current(filePath)
          }
        }, autoSaveDelay)
      )
    },
    []
  )

  const save = useCallback(
    async (pathOverride?: string) => {
      const targetPath = pathOverride ?? store.getState().currentFile?.path
      if (!targetPath) return

      // 手动保存时取消该文件尚未触发的自动保存，避免重复写入
      const pendingSave = saveTimers.current.get(targetPath)
      if (pendingSave) {
        clearTimeout(pendingSave)
        saveTimers.current.delete(targetPath)
      }
      scheduledContent.current.delete(targetPath)

      // 从 store 读取最新内容，避免闭包中的旧快照导致写回旧内容
      const latest = store.getState().openFiles.find((file) => file.path === targetPath)
      if (!latest || !isEditableKind(latest.kind)) return

      const contentToSave = latest.content

      try {
        store.getState().updateOpenFile(targetPath, { isSaving: true })
        const result = await api.writeFile(targetPath, contentToSave)
        if (!result.success) {
          throw new Error(result.error || 'Failed to save file')
        }

        // 写入期间用户可能继续输入：只有内容没再变化时才标记为已保存
        const afterSave = store.getState().openFiles.find((file) => file.path === targetPath)
        const changedDuringSave = Boolean(afterSave && afterSave.content !== contentToSave)

        if (changedDuringSave) {
          if (afterSave) {
            void api.draftSave(workspacePath, targetPath, afterSave.content).catch(() => undefined)
            scheduleSave(targetPath)
          }
        } else {
          const draftTimer = draftTimers.current.get(targetPath)
          if (draftTimer) {
            clearTimeout(draftTimer)
            draftTimers.current.delete(targetPath)
          }
          store.getState().markClean(targetPath)
          // 文件已落盘，删除对应的崩溃恢复草稿
          if (workspacePath) {
            void api.draftDelete(workspacePath, targetPath).catch(() => undefined)
          }
        }

        store.getState().updateOpenFile(targetPath, { isSaving: false })
        toast.success(useI18nStore.getState().t('savedFile', { name: latest.name }), 2000)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('Failed to save file:', error)
        toast.error(
          useI18nStore.getState().t('saveFileFailed', { error: localizeError(errorMsg) })
        )
        store.getState().updateOpenFile(targetPath, { isSaving: false })
      }
    },
    [store, workspacePath, scheduleSave]
  )

  saveRef.current = save
  // 内容变化：排程草稿与自动保存（对 Monaco 与阅读视图一视同仁）
  useEffect(() => {
    const unsubscribe = store.subscribe((state) => {
      const openPaths = new Set(state.openFiles.map((file) => file.path))

      // 标签关闭后回收该文件的计时器
      for (const filePath of [...saveTimers.current.keys()]) {
        if (!openPaths.has(filePath)) clearTimers(filePath)
      }
      for (const filePath of [...draftTimers.current.keys()]) {
        if (!openPaths.has(filePath)) {
          const timer = draftTimers.current.get(filePath)
          if (timer) clearTimeout(timer)
          draftTimers.current.delete(filePath)
        }
      }

      for (const file of state.openFiles) {
        if (!file.isDirty || !isEditableKind(file.kind)) continue
        if (scheduledContent.current.get(file.path) === file.content) continue
        scheduledContent.current.set(file.path, file.content)

        const pendingDraft = draftTimers.current.get(file.path)
        if (pendingDraft) clearTimeout(pendingDraft)
        if (workspacePath) {
          draftTimers.current.set(
            file.path,
            setTimeout(() => {
              draftTimers.current.delete(file.path)
              const latest = store.getState().openFiles.find((item) => item.path === file.path)
              if (!latest?.isDirty) return
              void api
                .draftSave(workspacePath, file.path, latest.content)
                .catch(() => undefined)
            }, DRAFT_DEBOUNCE_MS)
          )
        }

        scheduleSave(file.path)
      }
    })
    return unsubscribe
  }, [store, workspacePath, clearTimers, scheduleSave])

  // 外部文件变化：文本同步 / 媒体刷新 / 被删除时关闭标签
  useEffect(() => {
    const unsubscribe = api.onFsChanged(async (payload) => {
      const state = store.getState()
      const target: OpenFile | undefined = state.openFiles.find(
        (file) => file.path === payload.path
      )
      if (!target) return

      const existsResult = await api.exists(payload.path)
      if (existsResult.success && existsResult.exists === false) {
        clearTimers(payload.path)
        void api.draftDelete(workspacePath, payload.path).catch(() => undefined)
        store.getState().removeOpenFile(payload.path)
        toast.info(useI18nStore.getState().t('fileRemoved', { name: target.name }))
        return
      }

      // 媒体只刷新预览地址，不读文本
      if (isStreamedKind(target.kind) || target.kind === 'binary') {
        store.getState().touchFile(payload.path)
        return
      }

      if (target.isDirty) return

      const result = await api.readFile(payload.path)
      if (result.binary) {
        store.getState().updateOpenFile(payload.path, { kind: 'binary', content: '', view: 'source' })
        store.getState().markClean(payload.path)
        return
      }
      if (result.success && typeof result.content === 'string' && result.content !== target.content) {
        store.getState().updateOpenFile(payload.path, { content: result.content })
        store.getState().markClean(payload.path)
      }
    })

    return unsubscribe
  }, [clearTimers, store, workspacePath])

  // Ctrl/Cmd+S：只有可见工作区响应
  useEffect(() => {
    if (!active) return
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])

  // 卸载（关闭工作区 / 会话切换）前把未保存内容补成草稿
  useEffect(() => {
    const saveTimersMap = saveTimers.current
    const draftTimersMap = draftTimers.current
    const scheduledContentMap = scheduledContent.current
    return () => {
      for (const timer of saveTimersMap.values()) clearTimeout(timer)
      saveTimersMap.clear()
      for (const [filePath, timer] of draftTimersMap) {
        clearTimeout(timer)
        if (!workspacePath) continue
        const file = store.getState().openFiles.find((item) => item.path === filePath)
        if (file?.isDirty && isEditableKind(file.kind)) {
          void api.draftSave(workspacePath, filePath, file.content).catch(() => undefined)
        }
      }
      draftTimersMap.clear()
      scheduledContentMap.clear()
    }
  }, [store, workspacePath])

  return { save }
}
