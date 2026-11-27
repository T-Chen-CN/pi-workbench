import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { StoreApi } from 'zustand/vanilla'

const identity = <T,>(state: T): T => state

/**
 * 面向 Zustand v5 的零依赖选择器 Hook，基于 React 原生 `useSyncExternalStore`：
 * 支持自定义相等比较器（如 `sameOpenFileTabs`）并缓存上一次选出的快照引用，
 * 避免依赖 `zustand/traditional` 以及 React 开发态的 `getSnapshot should be cached` 死循环告警。
 */
export function useStoreWithComparator<S, T = S>(
  store: StoreApi<S>,
  selector: (state: S) => T = identity as unknown as (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const cacheRef = useRef<{
    store: StoreApi<S>
    state: S
    selector: (state: S) => T
    selected: T
  } | null>(null)

  const getSnapshot = useCallback((): T => {
    const state = store.getState()
    const cached = cacheRef.current
    if (cached && cached.store === store) {
      if (cached.selector === selector && Object.is(cached.state, state)) {
        return cached.selected
      }
      const nextSelected = selector(state)
      if (isEqual(cached.selected, nextSelected)) {
        cached.state = state
        cached.selector = selector
        return cached.selected
      }
      cached.state = state
      cached.selector = selector
      cached.selected = nextSelected
      return nextSelected
    }
    const selected = selector(state)
    cacheRef.current = { store, state, selector, selected }
    return selected
  }, [store, selector, isEqual])

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
