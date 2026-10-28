import React from 'react'
import { useChatPanelState } from '../hooks/useChatPanelState'
import type { ChatPanelProps } from '../utils/chatPanelShared'
import {
  THINKING_LEVELS,
  THINKING_LABEL_KEYS,
  formatTokenCount,
} from '../utils/chatPanelShared'
import {
  ArrowDown,
  ChevronDown,
  FileText,
  Minimize2,
  Paperclip,
  Send,
  Square,
  X,
} from 'lucide-react'
import { useChatStore } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { retrySecondsRemaining } from '../utils/retryCountdown'
import { formatBytes } from '../utils/formatBytes'
import {
  SESSION_MODE_ICON,
  SESSION_MODE_ICON_CLASS,
  SESSION_MODE_LABEL_KEY,
  SESSION_MODE_ORDER,
} from '../utils/sessionModePresentation'
import { ChatSessionList } from './ChatSessionList'
import { ApprovalCard, CATEGORY_LABEL_KEYS } from './ApprovalCard'
import { TurnTaskList } from './ChatMessageRow'
import { ChatHeader } from './ChatHeader'
import { ChatApiKeyPrompt } from './ChatApiKeyPrompt'
import { ChatTranscript } from './ChatTranscript'
import { ToolResultViewer } from './ToolResultViewer'
import { Meter, RingMeter } from './patterns'
import {
  Button,
  Caption,
  DataText,
  IconButton,
  Label,
  MenuOption,
  PopoverMenu,
  Spinner,
  Textarea,
  Value,
} from './ui'

export type { ChatPanelProps }

