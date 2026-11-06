/**
 * 按路径读云端图片（经网关旁路）。同一路径只拉一次，缩略图列表里
 * 反复滚动不会重复打网络。
 */

import { useEffect, useState } from 'react'
import { cloudApi } from '../api/cloud'

const MAX_CACHED = 24
const cache = new Map<string, string>()

function remember(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 测试用：清空缓存，避免用例之间串图 */
export function clearCloudImageCache(): void {
  cache.clear()
}

export interface CloudImageState {
  src?: string
  error?: string
  loading: boolean
}

export function useCloudImage(path: string | null | undefined): CloudImageState {
  const key = path ?? ''
  const [state, setState] = useState<CloudImageState>(() => {
    const hit = key ? cache.get(key) : undefined
    return hit ? { src: hit, loading: false } : { loading: Boolean(key) }
  })

  useEffect(() => {
    if (!key) {
      setState({ loading: false })
      return
    }
    const hit = cache.get(key)
    if (hit) {
      setState({ src: hit, loading: false })
      return
    }
    let cancelled = false
    setState({ loading: true })
    void cloudApi.readImage(key).then((result) => {
      if (cancelled) return
      if (result.success && result.dataUrl) {
        remember(key, result.dataUrl)
        setState({ src: result.dataUrl, loading: false })
        return
      }
      setState({ loading: false, error: result.error ?? 'unknown' })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return state
}
