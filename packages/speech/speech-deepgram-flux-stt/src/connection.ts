/**
 * `FluxSttConnection`: WebSocket lifecycle, protocol request construction,
 * and message mapping for the Deepgram Flux STT `/v2/listen` endpoint.
 *
 * The connection accepts an injectable `createWebSocket` factory for tests;
 * production code lazily imports undici's `WebSocket`, which (unlike the
 * global `WebSocket`) accepts custom request headers — required to send the
 * `Authorization` header on the handshake.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-stt/connection
 */

import type { SttConfigureRequest, SttEvent, SttOpenOptions } from '@deepseek-ai/dsh-speech'
import { SpeechRequestId } from '@deepseek-ai/dsh-speech'
import type {
  FluxSttClientControl,
  FluxSttServerMessage,
  FluxThresholds,
  FluxWord,
} from './types.ts'

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

/** Default Deepgram STT endpoint base; Flux requires `/v2/listen` (never `/v1/listen`). */
export const DEFAULT_BASE_URL = 'wss://api.deepgram.com'

/** Resolved options for opening one `FluxSttConnection`. */
export interface FluxSttConnectionOptions {
  /** Deepgram API key, sent as `Authorization: Token <apiKey>`. */
  readonly apiKey: string
  /** Endpoint base (default: {@link DEFAULT_BASE_URL}). */
  readonly baseURL: string
  /** Flux STT model: `flux-general-en` or `flux-general-multi`. */
  readonly model: string
  readonly options: SttOpenOptions
  /** Injectable WebSocket factory; production code supplies the undici-backed default. */
  readonly createWebSocket: WebSocketFactory
}

/**
 * Lazily import undici's `WebSocket`, which supports custom request headers
 * (Node's global `WebSocket` does not) — required to send the `Authorization`
 * header on the `/v2/listen` handshake.
 * @returns factory that opens an undici WebSocket with the given headers.
 */
async function defaultWebSocketFactory(): Promise<WebSocketFactory> {
  const { WebSocket } = await import('undici')
  return (url, headers) => new WebSocket(url, { headers })
}

function buildUrl(conn: FluxSttConnectionOptions): string {
  const { options } = conn
  const params = new URLSearchParams()
  params.set('model', conn.model)
  if (options.audio !== undefined) {
    params.set('encoding', options.audio.encoding)
    params.set('sample_rate', String(options.audio.sampleRateHz))
  }
  if (options.endOfTurn?.confidence !== undefined) params.set('eot_threshold', String(options.endOfTurn.confidence))
  if (options.endOfTurn?.eagerConfidence !== undefined) {
    params.set('eager_eot_threshold', String(options.endOfTurn.eagerConfidence))
  }
  if (options.endOfTurn?.timeoutMs !== undefined) params.set('eot_timeout_ms', String(options.endOfTurn.timeoutMs))
  for (const keyterm of options.keyterms ?? []) params.append('keyterm', keyterm)
  for (const hint of options.languageHints ?? []) params.append('language_hint', hint)
  return `${conn.baseURL.replace(/\/$/, '')}/v2/listen?${params.toString()}`
}

function mapWord(word: FluxWord): { text: string; confidence: number; startSec: number; endSec: number } {
  return { text: word.word, confidence: word.confidence, startSec: word.start, endSec: word.end }
}

const TURN_KIND_BY_EVENT = {
  Update: 'progress',
  StartOfTurn: 'started',
  EagerEndOfTurn: 'eager-completed',
  TurnResumed: 'resumed',
  EndOfTurn: 'completed',
} as const

/**
 * One live Deepgram Flux STT session. Owns the WebSocket, translates
 * `SttSession` calls into `/v2/listen` wire frames, and yields normalized
 * {@link SttEvent} values from server messages.
 */
export class FluxSttConnection {
  private ws: WebSocketLike | undefined
  private readonly queue: SttEvent[] = []
  private wake: (() => void) | undefined
  private closed = false
  private readonly closedSettled: Promise<void>
  private resolveClosedSettled!: () => void

  /** @param opts - resolved connection options, including the injectable WebSocket factory. */
  constructor(private readonly opts: FluxSttConnectionOptions) {
    this.closedSettled = new Promise((resolve) => {
      this.resolveClosedSettled = resolve
    })
  }

