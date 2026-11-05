import { describe, expect, it } from 'vitest'
import { mapMessages, parseToolResult, RunMapper, summarizeArgs } from '../electron/cloud/map'
import type { CloudTracePart } from '../src/types/cloud'

type ToolPart = Extract<CloudTracePart, { type: 'tool' }>
type TextPart = Extract<CloudTracePart, { type: 'text' }>

const MESSAGES = [
  {
    id: 30,
    role: 'user',
    content: 'Run sudo touch /tmp/probe and report',
    timestamp: 1793733048.39,
  },
  {
    id: 31,
    role: 'assistant',
    content: '',
    reasoning_content: 'The user wants a command run.',
    tool_calls: [
      {
        id: 'call_00_abc',
        call_id: 'call_00_abc',
        type: 'function',
        function: { name: 'terminal', arguments: '{"command": "sudo touch /tmp/probe"}' },
      },
    ],
    finish_reason: 'tool_calls',
  },
  {
    id: 32,
    role: 'tool',
    content: '{"output": "-rw-r--r-- 1 root root 0 Nov  4 03:10 /tmp/probe", "exit_code": 0, "error": null}',
    tool_call_id: 'call_00_abc',
    tool_name: 'terminal',
  },
  { id: 33, role: 'assistant', content: 'Done — the file exists.' },
  { id: 34, role: 'session_meta', content: null },
]

describe('summarizeArgs', () => {
  it('prefers the command field', () => {
    expect(summarizeArgs('{"command": "ls -la /tmp"}')).toBe('ls -la /tmp')
  })

  it('falls back to compact json for unknown shapes', () => {
    expect(summarizeArgs('{"foo":"bar"}')).toBe('{"foo":"bar"}')
  })

  it('keeps non-json arguments readable', () => {
    expect(summarizeArgs('plain   text\nwith breaks')).toBe('plain text with breaks')
  })

  it('returns empty for missing arguments', () => {
    expect(summarizeArgs('')).toBe('')
    expect(summarizeArgs(undefined)).toBe('')
  })
})

describe('parseToolResult', () => {
  it('reads output / exit_code / error', () => {
    expect(parseToolResult('{"output":"ok","exit_code":2,"error":null}')).toEqual({
      output: 'ok',
      exitCode: 2,
      error: null,
    })
  })

  it('treats plain text as output', () => {
    expect(parseToolResult('command not found')).toEqual({
      output: 'command not found',
      error: null,
    })
  })
})

describe('mapMessages', () => {
  it('maps the live message shapes into one timeline', () => {
    const parts = mapMessages(MESSAGES)

    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'thinking',
      'tool',
      'text',
      'divider',
    ])

    const tool = parts[2] as ToolPart
    expect(tool.toolName).toBe('terminal')
    expect(tool.toolCallId).toBe('call_00_abc')
    expect(tool.argsSummary).toBe('sudo touch /tmp/probe')
    expect(tool.status).toBe('success')
    expect(tool.exitCode).toBe(0)
    expect(tool.resultPreview).toContain('/tmp/probe')

    const user = parts[0] as TextPart
    expect(user.role).toBe('user')
    expect(user.id).toBe('h:30')
  })

  it('marks unresolved tool calls as errors once the session settled', () => {
    const parts = mapMessages([
      {
        id: 1,
        role: 'assistant',
        content: '',
        tool_calls: [{ call_id: 'c1', function: { name: 'terminal', arguments: '{}' } }],
      },
    ])
    expect((parts[0] as ToolPart).status).toBe('error')

    const live = mapMessages(
      [
        {
          id: 1,
          role: 'assistant',
          content: '',
          tool_calls: [{ call_id: 'c1', function: { name: 'terminal', arguments: '{}' } }],
        },
      ],
      { settled: false }
    )
    expect((live[0] as ToolPart).status).toBe('running')
  })

  it('flags non-zero exit codes as errors', () => {
    const parts = mapMessages([
      {
        id: 1,
        role: 'assistant',
        content: '',
        tool_calls: [{ call_id: 'c1', function: { name: 'terminal', arguments: '{}' } }],
      },
      {
        id: 2,
        role: 'tool',
        content: '{"output":"boom","exit_code":1,"error":null}',
        tool_call_id: 'c1',
        tool_name: 'terminal',
      },
    ])
    expect((parts[0] as ToolPart).status).toBe('error')
    expect((parts[0] as ToolPart).resultPreview).toBe('boom')
  })
})

