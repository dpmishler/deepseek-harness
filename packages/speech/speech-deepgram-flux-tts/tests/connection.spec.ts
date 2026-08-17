import { describe, expect, it } from 'vitest'
import type { WebSocketFactory, WebSocketLike } from '../src/connection.ts'
import { DEFAULT_BASE_URL, FluxTtsConnection, resolveDefaultWebSocketFactory } from '../src/connection.ts'
import type { TtsEvent } from '@deepseek-ai/dsh-speech'

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

function makeConnection(overrides: Partial<ConstructorParameters<typeof FluxTtsConnection>[0]> = {}) {
  const socket = new FakeSocket()
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}
  const createWebSocket: WebSocketFactory = (url, headers) => {
    capturedUrl = url
    capturedHeaders = headers
    return socket
  }
  const connection = new FluxTtsConnection({
    apiKey: 'test-key',
    baseURL: DEFAULT_BASE_URL,
    model: 'flux-alexis-en',
    options: { provider: 'deepgram-flux' },
    createWebSocket,
    ...overrides,
  })
  return { connection, socket, url: () => capturedUrl, headers: () => capturedHeaders }
}

async function collect(iterable: AsyncIterable<TtsEvent>, count: number): Promise<TtsEvent[]> {
  const out: TtsEvent[] = []
  for await (const event of iterable) {
    out.push(event)
    if (out.length >= count) break
  }
  return out
}

// ── URL construction ────────────────────────────────────────────────────────────

describe('FluxTtsConnection URL construction', () => {
  it('always sets model on /v2/speak', () => {
    const { connection, url } = makeConnection()
    void connection.connect()
    expect(url()).toBe('wss://api.deepgram.com/v2/speak?model=flux-alexis-en')
  })

  it('sends the API key as an Authorization: Token header', () => {
    const { connection, headers } = makeConnection({ apiKey: 'abc123' })
    void connection.connect()
    expect(headers()).toEqual({ Authorization: 'Token abc123' })
  })

  it('sets encoding and sample_rate only when options.audio is present', () => {
    const { connection, url } = makeConnection({
      options: { provider: 'deepgram-flux', audio: { encoding: 'linear16', sampleRateHz: 24000 } },
    })
    void connection.connect()
    expect(url()).toContain('encoding=linear16')
    expect(url()).toContain('sample_rate=24000')
  })

  it('omits encoding/sample_rate when options.audio is absent (model native rate)', () => {
    const { connection, url } = makeConnection()
    void connection.connect()
    expect(url()).not.toContain('encoding=')
    expect(url()).not.toContain('sample_rate=')
  })

  it('sets speed and expressivity only when provided', () => {
    const { connection, url } = makeConnection({
      options: { provider: 'deepgram-flux', speed: 1.1, expressivity: -1 },
    })
    void connection.connect()
    expect(url()).toContain('speed=1.1')
    expect(url()).toContain('expressivity=-1')
  })

  it('omits speed/expressivity when not provided', () => {
    const { connection, url } = makeConnection()
    void connection.connect()
    expect(url()).not.toContain('speed=')
    expect(url()).not.toContain('expressivity=')
  })

  it('strips a trailing slash from a custom baseURL', () => {
    const { connection, url } = makeConnection({ baseURL: 'wss://custom.example/' })
    void connection.connect()
    expect(url()).toBe('wss://custom.example/v2/speak?model=flux-alexis-en')
  })
})

// ── connect() lifecycle ──────────────────────────────────────────────────────────

