// @vitest-environment jsdom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'

vi.mock('../../src/api', () => ({
  api: {
    auxDetachAt: vi.fn(),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    onGitChanged: vi.fn(() => () => {}),
    onGitWorktreeDeps: vi.fn(() => () => {}),
    gitRepoInfo: vi.fn(async () => ({ success: false })),
    searchWorkspaceFiles: vi.fn(async () => ({ success: true, files: ['src/index.ts'] })),
    pickAttachments: vi.fn(async () => ({ success: true, canceled: true, files: [] })),
    getPathForFile: vi.fn(() => ''),
  },
}))

vi.mock('../../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    listPromptResources: vi.fn(async () => ({
      success: true,
      templates: [{ name: 'review', description: 'Review diff', scope: 'user' as const }],
      skills: [],
    })),
  },
}))

import {
  editorStoreFor,
  resetEditorStores,
  sameOpenFileTabs,
  useEditorStore,
} from '../../src/store/editorStore'
import { diffStoreFor, resetDiffStores, useDiffStore } from '../../src/store/diffStore'
import { selectRunningTasks, useCloudStore } from '../../src/store/cloudStore'
import {
  WorkspaceStoresProvider,
  peekDiffStore,
  peekEditorStore,
  useWorkspaceStores,
  type WorkspaceStores,
} from '../../src/store/WorkspaceStoresContext'
import { conversationKey, useChatStore } from '../../src/store/chatStore'
import { useSessionStore } from '../../src/store/sessionStore'
import { useApprovalStore } from '../../src/store/approvalStore'
import { useSettingsStore } from '../../src/store/settingsStore'
import { useWorkspaceStore } from '../../src/store/workspaceStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { translations } from '../../src/i18n/translations'
import { WorkspaceScopeProvider } from '../../src/workspace/WorkspaceScope'
import { resetAllChatTurnControl } from '../../src/workspace/chatTurnControl'
import {
  buildSteerPayload,
  buildTurnPayload,
  createChatTurnController,
  describeAgentFailure,
  filterContextAttachments,
  parseSlashCommand,
  type ChatTurnAgentAPI,
} from '../../src/components/chat/chatTurnController'
import { ChatHeader } from '../../src/components/chat/ChatHeader'
import { ChatApprovalBar } from '../../src/components/chat/ChatApprovalBar'
import { ChatComposer } from '../../src/components/chat/ChatComposer'
import { ChatStatusBar } from '../../src/components/chat/ChatStatusBar'
import type { ApprovalRequestPayload, SessionSummary, StructuredPlan } from '../../src/types/electron'

const zh = translations.zh
const t = (key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v))
    }
  }
  return value
}

