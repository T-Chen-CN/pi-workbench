/** 把 Agent 修改恢复为修改前内容：脏文件与冲突拒绝覆盖 */

import { useCallback, useState } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { confirmDialog } from '../store/dialogStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { revertFileEdit } from '../utils/revertFile'
import type { FileEdit } from '../types/electron'

export interface RevertEditsOptions {
  workspacePath: string
  /** 单个文件还原成功后同步 UI 状态 */
  onReverted?: (edit: FileEdit) => void
}

export function useRevertEdits({ workspacePath, onReverted }: RevertEditsOptions) {
  const { t } = useI18nStore()
  const [busy, setBusy] = useState(false)

  const revertOne = useCallback(
    async (edit: FileEdit): Promise<boolean> => {
      const result = await revertFileEdit(edit, workspacePath)
      if (!result.ok) {
        const detail =
          result.reason === 'dirty'
            ? t('revertBlockedDirty')
            : result.reason === 'conflict'
              ? t('revertConflict')
              : `${t('revertFailed')}: ${localizeError(result.error ?? '') || edit.path}`
        toast.error(detail)
        return false
      }
      onReverted?.(edit)
      return true
    },
    [t, workspacePath, onReverted]
  )

  const handleRevert = useCallback(
    async (edit: FileEdit) => {
      if (!(await confirmDialog({ message: t('revertConfirm'), danger: true }))) return
      setBusy(true)
      try {
        if (await revertOne(edit)) toast.success(t('reverted'))
      } finally {
        setBusy(false)
      }
    },
    [revertOne, t]
  )

  const handleRevertAll = useCallback(
    async (edits: FileEdit[]) => {
      if (!(await confirmDialog({ message: t('revertAllConfirm'), danger: true }))) return
      setBusy(true)
      let reverted = 0
      try {
        for (const edit of [...edits]) {
          if (await revertOne(edit)) reverted++
        }
        if (reverted > 0) {
          toast.success(reverted > 1 ? `${t('reverted')}: ${reverted}` : t('reverted'))
        }
      } finally {
        setBusy(false)
      }
    },
    [revertOne, t]
  )

  return { busy, revertOne, handleRevert, handleRevertAll }
}
