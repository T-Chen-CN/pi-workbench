import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_SAVE_DELAY,
  MAX_AUTO_SAVE_DELAY,
  MIN_AUTO_SAVE_DELAY,
  clampAutoSaveDelay,
  useSettingsStore,
} from '../src/store/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ autoSave: true, autoSaveDelay: DEFAULT_AUTO_SAVE_DELAY })
})

describe('settings store', () => {
  it('clamps the auto-save delay into the supported range', () => {
    expect(clampAutoSaveDelay(100)).toBe(MIN_AUTO_SAVE_DELAY)
    expect(clampAutoSaveDelay(99_999)).toBe(MAX_AUTO_SAVE_DELAY)
    expect(clampAutoSaveDelay(Number.NaN)).toBe(DEFAULT_AUTO_SAVE_DELAY)
  })

  it('hydrates values loaded from settings.json', () => {
    useSettingsStore.getState().hydrate({ autoSave: false, autoSaveDelay: 5000 })
    expect(useSettingsStore.getState().autoSave).toBe(false)
    expect(useSettingsStore.getState().autoSaveDelay).toBe(5000)
  })

  it('ignores malformed persisted values', () => {
    useSettingsStore.getState().hydrate({ autoSave: 'yes', autoSaveDelay: 'fast' })
    expect(useSettingsStore.getState().autoSave).toBe(true)
    expect(useSettingsStore.getState().autoSaveDelay).toBe(DEFAULT_AUTO_SAVE_DELAY)
  })
})
