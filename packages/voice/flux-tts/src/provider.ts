/**
 * Deepgram Flux TTS v2 provider: opens one `wss://.../v2/speak` connection
 * per {@link TtsOpenOptions} and maps its wire protocol onto
 * `@deepseek-ai/dsh-voice`'s provider-neutral `TtsSession`/`TtsEvent`
 * vocabulary. `../index.ts` (the Cordis plugin) resolves credentials and
 * config and constructs this provider; nothing here touches `ctx`. Flux TTS
 * lives only at `/v2/speak` — an Aura model string is rejected there, and
 * this provider never speaks `/v1/speak`.
 * @module @deepseek-ai/dsh-flux-tts/provider
 */

import { AsyncEventQueue, SpeechRequestId, SpeechTurnId, VoiceError } from '@deepseek-ai/dsh-voice'
import type { TtsConfigureRequest, TtsEvent, TtsOpenOptions, TtsProvider, TtsSession } from '@deepseek-ai/dsh-voice'
import { createWsWebSocket, toUint8Array, type WebSocketFactory, type WebSocketLike } from './socket.ts'
import type { FluxTtsEncoding, SpeakV2ClientMessage, SpeakV2ServerMessage } from './types.ts'

/** Stable provider id registered with `ctx.voice`. */
export const FLUX_TTS_PROVIDER_ID = 'deepgram-flux'

/** Resolved, deployment-varying connection facts for one Flux TTS connection. Built by `../index.ts` from `Config` + credentials. */
export interface FluxTtsProviderConfig {
  readonly apiKey: string
  readonly baseURL: string
  /** Required on every connection; format `flux-{voice}-{language}` (e.g. `flux-alexis-en`). Never an Aura model string. */
  readonly model: string
  readonly encoding: FluxTtsEncoding
  readonly sampleRateHz?: number
  readonly speed: number
  /** Fixed for the connection — not settable via `configure()`. */
  readonly expressivity: number
  readonly keepAliveIntervalMs: number
  readonly tag?: string
  /** Injectable for tests; defaults to a real `ws` client. */
  readonly createWebSocket?: WebSocketFactory
}

/** Build the `/v2/speak` query string from provider config and one call's overrides. */
function buildQuery(config: FluxTtsProviderConfig, options: TtsOpenOptions): string {
  const params = new URLSearchParams()
  params.set('model', options.voice ?? config.model)
  params.set('encoding', options.audio?.encoding ?? config.encoding)
  const sampleRate = options.audio?.sampleRateHz ?? config.sampleRateHz
  if (sampleRate !== undefined) params.set('sample_rate', String(sampleRate))
  params.set('speed', (options.speed ?? config.speed).toFixed(2))
  params.set('expressivity', String(options.expressivity ?? config.expressivity))
  if (config.tag !== undefined) params.set('tag', config.tag)
  return params.toString()
}

class FluxTtsSession implements TtsSession {
  private readonly ws: WebSocketLike
  private readonly queue = new AsyncEventQueue<TtsEvent>()
  private ready: { resolve: () => void; reject: (error: Error) => void } | undefined
  private closed = false
  private lastSentAt = Date.now()
  private currentTurnId: ReturnType<typeof SpeechTurnId> | undefined
  private readonly keepAliveTimer: ReturnType<typeof setInterval>

  readonly events: AsyncIterable<TtsEvent> = this.queue

