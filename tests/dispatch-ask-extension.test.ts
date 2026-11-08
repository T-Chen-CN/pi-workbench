/**
 * 派活反问工具：`ask_cloud_operator`。
 *
 * 断言两件事：工具确实注册进了会话工具表（否则模型永远看不到它）、
 * 它的 `execute` 真的把问题交出去并等回答——这是 `input_required` 的地基。
 */

import { describe, expect, it, vi } from 'vitest'
import { DISPATCH_ASK_TOOL, createDispatchAskExtension } from '../pi-bridge/src/dispatch-extension'

interface RegisteredTool {
  name: string
  description?: string
  parameters?: { required?: string[] }
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>
  }>
}

function register(ask: (question: string) => Promise<string>): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  const factory = createDispatchAskExtension({ ask })
  // `pi` 只需要 registerTool：扩展工厂的其余能力本工具不用
  ;(factory as unknown as (pi: unknown) => void)({
    registerTool: (tool: RegisteredTool) => tools.push(tool)
  })
  return tools
}

describe('dispatch ask extension', () => {
  it('registers exactly one tool with a required question parameter', () => {
    const tools = register(async () => 'ok')
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe(DISPATCH_ASK_TOOL)
    expect(tools[0].parameters?.required).toEqual(['question'])
  })

  it('returns the cloud answer as the tool result', async () => {
    const ask = vi.fn(async (question: string) => `回答：${question.slice(0, 4)}`)
    const [tool] = register(ask)
    const result = await tool.execute('call-1', { question: '删哪个分支？' })
    expect(ask).toHaveBeenCalledWith('删哪个分支？')
    expect(result.content[0]).toMatchObject({ type: 'text', text: '回答：删哪个分' })
  })

  it('rejects when the question is empty and when ask refuses', async () => {
    const [empty] = register(async () => 'ok')
    await expect(empty.execute('call-2', { question: '  ' })).rejects.toThrow('question')

    const [failing] = register(async () => {
      throw new Error('本机急停')
    })
    await expect(failing.execute('call-3', { question: '要哪个？' })).rejects.toThrow('本机急停')
  })
})
