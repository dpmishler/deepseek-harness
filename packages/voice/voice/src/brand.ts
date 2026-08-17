/**
 * dsh-voice's owned branded ids: cross-boundary correlation identifiers for
 * the speech capability seam.
 *
 * The `Branded<B>` primitive itself lives in `@deepseek-ai/dsh-brand` (a
 * zero-dependency type-only package) so every owner of a cross-boundary id can
 * brand it without depending on dsh-voice; see that package's README for the
 * nominal-typing policy.
 *
 * @module @deepseek-ai/dsh-voice/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Provider-assigned identifier for one open STT or TTS session, used to correlate logs and diagnostics. */
export type SpeechRequestId = Branded<'SpeechRequestId'>

/**
 * Brand a string as a {@link SpeechRequestId}.
 * @param id - the provider-issued request identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function SpeechRequestId(id: string): SpeechRequestId {
  return id as SpeechRequestId
}

/** Provider-assigned identifier for one TTS turn (a Deepgram Flux "speech") within an open session. */
export type SpeechTurnId = Branded<'SpeechTurnId'>

/**
 * Brand a string as a {@link SpeechTurnId}.
 * @param id - the provider-issued turn identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function SpeechTurnId(id: string): SpeechTurnId {
  return id as SpeechTurnId
}
