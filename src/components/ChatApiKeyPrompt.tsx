/** API Key 未配置时的提示 */

import React from 'react'
import { Settings2 } from 'lucide-react'
import { Button, EmptyState } from './ui'
import { emitAppEvent } from '../utils/appEvents'
import { ChatPanelHeader } from './ChatPanelHeader'

export interface ChatApiKeyPromptProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t: (key: any) => string
  fatalError: string | null
  /** 头部的工作树 chip 需要工作区路径 */
  workspacePath?: string
}

/** API 未配置时聊天面板仍是可拆分的面板，头部复用 ChatPanelHeader */
export const ChatApiKeyPrompt: React.FC<ChatApiKeyPromptProps> = ({
  onCollapse,
  collapseButtonRef,
  panelId,
  t,
  fatalError,
  workspacePath
}) => (
  <div className="flex h-full flex-col bg-surface">
    <ChatPanelHeader
      onCollapse={onCollapse}
      collapseButtonRef={collapseButtonRef}
      panelId={panelId}
      t={t}
      workspacePath={workspacePath}
      initialized
    />
    <div className="flex flex-1 items-center justify-center p-4">
      <EmptyState
        icon={Settings2}
        title={t('apiConfigRequired')}
        description={fatalError ? `${t('agentInitFailed')}: ${fatalError}` : t('apiConfigRequiredDesc')}
        action={
          <Button variant="primary" size="sm" icon={Settings2} onClick={() => emitAppEvent('open-settings')}>
            {t('goToSettings')}
          </Button>
        }
      />
    </div>
  </div>
)
