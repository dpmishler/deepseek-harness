# Speech Agent Demo

English | [中文](README.zh.md)

`cordis.yml` here wires the real production composition for a full-duplex voice agent:

- `@deepseek-ai/dsh-speech` (`ctx.speech`) plus the Deepgram Flux STT/TTS providers (`@deepseek-ai/dsh-speech-deepgram-flux-stt`/`-tts`).
- `@deepseek-ai/dsh-llm` plus the DeepSeek adapter (`@deepseek-ai/dsh-llm-deepseek`).
- `@deepseek-ai/dsh-session` for the durable `speech-agent/*` event log.

Turn-taking, barge-in reconciliation, and durable generated-vs-heard history are **not** plugins on this graph — they are the `@deepseek-ai/dsh-speech-agent` library, composed by application code that also owns the live audio transport (microphone capture, speaker playback), which this repository does not ship. See [`@deepseek-ai/dsh-speech-agent`'s README](../../packages/speech/speech-agent/README.md) for the API this demo's application code calls.

## Prerequisites

1. A Deepgram API key with access to Flux STT and Flux TTS: `DEEPGRAM_API_KEY`.
2. A DeepSeek API key: `DEEPSEEK_API_KEY`.
3. Both set in the environment or in a root `.env` file.

## What a full composition looks like

```ts
import { boot, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  SpeechAgentController,
  PlaybackClock,
} from '@deepseek-ai/dsh-speech-agent'
import { withSessionLogging, projectConversationHistory } from '@deepseek-ai/dsh-speech-agent/session-log'
import { createLlmResponder } from '@deepseek-ai/dsh-speech-agent/llm-responder'

loadEnv('speech-agent-demo')
const ctx = await boot('speech-agent-demo', resolveConfigPath('cordis.yml', undefined))

const session = ctx.sessions.create(SessionId(crypto.randomUUID()))
const stt = await ctx.speech.openStt({ provider: 'deepgram-flux' })
const tts = await ctx.speech.openTts({ provider: 'deepgram-flux' })
const playbackClock = new PlaybackClock()

const respond = createLlmResponder(ctx.llm, transcript => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [
    ...projectConversationHistory(session),
    { id: crypto.randomUUID() as never, role: 'user', content: [{ type: 'text', text: transcript }], source: { kind: 'user' } },
  ],
}))

const controller = new SpeechAgentController({
  stt,
  tts,
  playbackClock,
  respond,
  handlers: withSessionLogging(session, {
    onTranscript: () => {},
    onAudio: chunk => mySpeaker.write(chunk), // and call playbackClock.advance()/controller.reportPlayed() as frames actually render
    onHaltPlayback: () => mySpeaker.pause(),
    onSpeechInterrupted: () => {},
    onError: (error) => console.error(error),
  }),
})
void controller.run()

myMicrophone.on('data', (chunk) => stt.sendAudio(chunk))
```

`myMicrophone`/`mySpeaker` are host-specific audio I/O this repository does not provide.

## Verified without live credentials

The full loop above — real `ctx.speech`, real `ctx.llm`, real `SpeechAgentController`/`withSessionLogging`/`createLlmResponder`, wired through real Cordis plugin composition — is exercised deterministically, with fake STT/TTS providers and a fake LLM adapter standing in for the network calls, by `packages/speech/speech-agent/tests/demo.spec.ts`:

```sh
pnpm exec vitest run packages/speech/speech-agent/tests/demo.spec.ts
```

That test drives one natural turn and one barge-in turn end to end and asserts the durable `speech-agent/response-reconciled` events and the generated-vs-heard history projection. This `cordis.yml`'s real-provider path needs both API keys above and is not exercised by this repository's test suite here.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plugin load fails with "no Deepgram API key" | `DEEPGRAM_API_KEY` not set | Set the env var or add it to `.env` |
| `SPEECH_PROVIDER_NOT_REGISTERED` | Wrong provider id passed to `openStt`/`openTts` | Use `deepgram-flux`, matching this `cordis.yml` |
| Connection drops after ~10 s | No audio sent | Ensure `sendAudio()` is called continuously |
| `NET-0004` TTS error | TTS session idle >60 s | Reduce idle time between turns |
