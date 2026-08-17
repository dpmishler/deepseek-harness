# Voice-agent demo: Deepgram Flux STT/TTS with barge-in

English | [中文](README.zh.md)

Runnable demo composing the speech capability seam (`ctx.speech`), its Deepgram Flux providers, `@deepseek-ai/dsh-speech-agent`'s `TurnController`, and `ctx.llm` into one voice conversation with barge-in. `cordis.yml` mounts settings, credentials, `dsh-llm-deepseek`, `dsh-session`, `dsh-speech`, and both Deepgram Flux providers; the two provider rows are `disabled` without `$DEEPGRAM_API_KEY` (both fail loud at load on a missing key, so a keyless boot — CI, contributors without a Deepgram account — must not mount them at all).

## Architecture

```text
                 audio in                                  audio out
  microphone ───────────────▶ SttSession ───┐      ┌─── TtsSession ───────────────▶ speaker
  (caller-owned)             (Deepgram Flux    │      │  (Deepgram Flux
                              /v2/listen)      │      │   /v2/speak)
                                    │           │      │        ▲
                                    │ turn events      │        │ speak()/flush()/interrupt()
                                    ▼           │      │        │
                          ┌─────────────────────────────────────────────┐
                          │              TurnController                 │
                          │  listening ──▶ thinking ──▶ speaking ──▶... │
                          │  generation counter · PlaybackClock         │
                          │  stale-audio suppression                   │
                          └───────────────────┬─────────────┬───────────┘
                                               │ respond()    │ withSessionLogging()
                                               ▼              ▼
                                        ctx.llm.stream()   Session (speech-agent/*)
                                     (dsh-llm-deepseek)   (durable transcript, response,
                                                            turn-completed/-interrupted)
```

`TurnController` never touches the microphone or speaker directly — a caller feeds raw audio to `SttSession.sendAudio()`, renders `onAudio` chunks to its own sink, and reports playback progress through `reportPlayed()`. This demo's tests use fake audio I/O (see below); a real caller substitutes a real capture/playback device.

**Barge-in path:** a `started` STT turn while the controller is `thinking` or `speaking` bumps the generation counter, aborts the in-flight `ctx.llm.stream()` call via `AbortSignal`, halts local playback, and sends `TtsSession.interrupt()` with `PlaybackClock`'s current session-wide offset. Any TTS `audio` frame already in flight for the superseded generation is dropped (`TurnController.discardedFrameCount`) instead of reaching the sink. See [`speech-agent`'s README](../../packages/speech/speech-agent/README.md) for the full mechanism.

## Run it

Keyless (no external accounts): the automated test suite below IS the runnable demo — this composition has no interactive terminal UI, matching every other `packages/speech/*` package's test-first approach.

```sh
DSH_HOME=$(mktemp -d) pnpm vitest run examples/voice-agent/tests/keyless-smoke.e2e.ts
```

This boots the real `cordis.yml` through the real Cordis Loader, registers fake STT/TTS providers directly on the real `ctx.speech` (in place of Deepgram — the expensive, non-deterministic network boundary) and a locally scripted `respond()` (in place of a real model call), and drives one full turn plus one barge-in. Everything else — `ctx.speech` registration/dispatch, `TurnController`, and the durable `speech-agent/*` session log — is real.

With both provider accounts (real Deepgram Flux TTS, real DeepSeek):

```sh
DEEPSEEK_API_KEY=... DEEPGRAM_API_KEY=... pnpm vitest run examples/voice-agent/tests/live.e2e.ts
```

This drives one turn through a real `ctx.llm.stream()` call and a real Deepgram Flux `/v2/speak` session (STT stays a fake scripted transcript — this repository has no recorded speech audio fixture for a real `/v2/listen` round trip; that provider's own handshake is proven independently by `packages/speech/speech-deepgram-flux-stt/tests/live.e2e.ts`). It prints the demo's latency measurement (see below) and asserts real synthesized audio bytes arrive.

## Demo script

[`assets/demo-script.json`](assets/demo-script.json) is the canonical two-turn conversation for manually exercising a real microphone/speaker setup: ask a question, barge in partway through the answer with an unrelated question, then let the second answer complete naturally. Expect, in order: `speech-agent/transcript` → `speech-agent/response` → (`speech-agent/turn-interrupted` for the barged-in turn, or `speech-agent/turn-completed` for the one that finished naturally) in the session log, joined by a shared `generation` number per turn.

## Reproducible latency methodology

`tests/live.e2e.ts` times two intervals from the moment the (fake, scripted) STT turn finalizes:

- `firstAudioLatencyMs` — until the first Deepgram Flux TTS `audio` frame reaches `onAudio`. This is the caller-observable time-to-first-sound: DeepSeek's time to the first `text-delta`, plus this package's `speak()` call, plus Deepgram's synthesis-to-first-frame time.
- `turnLatencyMs` — until `speech-agent/turn-completed`, i.e. the full response's total generation and synthesis time.

Reproduce by running `tests/live.e2e.ts` with both API keys set, several times in sequence (a single run is noisy — provider load and network conditions dominate any one measurement); the test prints both values to stdout on every run rather than asserting a fixed ceiling, so CI cannot flake on provider latency variance. Compare against `packages/speech/speech-deepgram-flux-tts/tests/live.e2e.ts` (TTS-only) and `packages/speech/speech-deepgram-flux-stt/tests/live.e2e.ts` (STT-only) to isolate which leg of the pipeline dominates a given measurement.

## Known Limitations and Deferred Work

- **No real microphone/speaker demo** — this leaf has no interactive terminal UI; `assets/demo-script.json` documents a manual walkthrough for a caller who wires real audio I/O, but no such wiring ships here (see `dsh-speech-agent`'s own "No audio I/O" limitation).
- **No real end-to-end STT in the live test** — `tests/live.e2e.ts` scripts the transcript instead of feeding real speech audio into a real `/v2/listen` session, for lack of a recorded-audio fixture in this repository.
