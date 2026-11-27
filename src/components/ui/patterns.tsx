/**
 * 桌面端 Paper & Ink 内容模式兼容再导出层：唯一实现位于 `@pi-workbench/ui`（`packages/ui/src/patterns.tsx`）。
 *
 * 设计契约（实现在 `packages/ui/src/patterns.tsx` 中强制落地）：
 * - Card 采用 `border border-rule-hairline bg-raised`，卡片头使用 `border-b border-rule-divide`；
 * - Tab 关闭按钮带有 `data-tab-aux=""` 并保证 `h-6 w-6`（24px）最小命中区。
 */
import {
  Card as UiCard,
  CardHeader as UiCardHeader,
  KeyCap as UiKeyCap,
  LegendRow as UiLegendRow,
  ListRow as UiListRow,
  Meter as UiMeter,
  QuickAction as UiQuickAction,
  RingMeter as UiRingMeter,
  SearchField as UiSearchField,
  SectionHeader as UiSectionHeader,
  SettingsTable as UiSettingsTable,
  SettingsTableRow as UiSettingsTableRow,
  Stat as UiStat,
  StatGrid as UiStatGrid,
  StatusText as UiStatusText,
  Tab as UiTab,
  Tabs as UiTabs,
  TabsList as UiTabsList,
  TabsPanel as UiTabsPanel,
  TabsRoot as UiTabsRoot,
  TabsTab as UiTabsTab,
  handleTabListKeyDown,
  handleTabStripWheel,
} from '@pi-workbench/ui'

export type {
  CardHeaderProps,
  CardProps,
  LegendRowProps,
  ListRowProps,
  MeterProps,
  QuickActionProps,
  RingMeterProps,
  SearchFieldProps,
  SectionHeaderProps,
  SettingsTableColumn,
  SettingsTableProps,
  SettingsTableRowProps,
  StatProps,
  StatusTextProps,
  StatusTone,
  TabProps,
  TabsListProps,
  TabsPanelProps,
  TabsRootProps,
  TabsTabProps,
} from '@pi-workbench/ui'

export const Card = UiCard
export const CardHeader = UiCardHeader
export const SectionHeader = UiSectionHeader
export const Stat = UiStat
export const StatGrid = UiStatGrid
export const StatusText = UiStatusText
export const QuickAction = UiQuickAction
export const ListRow = UiListRow
export const LegendRow = UiLegendRow
export const SettingsTable = UiSettingsTable
export const SettingsTableRow = UiSettingsTableRow
export const KeyCap = UiKeyCap
export const Meter = UiMeter
export const RingMeter = UiRingMeter
export const SearchField = UiSearchField
export const Tab = UiTab
export const TabsRoot = UiTabsRoot
export const TabsList = UiTabsList
export const TabsTab = UiTabsTab
export const TabsPanel = UiTabsPanel
export const Tabs = UiTabs
export { handleTabListKeyDown, handleTabStripWheel }
