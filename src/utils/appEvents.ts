/** 应用内事件：替代散落的 window CustomEvent 字符串 */

export interface AppEventMap {
  'open-settings': void
  'open-command-palette': void
  'workspace-toggle-terminal': void
  'pi:refresh-files': void
  'pi:insert-slash': { insert: string }
  'attach-selection': void
  'api-config-saved': void
  'session-new': void
  'session-list': void
  'session-rename': void
  'session-delete': void
  'session-close': void
}

export type AppEventName = keyof AppEventMap

export function emitAppEvent<K extends AppEventName>(
  name: K,
  detail?: AppEventMap[K]
): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/** 订阅并返回取消函数；事件名写错会在编译期报错 */
export function onAppEvent<K extends AppEventName>(
  name: K,
  handler: (detail: AppEventMap[K]) => void
): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<AppEventMap[K]>).detail)
  window.addEventListener(name, listener)
  return () => window.removeEventListener(name, listener)
}
