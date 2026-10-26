/** 工作树切换工具：由 Agent 请求，应用在轮次边界生效 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import { existsSync } from 'fs'

export interface WorktreeSwitchResult {
  success: boolean
  root?: string
  branch?: string
  sharedWith?: number
  error?: string
}

export interface WorktreeExtensionContext {
  sessionId: string
  workspaceDir: string
  getRoot: () => string
  onSwitch: (target: string, base?: string) => Promise<WorktreeSwitchResult>
  scheduleRoot: (root: string, branch?: string) => void
}

export function createWorktreeExtension(context: WorktreeExtensionContext): ExtensionFactory {
  const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: undefined,
  })

  return (pi) => {
    // 工作树的 .pi 通常不在版本控制里；把仓库根的 skills / prompts / themes 补进资源发现
    pi.on('resources_discover', async () => {
      if (path.resolve(context.getRoot()) === path.resolve(context.workspaceDir)) return {}
      const projectDir = path.join(context.workspaceDir, '.pi')
      const pick = (name: string): string[] => {
        const dir = path.join(projectDir, name)
        return existsSync(dir) ? [dir] : []
      }
      return {
        skillPaths: pick('skills'),
        promptPaths: pick('prompts'),
        themePaths: pick('themes'),
      }
    })

    pi.registerTool({
      name: 'switch_worktree',
      label: 'Switch worktree',
      description:
        'Switch this session to the main worktree, a new worktree, an idle existing worktree, or a specific worktree path. The switch takes effect after the current turn. Do not modify files after calling it in the same turn.',
      promptSnippet:
        'switch_worktree: switch this session to the main/new/existing/idle worktree',
      promptGuidelines: [
        'Use switch_worktree when you need an isolated working tree for parallel work.',
        'After calling switch_worktree, stop modifying files in the current turn; the change applies at the end of the turn.',
        'target="auto" reuses an idle linked worktree or creates a new one; target="main" switches to the main checkout; target="new" always creates a new worktree.',
      ],
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'main | new | auto | a worktree path inside the workspace',
          },
          base: {
            type: 'string',
            description: 'Optional base branch or commit when target=new',
          },
        },
        required: ['target'],
      } as any,
      async execute(_toolCallId: string, params: any) {
        const target = typeof params?.target === 'string' ? params.target.trim() : ''
        if (!target) throw new Error('target is required')
        const base = typeof params?.base === 'string' ? params.base.trim() : undefined
        const switched = await context.onSwitch(target, base || undefined)
        if (!switched.success || !switched.root) {
          return result(`Unable to switch worktree: ${switched.error ?? 'unknown error'}`)
        }
        if (switched.root === context.getRoot()) {
          return result('This session is already using the requested worktree.')
        }
        context.scheduleRoot(switched.root, switched.branch)
        const shared =
          switched.sharedWith && switched.sharedWith > 0
            ? ` It is shared with ${switched.sharedWith} other session(s); commits may include their changes.`
            : ''
        return result(
          `Worktree switch scheduled for the end of this turn: ${switched.branch ?? switched.root}.${shared} Do not modify files for the rest of this turn.`
        )
      },
    })
  }
}
