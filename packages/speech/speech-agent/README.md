# @deepseek-ai/dsh-speech-agent

English | [中文](README.zh.md)

The Consumer role for the `ctx.speech` (`@deepseek-ai/dsh-speech`) capability seam: a durable, reusable speech-agent orchestration layer that finalizes STT turns, streams Harness LLM (`@deepseek-ai/dsh-llm`) output directly into an open TTS session, and reconciles barge-in against the provider's exact `textSpoken`/`textRemaining` split.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-speech` | Service Definition: `ctx.speech`, STT/TTS provider registries, session/event vocabulary |
| `@deepseek-ai/dsh-speech-deepgram-flux-stt` / `-tts` | Service Providers: Deepgram Flux adapters |
| `@deepseek-ai/dsh-speech-agent` (this) | Consumer: turn-taking orchestration, durable history, `ctx.llm` binding |

## `SpeechAgentController`

The main barrel (`@deepseek-ai/dsh-speech-agent`) exports only the Cordis- and session-log-free engine: {@link SpeechAgentController}, {@link PlaybackClock}, and {@link AsyncEventQueue}. The controller pumps one open `SttSession` and one open `TtsSession` (both from `@deepseek-ai/dsh-speech`) for the life of a conversation:

- A completed STT turn (`SttTurnEvent.kind === 'completed'`) calls the caller-supplied `respond(transcript, signal)`, which returns an `AsyncIterable<StreamChunk>` — the same vocabulary `ctx.llm.stream()` produces. Every `text-delta` chunk is forwarded straight into `tts.speak()`; the stream's end calls `tts.flush()`.
- A fresh STT turn starting (`kind === 'started'`) while the controller is `thinking` or `speaking` is barge-in: it aborts the in-flight `respond()` call via `signal`, calls the caller's `onHaltPlayback()`, and sends `tts.interrupt(playbackClock.elapsedMs)` — the session-wide playback offset a caller driving real audio reports through `reportPlayed()`. `TtsSession.interrupt()` requires this offset to strictly increase across a session; {@link PlaybackClock} is the one counter every barge-in call reads.
- Stale-audio suppression: an internal generation counter bumps on every barge-in. Audio events whose TTS turn belongs to a superseded generation increment `discardedFrameCount` instead of reaching `onAudio()`, so a caller's playback sink never renders audio for a response the listener already interrupted.
- Generated-vs-heard reconciliation: the controller accumulates every response's text-delta chunks. A natural `turn-completed` reports `generatedText` (the full response) as `SpeechAgentTurnCompleted`. A `turn-interrupted` reports the exact split as `SpeechAgentTurnInterrupted`: `heardText` is the provider's `textSpoken` (falling back to `generatedText` only if the provider omitted it), `remainingText` is `textRemaining`.

## Durable history (`./session-log`)

`withSessionLogging(session, handlers)` wraps a consumer's handlers so every reconciliation-relevant callback also appends a durable `speech-agent/*` `SessionEventMap` event to a `@deepseek-ai/dsh-session` `Session`, before delegating:

| Event | Recorded at |
|---|---|
| `speech-agent/turn-transcript` | Every completed STT turn |
| `speech-agent/response-reconciled` | Every TTS turn's natural completion or barge-in interruption, carrying `generatedText`/`heardText`/`remainingText`/`interrupted` |
| `speech-agent/session-metadata` | The TTS session's cumulative totals, via `logSessionMetadata()`, before the transport closes |

`projectConversationHistory(session)` folds that durable stream back into ordinary `@deepseek-ai/dsh-llm` `Message`s for the next `ctx.llm.stream()` call. This is the generated-vs-heard history contract: the assistant message content is always `heardText`, never `generatedText` — a barge-in-truncated response continues the conversation as the truncated utterance it actually was. Projected assistant messages carry a fixed `{ provider: 'speech-agent', model: 'speech-agent' }` source: they are a durable-event projection, not a replayed model response, so they never claim a real provider/model attribution.

## `ctx.llm` binding (`./llm-responder`)

`createLlmResponder(llm, buildRequest)` binds `TurnControllerOptions.respond`'s signature to a live `LlmRuntime`: `buildRequest(transcript)` returns the request (typically folding `projectConversationHistory()` plus the new transcript into `messages`), and the returned function forwards the caller's `AbortSignal` onto `GenerateOptions.signal` so a real adapter's HTTP request is cancelled the instant a barge-in fires — not just its local consumption.

## Invariant

The package's `./invariant` companion checks that `speech-agent/turn-transcript.turnIndex` strictly increases within one session, matching `SttTurnEvent`'s documented turn-index contract.

## Known Limitations and Deferred Work

- **No model-facing tool or automatic session wiring** — this package supplies the orchestration engine and durable-history helpers; a host composes them with a live audio transport (microphone capture, speaker playback) and a `ctx.llm` call config. No example composition is included in this change.
- **`projectConversationHistory` covers only voice turns** — it folds `speech-agent/*` events alone. A session that also carries ordinary `user/message`/`assistant/message` turns (text chat, tool calls) needs its own merge; this package does not interleave the two histories.
- **No reconnect or retry policy** — inherited from `@deepseek-ai/dsh-speech`: a transport failure ends the session and reaches `onError`; reconnection is a caller concern.

## Model Experience

### Projected voice-turn history

#### What the model sees

`projectConversationHistory()` turns each durable `speech-agent/turn-transcript` into an ordinary user-role text message (the STT turn's final transcript) and each `speech-agent/response-reconciled` into an ordinary assistant-role text message whose content is `heardText` — the barge-in-truncated utterance when one occurred, otherwise the full generated response. Callers fold this array into `GenerateOptions.messages`; the package renders no system-prompt text or tool schema of its own.

#### Token effect

Each reconciled voice turn adds one data-dependent user message and (once reconciled) one data-dependent assistant message. The package applies no private truncation or budget; a barge-in shortens the assistant message rather than adding a separate record.

#### KV Cache effect

Append-only: a reconciled turn's projected messages are written once and never revised, so earlier turns stay a stable, reusable prefix as later turns append. `heardText` is fixed at reconciliation time — a barge-in shortens what is recorded, not what a previously reconciled and already-sent turn contains.
