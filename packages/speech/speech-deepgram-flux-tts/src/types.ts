/**
 * Wire types for Deepgram Flux TTS's `/v2/speak` WebSocket protocol.
 * Reference: https://developers.deepgram.com/reference/text-to-speech-api/speak-flux
 * — current as of this package's writing. Flux TTS requires `/v2/speak` with
 * a `flux-{voice}-{lang}` model string; an Aura model string is REJECTED on
 * `/v2/speak` (Aura lives only on `/v1/speak`, which this package never uses).
 * @module @deepseek-ai/dsh-speech-deepgram-flux-tts/types
 */

/** Per-turn control-application counts, shared by `SpeechMetadata` and `SpeechInterrupted.metadata`. */
export interface FluxControlsApplied {
  readonly pronunciations_applied: number
  readonly breaks_applied: number
  readonly pronunciation_warnings: number
}

/** Sent once, immediately after the WebSocket handshake completes. */
export interface FluxTtsConnectedMessage {
  readonly type: 'Connected'
  readonly request_id: string
  readonly model_name: string
  readonly model_version?: string
  readonly model_uuids?: readonly string[]
}

/** Sent once at the start of a new turn, before its audio. */
export interface FluxSpeechStartedMessage {
  readonly type: 'SpeechStarted'
  readonly speech_id: string
}

/** Per-turn billing and timing, sent after a manual `Flush` fully drains that turn's audio. */
export interface FluxSpeechMetadataMessage {
  readonly type: 'SpeechMetadata'
  readonly speech_id: string
  readonly audio_duration_ms: number
  readonly input_character_count: number
  readonly billable_character_count: number
  readonly controls_applied?: FluxControlsApplied
}

/** Reply to a client `Interrupt`: what the listener heard, and the interrupted turn's billing. */
export interface FluxSpeechInterruptedMessage {
  readonly type: 'SpeechInterrupted'
  readonly audio_played_ms: number
  readonly text_spoken?: string
  readonly text_remaining?: string
  readonly metadata: {
    readonly speech_id: string
    readonly audio_duration_ms: number
    readonly input_character_count: number
    readonly billable_character_count: number
    readonly controls_applied?: FluxControlsApplied
  }
}

/** Echo confirming receipt of a client `Flush`. */
export interface FluxFlushedMessage {
  readonly type: 'Flushed'
  readonly speech_id: string
}

/** Cumulative session totals, sent once immediately before the socket closes. */
export interface FluxSessionMetadataMessage {
  readonly type: 'SessionMetadata'
  readonly total_audio_duration_ms: number
  readonly total_input_character_count: number
  readonly total_billable_character_count: number
}

/** Confirms a client `Configure` was accepted; echoes the configuration now in effect. */
export interface FluxConfigureSuccessMessage {
  readonly type: 'ConfigureSuccess'
  readonly applied: { readonly speed?: number }
}

/** Rejects a client `Configure`; the prior configuration is retained. */
export interface FluxConfigureFailureMessage {
  readonly type: 'ConfigureFailure'
  readonly code: string
  readonly description: string
  readonly field?: string
  readonly value?: unknown
}

/** A non-fatal notice; synthesis continues and the connection is unaffected. */
export interface FluxTtsWarningMessage {
  readonly type: 'Warning'
  readonly code: string
  readonly description: string
}

/** A fatal error; always followed by the WebSocket closing. */
export interface FluxTtsFatalErrorMessage {
  readonly type: 'Error'
  readonly code: string
  readonly description: string
}

/** Any server-to-client JSON text frame on `/v2/speak`; raw audio arrives as separate binary frames. */
export type FluxTtsServerMessage =
  | FluxTtsConnectedMessage
  | FluxSpeechStartedMessage
  | FluxSpeechMetadataMessage
  | FluxSpeechInterruptedMessage
  | FluxFlushedMessage
  | FluxSessionMetadataMessage
  | FluxConfigureSuccessMessage
  | FluxConfigureFailureMessage
  | FluxTtsWarningMessage
  | FluxTtsFatalErrorMessage

/** Send text to be synthesized into the active turn (starts one if none is active). */
export interface FluxSpeakMessage {
  readonly type: 'Speak'
  readonly text: string
}

/** End the active turn and generate its remaining audio. */
export interface FluxFlushMessage {
  readonly type: 'Flush'
}

/** Cancel the active turn because the caller detected barge-in. */
export interface FluxInterruptMessage {
  readonly type: 'Interrupt'
  /** Present only when the caller supplied a playback offset. */
  readonly playback_offset?: { readonly type: 'time_ms'; readonly value: number }
}

/** Update synthesis configuration mid-session. */
export interface FluxTtsConfigureMessage {
  readonly type: 'Configure'
  readonly speed?: number
}

/** Gracefully close the connection, draining all remaining and queued audio. */
export interface FluxCloseMessage {
  readonly type: 'Close'
}

/** Any client-to-server JSON text frame on `/v2/speak`. */
export type FluxTtsClientControl =
  | FluxSpeakMessage
  | FluxFlushMessage
  | FluxInterruptMessage
  | FluxTtsConfigureMessage
  | FluxCloseMessage
