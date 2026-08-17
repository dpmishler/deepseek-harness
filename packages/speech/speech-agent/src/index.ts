/**
 * `@deepseek-ai/dsh-speech-agent`: barge-in-aware turn orchestration over the
 * speech capability seam (`ctx.speech`) and `ctx.llm`. A library, not a
 * mounted Cordis plugin — `TurnController` accepts already-open
 * `SttSession`/`TtsSession` values and has no `ctx` key of its own; a
 * consumer opens the sessions (`ctx.speech.openStt()`/`openTts()`), drives an
 * `ctx.llm.stream()` call through `respond`, and optionally wires
 * `./consumer.ts`'s `withSessionLogging` for durable `speech-agent/*` events.
 * @module @deepseek-ai/dsh-speech-agent
 */

export { SpeechAgentError } from './error.ts'
export { PlaybackClock } from './playback-clock.ts'
export { TurnController } from './turn-controller.ts'
export type { TurnControllerHandlers, TurnControllerOptions, TurnState } from './turn-controller.ts'
