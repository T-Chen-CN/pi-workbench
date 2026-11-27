// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentParts } from '../../src/components/chat/AgentTrace'
import { CloudTraceSection } from '../../src/components/cloud/CloudTraceSection'
import { useChatStore } from '../../src/store/chatStore'
import { useI18nStore } from '../../src/store/i18nStore'
import type { AgentTracePart } from '../../src/types/electron'

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
})

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
})

describe('AgentParts 两阶段渐进收展与整轮归并（1A + 2A）', () => {
  it('多轮工具之间夹带空串 text 与中途旁白时收拢为唯一过程组，且只留最终正文在外', () => {
    const parts: AgentTracePart[] = [
      { type: 'thinking', id: 'th-1', text: '先检查分支状态', durationMs: 30 },
      { type: 'tool', id: 'tc-1', toolCallId: 'tc-1', toolName: 'bash', argsSummary: 'git status', status: 'success' },
      { type: 'text', id: 'tx-empty', text: '' },
      { type: 'text', id: 'tx-mid', text: '状态正常，接下来跑测试。' },
      { type: 'tool', id: 'tc-2', toolCallId: 'tc-2', toolName: 'bash', argsSummary: 'npm test', status: 'error' },
      { type: 'text', id: 'tx-ws', text: ' \n\n ' },
      { type: 'tool', id: 'tc-3', toolCallId: 'tc-3', toolName: 'bash', argsSummary: 'npm run build', status: 'success' },
      { type: 'text', id: 'tx-final', text: 'Pi Workbench v0.11.2 已正式发布完成。' },
    ]

    render(<AgentParts parts={parts} isStreaming={false} />)

    // 只有唯一 1 个过程折叠触发器，且完成后默认收起
    const toggles = screen.getAllByRole('button', { name: /过程/ })
    expect(toggles).toHaveLength(1)
    expect(toggles[0].getAttribute('aria-expanded')).toBe('false')
    // 30ms 显示 <0.1 秒而非 0 秒，且同时展示失败数与总工具数
    expect(toggles[0].textContent).toContain('1 个工具失败')
    expect(toggles[0].textContent).toContain('思考 <0.1 秒')
    expect(toggles[0].textContent).toContain('3 个工具')
    expect(toggles[0].textContent).not.toContain('思考 0 秒')

    // 最终正文渲染在过程组之外，中途旁白已收拢进过程组内
    expect(screen.getByText('Pi Workbench v0.11.2 已正式发布完成。')).toBeTruthy()
    expect(screen.queryByText('状态正常，接下来跑测试。')).toBeNull()

    // 手动展开复盘：不限高（无 data-live-scroll），可看到思考、中途旁白与全部工具
    fireEvent.click(toggles[0])
    expect(toggles[0].getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(toggles[0].getAttribute('aria-controls')!)
    expect(panel?.getAttribute('data-live-scroll')).toBeNull()
    expect(panel?.className).not.toContain('max-h-60')
    expect(screen.getByText('先检查分支状态')).toBeTruthy()
    expect(screen.getByText('状态正常，接下来跑测试。')).toBeTruthy()
    expect(screen.getByText('git status')).toBeTruthy()
    expect(screen.getByText('npm run build')).toBeTruthy()
  })

  it('干活直播态自动以限高滚窗展开，最终正文开始输出或轮次结束时自动收起', () => {
    const runningParts: AgentTracePart[] = [
      { type: 'thinking', id: 'th-1', text: '正在定位构建配置' },
      { type: 'tool', id: 'tc-1', toolCallId: 'tc-1', toolName: 'read', argsSummary: 'package.json', status: 'running' },
    ]

    const { rerender } = render(<AgentParts parts={runningParts} isStreaming={true} />)
    const toggle = screen.getByRole('button', { name: /读取…/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const livePanel = document.getElementById(toggle.getAttribute('aria-controls')!)
    expect(livePanel?.getAttribute('data-live-scroll')).toBe('true')
    expect(livePanel?.className).toContain('max-h-60')
    expect(screen.getByText('正在定位构建配置')).toBeTruthy()

    // 一旦最终正文开始吐字，过程区自动收起
    const withFinalText: AgentTracePart[] = [
      { type: 'thinking', id: 'th-1', text: '正在定位构建配置', durationMs: 800 },
      { type: 'tool', id: 'tc-1', toolCallId: 'tc-1', toolName: 'read', argsSummary: 'package.json', status: 'success' },
      { type: 'text', id: 'tx-1', text: '已经读完配置，结果如下：' },
    ]
    rerender(<AgentParts parts={withFinalText} isStreaming={true} />)
    const collapsedToggle = screen.getByRole('button', { name: /过程/ })
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('正在定位构建配置')).toBeNull()
    expect(screen.getByText('已经读完配置，结果如下：')).toBeTruthy()
  })

  it('干活期间用户手动收起后，后续新步骤不会强行重新展开', () => {
    const step1: AgentTracePart[] = [
      { type: 'thinking', id: 'th-1', text: '第一步思考' },
      { type: 'tool', id: 'tc-1', toolCallId: 'tc-1', toolName: 'read', argsSummary: 'a.ts', status: 'running' },
    ]
    const { rerender } = render(<AgentParts parts={step1} isStreaming={true} />)
    const toggle = screen.getByRole('button', { name: /读取…/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // 用户手动收起
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // 后续工具进来，保持收起
    const step2: AgentTracePart[] = [
      ...step1.map((p) => (p.type === 'tool' ? { ...p, status: 'success' as const } : p)),
      { type: 'tool', id: 'tc-2', toolCallId: 'tc-2', toolName: 'bash', argsSummary: 'npm test', status: 'running' },
    ]
    rerender(<AgentParts parts={step2} isStreaming={true} />)
    expect(screen.getByRole('button', { name: /运行命令…/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('为同会话内多个消息的思考块生成互不重复的 DOM id', () => {
    const parts: AgentTracePart[] = [
      { type: 'thinking', id: 'thinking-1', text: '分析问题' },
      { type: 'text', id: 'text-1', text: '结论' },
    ]
    render(
      <div>
        <AgentParts parts={parts} isStreaming={false} />
        <AgentParts parts={parts} isStreaming={false} />
      </div>
    )
    const toggles = screen.getAllByRole('button', { name: /过程/ })
    expect(toggles).toHaveLength(2)
    const id1 = toggles[0].getAttribute('aria-controls')
    const id2 = toggles[1].getAttribute('aria-controls')
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })
})

describe('CloudTraceSection 两阶段渐进收展与限高滚窗', () => {
  it('流式无正文时自动以 max-h-60 展开，正文到达自动收起，手动展开取消限高且修复 <0.1 秒', () => {
    const { rerender } = render(
      <CloudTraceSection
        messageId="m-cloud-1"
        thinking="先查在线终端"
        traces={[{ id: 't-1', toolName: 'list_devices', summary: '{}', status: 'running' }]}
        isStreaming={true}
        hasBodyText={false}
        language="zh"
      />
    )

    const liveToggle = screen.getByRole('button', { name: /list_devices/ })
    expect(liveToggle.getAttribute('aria-expanded')).toBe('true')
    const livePanel = document.getElementById('cloud-trace-m-cloud-1')
    expect(livePanel?.getAttribute('data-live-scroll')).toBe('true')
    expect(livePanel?.className).toContain('max-h-60')

    // 正文开始输出 → 自动收起
    rerender(
      <CloudTraceSection
        messageId="m-cloud-1"
        thinking="先查在线终端"
        thinkingDurationMs={35}
        traces={[{ id: 't-1', toolName: 'list_devices', summary: '主力机在线', status: 'ok', durationMs: 40 }]}
        isStreaming={true}
        hasBodyText={true}
        language="zh"
      />
    )
    const collapsedToggle = screen.getByRole('button', { name: /过程/ })
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false')
    expect(collapsedToggle.textContent).toContain('思考 <0.1 秒')
    expect(collapsedToggle.textContent).not.toContain('思考 0 秒')

    // 手动展开复盘 → 取消限高
    fireEvent.click(collapsedToggle)
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('true')
    const expandedPanel = document.getElementById('cloud-trace-m-cloud-1')
    expect(expandedPanel?.getAttribute('data-live-scroll')).toBeNull()
    expect(expandedPanel?.className).not.toContain('max-h-60')
  })
})

describe('chatStore.appendTextPart 过滤空串与非正文纯空白', () => {
  it('空串与前导纯空白不新建 text part 也不提前截断思考计时', () => {
    const key = 'ws\u0000s1'
    const store = useChatStore.getState()
    store.ensureConversation(key)
    const id = store.startStreamingMessage(key)

    store.appendThinkingPart(key, id, '推理中')
    store.appendTextPart(key, id, '')
    store.appendTextPart(key, id, '   \n\n  ')

    let msg = useChatStore.getState().conversations[key].messages[0]
    expect(msg.parts?.map((p) => p.type)).toEqual(['thinking'])
    expect(msg.thinkingStartedAt).toBeDefined()

    // 真正正文到来后正常写入，且正文内后续空格换行保留
    store.appendTextPart(key, id, '正文开始')
    store.appendTextPart(key, id, '\n\n')
    store.appendTextPart(key, id, '第二段')
    msg = useChatStore.getState().conversations[key].messages[0]
    expect(msg.parts?.map((p) => p.type)).toEqual(['thinking', 'text'])
    expect(msg.content).toBe('正文开始\n\n第二段')
    expect(msg.thinkingStartedAt).toBeUndefined()
  })
})
