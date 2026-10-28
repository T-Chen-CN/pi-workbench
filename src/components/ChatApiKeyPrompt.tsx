/** API Key 未配置时的提示 */

import React from 'react'
import { PanelRightClose, Settings2 } from 'lucide-react'
import { Button, EmptyState, IconButton } from './ui'
import { emitAppEvent } from '../utils/appEvents'
import { PanelDragHandle } from './PanelDragHandle'
import { usePanelContextMenu } from './PanelContextMenu'

export interface ChatApiKeyPromptProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t: (key: any) => string
  fatalError: string | null
}

/** API 未配置时聊天面板仍是可拆分的面板，头部入口与 ChatHeader 保持一致 */
export const ChatApiKeyPrompt: React.FC<ChatApiKeyPromptProps> = ({
  onCollapse,
  collapseButtonRef,
  panelId,
  t,
  fatalError
}) => {
  const panelMenu = usePanelContextMenu('chat')

  return (
    <div className="flex h-full flex-col bg-panel">
      {onCollapse && (
        <div
          className="flex h-[38px] flex-shrink-0 items-center gap-2.5 border-b border-rule-divide pl-2 pr-3.5"
          onContextMenu={panelMenu.onContextMenu}
        >
          <IconButton
            ref={collapseButtonRef}
            icon={PanelRightClose}
            label={t('collapseChat')}
            size="sm"
            aria-controls={panelId}
            aria-expanded
            onClick={onCollapse}
          />
          <h3 className="m-0 type-label text-ink-muted">{t('agentChatTitle')}</h3>
          <PanelDragHandle panel="chat" />
        </div>
      )}
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
      {panelMenu.menu}
    </div>
  )
}
