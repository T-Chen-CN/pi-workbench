import { describe, expect, it } from 'vitest'
import { readSseStream, SseParser } from '../electron/cloud/events'

describe('SseParser', () => {
  it('parses id + data frames and drops keepalive comments', () => {
    const parser = new SseParser()
    const frames = parser.push(': keepalive\n\nid: 3\ndata: {"event":"message.delta"}\n\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({
      id: 3,
      event: null,
      data: '{"event":"message.delta"}',
    })
  })

  it('keeps partial blocks until the terminator arrives', () => {
    const parser = new SseParser()
    expect(parser.push('id: 1\ndata: {"a"')).toEqual([])
    const frames = parser.push(':1}\n\n')
    expect(frames).toHaveLength(1)
    expect(frames[0].data).toBe('{"a":1}')
  })

  it('handles CRLF and multiple data lines', () => {
    const parser = new SseParser()
    const frames = parser.push('id: 7\r\nevent: run.completed\r\ndata: line1\r\ndata: line2\r\n\r\n')
    expect(frames[0]).toEqual({ id: 7, event: 'run.completed', data: 'line1\nline2' })
  })

  it('parses several frames from one chunk', () => {
    const parser = new SseParser()
    const frames = parser.push('id: 1\ndata: a\n\nid: 2\ndata: b\n\n')
    expect(frames.map((frame) => frame.data)).toEqual(['a', 'b'])
  })
})

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('readSseStream', () => {
  it('decodes a stream that splits multi-byte characters across chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"思考"}\n\n')
    const split = 12 // 落在多字节字符中间
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split))
        controller.enqueue(bytes.slice(split))
        controller.close()
      },
    })

    const frames: string[] = []
    const reason = await readSseStream(stream, {
      signal: new AbortController().signal,
      onFrame: (frame) => frames.push(frame.data),
    })

    expect(reason).toBe('ended')
    expect(frames).toEqual(['{"text":"思考"}'])
  })

  it('stops reading and reports aborted when the caller cancels', async () => {
    const controller = new AbortController()
    let pushes = 0
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: hi\n\n'))
        pushes += 1
      },
      cancel() {},
    })

    setTimeout(() => controller.abort(), 0)

    const frames: string[] = []
    const reason = await readSseStream(stream, {
      signal: controller.signal,
      onFrame: (frame) => frames.push(frame.data),
    })

    expect(reason).toBe('aborted')
    expect(frames).toEqual(['hi'])
    expect(pushes).toBe(1)
  })

  it('does not read at all when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const frames: string[] = []
    const reason = await readSseStream(streamOf(['data: 1\n\n']), {
      signal: controller.signal,
      onFrame: (frame) => frames.push(frame.data),
    })
    expect(reason).toBe('aborted')
    expect(frames).toEqual([])
  })

  it('reads a simple stream to the end', async () => {
    const frames: string[] = []
    const reason = await readSseStream(streamOf(['data: 1\n\n', 'data: 2\n\n']), {
      signal: new AbortController().signal,
      onFrame: (frame) => frames.push(frame.data),
    })
    expect(reason).toBe('ended')
    expect(frames).toEqual(['1', '2'])
  })
})
