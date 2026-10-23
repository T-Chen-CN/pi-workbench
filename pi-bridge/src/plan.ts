/** 结构化计划（R-04）：Plan 模式提交、批准后由任务列表使用 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export type PlanStatus = 'proposed' | 'approved' | 'rejected'

export interface PlanStep {
  id: string
  title: string
  files: string[]
  risk?: string
  status: PlanStepStatus
}

export interface StructuredPlan {
  id: string
  summary: string
  steps: PlanStep[]
  status: PlanStatus
  createdAt: number
  updatedAt: number
}

const MAX_STEPS = 20
const MAX_FILE_COUNT = 20

/** 清洗 submit_plan 的入参；非法步骤被丢弃，最多 20 步 */
export function normalizePlanSteps(input: unknown): PlanStep[] {
  if (!Array.isArray(input)) return []
  const steps: PlanStep[] = []
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (!title) continue
    const files = Array.isArray(record.files)
      ? record.files
          .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
          .map((file) => file.trim())
          .slice(0, MAX_FILE_COUNT)
      : []
    const risk =
      typeof record.risk === 'string' && record.risk.trim().length > 0
        ? record.risk.trim().slice(0, 300)
        : undefined
    steps.push({
      id: `step-${index + 1}`,
      title: title.slice(0, 300),
      files,
      risk,
      status: 'pending',
    })
    if (steps.length >= MAX_STEPS) break
  }
  return steps
}

/** 从 sidecar 读回的宽松校验 */
export function isStructuredPlan(value: unknown): value is StructuredPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan.id === 'string' &&
    Array.isArray(plan.steps) &&
    (plan.status === 'proposed' || plan.status === 'approved' || plan.status === 'rejected')
  )
}
