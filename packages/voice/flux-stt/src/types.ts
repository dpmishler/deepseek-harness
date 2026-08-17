/**
 * Deepgram Flux STT /v2/listen wire-protocol types.
 * These are adapter-internal types; consumers see only the normalized
 * `SttEvent` vocabulary from `@deepseek-ai/dsh-voice`.
 * @module @deepseek-ai/dsh-flux-stt/types
 */

// ── Server → client messages ──────────────────────────────────────────────────

/** One word in a turn transcript, as the Deepgram API delivers it. */
export interface ListenV2Word {
  word: string
  confidence: number
  start: number
  end: number
}

/** Emitted once, immediately after the WebSocket session is accepted. */
export interface ListenV2Connected {
  type: 'Connected'
  request_id: string
  sequence_id: number
}

/**
 * Turn-detection event. `event: 'EndOfTurn'` is a confirmed, final turn;
 * `event: 'EagerEndOfTurn'` is a speculative early completion the session may
 * retract; `event: 'TurnResumed'` retracts an earlier `EagerEndOfTurn`.
 */
export interface ListenV2TurnInfo {
  type: 'TurnInfo'
  request_id: string
  sequence_id: number
  event: 'EndOfTurn' | 'EagerEndOfTurn' | 'TurnResumed'
  turn_index: number
  audio_window_start: number
  audio_window_end: number
  transcript: string
  words: ListenV2Word[]
  end_of_turn_confidence: number
  languages?: string[]
}

/** Partial recognition result (interim or final). */
export interface ListenV2Results {
  type: 'Results'
  request_id: string
  sequence_id: number
  channel: {
    alternatives: Array<{
      transcript: string
      confidence: number
      words: ListenV2Word[]
    }>
  }
  is_final: boolean
  speech_final: boolean
}

/** A fatal, server-originated error. The connection closes after this. */
export interface ListenV2Error {
  type: 'Error'
  code: string
  description: string
}

/** Any server-sent JSON text frame. */
export type ListenV2ServerMessage =
  | ListenV2Connected
  | ListenV2TurnInfo
  | ListenV2Results
  | ListenV2Error

// ── Client → server messages ──────────────────────────────────────────────────

/** Update turn-detection configuration without disconnecting. */
export interface ListenV2Configure {
  type: 'Configure'
  thresholds?: {
    eot_threshold?: number
    eager_eot_threshold?: number
    eot_timeout_ms?: number
  }
  keyterms?: string[]
}

/** Gracefully close the stream; the server emits final transcription. */
export interface ListenV2CloseStream {
  type: 'CloseStream'
}

/** Any client-sent JSON text frame. */
export type ListenV2ClientMessage = ListenV2Configure | ListenV2CloseStream