  constructor(url: string, apiKey: string, createWebSocket: WebSocketFactory, keepAliveIntervalMs: number) {
    this.ws = createWebSocket(url, { headers: { Authorization: `Token ${apiKey}` } })
    this.ws.on('message', (data, isBinary) => { this.onMessage(data, isBinary) })
    this.ws.on('close', (code, reason) => { this.onClose(code, reason.toString()) })
    this.ws.on('error', (error) => { this.onTransportError(error) })
    // /v2/speak has no dedicated KeepAlive wire message; a WebSocket-protocol
    // ping frame is transparent to the JSON/binary application layer and
    // keeps a session alive through the idle gaps between user turns.
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastSentAt >= keepAliveIntervalMs) this.ws.ping()
    }, Math.max(1000, Math.floor(keepAliveIntervalMs / 2)))
  }

  /** Resolves once Deepgram's `Connected` message confirms the session is ready, or rejects if the transport fails first. */
  waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ready = { resolve, reject }
    })
  }

  private onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) {
      if (this.currentTurnId === undefined) return // audio before any SpeechStarted is a protocol violation; drop defensively.
      this.queue.push({ type: 'audio', turnId: this.currentTurnId, data: toUint8Array(data) })
      return
    }
    let message: SpeakV2ServerMessage
    try {
      message = JSON.parse(Buffer.from(toUint8Array(data)).toString('utf8')) as SpeakV2ServerMessage
    } catch {
      this.queue.push({ type: 'error', code: 'MALFORMED_MESSAGE', message: 'received a non-JSON text frame' })
      return
    }
    switch (message.type) {
      case 'Connected':
        this.queue.push({ type: 'connected', requestId: SpeechRequestId(message.request_id), modelName: message.model_name })
        this.ready?.resolve()
        this.ready = undefined
        break
      case 'SpeechStarted':
        this.currentTurnId = SpeechTurnId(message.speech_id)
        this.queue.push({ type: 'turn-started', turnId: this.currentTurnId })
        break
      case 'SpeechMetadata':
        this.queue.push({
          type: 'turn-completed',
          turnId: SpeechTurnId(message.speech_id),
          audioDurationMs: message.audio_duration_ms,
          inputCharacterCount: message.input_character_count,
          billableCharacterCount: message.billable_character_count,
        })
        break
      case 'SpeechInterrupted':
        this.queue.push({
          type: 'turn-interrupted',
          audioPlayedMs: message.audio_played_ms,
          textSpoken: message.text_spoken,
          textRemaining: message.text_remaining,
          metrics: {
            turnId: SpeechTurnId(message.metadata.speech_id),
            audioDurationMs: message.metadata.audio_duration_ms,
            inputCharacterCount: message.metadata.input_character_count,
            billableCharacterCount: message.metadata.billable_character_count,
          },
        })
        break
      case 'Flushed':
        this.queue.push({ type: 'turn-flushed', turnId: SpeechTurnId(message.speech_id) })
        break
      case 'SessionMetadata':
        this.queue.push({
          type: 'session-completed',
          totalAudioDurationMs: message.total_audio_duration_ms,
          totalInputCharacterCount: message.total_input_character_count,
          totalBillableCharacterCount: message.total_billable_character_count,
        })
        break
      case 'ConfigureSuccess':
        this.queue.push({ type: 'configure-ack', ok: true, ...message.applied.speed === undefined ? {} : { appliedSpeed: message.applied.speed } })
        break
      case 'ConfigureFailure':
        this.queue.push({
          type: 'configure-ack',
          ok: false,
          failureCode: message.code,
          failureMessage: message.description,
          ...message.field === undefined ? {} : { failureField: message.field },
          ...message.value === undefined ? {} : { failureValue: message.value },
        })
        break
      case 'Warning':
        this.queue.push({ type: 'warning', code: message.code, message: message.description })
        break
      case 'Error':
        this.queue.push({ type: 'error', code: message.code, message: message.description })
        this.ready?.reject(new VoiceError(message.description, message.code))
        this.ready = undefined
        break
    }
  }

  private onClose(code: number, reason: string): void {
    clearInterval(this.keepAliveTimer)
    this.closed = true
    this.queue.push({ type: 'closed', code, ...(reason.length > 0 ? { reason } : {}) })
    this.queue.end()
    this.ready?.reject(new VoiceError(`transport closed before Connected (code ${code})`, 'WS_CLOSE_BEFORE_READY'))
    this.ready = undefined
  }

  private onTransportError(error: Error): void {
    this.queue.push({ type: 'error', code: 'TRANSPORT_ERROR', message: error.message })
    this.ready?.reject(error)
    this.ready = undefined
  }

  private send(message: SpeakV2ClientMessage): void {
    if (this.closed) throw new VoiceError('cannot send to a closed TTS session', 'SESSION_CLOSED')
    this.ws.send(JSON.stringify(message))
    this.lastSentAt = Date.now()
  }

  speak(text: string): void {
    this.send({ type: 'Speak', text })
  }

  flush(): void {
    this.send({ type: 'Flush' })
  }

  interrupt(playbackOffsetMs?: number): void {
    this.send({ type: 'Interrupt', playback_offset: { type: 'time_ms', value: playbackOffsetMs ?? 0 } })
  }

  configure(request: TtsConfigureRequest): void {
    if (request.speed === undefined) return
    this.send({ type: 'Configure', speed: request.speed })
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    // Send Close; the server will drain remaining audio and close the WebSocket.
    // We mark the session closed immediately so subsequent calls throw SESSION_CLOSED.
    this.closed = true
    clearInterval(this.keepAliveTimer)
    this.ws.send(JSON.stringify({ type: 'Close' } satisfies SpeakV2ClientMessage))
    this.ws.close(1000)
    return Promise.resolve()
  }
}

/** Deepgram Flux TTS v2 (`/v2/speak`) provider. Register with `ctx.voice.registerTtsProvider(id, provider)`. */
export class FluxTtsProvider implements TtsProvider {
  constructor(private readonly config: FluxTtsProviderConfig) {}

  async connect(options: TtsOpenOptions): Promise<TtsSession> {
    const query = buildQuery(this.config, options)
    const url = `${this.config.baseURL}/v2/speak?${query}`
    if (options.signal?.aborted) {
      throw new VoiceError('connection attempt aborted', 'ABORTED')
    }
    const session = new FluxTtsSession(
      url,
      this.config.apiKey,
      this.config.createWebSocket ?? createWsWebSocket,
      this.config.keepAliveIntervalMs,
    )
    const onAbort = (): void => { session.close().catch(() => {}) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await session.waitUntilReady()
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
    return session
  }
}
