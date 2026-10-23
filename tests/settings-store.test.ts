import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_SAVE_DELAY,
  DEFAULT_RUN_WHILE_BUSY,
  MAX_AUTO_SAVE_DELAY,
  MIN_AUTO_SAVE_DELAY,
  clampAutoSaveDelay,
  useSettingsStore,
} from '../src/store/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({
    autoSave: true,
    autoSaveDelay: DEFAULT_AUTO_SAVE_DELAY,
    runWhileBusy: DEFAULT_RUN_WHILE_BUSY,
  })
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

describe('settings budget', () => {
  it('clamps the budget to a non-negative number', () => {
    useSettingsStore.getState().setBudgetUsd(5)
    expect(useSettingsStore.getState().budgetUsd).toBe(5)
    useSettingsStore.getState().setBudgetUsd(-3)
    expect(useSettingsStore.getState().budgetUsd).toBe(0)
  })
})

describe('settings run while busy', () => {
  it('defaults to queueing for the next turn', () => {
    expect(useSettingsStore.getState().runWhileBusy).toBe('queue')
  })

  it('hydrates a valid mode and ignores malformed values', () => {
    useSettingsStore.getState().hydrate({ runWhileBusy: 'steer' })
    expect(useSettingsStore.getState().runWhileBusy).toBe('steer')

    useSettingsStore.getState().hydrate({ runWhileBusy: 'later' })
    expect(useSettingsStore.getState().runWhileBusy).toBe('steer')
  })

  it('falls back to queue for unknown values from the setter', () => {
    useSettingsStore.getState().setRunWhileBusy('steer')
    expect(useSettingsStore.getState().runWhileBusy).toBe('steer')

    useSettingsStore.getState().setRunWhileBusy('invalid' as 'steer')
    expect(useSettingsStore.getState().runWhileBusy).toBe('queue')
  })
})
