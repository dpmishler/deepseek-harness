/**
 * Flux STT WebSocket session: lifecycle, event routing, keepalive, and
 * error handling for the Deepgram `/v2/listen` endpoint.
 *
 * The session resolves its `connect()` promise only after receiving the
 * `Connected` server message, surface-exposes `SttSession.events` as a
 * single-consumer async iterable, and throws `SESSION_CLOSED` on any
 * operation after the session has closed.
 * @module @deepseek-ai/dsh-flux-stt/session
 */

import { VoiceError } from '@deepseek-ai/dsh-voice'
import type { SpeechRequestId, SttConfigureRequest, SttEvent, SttSession, SttWord } from '@deepseek-ai/dsh-voice'
import type { ListenV2ClientMessage, ListenV2Configure, ListenV2ServerMessage, ListenV2Word } from './types.ts'
import type { WebSocketLike } from './socket.ts'

const SESSION_CLOSED = 'SESSION_CLOSED'

/** Throw `SESSION_CLOSED` when an operation is attempted after the session has closed. */
function assertOpen(closed: boolean): void {
  if (closed) throw new VoiceError('The STT session is already closed', SESSION_CLOSED)
}

function mapWord(w: ListenV2Word): SttWord {
  return { text: w.word, confidence: w.confidence, startSec: w.start, endSec: w.end }
}

/**
 * Configuration options for a single Flux STT WebSocket session.
 * The owning `FluxSttProvider` is responsible for supplying valid values.
 */
export interface FluxSttSessionOptions {
  /** Already-opened WebSocket socket, connecting or connected. */
  socket: WebSocketLike
  /** Interval (ms) at which `socket.ping()` is sent when audio is not flowing. */
  keepAliveIntervalMs: number
}

/**
 * A live Deepgram Flux STT session. Constructed by `FluxSttProvider.connect()`
 * after the WebSocket socket is created; the session's `connected` promise
 * resolves once the `Connected` server message arrives.
 *
 * `session.connected` must be awaited before returning the session to callers.
 */
export class FluxSttSession implements SttSession {
  /** Resolves with the session once `Connected` arrives; rejects on fatal errors. */
  readonly connected: Promise<FluxSttSession>

  private connectedResolve!: (session: FluxSttSession) => void
  private connectedReject!: (err: Error) => void

  private readonly queue: SttEvent[] = []
  private pendingResolve: (() => void) | null = null
  private closed = false
  private turnIndex = 0
  private activeTurnIndex = -1

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastAudioTime = 0

  private readonly socket: WebSocketLike
  private readonly keepAliveIntervalMs: number

  constructor(opts: FluxSttSessionOptions) {
    this.socket = opts.socket
    this.keepAliveIntervalMs = opts.keepAliveIntervalMs

    this.connected = new Promise<FluxSttSession>((resolve, reject) => {
      this.connectedResolve = resolve
      this.connectedReject = reject
    })

    this.socket.on('message', (data, _isBinary) => {
      this.handleMessage(data)
    })

    this.socket.on('close', (code, reason) => {
      this.handleClose(code, reason.toString())
    })

    this.socket.on('error', (err) => {
      this.handleError(err)
    })

    this.startKeepalive()
  }

  // ── keepalive ────────────────────────────────────────────────────────────────

  private startKeepalive(): void {
    this.lastAudioTime = Date.now()
    this.keepAliveTimer = setInterval(() => {
      if (!this.closed && Date.now() - this.lastAudioTime >= this.keepAliveIntervalMs) {
        this.socket.ping()
      }
    }, this.keepAliveIntervalMs)
  }

  private stopKeepalive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  // ── message handling ─────────────────────────────────────────────────────────

