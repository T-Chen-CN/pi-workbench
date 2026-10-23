import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  eventToShortcut,
  findConflict,
  formatShortcut,
  matchShortcut,
  normalizeKeybindings,
} from '../src/utils/keybindings'

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent
}

describe('matchShortcut', () => {
  it('matches mod+shift+p on Windows/Linux semantics', () => {
    const event = keyEvent({ key: 'P', ctrlKey: true, shiftKey: true })
    expect(matchShortcut(event, 'mod+shift+p')).toBe(true)
    expect(matchShortcut(event, 'mod+p')).toBe(false)
    expect(matchShortcut(keyEvent({ key: 'p', ctrlKey: true }), 'mod+p')).toBe(true)
    expect(matchShortcut(keyEvent({ key: ',', ctrlKey: true }), 'mod+,')).toBe(true)
  })

  it('rejects malformed combinations', () => {
    expect(matchShortcut(keyEvent({ key: 'p', ctrlKey: true }), 'p')).toBe(false)
  })
})

describe('eventToShortcut', () => {
  it('normalizes modifier keys', () => {
    expect(eventToShortcut(keyEvent({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(
      'mod+shift+p'
    )
    expect(eventToShortcut(keyEvent({ key: ',', ctrlKey: true }))).toBe('mod+,')
  })

  it('ignores modifier-only and unmodified keys', () => {
    expect(eventToShortcut(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(eventToShortcut(keyEvent({ key: 'a' }))).toBeNull()
  })
})

describe('formatShortcut', () => {
  it('renders a readable label', () => {
    expect(formatShortcut('mod+shift+p', false)).toBe('Ctrl+Shift+P')
    expect(formatShortcut('mod+,', false)).toBe('Ctrl+,')
  })
})

describe('normalizeKeybindings', () => {
  it('keeps valid overrides and ignores invalid ones', () => {
    expect(normalizeKeybindings({ settings: 'mod+alt+s' }).settings).toBe('mod+alt+s')
    expect(normalizeKeybindings({ settings: 'nope' }).settings).toBe(
      DEFAULT_KEYBINDINGS.settings
    )
  })
})

describe('findConflict', () => {
  it('detects duplicates across commands', () => {
    const bindings = { ...DEFAULT_KEYBINDINGS, settings: 'mod+shift+p' }
    expect(findConflict(bindings, 'mod+shift+p', 'commandPalette')).toBe('settings')
    expect(findConflict(bindings, 'mod+k', 'commandPalette')).toBeNull()
  })
})
