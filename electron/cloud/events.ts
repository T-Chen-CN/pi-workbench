/**
 * SSE 解析。
 *
 * 云端 `/v1/runs/{id}/events` 的线格式是 `id: <seq>` + `data: <json>`，心跳是 `: keepalive`
 * （没有 data 行）。解析必须按「空行分帧」处理，且要能容忍 UTF-8 被切成两半的 chunk。
 */

export interface SseFrame {
  id: number | null
  event: string | null
  data: string
}

function parseBlock(block: string): SseFrame | null {
  let id: number | null = null
  let event: string | null = null
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') {
      const parsed = Number(value)
      id = Number.isFinite(parsed) ? parsed : null
    } else if (field === 'event') {
      event = value
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }

  // 只有注释 / id 没有 data 的帧（心跳）直接丢弃
  if (dataLines.length === 0) return null
  return { id, event, data: dataLines.join('\n') }
}

export class SseParser {
  private buffer = ''

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const frames: SseFrame[] = []
    let index = this.buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      const frame = parseBlock(block)
      if (frame) frames.push(frame)
      index = this.buffer.indexOf('\n\n')
    }
    return frames
  }
}

export type SseEndReason = 'ended' | 'idle' | 'aborted'

export interface ReadSseOptions {
  signal: AbortSignal
  /** 超过该时间没有收到任何字节就判定断流（后端心跳 10s，留足余量） */
  idleTimeoutMs?: number
  onFrame: (frame: SseFrame) => void
}

/** 读完一个 SSE 流；断流 / 空闲 / 主动中止都正常返回原因，异常留给调用方转成错误帧 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions
): Promise<SseEndReason> {
  const { signal, onFrame } = options
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idle = false
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idle = true
      void reader.cancel().catch(() => undefined)
    }, idleTimeoutMs)
  }

  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort)

  resetIdle()
  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined)
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      if (!value || value.length === 0) continue
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        onFrame(frame)
      }
    }
    for (const frame of parser.push(decoder.decode())) onFrame(frame)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
  }

  if (idle) return 'idle'
  if (signal.aborted) return 'aborted'
  return 'ended'
}
