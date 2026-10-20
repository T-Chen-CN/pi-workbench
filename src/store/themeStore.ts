import { useEffect, useState } from 'react'
import { create } from 'zustand'

export type ThemeMode = 'system' | 'dark' | 'light'

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

/**
 * 主题偏好（默认 Paper 纸色）。
 *
 * 持久化与语言一致：由 App/Settings 写入 `{appDir}/config/settings.json`。
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  mode: 'light',
  setMode: (mode) => set({ mode }),
}))

/** 把主题偏好解析为实际生效的深浅色 */
export function useResolvedTheme(): 'dark' | 'light' {
  const mode = useThemeStore((state) => state.mode)
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}
