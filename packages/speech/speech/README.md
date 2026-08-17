# @deepseek-ai/dsh-speech

The **`SpeechRuntime`** (`ctx.speech`) defines WHAT streaming speech capability the harness has — open a speech-to-text session, open a text-to-speech session — over multiple providers, without binding the model-visible or product-visible surface to one vendor's wire protocol.

This package owns the Service Definition role of the speech capability. Unlike `ctx.web`, provider selection is never ambiguous or auto-resolved: every session-opening request names its provider id explicitly, so `openStt()`/`openTts()` either dispatch to that exact registered adapter or fail loud.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-speech` (this) | Service Definition: the service, provider registries, session/event vocabulary, the `SpeechError` taxonomy |
| `@deepseek-ai/dsh-speech-deepgram-flux-stt` | STT provider: Deepgram Flux over `wss://api.deepgram.com/v2/listen` |
| `@deepseek-ai/dsh-speech-deepgram-flux-tts` | TTS provider: Deepgram Flux over `wss://api.deepgram.com/v2/speak` |

STT and TTS share no request schema and no business logic, but they are deliberately one seam: `ctx.speech` is a single provider-registry owner with one duplicate-id policy and one error taxonomy, mirroring the STT/TTS split of `ctx.voice` while keeping registration explicit rather than availability-ranked.

## Service API (`ctx.speech`)

| Member | Semantics |
|---|---|
| `registerSttProvider(id, provider)` / `registerTtsProvider(id, provider)` | Register a backend under `id`. Throws `SpeechError` `SPEECH_DUPLICATE_PROVIDER` on a duplicate id within that capability kind. Returns a disposer; disposed with the calling fiber. |
| `listSttProviders()` / `listTtsProviders()` | Snapshot of registered provider ids, in registration order. |
| `openStt(options)` | Open an STT session on the provider named by `options.provider`. Throws `SpeechError` `SPEECH_PROVIDER_NOT_REGISTERED` when that id has no registered adapter. |
| `openTts(options)` | Open a TTS session on the provider named by `options.provider`. Throws `SpeechError` `SPEECH_PROVIDER_NOT_REGISTERED` when that id has no registered adapter. |

STT and TTS provider ids live in independent namespaces: the same id may be registered once per capability kind.

## Vocabulary

An `SttSession`/`TtsSession` is an open, provider-neutral streaming session: `events` is a single-consumer `AsyncIterable` driven by one `for await` loop for the session's life. `SttSession.sendAudio()` enqueues raw audio; `SttSession.configure()` applies a mid-session turn-detection/keyterm update, acknowledged by a `configure-ack` event. `TtsSession.speak()`/`flush()` stream text into a turn and close it; `interrupt()` reports caller-detected barge-in for context reconciliation (never for stopping local playback, which is the caller's job).

`SttTurnEvent.kind` names the provider's turn-detection state transition (`progress` | `started` | `eager-completed` | `resumed` | `completed`) without assuming any one provider's message names. `TtsTurnMetrics` (`audioDurationMs`, `inputCharacterCount`, `billableCharacterCount`) is shared by a natural `turn-completed` and an interrupted turn's `metrics` field, so both accounting paths read one shape. `SpeechRequestId` and `SpeechTurnId` (`@deepseek-ai/dsh-brand`) brand the provider-assigned correlation ids so they cannot be confused with plain strings at the type level. See `src/types.ts` for the full contracts and the `SpeechError` code taxonomy.

## Model Experience

None, as the STT/TTS provider registry only opens sessions and forwards audio/text; no model-facing consumer is registered yet.

#### KV Cache effect

Not applicable: this package makes no model request of its own.

## Known Limitations and Deferred Work

- **No model-facing consumer yet** — no tool or voice-agent Consumer renders speech sessions into a model request; `openStt()`/`openTts()` are usable only from plugin code until one is added.
- **No provider-availability query** — unlike `ctx.web`, there is no `available()` check or auto-selection; a caller must know which provider id is registered, and a missing id fails only at `openStt()`/`openTts()` time, not at registration time.
- **No reconnect or retry policy** — a transport failure ends the session (`closed` or a rejected `events` iterable); reconnection, backoff, and mid-session resume are provider- or consumer-owned, not part of this seam.
