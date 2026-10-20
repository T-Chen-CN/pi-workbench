/** 平台相关的快捷键文案（只用于展示；实际监听在 CommandPalette） */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || ''
  if (/mac/i.test(platform)) return true
  return /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

export function commandPaletteShortcut(): string {
  return isMacPlatform() ? '⌘⇧P' : 'Ctrl+Shift+P'
}
