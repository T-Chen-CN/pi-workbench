/** API Key 未配置时的提示 */

import React from 'react'
import { PanelRightClose, Settings2 } from 'lucide-react'
import { Button, EmptyState, IconButton } from './ui'
import { emitAppEvent } from '../utils/appEvents'

export interface ChatApiKeyPromptProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t: (key: any) => string
  fatalError: string | null
}

export const ChatApiKeyPrompt: React.FC<ChatApiKeyPromptProps> = ({
  onCollapse,
  collapseButtonRef,
  panelId,
  t,
  fatalError,
}) => (

      <div className="flex h-full flex-col bg-panel">
        {onCollapse && (
          <div className="flex h-[38px] flex-shrink-0 items-center gap-2.5 border-b border-rule-divide pl-2 pr-3.5">
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
          </div>
        )}
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={Settings2}
            title={t('apiConfigRequired')}
            description={
              fatalError ? `${t('agentInitFailed')}: ${fatalError}` : t('apiConfigRequiredDesc')
            }
            action={
              <Button
                variant="primary"
                size="sm"
                icon={Settings2}
                onClick={() => emitAppEvent('open-settings')}
              >
                {t('goToSettings')}
              </Button>
            }
          />
        </div>
      </div>
    )
