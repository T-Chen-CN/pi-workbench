import {
  Eye,
  ListChecks,
  ShieldOff,
  ShieldQuestion,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '../i18n/translations'
import type { SessionMode } from '../types/electron'

/** 状态行与菜单中的模式顺序：按自主性递增 */
export const SESSION_MODE_ORDER: SessionMode[] = ['readonly', 'plan', 'ask', 'auto']

/** 模式图标；颜色只给图标，文字保持中性 */
export const SESSION_MODE_ICON: Record<SessionMode, LucideIcon> = {
  readonly: Eye,
  plan: ListChecks,
  ask: ShieldQuestion,
  auto: ShieldOff,
}

/** 图标色调：只读中性、计划松绿、询问琥珀、完全朱砂 */
export const SESSION_MODE_ICON_CLASS: Record<SessionMode, string> = {
  readonly: 'text-ink-muted',
  plan: 'text-accent',
  ask: 'text-warning',
  auto: 'text-danger',
}

export const SESSION_MODE_LABEL_KEY: Record<SessionMode, TranslationKey> = {
  readonly: 'permissionLevelReadonly',
  plan: 'permissionLevelPlan',
  ask: 'permissionLevelAsk',
  auto: 'permissionLevelAuto',
}

export const SESSION_MODE_DESCRIPTION_KEY: Record<SessionMode, TranslationKey> = {
  readonly: 'modeReadonlyDesc',
  plan: 'modePlanDesc',
  ask: 'modeAskDesc',
  auto: 'modeAutoDesc',
}
