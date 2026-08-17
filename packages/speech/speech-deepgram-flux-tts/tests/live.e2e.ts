import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, FluxTtsProvider } from '@deepseek-ai/dsh-speech-deepgram-flux-tts'
import type { TtsEvent } from '@deepseek-ai/dsh-speech'

/**
 * Real-API smoke against `wss://api.deepgram.com/v2/speak`. Self-skips
 * without `$DEEPGRAM_API_KEY` (CI has no secrets), per the with-key e2e
 * policy in docs/testing.md. Synthesizes one short phrase and asserts real
 * audio bytes and a `turn-completed` event come back.
 */
const apiKey = process.env.DEEPGRAM_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('FluxTtsProvider real API', () => {
  it('synthesizes text into audio over /v2/speak', async () => {
    const provider = new FluxTtsProvider({
      apiKey: apiKey!,
      baseURL: process.env.DEEPGRAM_BASE_URL ?? DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    })
    const session = await provider.connect({
      provider: 'deepgram-flux',
      audio: { encoding: 'linear16', sampleRateHz: 24000 },
    })

    session.speak('Hello from the DeepSeek Harness voice agent test suite.')
    session.flush()

    let totalAudioBytes = 0
    let completed: TtsEvent | undefined
    for await (const event of session.events) {
      if (event.type === 'audio') totalAudioBytes += event.data.byteLength
      if (event.type === 'turn-completed') {
        completed = event
        break
      }
      if (event.type === 'error') throw new Error(`Flux TTS error: ${event.message}`)
    }

    expect(completed?.type).toBe('turn-completed')
    expect(totalAudioBytes).toBeGreaterThan(1000)

    await session.close()
  }, 30_000)
})
