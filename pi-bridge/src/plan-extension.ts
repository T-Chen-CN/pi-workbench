/** Plan 模式的结构化计划工具（R-04） */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  normalizePlanSteps,
  type PlanStepStatus,
  type StructuredPlan,
} from './plan.js'
import type { SessionMode } from './approval-policy.js'
import type { AgentTraceEvent } from './types.js'

interface PlanRuntime {
  extras: { plan: StructuredPlan | null }
  onTrace?: ((event: AgentTraceEvent) => void) | null
}

export function createPlanExtension(context: {
  getRuntime: () => PlanRuntime | null
  getMode: () => SessionMode
  persistExtras: (runtime: PlanRuntime) => void
}): ExtensionFactory {
  const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: undefined,
  })

  return (pi) => {
    pi.registerTool({
      name: 'submit_plan',
      label: 'Submit plan',
      description:
        'Submit one structured implementation plan for the user to approve. Plan mode only.',
      promptSnippet: 'submit_plan: submit a structured implementation plan (Plan mode)',
      promptGuidelines: [
        'In Plan mode, call submit_plan exactly once after exploring; do not write the plan as free-form text.',
      ],
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-sentence summary of the plan' },
          steps: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short step title' },
                files: { type: 'array', items: { type: 'string' } },
                risk: { type: 'string', description: 'Optional risk or side effect' },
              },
              required: ['title'],
            },
          },
        },
        required: ['steps'],
      } as any,
      async execute(_toolCallId: string, params: any) {
        const runtime = context.getRuntime()
        if (!runtime) throw new Error('Plan state is unavailable.')
        if (context.getMode() !== 'plan') {
          throw new Error('submit_plan is only available in Plan mode.')
        }
        const steps = normalizePlanSteps(params?.steps)
        if (steps.length === 0) {
          throw new Error('A plan needs at least one step with a title.')
        }
        const now = Date.now()
        const plan: StructuredPlan = {
          id: `plan-${now}`,
          summary: typeof params?.summary === 'string' ? params.summary.trim().slice(0, 500) : '',
          steps,
          status: 'proposed',
          createdAt: now,
          updatedAt: now,
        }
        runtime.extras.plan = plan
        context.persistExtras(runtime)
        runtime.onTrace?.({ type: 'plan_submitted', plan })
        return result(
          `Plan submitted with ${plan.steps.length} step(s). Waiting for the user to approve or reject it.`
        )
      },
    })

    pi.registerTool({
      name: 'update_plan_step',
      label: 'Update plan step',
      description: 'Mark a step of the approved plan as in_progress, done, pending or skipped.',
      promptSnippet: 'update_plan_step: update the status of an approved plan step',
      promptGuidelines: [
        'When executing an approved plan, call update_plan_step with in_progress before starting a step and done after finishing it.',
      ],
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: 'Step id from the approved plan' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'skipped'],
          },
        },
        required: ['stepId', 'status'],
      } as any,
      async execute(_toolCallId: string, params: any) {
        const runtime = context.getRuntime()
        const plan = runtime?.extras.plan
        if (!runtime || !plan) throw new Error('There is no active plan to update.')
        const step = plan.steps.find((item) => item.id === params?.stepId)
        if (!step) throw new Error(`Unknown plan step "${String(params?.stepId ?? '')}".`)
        const status = String(params?.status ?? '')
        if (!['pending', 'in_progress', 'done', 'skipped'].includes(status)) {
          throw new Error('Invalid plan step status.')
        }
        step.status = status as PlanStepStatus
        plan.updatedAt = Date.now()
        context.persistExtras(runtime)
        runtime.onTrace?.({ type: 'plan_updated', plan })
        return result(`Step ${step.id} is now ${status}.`)
      },
    })
  }
}
