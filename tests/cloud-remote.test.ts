import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { createCloudClient } from '../electron/cloud/client'
import { createRemote, toRunStatus } from '../electron/cloud/remote'

function remote() {
  return createRemote(createCloudClient({ baseUrl: 'https://api.example.com', apiKey: 'k' }))
}

describe('run 状态映射', () => {
  it('keeps "unknown" distinct instead of pretending it is running', () => {
    expect(toRunStatus('unknown')).toBe('unknown')
    expect(toRunStatus('queued')).toBe('started')
    expect(toRunStatus('waiting_for_approval')).toBe('waiting_approval')
    // 没见过的新状态仍然按 running 处理（不误判成终态）
    expect(toRunStatus('brand_new_status')).toBe('running')
  })

  it('carries the admission pair so the UI can resolve a lost run', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        run_id: 'run_1',
        status: 'unknown',
        session_id: 's1',
        admission_id: 'adm_1',
        execution_generation: 3,
      })
    )
    await expect(remote().runStatus('run_1')).resolves.toMatchObject({
      status: 'unknown',
      sessionId: 's1',
      admissionId: 'adm_1',
      executionGeneration: 3,
    })
  })
})

describe('resolve-unknown', () => {
  it('sends exactly the two fields the backend accepts', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ run_id: 'run_1', status: 'cancelled', object: 'hermes.run.receipt' })
    )
    await expect(
      remote().resolveUnknownRun({ runId: 'run_1', admissionId: 'adm_1', executionGeneration: 3 })
    ).resolves.toEqual({ status: 'cancelled', sessionId: null })

    const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]
    expect(String(url)).toBe('https://api.example.com/v1/runs/run_1/resolve-unknown')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      admission_id: 'adm_1',
      execution_generation: 3,
    })
  })
})

describe('clarify 应答', () => {
  it('posts exactly the three fields the backend accepts', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: 'resolved', prompt_id: 'cl_1' }))
    await remote().clarifyRun({
      runId: 'run_9',
      requestId: 'cl_1',
      generation: 3,
      answer: 'production',
    })
    const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]
    expect(url).toBe('https://api.example.com/v1/runs/run_9/clarify')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      request_id: 'cl_1',
      execution_generation: 3,
      answer: 'production',
    })
  })
})
