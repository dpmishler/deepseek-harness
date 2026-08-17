/**
 * Provider-neutral streaming speech-session vocabulary shared by every STT
 * and TTS provider registered on `ctx.speech`. Types here name concepts, not
 * wire fields: a provider adapter maps its own protocol onto this vocabulary,
 * and nothing here assumes Deepgram, WebSocket framing, or any other
 * transport.
 * @module @deepseek-ai/dsh-speech/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SpeechRequestId, SpeechTurnId } from './brand.ts'

/** Raw (non-containerized) audio format for a streaming session. */
export interface AudioFormat {
  /** Sample encoding. `linear16` is signed 16-bit PCM; `mulaw`/`alaw` are G.711. */
  readonly encoding: 'linear16' | 'mulaw' | 'alaw'
  /** Sample rate in Hz, e.g. `16000`. */
  readonly sampleRateHz: number
}

/** One recognized or hinted word inside a turn transcript. */
export interface SttWord {
  /** Recognized word text, including any attached punctuation. */
  readonly text: string
  /** Provider confidence for this word, in `[0, 1]`. */
  readonly confidence: number
  /** Word start offset in seconds, relative to the session's audio start. */
  readonly startSec: number
  /** Word end offset in seconds, relative to the session's audio start. */
  readonly endSec: number
}

/**
 * How one {@link SttTurnEvent} relates to the provider's turn-detection state
 * machine. `progress` carries interim recognition with no state transition.
 * `started` opens a turn. `eager-completed` is a low-latency speculative
 * completion a provider may later retract via `resumed`. `completed` is the
 * confirmed, final end of the turn: its transcript is not revised further.
 */
export type SttTurnEventKind = 'progress' | 'started' | 'eager-completed' | 'resumed' | 'completed'

/** One turn-detection update: interim progress or a turn-boundary transition. */
export interface SttTurnEvent {
  readonly type: 'turn'
  readonly kind: SttTurnEventKind
  /** Zero-based index of the turn this update belongs to; increments after every `completed`. */
  readonly turnIndex: number
  /** Transcript accumulated for the current turn as of this update. */
  readonly transcript: string
  /** Recognized words backing `transcript`, in order. */
  readonly words: readonly SttWord[]
  /** Provider confidence that the turn has ended, in `[0, 1]`. */
  readonly endOfTurnConfidence: number
  /** Start of the audio window this update covers, in seconds. */
  readonly audioWindowStartSec: number
  /** End of the audio window this update covers, in seconds. */
  readonly audioWindowEndSec: number
  /** Detected languages ordered by share of the turn, for a multilingual session. */
  readonly languages?: readonly string[]
}

/** Emitted once, immediately after a session opens successfully. */
export interface SttConnectedEvent {
  readonly type: 'connected'
  /** Opaque provider-assigned identifier for this session, for correlating logs. */
  readonly requestId: SpeechRequestId
}

/** Reply to a caller {@link SttSession.configure} call. */
export interface SttConfigureAckEvent {
  readonly type: 'configure-ack'
  readonly ok: boolean
  /** Present when `ok` is `false`: stable provider failure code. */
  readonly failureCode?: string
  /** Present when `ok` is `false`: human-readable failure detail. */
  readonly failureMessage?: string
}

/** A provider-originated failure. Non-fatal errors leave the session usable; fatal ones precede a `closed` event. */
export interface SttErrorEvent {
  readonly type: 'error'
  readonly code: string
  readonly message: string
  readonly fatal: boolean
}

/** Emitted once when the transport closes, whether requested or not. */
export interface SttClosedEvent {
  readonly type: 'closed'
  readonly code?: number
  readonly reason?: string
}

/** Every event an open {@link SttSession} can emit. */
export type SttEvent = SttConnectedEvent | SttTurnEvent | SttConfigureAckEvent | SttErrorEvent | SttClosedEvent

/** Mid-session configuration update; omitted fields keep their current value. */
export interface SttConfigureRequest {
  /** Replaces the full keyterm list (never merged); `[]` clears it. */
  readonly keyterms?: readonly string[]
  /** Replaces language hints; `[]` reverts to auto-detection; `null`/omitted keeps the current hints. */
  readonly languageHints?: readonly string[] | null
  /** Confidence required to confirm a turn's end, in `[0.5, 0.9]`. */
  readonly endOfTurnConfidence?: number
  /** Confidence required to fire a speculative early completion, in `[0.3, 0.9]`; must be `<= endOfTurnConfidence`. */
  readonly eagerEndOfTurnConfidence?: number
  /** Silence duration in milliseconds that forces turn completion regardless of confidence. */
  readonly endOfTurnTimeoutMs?: number
}

