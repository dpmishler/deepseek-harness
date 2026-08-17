# @deepseek-ai/dsh-speech-deepgram-flux-tts

English | [中文](README.zh.md)

Registers a Deepgram Flux-backed `TtsProvider` on `ctx.speech` (owned by `@deepseek-ai/dsh-speech`). Opens one WebSocket per session against `wss://api.deepgram.com/v2/speak` — **never** `/v1/speak` (Aura); an Aura model string is rejected on `/v2/speak` per [Deepgram's docs](https://developers.deepgram.com/reference/text-to-speech-api/speak-flux).

## Registration

```yaml
plugins:
  speech: {}
  speech-deepgram-flux-tts:
    apiKey: ${DEEPGRAM_API_KEY} # or omit and export $DEEPGRAM_API_KEY
```

`apply()` registers the provider under the stable id `PROVIDER_ID` (`deepgram-flux`); open a session with `ctx.speech.openTts({ provider: 'deepgram-flux', ... })`. A missing API key (neither `config.apiKey` nor `$DEEPGRAM_API_KEY`) throws at load — this provider has no `available()` escape valve.

## Protocol mapping

Query parameters sent on the `/v2/speak` URL: `model` (from `options.voice`, format `flux-{voice}-{lang}`, default `flux-alexis-en`), `encoding`/`sample_rate` (from `options.audio`, omitted for the model's native rate), `speed` (from `options.speed`), `expressivity` (from `options.expressivity` — fixed for the connection; Deepgram does not accept it on `Configure`). Authentication is `Authorization: Token <apiKey>` on the WebSocket handshake, sent via undici's `WebSocket`.

| Deepgram `/v2/speak` message | `TtsEvent` |
|---|---|
| `Connected` | `connected` (`requestId`, `modelName`) |
| binary `Audio` frame | `audio` (`turnId` is the connection's tracked active turn; see below) |
| `SpeechStarted` | `turn-started`; also sets the connection's active turn id |
| `SpeechMetadata` | `turn-completed` |
| `SpeechInterrupted` | `turn-interrupted` |
| `Flushed` | `turn-flushed` |
| `SessionMetadata` | `session-completed` |
| `ConfigureSuccess` | `configure-ack` (`ok: true`, `appliedSpeed`) |
| `ConfigureFailure` | `configure-ack` (`ok: false`, `failureCode`, `failureField`, `failureValue`, `failureMessage`) |
| `Warning` | `warning` |
| `Error` | `error` |
| WebSocket `close` | `closed` |

Binary `Audio` frames on the wire carry no turn identifier, so `FluxTtsConnection` tracks the most recent `SpeechStarted.speech_id` and attaches it to every `audio` event until the next `SpeechStarted`; a frame that somehow arrives before the first `SpeechStarted` is dropped rather than emitted with a synthesized id. `TtsSession.interrupt(playbackOffsetMs)` sends `{"type":"Interrupt","playback_offset":{"type":"time_ms","value":playbackOffsetMs}}`; calling it with no argument omits `playback_offset` entirely (the server then omits `text_spoken`/`text_remaining` from `SpeechInterrupted`, matching the seam's own contract). `close()` sends `{"type":"Close"}` and waits for the server to drain remaining audio and close the transport itself — it does **not** force-close the socket, which would truncate the drain.

## Model Experience

None, as the Deepgram Flux TTS adapter only opens sessions; it renders whatever text a caller streams in, without adding prompt or schema of its own.

#### KV Cache effect

Not applicable: this package makes no model request of its own.

## Known Limitations and Deferred Work

- **`expressivity` cannot be changed mid-session** — per Deepgram, it is fixed for the connection (beta; not settable via `Configure`); a caller who wants a different value must open a new session.
- **`mip_opt_out` and `tag` query parameters are not exposed** — the provider-neutral `TtsOpenOptions` has no fields for them.
- **No reconnect on an unexpected close** — an abnormal WebSocket close surfaces as a `closed` event like any other; the caller must reconnect by opening a new session.