describe('RunMapper', () => {
  const frame = (payload: Record<string, unknown>, id = 1) => ({
    id,
    event: null,
    data: JSON.stringify({ timestamp: 1, ...payload }),
  })

  it('streams deltas into a single text part', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(frame({ event: 'message.delta', delta: 'Hel' }))
    const frames = mapper.handle(frame({ event: 'message.delta', delta: 'lo' }, 2))

    const part = (frames[0] as { kind: 'part'; part: TextPart }).part
    expect(frames).toHaveLength(1)
    expect(part.text).toBe('Hello')
    expect(mapper.parts).toHaveLength(1)
  })

  it('ignores interim text that was already streamed', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(frame({ event: 'message.delta', delta: 'abc' }))
    const frames = mapper.handle(
      frame({ event: 'message.interim', text: 'abc', already_streamed: true }, 2)
    )
    expect(frames).toEqual([])
    expect(mapper.parts).toHaveLength(1)
  })

  it('pairs tool.started with tool.completed by call id', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(
      frame({
        event: 'tool.started',
        tool: 'terminal',
        preview: 'ls -la',
        tool_call_id: 'c1',
      })
    )
    const frames = mapper.handle(
      frame(
        {
          event: 'tool.completed',
          tool: 'terminal',
          tool_call_id: 'c1',
          error: false,
          duration: 1.25,
          preview: '-rw-r--r-- file',
        },
        2
      )
    )

    const part = (frames[0] as { kind: 'part'; part: ToolPart }).part
    expect(part.status).toBe('success')
    expect(part.durationMs).toBe(1250)
    expect(part.resultPreview).toBe('-rw-r--r-- file')
    expect(mapper.parts).toHaveLength(1)
  })

  it('keeps a second text segment separate after a tool call', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(frame({ event: 'message.delta', delta: 'first' }))
    mapper.handle(frame({ event: 'tool.started', tool: 'terminal', tool_call_id: 'c1' }, 2))
    mapper.handle(frame({ event: 'message.delta', delta: 'second' }, 3))

    const texts = mapper.parts.filter((part): part is TextPart => part.type === 'text')
    expect(texts.map((part) => part.text)).toEqual(['first', 'second'])
  })

  it('emits the terminal state and appends the final answer when nothing streamed', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(
      frame({ event: 'run.completed', output: 'all done', usage: {} })
    )

    expect(frames.some((item) => item.kind === 'run' && item.state === 'completed')).toBe(true)
    const text = mapper.parts.find((part): part is TextPart => part.type === 'text')
    expect(text?.text).toBe('all done')
  })

  it('does not duplicate the answer that was already streamed', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(frame({ event: 'message.delta', delta: 'all done' }))
    mapper.handle(frame({ event: 'run.completed', output: 'all done' }, 2))
    const texts = mapper.parts.filter((part) => part.type === 'text')
    expect(texts).toHaveLength(1)
  })

  it('surfaces failures with the backend message', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(
      frame({ event: 'run.failed', error: 'provider 401' })
    )
    expect(frames[0]).toMatchObject({ kind: 'run', state: 'failed', error: 'provider 401' })
  })
})

describe('插话（steer）', () => {
  const frame = (event: string, payload: Record<string, unknown>, id = 1) => ({
    id,
    event: null,
    data: JSON.stringify({ event, ...payload }),
  })

  it('marks an interjection delivered when run.steered comes back', () => {
    const mapper = new RunMapper('run_1')
    mapper.parts.push({ type: 'interjection', id: 'local:steer:1', text: '换个方向', delivered: false })

    const frames = mapper.handle(frame('run.steered', { input: '换个方向' }, 2))
    const part = frames.find((item) => item.kind === 'part')
    expect(part && 'part' in part ? part.part : null).toMatchObject({
      type: 'interjection',
      delivered: true,
    })
  })

  it('surfaces an undelivered steer via pending_steer on the terminal event', () => {
    const mapper = new RunMapper('run_1')
    mapper.parts.push({ type: 'interjection', id: 'local:steer:1', text: '换个方向', delivered: false })

    const frames = mapper.handle(
      frame('run.completed', { output: 'done', pending_steer: '换个方向' }, 9)
    )
    const interjection = frames
      .filter((item) => item.kind === 'part')
      .map((item) => ('part' in item ? item.part : null))
      .find((part) => part?.type === 'interjection')
    expect(interjection).toMatchObject({ delivered: false, undelivered: true })
  })

  it('leaves no undelivered marker when the run finishes cleanly', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(frame('run.completed', { output: 'x' }, 3))
    expect(
      frames.some((item) => item.kind === 'part' && 'part' in item && item.part.type === 'interjection')
    ).toBe(false)
  })
})