/** Options accepted when opening a speech-to-text session. */
export interface SttOpenOptions {
  /** Provider id registered via {@link SpeechRuntime.registerSttProvider}. */
  readonly provider: string
  /** Provider-specific model or language selector (for example a Deepgram model id). */
  readonly model?: string
  /** Raw audio format; omit when the caller streams containerized audio the provider can demux. */
  readonly audio?: AudioFormat
  /** Initial keyterm list; see {@link SttConfigureRequest.keyterms}. */
  readonly keyterms?: readonly string[]
  /** Initial language hints; see {@link SttConfigureRequest.languageHints}. */
  readonly languageHints?: readonly string[]
  /** Initial turn-detection thresholds. */
  readonly endOfTurn?: {
    readonly confidence?: number
    readonly eagerConfidence?: number
    readonly timeoutMs?: number
  }
  /** Request-tracking tags opaque to the caller. */
  readonly tags?: readonly string[]
  /** Aborts the connection attempt; has no effect once the session is open. */
  readonly signal?: AbortSignal
}

/**
 * An open, provider-neutral speech-to-text session. `events` is a
 * single-consumer stream: drive it with one `for await` loop for the life of
 * the session.
 */
export interface SttSession {
  /** Ends when the transport closes; the final event is always `closed`, or the iterable rejects on an unrecoverable transport failure. */
  readonly events: AsyncIterable<SttEvent>

  /**
   * Enqueue one chunk of raw audio for recognition. Fire-and-forget: the
   * transport owns backpressure. Throws {@link SpeechError} (`SESSION_CLOSED`)
   * once `close()` has been called or `closed` has been observed.
   * @param chunk - raw audio bytes matching the session's negotiated {@link AudioFormat}.
   */
  sendAudio(chunk: Uint8Array): void

  /**
   * Apply a mid-session configuration update; the provider replies with a
   * `configure-ack` event.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: SttConfigureRequest): void

  /**
   * Request a graceful shutdown: the provider finishes any in-flight turn and
   * emits a final `closed` event before the transport disconnects.
   * @returns settles once the transport has closed.
   */
  close(): Promise<void>
}

/** Provider-wire adapter for {@link SttSession}. Register with `ctx.speech.registerSttProvider(id, provider)`. */
export interface SttProvider {
  /**
   * Open one session.
   * @param options - session parameters; `options.provider` is this adapter's registered id.
   * @returns the open session once the transport confirms readiness.
   */
  connect(options: SttOpenOptions): Promise<SttSession>
}

/** Options accepted when opening a text-to-speech session. */
export interface TtsOpenOptions {
  /** Provider id registered via {@link SpeechRuntime.registerTtsProvider}. */
  readonly provider: string
  /** Provider-specific voice/model selector. */
  readonly voice?: string
  /** Raw output audio format. */
  readonly audio?: AudioFormat
  /** Initial speech-rate multiplier. */
  readonly speed?: number
  /** Initial delivery-register dial, calm-to-animated. */
  readonly expressivity?: number
  /** Request-tracking tags opaque to the caller. */
  readonly tags?: readonly string[]
  /** Aborts the connection attempt; has no effect once the session is open. */
  readonly signal?: AbortSignal
}

/** Emitted once, immediately after a session opens successfully. */
export interface TtsConnectedEvent {
  readonly type: 'connected'
  readonly requestId: SpeechRequestId
  /** Resolved model/voice identifier the provider will synthesize with. */
  readonly modelName: string
}

/** One binary audio chunk belonging to the turn named by `turnId`. */
export interface TtsAudioEvent {
  readonly type: 'audio'
  readonly turnId: SpeechTurnId
  readonly data: Uint8Array
}

/** Emitted once at the start of a new turn, before its audio. */
export interface TtsTurnStartedEvent {
  readonly type: 'turn-started'
  readonly turnId: SpeechTurnId
}

