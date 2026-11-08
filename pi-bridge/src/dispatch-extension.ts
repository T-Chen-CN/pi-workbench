/**
 * 派活会话的反问工具（H3 P2 / `input_required`）。
 *
 * 云端派下来的任务常常一句话说不全（「把那个删了」）。派活会话里**没有人**能回答：
 * 缺的信息只能问云端。做法是注册一个阻塞式工具 —— `execute` 返回一个挂住的
 * Promise，先由执行器把问题回报给网关（状态变 `input_required`），云端用
 * `local_task_reply` 回答后，`task.answered` 帧把它喂回这里，工具返回答案，
 * 同一轮对话继续跑。
 *
 * 为什么必须是阻塞式工具而不是「结束这一轮再起一轮」：会话的权限、已读文件、
 * 计划都在这一轮里；另起一轮等于重新开始，前面探过的路全丢。
 * `StallWatchdog` 在工具执行期间自动挂起且没有整轮上限（`WORKSPACE_DISPATCH` §13 ⑩）。
 *
 * 只给派活会话注入（`AgentManager.createSession(root, { dispatchAsk })`），
 * 交互会话里没有这个工具：那里用户就在旁边，问云端是错的。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export interface DispatchAskContext {
  /** 把问题交给网关并等待云端回答；reject 表示任务被取消 / 超时 */
  ask: (question: string) => Promise<string>
}

export const DISPATCH_ASK_TOOL = 'ask_cloud_operator'

export function createDispatchAskExtension(context: DispatchAskContext): ExtensionFactory {
  const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: undefined,
  })

  return (pi) => {
    pi.registerTool({
      name: DISPATCH_ASK_TOOL,
      label: 'Ask cloud operator',
      description:
        'Ask the cloud side that dispatched this task for a decision you cannot make yourself. ' +
        'Only use it when the instruction is genuinely ambiguous or you need a choice you must not make alone.',
      promptSnippet:
        'ask_cloud_operator: ask the dispatching cloud agent to decide something ambiguous',
      promptGuidelines: [
        'Ask at most a couple of times per task; prefer making a reasonable choice and stating it in your summary.',
        'Put the concrete options in the question so the answer can be a single short sentence.',
      ],
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'What you need decided, including the options you see',
          },
        },
        required: ['question'],
      } as any,
      async execute(_toolCallId: string, params: any) {
        const question = String(params?.question ?? '').trim()
        if (!question) throw new Error('question is required')
        const answer = await context.ask(question)
        return result(answer)
      },
    })
  }
}