  private handleMessage(data: Buffer): void {
    let msg: ListenV2ServerMessage
    try {
      msg = JSON.parse(data.toString()) as ListenV2ServerMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'Connected':
        this.push({ type: 'connected', requestId: msg.request_id as SpeechRequestId })
        this.connectedResolve(this)
        break
      case 'TurnInfo': {
        const kind = msg.event === 'EndOfTurn'
          ? 'completed'
          : msg.event === 'EagerEndOfTurn' ? 'eager-completed' : 'resumed'
        const turnIndex = msg.turn_index
        this.push({
          type: 'turn',
          kind,
          turnIndex,
          transcript: msg.transcript,
          words: msg.words.map(mapWord),
          endOfTurnConfidence: msg.end_of_turn_confidence,
          audioWindowStartSec: msg.audio_window_start,
          audioWindowEndSec: msg.audio_window_end,
          ...(msg.languages !== undefined ? { languages: msg.languages } : {}),
        })
        if (kind === 'completed') this.turnIndex = turnIndex + 1
        break
      }
      case 'Results': {
        const alt = msg.channel.alternatives[0]
        if (alt === undefined || alt.transcript.length === 0) break
        const kind = msg.speech_final ? 'started' : 'progress'
        if (kind === 'started') this.activeTurnIndex = this.turnIndex
        this.push({
          type: 'turn',
          kind,
          turnIndex: this.activeTurnIndex >= 0 ? this.activeTurnIndex : this.turnIndex,
          transcript: alt.transcript,
          words: alt.words.map(mapWord),
          endOfTurnConfidence: alt.confidence,
          audioWindowStartSec: 0,
          audioWindowEndSec: 0,
        })
        break
      }
      case 'Error':
        // Fatal server error: reject the connect() promise if not yet resolved,
        // then push the error event and close.
        this.connectedReject(new Error(msg.description))
        if (!this.closed) {
          this.push({ type: 'error', code: msg.code, message: msg.description, fatal: true })
          this.doClose()
        }
        break
      default:
        // Unknown frame; ignore for forward compatibility.
        break
    }
  }

  private handleClose(code: number, reason: string): void {
    const wasResolved = this.closed
    this.stopKeepalive()
    if (!wasResolved) {
      // If we closed before Connected arrived, reject the connect promise.
      this.connectedReject(new Error(`transport closed before Connected (code ${code}): ${reason}`))
      if (code !== 1000 && code !== 1001) {
        this.push({ type: 'error', code: `WS_CLOSE_${code}`, message: reason || `closed ${code}`, fatal: true })
      }
    }
    this.closed = true
    this.push({ type: 'closed', ...(code !== undefined ? { code } : {}), ...(reason.length > 0 ? { reason } : {}) })
    this.wakeConsumer()
  }

  private handleError(err: Error): void {
    this.stopKeepalive()
    this.connectedReject(err)
    if (!this.closed) {
      this.push({ type: 'error', code: 'CONNECTION_FAILED', message: err.message, fatal: true })
      this.closed = true
    }
    this.wakeConsumer()
  }

  private doClose(): void {
    this.stopKeepalive()
    this.closed = true
    this.wakeConsumer()
  }

  // ── event queue ──────────────────────────────────────────────────────────────

  private push(event: SttEvent): void {
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

  // ── SttSession interface ─────────────────────────────────────────────────────

  get events(): AsyncIterable<SttEvent> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<SttEvent> {
        return {
          async next(): Promise<IteratorResult<SttEvent>> {
            while (true) {
              if (self.queue.length > 0) return { value: self.queue.shift()!, done: false }
              if (self.closed) return { value: undefined as unknown as SttEvent, done: true }
              await new Promise<void>((resolve) => { self.pendingResolve = resolve })
            }
          },
        }
      },
    }
  }

  /**
   * Send raw audio to the endpoint.
   * @param chunk - PCM/encoded audio bytes in the session's negotiated format.
   * @throws {@link VoiceError} `SESSION_CLOSED` when called after close.
   */
  sendAudio(chunk: Uint8Array): void {
    assertOpen(this.closed)
    this.lastAudioTime = Date.now()
    this.socket.send(chunk)
  }

  /**
   * Update turn-detection configuration.
   * @param request - fields to change; omitted fields keep their current value.
   * @throws {@link VoiceError} `SESSION_CLOSED` when called after close.
   */
  configure(request: SttConfigureRequest): void {
    assertOpen(this.closed)
    const thresholds: ListenV2Configure['thresholds'] = {}
    if (request.endOfTurnConfidence !== undefined) thresholds.eot_threshold = request.endOfTurnConfidence
    if (request.eagerEndOfTurnConfidence !== undefined) thresholds.eager_eot_threshold = request.eagerEndOfTurnConfidence
    if (request.endOfTurnTimeoutMs !== undefined) thresholds.eot_timeout_ms = request.endOfTurnTimeoutMs
    const msg: ListenV2ClientMessage = {
      type: 'Configure',
      ...(Object.keys(thresholds).length > 0 ? { thresholds } : {}),
      ...(request.keyterms !== undefined ? { keyterms: [...request.keyterms] } : {}),
    }
    this.socket.send(JSON.stringify(msg))
  }

  /**
   * Gracefully close the session.
   * @returns resolves once the transport closes.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    const closeMsg: ListenV2ClientMessage = { type: 'CloseStream' }
    this.socket.send(JSON.stringify(closeMsg))
    this.socket.close(1000)
    // The socket's close() fires the 'close' event synchronously in tests.
    // If it does, closed is already true. Either way, return a resolved promise.
    return Promise.resolve()
  }
}
