/**
 * Durable session-log integration for {@link TurnController}: the
 * `speech-agent/*` `SessionEventMap` vocabulary and a pure handler-wrapping
 * helper that appends one event per reconciliation-relevant callback before
 * delegating to a consumer's own {@link TurnControllerHandlers}. Kept out of
 * the package's main barrel (`./index.ts`) because it is the only module that
 * needs `@deepseek-ai/dsh-session`'s `Session` type; importing it is opt-in
 * for a consumer that logs, while a unit test of {@link TurnController}
 * itself never needs a session at all.
 * @module @deepseek-ai/dsh-speech-agent/consumer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { TurnControllerHandlers } from './turn-controller.ts'

/** Durable record of one completed user turn, immediately before its transcript reaches the model. */
export interface SpeechAgentTranscriptMeta {
  /** The response generation this transcript starts; correlates with the matching `speech-agent/response` event. */
  readonly generation: number
  readonly turnIndex: number
  readonly transcript: string
  readonly endOfTurnConfidence: number
}

/**
 * Durable record of the complete text the model generated for one response
 * generation — the "generated" half of generated-vs-heard reconciliation.
 * Always logged, whether the generation later completed naturally or was
 * superseded by barge-in.
 */
export interface SpeechAgentResponseMeta {
  readonly generation: number
  readonly text: string
}

/** Durable per-turn billing and timing for a TTS turn that completed naturally. */
export interface SpeechAgentTurnCompletedMeta {
  /** The response generation that produced this turn; correlates with the matching `speech-agent/response` event. */
  readonly generation: number
  readonly turnId: SpeechTurnId
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/**
 * Durable barge-in reconciliation — the "heard" half: the exact split between
 * what the listener heard (`textSpoken`) and what was cancelled
 * (`textRemaining`) for one interrupted TTS turn, plus that turn's billing and
 * timing. `generation` joins the preceding `speech-agent/response` event with
 * the same generation — `textSpoken + textRemaining` must reconstruct that
 * event's `text` verbatim; the package invariant company checks this exactly.
 */
export interface SpeechAgentTurnInterruptedMeta {
  /** The response generation that produced this turn; correlates with the matching `speech-agent/response` event. */
  readonly generation: number
  readonly turnId: SpeechTurnId
  readonly audioPlayedMs: number
  readonly textSpoken?: string
  readonly textRemaining?: string
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/** Durable cumulative TTS session totals, recorded once before the transport closes. */
export interface SpeechAgentSessionCompletedMeta {
  readonly totalAudioDurationMs: number
  readonly totalInputCharacterCount: number
  readonly totalBillableCharacterCount: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A user turn's final transcript, recorded immediately before it becomes model input. */
    'speech-agent/transcript': SpeechAgentTranscriptMeta
    /** The complete generated text for one response generation — see {@link SpeechAgentResponseMeta}. */
    'speech-agent/response': SpeechAgentResponseMeta
    /** A TTS turn's billing and timing after it completed naturally (no barge-in). */
    'speech-agent/turn-completed': SpeechAgentTurnCompletedMeta
    /** Barge-in reconciliation for one cancelled TTS turn. */
    'speech-agent/turn-interrupted': SpeechAgentTurnInterruptedMeta
    /** Cumulative TTS session totals, recorded once before the transport closes. */
    'speech-agent/session-completed': SpeechAgentSessionCompletedMeta
  }
}

/**
 * Wrap a consumer's {@link TurnControllerHandlers} so every reconciliation-
 * relevant callback appends its durable `speech-agent/*` event to `session`
 * before delegating. Pure: takes no ownership of `session` or `handlers`, and
 * every other callback (`onStateChange`, `onAssistantTextDelta`, `onAudio`,
 * `onHaltPlayback`, `onWarning`, `onError`) passes through unchanged, since
 * those carry no model-visible or durable fact of their own.
 * @param session - the session to append `speech-agent/*` events to.
 * @param handlers - the consumer's own handlers; called after the matching append.
 * @returns a new handlers object suitable for {@link TurnControllerOptions.handlers}.
 */
export function withSessionLogging(session: Session, handlers: TurnControllerHandlers): TurnControllerHandlers {
  return {
    ...handlers,
    onTranscript(turn, generation) {
      session.append('speech-agent/transcript', {
        generation,
        turnIndex: turn.turnIndex,
        transcript: turn.transcript,
        endOfTurnConfidence: turn.endOfTurnConfidence,
      })
      handlers.onTranscript(turn, generation)
    },
    onResponseGenerated(generation, text) {
      session.append('speech-agent/response', { generation, text })
      handlers.onResponseGenerated(generation, text)
    },
    onTurnCompleted(event, generation) {
      session.append('speech-agent/turn-completed', {
        generation,
        turnId: event.turnId,
        audioDurationMs: event.audioDurationMs,
        inputCharacterCount: event.inputCharacterCount,
        billableCharacterCount: event.billableCharacterCount,
      })
      handlers.onTurnCompleted?.(event, generation)
    },
    onSpeechInterrupted(event, generation) {
      session.append('speech-agent/turn-interrupted', {
        generation,
        turnId: event.metrics.turnId,
        audioPlayedMs: event.audioPlayedMs,
        ...event.textSpoken === undefined ? {} : { textSpoken: event.textSpoken },
        ...event.textRemaining === undefined ? {} : { textRemaining: event.textRemaining },
        audioDurationMs: event.metrics.audioDurationMs,
        inputCharacterCount: event.metrics.inputCharacterCount,
        billableCharacterCount: event.metrics.billableCharacterCount,
      })
      handlers.onSpeechInterrupted(event, generation)
    },
  }
}

/**
 * Append the cumulative `speech-agent/session-completed` event. Not part of
 * {@link withSessionLogging} because `TtsSessionCompletedEvent` is consumed at
 * the transport level (a {@link TurnController} caller's own `tts.events` loop
 * or close path), not through {@link TurnControllerHandlers}.
 * @param session - the session to append to.
 * @param totals - the TTS provider's reported cumulative totals.
 */
export function logSessionCompleted(
  session: Session,
  totals: SpeechAgentSessionCompletedMeta,
): void {
  session.append('speech-agent/session-completed', totals)
}