/** Per-turn billing and timing, shared by a natural completion and an interrupted one. */
export interface TtsTurnMetrics {
  readonly turnId: SpeechTurnId
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/** Emitted once a turn's audio is fully generated after a caller `flush()`. */
export interface TtsTurnCompletedEvent extends TtsTurnMetrics {
  readonly type: 'turn-completed'
}

/** Acknowledges that a caller `flush()` reached the head of the turn queue and was applied. */
export interface TtsTurnFlushedEvent {
  readonly type: 'turn-flushed'
  readonly turnId: SpeechTurnId
}

/** Reply to a caller `interrupt()`: what the listener heard, and what they did not. */
export interface TtsTurnInterruptedEvent {
  readonly type: 'turn-interrupted'
  /** How much session audio had played when the interrupt landed, in milliseconds. */
  readonly audioPlayedMs: number
  /** Portion of the turn's text the listener heard; present only when `interrupt()` carried a playback offset. */
  readonly textSpoken?: string
  /** Portion of the turn's text the listener did not hear; present only when `interrupt()` carried a playback offset. */
  readonly textRemaining?: string
  readonly metrics: TtsTurnMetrics
}

/** Cumulative session totals, emitted once immediately before the transport closes. */
export interface TtsSessionCompletedEvent {
  readonly type: 'session-completed'
  readonly totalAudioDurationMs: number
  readonly totalInputCharacterCount: number
  readonly totalBillableCharacterCount: number
}

/** Reply to a caller {@link TtsSession.configure} call. */
export interface TtsConfigureAckEvent {
  readonly type: 'configure-ack'
  readonly ok: boolean
  /** Present when `ok` is `true`: the configuration now in effect. */
  readonly appliedSpeed?: number
  /** Present when `ok` is `false`: stable provider failure code. */
  readonly failureCode?: string
  /** Present when `ok` is `false` and the failure names one field. */
  readonly failureField?: string
  /** Present when `ok` is `false` and the failure names one rejected value. */
  readonly failureValue?: unknown
  /** Present when `ok` is `false`: human-readable failure detail. */
  readonly failureMessage?: string
}

/** A non-fatal, provider-originated notice; the session remains usable. */
export interface TtsWarningEvent {
  readonly type: 'warning'
  readonly code: string
  readonly message: string
}

/** A fatal, provider-originated failure; always followed by a `closed` event. */
export interface TtsErrorEvent {
  readonly type: 'error'
  readonly code: string
  readonly message: string
}

/** Emitted once when the transport closes, whether requested or not. */
export interface TtsClosedEvent {
  readonly type: 'closed'
  readonly code?: number
  readonly reason?: string
}

/** Every event an open {@link TtsSession} can emit. */
export type TtsEvent =
  | TtsConnectedEvent
  | TtsAudioEvent
  | TtsTurnStartedEvent
  | TtsTurnCompletedEvent
  | TtsTurnFlushedEvent
  | TtsTurnInterruptedEvent
  | TtsSessionCompletedEvent
  | TtsConfigureAckEvent
  | TtsWarningEvent
  | TtsErrorEvent
  | TtsClosedEvent

/** Mid-session configuration update; omitted fields keep their current value. */
export interface TtsConfigureRequest {
  /** New speech-rate multiplier. */
  readonly speed?: number
}

/**
 * An open, provider-neutral text-to-speech session. `events` is a
 * single-consumer stream: drive it with one `for await` loop for the life of
 * the session. A session is a sequence of turns: `speak()` streams text into
 * the active turn and `flush()` closes it; `interrupt()` cancels the active
 * turn on caller-detected barge-in.
 */
export interface TtsSession {
  /** Ends when the transport closes; the final event is always `closed`, or the iterable rejects on an unrecoverable transport failure. */
  readonly events: AsyncIterable<TtsEvent>

  /**
   * Stream text into the active turn (starting one if none is active). Send
   * plain text; whitespace between separate calls is the caller's
   * responsibility. Throws {@link SpeechError} (`SESSION_CLOSED`) once closed.
   * @param text - text to synthesize, appended verbatim to the active turn.
   */
  speak(text: string): void

  /** End the active turn: the provider generates its remaining audio and reports completion. A call with no active turn is a no-op. */
  flush(): void

  /**
   * Cancel the active turn because the caller detected barge-in. Stop local
   * playback before calling this — the round trip is for context
   * reconciliation, not for stopping audio — and discard any `audio` events
   * that arrive before the resulting `turn-interrupted` event.
   * @param playbackOffsetMs - milliseconds of session audio the listener had
   *   actually heard when the barge-in was detected, measured from the start
   *   of the session. Required to receive `textSpoken`/`textRemaining` on the
   *   reply; each call's offset must exceed the previous interrupt's.
   */
  interrupt(playbackOffsetMs?: number): void

  /**
   * Apply a mid-session configuration update; the provider replies with a
   * `configure-ack` event.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: TtsConfigureRequest): void

  /**
   * Request a graceful shutdown: the provider drains all queued audio and
   * emits a final `session-completed` then `closed` event before the
   * transport disconnects.
   * @returns settles once the transport has closed.
   */
  close(): Promise<void>
}

/** Provider-wire adapter for {@link TtsSession}. Register with `ctx.speech.registerTtsProvider(id, provider)`. */
export interface TtsProvider {
  /**
   * Open one session.
   * @param options - session parameters; `options.provider` is this adapter's registered id.
   * @returns the open session once the transport confirms readiness.
   */
  connect(options: TtsOpenOptions): Promise<TtsSession>
}

/**
 * Typed speech error. `code` is machine-routable:
 * - `SPEECH_DUPLICATE_PROVIDER` — id already registered in that capability kind (STT or TTS).
 * - `SPEECH_PROVIDER_NOT_REGISTERED` — `options.provider` names an id with no registered provider.
 * - `SESSION_CLOSED` — a session method was called after `close()` or after observing `closed`.
 * - `CONNECT_ABORTED` — `options.signal` was already aborted, or fired before the provider's transport
 *   finished connecting; providers that honor {@link SttOpenOptions.signal}/{@link TtsOpenOptions.signal} use this code.
 */
export class SpeechError extends HarnessError {}
