/**
 * Durable session-log integration for {@link SpeechAgentController}: the
 * `speech-agent/*` `SessionEventMap` vocabulary, a handler-wrapping helper
 * that appends one event per reconciliation-relevant callback, and the
 * generated-vs-heard history projection that turns those durable events back
 * into `@deepseek-ai/dsh-llm` `Message`s for the next request.
 *
 * Kept out of the package's main barrel (`./index.ts`) because it is the
 * only module that needs `@deepseek-ai/dsh-session`'s `Session` type;
 * importing it is opt-in for a consumer that logs, while a unit test of
 * {@link SpeechAgentController} itself never needs a session at all.
 * @module @deepseek-ai/dsh-speech-agent/session-log
 */

import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { SpeechAgentTurnCompleted, SpeechAgentTurnInterrupted, TurnControllerHandlers } from './controller.ts'

/** Durable record of one completed user turn, immediately before its transcript reaches {@link TurnControllerOptions.respond}. */
export interface SpeechAgentTurnTranscriptMeta {
  readonly turnIndex: number
  readonly transcript: string
  readonly endOfTurnConfidence: number
}

/**
 * Durable generated-vs-heard reconciliation for one assistant response.
 * `generatedText` is everything the LLM produced for this response, whether
 * or not the listener heard all of it; `heardText`/`remainingText` are the
 * exact split a barge-in's `textSpoken`/`textRemaining` established.
 * `interrupted: false` always carries `heardText === generatedText` and no
 * `remainingText` — the response completed naturally.
 */
export interface SpeechAgentResponseReconciledMeta {
  readonly turnId: SpeechTurnId
  readonly generatedText: string
  readonly heardText: string
  readonly remainingText?: string
  readonly interrupted: boolean
  /** Milliseconds of session audio the listener had heard when a barge-in landed; absent for a natural completion. */
  readonly audioPlayedMs?: number
  readonly audioDurationMs: number
  readonly inputCharacterCount: number
  readonly billableCharacterCount: number
}

/** Durable cumulative TTS session totals, recorded once before the transport closes. */
export interface SpeechAgentSessionMetadataMeta {
  readonly totalAudioDurationMs: number
  readonly totalInputCharacterCount: number
  readonly totalBillableCharacterCount: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A user turn's final transcript, recorded immediately before it becomes the next `respond()` call's input. */
    'speech-agent/turn-transcript': SpeechAgentTurnTranscriptMeta
    /** Generated-vs-heard reconciliation for one assistant response, natural or barge-in-cancelled. */
    'speech-agent/response-reconciled': SpeechAgentResponseReconciledMeta
    /** Cumulative TTS session totals, recorded once before the transport closes. */
    'speech-agent/session-metadata': SpeechAgentSessionMetadataMeta
  }
}

/**
 * Wrap a consumer's {@link TurnControllerHandlers} so every reconciliation-
 * relevant callback appends its durable `speech-agent/*` event to `session`
 * before delegating. Pure: takes no ownership of `session` or `handlers`,
 * and every other callback (`onStateChange`, `onAssistantTextDelta`,
 * `onAudio`, `onHaltPlayback`, `onWarning`, `onError`) passes through
 * unchanged, since those carry no model-visible or durable fact of their own.
 * @param session - the session to append `speech-agent/*` events to.
 * @param handlers - the consumer's own handlers; called after the matching append.
 * @returns a new handlers object suitable for `TurnControllerOptions.handlers`.
 */
export function withSessionLogging(session: Session, handlers: TurnControllerHandlers): TurnControllerHandlers {
  return {
    ...handlers,
    onTranscript(turn) {
      session.append('speech-agent/turn-transcript', {
        turnIndex: turn.turnIndex,
        transcript: turn.transcript,
        endOfTurnConfidence: turn.endOfTurnConfidence,
      })
      handlers.onTranscript(turn)
    },
    onTurnCompleted(event: SpeechAgentTurnCompleted) {
      session.append('speech-agent/response-reconciled', {
        turnId: event.turnId,
        generatedText: event.generatedText,
        heardText: event.generatedText,
        interrupted: false,
        audioDurationMs: event.audioDurationMs,
        inputCharacterCount: event.inputCharacterCount,
        billableCharacterCount: event.billableCharacterCount,
      })
      handlers.onTurnCompleted?.(event)
    },
    onSpeechInterrupted(event: SpeechAgentTurnInterrupted) {
      session.append('speech-agent/response-reconciled', {
        turnId: event.metrics.turnId,
        generatedText: event.generatedText,
        heardText: event.heardText,
        interrupted: true,
        audioPlayedMs: event.audioPlayedMs,
        ...event.textRemaining === undefined ? {} : { remainingText: event.textRemaining },
        audioDurationMs: event.metrics.audioDurationMs,
        inputCharacterCount: event.metrics.inputCharacterCount,
        billableCharacterCount: event.metrics.billableCharacterCount,
      })
      handlers.onSpeechInterrupted(event)
    },
  }
}

/**
 * Append the cumulative `speech-agent/session-metadata` event. Not part of
 * {@link withSessionLogging} because a `TtsSession`'s cumulative
 * `session-completed` event is consumed at the transport level (a
 * {@link SpeechAgentController} caller's own `tts.events` loop or close
 * path), not through {@link TurnControllerHandlers}.
 * @param session - the session to append to.
 * @param totals - the TTS provider's reported cumulative totals.
 */
export function logSessionMetadata(session: Session, totals: SpeechAgentSessionMetadataMeta): void {
  session.append('speech-agent/session-metadata', totals)
}

/**
 * Project the durable `speech-agent/turn-transcript` /
 * `speech-agent/response-reconciled` stream into ordinary conversation
 * `Message`s, suitable for `GenerateOptions.messages` on the next
 * `ctx.llm.stream()` call. This is the generated-vs-heard history contract:
 * the assistant message content is always `heardText` — what the listener
 * actually heard — never `generatedText`, so a barge-in-truncated response
 * continues the conversation as the truncated utterance it actually was,
 * not as the fuller text the model happened to generate before being cut
 * off.
 *
 * Pairs each transcript with the next reconciliation event in log order;
 * a trailing transcript with no reconciliation yet (a response still in
 * flight) projects as a final user-only message. A reconciliation event
 * with no pending transcript (should not occur given
 * {@link SpeechAgentController}'s own call order) is skipped rather than
 * projected as an orphaned assistant turn.
 * @param session - the session whose `speech-agent/*` log to project.
 * @returns ordered user/assistant `Message`s covering every reconciled voice turn.
 */
export function projectConversationHistory(session: Session): Message[] {
  const messages: Message[] = []
  let pendingTranscript: string | undefined
  for (const event of session.events) {
    if (event.type === 'speech-agent/turn-transcript') {
      if (pendingTranscript !== undefined) {
        messages.push(createUserMessage({ content: [{ type: 'text', text: pendingTranscript }], source: { kind: 'user' } }))
      }
      pendingTranscript = event.data.transcript
    } else if (event.type === 'speech-agent/response-reconciled') {
      if (pendingTranscript === undefined) continue
      messages.push(createUserMessage({ content: [{ type: 'text', text: pendingTranscript }], source: { kind: 'user' } }))
      pendingTranscript = undefined
      messages.push(createAssistantMessage({
        content: [{ type: 'text', text: event.data.heardText }],
        source: { provider: 'speech-agent', model: 'speech-agent' },
      }))
    }
  }
  if (pendingTranscript !== undefined) {
    messages.push(createUserMessage({ content: [{ type: 'text', text: pendingTranscript }], source: { kind: 'user' } }))
  }
  return messages
}
