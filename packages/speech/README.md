# speech/ — speech capability family

English

The speech seam and its Deepgram Flux provider adapters, plus a durable speech-agent orchestration Consumer. The `speech` package owns the Service Definition role: STT/TTS provider registries, session/event vocabulary, and the `SpeechError` taxonomy. Provider adapters register on `ctx.speech` by explicit id — there is no auto-selection, unlike `ctx.web`. `speech-agent` is the Consumer role: it drives STT turn detection, streams `ctx.llm` output into TTS, reconciles barge-in, and projects durable generated-vs-heard history. No model-facing tool is wired yet.

| Package | Role | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | Speech service, provider registries, session/event vocabulary | `ctx.speech` |
| [`speech-deepgram-flux-stt/`](speech-deepgram-flux-stt/README.md) | Deepgram Flux STT provider (`wss://api.deepgram.com/v2/listen`) | registers on `ctx.speech` |
| [`speech-deepgram-flux-tts/`](speech-deepgram-flux-tts/README.md) | Deepgram Flux TTS provider (`wss://api.deepgram.com/v2/speak`) | registers on `ctx.speech` |
| [`speech-agent/`](speech-agent/README.md) | Speech-agent orchestration Consumer: turn-taking, durable history, `ctx.llm` binding | consumes `ctx.speech` + `ctx.llm` |

Deepgram's Flux models are the only STT/TTS models these adapters target; Aura and the legacy `/v1/speak`/`/v1/listen` endpoints are explicitly out of scope — see each adapter README for the protocol reference. The child READMEs own wire-message mapping, configuration, and provider-specific limitations.
