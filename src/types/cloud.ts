/**
 * 云端页的数据形状（渲染层视角）。
 *
 * 共享数据形状与常量统一由 `@pi-workbench/cloud-ui` 提供，桌面端在此补充 Electron IPC 连接状态类型。
 */

import type {
  CloudClientState,
  CloudDeviceState,
  CloudLinkView,
  CloudWorkspaceEntry,
} from './electron'

export type { CloudClientState, CloudDeviceState, CloudLinkView, CloudWorkspaceEntry }

export {
  CLOUD_ACTIVE_TASK_STATUSES,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_PROVIDER_PRESETS,
  INITIAL_CLOUD_SESSION_STATE,
  isCloudTaskActiveStatus,
  type CloudAgentStatusName,
  type CloudAuthorizationRow,
  type CloudAwaySummaryRow,
  type CloudCatalogModel,
  type CloudChangedFileRow,
  type CloudChatRow,
  type CloudDeviceRow,
  type CloudDocItem,
  type CloudDreamItem,
  type CloudMemoryItem,
  type CloudMemoryKind,
  type CloudNotice,
  type CloudSecretHitRow,
  type CloudSessionState,
  type CloudTaskRow,
  type CloudTaskStatusName,
  type CloudTraceRow,
  type CloudUnitRow,
} from '@pi-workbench/cloud-ui'
