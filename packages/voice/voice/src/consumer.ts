/**
 * Durable session-log integration for {@link TurnController}: the `voice/*`
 * `SessionEventMap` vocabulary and a pure handler-wrapping helper that
 * appends one event per reconciliation-relevant callback before delegating to
 * a consumer's own {@link TurnControllerHandlers}. Kept out of the package's
 * main barrel (`./index.ts`) because it is the only module that needs
 * `@deepseek-ai/dsh-session`'s `Session` type; importing it is opt-in for a
 * consumer that logs, while a unit test of {@link TurnController} itself
 * never needs a session at all.
 * @module @deepseek-ai/dsh-voice/consumer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SpeechTurnId } from './brand.ts'
import type { TurnControllerHandlers } from './turn-controller.ts'

/** Durable record of one completed user turn, immediately before its transcript reaches the model as a `user/message`. */
export interface VoiceTranscriptMeta {
  readonly turnIndex: number
  readonly transcript: string
  readonly endOfTurnConfidence: number
}

/** Durable per-turn billing and timing for a TTS turn that completed naturally. */
export interface VoiceSpeechMetadataMeta {
  readonly turnId: SpeechTurnId
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/**
 * Durable barge-in reconciliation: the exact split between what the listener
 * heard (`textSpoken`) and what was cancelled (`textRemaining`) for one
 * interrupted TTS turn, plus that turn's billing and timing.
 */
export interface VoiceSpeechInterruptedMeta {
  readonly turnId: SpeechTurnId
  readonly audioPlayedMs: number
  readonly textSpoken?: string
  readonly textRemaining?: string
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/** Durable cumulative TTS session totals, recorded once before the transport closes. */
export interface VoiceSessionMetadataMeta {
  readonly totalAudioDurationMs: number
  readonly totalInputCharacterCount: number
  readonly totalBillableCharacterCount: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A user turn's final transcript, recorded immediately before it becomes a `user/message`. */
    'voice/transcript': VoiceTranscriptMeta
    /** A TTS turn's billing and timing after it completed naturally (no barge-in). */
    'voice/speech-metadata': VoiceSpeechMetadataMeta
    /** Barge-in reconciliation for one cancelled TTS turn. */
    'voice/speech-interrupted': VoiceSpeechInterruptedMeta
    /** Cumulative TTS session totals, recorded once before the transport closes. */
    'voice/session-metadata': VoiceSessionMetadataMeta
  }
}

/**
 * Wrap a consumer's {@link TurnControllerHandlers} so every reconciliation-
 * relevant callback appends its durable `voice/*` event to `session` before
 * delegating. Pure: takes no ownership of `session` or `handlers`, and every
 * other callback (`onStateChange`, `onAssistantTextDelta`, `onAudio`,
 * `onHaltPlayback`, `onWarning`, `onError`) passes through unchanged, since
 * those carry no model-visible or durable fact of their own.
 * @param session - the session to append `voice/*` events to.
 * @param handlers - the consumer's own handlers; called after the matching append.
 * @returns a new handlers object suitable for {@link TurnControllerOptions.handlers}.
 */
export function withSessionLogging(session: Session, handlers: TurnControllerHandlers): TurnControllerHandlers {
  return {
    ...handlers,
    onTranscript(turn) {
      session.append('voice/transcript', {
        turnIndex: turn.turnIndex,
        transcript: turn.transcript,
        endOfTurnConfidence: turn.endOfTurnConfidence,
      })
      handlers.onTranscript(turn)
    },
    onTurnCompleted(event) {
      session.append('voice/speech-metadata', {
        turnId: event.turnId,
        audioDurationMs: event.audioDurationMs,
        inputCharacterCount: event.inputCharacterCount,
        billableCharacterCount: event.billableCharacterCount,
      })
      handlers.onTurnCompleted?.(event)
    },
    onSpeechInterrupted(event) {
      session.append('voice/speech-interrupted', {
        turnId: event.metrics.turnId,
        audioPlayedMs: event.audioPlayedMs,
        ...event.textSpoken === undefined ? {} : { textSpoken: event.textSpoken },
        ...event.textRemaining === undefined ? {} : { textRemaining: event.textRemaining },
        audioDurationMs: event.metrics.audioDurationMs,
        inputCharacterCount: event.metrics.inputCharacterCount,
        billableCharacterCount: event.metrics.billableCharacterCount,
      })
      handlers.onSpeechInterrupted(event)
    },
  }
}

/**
 * Append the cumulative `voice/session-metadata` event. Not part of
 * {@link withSessionLogging} because {@link TtsSessionCompletedEvent} is
 * consumed at the transport level (a {@link TurnController} caller's own
 * `tts.events` loop or close path), not through {@link TurnControllerHandlers}.
 * @param session - the session to append to.
 * @param totals - the TTS provider's reported cumulative totals.
 */
export function logSessionMetadata(
  session: Session,
  totals: VoiceSessionMetadataMeta,
): void {
  session.append('voice/session-metadata', totals)
}
