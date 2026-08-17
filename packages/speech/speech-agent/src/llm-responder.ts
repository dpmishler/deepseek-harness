/**
 * Binds `@deepseek-ai/dsh-speech-agent`'s wire-neutral
 * `TurnControllerOptions.respond` signature to a live `ctx.llm`
 * (`LlmRuntime`, `@deepseek-ai/dsh-llm`) — the "streams Harness LLM output
 * directly to TTS" integration point. Kept out of `./index.ts`'s main
 * barrel for the same reason as `./session-log.ts`: it is the only module
 * that needs a live `LlmRuntime` instance, while {@link SpeechAgentController}
 * itself stays testable against a hand-written `respond()` with no Cordis
 * context at all.
 * @module @deepseek-ai/dsh-speech-agent/llm-responder
 */

import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Options `createLlmResponder` needs beyond the transcript and cancellation signal `respond()` already receives. */
export type SpeechAgentRequestOptions = Omit<GenerateOptions, 'signal'>

/**
 * Build one `respond()` implementation suitable for
 * `TurnControllerOptions.respond`, forwarding every text delta from a real
 * `ctx.llm.stream()` call and propagating barge-in cancellation into the
 * provider request via `signal`.
 * @param llm - the live LLM runtime to call.
 * @param buildRequest - produce the full request for one completed user
 *   transcript; typically folds `projectConversationHistory()`
 *   (`./session-log.ts`) plus the new transcript into `messages`.
 * @returns a `respond()` function that streams the model's reply straight
 *   from `ctx.llm` into whatever consumes its `StreamChunk`s (a
 *   `SpeechAgentController`'s `tts.speak()` calls, for the intended use).
 */
export function createLlmResponder(
  llm: LlmRuntime,
  buildRequest: (transcript: string) => SpeechAgentRequestOptions,
): (transcript: string, signal: AbortSignal) => AsyncIterable<StreamChunk> {
  return (transcript, signal) => llm.stream({ ...buildRequest(transcript), signal })
}
