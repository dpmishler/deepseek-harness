# Voice

English

The voice capability seam (`ctx.voice`) from [`packages/voice`](../../packages/voice/README.md): the abstract service, session and event vocabulary, and the Deepgram Flux STT and TTS provider adapters.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ctx.voice (VoiceRuntime)                  │
│                                                             │
│  STT Registry                   TTS Registry               │
│  ┌───────────────┐               ┌───────────────┐          │
│  │ deepgram-flux │               │ deepgram-flux │          │
│  │ (FluxSttProv) │               │ (FluxTtsProv) │          │
│  └───────┬───────┘               └───────┬───────┘          │
│          │ SttSession                    │ TtsSession       │
└──────────┼───────────────────────────────┼──────────────────┘
           │                               │
           ▼                               ▼
   FluxSttConnection              FluxTtsConnection
   WebSocket                      WebSocket
   /v2/listen                     /v2/speak
   (flux-general-en)              (flux-haley-en, ...)
           │                               │
           ▼                               ▼
   Deepgram STT API               Deepgram TTS API
   api.deepgram.com               api.deepgram.com
```

Source: [`packages/voice/voice/src/index.ts`](../../packages/voice/voice/src/index.ts)

## Capability seam roles

| Role | Package | Description |
|---|---|---|
| Service Definition | `@deepseek-ai/dsh-voice` | `VoiceRuntime` service, types, and error codes |
| STT Provider | `@deepseek-ai/dsh-flux-stt` | Deepgram Flux `/v2/listen` WebSocket adapter |
| TTS Provider | `@deepseek-ai/dsh-flux-tts` | Deepgram Flux `/v2/speak` WebSocket adapter |

## VoiceRuntime service

`VoiceRuntime` manages separate STT and TTS provider registries. Provider resolution is at call time and never depends on registration order.

Selection semantics:

| Condition | Code |
|---|---|
| Configured id registered + available | provider selected |
| Configured id not registered | `VOICE_PROVIDER_CONFIGURED_MISSING` |
| Configured id registered but unavailable | `VOICE_PROVIDER_CONFIGURED_UNAVAILABLE` |
| No id configured, exactly one usable | provider selected |
| No id configured, multiple usable | `VOICE_PROVIDER_AMBIGUOUS` |
| No id configured, none usable | `VOICE_PROVIDER_UNAVAILABLE` |

## Deepgram Flux STT (`/v2/listen`)

Source: [`packages/voice/flux-stt/src/connection.ts`](../../packages/voice/flux-stt/src/connection.ts)

### Connection requirements

- Endpoint: `wss://api.deepgram.com/v2/listen` (NOT `/v1/listen`)
- Models: `flux-general-en` (English) or `flux-general-multi` (multilingual)
- Auth: `Authorization: Token YOUR_KEY` header
- Audio: raw (non-containerized) binary frames; recommended 80 ms chunks

### Query parameters

| Parameter | Range | Default | Purpose |
|---|---|---|---|
| `model` | — | `flux-general-en` | Flux STT model |
| `encoding` | `linear16`/`mulaw`/`alaw` | `linear16` | Audio encoding |
| `sample_rate` | 8000–48000 | 16000 | Audio sample rate |
| `eot_threshold` | 0.5–0.9 | 0.7 | End-of-turn confidence threshold |
| `eager_eot_threshold` | 0.3–0.9 | (disabled) | Enables EagerTurnInfo events |
| `eot_timeout_ms` | 500–60000 | 5000 | Forced end-of-turn after silence |
| `keyterm` | (repeatable) | — | Bias recognition |

### SttEvent types

| Type | Source | Description |
|---|---|---|
| `transcript` | `Results` frame | Partial or final recognition result |
| `turn` | `TurnInfo` frame | Complete speaker turn with EOT confidence |
| `eager-turn` | `EagerTurnInfo` frame | Speculative early turn for lower latency |
| `speech-started` | `SpeechStarted` frame | VAD detected speech |
| `utterance-end` | `UtteranceEnd` frame | Silence ended an utterance |
| `error` | close/error event | Non-recoverable session error |

