/** 聊天面板头部：收起按钮 + 标题 + 工作树 chip + 拖出柄（未配置 API 的空状态共用） */

import React from 'react'
import { PanelRightClose } from 'lucide-react'
import { IconButton } from './ui'
import { PanelDragHandle } from './PanelDragHandle'
import { usePanelContextMenu } from './PanelContextMenu'
import { WorktreeChip } from './WorktreeChip'

export interface ChatPanelHeaderProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t: (key: any) => string
  /** 有工作区时才渲染工作树 chip */
  workspacePath?: string
  /** false 表示 Agent 仍在初始化：标题退为「初始化中…」并显示脉冲点 */
  initialized?: boolean
}

/**
 * 聊天头部只有一层 34px。
 *
 * 左端图标（收起按钮）与下方会话标签的状态点、工作树 chip 的左边缘都落在 12px；
 * 常态不显示任何状态文字——「就绪」是恒真信息，只在初始化期间替代标题文案。
 */
export const ChatPanelHeader: React.FC<ChatPanelHeaderProps> = ({
  onCollapse,
  collapseButtonRef,
  panelId,
  t,
  workspacePath,
  initialized,
}) => {
  const panelMenu = usePanelContextMenu('chat')
  const initializing = initialized === false

  return (
    <>
      <div
        className={`flex h-[34px] flex-shrink-0 items-center gap-2 border-b border-rule-divide pr-3 ${
          onCollapse ? 'pl-0.5' : 'pl-3'
        }`}
        onContextMenu={panelMenu.onContextMenu}
      >
        {onCollapse && (
          <IconButton
            ref={collapseButtonRef}
            icon={PanelRightClose}
            label={t('collapseChat')}
            size="sm"
            aria-controls={panelId}
            aria-expanded
            onClick={onCollapse}
          />
        )}
        <h3 className="m-0 min-w-0 truncate type-label text-ink-muted">
          {initializing ? t('agentInitializingStatus') : t('agentChatTitle')}
        </h3>
        {initializing && (
          <span
            aria-hidden="true"
            className="h-1 w-1 flex-shrink-0 animate-pulse rounded-full bg-warning"
          />
        )}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {workspacePath && <WorktreeChip workspacePath={workspacePath} />}
          <PanelDragHandle panel="chat" />
        </div>
      </div>

      {panelMenu.menu}
    </>
  )
}
