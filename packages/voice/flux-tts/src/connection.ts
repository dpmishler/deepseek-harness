/**
 * `FluxTtsConnection`: WebSocket lifecycle, text streaming, and audio/event
 * routing for the Deepgram Flux TTS `/v2/speak` endpoint.
 *
 * Implements the `TtsSession` interface from `@deepseek-ai/dsh-voice`:
 * `events` is a single-consumer `AsyncIterable<TtsEvent>` that yields binary
 * audio chunks interleaved with lifecycle events. `speak()` streams text tokens
 * into the active turn; `flush()` ends the turn; `interrupt()` handles barge-in;
 * `configure()` adjusts speed mid-stream; `close()` gracefully drains and shuts down.
 *
 * The injectable `createWebSocket` factory enables deterministic unit tests.
 * @module @deepseek-ai/dsh-flux-tts/connection
 */

import type {
  SpeechRequestId,
  SpeechTurnId,
  TtsConfigureRequest,
  TtsEvent,
  TtsSession,
  TtsTurnMetrics,
} from '@deepseek-ai/dsh-voice'
import type { FluxTtsClientMessage, FluxTtsServerMessage } from './types.ts'

/** Minimum WHATWG-compatible WebSocket surface the connection requires. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(event: 'open', cb: () => void): void
  addEventListener(event: 'message', cb: (event: { data: unknown }) => void): void
  addEventListener(event: 'close', cb: (event: { code: number; reason: string }) => void): void
  addEventListener(event: 'error', cb: (event: { error?: unknown; message?: string }) => void): void
}

/** Factory that opens a WebSocket; injectable for tests. */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike

/** Options for one `FluxTtsConnection`. */
export interface FluxTtsConnectionOptions {
  /** Deepgram API key. */
  apiKey: string
  /** Endpoint base (default: `wss://api.deepgram.com`). */
  baseURL?: string
  /** Flux TTS voice/model string (e.g. `flux-haley-en`). Required. */
  model: string
  /** Raw audio encoding (default: `linear16`). */
  encoding?: string
  /** Output sample rate in Hz. Omit for model native. */
  sampleRateHz?: number
  /** Initial speed multiplier (0.85–1.15). */
  speed?: number
  /** Initial expressivity (-2 to 2). */
  expressivity?: number
  /** Injectable WebSocket factory. Production: undici. Tests: fake. */
  createWebSocket?: WebSocketFactory
}

/** Default Deepgram TTS endpoint base. */
export const DEFAULT_TTS_BASE_URL = 'wss://api.deepgram.com'

/**
 * Build the undici production WebSocket factory.
 * @returns factory that creates an undici WebSocket with Authorization header.
 */
async function makeDefaultFactory(): Promise<WebSocketFactory> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let WS: new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike
  try {
    const m = await import('node:undici' as string) as { WebSocket: typeof WS }
    WS = m.WebSocket
  } catch {
    const m = await import('undici' as string) as { WebSocket: typeof WS }
    WS = m.WebSocket
  }
  return (url: string, headers: Record<string, string>): WebSocketLike => new WS(url, { headers })
}

function buildUrl(opts: FluxTtsConnectionOptions): string {
  const base = (opts.baseURL ?? DEFAULT_TTS_BASE_URL).replace(/\/$/, '')
  const params = new URLSearchParams()
  params.set('model', opts.model)
  if (opts.encoding !== undefined) params.set('encoding', opts.encoding)
  if (opts.sampleRateHz !== undefined) params.set('sample_rate', String(opts.sampleRateHz))
  if (opts.speed !== undefined) params.set('speed', String(opts.speed))
  if (opts.expressivity !== undefined) params.set('expressivity', String(opts.expressivity))
  return `${base}/v2/speak?${params.toString()}`
}

