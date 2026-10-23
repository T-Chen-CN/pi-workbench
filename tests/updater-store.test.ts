import { beforeEach, describe, expect, it } from 'vitest'
import {
  INITIAL_UPDATE_STATE,
  shouldShowUpdatePrompt,
  useUpdaterStore,
} from '../src/store/updaterStore'
import type { UpdateState } from '../src/types/electron'

const downloaded = (version: string): UpdateState => ({
  status: 'downloaded',
  currentVersion: '0.2.0',
  platform: 'win32',
  canAutoInstall: true,
  version,
  percent: 100,
})

beforeEach(() => {
  useUpdaterStore.setState({
    state: INITIAL_UPDATE_STATE,
    deferredVersion: null,
    promptRequested: false,
  })
})

describe('updater store', () => {
  it('prompts once a version is downloaded', () => {
    useUpdaterStore.getState().applyState(downloaded('0.3.0'))
    expect(shouldShowUpdatePrompt(useUpdaterStore.getState())).toBe(true)
  })

  it('stops prompting for a deferred version but not for the next one', () => {
    useUpdaterStore.getState().applyState(downloaded('0.3.0'))
    useUpdaterStore.getState().deferPrompt('0.3.0')
    expect(shouldShowUpdatePrompt(useUpdaterStore.getState())).toBe(false)

    useUpdaterStore.getState().applyState(downloaded('0.4.0'))
    expect(shouldShowUpdatePrompt(useUpdaterStore.getState())).toBe(true)
  })

  it('always opens the prompt when requested from the status bar', () => {
    useUpdaterStore.getState().applyState(downloaded('0.3.0'))
    useUpdaterStore.getState().deferPrompt('0.3.0')
    useUpdaterStore.getState().requestPrompt()
    expect(shouldShowUpdatePrompt(useUpdaterStore.getState())).toBe(true)
  })

  it('never prompts on macOS, where install is manual', () => {
    useUpdaterStore.getState().applyState({ ...downloaded('0.3.0'), canAutoInstall: false })
    expect(shouldShowUpdatePrompt(useUpdaterStore.getState())).toBe(false)
  })
})
