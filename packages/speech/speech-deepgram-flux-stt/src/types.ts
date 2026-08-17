/**
 * Wire types for Deepgram Flux STT's `/v2/listen` WebSocket protocol.
 * Reference: https://developers.deepgram.com/reference/speech-to-text-api/listen-flux
 * and https://developers.deepgram.com/docs/flux/quickstart — current as of
 * this package's writing. Flux requires `/v2/listen`; the legacy `/v1/listen`
 * message names (`Results`, `SpeechStarted`, `UtteranceEnd`, `Metadata`) do
 * NOT apply here.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-stt/types
 */

/** One recognized word inside a Flux `TurnInfo` transcript. */
export interface FluxWord {
  readonly word: string
  readonly confidence: number
  readonly start: number
  readonly end: number
}

/** How one `TurnInfo` message relates to Flux's turn-detection state machine. */
export type FluxTurnEvent = 'Update' | 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn'

/** Sent once, immediately after the WebSocket handshake completes. */
export interface FluxConnectedMessage {
  readonly type: 'Connected'
  readonly request_id: string
  readonly sequence_id?: number
}

/**
 * The one transcription/turn-detection message shape; `event` discriminates
 * interim progress from the turn-boundary transitions.
 */
export interface FluxTurnInfoMessage {
  readonly type: 'TurnInfo'
  readonly request_id?: string
  readonly sequence_id?: number
  readonly event: FluxTurnEvent
  readonly turn_index: number
  readonly audio_window_start: number
  readonly audio_window_end: number
  readonly transcript: string
  readonly words: readonly FluxWord[]
  readonly end_of_turn_confidence: number
  /** Present only for `flux-general-multi`: detected languages by share of the turn. */
  readonly languages?: readonly string[]
  /** Present only for `flux-general-multi`: the active language hints. */
  readonly languages_hinted?: readonly string[]
}

/** A fatal server error; always followed by the WebSocket closing. */
export interface FluxFatalErrorMessage {
  readonly type: 'Error'
  readonly sequence_id?: number
  readonly code: string
  readonly description: string
}

/** Nested threshold fields shared by the client `Configure` message and its `ConfigureSuccess` echo. */
export interface FluxThresholds {
  readonly eot_threshold?: number
  readonly eager_eot_threshold?: number
  readonly eot_timeout_ms?: number
}

/** Reply confirming a client `Configure` message was applied; echoes the resulting configuration. */
export interface FluxConfigureSuccessMessage {
  readonly type: 'ConfigureSuccess'
  readonly request_id?: string
  readonly sequence_id?: number
  readonly thresholds?: FluxThresholds
  readonly keyterms?: readonly string[]
  readonly language_hints?: readonly string[]
}

/** Reply rejecting a client `Configure` message; the stream keeps its prior configuration. */
export interface FluxConfigureFailureMessage {
  readonly type: 'ConfigureFailure'
  readonly request_id?: string
  readonly sequence_id?: number
  readonly code?: string
  readonly description?: string
}

/** Any server-to-client JSON text frame on `/v2/listen`. */
export type FluxSttServerMessage =
  | FluxConnectedMessage
  | FluxTurnInfoMessage
  | FluxFatalErrorMessage
  | FluxConfigureSuccessMessage
  | FluxConfigureFailureMessage

/** Client request to close the stream gracefully. */
export interface FluxCloseStreamMessage {
  readonly type: 'CloseStream'
}

/** Client request to update turn-detection thresholds, keyterms, or language hints mid-stream. */
export interface FluxConfigureMessage {
  readonly type: 'Configure'
  readonly thresholds?: FluxThresholds
  readonly keyterms?: readonly string[]
  readonly language_hints?: readonly string[] | null
}

/** Any client-to-server JSON text frame on `/v2/listen`; raw audio is sent as separate binary frames. */
export type FluxSttClientControl = FluxCloseStreamMessage | FluxConfigureMessage
