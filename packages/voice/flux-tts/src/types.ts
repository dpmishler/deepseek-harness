/**
 * Deepgram Flux TTS v2 (`/v2/speak`) wire protocol types, verbatim from
 * https://developers.deepgram.com/reference/text-to-speech-api/speak-flux.
 * Flux TTS lives only at `/v2/speak`; an Aura model string (or `/v1/speak`)
 * is a different product surface this provider never speaks.
 * @module @deepseek-ai/dsh-flux-tts/types
 */

/** `encoding` query parameter for the raw (non-containerized) streaming output. */
export type FluxTtsEncoding = 'linear16' | 'mulaw' | 'alaw'

/** Accepted `speed` values: `1.00` is the model's nominal rate, in `0.05` increments. */
export type FluxTtsSpeed = 0.85 | 0.90 | 0.95 | 1.00 | 1.05 | 1.10 | 1.15

/** Accepted `expressivity` values: `0` is the voice's tuned delivery; fixed for the connection. */
export type FluxTtsExpressivity = -2 | -1 | 0 | 1 | 2

/** Send text to be synthesized into the active turn. */
export interface SpeakV2Speak {
  readonly type: 'Speak'
  readonly text: string
}

/** End the active turn and generate the remaining audio. */
export interface SpeakV2Flush {
  readonly type: 'Flush'
}

/** Cancel the active turn because the user barged in. */
export interface SpeakV2Interrupt {
  readonly type: 'Interrupt'
  readonly playback_offset: {
    readonly type: 'time_ms'
    readonly value: number
  }
}

/** Update synthesis configuration mid-session. */
export interface SpeakV2Configure {
  readonly type: 'Configure'
  readonly speed: number
}

/** Gracefully close the connection, draining all remaining and queued audio. */
export interface SpeakV2Close {
  readonly type: 'Close'
}

/** Every JSON message a client can send to `/v2/speak` (binary audio never flows this direction). */
export type SpeakV2ClientMessage = SpeakV2Speak | SpeakV2Flush | SpeakV2Interrupt | SpeakV2Configure | SpeakV2Close

/** Received on a successful connection. */
export interface SpeakV2Connected {
  readonly type: 'Connected'
  readonly request_id: string
  readonly model_name: string
  readonly model_version: string
  readonly model_uuids: readonly string[]
}

/** Received marking the start of a new turn. */
export interface SpeakV2SpeechStarted {
  readonly type: 'SpeechStarted'
  readonly speech_id: string
}

/** Per-turn controls-applied counters shared by `SpeechMetadata` and `SpeechInterrupted`. */
export interface SpeakV2ControlsApplied {
  readonly pronunciations_applied: number
  readonly breaks_applied: number
  readonly pronunciation_warnings: number
}

/** Received with per-turn billing and timing after a manual `Flush`. */
export interface SpeakV2SpeechMetadata {
  readonly type: 'SpeechMetadata'
  readonly speech_id: string
  readonly audio_duration_ms: number
  readonly input_character_count: number
  readonly billable_character_count: number
  readonly controls_applied: SpeakV2ControlsApplied
}

/** Received after an `Interrupt`: what the user heard, and the interrupted turn's billing. */
export interface SpeakV2SpeechInterrupted {
  readonly type: 'SpeechInterrupted'
  readonly audio_played_ms: number
  readonly metadata: {
    readonly speech_id: string
    readonly audio_duration_ms: number
    readonly input_character_count: number
    readonly billable_character_count: number
    readonly controls_applied: SpeakV2ControlsApplied
  }
  readonly text_spoken: string
  readonly text_remaining: string
}

/** Received as an echo confirming receipt of a manual `Flush`. */
export interface SpeakV2Flushed {
  readonly type: 'Flushed'
  readonly speech_id: string
}

/** Received once with cumulative session totals before the socket closes. */
export interface SpeakV2SessionMetadata {
  readonly type: 'SessionMetadata'
  readonly total_audio_duration_ms: number
  readonly total_input_character_count: number
  readonly total_billable_character_count: number
}

/** Received confirming a `Configure` was accepted; echoes the applied configuration. */
export interface SpeakV2ConfigureSuccess {
  readonly type: 'ConfigureSuccess'
  readonly applied: {
    readonly speed?: number
  }
}

/** Received when a `Configure` was rejected or failed to apply; the prior configuration is retained. */
export interface SpeakV2ConfigureFailure {
  readonly type: 'ConfigureFailure'
  readonly code: string
  readonly description: string
  readonly field?: string
  readonly value?: unknown
}

/** Received as a warning; synthesis continues and the connection is unaffected. */
export interface SpeakV2Warning {
  readonly type: 'Warning'
  readonly code: string
  readonly description: string
}

/** Received as a fatal error, always followed by a WebSocket close. */
export interface SpeakV2Error {
  readonly type: 'Error'
  readonly code: string
  readonly description: string
}

/** Every JSON message `/v2/speak` can send (binary `SpeakV2Audio` frames are handled separately). */
export type SpeakV2ServerMessage =
  | SpeakV2Connected
  | SpeakV2SpeechStarted
  | SpeakV2SpeechMetadata
  | SpeakV2SpeechInterrupted
  | SpeakV2Flushed
  | SpeakV2SessionMetadata
  | SpeakV2ConfigureSuccess
  | SpeakV2ConfigureFailure
  | SpeakV2Warning
  | SpeakV2Error
