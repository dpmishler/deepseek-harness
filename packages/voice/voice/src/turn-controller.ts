/**
 * Explicit turn state machine driving one voice conversation: pumps STT
 * turn-detection events, streams the LLM's response text directly into an
 * open TTS session, and reconciles barge-in. Cordis- and session-log-free by
 * design — `./consumer.ts` is the Cordis plugin that wires this engine to a
 * live `Agent` and appends the durable `voice/*` session events; this class
 * owns only the wire-neutral orchestration so it is testable against fake
 * {@link SttSession}/{@link TtsSession} objects with no Cordis context at all.
 * @module @deepseek-ai/dsh-voice/turn-controller
 */

import { assertNever, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { VoiceError } from './error.ts'
import { PlaybackClock } from './playback-clock.ts'
import type { SttSession, SttTurnEvent, TtsSession, TtsTurnCompletedEvent, TtsTurnInterruptedEvent, TtsWarningEvent } from './types.ts'

/**
 * The conversation's current phase. `idle` never recurs after {@link TurnController.run}
 * starts (the controller immediately begins `listening`); it exists for a
 * caller that inspects {@link TurnController.currentState} before `run()`.
 */
export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking'

/**
 * Callbacks the controller drives as the conversation progresses. Every
 * handler is synchronous and fire-and-forget from the controller's
 * perspective — a consumer that needs to append a session event or update UI
 * state does so inside the callback; a throwing handler propagates out of the
 * controller's internal pump loop and reaches {@link TurnController.run}'s
 * rejection, ending the conversation.
 */
export interface TurnControllerHandlers {
  /** The turn state changed. Optional — most consumers care only about the terminal events below. */
  onStateChange?(state: TurnState): void
  /** A user utterance's turn detection completed; `turn.transcript` is the final text about to be sent to {@link TurnControllerOptions.respond}. */
  onTranscript(turn: SttTurnEvent): void
  /** One text delta the model produced, forwarded to TTS in the same call. Optional — for UI echo only. */
  onAssistantTextDelta?(text: string): void
  /** One binary audio chunk to render. Never called for a chunk the controller determined was stale (see {@link TurnController.discardedFrameCount}). */
  onAudio(chunk: Uint8Array): void
  /** Barge-in was detected: stop rendering any already-buffered audio for the current response immediately, before the provider round trip completes. */
  onHaltPlayback(): void
  /** The active TTS turn finished naturally (no barge-in). */
  onTurnCompleted?(event: TtsTurnCompletedEvent): void
  /** The active TTS turn was cancelled by barge-in; carries the exact `textSpoken`/`textRemaining` split for conversation reconciliation. */
  onSpeechInterrupted(event: TtsTurnInterruptedEvent): void
  /** A non-fatal provider notice. Optional — synthesis continues without caller action. */
  onWarning?(event: TtsWarningEvent): void
  /** A fatal STT/TTS transport or protocol failure, or an LLM response failure not caused by barge-in cancellation. */
  onError(error: Error): void
}

/** Constructor options for {@link TurnController}. */
export interface TurnControllerOptions {
  /** The open STT session driving turn detection; the controller consumes its `events` for the whole conversation. */
  readonly stt: SttSession
  /** The open TTS session receiving `speak()`/`flush()`/`interrupt()` calls. */
  readonly tts: TtsSession
  /** Session-wide playback-position clock; a caller driving real audio reports progress through {@link TurnController.reportPlayed}. */
  readonly playbackClock: PlaybackClock
  /**
   * Produce the assistant's streaming response to one final transcript.
   * Reusing `@deepseek-ai/dsh-llm`'s `StreamChunk` vocabulary directly (rather
   * than a narrower text-only contract) keeps this the same stream an
   * `LlmRuntime.stream()` call already produces: the controller consumes only
   * `text-delta` chunks and treats the stream's end as the response's end,
   * so a real `respond` is `(transcript, signal) => ctx.llm.stream(options)`
   * with `transcript` folded into `options.messages` and `signal` forwarded
   * to `options.signal`.
   * @param transcript - the completed user turn's final text.
   * @param signal - aborted the instant a barge-in cancels this response.
   */
  readonly respond: (transcript: string, signal: AbortSignal) => AsyncIterable<StreamChunk>
  readonly handlers: TurnControllerHandlers
}

/**
 * Drives one voice conversation end to end. Barge-in reconciliation: a fresh
 * STT turn starting while the controller is `thinking` or `speaking` aborts
 * the in-flight LLM response, halts local playback, sends `interrupt()` with
 * the session-wide playback offset, and bumps an internal generation counter
 * so any audio already in flight for the cancelled response is dropped
 * instead of reaching {@link TurnControllerHandlers.onAudio} — see
 * {@link TurnController.discardedFrameCount}.
 */
export class TurnController {
  private state: TurnState = 'idle'
  /** Bumped on every barge-in; invalidates the in-flight response and any TTS turn it started. */
  private generation = 0
  /** The generation whose TTS turn is currently producing audio, or `undefined` before the first `turn-started`. */
  private speakingGeneration: number | undefined
  private discardedAudioFrames = 0
  private currentAbort: AbortController | undefined
  private closed = false

  constructor(private readonly options: TurnControllerOptions) {}

  /** The controller's current phase. */
  get currentState(): TurnState {
    return this.state
  }

  /** Audio chunks dropped because they belonged to a response superseded by barge-in before they arrived. */
  get discardedFrameCount(): number {
    return this.discardedAudioFrames
  }

  /**
   * Start pumping both sessions' events for the life of the conversation.
   * @returns settles once both `events` streams end (normal session close) or rejects on an unhandled pump failure.
   */
  async run(): Promise<void> {
    this.setState('listening')
    await Promise.all([this.pumpStt(), this.pumpTts()])
  }

  /**
   * Report locally rendered playback progress, advancing the session-wide
   * {@link PlaybackClock} a caller driving real audio output owns.
   * @param ms - non-negative milliseconds of audio the sink has just rendered.
   */
  reportPlayed(ms: number): void {
    this.options.playbackClock.advance(ms)
  }

  /**
   * Close both underlying sessions and stop pumping. Idempotent.
   * @returns settles once both sessions have closed.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.currentAbort?.abort()
    await Promise.all([this.options.stt.close(), this.options.tts.close()])
  }

  private setState(next: TurnState): void {
    if (this.state === next) return
    this.state = next
    this.options.handlers.onStateChange?.(next)
  }

  private async pumpStt(): Promise<void> {
    try {
      for await (const event of this.options.stt.events) {
        if (event.type !== 'turn') continue
        if (event.kind === 'started' && (this.state === 'thinking' || this.state === 'speaking')) {
          this.bargeIn()
        }
        if (event.kind === 'completed') {
          this.options.handlers.onTranscript(event)
          this.beginResponse(event.transcript)
        }
      }
    } catch (error) {
      this.options.handlers.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async pumpTts(): Promise<void> {
    try {
      for await (const event of this.options.tts.events) {
        switch (event.type) {
          case 'turn-started':
            this.speakingGeneration = this.generation
            this.setState('speaking')
            break
          case 'audio':
            if (this.speakingGeneration === this.generation) {
              this.options.handlers.onAudio(event.data)
            } else {
              this.discardedAudioFrames += 1
            }
            break
          case 'turn-completed':
            this.options.handlers.onTurnCompleted?.(event)
            this.setState('listening')
            break
          case 'turn-interrupted':
            this.options.handlers.onSpeechInterrupted(event)
            this.setState('listening')
            break
          case 'warning':
            this.options.handlers.onWarning?.(event)
            break
          case 'error':
            this.options.handlers.onError(new VoiceError(event.message, event.code))
            break
          case 'connected':
          case 'turn-flushed':
          case 'session-completed':
          case 'configure-ack':
          case 'closed':
            break
          default:
            assertNever(event, 'TurnController.pumpTts')
        }
      }
    } catch (error) {
      this.options.handlers.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private beginResponse(transcript: string): void {
    const myGeneration = ++this.generation
    this.setState('thinking')
    const controller = new AbortController()
    this.currentAbort = controller
    void this.streamResponse(transcript, myGeneration, controller.signal)
  }

  private async streamResponse(transcript: string, myGeneration: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const chunk of this.options.respond(transcript, signal)) {
        if (myGeneration !== this.generation) return
        if (chunk.type === 'text-delta') {
          this.options.handlers.onAssistantTextDelta?.(chunk.text)
          this.options.tts.speak(chunk.text)
        }
      }
      if (myGeneration === this.generation) this.options.tts.flush()
    } catch (error) {
      // A barge-in's abort() surfaces here as the respond() stream's own
      // rejection shape; either way a superseded generation is not a real
      // failure — the barge-in path already reported it via onHaltPlayback.
      if (myGeneration !== this.generation) return
      this.options.handlers.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private bargeIn(): void {
    this.generation += 1
    this.currentAbort?.abort()
    this.options.handlers.onHaltPlayback()
    this.options.tts.interrupt(this.options.playbackClock.elapsedMs)
    this.setState('listening')
  }
}