export const ChatPanel: React.FC<ChatPanelProps> = (props) => {
  const { workspacePath, onCollapse, collapseButtonRef, panelId } = props
  const {
    SessionModeIcon,
    activeKey,
    activePlan,
    activeSessionId,
    addMention,
    attachMode,
    attachSymbol,
    attachments,
    availableModels,
    closeStatusMenu,
    contextPercent,
    contextPercentRounded,
    contextRemaining,
    contextTokensRef,
    contextTokensText,
    contextTone,
    contextUsage,
    currentEditorFile,
    currentSymbols,
    diffToolIds,
    emptySuggestions,
    error,
    exportSession,
    fatalError,
    handleApprovalResponse,
    handleNewSession,
    handleSelectSession,
    handleCloseTab,
    handleRenameSession,
    handleDeleteSession,
    handleApprovePlan,
    handleCompact,
    handleCopyMessage,
    handleDraftChange,
    handleDropFiles,
    handleEditMessage,
    handleExecutePlan,
    handleKeyDown,
    handleModelChange,
    handleOpenToolResult,
    handlePaste,
    handleRejectPlan,
    handleResetPermissionGrants,
    handleRetryMessage,
    handleSessionModeChange,
    handleStop,
    handleSubmit,
    handleSwitchBranch,
    handleThinkingChange,
    handleTranscriptScroll,
    imageProcessing,
    initialized,
    input,
    inputRef,
    insertSlashItem,
    isLoading,
    lastAssistantMessage,
    lastMessageId,
    lastUserMessageId,
    latestProposedPlan,
    mention,
    messages,
    modelCapabilities,
    modelCapabilityText,
    needsApiKey,
    newMessageCount,
    openFiles,
    openToolDiff,
    panelOpen,
    pendingApprovals,
    pendingMessages,
    permissionLabelRef,
    retryNow,
    retryStatus,
    scrollToBottom,
    selectedModelCapability,
    selection,
    sendSteer,
    sessionMeta,
    sessionPermission,
    sessionSettings,
    sessionStats,
    sessions,
    setAttachMode,
    setShowArchived,
    setShowAttachMenu,
    setStatusMenu,
    setToolResultView,
    showArchived,
    showAttachMenu,
    showContextTokens,
    showPermissionLabel,
    showScrollButton,
    slashActive,
    slashItems,
    statusMenu,
    statusStripRef,
    stopping,
    t,
    toggleArchive,
    togglePin,
    toolResultView,
    transcriptRef,
    virtualizer,
  } = useChatPanelState(props)

  // 纯图片（无文本）也可以发送；预处理中的图片不算可发送内容
  const hasSendableInput = Boolean(input.trim()) || attachments.some((a) => a.kind === 'image')

  if (needsApiKey) {
    return (
      <ChatApiKeyPrompt
        onCollapse={onCollapse}
        collapseButtonRef={collapseButtonRef}
        panelId={panelId}
        t={t}
        fatalError={fatalError}
      />
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-panel">
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

      <ChatTranscript
        activeSessionId={activeSessionId}
        activeKey={activeKey}
        handleNewSession={handleNewSession}
        t={t}
        transcriptRef={transcriptRef}
        handleTranscriptScroll={handleTranscriptScroll}
        messages={messages}
        isLoading={isLoading}
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

      {/* Composer */}
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
          {retryStatus && (
            <div className="mb-2 flex items-center gap-2 type-caption text-warning">
              <Spinner size={10} />
              <span>
                {retrySecondsRemaining(retryStatus, retryNow) > 0
                  ? t('retryInProgress', {
                      attempt: retryStatus.attempt,
                      max: retryStatus.maxAttempts,
                      seconds: retrySecondsRemaining(retryStatus, retryNow),
                    })
                  : t('retryStarting', {
                      attempt: retryStatus.attempt,
                      max: retryStatus.maxAttempts,
                    })}
              </span>
              {retryStatus.message && (
                <span className="min-w-0 truncate text-ink-muted">{retryStatus.message}</span>
              )}
            </div>
          )}
          {activePlan ? (
            <div className="mb-2 flex items-center justify-between gap-2 border border-rule-hairline bg-raised px-3 py-2">
              <Caption className="text-ink-muted">
                {t('planProgress', {
                  done: activePlan.steps.filter((step) => step.status === 'done').length,
                  total: activePlan.steps.length,
                })}
              </Caption>
              <span className="min-w-0 truncate type-caption text-ink">
                {(
                  activePlan.steps.find((step) => step.status === 'in_progress') ??
                  activePlan.steps.find((step) => step.status === 'pending')
                )?.title ?? ''}
              </span>
            </div>
          ) : (
            lastAssistantMessage?.parts?.some((part) => part.type === 'tool') && (
              <div className="mb-2">
                <TurnTaskList parts={lastAssistantMessage.parts ?? []} />
              </div>
            )
          )}
          {pendingMessages.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5">
              {pendingMessages.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 border border-rule-hairline bg-raised px-3 py-1.5"
                >
                  <span className="type-caption text-ink-muted">
                    {isLoading ? t('pendingNextTurn') : t('pendingIdle')}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate type-value text-ink"
                    title={item.text || undefined}
                  >
                    {item.text || t('pendingImageCount', { count: item.images?.length ?? 0 })}
                  </span>
                  {isLoading ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeKey || !activeSessionId) return
                        void sendSteer(activeSessionId, activeKey, item)
                      }}
                      className="type-caption text-ink-muted transition-colors hover:text-ink"
                    >
                      {t('insertNow')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeKey) return
                        useChatStore.getState().removePending(activeKey, item.id)
                        void handleSubmit(undefined, item.text, {
                          images: item.images,
                          consumeAttachments: false,
                        })
                      }}
                      className="p-0.5 text-ink-muted transition-colors hover:text-ink"
                      aria-label={t('sendNow')}
                      title={t('sendNow')}
                    >
                      <Send size={11} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      activeKey && useChatStore.getState().removePending(activeKey, item.id)
                    }
                    className="p-0.5 text-ink-muted transition-colors hover:text-ink"
                    aria-label={t('removePending')}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {sessionPermission.mode === 'plan' &&
            !isLoading &&
            !latestProposedPlan &&
            messages.some((msg) => msg.role === 'assistant') && (
            <div className="mb-2 flex flex-col gap-2 border border-rule-hairline bg-raised px-3 py-2">
              <span className="type-caption text-ink-muted">{t('planModeHint')}</span>
              <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void handleExecutePlan('auto')}>
                  {t('planApproveAuto')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void handleExecutePlan('ask')}>
                  {t('planApproveAsk')}
                </Button>
              </div>
            </div>
          )}
          {pendingApprovals.length > 0 && (
            <div className="mb-2 flex flex-col gap-2">
              {pendingApprovals.map((request) => (
                <ApprovalCard
                  key={request.requestId}
                  request={request}
                  onRespond={handleApprovalResponse}
                />
              ))}
            </div>
          )}
          {imageProcessing > 0 && (
            <div className="mb-1.5 flex items-center gap-1.5 type-caption text-ink-muted">
              <Spinner size={10} />
              {t('imageOptimizing')}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => {
                if (attachment.kind === 'image') {
                  return (
                    <span
                      key={attachment.id}
                      className="inline-flex items-center gap-1 border border-rule-control bg-sunken p-1 type-data text-ink-muted"
                      title={`${attachment.name} · ${formatBytes(attachment.size ?? 0)}`}
                    >
                      <img
                        src={`data:${attachment.mimeType};base64,${attachment.data}`}
                        alt={attachment.name}
                        className="h-10 w-10 rounded-sm object-cover"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          activeKey &&
                          useChatStore.getState().removeAttachment(activeKey, attachment.id)
                        }
                        title={t('removeAttachment')}
                        aria-label={t('removeAttachment')}
                        className="p-0.5 text-ink-muted hover:text-ink"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  )
                }
                const label =
                  attachment.kind === 'snippet'
                    ? `${attachment.name}:${attachment.startLine}–${attachment.endLine}`
                    : attachment.name
                return (
                  <span
                    key={attachment.id}
                    className="inline-flex items-center gap-1 border border-rule-control bg-sunken px-2 py-1 type-data text-ink-muted"
                    title={
                      attachment.kind === 'snippet'
                        ? `${attachment.path}:${attachment.startLine}-${attachment.endLine}`
                        : attachment.path
                    }
                  >
                    <FileText size={10} className="text-ink-muted" />
                    {label}
                    <button
                      type="button"
                      onClick={() =>
                        activeKey &&
                        useChatStore.getState().removeAttachment(activeKey, attachment.id)
                      }
                      title={t('removeAttachment')}
                      aria-label={t('removeAttachment')}
                      className="ml-0.5 p-0.5 text-ink-muted hover:text-ink"
                    >
                      <X size={10} />
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          {slashActive && slashItems.length > 0 && (
            <div className="mb-1 max-h-60 overflow-y-auto border border-line bg-raised shadow-print">
              {slashItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => insertSlashItem(item.insert)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <span className="flex-shrink-0 type-data text-ink">{item.label}</span>
                  <span className="min-w-0 truncate type-caption text-ink-muted">
                    {item.description}
                  </span>
                </button>
              ))}
            </div>
          )}

          {mention && mention.results.length > 0 && (
            <div className="mb-1 max-h-52 overflow-y-auto border border-line bg-raised shadow-print">
              {mention.results.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => addMention(file)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-data text-ink transition-colors hover:bg-hover"
                >
                  <FileText size={11} className="flex-shrink-0 text-ink-muted" />
                  <span className="truncate">{file}</span>
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDropFiles}
            className="border border-rule-control bg-sunken transition-colors focus-within:border-accent"
          >
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(event) =>
                handleDraftChange(event.target.value, event.target.selectionStart ?? 0)
              }
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('inputPlaceholder')}
              disabled={!initialized}
              rows={3}
              className="min-h-[68px] max-h-40 border-none bg-transparent px-3 py-2 focus:ring-0"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="relative flex items-center gap-1">
                <IconButton
                  icon={Paperclip}
                  label={t('attachContext')}
                  size="sm"
                  disabled={!initialized || isLoading}
                  onClick={() => {
                    setShowAttachMenu((open) => !open)
                    setAttachMode('files')
                  }}
                />
                {showAttachMenu && activeKey && (
                  <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto border border-line bg-raised py-1 shadow-print">
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="type-label text-ink-muted">{t('attachContext')}</span>
                      {currentEditorFile && (
                        <button
                          type="button"
                          onClick={() =>
                            setAttachMode((mode) => (mode === 'files' ? 'symbols' : 'files'))
                          }
                          className="type-caption text-ink-muted transition-colors hover:text-ink"
                        >
                          {attachMode === 'symbols' ? t('attachFile') : t('attachSymbol')}
                        </button>
                      )}
                    </div>
                    {attachMode === 'symbols' ? (
                      currentSymbols.length === 0 ? (
                        <div className="px-3 py-2 type-caption text-ink-muted">
                          {t('noSymbols')}
                        </div>
                      ) : (
                        currentSymbols.map((symbol) => (
                          <button
                            key={`${symbol.name}-${symbol.startLine}`}
                            type="button"
                            onClick={() => attachSymbol(symbol)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
                          >
                            <span className="flex-shrink-0 type-caption text-ink-muted">
                              {symbol.kind}
                            </span>
                            <span className="min-w-0 flex-1 truncate type-value text-ink">
                              {symbol.name}
                            </span>
                            <DataText className="flex-shrink-0 text-ink-muted">
                              L{symbol.startLine}–L{symbol.endLine}
                            </DataText>
                          </button>
                        ))
                      )
                    ) : (
                      <>
                    <button
                      type="button"
                      disabled={!selection}
                      onClick={() => {
                        if (!selection || !activeKey) return
                        useChatStore.getState().addAttachment(activeKey, {
                          kind: 'snippet',
                          path: selection.path,
                          name: selection.name,
                          startLine: selection.startLine,
                          endLine: selection.endLine,
                          content: selection.text,
                        })
                        setShowAttachMenu(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                    >
                      <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                      <span className="flex min-w-0 flex-col">
                        <span>{t('attachSelection')}</span>
                        <DataText className="truncate text-ink-muted">
                          {selection
                            ? `${selection.name}:${selection.startLine}–${selection.endLine}`
                            : t('noSelection')}
                        </DataText>
                      </span>
                    </button>
                    <div className="my-1 border-t border-rule-divide" />
                    {openFiles.length === 0 && !selection ? (
                      <div className="px-3 py-2 type-caption text-ink-muted">
                        {t('noOpenFiles')}
                      </div>
                    ) : (
                      openFiles.map((file) => {
                        const attached = attachments.some(
                          (item) => item.kind === 'file' && item.path === file.path
                        )
                        return (
                          <button
                            key={file.path}
                            type="button"
                            disabled={attached}
                            onClick={() => {
                              if (!activeKey) return
                              useChatStore
                                .getState()
                                .addAttachment(activeKey, {
                                  kind: 'file',
                                  path: file.path,
                                  name: file.name,
                                })
                              setShowAttachMenu(false)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                          >
                            <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{file.name}</span>
                              <DataText className="truncate text-ink-muted">
                                {file.path}
                              </DataText>
                            </span>
                          </button>
                        )
                      })
                    )}
                      </>
                    )}
                  </div>
                )}
              </div>
              {isLoading && !hasSendableInput ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Square}
                  disabled={stopping}
                  className="text-danger hover:bg-danger/10 hover:text-danger [&_svg]:fill-current"
                  onClick={() => void handleStop()}
                >
                  {t('stop')}
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon={Send}
                  disabled={!initialized || !hasSendableInput || imageProcessing > 0}
                >
                  {t('send')}
                </Button>
              )}
            </div>
          </form>
          {(sessionSettings || contextUsage) && (
            <div
              ref={statusStripRef}
              className="mt-1 flex min-w-0 items-center gap-1 whitespace-nowrap"
            >
              {sessionSettings && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'permission'}
                    aria-label={t('sessionModeLabel')}
                    disabled={!initialized || isLoading}
                    title={
                      showPermissionLabel
                        ? undefined
                        : t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])
                    }
                    onClick={() =>
                      setStatusMenu((current) => (current === 'permission' ? null : 'permission'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'permission'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <SessionModeIcon
                      size={12}
                      className={SESSION_MODE_ICON_CLASS[sessionPermission.mode]}
                      aria-hidden="true"
                    />
                    {showPermissionLabel && (
                      <span ref={permissionLabelRef} className="type-caption">
                        {t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])}
                      </span>
                    )}
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'permission' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'permission'}
                    onClose={closeStatusMenu}
                    label={t('sessionModeLabel')}
                    className="w-44 py-1"
                  >
                    {SESSION_MODE_ORDER.map((mode) => {
                      const ModeIcon = SESSION_MODE_ICON[mode]
                      return (
                        <MenuOption
                          key={mode}
                          selected={mode === sessionPermission.mode}
                          onSelect={() => {
                            closeStatusMenu()
                            handleSessionModeChange(mode)
                          }}
                        >
                          <span className="flex items-center gap-2">
                            <ModeIcon
                              size={14}
                              className={SESSION_MODE_ICON_CLASS[mode]}
                              aria-hidden="true"
                            />
                            <span>{t(SESSION_MODE_LABEL_KEY[mode])}</span>
                          </span>
                        </MenuOption>
                      )
                    })}
                    {sessionPermission.grants.length > 0 && (
                      <>
                        <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                          <span className="block type-caption text-ink-muted">
                            {t('permissionGrants', {
                              categories: sessionPermission.grants
                                .map((category) => t(CATEGORY_LABEL_KEYS[category]))
                                .join(t('listSeparator')),
                            })}
                          </span>
                        </div>
                        <MenuOption
                          onSelect={() => {
                            closeStatusMenu()
                            handleResetPermissionGrants()
                          }}
                        >
                          {t('permissionResetGrants')}
                        </MenuOption>
                      </>
                    )}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {sessionSettings && (
                <span className="relative flex min-w-24 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'model'}
                    aria-label={t('modelLabel')}
                    disabled={isLoading}
                    onClick={() =>
                      setStatusMenu((current) => (current === 'model' ? null : 'model'))
                    }
                    className={`flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'model'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <span className="max-w-28 truncate type-data text-ink">
                      {sessionSettings.modelId ?? '—'}
                    </span>
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'model' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'model'}
                    onClose={closeStatusMenu}
                    label={t('modelLabel')}
                    className="w-56 py-1"
                  >
                    {availableModels.length === 0 && sessionSettings.modelId && (
                      <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                        {sessionSettings.modelId}
                      </MenuOption>
                    )}
                    {availableModels.length > 0 &&
                      sessionSettings.modelId &&
                      !availableModels.includes(sessionSettings.modelId) && (
                        <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                          {sessionSettings.modelId}
                        </MenuOption>
                      )}
                    {availableModels.map((model) => {
                      const capability = modelCapabilities.find((item) => item.id === model)
                      const unavailable = capability?.available === false
                      return (
                        <MenuOption
                          key={model}
                          variant="data"
                          selected={model === sessionSettings.modelId}
                          disabled={unavailable}
                          meta={unavailable ? t('modelUnavailable') : undefined}
                          title={unavailable ? t('modelUnavailableHint') : undefined}
                          onSelect={() => {
                            closeStatusMenu()
                            void handleModelChange(model)
                          }}
                        >
                          {model}
                        </MenuOption>
                      )
                    })}
                    {modelCapabilityText && (
                      <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                        <Caption className="block text-ink-muted">{modelCapabilityText}</Caption>
                      </div>
                    )}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {sessionSettings && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'thinking'}
                    aria-label={t('thinkingLabel')}
                    disabled={isLoading || selectedModelCapability?.reasoning === false}
                    title={
                      selectedModelCapability?.reasoning === false
                        ? t('modelThinkingUnavailable')
                        : undefined
                    }
                    onClick={() =>
                      setStatusMenu((current) => (current === 'thinking' ? null : 'thinking'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'thinking'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <span className="type-caption">
                      {t('thinkingLabel')} {t(THINKING_LABEL_KEYS[(sessionSettings.thinkingLevel ?? 'medium') as (typeof THINKING_LEVELS)[number]] ?? 'thinkingMedium')}
                    </span>
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'thinking' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'thinking'}
                    onClose={closeStatusMenu}
                    label={t('thinkingLabel')}
                    className="w-36 py-1"
                  >
                    {THINKING_LEVELS.map((level) => {
                      const supported =
                        !selectedModelCapability ||
                        selectedModelCapability.thinkingLevels.length === 0 ||
                        selectedModelCapability.thinkingLevels.includes(level)
                      return (
                        <MenuOption
                          key={level}
                          selected={level === (sessionSettings.thinkingLevel ?? 'medium')}
                          disabled={!supported}
                          meta={<span className="type-data">{level}</span>}
                          onSelect={() => {
                            closeStatusMenu()
                            void handleThinkingChange(level)
                          }}
                        >
                          {t(THINKING_LABEL_KEYS[level])}
                        </MenuOption>
                      )
                    })}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && contextUsage && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {contextUsage && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'context'}
                    aria-label={t('contextUsageLabel')}
                    onClick={() =>
                      setStatusMenu((current) => (current === 'context' ? null : 'context'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors ${
                      statusMenu === 'context'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <RingMeter
                      value={contextPercent}
                      size={14}
                      strokeWidth={2}
                      tone={contextTone}
                      label={t('contextUsageLabel')}
                    />
                    <span
                      className={`type-data ${
                        contextPercent != null && contextPercent >= 95
                          ? 'text-danger'
                          : contextPercent != null && contextPercent >= 80
                            ? 'text-warning'
                            : 'text-ink'
                      }`}
                    >
                      {contextPercentRounded != null ? `${contextPercentRounded}%` : '—'}
                    </span>
                    {showContextTokens && (
                      <span
                        ref={contextTokensRef}
                        className="flex-shrink-0 type-data text-ink-muted"
                      >
                        {contextTokensText} tok
                      </span>
                    )}
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'context' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'context'}
                    onClose={closeStatusMenu}
                    role="dialog"
                    label={t('contextUsageLabel')}
                    className="w-64"
                  >
                    <div className="px-3 pb-2 pt-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label className="text-ink">{t('contextUsageLabel')}</Label>
                        <Caption className="text-ink-muted">{t('contextScope')}</Caption>
                      </div>
                      <div className="mt-1.5 flex items-baseline justify-between gap-2">
                        <Value className="text-ink">
                          {contextPercentRounded != null
                            ? t('contextUsed', { percent: contextPercentRounded })
                            : '—'}
                        </Value>
                        <DataText className="text-ink-muted">{contextTokensText} tok</DataText>
                      </div>
                      <Meter
                        value={contextPercent ?? 0}
                        label={t('contextUsageLabel')}
                        tone={contextTone}
                        className="mt-2"
                      />
                      <div className="mt-2.5 flex gap-6 border-t border-rule-divide pt-2.5">
                        <div className="flex flex-col gap-0.5">
                          <Caption className="text-ink-muted">{t('contextRemaining')}</Caption>
                          <DataText className="text-ink">
                            {contextRemaining != null
                              ? `${formatTokenCount(contextRemaining)} tok`
                              : '—'}
                          </DataText>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <Caption className="text-ink-muted">{t('contextSessionTotal')}</Caption>
                          <DataText className="text-ink">
                            {sessionStats
                              ? `${formatTokenCount(sessionStats.tokens)} tok${
                                  sessionStats.cost > 0
                                    ? ` · $${sessionStats.cost.toFixed(2)}`
                                    : ''
                                }`
                              : '—'}
                          </DataText>
                        </div>
                      </div>
                      {contextUsage.tokens == null && (
                        <Caption className="mt-2 block text-ink-muted">
                          {t('contextUnknownHint')}
                        </Caption>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={() => {
                        closeStatusMenu()
                        void handleCompact()
                      }}
                      className="flex w-full items-center gap-2 border-t border-rule-divide px-3 py-2 text-left type-value text-ink transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Minimize2
                        size={13}
                        aria-hidden="true"
                        className="flex-shrink-0 text-ink-muted"
                      />
                      {t('compactContext')}
                    </button>
                  </PopoverMenu>
                </span>
              )}
            </div>
          )}
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