describe('子代理轨道', () => {
  const sse = (payload: Record<string, unknown>, id = 1) => ({
    id,
    event: null,
    data: JSON.stringify({ timestamp: 1, ...payload }),
  })

  it('pairs start and complete by subagent_id', () => {
    const mapper = new RunMapper('run_1')
    const opened = mapper.handle(
      sse({
        event: 'subagent.start',
        goal: '查一下 Caddy 版本',
        subagent_id: 'sa_1',
        task_index: 0,
        task_count: 2,
        model: 'deepseek-flash',
      })
    )
    const started = (opened[0] as { kind: 'part'; part: CloudTracePart }).part
    expect(started).toMatchObject({
      type: 'subagent',
      id: 'sa:sa_1',
      goal: '查一下 Caddy 版本',
      status: 'running',
      model: 'deepseek-flash',
      taskCount: 2,
    })

    const closed = mapper.handle(
      sse(
        {
          event: 'subagent.complete',
          goal: '查一下 Caddy 版本',
          subagent_id: 'sa_1',
          status: 'completed',
          duration_seconds: 4.2,
          summary: 'v2.11.7',
          tool_count: 3,
          input_tokens: 100,
          output_tokens: 20,
          cost_usd: 0.0012,
          files_read: ['a.ts', 'b.ts'],
          files_written: ['c.ts'],
          output_tail: [{ tool: 'terminal', output: 'Caddy v2.11.7' }],
        },
        2
      )
    )
    const done = (closed[0] as { kind: 'part'; part: CloudTracePart }).part
    expect(done).toMatchObject({
      type: 'subagent',
      status: 'completed',
      summary: 'v2.11.7',
      durationMs: 4200,
      toolCount: 3,
      filesRead: 2,
      filesWritten: 1,
    })
    expect((done as Extract<CloudTracePart, { type: 'subagent' }>).outputTail).toContain(
      'Caddy v2.11.7'
    )
  })

  it('keeps two concurrent subagents apart', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'subagent.start', goal: 'A', subagent_id: 'sa_1' }))
    mapper.handle(sse({ event: 'subagent.start', goal: 'B', subagent_id: 'sa_2' }, 2))
    const frames = mapper.handle(
      sse({ event: 'subagent.complete', subagent_id: 'sa_2', status: 'failed', summary: 'boom' }, 3)
    )
    const part = (frames[0] as { kind: 'part'; part: CloudTracePart }).part as Extract<
      CloudTracePart,
      { type: 'subagent' }
    >
    expect(part.id).toBe('sa:sa_2')
    expect(part.status).toBe('failed')
    expect(part.goal).toBe('B')
  })

  it('reports timeout as its own state and keeps the failure reason', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'subagent.start', goal: 'A', subagent_id: 'sa_1' }))
    const frames = mapper.handle(
      sse({
        event: 'subagent.complete',
        subagent_id: 'sa_1',
        status: 'timeout',
        failure_reason: 'inactivity_timeout',
      }, 2)
    )
    const part = (frames[0] as { kind: 'part'; part: CloudTracePart }).part as Extract<
      CloudTracePart,
      { type: 'subagent' }
    >
    expect(part.status).toBe('timeout')
    expect(part.failureReason).toBe('inactivity_timeout')
  })

  it('does not drop a completion that arrives without a start frame', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(
      sse({ event: 'subagent.complete', subagent_id: 'sa_9', status: 'completed', summary: 'ok' })
    )
    const part = (frames[frames.length - 1] as { kind: 'part'; part: CloudTracePart })
      .part as Extract<CloudTracePart, { type: 'subagent' }>
    expect(part.id).toBe('sa:sa_9')
    expect(part.status).toBe('completed')
    expect(part.summary).toBe('ok')
  })

  it('ignores the per-token child chatter', () => {
    const mapper = new RunMapper('run_1')
    expect(mapper.handle(sse({ event: 'subagent.text', subagent_id: 'sa_1', text: 'x' }))).toEqual(
      []
    )
  })
})

