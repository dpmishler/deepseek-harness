/**
 * `FluxTtsConnection`: WebSocket lifecycle, protocol request construction,
 * and message mapping for the Deepgram Flux TTS `/v2/speak` endpoint.
 *
 * The connection accepts an injectable `createWebSocket` factory for tests;
 * production code lazily imports undici's `WebSocket`, which (unlike the
 * global `WebSocket`) accepts custom request headers — required to send the
 * `Authorization` header on the handshake.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-tts/connection
 */

import type { TtsConfigureRequest, TtsEvent, TtsOpenOptions } from '@deepseek-ai/dsh-speech'
import { SpeechRequestId, SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { FluxTtsClientControl, FluxTtsServerMessage } from './types.ts'

/** Minimal WHATWG-compatible WebSocket surface the connection depends on. */
export interface WebSocketLike {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(event: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(event: 'error', listener: (event: { message?: string }) => void): void
}

/** Factory that opens a WebSocket to `url` with the given request headers; injectable for tests. */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike

/** Default Deepgram TTS endpoint base; Flux TTS requires `/v2/speak` (never `/v1/speak`, which serves Aura). */
export const DEFAULT_BASE_URL = 'wss://api.deepgram.com'

/** Resolved options for opening one `FluxTtsConnection`. */
export interface FluxTtsConnectionOptions {
  /** Deepgram API key, sent as `Authorization: Token <apiKey>`. */
  readonly apiKey: string
  /** Endpoint base (default: {@link DEFAULT_BASE_URL}). */
  readonly baseURL: string
  /** Flux TTS model string, format `flux-{voice}-{lang}` (e.g. `flux-alexis-en`). An Aura model string is rejected. */
  readonly model: string
  readonly options: TtsOpenOptions
  /** Injectable WebSocket factory; production code supplies the undici-backed default. */
  readonly createWebSocket: WebSocketFactory
}

/**
 * Lazily import undici's `WebSocket`, which supports custom request headers
 * (Node's global `WebSocket` does not) — required to send the `Authorization`
 * header on the `/v2/speak` handshake.
 * @returns factory that opens an undici WebSocket with the given headers.
 */
async function defaultWebSocketFactory(): Promise<WebSocketFactory> {
  const { WebSocket } = await import('undici')
  return (url, headers) => new WebSocket(url, { headers })
}

/**
 * Resolve the production `createWebSocket` factory. Lazily imports undici so
 * importing this module has no side effect; callers memoize the resolved
 * factory across connections.
 * @returns a sync {@link WebSocketFactory} backed by undici's `WebSocket`.
 */
export const resolveDefaultWebSocketFactory = defaultWebSocketFactory

function buildUrl(conn: FluxTtsConnectionOptions): string {
  const { options } = conn
  const params = new URLSearchParams()
  params.set('model', conn.model)
  if (options.audio !== undefined) {
    params.set('encoding', options.audio.encoding)
    params.set('sample_rate', String(options.audio.sampleRateHz))
  }
  if (options.speed !== undefined) params.set('speed', String(options.speed))
  if (options.expressivity !== undefined) params.set('expressivity', String(options.expressivity))
  return `${conn.baseURL.replace(/\/$/, '')}/v2/speak?${params.toString()}`
}

/**
 * One live Deepgram Flux TTS session. Owns the WebSocket, translates
 * `TtsSession` calls into `/v2/speak` wire frames, and yields normalized
 * {@link TtsEvent} values from server messages. Binary `Audio` frames carry
 * no turn identifier on the wire, so the connection tracks the active turn's
 * id itself (set by `SpeechStarted`) to attach to each `audio` event.
 */
export class FluxTtsConnection {
  private ws: WebSocketLike | undefined
  private readonly queue: TtsEvent[] = []
  private wake: (() => void) | undefined
  private closed = false
  private readonly closedSettled: Promise<void>
  private resolveClosedSettled!: () => void
  private activeTurnId: ReturnType<typeof SpeechTurnId> | undefined

  /** @param opts - resolved connection options, including the injectable WebSocket factory. */
  constructor(private readonly opts: FluxTtsConnectionOptions) {
    this.closedSettled = new Promise((resolve) => {
      this.resolveClosedSettled = resolve
    })
  }

  /**
   * Open the WebSocket. Resolves once the handshake completes (`open`);
   * rejects if the handshake fails before then.
   * @returns settles once the transport is ready to send text.
   */
  async connect(): Promise<void> {
    const url = buildUrl(this.opts)
    const ws = this.opts.createWebSocket(url, { Authorization: `Token ${this.opts.apiKey}` })
    this.ws = ws
    return new Promise<void>((resolve, reject) => {
      let opened = false
      ws.addEventListener('open', () => {
        opened = true
        resolve()
      })
      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data)
      })
      ws.addEventListener('close', (event) => {
        this.finish({ type: 'closed', code: event.code, reason: event.reason })
      })
      ws.addEventListener('error', (event) => {
        if (!opened) {
          reject(new Error(event.message ?? 'Deepgram Flux TTS WebSocket handshake failed'))
          return
        }
        this.enqueue({ type: 'error', code: 'TRANSPORT_ERROR', message: event.message ?? 'WebSocket error' })
      })
    })
  }

  private handleMessage(data: unknown): void {
    if (data instanceof Uint8Array) {
      if (this.activeTurnId !== undefined) {
        this.enqueue({ type: 'audio', turnId: this.activeTurnId, data })
      }
      return
    }
    if (typeof data !== 'string') return
    let message: FluxTtsServerMessage
    try {
      message = JSON.parse(data) as FluxTtsServerMessage
    } catch {
      // A non-JSON text frame from the server would be a protocol violation
      // this client cannot act on usefully; drop it rather than crash the session.
      return
    }
    switch (message.type) {
      case 'Connected':
        this.enqueue({ type: 'connected', requestId: SpeechRequestId(message.request_id), modelName: message.model_name })
        return
      case 'SpeechStarted': {
        const turnId = SpeechTurnId(message.speech_id)
        this.activeTurnId = turnId
        this.enqueue({ type: 'turn-started', turnId })
        return
      }
      case 'SpeechMetadata':
        this.enqueue({
          type: 'turn-completed',
          turnId: SpeechTurnId(message.speech_id),
          audioDurationMs: message.audio_duration_ms,
          inputCharacterCount: message.input_character_count,
          billableCharacterCount: message.billable_character_count,
        })
        return
      case 'SpeechInterrupted':
        this.enqueue({
          type: 'turn-interrupted',
          audioPlayedMs: message.audio_played_ms,
          ...message.text_spoken === undefined ? {} : { textSpoken: message.text_spoken },
          ...message.text_remaining === undefined ? {} : { textRemaining: message.text_remaining },
          metrics: {
            turnId: SpeechTurnId(message.metadata.speech_id),
            audioDurationMs: message.metadata.audio_duration_ms,
            inputCharacterCount: message.metadata.input_character_count,
            billableCharacterCount: message.metadata.billable_character_count,
          },
        })
        return
      case 'Flushed':
        this.enqueue({ type: 'turn-flushed', turnId: SpeechTurnId(message.speech_id) })
        return
      case 'SessionMetadata':
        this.enqueue({
          type: 'session-completed',
          totalAudioDurationMs: message.total_audio_duration_ms,
          totalInputCharacterCount: message.total_input_character_count,
          totalBillableCharacterCount: message.total_billable_character_count,
        })
        return
      case 'ConfigureSuccess':
        this.enqueue({ type: 'configure-ack', ok: true, ...message.applied.speed === undefined ? {} : { appliedSpeed: message.applied.speed } })
        return
      case 'ConfigureFailure':
        this.enqueue({
          type: 'configure-ack',
          ok: false,
          failureCode: message.code,
          failureMessage: message.description,
          ...message.field === undefined ? {} : { failureField: message.field },
          ...message.value === undefined ? {} : { failureValue: message.value },
        })
        return
      case 'Warning':
        this.enqueue({ type: 'warning', code: message.code, message: message.description })
        return
      case 'Error':
        this.enqueue({ type: 'error', code: message.code, message: message.description })
        return
      default:
        // Forward-compatible: an unrecognized message type from a future
        // protocol revision is dropped rather than crashing the session.
        return
    }
  }

  /**
   * Stream text into the active turn.
   * @param text - text to synthesize, appended verbatim to the active turn.
   */
  speak(text: string): void {
    if (this.closed) return
    this.sendControl({ type: 'Speak', text })
  }

  /** End the active turn: the provider generates its remaining audio and reports completion via `SpeechMetadata`. */
  flush(): void {
    if (this.closed) return
    this.sendControl({ type: 'Flush' })
  }

  /**
   * Cancel the active turn on caller-detected barge-in.
   * @param playbackOffsetMs - milliseconds of session audio the listener had heard; omit to skip the `text_spoken`/`text_remaining` split.
   */
  interrupt(playbackOffsetMs?: number): void {
    if (this.closed) return
    this.sendControl({
      type: 'Interrupt',
      ...playbackOffsetMs === undefined ? {} : { playback_offset: { type: 'time_ms', value: playbackOffsetMs } },
    })
  }

  /**
   * Send a `Configure` control message for the given request.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: TtsConfigureRequest): void {
    if (this.closed) return
    this.sendControl({ type: 'Configure', ...request.speed === undefined ? {} : { speed: request.speed } })
  }

  private sendControl(message: FluxTtsClientControl): void {
    this.ws?.send(JSON.stringify(message))
  }

  /**
   * Send `Close` and wait for the server to drain remaining audio and close
   * the transport. Idempotent: a second call returns the same settlement.
   * @returns settles once the WebSocket has closed.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.sendControl({ type: 'Close' })
    }
    return this.closedSettled
  }

  private enqueue(event: TtsEvent): void {
    this.queue.push(event)
    this.wake?.()
  }

  private finish(event: TtsEvent): void {
    if (this.closed) return
    this.closed = true
    this.enqueue(event)
    this.resolveClosedSettled()
  }

  /**
   * Async iterator over normalized `TtsEvent` values, in arrival order.
   * Terminates after the `closed` event has been yielded.
   * @yields each event as it arrives, or immediately if already queued.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TtsEvent> {
    while (true) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}
