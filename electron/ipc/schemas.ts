/**
 * 主进程高危写操作 IPC 的运行时 Zod Schema 契约。
 *
 * 目标：在进入文件系统、PTY 终端、设置落盘、Git 变更与云端控制面之前阻断畸形/越界/超长入参，
 * 避免 `...args: any[]` 导致类型漂移或将未知/恶意字段直接落盘。
 */

import { z } from 'zod'

const MAX_PATH_LEN = 4096
const MAX_TEXT_WRITE_BYTES = 32 * 1024 * 1024
const MAX_TERMINAL_WRITE_BYTES = 1024 * 1024
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024

/** 合法文件系统路径字符串（非空、长度受限、不含 NUL 字节） */
export const safePathSchema = z
  .string()
  .min(1, 'Path is required')
  .max(MAX_PATH_LEN, 'Path is too long')
  .refine((v) => !v.includes('\0'), 'Path must not contain NUL bytes')

export const fsCreateFileSchema = z.object({
  filePath: safePathSchema,
})

export const fsWriteFileSchema = z.object({
  filePath: safePathSchema,
  content: z
    .string()
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= MAX_TEXT_WRITE_BYTES,
      'File content exceeds 32 MB write limit'
    ),
})

export const fsRenameSchema = z.object({
  oldPath: safePathSchema,
  newPath: safePathSchema,
})

export const draftSaveSchema = z.object({
  workspacePath: safePathSchema,
  filePath: safePathSchema,
  content: z.string(),
})

export const draftDeleteSchema = z.object({
  workspacePath: safePathSchema,
  filePath: safePathSchema,
})

export const terminalCreateSchema = z.object({
  workspaceDir: safePathSchema,
  cols: z.number().int().min(1).max(1000).catch(80),
  rows: z.number().int().min(1).max(500).catch(24),
  cwd: safePathSchema.optional(),
})

export const terminalWriteSchema = z.object({
  id: z.string().min(1).max(128),
  data: z
    .string()
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= MAX_TERMINAL_WRITE_BYTES,
      'Terminal input chunk exceeds 1 MB limit'
    ),
})

export const terminalResizeSchema = z.object({
  id: z.string().min(1).max(128),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
})

export const terminalIdSchema = z.object({
  id: z.string().min(1).max(128),
})

export const pluginToggleSchema = z.object({
  workspaceDir: safePathSchema,
  pluginId: z.string().min(1).max(128),
  enabled: z.boolean(),
})

export const shellOpenExternalSchema = z.object({
  url: z.string().min(1).max(4096),
})

export const clipboardWriteSchema = z.object({
  text: z
    .string()
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= MAX_CLIPBOARD_BYTES,
      'Clipboard text exceeds 4 MB limit'
    ),
})

/**
 * `app:saveSettings` 允许落盘的白名单 Schema：
 * 剥离任意未知键值与超大嵌套对象，防止未受控字段污染 `config/settings.json`；
 * 对可降级的布尔/排序/权限字段使用 `.catch(undefined)` 以兼容旧前端与异常字段回落。
 */
export const appSaveSettingsSchema = z.object({
  language: z.enum(['zh', 'en', 'zh-CN', 'en-US']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  autoSave: z.boolean().optional(),
  autoSaveDelay: z.number().int().min(200).max(60_000).optional(),
  runWhileBusy: z.enum(['queue', 'steer']).optional(),
  permissionLevel: z.enum(['readonly', 'ask', 'auto']).optional().catch(undefined),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      approval: z.boolean().optional(),
      complete: z.boolean().optional(),
      error: z.boolean().optional(),
    })
    .optional(),
  budgetUsd: z.number().finite().min(0).max(100_000).optional(),
  keybindings: z.record(z.string().max(64), z.string().max(64)).optional(),
  explorerSortBy: z.enum(['name', 'type']).optional().catch(undefined),
  explorerFoldersFirst: z.boolean().optional().catch(undefined),
  explorerSortReverse: z.boolean().optional().catch(undefined),
  closeToTray: z.boolean().optional().catch(undefined),
  autoInstallWorktreeDeps: z.boolean().optional().catch(undefined),
  useSystemProxy: z.boolean().optional().catch(undefined),
  autoRefreshCatalog: z.boolean().optional().catch(undefined),
  panelWidths: z
    .object({
      sidebar: z.number().int().min(160).max(600).optional(),
      chat: z.number().int().min(260).max(900).optional(),
      terminalHeight: z.number().int().min(100).max(700).optional(),
    })
    .optional()
    .catch(undefined),
  /** 历史兼容字段（迁移读取用，不接受超大值） */
  permissions: z
    .record(z.string().max(32), z.enum(['allow', 'ask', 'deny']))
    .optional(),
})

export const gitBindWorktreeSchema = z.object({
  workspaceDir: safePathSchema,
  sessionId: z.string().min(1).max(128),
  target: z.string().min(1).max(MAX_PATH_LEN),
  base: z.string().max(256).optional(),
})

export const gitCreateBranchSchema = z.object({
  workspaceDir: safePathSchema,
  sha: z.string().regex(/^[0-9a-f]{4,64}$/i, 'Invalid commit sha'),
  name: z.string().min(1).max(256),
})

export const gitCheckoutSchema = z.object({
  workspaceDir: safePathSchema,
  worktreePath: safePathSchema,
  branch: z.string().min(1).max(256),
})

export const gitMergeSchema = z.object({
  workspaceDir: safePathSchema,
  worktreePath: safePathSchema,
  branch: z.string().min(1).max(256),
  strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
})

export const cloudPairSchema = z.object({
  baseUrl: z.string().min(1).max(2048),
  code: z.string().min(1).max(128),
  deviceName: z.string().max(128).optional(),
})

export const cloudSaveConfigSchema = z
  .object({
    providerId: z.string().min(1).max(64).optional(),
    modelId: z.string().min(1).max(256).optional(),
    apiKey: z.string().max(4096).optional(),
    thinkingLevel: z.string().max(32).optional(),
  })
  .loose()

export function parseIpcInput<T>(
  schema: z.ZodType<T>,
  input: unknown
): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, data: result.data }
  const first = result.error.issues[0]
  const loc = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
  return { ok: false, error: `${loc}${first?.message ?? 'Invalid IPC payload'}` }
}
