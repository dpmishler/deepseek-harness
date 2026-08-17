# Voice Agent Example

A runnable example demonstrating the Deepgram Flux voice capability seam in DeepSeek Harness.
This example loads the STT and TTS providers and shows how to wire a voice agent loop.

## Prerequisites

1. A Deepgram API key with access to Flux STT and Flux TTS.
2. `DEEPGRAM_API_KEY` set in the environment or in a root `.env` file.
3. A microphone input source (or pre-recorded audio) for STT.
4. Audio playback for TTS output.

## Configuration

See [`cordis.yml`](cordis.yml) for the plugin composition.

### Flux STT models

| Model | Languages |
|---|---|
| `flux-general-en` | English only (default) |
| `flux-general-multi` | 10 languages with `language_hint` |

### Flux TTS models

Flux TTS voices follow `flux-{voice}-{language}` (e.g. `flux-haley-en`).
See [Deepgram Flux TTS Voices](https://developers.deepgram.com/docs/flux-tts/quickstart#model-naming) for the full catalog.

## Running

```sh
# From repo root (needs DEEPGRAM_API_KEY):
node --import tsx/esm examples/voice-agent/run.ts
```

## Architecture              TTS Registry             │
│  ┌─────────────┐           ┌─────────────┐          │
│  │ deepgram-   │           │ deepgram-   │          │
│  │ flux (STT)  │           │ flux (TTS)  │          │
│  └──────┬──────┘           └──────┬──────┘          │
│         │                         │                 │
│   SttSession                 TtsSession             │
│   WebSocket                  WebSocket              │
│   /v2/listen                 /v2/speak              │
└─────────────────────────────────────────────────────┘
       │                           │
       ▼                           ▼
  Deepgram STT              Deepgram TTS
  flux-general-en           flux-haley-en
  (turn detection)          (turn synthesis)
```

## Security

- API keys are resolved per-session from the environment or credentials provider — never hardcoded in configuration.
- The WebSocket connection uses `Authorization: Token <KEY>` in the header (not a query parameter).
- Audio data is transmitted only to Deepgram's API (`api.deepgram.com`) over TLS (`wss://`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `VOICE_PROVIDER_UNAVAILABLE` | `DEEPGRAM_API_KEY` not set | Set the env var or add to `.env` |
| Connection drops after 10 s | No audio sent and KeepAlive not sent | Ensure audio is flowing; check `keepAliveIntervalMs` |
| `WS_CLOSE_1006` error event | Abnormal WebSocket disconnect | Check network; Deepgram status at status.deepgram.com |
| `NET-0004` TTS error | TTS session idle >60 s | Reduce idle time between turns |
| Empty TTS audio | Text was all whitespace/punctuation | Send substantive text before `flush()` |
| `VOICE_PROVIDER_CONFIGURED_MISSING` | Wrong provider id in config | Check `sttProvider`/`ttsProvider` config fields |
