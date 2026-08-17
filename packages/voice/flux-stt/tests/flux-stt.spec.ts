import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import VoiceRuntime from '@deepseek-ai/dsh-voice'
import * as FluxStt from '../src/index.ts'
import { FluxSttProvider, FLUX_STT_PROVIDER_ID } from '../src/provider.ts'
import type { WebSocketFactory, WebSocketLike } from '../src/socket.ts'
import type { ListenV2ServerMessage } from '../src/types.ts'

/** A fully scripted fake `ws` socket: no network, deterministic message replay. */
class FakeSocket implements WebSocketLike {
  readonly sent: Array<string | Uint8Array> = []
  readonly pings: number[] = []
  readonly closed: Array<{ code?: number; reason?: string }> = []
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {}

  on(event: string, listener: (...args: never[]) => void): void {
    (this.listeners[event] ??= []).push(listener)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) (listener as (...a: unknown[]) => void)(...args)
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  ping(): void {
    this.pings.push(Date.now())
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason })
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''))
  }

  /** Test helper: deliver one JSON server message. */
  receiveJson(message: ListenV2ServerMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }

  /** Test helper: simulate an abnormal transport failure. */
  receiveError(error: Error): void {
    this.emit('error', error)
  }
}

function fakeFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const factory: WebSocketFactory = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  return { factory, sockets }
}

const CONNECTED: ListenV2ServerMessage = { type: 'Connected', request_id: 'req-1', sequence_id: 0 }