### Keepalive

The server disconnects after ~10 seconds with no audio or control frames. `FluxSttConnection` sends `{ type: "KeepAlive" }` JSON frames every `keepAliveIntervalMs` (default 8 seconds). The timer stops on `close()` or server disconnect.

### Control messages (client → server)

| Message | Purpose |
|---|---|
| binary frame | Raw audio chunk |
| `{ type: "KeepAlive" }` | Prevent idle disconnect |
| `{ type: "CloseStream" }` | Graceful close |
| `{ type: "Configure", ... }` | Mid-stream parameter update |

## Deepgram Flux TTS (`/v2/speak`)

Source: [`packages/voice/flux-tts/src/connection.ts`](../../packages/voice/flux-tts/src/connection.ts)

### Connection requirements

- Endpoint: `wss://api.deepgram.com/v2/speak` (NOT `/v1/speak`)
- Model: required — Flux TTS model string (e.g. `flux-haley-en`)
- Auth: `Authorization: Token YOUR_KEY` header
- Output: raw audio binary frames (no container)

### Connection query parameters

| Parameter | Values | Default | Purpose |
|---|---|---|---|
| `model` | `flux-{voice}-{language}` | required | Flux TTS model |
| `encoding` | `linear16`/`mulaw`/`alaw` | `linear16` | Output encoding |
| `sample_rate` | 8000–48000 | model native | Output sample rate |
| `speed` | 0.85–1.15 (0.05 steps) | 1.0 | Speech rate |
| `expressivity` | -2 to 2 | 0 | Delivery register |

### TtsEvent types

| Type | Source | Description |
|---|---|---|
| `audio` | binary frame | Raw audio bytes |
| `speech-started` | `SpeechStarted` | New turn began |
| `speech-metadata` | `SpeechMetadata` | Turn complete; billing data |
| `speech-interrupted` | `SpeechInterrupted` | Barge-in response with text_spoken |
| `flushed` | `Flushed` | Turn buffer flushed |
| `session-metadata` | `SessionMetadata` | Cumulative session totals on close |
| `warning` | `Warning` | Non-fatal; synthesis continues |
| `error` | `Error` / close | Fatal; session closed |

### Client messages

| Message | Purpose |
|---|---|
| `{ type: "Speak", text }` | Add text to active turn |
| `{ type: "Flush" }` | End turn; generate remaining audio |
| `{ type: "Interrupt", playback_offset? }` | Cancel turn on barge-in |
| `{ type: "Configure", speed? }` | Adjust speed mid-stream |
| `{ type: "Close" }` | Graceful close |

### Turn lifecycle

```
send("Hello,") → send(" world.") → ... → flush()
     ↓                                        ↓
SpeechStarted              audio*         SpeechMetadata + Flushed
```

On barge-in:
```
interrupt(playbackOffsetMs)
     ↓
SpeechInterrupted { text_spoken, text_remaining }
```

### Idle timeout

The server closes an idle session after 60 seconds (`NET-0004`). Typical voice-agent usage (sending turns continuously) does not require explicit keepalive.

## Security

- API keys resolve from environment or the credential seam per-session. Never hardcode keys in cordis.yml or plugin config.
- All WebSocket connections use TLS (`wss://`).
- The `Authorization` header carries the key — not a query parameter — to reduce exposure in server logs.
- `available()` returns `false` when no key is configured; session open fails loud rather than trying with an empty credential.

## Known Limitations

- **No audio capture or playback** — `ctx.voice` is transport-only. Audio I/O (microphone, speaker) is the caller's responsibility.
- **No loop integration** — voice sessions are not yet wired into the agent turn flow. A model-facing voice tool and session event types for voice turns are future work.
- **TTS keepalive** — `/v2/speak` has no `KeepAlive` control message; idle sessions beyond 60 seconds require the caller to send a turn or a WebSocket Ping (if the transport exposes it). The WHATWG WebSocket API used here does not expose `ping()`; callers depending on long-idle TTS sessions must reconnect.
- **Multilingual TTS** — Flux TTS voices are English-only today; the model catalog grows independently of this seam.