describe('clarify', () => {
  const sse = (payload: Record<string, unknown>, id = 1) => ({
    id,
    event: null,
    data: JSON.stringify({ timestamp: 1, ...payload }),
  })

  it('turns a clarify.request into an answerable part', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(
      sse({
        event: 'clarify.request',
        kind: 'clarify',
        prompt_id: 'cl_1',
        execution_generation: 4,
        question: '要发布到哪个环境？',
        choices: ['staging', 'production'],
        multi_select: false,
        timeout_s: 300,
      })
    )
    const part = (frames[0] as { kind: 'part'; part: CloudTracePart }).part
    expect(part).toMatchObject({
      type: 'clarify',
      promptId: 'cl_1',
      generation: 4,
      question: '要发布到哪个环境？',
      choices: ['staging', 'production'],
      timeoutSeconds: 300,
    })
  })

  it('dedupes the prompt when it also arrives from the status poll', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'clarify.request', prompt_id: 'cl_1', question: 'Q', choices: [] }))
    expect(
      mapper.ensureClarify({ kind: 'clarify', prompt_id: 'cl_1', question: 'Q', choices: [] })
    ).toEqual([])
    // 第一次开会补出卡片
    expect(
      mapper.ensureClarify({ kind: 'clarify', prompt_id: 'cl_2', question: 'Q2', choices: [] })[0]
    ).toMatchObject({ kind: 'part' })
  })

  it('marks the prompt settled without inventing an answer', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'clarify.request', prompt_id: 'cl_1', question: 'Q', choices: [] }))
    const frames = mapper.handle(sse({ event: 'clarify.settled', prompt_id: 'cl_1' }, 2))
    const part = (frames[0] as { kind: 'part'; part: CloudTracePart }).part as Extract<
      CloudTracePart,
      { type: 'clarify' }
    >
    expect(part.settled).toBe(true)
    expect(part.answer).toBeUndefined()
  })
})

describe('审批事件', () => {
  const sse = (payload: Record<string, unknown>, id = 1) => ({
    id,
    event: null,
    data: JSON.stringify({ timestamp: 1, ...payload }),
  })

  const approvalPart = (frames: unknown[]): Extract<CloudTracePart, { type: 'approval' }> =>
    (frames[0] as { part: Extract<CloudTracePart, { type: 'approval' }> }).part

  it('builds the card from approval.request with the real request id', () => {
    const mapper = new RunMapper('run_1')
    const frames = mapper.handle(
      sse({
        event: 'approval.request',
        run_id: 'run_1',
        prompt_id: 'ap_42',
        command: 'rm -rf build',
        pattern_keys: ['rm -rf', 'destructive'],
        choices: ['once', 'session', 'deny', 'always'],
        execution_generation: 5,
        timeout_s: 120,
      })
    )
    const part = approvalPart(frames)
    expect(part.requestId).toBe('ap_42')
    expect(part.command).toBe('rm -rf build')
    expect(part.patternKeys).toEqual(['rm -rf', 'destructive'])
    // always 会写服务端永久白名单：映射层就剔掉，UI 拿不到
    expect(part.choices).toEqual(['once', 'session', 'deny'])
    expect(part.generation).toBe(5)
    expect(part.timeoutSeconds).toBe(120)
    expect(part.expiresAt).toBeGreaterThan(Date.now() - 1000)
    expect(part.decision).toBeUndefined()
  })

  it('falls back to the run id when the server gives no prompt id', () => {
    const mapper = new RunMapper('run_9')
    const part = approvalPart(
      mapper.handle(sse({ event: 'approval.request', command: 'ls', choices: [] }))
    )
    expect(part.requestId).toBe('run_9')
    // 服务端没给 choices 时按我们的三项来，绝不补 always
    expect(part.choices).toEqual(['once', 'session', 'deny'])
  })

  it('fills the decision back from approval.responded', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'approval.request', prompt_id: 'ap_1', command: 'ls' }))
    const frames = mapper.handle(
      sse({ event: 'approval.responded', prompt_id: 'ap_1', choice: 'approved', resolved: 1 }, 2)
    )
    const part = approvalPart(frames)
    expect(part.decision).toBe('once')
    expect(part.decidedAt).toBeTypeOf('number')
  })

  it('marks the card settled when someone else picked a choice we do not offer', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'approval.request', prompt_id: 'ap_1', command: 'ls' }))
    const part = approvalPart(
      mapper.handle(sse({ event: 'approval.responded', prompt_id: 'ap_1', choice: 'always' }, 2))
    )
    expect(part.decision).toBeUndefined()
    expect(part.settled).toBe(true)
  })

  it('expires the pending card when the run ends without an answer', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'approval.request', prompt_id: 'ap_1', command: 'ls' }))
    const frames = mapper.handle(sse({ event: 'run.completed', output: 'ok' }, 2))
    const expired = frames.find(
      (frame) =>
        frame.kind === 'part' && frame.part.type === 'approval' && frame.part.expiredAt !== undefined
    )
    expect(expired).toBeTruthy()
  })

  it('dedupes the same approval coming from the status poll', () => {
    const mapper = new RunMapper('run_1')
    mapper.handle(sse({ event: 'approval.request', prompt_id: 'ap_1', command: 'ls' }))
    expect(mapper.ensureApproval({ kind: 'approval', prompt_id: 'ap_1', command: 'ls' })).toEqual([])
    expect(
      mapper.ensureApproval({ kind: 'approval', prompt_id: 'ap_2', command: 'whoami' })[0]
    ).toMatchObject({ kind: 'part' })
  })
})