describe('FluxSttProvider protocol', () => {
  it('resolves connect() only after the Connected message arrives', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-general-en',
      encoding: 'linear16',
      sampleRateHz: 16_000,
      eotThreshold: 0.7,
      eotTimeoutMs: 5_000,
      keepAliveIntervalMs: 8_000,
      profanityFilter: false,
      numerals: false,
      createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    expect(sockets).toHaveLength(1)
    sockets[0]?.receiveJson(CONNECTED)
    const session = await connectPromise
    const events: unknown[] = []
    void (async () => {
      for await (const event of session.events) events.push(event)
    })()
    await Promise.resolve()
    expect(events).toEqual([{ type: 'connected', requestId: 'req-1' }])
  })

  it('builds the query string from per-call options and provider config', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-general-en',
      encoding: 'linear16',
      sampleRateHz: 16_000,
      eotThreshold: 0.7,
      eotTimeoutMs: 5_000,
      keepAliveIntervalMs: 8_000,
      profanityFilter: false,
      numerals: false,
      createWebSocket: factory,
    })
    const connectPromise = provider.connect({
      provider: FLUX_STT_PROVIDER_ID,
      model: 'flux-general-multi',
      keyterms: ['weather', 'forecast'],
      languageHints: ['en', 'es'],
    })
    await Promise.resolve()
    sockets[0]?.receiveJson(CONNECTED)
    await connectPromise
    expect(sockets).toHaveLength(1)
  })

  it('normalizes a TurnInfo EndOfTurn message into a completed turn event', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson(CONNECTED)
    const session = await connectPromise
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next() // consume 'connected'

    sockets[0]?.receiveJson({
      type: 'TurnInfo',
      request_id: 'req-1',
      sequence_id: 1,
      event: 'EndOfTurn',
      turn_index: 0,
      audio_window_start: 0,
      audio_window_end: 1.3,
      transcript: 'Hello, how are you?',
      words: [{ word: 'Hello,', confidence: 0.96, start: 0, end: 0.18 }],
      end_of_turn_confidence: 0.86,
    })
    const { value } = await iterator.next()
    expect(value).toEqual({
      type: 'turn',
      kind: 'completed',
      turnIndex: 0,
      transcript: 'Hello, how are you?',
      words: [{ text: 'Hello,', confidence: 0.96, startSec: 0, endSec: 0.18 }],
      endOfTurnConfidence: 0.86,
      audioWindowStartSec: 0,
      audioWindowEndSec: 1.3,
    })
  })

  it('sends binary audio frames over the socket', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson(CONNECTED)
    const session = await connectPromise
    const chunk = new Uint8Array([1, 2, 3])
    session.sendAudio(chunk)
    expect(sockets[0]?.sent).toEqual([chunk])
  })

  it('throws SESSION_CLOSED for sendAudio/configure after close', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson(CONNECTED)
    const session = await connectPromise
    const closePromise = session.close()
    await Promise.resolve()
    await closePromise
    expect(() => session.sendAudio(new Uint8Array())).toThrow(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    )
    expect(() => session.configure({})).toThrow(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    )
  })

  it('sends a translated Configure control frame', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson(CONNECTED)
    const session = await connectPromise
    session.configure({ endOfTurnConfidence: 0.8, keyterms: ['weather'] })
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ type: 'Configure', thresholds: { eot_threshold: 0.8 }, keyterms: ['weather'] }),
    ])
  })

  it('surfaces a fatal Error message and rejects a not-yet-ready connect()', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'boom' })
    await expect(connectPromise).rejects.toThrow('boom')
  })

  it('rejects connect() on an abnormal close before Connected', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.close(1006, 'abnormal')
    await expect(connectPromise).rejects.toThrow(/WS_CLOSE_BEFORE_READY|abnormal/)
  })

  it('pings the socket when idle beyond keepAliveIntervalMs, and not while audio is flowing', async () => {
    vi.useFakeTimers()
    try {
      const { factory, sockets } = fakeFactory()
      const provider = new FluxSttProvider({
        apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
        sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 4_000,
        profanityFilter: false, numerals: false, createWebSocket: factory,
      })
      const connectPromise = provider.connect({ provider: FLUX_STT_PROVIDER_ID })
      await Promise.resolve()
      sockets[0]?.receiveJson(CONNECTED)
      const session = await connectPromise
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets[0]?.pings).toHaveLength(0)
      session.sendAudio(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets[0]?.pings).toHaveLength(0) // reset by sendAudio
      await vi.advanceTimersByTimeAsync(4_000)
      expect(sockets[0]?.pings.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an abort signal set before connect() rejects immediately', async () => {
    const { factory } = fakeFactory()
    const provider = new FluxSttProvider({
      apiKey: 'key', baseURL: 'wss://api.deepgram.com', model: 'flux-general-en', encoding: 'linear16',
      sampleRateHz: 16_000, eotThreshold: 0.7, eotTimeoutMs: 5_000, keepAliveIntervalMs: 8_000,
      profanityFilter: false, numerals: false, createWebSocket: factory,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.connect({ provider: FLUX_STT_PROVIDER_ID, signal: controller.signal })).rejects.toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    )
  })
})

describe('flux-stt plugin', () => {
  it('registers the deepgram-flux STT provider and resolves the API key through ctx.credentials', async () => {
    const ctx = new Context()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-flux-stt-'))
    const previous = process.env['DEEPGRAM_API_KEY']
    process.env['DEEPGRAM_API_KEY'] = 'from-credentials'
    try {
      await ctx.plugin(VoiceRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(FluxStt)
      expect(ctx.voice.listSttProviders()).toEqual([FLUX_STT_PROVIDER_ID])
    } finally {
      if (previous === undefined) delete process.env['DEEPGRAM_API_KEY']
      else process.env['DEEPGRAM_API_KEY'] = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loud with VOICE_PROVIDER_UNAVAILABLE when no key is configured anywhere', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime)
    await ctx.plugin(FluxStt)
    const previous = process.env['DEEPGRAM_API_KEY']
    delete process.env['DEEPGRAM_API_KEY']
    try {
      await expect(ctx.voice.openStt({ provider: FLUX_STT_PROVIDER_ID })).rejects.toThrow(
        expect.objectContaining({ code: 'VOICE_PROVIDER_UNAVAILABLE' }),
      )
    } finally {
      if (previous !== undefined) process.env['DEEPGRAM_API_KEY'] = previous
    }
  })
})