  /**
   * Open the WebSocket. Resolves once the handshake completes (`open`);
   * rejects if the handshake fails before then.
   * @returns settles once the transport is ready to send audio.
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
          reject(new Error(event.message ?? 'Deepgram Flux STT WebSocket handshake failed'))
          return
        }
        this.enqueue({ type: 'error', code: 'TRANSPORT_ERROR', message: event.message ?? 'WebSocket error', fatal: false })
      })
    })
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let message: FluxSttServerMessage
    try {
      message = JSON.parse(data) as FluxSttServerMessage
    } catch {
      // A non-JSON text frame from the server would be a protocol violation
      // this client cannot act on usefully; drop it rather than crash the session.
      return
    }
    switch (message.type) {
      case 'Connected':
        this.enqueue({ type: 'connected', requestId: SpeechRequestId(message.request_id) })
        return
      case 'TurnInfo':
        this.enqueue({
          type: 'turn',
          kind: TURN_KIND_BY_EVENT[message.event],
          turnIndex: message.turn_index,
          transcript: message.transcript,
          words: message.words.map(mapWord),
          endOfTurnConfidence: message.end_of_turn_confidence,
          audioWindowStartSec: message.audio_window_start,
          audioWindowEndSec: message.audio_window_end,
          ...message.languages === undefined ? {} : { languages: message.languages },
        })
        return
      case 'Error':
        this.enqueue({ type: 'error', code: message.code, message: message.description, fatal: true })
        return
      case 'ConfigureSuccess':
        this.enqueue({ type: 'configure-ack', ok: true })
        return
      case 'ConfigureFailure':
        this.enqueue({
          type: 'configure-ack',
          ok: false,
          ...message.code === undefined ? {} : { failureCode: message.code },
          ...message.description === undefined ? {} : { failureMessage: message.description },
        })
        return
      default:
        // Forward-compatible: an unrecognized message type from a future
        // protocol revision is dropped rather than crashing the session.
        return
    }
  }

  /**
   * Enqueue one chunk of raw audio. A no-op once the connection has closed.
   * @param chunk - raw audio bytes in the negotiated {@link SttOpenOptions.audio} format.
   */
  sendAudio(chunk: Uint8Array): void {
    if (this.closed) return
    this.ws?.send(chunk)
  }

  /**
   * Send a `Configure` control message for the given request.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: SttConfigureRequest): void {
    if (this.closed) return
    const thresholds: FluxThresholds = {
      ...request.endOfTurnConfidence === undefined ? {} : { eot_threshold: request.endOfTurnConfidence },
      ...request.eagerEndOfTurnConfidence === undefined ? {} : { eager_eot_threshold: request.eagerEndOfTurnConfidence },
      ...request.endOfTurnTimeoutMs === undefined ? {} : { eot_timeout_ms: request.endOfTurnTimeoutMs },
    }
    const message: FluxSttClientControl = {
      type: 'Configure',
      ...Object.keys(thresholds).length === 0 ? {} : { thresholds },
      ...request.keyterms === undefined ? {} : { keyterms: [...request.keyterms] },
      ...request.languageHints === undefined || request.languageHints === null
        ? {}
        : { language_hints: [...request.languageHints] },
    }
    this.sendControl(message)
  }

  private sendControl(message: FluxSttClientControl): void {
    this.ws?.send(JSON.stringify(message))
  }

  /**
   * Send `CloseStream` and wait for the server to close the transport.
   * Idempotent: a second call returns the same settlement.
   * @returns settles once the WebSocket has closed.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.sendControl({ type: 'CloseStream' })
      this.ws?.close(1000)
    }
    return this.closedSettled
  }

  private enqueue(event: SttEvent): void {
    this.queue.push(event)
    this.wake?.()
  }

  private finish(event: SttEvent): void {
    if (this.closed) return
    this.closed = true
    this.enqueue(event)
    this.resolveClosedSettled()
  }

  /**
   * Async iterator over normalized `SttEvent` values, in arrival order.
   * Terminates after the `closed` event has been yielded.
   * @yields each event as it arrives, or immediately if already queued.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<SttEvent> {
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

/**
 * Resolve the production `createWebSocket` factory. Lazily imports undici so
 * importing this module has no side effect; callers memoize the resolved
 * factory across connections (constructing it per undici WebSocket handshake
 * would be wasteful, not incorrect).
 * @returns a sync {@link WebSocketFactory} backed by undici's `WebSocket`.
 */
export const resolveDefaultWebSocketFactory = defaultWebSocketFactory
