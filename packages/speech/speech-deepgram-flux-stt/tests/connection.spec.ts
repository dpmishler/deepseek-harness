import { describe, expect, it } from 'vitest'
import type { WebSocketFactory, WebSocketLike } from '../src/connection.ts'
import { DEFAULT_BASE_URL, FluxSttConnection, resolveDefaultWebSocketFactory } from '../src/connection.ts'
import type { SttEvent } from '@deepseek-ai/dsh-speech'

/** A fully scripted `WebSocketLike` double: the test drives every event by hand. */
class FakeSocket implements WebSocketLike {
  sent: (string | Uint8Array)[] = []
  closedWith: { code: number | undefined; reason: string | undefined } | undefined
  private openListener: (() => void) | undefined
  private messageListener: ((event: { data: unknown }) => void) | undefined
  private closeListener: ((event: { code: number; reason: string }) => void) | undefined
  private errorListener: ((event: { message?: string }) => void) | undefined

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
  }

  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(event: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(event: 'error', listener: (event: { message?: string }) => void): void
  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'open') this.openListener = listener
    if (event === 'message') this.messageListener = listener as (event: { data: unknown }) => void
    if (event === 'close') this.closeListener = listener as (event: { code: number; reason: string }) => void
    if (event === 'error') this.errorListener = listener as (event: { message?: string }) => void
  }

  fireOpen(): void {
    this.openListener?.()
  }

  fireMessage(data: unknown): void {
    this.messageListener?.({ data })
  }

  fireClose(code: number, reason: string): void {
    this.closeListener?.({ code, reason })
  }

  fireError(message?: string): void {
    this.errorListener?.(message === undefined ? {} : { message })
  }
}

/** Build a connection whose factory captures the constructed URL/headers and returns a controllable `FakeSocket`. */
function makeConnection(overrides: Partial<ConstructorParameters<typeof FluxSttConnection>[0]> = {}) {
  const socket = new FakeSocket()
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}
  const createWebSocket: WebSocketFactory = (url, headers) => {
    capturedUrl = url
    capturedHeaders = headers
    return socket
  }
  const connection = new FluxSttConnection({
    apiKey: 'test-key',
    baseURL: DEFAULT_BASE_URL,
    model: 'flux-general-en',
    options: { provider: 'deepgram-flux' },
    createWebSocket,
    ...overrides,
  })
  return { connection, socket, url: () => capturedUrl, headers: () => capturedHeaders }
}

async function collect(iterable: AsyncIterable<SttEvent>, count: number): Promise<SttEvent[]> {
  const out: SttEvent[] = []
  for await (const event of iterable) {
    out.push(event)
    if (out.length >= count) break
  }
  return out
}

// ── URL construction ────────────────────────────────────────────────────────────

describe('FluxSttConnection URL construction', () => {
  it('always sets model on /v2/listen', () => {
    const { connection, url } = makeConnection()
    void connection.connect()
    expect(url()).toBe('wss://api.deepgram.com/v2/listen?model=flux-general-en')
  })

  it('sends the API key as an Authorization: Token header', () => {
    const { connection, headers } = makeConnection({ apiKey: 'abc123' })
    void connection.connect()
    expect(headers()).toEqual({ Authorization: 'Token abc123' })
  })

  it('sets encoding and sample_rate only when options.audio is present', () => {
    const { connection, url } = makeConnection({
      options: { provider: 'deepgram-flux', audio: { encoding: 'linear16', sampleRateHz: 16000 } },
    })
    void connection.connect()
    expect(url()).toContain('encoding=linear16')
    expect(url()).toContain('sample_rate=16000')
  })

  it('omits encoding/sample_rate for containerized audio (no options.audio)', () => {
    const { connection, url } = makeConnection()
    void connection.connect()
    expect(url()).not.toContain('encoding=')
    expect(url()).not.toContain('sample_rate=')
  })

  it('sets end-of-turn threshold params from options.endOfTurn', () => {
    const { connection, url } = makeConnection({
      options: {
        provider: 'deepgram-flux',
        endOfTurn: { confidence: 0.8, eagerConfidence: 0.4, timeoutMs: 6000 },
      },
    })
    void connection.connect()
    expect(url()).toContain('eot_threshold=0.8')
    expect(url()).toContain('eager_eot_threshold=0.4')
    expect(url()).toContain('eot_timeout_ms=6000')
  })

  it('repeats keyterm and language_hint for each entry', () => {
    const { connection, url } = makeConnection({
      options: { provider: 'deepgram-flux', keyterms: ['apple', 'banana'], languageHints: ['en', 'es'] },
    })
    void connection.connect()
    const parsed = new URL(url())
    expect(parsed.searchParams.getAll('keyterm')).toEqual(['apple', 'banana'])
    expect(parsed.searchParams.getAll('language_hint')).toEqual(['en', 'es'])
  })

  it('strips a trailing slash from a custom baseURL', () => {
    const { connection, url } = makeConnection({ baseURL: 'wss://custom.example/' })
    void connection.connect()
    expect(url()).toBe('wss://custom.example/v2/listen?model=flux-general-en')
  })
})

