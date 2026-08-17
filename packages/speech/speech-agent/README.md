# @deepseek-ai/dsh-speech-agent

English | [中文](README.zh.md)

Barge-in-aware turn-taking orchestration over the speech capability seam (`ctx.speech`, from `@deepseek-ai/dsh-speech`) and the LLM capability (`ctx.llm`, from `@deepseek-ai/dsh-llm`). A **Consumer** in the [capability-seam](../../../docs/architecture.md#capability-seams) sense — it uses already-open `SttSession`/`TtsSession` values and an already-open LLM stream, and owns no service of its own (`ctx` key). This is a library, not a mounted Cordis plugin: a caller opens the sessions and wires `TurnController` directly.

## `TurnController`

`TurnController` drives one voice conversation end to end:

1. Pumps the open `SttSession.events`. A `completed` turn's transcript is reported (`onTranscript`) and starts a new **response generation** — `TurnController.respond(transcript, signal)` streams `@deepseek-ai/dsh-llm`'s `StreamChunk` vocabulary directly, so a real `respond` is `(transcript, signal) => ctx.llm.stream({ ...options, messages: [...history, userMessage(transcript)], signal })`.
2. Forwards every `text-delta` straight into the open `TtsSession.speak()` (`onAssistantTextDelta` echoes it for UI only) and calls `flush()` once the model's stream ends.
3. Pumps the open `TtsSession.events`, forwarding `audio` frames to `onAudio` and reporting `turn-completed`/`turn-interrupted` outcomes.
4. On barge-in — a fresh STT turn `started` while the controller is `thinking` or `speaking` — aborts the in-flight LLM call, halts playback (`onHaltPlayback`), and sends `TtsSession.interrupt()` with the session-wide playback offset.

### Barge-in cancellation and stale-audio suppression

Every response generation gets a monotonically increasing `generation` number. Barge-in bumps it and aborts the in-flight `respond()` call via `AbortSignal`; any `audio` frame that later arrives for a now-superseded generation (already in flight over the TTS WebSocket when `Interrupt` was sent) is dropped rather than reaching `onAudio` — see `TurnController.discardedFrameCount`. This is the propagation path: LLM generation, TTS synthesis, and playback all key off the same generation counter, so one cancellation invalidates all three without a race between them.

### Session-wide playback offsets

Flux TTS's `Interrupt.playback_offset` is one clock for the whole session, not per turn, and each interrupt's offset must strictly exceed the previous one — a non-advancing offset is ignored with an `INVALID_INTERRUPT_OFFSET` warning. `PlaybackClock` owns that counter: a caller driving real audio output calls `TurnController.reportPlayed(ms)` as frames are actually rendered (not merely received), and `bargeIn()` reads `PlaybackClock.consumeInterruptOffsetMs()` to get the next valid offset — which is `undefined` when the clock has not advanced since the last interrupt (for example, two barge-ins during the same `thinking` phase, before any audio played). `TurnController` then calls `interrupt()` with no argument in that case: the turn is still cancelled, but the reply omits `textSpoken`/`textRemaining`.

### Generated-vs-heard reconciliation

`onResponseGenerated(generation, text)` fires exactly once per generation with the complete text the model produced — the full text when the response flushed naturally, or whatever had streamed so far when a barge-in superseded it before flush. Compare it against the matching `onSpeechInterrupted` reply's `textSpoken`/`textRemaining` (Flux TTS's own split of what the listener heard from what was cancelled, joined by the same `generation`) to reconcile exactly what reached the listener. `withSessionLogging` (see below) makes both halves durable so this reconciliation survives a replay.

## `./consumer.ts`: durable session-log integration

`withSessionLogging(session, handlers)` wraps a caller's `TurnControllerHandlers` so every reconciliation-relevant callback appends its durable event to a `@deepseek-ai/dsh-session` `Session` before delegating:

| Event | From | Carries |
|---|---|---|
| `speech-agent/transcript` | `onTranscript` | `generation`, `turnIndex`, `transcript`, `endOfTurnConfidence` |
| `speech-agent/response` | `onResponseGenerated` | `generation`, `text` — the "generated" half of reconciliation |
| `speech-agent/turn-completed` | `onTurnCompleted` | `generation`, `turnId`, and `TtsTurnMetrics` |
| `speech-agent/turn-interrupted` | `onSpeechInterrupted` | `generation`, `turnId`, `audioPlayedMs`, `textSpoken`/`textRemaining` — the "heard" half — and `TtsTurnMetrics` |

`logSessionCompleted(session, totals)` appends `speech-agent/session-completed` (cumulative totals) separately, since `TtsSessionCompletedEvent` is consumed at the transport level (a caller's own `tts.events` loop or close path), not through `TurnControllerHandlers`.

Kept out of the package's main barrel (`./index.ts`) because it is the only module that needs `@deepseek-ai/dsh-session`'s `Session` type; a unit test of `TurnController` itself never needs a session at all, matching the [session-log-free design](#turncontroller) above.

`./invariant.ts` checks the durable relationships these events establish across a session's whole log: `speech-agent/transcript` generations strictly increase, `speech-agent/turn-interrupted` `audioPlayedMs` never decreases (mirroring `PlaybackClock`'s own monotonic contract), and — when both are present for the same `generation` — `textSpoken + textRemaining` reconstructs the matching `speech-agent/response` text verbatim.

## Model Experience

None, as `TurnController` only orchestrates already-open STT/TTS sessions and forwards whatever transcript or response text its caller supplies through `respond`; it builds no system prompt or tool schema of its own — those belong to whatever `ctx.llm.stream()` call the caller's `respond` makes.

#### KV Cache effect

Not applicable: this package makes no model request of its own.

## Known Limitations and Deferred Work

- **No eager/speculative response generation** — `TurnController` only starts a response on a confirmed `completed` STT turn; Flux STT's `eager-completed`/`resumed` events (opt-in `eagerEndOfTurn` config) are seam-level vocabulary this package deliberately does not act on yet, trading the latency benefit for never having to retract a speculative response.
- **Barge-in detection is STT-only** — the controller treats a fresh STT `started` event as the sole barge-in signal, per Deepgram's own recommended pattern; a caller wanting a local VAD/energy-based trigger in addition must call the equivalent of `bargeIn()` itself (not currently exposed as a public method).
- **No reconnect or multi-channel merge** — one `TurnController` drives exactly one STT session and one TTS session for the life of one conversation; reconnection after an unexpected transport close and merging multiple audio participants are both caller-owned, not part of this package.
- **No audio I/O** — `TurnController` never touches a microphone, speaker, or audio file; a caller supplies raw audio to `SttSession.sendAudio()`, renders `onAudio` chunks to its own sink, and reports playback progress through `reportPlayed()`.
