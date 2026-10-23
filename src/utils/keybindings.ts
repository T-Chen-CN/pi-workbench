/**
 * 可自定义快捷键（E-02）
 *
 * 组合串使用 `mod+shift+p` 形式：mod 在 Windows/Linux 是 Ctrl，在 macOS 是 ⌘。
 * 这里只处理应用级命令；编辑器内部快捷键仍由 Monaco 负责。
 */

export type ShortcutId = 'commandPalette' | 'settings'

export const DEFAULT_KEYBINDINGS: Record<ShortcutId, string> = {
  commandPalette: 'mod+shift+p',
  settings: 'mod+,',
}

export function isMacPlatform(): boolean {
  if (typeof window !== 'undefined') {
    const platform = window.electronAPI?.platform
    if (typeof platform === 'string') return platform === 'darwin'
  }
  if (typeof navigator === 'undefined') return false
  return /mac/i.test(navigator.platform || '') || /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

export function normalizeKeybindings(input: unknown): Record<ShortcutId, string> {
  const source = (input ?? {}) as Record<string, unknown>
  const result = { ...DEFAULT_KEYBINDINGS }
  for (const id of Object.keys(DEFAULT_KEYBINDINGS) as ShortcutId[]) {
    const value = source[id]
    if (typeof value === 'string' && parseShortcut(value)) result[id] = value.toLowerCase()
  }
  return result
}

function parseShortcut(combo: string): { mod: boolean; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; key: string } | null {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (!key) return null
  return {
    mod: parts.includes('mod'),
    ctrl: parts.includes('ctrl'),
    meta: parts.includes('meta') || parts.includes('cmd'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key,
  }
}

/** 事件是否匹配组合串 */
export function matchShortcut(event: KeyboardEvent, combo: string): boolean {
  const parsed = parseShortcut(combo)
  if (!parsed) return false
  const mac = isMacPlatform()
  const wantCtrl = parsed.ctrl || (parsed.mod && !mac)
  const wantMeta = parsed.meta || (parsed.mod && mac)
  if (event.ctrlKey !== wantCtrl) return false
  if (event.metaKey !== wantMeta) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  return event.key.toLowerCase() === parsed.key.toLowerCase()
}

/** 把按键事件转为组合串；没有修饰键或只有修饰键时返回 null */
export function eventToShortcut(event: KeyboardEvent): string | null {
  const key = event.key
  if (!key || key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt') return null
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null
  const parts: string[] = ['mod']
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  parts.push(key.length === 1 ? key.toLowerCase() : key.toLowerCase())
  return parts.join('+')
}

/** 人类可读的组合串 */
export function formatShortcut(combo: string, mac = isMacPlatform()): string {
  const parsed = parseShortcut(combo)
  if (!parsed) return combo
  const parts: string[] = []
  if (parsed.mod || parsed.ctrl || parsed.meta) parts.push(mac ? '⌘' : 'Ctrl')
  if (parsed.shift) parts.push(mac ? '⇧' : 'Shift')
  if (parsed.alt) parts.push(mac ? '⌥' : 'Alt')
  parts.push(parsed.key === ',' ? ',' : parsed.key.toUpperCase())
  return parts.join(mac ? '' : '+')
}

export function findConflict(
  keybindings: Record<ShortcutId, string>,
  candidate: string,
  exclude: ShortcutId
): ShortcutId | null {
  for (const id of Object.keys(keybindings) as ShortcutId[]) {
    if (id === exclude) continue
    if (keybindings[id].toLowerCase() === candidate.toLowerCase()) return id
  }
  return null
}
