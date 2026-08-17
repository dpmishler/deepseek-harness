/**
 * Real-API smoke: drives one full voice-agent turn through the real
 * `cordis.yml` composition against the real DeepSeek LLM and the real
 * Deepgram Flux TTS endpoint. Self-skips unless both `$DEEPSEEK_API_KEY` and
 * `$DEEPGRAM_API_KEY` are set (CI has no secrets), per the with-key e2e
 * policy in docs/testing.md.
 *
 * STT is a fake that emits one scripted final transcript instead of a real
 * `/v2/listen` connection — mocking only the boundary this repository has no
 * recorded speech audio fixture to exercise (see
 * `speech-deepgram-flux-stt/tests/live.e2e.ts` for that provider's own real
 * handshake proof). Everything downstream of the transcript is real: the
 * real `ctx.llm.stream()` call, the real Deepgram Flux `/v2/speak` session,
 * `TurnController`, and the durable `speech-agent/*` session log.
 *
 * This is also the demo's reproducible latency methodology: the test times
 * from the finalized transcript to the first rendered audio byte
 * (`firstAudioLatencyMs`) and to the turn's completion (`turnLatencyMs`) and
 * prints both. Reproduce by running this file directly with both API keys
 * set — `DEEPSEEK_API_KEY=... DEEPGRAM_API_KEY=... pnpm vitest run
 * examples/voice-agent/tests/live.e2e.ts` — averaging across several runs;
 * network conditions and provider load make any single run noisy, so no
 * fixed ceiling is asserted here, only a generous smoke bound that catches a
 * genuine hang.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SttEvent, SttOpenOptions, SttProvider, SttSession } from '@deepseek-ai/dsh-speech'
import { PlaybackClock, TurnController } from '@deepseek-ai/dsh-speech-agent'
import type { TurnControllerHandlers } from '@deepseek-ai/dsh-speech-agent'
import { withSessionLogging } from '@deepseek-ai/dsh-speech-agent/src/consumer.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootVoiceAgent } from './harness.ts'

const deepseekKey = process.env.DEEPSEEK_API_KEY
const deepgramKey = process.env.DEEPGRAM_API_KEY
const maybe = deepseekKey !== undefined && deepseekKey.length > 0
  && deepgramKey !== undefined && deepgramKey.length > 0
  ? describe
  : describe.skip

/** Single-shot fake STT session: emits `connected` then one scripted final transcript. */
function fakeSttProvider(transcript: string): SttProvider {
  return {
    connect(_options: SttOpenOptions): Promise<SttSession> {
      let delivered = false
      const session: SttSession = {
        events: {
          [Symbol.asyncIterator](): AsyncIterator<SttEvent> {
            return {
              next: (): Promise<IteratorResult<SttEvent>> => {
                if (!delivered) {
                  delivered = true
                  return Promise.resolve({
                    done: false,
                    value: {
                      type: 'turn',
                      kind: 'completed',
                      turnIndex: 0,
                      transcript,
                      words: [],
                      endOfTurnConfidence: 0.95,
                      audioWindowStartSec: 0,
                      audioWindowEndSec: 1.5,
                    },
                  })
                }
                return new Promise<IteratorResult<SttEvent>>(() => {
                  // Held open deliberately: this fake never closes on its own,
                  // matching a real STT session's lifetime — the test's own
                  // `controller.close()` ends it.
                })
              },
            }
          },
        },
        sendAudio: () => {},
        configure: () => {},
        close: () => Promise.resolve(),
      }
      return Promise.resolve(session)
    },
  }
}

maybe('voice-agent example (real DeepSeek LLM + real Deepgram Flux TTS)', () => {
  it(
    'streams a real LLM response into real Flux TTS audio for one scripted transcript',
    async () => {
      const booted = await bootVoiceAgent({ DEEPSEEK_API_KEY: deepseekKey!, DEEPGRAM_API_KEY: deepgramKey! })
      try {
        const { ctx } = booted
        ctx.speech.registerSttProvider('fake', fakeSttProvider('In one short sentence, what is the capital of France?'))

        const stt = await ctx.speech.openStt({ provider: 'fake' })
        const tts = await ctx.speech.openTts({ provider: 'deepgram-flux', audio: { encoding: 'linear16', sampleRateHz: 24000 } })
        const session = ctx.sessions.create(SessionId('voice-agent-live-smoke'))

        const transcriptAt = Date.now()
        let firstAudioAt: number | undefined
        let totalAudioBytes = 0
        let turnCompletedAt: number | undefined

        const handlers: TurnControllerHandlers = {
          onTranscript: () => {},
          onResponseGenerated: () => {},
          onAudio: (chunk) => {
            firstAudioAt ??= Date.now()
            totalAudioBytes += chunk.byteLength
          },
          onHaltPlayback: () => {},
          onSpeechInterrupted: () => {},
          onTurnCompleted: () => { turnCompletedAt = Date.now() },
          onError: (error) => { throw error },
        }

        const controller = new TurnController({
          stt,
          tts,
          playbackClock: new PlaybackClock(),
          respond: (transcript, signal): AsyncIterable<StreamChunk> => ctx.llm.stream({
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            messages: [createUserMessage({ content: [{ type: 'text', text: transcript }], source: { kind: 'user' } })],
            signal,
          }),
          handlers: withSessionLogging(session, handlers),
        })
        const run = controller.run()

        // Wait for the natural turn completion, or fail the test on a hang.
        await Promise.race([
          (async () => { while (turnCompletedAt === undefined) await new Promise(resolve => setTimeout(resolve, 50)) })(),
          new Promise((_resolve, reject) => {
            setTimeout(() => { reject(new Error('timed out waiting for turn-completed')) }, 45_000)
          }),
        ])

        expect(totalAudioBytes).toBeGreaterThan(0)
        expect(firstAudioAt).toBeDefined()

        const firstAudioLatencyMs = firstAudioAt! - transcriptAt
        const turnLatencyMs = turnCompletedAt! - transcriptAt
        // Intentional: this IS the demo's reproducible latency methodology output.
        console.log(`voice-agent live smoke: firstAudioLatencyMs=${firstAudioLatencyMs} turnLatencyMs=${turnLatencyMs} totalAudioBytes=${totalAudioBytes}`)
        expect(firstAudioLatencyMs).toBeGreaterThan(0)

        const responseEvents = session.events.filter(event => event.type === 'speech-agent/response')
        expect(responseEvents).toHaveLength(1)
        expect((responseEvents[0]?.data as { text: string }).text.length).toBeGreaterThan(0)
        const completedEvents = session.events.filter(event => event.type === 'speech-agent/turn-completed')
        expect(completedEvents).toHaveLength(1)

        await controller.close()
        await stt.close()
        await tts.close()
        await run
      } finally {
        await booted.dispose()
      }
    },
    60_000,
  )
})