// ── connect() lifecycle ──────────────────────────────────────────────────────────

describe('FluxSttConnection connect()', () => {
  it('resolves once the socket opens', async () => {
    const { connection, socket } = makeConnection()
    const opened = connection.connect()
    socket.fireOpen()
    await expect(opened).resolves.toBeUndefined()
  })

  it('rejects when the socket errors before opening', async () => {
    const { connection, socket } = makeConnection()
    const opened = connection.connect()
    socket.fireError('handshake refused')
    await expect(opened).rejects.toThrow('handshake refused')
  })

  it('rejects with a default message when the socket errors before opening with no message', async () => {
    const { connection, socket } = makeConnection()
    const opened = connection.connect()
    socket.fireError()
    await expect(opened).rejects.toThrow('Deepgram Flux STT WebSocket handshake failed')
  })

  it('rejects immediately without opening a socket when options.signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let socketCreated = false
    const createWebSocket: WebSocketFactory = () => { socketCreated = true; return new FakeSocket() }
    const connection = new FluxSttConnection({
      apiKey: 'test-key',
      baseURL: DEFAULT_BASE_URL,
      model: 'flux-general-en',
      options: { provider: 'deepgram-flux', signal: controller.signal },
      createWebSocket,
    })
    await expect(connection.connect()).rejects.toThrow(expect.objectContaining({ code: 'CONNECT_ABORTED' }))
    expect(socketCreated).toBe(false)
  })

  it('rejects and closes the socket when options.signal aborts before the handshake completes', async () => {
    const controller = new AbortController()
    const { connection, socket } = makeConnection({ options: { provider: 'deepgram-flux', signal: controller.signal } })
    const opened = connection.connect()
    controller.abort()
    await expect(opened).rejects.toThrow(expect.objectContaining({ code: 'CONNECT_ABORTED' }))
    expect(socket.closedWith).toBeDefined()
  })

  it('ignores a signal abort that fires after the handshake has already completed', async () => {
    const controller = new AbortController()
    const { connection, socket } = makeConnection({ options: { provider: 'deepgram-flux', signal: controller.signal } })
    const opened = connection.connect()
    socket.fireOpen()
    await expect(opened).resolves.toBeUndefined()
    expect(() => { controller.abort() }).not.toThrow()
    expect(socket.closedWith).toBeUndefined()
  })
})

// ── message mapping ──────────────────────────────────────────────────────────────

describe('FluxSttConnection message mapping', () => {
  it('maps Connected to a connected event', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-1' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'connected', requestId: 'req-1' })
  })

  it.each([
    ['Update', 'progress'],
    ['StartOfTurn', 'started'],
    ['EagerEndOfTurn', 'eager-completed'],
    ['TurnResumed', 'resumed'],
    ['EndOfTurn', 'completed'],
  ] as const)('maps TurnInfo event %s to turn kind %s', async (wireEvent, kind) => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'TurnInfo',
      event: wireEvent,
      turn_index: 2,
      audio_window_start: 0.1,
      audio_window_end: 0.5,
      transcript: 'hello there',
      words: [{ word: 'hello', confidence: 0.9, start: 0.1, end: 0.3 }],
      end_of_turn_confidence: 0.7,
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'turn',
      kind,
      turnIndex: 2,
      transcript: 'hello there',
      words: [{ text: 'hello', confidence: 0.9, startSec: 0.1, endSec: 0.3 }],
      endOfTurnConfidence: 0.7,
      audioWindowStartSec: 0.1,
      audioWindowEndSec: 0.5,
    })
  })

  it('includes languages on a multilingual TurnInfo message', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      turn_index: 0,
      audio_window_start: 0,
      audio_window_end: 1,
      transcript: 'hola',
      words: [],
      end_of_turn_confidence: 0.9,
      languages: ['es', 'en'],
    }))
    const [event] = await collect(connection, 1)
    expect(event).toMatchObject({ languages: ['es', 'en'] })
  })

  it('maps a fatal Error message', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'boom' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'error', code: 'INTERNAL_SERVER_ERROR', message: 'boom', fatal: true })
  })

  it('maps ConfigureSuccess to an ok configure-ack', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'ConfigureSuccess', thresholds: { eot_threshold: 0.8 } }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'configure-ack', ok: true })
  })

  it('maps ConfigureFailure to a failed configure-ack with code/message', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'ConfigureFailure',
      code: 'INVALID_THRESHOLD',
      description: 'eager_eot_threshold must be <= eot_threshold',
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'configure-ack',
      ok: false,
      failureCode: 'INVALID_THRESHOLD',
      failureMessage: 'eager_eot_threshold must be <= eot_threshold',
    })
  })

  it('maps ConfigureFailure with no code/description to a bare failed configure-ack', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'ConfigureFailure' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'configure-ack', ok: false })
  })

  it('drops a non-JSON text frame instead of throwing', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage('not json')
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-2' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'connected', requestId: 'req-2' })
  })

  it('ignores a binary message frame', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(new Uint8Array([1, 2, 3]))
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-3' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'connected', requestId: 'req-3' })
  })

  it('drops an unrecognized message type for forward compatibility', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'SomeFutureMessage', foo: 'bar' }))
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-4' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'connected', requestId: 'req-4' })
  })
})