beforeEach(() => {
  resetEditorStores()
  resetDiffStores()
  resetAllChatTurnControl()
  useChatStore.getState().reset()
  useSessionStore.getState().reset()
  useApprovalStore.getState().reset()
  useSettingsStore.getState().setRunWhileBusy('queue')
  useWorkspaceStore.setState({ workspacePath: '/ws', openWorkspaces: ['/ws'], recentWorkspaces: [] })
  useI18nStore.getState().setLanguage('zh')
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Zustand v5 migration — useShallow & custom comparator stability', () => {
  it('supports custom comparator (sameOpenFileTabs) and useShallow without getSnapshot loop warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const renders = { tabs: 0, combined: 0 }

    function EditorTabsProbe({ workspace }: { workspace: string }) {
      renders.tabs += 1
      const openFiles = useEditorStore(workspace, (state) => state.openFiles, sameOpenFileTabs)
      return <div data-testid="tab-count">{openFiles.length}</div>
    }

    function ShallowMultiStoreProbe({ convKey, workspace }: { convKey: string; workspace: string }) {
      renders.combined += 1
      const chatSlice = useChatStore(
        useShallow((state) => {
          const conv = state.conversations[convKey]
          return {
            isLoading: conv?.isLoading ?? false,
            draft: state.draftInputs[convKey] ?? '',
          }
        })
      )
      const diffSlice = useDiffStore(
        workspace,
        useShallow((state) => ({ isOpen: state.isOpen, count: state.edits.length }))
      )
      const settingsSlice = useSettingsStore(
        useShallow((state) => ({
          runWhileBusy: state.runWhileBusy,
          autoSave: state.autoSave,
        }))
      )
      return (
        <div data-testid="combined">
          {`${chatSlice.draft}|${chatSlice.isLoading}|${diffSlice.isOpen}:${diffSlice.count}|${settingsSlice.runWhileBusy}:${settingsSlice.autoSave}`}
        </div>
      )
    }

    const ws = '/ws-v5'
    const key = conversationKey(ws, 's1')
    useChatStore.getState().ensureConversation(key)
    editorStoreFor(ws).getState().addOpenFile({
      path: '/ws-v5/a.ts',
      name: 'a.ts',
      content: 'const x = 1',
      isDirty: false,
      isSaving: false,
    })

    render(
      <>
        <EditorTabsProbe workspace={ws} />
        <ShallowMultiStoreProbe convKey={key} workspace={ws} />
      </>
    )

    expect(screen.getByTestId('tab-count').textContent).toBe('1')
    const initialTabRenders = renders.tabs
    const initialCombinedRenders = renders.combined

    // Editing file body must NOT re-render the tab list because sameOpenFileTabs ignores body text
    act(() => {
      editorStoreFor(ws).getState().updateOpenFile('/ws-v5/a.ts', { content: 'const x = 2' })
    })
    expect(renders.tabs).toBe(initialTabRenders)

    // Marking dirty MUST re-render the tab list
    act(() => {
      editorStoreFor(ws).getState().markDirty('/ws-v5/a.ts')
    })
    expect(renders.tabs).toBe(initialTabRenders + 1)

    // Updating an unrelated field in settingsStore must NOT re-render ShallowMultiStoreProbe
    act(() => {
      useSettingsStore.getState().setBudgetUsd(12)
    })
    expect(renders.combined).toBe(initialCombinedRenders)

    // Updating diffStore and chatStore draft MUST update ShallowMultiStoreProbe cleanly
    act(() => {
      diffStoreFor(ws).getState().openEdits([
        { path: '/ws-v5/a.ts', oldContent: '1', newContent: '2' },
      ])
      useChatStore.getState().setDraftInput(key, 'hello')
    })
    expect(screen.getByTestId('combined').textContent).toBe('hello|false|true:1|queue:true')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('memoizes cloudStore.selectRunningTasks per tasks array reference without getSnapshot warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks = [
      {
        id: 't1',
        deviceId: 'd1',
        workspacePath: '/ws',
        prompt: 'a',
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 't2',
        deviceId: 'd1',
        workspacePath: '/ws',
        prompt: 'b',
        status: 'done' as const,
        createdAt: 2,
        updatedAt: 2,
      },
    ]
    useCloudStore.setState({ tasks: tasks as any })
    const first = selectRunningTasks(useCloudStore.getState())
    const second = selectRunningTasks(useCloudStore.getState())
    expect(first).toBe(second)
    expect(first.map((item) => item.id)).toEqual(['t1'])

    function RunningProbe() {
      const running = useCloudStore(selectRunningTasks)
      return <div data-testid="running-count">{running.length}</div>
    }
    render(<RunningProbe />)
    expect(screen.getByTestId('running-count').textContent).toBe('1')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('WorkspaceStoresProvider & peekEditorStore / peekDiffStore lifecycle', () => {
  it('never allocates zombie stores on peek, retains on mount, and disposes synchronously on unmount', () => {
    const ws = '/ws-lifecycle'
    expect(peekEditorStore(ws)).toBeNull()
    expect(peekDiffStore(ws)).toBeNull()

    let observed: WorkspaceStores | null = null
    function Consumer() {
      observed = useWorkspaceStores()
      return <div data-testid="ws">{observed?.workspacePath ?? 'none'}</div>
    }

    const { unmount } = render(
      <WorkspaceStoresProvider workspacePath={ws}>
        <Consumer />
      </WorkspaceStoresProvider>
    )

    expect(screen.getByTestId('ws').textContent).toBe(ws)
    expect(observed).not.toBeNull()
    expect(peekEditorStore(ws)).toBe(observed!.editorStore)
    expect(peekDiffStore(ws)).toBe(observed!.diffStore)
    expect(editorStoreFor(ws)).toBe(observed!.editorStore)
    expect(diffStoreFor(ws)).toBe(observed!.diffStore)

    // Unmount disposes synchronously without setTimeout(0) race
    unmount()
    expect(peekEditorStore(ws)).toBeNull()
    expect(peekDiffStore(ws)).toBeNull()
  })

  it('survives React StrictMode double-mount with pre-populated state and cleans up on unmount', () => {
    const ws = '/ws-strict'
    editorStoreFor(ws).getState().addOpenFile({
      path: '/ws-strict/main.ts',
      name: 'main.ts',
      content: 'export {}',
      isDirty: false,
      isSaving: false,
    })

    function Probe() {
      const stores = useWorkspaceStores()
      const count = useEditorStore(ws, (s) => s.openFiles.length)
      return <div data-testid="strict-count">{`${stores?.workspacePath}:${count}`}</div>
    }

    const { unmount } = render(
      <StrictMode>
        <WorkspaceStoresProvider workspacePath={ws}>
          <Probe />
        </WorkspaceStoresProvider>
      </StrictMode>
    )

    expect(screen.getByTestId('strict-count').textContent).toBe('/ws-strict:1')
    expect(peekEditorStore(ws)?.getState().openFiles).toHaveLength(1)

    unmount()
    expect(peekEditorStore(ws)).toBeNull()
    expect(peekDiffStore(ws)).toBeNull()
  })

  it('reference-counts overlapping mounts for the same workspace', () => {
    const ws = '/ws-shared'
    const first = render(
      <WorkspaceStoresProvider workspacePath={ws}>
        <div />
      </WorkspaceStoresProvider>
    )
    const second = render(
      <WorkspaceStoresProvider workspacePath={ws}>
        <div />
      </WorkspaceStoresProvider>
    )
    const liveStore = peekEditorStore(ws)
    expect(liveStore).not.toBeNull()

    first.unmount()
    expect(peekEditorStore(ws)).toBe(liveStore)

    second.unmount()
    expect(peekEditorStore(ws)).toBeNull()
  })
})

describe('Pure TS chatTurnController (no React mounted)', () => {
  function makeMockAgentAPI(): ChatTurnAgentAPI {
    return {
      chat: vi.fn(async () => ({ success: true, response: 'assistant reply' })),
      abort: vi.fn(async () => ({ success: true })),
      steer: vi.fn(async () => ({ success: true })),
      sessionsOpen: vi.fn(async () => ({ success: true, history: [] })),
      getContextUsage: vi.fn(async () => ({ success: true, usage: undefined })),
      listPromptResources: vi.fn(async () => ({ success: true, templates: [], skills: [] })),
      rewindLastUser: vi.fn(async () => ({ success: true, text: 'original question' })),
      switchBranch: vi.fn(async () => ({ success: true, history: [] })),
      respondApproval: vi.fn(async () => ({ success: true })),
      approvePlan: vi.fn(async () => ({ success: true })),
      rejectPlan: vi.fn(async () => ({ success: true })),
    }
  }

  it('parses slash commands, filters snippets, and builds turn & steer payloads purely', () => {
    expect(parseSlashCommand('hello')).toBeNull()
    expect(parseSlashCommand('/model gpt-4o')).toEqual({
      command: '/model',
      argument: 'gpt-4o',
      kind: 'model',
    })
    expect(parseSlashCommand('/review foo')).toEqual({
      command: '/review',
      argument: 'foo',
      kind: 'custom',
    })

    const onTooLarge = vi.fn()
    const filtered = filterContextAttachments(
      [
        {
          id: 's-ok',
          kind: 'snippet',
          path: '/ws/a.ts',
          name: 'a.ts',
          startLine: 1,
          endLine: 2,
          content: 'ok',
        },
        {
          id: 's-big',
          kind: 'snippet',
          path: '/ws/big.ts',
          name: 'big.ts',
          startLine: 1,
          endLine: 999,
          content: 'x'.repeat(50_000),
        },
      ],
      { onSnippetTooLarge: onTooLarge }
    )
    expect(filtered.map((a) => a.id)).toEqual(['s-ok'])
    expect(onTooLarge).toHaveBeenCalledWith('big.ts')

    const payload = buildTurnPayload({
      userMessage: 'explain this',
      acceptedAttachments: filtered,
      quoteFile: { path: '/ws/README.md', name: 'README.md' },
      promptImages: [],
    })
    expect(payload.prompt).toContain('explain this')
    expect(payload.prompt).toContain('/ws/README.md')
    expect(payload.messageContext?.files?.[0]?.path).toBe('/ws/README.md')

    const steer = buildSteerPayload({
      id: 'p1',
      text: 'focus on tests',
      attachments: [{ id: 'file:/ws/a.ts', kind: 'file', path: '/ws/a.ts', name: 'a.ts' }],
    })
    expect(steer.text).toContain('/ws/a.ts')
    expect(steer.text).toContain('focus on tests')

    expect(
      describeAgentFailure(
        { errorCode: 'empty-response', outputLimit: 8192 },
        t as any
      )
    ).toContain('8,192')
  })

  it('submits a turn, queues/steers while busy, retries, and resolves approvals', async () => {
    const ws = '/ws'
    const sid = 's1'
    const key = conversationKey(ws, sid)
    useChatStore.getState().ensureConversation(key)
    useSessionStore.getState().setOpen(ws, [sid], sid)

    const agentAPI = makeMockAgentAPI()
    const notify = { info: vi.fn(), error: vi.fn() }
    const onScrollToBottom = vi.fn()
    const onRefreshSessionSettings = vi.fn(async () => {})
    const gitSwitch = vi.fn(async () => ({ success: true, scheduled: true }))
    const gitLoad = vi.fn(async () => {})

    const controller = createChatTurnController({
      workspacePath: ws,
      getEditorRoot: () => ws,
      getActiveSessionId: () => sid,
      getAvailableModels: () => ['test-model'],
      getImagesAllowed: () => true,
      getImageProcessingCount: () => 0,
      getPromptResources: () => ({ templates: [], skills: [] }),
      setPromptResources: () => {},
      getLatestProposedPlan: () => null,
      translate: t as any,
      agentAPI,
      gitStore: () => ({ switchWorktree: gitSwitch, load: gitLoad } as any),
      notify,
      scheduleTimer: () => 0,
      onScrollToBottom,
      onRefreshSessionSettings,
    })

    // 1. Schedule worktree switch while running (turn boundary) + submit turn
    const switchResult = await controller.requestWorktreeSwitch('wt-2')
    expect(switchResult).toEqual({ success: true, scheduled: true })

    await controller.submitTurn('hello agent')
    expect(agentAPI.chat).toHaveBeenCalledTimes(1)
    expect(onScrollToBottom).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().conversations[key].messages.map((m) => m.content)).toEqual([
      'hello agent',
      'assistant reply',
    ])
    // Scheduled worktree refresh fires on turn boundary
    expect(gitLoad).toHaveBeenCalledWith(ws, sid)

    // 2. While loading, default mode queues pending message; steer mode injects immediately
    useChatStore.getState().setLoading(key, true)
    useSettingsStore.getState().setRunWhileBusy('queue')
    await controller.submitTurn('queued msg')
    expect(useChatStore.getState().conversations[key].pending).toHaveLength(1)
    expect(agentAPI.steer).not.toHaveBeenCalled()

    const pendingItem = useChatStore.getState().conversations[key].pending[0]
    const steered = await controller.sendSteer(sid, key, pendingItem)
    expect(steered).toBe(true)
    expect(agentAPI.steer).toHaveBeenCalledWith(ws, sid, 'queued msg', undefined)
    expect(useChatStore.getState().conversations[key].pending).toHaveLength(0)

    // 3. Retry rewinds last user message and re-submits without duplicating user bubble
    useChatStore.getState().setLoading(key, false)
    const assistantMsg = useChatStore
      .getState()
      .conversations[key].messages.find((m) => m.role === 'assistant')!
    await controller.retryMessage(assistantMsg)
    expect(agentAPI.rewindLastUser).toHaveBeenCalledWith(ws, sid)
    expect(agentAPI.chat).toHaveBeenCalledTimes(2)

    // 4. Approval resolution removes card, clears needsAction when queue empties, and refreshes settings on allow-always
    const req: ApprovalRequestPayload = {
      requestId: 'req-42',
      workspaceDir: ws,
      sessionId: sid,
      toolCallId: 'tc-1',
      toolName: 'bash',
      category: 'command',
      summary: 'npm test',
      details: { command: 'npm test' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }
    useApprovalStore.getState().add(req)
    useSessionStore.getState().markNeedsAction(ws, sid, 'confirm')

    await controller.respondApproval('req-42', { action: 'allow-always' })
    expect(agentAPI.respondApproval).toHaveBeenCalledWith('req-42', { action: 'allow-always' })
    expect(useApprovalStore.getState().requests).toHaveLength(0)
    expect(useSessionStore.getState().needsAction[key]).toBeUndefined()
    expect(onRefreshSessionSettings).toHaveBeenCalledWith(sid)
  })

  it('approves and rejects structured plans via controller', async () => {
    const ws = '/ws'
    const sid = 's1'
    const key = conversationKey(ws, sid)
    useChatStore.getState().ensureConversation(key)
    const plan: StructuredPlan = {
      id: 'p1',
      summary: 'Refactor chat',
      status: 'proposed',
      createdAt: 1,
      updatedAt: 1,
      steps: [{ id: 'st1', title: 'Extract controller', files: [], status: 'pending' }],
    }
    useChatStore.getState().appendPlanMessage(key, plan)

    const agentAPI = makeMockAgentAPI()
    vi.mocked(agentAPI.approvePlan).mockResolvedValue({
      success: true,
      plan: { ...plan, status: 'approved' },
      permission: { mode: 'ask', grants: [] },
    })

    const controller = createChatTurnController({
      workspacePath: ws,
      getEditorRoot: () => ws,
      getActiveSessionId: () => sid,
      getAvailableModels: () => [],
      getImagesAllowed: () => false,
      getImageProcessingCount: () => 0,
      getPromptResources: () => ({ templates: [], skills: [] }),
      setPromptResources: () => {},
      getLatestProposedPlan: () => ({ plan, messageId: 'msg-plan-p1' }),
      translate: t as any,
      agentAPI,
      notify: { info: vi.fn(), error: vi.fn() },
      scheduleTimer: () => 0,
    })

    await controller.executePlan('ask')
    expect(agentAPI.approvePlan).toHaveBeenCalledWith(ws, sid, 'p1', 'ask')
    expect(useChatStore.getState().conversations[key].sessionSettings?.permission).toEqual({
      mode: 'ask',
      grants: [],
    })
    await waitFor(() => expect(agentAPI.chat).toHaveBeenCalledTimes(1))
  })
})

describe('Decomposed ChatPanel subcomponents (Header / ApprovalBar / Composer / StatusBar)', () => {
  it('renders ChatHeader and triggers new / select / close callbacks', () => {
    const ws = '/ws'
    const sessions: SessionSummary[] = [
      { id: 's1', title: 'Alpha', messageCount: 1, createdAt: 1, updatedAt: 2 },
      { id: 's2', title: 'Beta', messageCount: 2, createdAt: 2, updatedAt: 3 },
    ]
    useSessionStore.getState().setSessions(ws, sessions)
    useSessionStore.getState().setOpen(ws, ['s1', 's2'], 's1')

    const handleSelectSession = vi.fn()
    const handleNewSession = vi.fn()
    const handleCloseTab = vi.fn()

    render(
      <WorkspaceScopeProvider value={ws}>
        <ChatHeader
          workspacePath={ws}
          initialized
          sessions={sessions}
          handleSelectSession={handleSelectSession}
          handleNewSession={handleNewSession}
          handleCloseTab={handleCloseTab}
          t={t as any}
        />
      </WorkspaceScopeProvider>
    )

    fireEvent.click(screen.getByRole('tab', { name: /Beta/ }))
    expect(handleSelectSession).toHaveBeenCalledWith(sessions[1])

    fireEvent.click(screen.getByLabelText(zh.newSession))
    expect(handleNewSession).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getAllByLabelText(zh.closeSessionTab)[0])
    expect(handleCloseTab).toHaveBeenCalledWith('s1')
  })

  it('renders ChatApprovalBar for pending approvals and plan-mode review bar', () => {
    const ws = '/ws'
    const sid = 's1'
    const key = conversationKey(ws, sid)
    useChatStore.getState().ensureConversation(key)
    useChatStore.getState().setSessionSettings(key, {
      modelId: 'test-model',
      thinkingLevel: 'medium',
      permission: { mode: 'plan', grants: [] },
    })
    useChatStore.getState().addMessage(key, { role: 'assistant', content: 'Proposed plan text' })
    useApprovalStore.getState().add({
      requestId: 'req-1',
      workspaceDir: ws,
      sessionId: sid,
      toolCallId: 'tc-1',
      toolName: 'bash',
      category: 'command',
      summary: 'npm run lint',
      details: { command: 'npm run lint' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    const onRespondApproval = vi.fn()
    const onExecutePlan = vi.fn()

    render(
      <ChatApprovalBar
        workspacePath={ws}
        activeSessionId={sid}
        activeKey={key}
        onRespondApproval={onRespondApproval}
        onExecutePlan={onExecutePlan}
        t={t as any}
      />
    )

    expect(screen.getByTestId('plan-review-bar')).toBeTruthy()
    expect(screen.getByTestId('approval-bar')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh.planApproveAsk }))
    expect(onExecutePlan).toHaveBeenCalledWith('ask')

    fireEvent.click(screen.getByText(zh.approvalAllowOnce))
    expect(onRespondApproval).toHaveBeenCalledWith('req-1', { action: 'allow-once' })
  })

  it('renders ChatComposer with isolated draft typing, slash menu, and stop/send/steer controls', async () => {
    const ws = '/ws'
    const sid = 's1'
    const key = conversationKey(ws, sid)
    useChatStore.getState().ensureConversation(key)
    const convBefore = useChatStore.getState().conversations[key]

    const onSubmit = vi.fn()
    const onStop = vi.fn()
    const onSteer = vi.fn()
    const inputRef = React.createRef<HTMLTextAreaElement>()
    const imageProcessingCountRef = { current: 0 }

    render(
      <ChatComposer
        workspacePath={ws}
        activeKey={key}
        activeSessionId={sid}
        initialized
        imagesAllowed={false}
        stopping={false}
        inputRef={inputRef}
        imageProcessingCountRef={imageProcessingCountRef}
        onSubmit={onSubmit}
        onStop={onStop}
        onSteer={onSteer}
        syncPromptResources={vi.fn()}
        t={t as any}
      />
    )

    const textarea = screen.getByPlaceholderText(zh.inputPlaceholder)
    fireEvent.change(textarea, { target: { value: '/rev' } })
    // Typing updates draftInputs without replacing conversations[key]
    expect(useChatStore.getState().conversations[key]).toBe(convBefore)
    expect(await screen.findByText('/review')).toBeTruthy()

    fireEvent.click(screen.getByText('/review'))
    expect((textarea as HTMLTextAreaElement).value).toBe('/review ')

    fireEvent.click(screen.getByRole('button', { name: zh.send }))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // Clearing draft while loading switches Send -> Stop and exposes pending steer
    act(() => {
      useChatStore.getState().setDraftInput(key, '')
      useChatStore.getState().setLoading(key, true)
      useChatStore.getState().addPending(key, 'follow-up')
    })

    fireEvent.click(await screen.findByRole('button', { name: zh.stop }))
    expect(onStop).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: zh.insertNow }))
    expect(onSteer).toHaveBeenCalledTimes(1)
  })

  it('renders ChatStatusBar menus for permission, model, thinking, and context compaction', async () => {
    const ws = '/ws'
    const sid = 's1'
    const key = conversationKey(ws, sid)
    useChatStore.getState().ensureConversation(key)
    useChatStore.getState().setSessionSettings(key, {
      modelId: 'test-model',
      thinkingLevel: 'medium',
      permission: { mode: 'ask', grants: [] },
    })
    useChatStore.getState().setContextUsage(key, {
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    })

    const onSessionModeChange = vi.fn()
    const onModelChange = vi.fn()
    const onThinkingChange = vi.fn()
    const onCompact = vi.fn()

    render(
      <ChatStatusBar
        activeKey={key}
        activeSessionId={sid}
        initialized
        availableModels={['test-model', 'fast-model']}
        modelCapabilities={[]}
        selectedModelCapability={null}
        modelCapabilityText={null}
        onSessionModeChange={onSessionModeChange}
        onResetPermissionGrants={vi.fn()}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
        onCompact={onCompact}
        t={t as any}
      />
    )

    fireEvent.click(screen.getByLabelText(zh.sessionModeLabel))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: zh.permissionLevelPlan }))
    expect(onSessionModeChange).toHaveBeenCalledWith('plan')

    fireEvent.click(screen.getByLabelText(zh.modelLabel))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /fast-model/ }))
    expect(onModelChange).toHaveBeenCalledWith('fast-model')

    fireEvent.click(screen.getByLabelText(zh.thinkingLabel))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^高/ }))
    expect(onThinkingChange).toHaveBeenCalledWith('high')

    fireEvent.click(screen.getByRole('button', { name: zh.contextUsageLabel }))
    fireEvent.click(await screen.findByRole('button', { name: zh.compactContext }))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })
})
