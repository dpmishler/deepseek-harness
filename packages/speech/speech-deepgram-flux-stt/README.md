# @deepseek-ai/dsh-speech-deepgram-flux-stt

English | [中文](README.zh.md)

Registers a Deepgram Flux-backed `SttProvider` on `ctx.speech` (owned by `@deepseek-ai/dsh-speech`). Opens one WebSocket per session against `wss://api.deepgram.com/v2/listen` — **never** `/v1/listen` (Nova/legacy) or any Aura endpoint; Flux requires `/v2/listen` per [Deepgram's docs](https://developers.deepgram.com/docs/flux/quickstart).

## Registration

```yaml
plugins:
  speech: {}
  speech-deepgram-flux-stt:
    apiKey: ${DEEPGRAM_API_KEY} # or omit and export $DEEPGRAM_API_KEY
```

`apply()` registers the provider under the stable id `PROVIDER_ID` (`deepgram-flux`); open a session with `ctx.speech.openStt({ provider: 'deepgram-flux', ... })`. A missing API key (neither `config.apiKey` nor `$DEEPGRAM_API_KEY`) throws at load — this provider has no `available()` escape valve, so `ctx.speech` would otherwise dispatch to a provider that can never connect.

## Protocol mapping

Query parameters sent on the `/v2/listen` URL: `model` (from `options.model`, default `flux-general-en`), `encoding`/`sample_rate` (from `options.audio`, omitted for containerized audio), `eot_threshold`/`eager_eot_threshold`/`eot_timeout_ms` (from `options.endOfTurn`), repeated `keyterm`/`language_hint` (from `options.keyterms`/`options.languageHints`). Authentication is `Authorization: Token <apiKey>` on the WebSocket handshake, sent via undici's `WebSocket` (Node's global `WebSocket` cannot set custom request headers).

| Deepgram `/v2/listen` message | `SttEvent` |
|---|---|
| `Connected` | `connected` |
| `TurnInfo` (`event: Update`) | `turn` (`kind: 'progress'`) |
| `TurnInfo` (`event: StartOfTurn`) | `turn` (`kind: 'started'`) |
| `TurnInfo` (`event: EagerEndOfTurn`) | `turn` (`kind: 'eager-completed'`) |
| `TurnInfo` (`event: TurnResumed`) | `turn` (`kind: 'resumed'`) |
| `TurnInfo` (`event: EndOfTurn`) | `turn` (`kind: 'completed'`) |
| `Error` | `error` (`fatal: true`) |
| `ConfigureSuccess` | `configure-ack` (`ok: true`) |
| `ConfigureFailure` | `configure-ack` (`ok: false`, `failureCode`, `failureMessage`) |
| WebSocket `close` | `closed` |

`SttSession.configure()` sends a `Configure` control message: threshold fields nest under `thresholds`, `keyterms: []` clears the list (per Deepgram, omission keeps it), and `languageHints: null`/omitted is dropped from the message entirely (server-side "no change"), while `languageHints: []` is sent explicitly to clear hints. There is no client-sent `KeepAlive` on `/v2/listen` — that message exists only on the legacy `/v1/listen` stream.

## Model Experience

None, as the Deepgram Flux STT adapter only opens sessions; the model-facing surface belongs to whatever consumer turns a transcript into a `user/message`.

#### KV Cache effect

Not applicable: this package makes no model request of its own.

## Known Limitations and Deferred Work

- **No local model/language-hint validation** — sending `language_hint` to `flux-general-en`, or an out-of-range threshold, is rejected by the server (`ConfigureFailure` or a connection-level error), not caught locally before the request is sent.
- **`profanity_filter`, `numerals`, `redact`, `mip_opt_out`, `tag` query parameters are not exposed** — the provider-neutral `SttOpenOptions` has no fields for them; a future revision would need either provider-specific passthrough or seam-level additions.
- **No reconnect on an unexpected close** — an abnormal WebSocket close (any code besides a caller-initiated `close()`) surfaces as a `closed` event like any other; the caller must reconnect by opening a new session.
