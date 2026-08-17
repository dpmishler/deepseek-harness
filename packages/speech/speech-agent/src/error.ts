/**
 * Typed error for `@deepseek-ai/dsh-speech-agent`'s own orchestration
 * invariants — distinct from `@deepseek-ai/dsh-speech`'s `SpeechError`, which
 * owns the capability seam's provider-dispatch and session-lifecycle codes.
 * @module @deepseek-ai/dsh-speech-agent/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Typed speech-agent error. `code` is machine-routable:
 * - `INVALID_PLAYBACK_PROGRESS` — `PlaybackClock.advance()` received a negative or non-finite value.
 */
export class SpeechAgentError extends HarnessError {}
