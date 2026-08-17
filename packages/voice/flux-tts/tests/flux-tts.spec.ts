import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import VoiceRuntime from '@deepseek-ai/dsh-voice'
import * as FluxTts from '../src/index.ts'
import { FluxTtsProvider, FLUX_TTS_PROVIDER_ID } from '../src/provider.ts'
import type { WebSocketFactory, WebSocketLike } from '../src/socket.ts'
import type { SpeakV2ServerMessage } from '../src/types.ts'

/** A fully scripted fake `ws` socket: no network, deterministic message replay. */
class FakeSocket implements WebSocketLike {
  readonly sent: string[] = []
  readonly pings: number[] = []
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {}

  on(event: string, listener: (...args: never[]) => void): void {
    (this.listeners[event] ??= []).push(listener)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) (listener as (...a: unknown[]) => void)(...args)
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data)
  }

  ping(): void {
    this.pings.push(Date.now())
  }

  close(code?: number, reason?: string): void {
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''))
  }

  /** Test helper: deliver one JSON server message. */
  receiveJson(message: SpeakV2ServerMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }

  /** Test helper: deliver one binary audio frame. */
  receiveAudio(bytes: Uint8Array): void {
    this.emit('message', Buffer.from(bytes), true)
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

const CONNECTED: SpeakV2ServerMessage = {
  type: 'Connected',
  request_id: '550e8400-e29b-41d4-a716-446655440000',
  model_name: 'flux-alexis-en',
  model_version: '2026.06.01',
  model_uuids: ['b3e47c20-9f81-4a2e-bd15-8d7c6e2a1f09'],
}

function baseConfig(factory: WebSocketFactory) {
  return {
    apiKey: 'key',
    baseURL: 'wss://api.deepgram.com',
    model: 'flux-alexis-en',
    encoding: 'linear16' as const,
    speed: 1.00,
    expressivity: 0,
    keepAliveIntervalMs: 20_000,
    createWebSocket: factory,
  }
}

async function connectReady(provider: FluxTtsProvider, sockets: FakeSocket[]) {
  const connectPromise = provider.connect({ provider: FLUX_TTS_PROVIDER_ID })
  await Promise.resolve()
  sockets[0]?.receiveJson(CONNECTED)
  return connectPromise
}

describe('FluxTtsProvider protocol', () => {
  it('resolves connect() only after Connected, and sends Speak text', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    session.speak('Sure, I can help you cancel your subscription.')
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ type: 'Speak', text: 'Sure, I can help you cancel your subscription.' }),
    ])
  })

  it('sends Flush and Interrupt with the session-wide playback offset', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    session.flush()
    session.interrupt(2340)
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ type: 'Flush' }),
      JSON.stringify({ type: 'Interrupt', playback_offset: { type: 'time_ms', value: 2340 } }),
    ])
  })

  it('replays a full natural turn: turn-started, audio tagged with the turn id, then turn-completed', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next() // connected

    sockets[0]?.receiveJson({ type: 'SpeechStarted', speech_id: 'dg_sp_a1b2c3d4e5f6' })
    const started = await iterator.next()
    expect(started.value).toEqual({ type: 'turn-started', turnId: 'dg_sp_a1b2c3d4e5f6' })

    const chunk = new Uint8Array([1, 2, 3, 4])
    sockets[0]?.receiveAudio(chunk)
    const audio = await iterator.next()
    expect(audio.value).toEqual({ type: 'audio', turnId: 'dg_sp_a1b2c3d4e5f6', data: chunk })

    sockets[0]?.receiveJson({
      type: 'SpeechMetadata',
      speech_id: 'dg_sp_a1b2c3d4e5f6',
      audio_duration_ms: 3200,
      input_character_count: 47,
      billable_character_count: 45,
      controls_applied: { pronunciations_applied: 0, breaks_applied: 0, pronunciation_warnings: 0 },
    })
    const completed = await iterator.next()
    expect(completed.value).toEqual({
      type: 'turn-completed',
      turnId: 'dg_sp_a1b2c3d4e5f6',
      audioDurationMs: 3200,
      inputCharacterCount: 47,
      billableCharacterCount: 45,
    })
  })

  it('replays an interrupted turn: exact textSpoken/textRemaining reconciliation', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next() // connected

    sockets[0]?.receiveJson({ type: 'SpeechStarted', speech_id: 'dg_sp_a1b2c3d4e5f6' })
    await iterator.next() // turn-started
    sockets[0]?.receiveAudio(new Uint8Array([9, 9]))
    await iterator.next() // audio

    session.interrupt(2340)
    sockets[0]?.receiveJson({
      type: 'SpeechInterrupted',
      audio_played_ms: 2340,
      metadata: {
        speech_id: 'dg_sp_a1b2c3d4e5f6',
        audio_duration_ms: 2340,
        input_character_count: 75,
        billable_character_count: 75,
        controls_applied: { pronunciations_applied: 0, breaks_applied: 0, pronunciation_warnings: 0 },
      },
      text_spoken: 'Sure, I can help you cancel your subscription.',
      text_remaining: ' Let me pull up your account.',
    })
    const interrupted = await iterator.next()
    expect(interrupted.value).toEqual({
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Sure, I can help you cancel your subscription.',
      textRemaining: ' Let me pull up your account.',
      metrics: {
        turnId: 'dg_sp_a1b2c3d4e5f6',
        audioDurationMs: 2340,
        inputCharacterCount: 75,
        billableCharacterCount: 75,
      },
    })

    // A new turn's audio must be tagged with its OWN turn id, never the interrupted one.
    sockets[0]?.receiveJson({ type: 'SpeechStarted', speech_id: 'dg_sp_next_turn' })
    await iterator.next()
    sockets[0]?.receiveAudio(new Uint8Array([7]))
    const nextAudio = await iterator.next()
    expect(nextAudio.value).toMatchObject({ turnId: 'dg_sp_next_turn' })
  })

  it('reports cumulative session totals and forwards Flushed/Warning/ConfigureSuccess/ConfigureFailure', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next() // connected

    sockets[0]?.receiveJson({ type: 'Flushed', speech_id: 'dg_sp_a1b2c3d4e5f6' })
    expect((await iterator.next()).value).toEqual({ type: 'turn-flushed', turnId: 'dg_sp_a1b2c3d4e5f6' })

    sockets[0]?.receiveJson({ type: 'Warning', code: 'NO_ACTIVE_SPEECH', description: 'There is no active turn.' })
    expect((await iterator.next()).value).toEqual({ type: 'warning', code: 'NO_ACTIVE_SPEECH', message: 'There is no active turn.' })

    sockets[0]?.receiveJson({ type: 'ConfigureSuccess', applied: { speed: 1.05 } })
    expect((await iterator.next()).value).toEqual({ type: 'configure-ack', ok: true, appliedSpeed: 1.05 })

    sockets[0]?.receiveJson({ type: 'ConfigureFailure', code: 'SPEED_OUT_OF_RANGE', description: 'out of range', field: 'speed', value: 3.5 })
    expect((await iterator.next()).value).toEqual({
      type: 'configure-ack', ok: false, failureCode: 'SPEED_OUT_OF_RANGE', failureMessage: 'out of range', failureField: 'speed', failureValue: 3.5,
    })

    sockets[0]?.receiveJson({ type: 'SessionMetadata', total_audio_duration_ms: 184_500, total_input_character_count: 4_280, total_billable_character_count: 4_180 })
    expect((await iterator.next()).value).toEqual({
      type: 'session-completed', totalAudioDurationMs: 184_500, totalInputCharacterCount: 4_280, totalBillableCharacterCount: 4_180,
    })
  })

  it('a Configure with no speed is a no-op (nothing to apply)', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    session.configure({})
    expect(sockets[0]?.sent).toEqual([])
  })

  it('throws SESSION_CLOSED for speak/flush/interrupt/configure after close', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const session = await connectReady(provider, sockets)
    const closePromise = session.close()
    await Promise.resolve()
    await closePromise
    expect(() => session.speak('hi')).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(() => session.flush()).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(() => session.interrupt(0)).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(() => session.configure({ speed: 1.0 })).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }))
  })

  it('surfaces a fatal Error message and rejects a not-yet-ready connect()', async () => {
    const { factory, sockets } = fakeFactory()
    const provider = new FluxTtsProvider(baseConfig(factory))
    const connectPromise = provider.connect({ provider: FLUX_TTS_PROVIDER_ID })
    await Promise.resolve()
    sockets[0]?.receiveJson({ type: 'Error', code: 'MESSAGE-0000', description: 'The message could not be parsed.' })
    await expect(connectPromise).rejects.toThrow('The message could not be parsed.')
  })

  it('pings the socket when idle beyond keepAliveIntervalMs, and not while turns are active', async () => {
    vi.useFakeTimers()
    try {
      const { factory, sockets } = fakeFactory()
      const provider = new FluxTtsProvider({ ...baseConfig(factory), keepAliveIntervalMs: 4_000 })
      const session = await connectReady(provider, sockets)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets[0]?.pings).toHaveLength(0)
      session.speak('hello')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets[0]?.pings).toHaveLength(0) // reset by speak()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(sockets[0]?.pings.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('flux-tts plugin', () => {
  it('rejects an Aura model string at load — Flux TTS lives only at /v2/speak', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime)
    await expect(ctx.plugin(FluxTts, { model: 'aura-asteria-en' })).rejects.toThrow(
      expect.objectContaining({ code: 'VOICE_INVALID_PROVIDER' }),
    )
  })

  it('registers the deepgram-flux TTS provider and resolves the API key through ctx.credentials', async () => {
    const ctx = new Context()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-flux-tts-'))
    const previous = process.env['DEEPGRAM_API_KEY']
    process.env['DEEPGRAM_API_KEY'] = 'from-credentials'
    try {
      await ctx.plugin(VoiceRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(FluxTts, { model: 'flux-alexis-en' })
      expect(ctx.voice.listTtsProviders()).toEqual([FLUX_TTS_PROVIDER_ID])
    } finally {
      if (previous === undefined) delete process.env['DEEPGRAM_API_KEY']
      else process.env['DEEPGRAM_API_KEY'] = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loud with VOICE_PROVIDER_UNAVAILABLE when no key is configured anywhere', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime)
    await ctx.plugin(FluxTts, { model: 'flux-alexis-en' })
    const previous = process.env['DEEPGRAM_API_KEY']
    delete process.env['DEEPGRAM_API_KEY']
    try {
      await expect(ctx.voice.openTts({ provider: FLUX_TTS_PROVIDER_ID })).rejects.toThrow(
        expect.objectContaining({ code: 'VOICE_PROVIDER_UNAVAILABLE' }),
      )
    } finally {
      if (previous !== undefined) process.env['DEEPGRAM_API_KEY'] = previous
    }
  })
})
