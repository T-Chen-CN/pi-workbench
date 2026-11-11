// @vitest-environment node
/**
 * 派活轨迹：步骤收集、脱敏、上限、缓存与回报副本压缩。
 *
 * 轨迹是「云端事后查」的唯一依据，所以这里重点测三件事：**不留本机绝对路径**、
 * **有上限**、**取消也留下已发生的步骤**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_REPORT_CHARS,
  MAX_STEPS,
  TraceCollector,
  clampForDisk,
  compactTrace,
  readTrace,
  redact,
  traceDir,
  tracePath
} from '../electron/dispatch/trace'

let appDir = ''
const workspace = path.join(os.tmpdir(), 'pi-trace-ws')

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-trace-'))
  fs.mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true })
})

function collector(taskId = 'dt_1', now = () => 1_000): TraceCollector {
  return new TraceCollector(taskId, workspace, now)
}

describe('dispatch trace · 收集', () => {
  it('turns tool_start/tool_end pairs into steps', () => {
    const trace = collector()
    trace.note({ type: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: 'npm test' })
    trace.note({ type: 'tool_end', toolCallId: 'c1', toolName: 'bash', status: 'success', durationMs: 1200 })
    trace.note({ type: 'tool_start', toolCallId: 'c2', toolName: 'read', argsSummary: 'src/a.ts' })
    trace.note({
      type: 'tool_end',
      toolCallId: 'c2',
      toolName: 'read',
      status: 'error',
      durationMs: 40,
      resultPreview: 'ENOENT'
    })

    expect(trace.snapshot()).toMatchObject({
      total: 2,
      truncated: false,
      steps: [
        { tool: 'bash', args: 'npm test', ok: true, ms: 1200 },
        { tool: 'read', args: 'src/a.ts', ok: false, ms: 40, result: 'ENOENT' }
      ]
    })
  })

  it('strips terminal colour codes before clipping the result', () => {
    // 实测：31% 的 powershell 结果是带色的，160 字的预算里平均 47 个字节是 ESC 码，
    // 而这份摘要是回报给云端的那一份。
    const trace = collector()
    trace.note({ type: 'tool_start', toolCallId: 'c1', toolName: 'powershell', argsSummary: 'dotnet build' })
    trace.note({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'powershell',
      status: 'error',
      durationMs: 30,
      resultPreview: '\u001b[31;1mdotnet: \u001b[0m\u001b[36;1mLine |\u001b[0m \u001b[31;1m命令未找到\u001b[0m'
    })

    const step = trace.snapshot().steps[0]
    expect(step?.result).toBe('dotnet: Line | 命令未找到')
    expect(step?.result).not.toContain('\u001b')
  })

  it('keeps a failed step for calls that never ended (cancel / crash)', () => {
    const trace = collector()
    trace.note({ type: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: 'sleep 900' })
    trace.finish()
    const steps = trace.snapshot().steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ tool: 'bash', ok: false })
    expect(steps[0].result).toContain('取消或中断')
  })

  it('caps the step list but keeps counting', () => {
    const trace = collector()
    for (let index = 0; index < MAX_STEPS + 5; index += 1) {
      trace.note({ type: 'tool_start', toolCallId: `c${index}`, toolName: 'bash', argsSummary: 'x' })
      trace.note({ type: 'tool_end', toolCallId: `c${index}`, toolName: 'bash', status: 'success' })
    }
    const snapshot = trace.snapshot()
    expect(snapshot.steps).toHaveLength(MAX_STEPS)
    expect(snapshot.total).toBe(MAX_STEPS + 5)
    expect(snapshot.truncated).toBe(true)
  })

  it('records changed files relative to the workspace', () => {
    const trace = collector()
    const file = path.join(workspace, 'src', 'deep', 'a.ts')
    trace.note({ type: 'tool_start', toolCallId: 'c1', toolName: 'edit', argsSummary: file })
    trace.note({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'edit',
      status: 'success',
      filePath: file
    })
    expect(trace.snapshot().steps[0].file).toBe('src/deep/a.ts')
  })
})

describe('dispatch trace · 脱敏', () => {
  it('strips the workspace path from summaries', () => {
    expect(redact(`open ${workspace}\\src\\a.ts`, workspace)).toContain('src\\a.ts')
    expect(redact(`open ${workspace}\\src\\a.ts`, workspace)).not.toContain(workspace)
  })

  it('strips the git-bash form of the workspace path', () => {
    const windowsRoot = 'D:\\work\\repo'
    const text = redact('cd /d/work/repo && npm test', windowsRoot)
    expect(text).not.toContain('/d/work/repo')
    expect(text).toContain('npm test')
  })

  it('collapses git-bash mounted drive paths outside the workspace', () => {
    const text = redact('ls -la /d/tmp && cd /d/tmp/trace-ws', 'D:\tmp\trace-ws')
    expect(text).not.toContain('/d/tmp')
    expect(text).toContain('tmp')
  })

  it('collapses outside absolute paths to a bare file name', () => {
    const text = redact('cat D:\\secret\\keys.txt and /home/ubuntu/.env', workspace)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('/home/ubuntu')
    expect(text).toContain('keys.txt')
    expect(text).toContain('.env')
  })
})

describe('dispatch trace · 落盘与回报副本', () => {
  it('writes a cache file that can be read back', async () => {
    const trace = collector('dt_cache')
    trace.note({ type: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: 'ls' })
    trace.note({ type: 'tool_end', toolCallId: 'c1', toolName: 'bash', status: 'success', durationMs: 5 })
    await trace.flush(traceDir(appDir))

    expect(fs.existsSync(tracePath(traceDir(appDir), 'dt_cache'))).toBe(true)
    await expect(readTrace(traceDir(appDir), 'dt_cache')).resolves.toMatchObject({ total: 1 })
  })

  it('returns null for an unknown task', async () => {
    await expect(readTrace(traceDir(appDir), 'dt_missing')).resolves.toBe(null)
  })

  it('drops result previews before dropping steps', () => {
    const trace = collector()
    for (let index = 0; index < 40; index += 1) {
      trace.note({ type: 'tool_start', toolCallId: `c${index}`, toolName: 'bash', argsSummary: 'x' })
      trace.note({
        type: 'tool_end',
        toolCallId: `c${index}`,
        toolName: 'bash',
        status: 'success',
        resultPreview: 'r'.repeat(160)
      })
    }
    const compact = compactTrace(trace.snapshot(), 4_000)
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(4_000)
    expect(compact.steps.every((step) => step.result === undefined)).toBe(true)
    expect(compact.steps).toHaveLength(40)
  })

  it('keeps the report copy under the default budget', () => {
    const trace = collector()
    for (let index = 0; index < MAX_STEPS; index += 1) {
      trace.note({ type: 'tool_start', toolCallId: `c${index}`, toolName: 'bash', argsSummary: 'a'.repeat(200) })
      trace.note({
        type: 'tool_end',
        toolCallId: `c${index}`,
        toolName: 'bash',
        status: 'success',
        resultPreview: 'r'.repeat(160),
        durationMs: 10
      })
    }
    const compact = compactTrace(trace.snapshot())
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(MAX_REPORT_CHARS)
    expect(compact.steps.length).toBeGreaterThan(0)
  })

  it('clamps the on-disk copy', () => {
    const trace = collector()
    for (let index = 0; index < MAX_STEPS; index += 1) {
      trace.note({ type: 'tool_start', toolCallId: `c${index}`, toolName: 'bash', argsSummary: 'a'.repeat(200) })
      trace.note({
        type: 'tool_end',
        toolCallId: `c${index}`,
        toolName: 'bash',
        status: 'success',
        resultPreview: 'r'.repeat(160)
      })
    }
    expect(JSON.stringify(clampForDisk(trace.snapshot())).length).toBeLessThanOrEqual(64 * 1024)
  })
})
