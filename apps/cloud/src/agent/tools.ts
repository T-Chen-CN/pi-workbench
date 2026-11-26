/**
 * 云端 Agent 的六个工具（P0 白名单，D-03）。
 *
 * 硬约束：
 * - **没有** `fs` / `bash` / `git`：云端没有仓库。
 * - 没有阻塞型工具（原 `wait_task` 已取消）：派完就回，推进靠事件唤醒（D-21）。
 * - `dispatch_task` 必须带 `authorizationId`，范围与额度由服务端校验（G9）；
 *   模型自称「用户已同意」不会生效。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { CLOUD_TOOL_NAMES } from './cloud-session.js'
import { toolError, toolText } from './cloud-session.js'
import type { CloudStore } from '../store/store.js'
import type { Hub } from '../ws/hub.js'
import type { TaskDispatcher } from '../tasks/dispatcher.js'

export interface CloudToolsDeps {
  store: CloudStore
  hub: Hub
  dispatcher: TaskDispatcher
  now?: () => number
}

function summarizeTask(task: ReturnType<CloudStore['findTask']>): string {
  if (!task) return 'unknown task'
  const lines = [
    `${task.id} [${task.status}] ${task.spec.title}`,
    `device: ${task.spec.deviceId} · repo: ${task.spec.repo.workspacePath}`,
    `progress: step ${task.progress.step}${task.progress.totalSteps ? `/${task.progress.totalSteps}` : ''}`,
  ]
  if (task.progress.summary) lines.push(`last: ${task.progress.summary}`)
  if (task.progress.changedFiles?.length) {
    const attention = task.progress.changedFiles.filter((file) => Boolean(file.attention))
    const normal = task.progress.changedFiles.filter((file) => !file.attention)
    if (attention.length > 0) {
      lines.push(
        `attention: ${attention.map((file) => `${file.path} (${file.attention})`).join(', ')}`
      )
    }
    if (normal.length > 0) {
      lines.push(`changed: ${normal.map((file) => file.path).join(', ')}`)
    }
  }
  if (task.progress.secretHits?.length) {
    lines.push(
      `secret-hits (locations only): ${task.progress.secretHits.map((hit) => `${hit.path}:${hit.line} (${hit.kind})`).join(', ')}`
    )
  }
  if (task.progress.branch) lines.push(`branch: ${task.progress.branch}`)
  if (task.progress.commit) lines.push(`commit: ${task.progress.commit}`)
  if (task.terminalReason) lines.push(`terminal: ${task.terminalReason}`)
  if (task.error) lines.push(`error: ${task.error}`)
  return lines.join('\n')
}

export function createCloudToolsExtension(deps: CloudToolsDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'list_devices',
      label: 'List devices',
      description:
        'List paired devices with online state and their registered repositories. Use it before proposing a plan.',
      promptSnippet: 'list_devices: paired devices, online state, repositories',
      parameters: { type: 'object', properties: {}, required: [] } as any,
      async execute() {
        const devices = deps.dispatcher.deviceSnapshots()
        if (devices.length === 0) return toolText('No device has been paired yet.')
        const lines = devices.map((device) => {
          const repos = device.workspaces
            .filter((workspace) => workspace.isGit)
            .map((workspace) => `  - ${workspace.name} (${workspace.path})${workspace.defaultBranch ? ` [${workspace.defaultBranch}]` : ''}`)
          return [
            `${device.id} · ${device.name} · ${device.platform} · ${device.online ? 'online' : 'offline'}`,
            repoOrEmpty(repos),
          ].join('\n')
        })
        return toolText(lines.join('\n\n'))
      },
    })

    pi.registerTool({
      name: 'list_repos',
      label: 'List repositories',
      description: 'List the repositories registered on one device, with git status.',
      promptSnippet: 'list_repos: repositories on a device',
      parameters: {
        type: 'object',
        properties: { deviceId: { type: 'string', description: 'Paired device id' } },
        required: ['deviceId'],
      } as any,
      async execute(_id: string, params: { deviceId?: string }) {
        const device = params.deviceId ? deps.store.findDevice(params.deviceId) : undefined
        if (!device) return toolError(`Unknown device: ${String(params.deviceId)}`)
        const lines = device.workspaces.map(
          (workspace) =>
            `- ${workspace.name} (${workspace.path})${workspace.isGit ? '' : ' — not a git repository, cannot accept tasks'}`
        )
        return toolText(lines.length ? lines.join('\n') : 'No repository registered on that device.')
      },
    })

    pi.registerTool({
      name: 'dispatch_task',
      label: 'Dispatch task',
      description:
        'Dispatch a self-contained task to a device. Requires the authorizationId of a user-confirmed plan. The task runs in an isolated git worktree on that device.',
      promptSnippet: 'dispatch_task: send one self-contained task to a device',
      promptGuidelines: [
        'Always pass the authorizationId from the user-confirmed plan; dispatching without it is rejected.',
        'The task must be self-contained: the terminal cannot see this conversation.',
        'Do not wait for the result; events will wake you when the task progresses.',
      ],
      parameters: {
        type: 'object',
        properties: {
          authorizationId: { type: 'string' },
          workUnitId: {
            type: 'string',
            description: 'Work unit id; tasks in the same unit share one git worktree',
          },
          deviceId: { type: 'string' },
          workspacePath: { type: 'string' },
          title: { type: 'string' },
          background: { type: 'string' },
          goal: { type: 'string' },
          acceptance: { type: 'string' },
          expectedChanges: { type: 'string' },
          commit: {
            type: 'boolean',
            description: 'Whether this task should produce a commit (decided per work unit)',
          },
        },
        required: [
          'authorizationId',
          'workUnitId',
          'deviceId',
          'workspacePath',
          'title',
          'background',
          'goal',
          'acceptance',
        ],
      } as any,
      async execute(_id: string, params: Record<string, unknown>) {
        const request = {
          authorizationId: String(params.authorizationId ?? ''),
          workUnitId: String(params.workUnitId ?? ''),
          deviceId: String(params.deviceId ?? ''),
          workspacePath: String(params.workspacePath ?? ''),
          title: String(params.title ?? ''),
          background: String(params.background ?? ''),
          goal: String(params.goal ?? ''),
          acceptance: String(params.acceptance ?? ''),
          expectedChanges: params.expectedChanges ? String(params.expectedChanges) : undefined,
          commit: Boolean(params.commit),
        }
        if (!request.authorizationId || !request.workUnitId) {
          return toolError('authorizationId and workUnitId are required.')
        }
        const outcome = await deps.dispatcher.dispatch(request)
        if (!outcome.ok) return toolError(`${outcome.code}: ${outcome.message}`)
        return toolText(
          `Dispatched ${outcome.task.id} (status ${outcome.task.status}). Do not wait; you will be woken by task events.`
        )
      },
    })

    pi.registerTool({
      name: 'get_task',
      label: 'Get task',
      description: 'Read the live snapshot of one task (no cache; never blocks).',
      promptSnippet: 'get_task: live task snapshot',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      } as any,
      async execute(_id: string, params: { taskId?: string }) {
        const task = params.taskId ? deps.store.findTask(params.taskId) : undefined
        if (!task) return toolError(`Unknown task: ${String(params.taskId)}`)
        return toolText(summarizeTask(task))
      },
    })

    pi.registerTool({
      name: 'send_task_message',
      label: 'Send task message',
      description:
        'Send an additional instruction to a running task on the device. Do not use it to change the goal — that needs a new plan.',
      promptSnippet: 'send_task_message: pass an instruction to the running task',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['taskId', 'text'],
      } as any,
      async execute(_id: string, params: { taskId?: string; text?: string }) {
        const task = params.taskId ? deps.store.findTask(params.taskId) : undefined
        if (!task) return toolError(`Unknown task: ${String(params.taskId)}`)
        if (['done', 'failed', 'cancelled', 'expired', 'rejected', 'interrupted'].includes(task.status)) {
          return toolError(`Task ${task.id} is already ${task.status}.`)
        }
        const text = String(params.text ?? '').trim()
        if (!text) return toolError('text is required.')
        const online = deps.hub.isDeviceOnline(task.spec.deviceId)
        if (!online) return toolError('The device is offline; the instruction was not delivered.')
        // 若工单正处于 waiting_human，走 task_answer 把状态推进回 running，避免撞死状态机
        if (task.status === 'waiting_human') {
          const answered = await deps.dispatcher.answerTask(task.id, text, task.question?.id)
          if (!answered) return toolError(`Task ${task.id} could not accept an answer right now.`)
          return toolText(`Answer delivered to ${task.id}.`)
        }
        deps.hub.sendToDevice(
          task.spec.deviceId,
          { v: 1, type: 'task_message', seq: 0, taskId: task.id, text, at: Date.now() },
          task.id
        )
        return toolText(`Instruction delivered to ${task.id}.`)
      },
    })

    pi.registerTool({
      name: 'cancel_task',
      label: 'Cancel task',
      description: 'Cancel a task on the device. Already-made changes stay in the worktree.',
      promptSnippet: 'cancel_task: stop a task (does not roll back changes)',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      } as any,
      async execute(_id: string, params: { taskId?: string }) {
        const taskId = String(params.taskId ?? '')
        const cancelled = await deps.dispatcher.cancelTask(taskId, 'user-cancel')
        return cancelled
          ? toolText(`Task ${taskId} is cancelled. Changes stay in the worktree.`)
          : toolError(`Task ${taskId} was not cancellable (unknown or already terminal).`)
      },
    })
  }
}

function repoOrEmpty(repos: string[]): string {
  return repos.length ? repos.join('\n') : '  (no git repository)'
}

/** 校验工具集常量与注册一致（防止改了常量忘了注册） */
export const CLOUD_TOOL_WHITELIST = [...CLOUD_TOOL_NAMES]