describe('FluxTtsConnection connect()', () => {
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
    await expect(opened).rejects.toThrow('Deepgram Flux TTS WebSocket handshake failed')
  })

  it('rejects immediately without opening a socket when options.signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let socketCreated = false
    const createWebSocket: WebSocketFactory = () => { socketCreated = true; return new FakeSocket() }
    const connection = new FluxTtsConnection({
      apiKey: 'test-key',
      baseURL: DEFAULT_BASE_URL,
      model: 'flux-haley-en',
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

describe('FluxTtsConnection message mapping', () => {
  it('maps Connected to a connected event with requestId and modelName', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-1', model_name: 'flux-alexis-en' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'connected', requestId: 'req-1', modelName: 'flux-alexis-en' })
  })

  it('maps SpeechStarted to turn-started and tracks the active turn id', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'SpeechStarted', speech_id: 'turn-1' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'turn-started', turnId: 'turn-1' })
  })

  it('attaches the active turn id to binary audio frames', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'SpeechStarted', speech_id: 'turn-1' }))
    const chunk = new Uint8Array([1, 2, 3])
    socket.fireMessage(chunk)
    const [started, audio] = await collect(connection, 2)
    expect(started).toMatchObject({ type: 'turn-started' })
    expect(audio).toEqual({ type: 'audio', turnId: 'turn-1', data: chunk })
  })

  it('drops a binary frame received before any SpeechStarted', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(new Uint8Array([9]))
    socket.fireMessage(JSON.stringify({ type: 'SpeechStarted', speech_id: 'turn-1' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'turn-started', turnId: 'turn-1' })
  })

  it('ignores a non-binary, non-string message frame', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(12345)
    socket.fireMessage(JSON.stringify({ type: 'SpeechStarted', speech_id: 'turn-1' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'turn-started', turnId: 'turn-1' })
  })

  it('maps SpeechMetadata to turn-completed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'SpeechMetadata',
      speech_id: 'turn-1',
      audio_duration_ms: 3200,
      input_character_count: 47,
      billable_character_count: 45,
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'turn-completed',
      turnId: 'turn-1',
      audioDurationMs: 3200,
      inputCharacterCount: 47,
      billableCharacterCount: 45,
    })
  })

  it('maps SpeechInterrupted with textSpoken/textRemaining', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'SpeechInterrupted',
      audio_played_ms: 2340,
      text_spoken: 'Sure, I can help.',
      text_remaining: ' Let me pull that up.',
      metadata: { speech_id: 'turn-1', audio_duration_ms: 2340, input_character_count: 75, billable_character_count: 75 },
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Sure, I can help.',
      textRemaining: ' Let me pull that up.',
      metrics: { turnId: 'turn-1', audioDurationMs: 2340, inputCharacterCount: 75, billableCharacterCount: 75 },
    })
  })

  it('maps SpeechInterrupted without text fields when no playback offset was supplied by the caller', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'SpeechInterrupted',
      audio_played_ms: 1000,
      metadata: { speech_id: 'turn-1', audio_duration_ms: 1000, input_character_count: 10, billable_character_count: 10 },
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'turn-interrupted',
      audioPlayedMs: 1000,
      metrics: { turnId: 'turn-1', audioDurationMs: 1000, inputCharacterCount: 10, billableCharacterCount: 10 },
    })
  })

  it('maps Flushed to turn-flushed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Flushed', speech_id: 'turn-1' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'turn-flushed', turnId: 'turn-1' })
  })

  it('maps SessionMetadata to session-completed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'SessionMetadata',
      total_audio_duration_ms: 184500,
      total_input_character_count: 4280,
      total_billable_character_count: 4180,
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'session-completed',
      totalAudioDurationMs: 184500,
      totalInputCharacterCount: 4280,
      totalBillableCharacterCount: 4180,
    })
  })

  it('maps ConfigureSuccess to an ok configure-ack with appliedSpeed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'ConfigureSuccess', applied: { speed: 1.05 } }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'configure-ack', ok: true, appliedSpeed: 1.05 })
  })

  it('maps ConfigureFailure to a failed configure-ack with code/field/value/message', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({
      type: 'ConfigureFailure',
      code: 'SPEED_OUT_OF_RANGE',
      description: 'speed must be between 0.85 and 1.15',
      field: 'speed',
      value: 3.5,
    }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({
      type: 'configure-ack',
      ok: false,
      failureCode: 'SPEED_OUT_OF_RANGE',
      failureMessage: 'speed must be between 0.85 and 1.15',
      failureField: 'speed',
      failureValue: 3.5,
    })
  })

  it('maps ConfigureSuccess to an ok configure-ack with no appliedSpeed when the reply omits it', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'ConfigureSuccess', applied: {} }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'configure-ack', ok: true })
  })

  it('maps ConfigureFailure to a failed configure-ack with no field/value when the reply omits them', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'ConfigureFailure', code: 'SPEED_OUT_OF_RANGE', description: 'bad speed' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'configure-ack', ok: false, failureCode: 'SPEED_OUT_OF_RANGE', failureMessage: 'bad speed' })
  })

  it('maps Warning to a non-fatal warning event', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Warning', code: 'NO_ACTIVE_SPEECH', description: 'no active turn' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'warning', code: 'NO_ACTIVE_SPEECH', message: 'no active turn' })
  })

  it('maps a fatal Error message', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'Error', code: 'MESSAGE-0000', description: 'could not be parsed' }))
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'error', code: 'MESSAGE-0000', message: 'could not be parsed' })
  })

  it('drops a non-JSON text frame instead of throwing', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage('not json')
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-2', model_name: 'flux-alexis-en' }))
    const [event] = await collect(connection, 1)
    expect(event).toMatchObject({ type: 'connected' })
  })

  it('drops an unrecognized message type for forward compatibility', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireMessage(JSON.stringify({ type: 'SomeFutureMessage', foo: 'bar' }))
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-3', model_name: 'flux-alexis-en' }))
    const [event] = await collect(connection, 1)
    expect(event).toMatchObject({ type: 'connected' })
  })
})

