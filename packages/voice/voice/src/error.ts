/**
 * Typed error for the voice capability seam (`ctx.voice`) and every session it
 * opens.
 * @module @deepseek-ai/dsh-voice/error
 */

/**
 * Error raised by `ctx.voice` and its STT/TTS sessions. `code` is a stable,
 * provider-neutral machine code; route on it, never on `message`. The
 * registry itself throws `VOICE_INVALID_PROVIDER`, `VOICE_DUPLICATE_PROVIDER`,
 * and `VOICE_PROVIDER_NOT_REGISTERED`. Session implementations share the
 * generic `SESSION_CLOSED` for a call after close, plus their own transport
 * and protocol codes (for example a Deepgram Flux provider's `PROTOCOL_ERROR`
 * or `WS_CLOSE_1006`).
 */
export class VoiceError extends Error {
  /** Stable machine-routable failure class. */
  readonly code: string

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable machine code.
   * @param options - optional `cause` chaining.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    if (message.length === 0) throw new Error('VoiceError message must be a non-empty string')
    if (code.length === 0) throw new Error('VoiceError code must be a non-empty string')
    super(message, options)
    this.name = 'VoiceError'
    this.code = code
  }
}
