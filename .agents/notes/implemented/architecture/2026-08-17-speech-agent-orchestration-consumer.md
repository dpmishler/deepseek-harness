# Agent Note: speech-agent orchestration Consumer for ctx.speech

Status: implemented

English | [中文](2026-08-17-speech-agent-orchestration-consumer.zh.md)

## Problem

`@deepseek-ai/dsh-speech` (the `ctx.speech` capability seam) and its Deepgram Flux STT/TTS provider adapters shipped as a foundation slice with an explicitly documented gap: "no model-facing tool or voice-agent Consumer is wired yet". Opening STT/TTS sessions is usable only from ad hoc plugin code; nothing drives a full turn-taking conversation — finalizing a user's STT turn, streaming the Harness LLM's reply straight into TTS, and reconciling a barge-in against the provider's exact `textSpoken`/`textRemaining` split.

A prior attempt at this orchestration layer (`packages/voice/*`, commit `33dbd22972`) was reverted (`e59b02d46f`) because it duplicated `ctx.speech` as a second, competing `ctx.voice` capability seam instead of consuming the wired one, and its own tests carried two classes of defect: a `for await` pump loop test that never called `queue.end()` on its fake sessions before awaiting `controller.run()`'s settlement (a genuine test-side deadlock, not a library bug, that surfaced as a 5-second Vitest timeout), and three `VoiceRuntime`-dispatch tests asserting an error contract the registry never implemented.

## Decision

`@deepseek-ai/dsh-speech-agent` (`packages/speech/speech-agent`) is the Consumer role for the existing `ctx.speech` seam — it registers no competing capability and imports `SttSession`/`TtsSession`/`SpeechError` directly from `@deepseek-ai/dsh-speech`. It ships four independently importable pieces:

- **`SpeechAgentController`** (main barrel): a Cordis- and session-log-free turn state machine (`idle`/`listening`/`thinking`/`speaking`) that pumps one open `SttSession` and one open `TtsSession`. A completed STT turn calls a caller-supplied `respond(transcript, signal): AsyncIterable<StreamChunk>` and forwards every `text-delta` into `tts.speak()`, then `tts.flush()`. A fresh STT turn starting while `thinking`/`speaking` is barge-in: it aborts `respond()` via `signal`, calls `onHaltPlayback()`, and sends `tts.interrupt(playbackClock.elapsedMs)`.
- **`PlaybackClock`**: the session-wide monotonic "milliseconds of audio actually heard" counter `TtsSession.interrupt()` requires (each call's offset must exceed the previous one).
- **Stale-audio suppression**: an internal generation counter bumps on every barge-in; a TTS `audio` event whose turn belongs to a superseded generation increments `discardedFrameCount` instead of reaching `onAudio()`.
- **Generated-vs-heard reconciliation**: the controller accumulates each response's `text-delta` chunks per generation. A natural `turn-completed` reports the full `generatedText`; a `turn-interrupted` reports `generatedText` alongside `heardText` (the provider's `textSpoken`, falling back to `generatedText` only if the provider omitted it) and `remainingText`.
- **`./session-log` (opt-in subpath)**: `withSessionLogging(session, handlers)` appends durable `speech-agent/turn-transcript` and `speech-agent/response-reconciled` `SessionEventMap` events (declaration-merged into `@deepseek-ai/dsh-session`'s map); `projectConversationHistory(session)` folds that log back into ordinary `Message`s for the next request, using `heardText` — never `generatedText` — as the assistant content. This is the generated-vs-heard *durable history* contract: a barge-in-truncated response continues the conversation as the truncated utterance it actually was.
- **`./llm-responder` (opt-in subpath)**: `createLlmResponder(llm, buildRequest)` binds `respond()`'s signature to a live `LlmRuntime.stream()`, forwarding the caller's `AbortSignal` onto `GenerateOptions.signal` so barge-in cancels the real provider request, not just local consumption — "streams Harness LLM output directly to TTS" concretely.

Both durable-log and `ctx.llm` integration stay separate module exports (not the main barrel) so a unit test of the controller itself needs neither `@deepseek-ai/dsh-session` nor a live `LlmRuntime`, matching the reverted design's own stated rationale.

The package's `./invariant` companion checks that `speech-agent/turn-transcript.turnIndex` strictly increases within one session (mirrors the reverted `dsh-voice` companion, adjusted to the new event names).

Workspace defect fixed in the same change: `tsconfig.base.json` still listed `./packages/voice/*/src` and `./packages/voice/*/src/invariant.ts` in the `@deepseek-ai/dsh-*` path wildcard and invariant-glob after the `packages/voice` directory was deleted by the revert — a dangling glob entry pointing at a nonexistent directory. Removed both; `tsconfig.host.json` gained the new package's project reference.

## Alternatives considered

**Reviving `packages/voice/*` wholesale.** Rejected for the same reason the original revert gave: it would re-introduce a second, competing capability seam (`ctx.voice` alongside the wired `ctx.speech`) rather than consuming the one `tsconfig.base.json`'s pre-existing wildcard and the rest of the tree already wire.

**Fixing the reverted test suite in place and re-landing `packages/voice`.** Considered, but the reverted tree's own `VoiceRuntime` duplicated `SpeechRuntime`'s provider-registry logic (register/list/open, duplicate-id and not-registered errors) with a different error-code namespace; carrying it forward would leave two registries for one capability. The orchestration engine, playback clock, and async queue design were sound and are reused near-verbatim, retargeted at `@deepseek-ai/dsh-speech`'s existing types.

**One durable event per outcome (separate `turn-completed`/`turn-interrupted` event types), matching the reverted design exactly.** Rejected in favor of one `speech-agent/response-reconciled` event carrying an `interrupted: boolean` discriminant: both outcomes are the same fact — "this response ended; here is what was generated and what was heard" — and a single event type gives `projectConversationHistory` one query instead of two, and the invariant/history-projection code one shape to fold instead of a union.

**A fixed fabricated `provider`/`model` naming the original LLM call in a projected assistant message's `source`.** `AssistantMessage.source` requires `ModelMessageSource` (`kind: 'model'` plus `provider`/`model`), but the controller's `respond()` signature is deliberately opaque to which route produced a chunk, and durable `speech-agent/response-reconciled` events do not record it either. Inventing an attribution would misrepresent a reconstructed message as a real provider replay (implying `replayState` compatibility it does not have). The projection uses a fixed `{ provider: 'speech-agent', model: 'speech-agent' }` sentinel instead, documented as intentional.

**Building the runnable demo as a new `examples/<leaf>/run.ts` script.** `examples/AGENTS.md` states examples keep only `cordis.yml` wiring and e2e/snapshot scenarios; a bespoke long-running script does not fit that shape. The demo instead lives as a real, runnable Vitest orchestration suite in this package's own `tests/`, against fake `SttSession`/`TtsSession` and a scripted `LlmAdapter` — no `examples/` leaf is added in this change; a production composition (real Deepgram Flux + DeepSeek, a live audio transport) is deferred to a future package or example.

## Consequences

`ctx.speech` gains a documented, tested Consumer; the package README's "no model-facing tool or voice-agent Consumer is wired yet" limitation is narrowed to "no model-facing *tool*" — programmatic composition (a demo, a future tool) can now drive a full voice conversation without hand-rolling turn-taking, barge-in, or history reconciliation. `projectConversationHistory` only folds `speech-agent/*` events; a session that mixes voice turns with ordinary text `user/message`/`assistant/message` history needs its own merge, left to the composing host. The stale dangling `packages/voice/*` tsconfig glob entries are removed, so a future `tsc -b` invocation no longer silently matches zero files there.

## Testing

Deterministic unit/orchestration tests (no network, no real timers) cover: natural turn completion (STT finalize → LLM stream → TTS speak/flush), barge-in (halt, abort propagation, playback-offset interrupt, stale-audio suppression, `textSpoken`/`textRemaining` reconciliation with and without a provider-supplied offset), non-`Error` and `Error` transport/response failures on both STT and TTS sides, an unrecognized TTS event type (`assertNever`), and cross-turn generation-map cleanup (no leaked `generatedText` across sequential turns). Session-log tests cover durable-event shape and `projectConversationHistory`'s generated-vs-heard fold, including defensive branches (an unreconciled trailing transcript, an orphaned reconciliation event, an unrelated interleaved session event type). The invariant companion is tested against a fresh session, a pre-existing session seeded before the companion mounts, a repeated `turnIndex`, and a decreasing one. Tests replaced fixed `await Promise.resolve()` counts with a bounded microtask-polling `waitUntil` helper, which is what surfaced (and let us fix) the exact "test never calls `queue.end()` before awaiting `run()`'s settlement" deadlock class the original revert attributed to the reverted suite.
