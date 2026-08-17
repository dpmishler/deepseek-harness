# speech/ — speech capability family

English | [中文](README.zh.md)

The speech seam, its Deepgram Flux provider adapters, and the turn-taking orchestration Consumer. The `speech` package owns the Service Definition role: STT/TTS provider registries, session/event vocabulary, and the `SpeechError` taxonomy. Provider adapters register on `ctx.speech` by explicit id — there is no auto-selection, unlike `ctx.web`.

| Package | Role | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | Speech service, provider registries, session/event vocabulary | `ctx.speech` |
| [`speech-deepgram-flux-stt/`](speech-deepgram-flux-stt/README.md) | Deepgram Flux STT provider (`wss://api.deepgram.com/v2/listen`) | registers on `ctx.speech` |
| [`speech-deepgram-flux-tts/`](speech-deepgram-flux-tts/README.md) | Deepgram Flux TTS provider (`wss://api.deepgram.com/v2/speak`) | registers on `ctx.speech` |
| [`speech-agent/`](speech-agent/README.md) | Consumer: barge-in-aware turn controller streaming LLM text into TTS, plus the durable `speech-agent/*` session log | none — takes open sessions, registers no service |

Deepgram's Flux models are the only STT/TTS models these adapters target; Aura and the legacy `/v1/speak`/`/v1/listen` endpoints are explicitly out of scope — see each adapter README for the protocol reference. The child READMEs own wire-message mapping, configuration, and provider-specific limitations. [`examples/voice-agent`](../../examples/voice-agent/README.md) wires all four into a runnable demo over `dsh-llm` and `dsh-session`.