// ── sendAudio / configure / close ─────────────────────────────────────────────────

describe('FluxSttConnection sendAudio/configure/close', () => {
  it('sends raw audio bytes verbatim', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const chunk = new Uint8Array([1, 2, 3])
    connection.sendAudio(chunk)
    expect(socket.sent).toContain(chunk)
  })

  it('is a no-op to send audio after close', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const closed = connection.close()
    socket.fireClose(1000, 'normal')
    await closed
    socket.sent = []
    connection.sendAudio(new Uint8Array([9]))
    expect(socket.sent).toEqual([])
  })

  it('builds a Configure message with nested thresholds', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({ endOfTurnConfidence: 0.8, eagerEndOfTurnConfidence: 0.4, endOfTurnTimeoutMs: 6000 })
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'Configure',
      thresholds: { eot_threshold: 0.8, eager_eot_threshold: 0.4, eot_timeout_ms: 6000 },
    })
  })

  it('replaces keyterms with an empty array to clear them', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({ keyterms: [] })
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Configure', keyterms: [] })
  })

  it('omits language_hints when null (keep current) but includes an empty array (clear)', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({ languageHints: null })
    connection.configure({ languageHints: [] })
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Configure' })
    expect(JSON.parse(socket.sent[1] as string)).toEqual({ type: 'Configure', language_hints: [] })
  })

  it('sends no thresholds object when no threshold field is set', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({ keyterms: ['x'] })
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Configure', keyterms: ['x'] })
  })

  it('sends CloseStream and waits for the server to close the transport', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const closing = connection.close()
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'CloseStream' })
    expect(socket.closedWith).toBeUndefined()
    socket.fireClose(1000, 'normal')
    await expect(closing).resolves.toBeUndefined()
  })

  it('does not resolve close() until the server actually closes the transport', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    let settled = false
    const closing = connection.close().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.fireClose(1000, 'normal')
    await closing
    expect(settled).toBe(true)
  })

  it('close() is idempotent: a second call returns the same settlement', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const first = connection.close()
    socket.fireClose(1000, 'normal')
    await first
    socket.sent = []
    await connection.close()
    expect(socket.sent).toEqual([])
  })
})

// ── unexpected close / transport error ────────────────────────────────────────────

describe('FluxSttConnection unexpected transport events', () => {
  it('yields a closed event with the server close code/reason', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1011, 'server error')
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'closed', code: 1011, reason: 'server error' })
  })

  it('surfaces a post-open transport error as a non-fatal error event, then finishes on close', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireError('read failed')
    const [errorEvent] = await collect(connection, 1)
    expect(errorEvent).toEqual({ type: 'error', code: 'TRANSPORT_ERROR', message: 'read failed', fatal: false })
    socket.fireClose(1006, 'abnormal')
  })

  it('terminates the async iterator after the closed event', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1000, 'normal')
    const events: SttEvent[] = []
    for await (const event of connection) events.push(event)
    expect(events).toEqual([{ type: 'closed', code: 1000, reason: 'normal' }])
  })

  it('surfaces a post-open transport error with a default message when none is given', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireError()
    const [errorEvent] = await collect(connection, 1)
    expect(errorEvent).toEqual({ type: 'error', code: 'TRANSPORT_ERROR', message: 'WebSocket error', fatal: false })
  })

  it('ignores a second close event once the connection has already finished', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1000, 'first')
    socket.fireClose(1006, 'second')
    const events = await collect(connection, 1)
    expect(events).toEqual([{ type: 'closed', code: 1000, reason: 'first' }])
  })

  it('drops a Configure control message once the connection has closed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1000, 'normal')
    await collect(connection, 1)
    socket.sent = []
    connection.configure({ keyterms: ['x'] })
    expect(socket.sent).toEqual([])
  })

  it('waits for the next enqueued event when the iterator has drained the queue', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const iterator = connection[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-3' }))
    const result = await pending
    expect(result).toEqual({ done: false, value: { type: 'connected', requestId: 'req-3' } })
  })
})

// ── default WebSocket factory resolution ────────────────────────────────────────────

describe('resolveDefaultWebSocketFactory', () => {
  it('resolves to a callable factory backed by undici', async () => {
    const factory = await resolveDefaultWebSocketFactory()
    expect(typeof factory).toBe('function')
  })
})