// ── speak / flush / interrupt / configure / close ─────────────────────────────────

describe('FluxTtsConnection speak/flush/interrupt/configure/close', () => {
  it('sends Speak with the given text', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.speak('Hello, world!')
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Speak', text: 'Hello, world!' })
  })

  it('sends Flush with no fields', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.flush()
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Flush' })
  })

  it('sends Interrupt without playback_offset when no offset is given', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.interrupt()
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Interrupt' })
  })

  it('sends Interrupt with a time_ms playback_offset when an offset is given', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.interrupt(2340)
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'Interrupt',
      playback_offset: { type: 'time_ms', value: 2340 },
    })
  })

  it('sends Configure with the given speed', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({ speed: 1.05 })
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Configure', speed: 1.05 })
  })

  it('sends Configure with no speed field when the request omits it', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    connection.configure({})
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Configure' })
  })

  it('is a no-op to speak/flush/interrupt/configure after close', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const closing = connection.close()
    socket.fireClose(1000, 'normal')
    await closing
    socket.sent = []
    connection.speak('too late')
    connection.flush()
    connection.interrupt()
    connection.configure({ speed: 1 })
    expect(socket.sent).toEqual([])
  })

  it('sends Close and does not force-close the socket itself (server drains then closes)', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const closing = connection.close()
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'Close' })
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

describe('FluxTtsConnection unexpected transport events', () => {
  it('yields a closed event with the server close code/reason', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1011, 'server error')
    const [event] = await collect(connection, 1)
    expect(event).toEqual({ type: 'closed', code: 1011, reason: 'server error' })
  })

  it('surfaces a post-open transport error as an error event, then finishes on close', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireError('read failed')
    const [errorEvent] = await collect(connection, 1)
    expect(errorEvent).toEqual({ type: 'error', code: 'TRANSPORT_ERROR', message: 'read failed' })
    socket.fireClose(1006, 'abnormal')
  })

  it('terminates the async iterator after the closed event', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireClose(1000, 'normal')
    const events: TtsEvent[] = []
    for await (const event of connection) events.push(event)
    expect(events).toEqual([{ type: 'closed', code: 1000, reason: 'normal' }])
  })

  it('surfaces a post-open transport error with a default message when none is given', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    socket.fireError()
    const [errorEvent] = await collect(connection, 1)
    expect(errorEvent).toEqual({ type: 'error', code: 'TRANSPORT_ERROR', message: 'WebSocket error' })
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

  it('waits for the next enqueued event when the iterator has drained the queue', async () => {
    const { connection, socket } = makeConnection()
    void connection.connect()
    socket.fireOpen()
    const iterator = connection[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    socket.fireMessage(JSON.stringify({ type: 'Connected', request_id: 'req-3', model_name: 'flux-alexis-en' }))
    const result = await pending
    expect(result).toEqual({ done: false, value: { type: 'connected', requestId: 'req-3', modelName: 'flux-alexis-en' } })
  })
})

// ── default WebSocket factory resolution ────────────────────────────────────────────

describe('resolveDefaultWebSocketFactory', () => {
  it('resolves to a callable factory backed by undici', async () => {
    const factory = await resolveDefaultWebSocketFactory()
    expect(typeof factory).toBe('function')
  })
})
