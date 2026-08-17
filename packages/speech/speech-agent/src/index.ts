/**
 * Durable speech-agent orchestration Consumer for the `ctx.speech`
 * (`@deepseek-ai/dsh-speech`) capability seam: a turn-taking engine that
 * finalizes STT turns, streams Harness LLM (`@deepseek-ai/dsh-llm`) output
 * directly into an open TTS session, and reconciles barge-in against the
 * provider's exact `textSpoken`/`textRemaining` split.
 *
 * This barrel exports only the Cordis- and session-log-free engine
 * ({@link SpeechAgentController}, {@link PlaybackClock},
 * {@link AsyncEventQueue}) so a unit test — or an embedding host with no
 * `@deepseek-ai/dsh-session` dependency at all — can use it without pulling
 * in the session or LLM integration modules. Durable history
 * (`./session-log.ts`, generated-vs-heard reconciliation) and the live
 * `ctx.llm` binding (`./llm-responder.ts`) are separate opt-in subpath
 * exports for exactly that reason.
 * @module @deepseek-ai/dsh-speech-agent
 */

export { AsyncEventQueue } from './async-event-queue.ts'
export { PlaybackClock } from './playback-clock.ts'
export { SpeechAgentController } from './controller.ts'
export type {
  SpeechAgentTurnCompleted,
  SpeechAgentTurnInterrupted,
  TurnControllerHandlers,
  TurnControllerOptions,
  TurnState,
} from './controller.ts'