function toBuffer(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

function buildMetrics(m: { speech_id: string; audio_duration_ms: number; input_character_count: number; billable_character_count: number }): TtsTurnMetrics {
  return {
    turnId: m.speech_id as SpeechTurnId,
    audioDurationMs: m.audio_duration_ms,
    inputCharacterCount: m.input_character_count,
    billableCharacterCount: m.billable_character_count,
  }
}

/**
 * Live Deepgram Flux TTS WebSocket session. Implements `TtsSession` from
 * `@deepseek-ai/dsh-voice`.
 *
 * Call `FluxTtsConnection.open(opts)` to get a connected instance. Then iterate
 * `session.events` with a single `for await` loop while calling `speak()` and
 * `flush()` to drive the turn lifecycle.
 */
export class FluxTtsConnection implements TtsSession {
  private ws: WebSocketLike | null = null
  private readonly queue: TtsEvent[] = []
  private pendingResolve: (() => void) | null = null
  private _done = false
  private _closeResolve: (() => void) | null = null

  private constructor(private readonly opts: FluxTtsConnectionOptions) {}

  /**
   * Open a new Flux TTS WebSocket session.
   * @param opts - connection options.
   * @returns the open session.
   */
  static async open(opts: FluxTtsConnectionOptions): Promise<FluxTtsConnection> {
    const session = new FluxTtsConnection(opts)
    await session.connectWs()
    return session
  }

  private async connectWs(): Promise<void> {
    const factory = this.opts.createWebSocket ?? await makeDefaultFactory()
    const url = buildUrl(this.opts)
    this.ws = factory(url, { Authorization: `Token ${this.opts.apiKey}` })
    const ws = this.ws

    return new Promise<void>((resolve, reject) => {
      let opened = false

      ws.addEventListener('open', () => {
        opened = true
        resolve()
      })

      ws.addEventListener('message', (event) => {
        this.handleFrame(event.data)
      })

      ws.addEventListener('close', (event) => {
        if (!this._done) {
          this._done = true
          if (event.code !== 1000 && event.code !== 1001) {
            this.push({ type: 'error', code: `WS_CLOSE_${event.code}`, message: event.reason || `closed ${event.code}` })
          }
          this.push({ type: 'closed', code: event.code, reason: event.reason || undefined })
          this.wakeConsumer()
          this.resolvePendingClose()
        }
      })

      ws.addEventListener('error', (event) => {
        if (!this._done) {
          this._done = true
          const msg = event.message ?? 'WebSocket error'
          this.push({ type: 'error', code: 'CONNECTION_FAILED', message: msg })
          this.push({ type: 'closed' })
          this.wakeConsumer()
          this.resolvePendingClose()
        }
        if (!opened) reject(new Error(event.message ?? 'WebSocket error'))
      })
    })
  }

  private handleFrame(data: unknown): void {
    // Binary frames are audio
    const bin = toBuffer(data)
    if (bin !== null) {
      // Emit audio under the current speech_id placeholder; TtsTurnStartedEvent carries the real id
      this.push({ type: 'audio', turnId: '' as SpeechTurnId, data: bin })
      return
    }

    if (typeof data !== 'string') return

    let msg: FluxTtsServerMessage
    try {
      msg = JSON.parse(data) as FluxTtsServerMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'Connected':
        this.push({
          type: 'connected',
          requestId: msg.request_id as SpeechRequestId,
          modelName: msg.model_name,
        })
        break
      case 'SpeechStarted':
        this.push({ type: 'turn-started', turnId: msg.speech_id as SpeechTurnId })
        break
      case 'SpeechMetadata':
        this.push({ type: 'turn-completed', ...buildMetrics(msg) })
        break
      case 'Flushed':
        this.push({ type: 'turn-flushed', turnId: msg.speech_id as SpeechTurnId })
        break
      case 'SpeechInterrupted':
        this.push({
          type: 'turn-interrupted',
          audioPlayedMs: msg.audio_played_ms,
          ...(msg.text_spoken !== undefined ? { textSpoken: msg.text_spoken } : {}),
          ...(msg.text_remaining !== undefined ? { textRemaining: msg.text_remaining } : {}),
          metrics: buildMetrics(msg.metadata),
        })
        break
      case 'SessionMetadata':
        this.push({
          type: 'session-completed',
          totalAudioDurationMs: msg.total_audio_duration_ms,
          totalInputCharacterCount: msg.total_input_character_count,
          totalBillableCharacterCount: msg.total_billable_character_count,
        })
        break
      case 'ConfigureSuccess':
        this.push({
          type: 'configure-ack',
          ok: true,
          ...(msg.applied.speed !== undefined ? { appliedSpeed: msg.applied.speed } : {}),
        })
        break
      case 'ConfigureFailure':
        this.push({
          type: 'configure-ack',
          ok: false,
          failureCode: msg.code,
          ...(msg.field !== undefined ? { failureField: msg.field } : {}),
          ...(msg.value !== undefined ? { failureValue: msg.value } : {}),
          failureMessage: msg.description,
        })
        break
      case 'Warning':
        this.push({ type: 'warning', code: msg.code, message: msg.description })
        break
      case 'Error':
        this.push({ type: 'error', code: msg.code, message: msg.description })
        break
      default:
        // Unknown frame; ignore for forward compatibility.
        break
    }
  }

  private push(event: TtsEvent): void {
    this.queue.push(event)
    this.wakeConsumer()
  }

  private wakeConsumer(): void {
    if (this.pendingResolve !== null) {
      const cb = this.pendingResolve
      this.pendingResolve = null
      cb()
    }
  }

  private resolvePendingClose(): void {
    if (this._closeResolve !== null) {
      const cb = this._closeResolve
      this._closeResolve = null
      cb()
    }
  }

  private sendMessage(msg: FluxTtsClientMessage): void {
    if (this.ws !== null && !this._done) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** The session event stream. Drive with exactly one `for await` loop. */
  get events(): AsyncIterable<TtsEvent> {
    return this.makeIterable()
  }

  private makeIterable(): AsyncIterable<TtsEvent> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
        return {
          async next(): Promise<IteratorResult<TtsEvent>> {
            while (true) {
              if (self.queue.length > 0) {
                return { value: self.queue.shift()!, done: false }
              }
              if (self._done) return { value: undefined as unknown as TtsEvent, done: true }
              await new Promise<void>((resolve) => { self.pendingResolve = resolve })
            }
          },
        }
      },
    }
  }

  /**
   * Stream text into the active turn.
   * @param text - plain text to synthesize.
   */
  speak(text: string): void {
    this.sendMessage({ type: 'Speak', text })
  }

  /** End the active turn; the server generates remaining audio and emits turn-completed. */
  flush(): void {
    this.sendMessage({ type: 'Flush' })
  }

  /**
   * Cancel the active turn on barge-in.
   * @param playbackOffsetMs - ms of session audio played, from the start of the session.
   */
  interrupt(playbackOffsetMs?: number): void {
    const msg: FluxTtsClientMessage = playbackOffsetMs !== undefined
      ? { type: 'Interrupt', playback_offset: { type: 'time_ms', value: playbackOffsetMs } }
      : { type: 'Interrupt' }
    this.sendMessage(msg)
  }

  /**
   * Adjust synthesis configuration mid-session.
   * @param request - fields to update; omitted fields keep their current value.
   */
  configure(request: TtsConfigureRequest): void {
    this.sendMessage({ type: 'Configure', ...(request.speed !== undefined ? { speed: request.speed } : {}) })
  }

  /**
   * Gracefully close the session.
   * @returns resolves once the transport closes.
   */
  close(): Promise<void> {
    if (this._done) return Promise.resolve()
    this.sendMessage({ type: 'Close' })
    this._done = true
    this.ws?.close(1000)
    this.wakeConsumer()
    return new Promise<void>((resolve) => {
      this._closeResolve = resolve
      if (this.ws === null) resolve()
    })
  }
}
