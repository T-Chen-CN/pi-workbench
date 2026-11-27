/**
 * 会话消息归一化兼容层：转发至单一投影实现 `session-view.ts`。
 */

export {
  deriveMessage,
  deriveMessages,
  deriveMessages as buildSessionMessagesFromEntries,
  mergeAgentUsage,
  readMessageUsage,
  userMessageFromRaw,
  type DeriveMessagesOptions,
} from './session-view.js'
