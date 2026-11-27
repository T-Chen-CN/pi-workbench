import React, { useMemo } from 'react'
import { ArrowDown } from 'lucide-react'
import { useChatPanelState } from '../../hooks/useChatPanelState'
import type { ChatPanelProps } from '../../utils/chatPanelShared'
import { useSessionStore } from '../../store/sessionStore'
import { MarkdownLinkScopeProvider } from '../../workspace/MarkdownLinkScope'
import { SelectionQuoteButton } from '../ui/SelectionQuoteButton'
import { useHostDocument, useHostId } from '../../panelHost/HostContext'
import { MAIN_HOST } from '../../panelHost/types'
import { ChatApiKeyPrompt } from './ChatApiKeyPrompt'
import { ChatApprovalBar } from './ChatApprovalBar'
import { ChatComposer } from './ChatComposer'
import { ChatHeader } from './ChatHeader'
import { ChatSessionList } from './ChatSessionList'
import { ChatStatusBar } from './ChatStatusBar'
import { ChatTranscript } from './ChatTranscript'
import { ToolResultViewer } from './ToolResultViewer'

export type { ChatPanelProps }

export const ChatPanel: React.FC<ChatPanelProps> = (props) => {
  const { workspacePath, viewRoot, onCollapse, collapseButtonRef, panelId } = props
  const {
    activeKey,
    activeSessionId,
    availableModels,
    diffToolIds,
    emptySuggestions,
    error,
    exportSession,
    fatalError,
    handleApprovalResponse,
    handleApprovePlan,
    handleCloseTab,
    handleCompact,
    handleCopyMessage,
    handleDeleteSession,
    handleEditMessage,
    handleExecutePlan,
    handleModelChange,
    handleNewSession,
    handleOpenToolResult,
    handleRejectPlan,
    handleRenameSession,
    handleResetPermissionGrants,
    handleRetryMessage,
    handleSelectSession,
    handleSessionModeChange,
    handleStop,
    handleSubmit,
    handleSwitchBranch,
    handleThinkingChange,
    handleTranscriptScroll,
    hideAttachMenuRef,
    imageProcessingCountRef,
    imagesAllowed,
    initialized,
    inputRef,
    isCompacting,
    isLoading,
    lastAssistantMessage,
    lastMessageId,
    lastUserMessageId,
    latestProposedPlan,
    messages,
    modelCapabilities,
    modelCapabilityText,
    needsApiKey,
    newMessageCount,
    openToolDiff,
    panelOpen,
    scrollToBottom,
    selectedModelCapability,
    sendSteer,
    sessionMeta,
    sessions,
    setShowArchived,
    setToolResultView,
    showArchived,
    showScrollButton,
    stopping,
    syncPromptResources,
    t,
    toggleArchive,
    togglePin,
    toolResultView,
    transcriptRef,
    virtualizer,
  } = useChatPanelState(props)

  // 聊天拆进辅助窗口后，选区在那个 document 里：单独挂一个只监听宿主文档的引用按钮
  const hostId = useHostId()
  const hostDocument = useHostDocument()

  // 保持上下文对象引用稳定，避免每次流式 delta 击穿 ChatMessageRow / AgentMarkdown 的 React.memo
  const linkScope = useMemo(
    () => ({ docDir: null as string | null, openRoot: viewRoot ?? workspacePath }),
    [viewRoot, workspacePath]
  )

  if (needsApiKey) {
    return (
      <ChatApiKeyPrompt
        onCollapse={onCollapse}
        collapseButtonRef={collapseButtonRef}
        panelId={panelId}
        t={t}
        fatalError={fatalError}
        workspacePath={workspacePath}
      />
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {hostId !== MAIN_HOST && <SelectionQuoteButton doc={hostDocument} />}

      <ChatHeader
        onCollapse={onCollapse}
        collapseButtonRef={collapseButtonRef}
        panelId={panelId}
        t={t}
        initialized={initialized}
        workspacePath={workspacePath}
        sessions={sessions}
        handleSelectSession={handleSelectSession}
        handleNewSession={handleNewSession}
        handleCloseTab={handleCloseTab}
      />

      <MarkdownLinkScopeProvider value={linkScope}>
        <ChatTranscript
          activeSessionId={activeSessionId}
          activeKey={activeKey}
          handleNewSession={handleNewSession}
          t={t}
          transcriptRef={transcriptRef}
          handleTranscriptScroll={handleTranscriptScroll}
          messages={messages}
          isLoading={isLoading}
          isCompacting={isCompacting}
          initialized={initialized}
          emptySuggestions={emptySuggestions}
          inputRef={inputRef}
          virtualizer={virtualizer}
          diffToolIds={diffToolIds}
          openToolDiff={openToolDiff}
          handleCopyMessage={handleCopyMessage}
          handleSwitchBranch={handleSwitchBranch}
          handleOpenToolResult={handleOpenToolResult}
          latestProposedPlan={latestProposedPlan}
          handleApprovePlan={handleApprovePlan}
          handleRejectPlan={handleRejectPlan}
          lastMessageId={lastMessageId}
          lastUserMessageId={lastUserMessageId}
          handleRetryMessage={handleRetryMessage}
          handleEditMessage={handleEditMessage}
          error={error}
          fatalError={fatalError}
          lastAssistantMessage={lastAssistantMessage}
        />
      </MarkdownLinkScopeProvider>

      {activeSessionId && (
        <div className="relative h-0 flex-shrink-0">
          {showScrollButton && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-2 right-4 z-10 flex items-center gap-1 border border-line bg-raised px-2 py-1 type-caption text-ink-muted shadow-print transition-colors hover:text-ink"
            >
              <ArrowDown size={12} />
              {newMessageCount > 0
                ? t('newMessages', { count: newMessageCount })
                : t('scrollToBottom')}
            </button>
          )}
        </div>
      )}

      {activeSessionId && (
        <div className="flex-shrink-0 p-2.5">
          <ChatApprovalBar
            workspacePath={workspacePath}
            activeSessionId={activeSessionId}
            activeKey={activeKey}
            onRespondApproval={handleApprovalResponse}
            onExecutePlan={handleExecutePlan}
            t={t}
          />
          <ChatComposer
            workspacePath={workspacePath}
            viewRoot={viewRoot}
            activeKey={activeKey}
            activeSessionId={activeSessionId}
            initialized={initialized}
            imagesAllowed={imagesAllowed}
            stopping={stopping}
            inputRef={inputRef}
            imageProcessingCountRef={imageProcessingCountRef}
            hideAttachMenuRef={hideAttachMenuRef}
            onSubmit={handleSubmit}
            onStop={handleStop}
            onSteer={sendSteer}
            syncPromptResources={syncPromptResources}
            t={t}
          />
          <ChatStatusBar
            activeKey={activeKey}
            activeSessionId={activeSessionId}
            initialized={initialized}
            availableModels={availableModels}
            modelCapabilities={modelCapabilities}
            selectedModelCapability={selectedModelCapability}
            modelCapabilityText={modelCapabilityText}
            onSessionModeChange={handleSessionModeChange}
            onResetPermissionGrants={handleResetPermissionGrants}
            onModelChange={handleModelChange}
            onThinkingChange={handleThinkingChange}
            onCompact={handleCompact}
            t={t}
          />
        </div>
      )}

      <ChatSessionList
        workspacePath={workspacePath}
        open={panelOpen}
        sessions={sessions}
        pinnedIds={sessionMeta.pinned}
        archivedIds={sessionMeta.archived}
        showArchived={showArchived}
        onToggleShowArchived={() => setShowArchived((value) => !value)}
        onClose={() => useSessionStore.getState().setPanelOpen(workspacePath, false)}
        onSelect={(session) => void handleSelectSession(session)}
        onNew={() => void handleNewSession()}
        onRename={(session) => void handleRenameSession(session)}
        onDelete={(session) => void handleDeleteSession(session)}
        onTogglePin={togglePin}
        onToggleArchive={toggleArchive}
        onExport={(session, format) => void exportSession(session, format)}
      />

      {toolResultView && (
        <ToolResultViewer
          key={`${toolResultView.sessionId}:${toolResultView.toolCallId}`}
          workspacePath={workspacePath}
          sessionId={toolResultView.sessionId}
          toolCallId={toolResultView.toolCallId}
          toolName={toolResultView.toolName}
          onClose={() => setToolResultView(null)}
        />
      )}
    </div>
  )
}
