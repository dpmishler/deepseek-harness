import { describe, expect, it } from 'vitest'
import type { TtsEvent } from '@deepseek-ai/dsh-voice'
import { FluxTtsProvider, FLUX_TTS_PROVIDER_ID } from '../src/provider.ts'

/**
 * Real-API smoke for the Deepgram Flux TTS provider. Self-skips without
 * `$DEEPGRAM_API_KEY` (CI has no secrets), per the with-key e2e policy in
 * docs/testing.md. Speaks one short sentence, flushes, and asserts real
 * audio bytes and a `turn-completed` event came back from the live service —
 * verifying the world (bytes actually received), not a self-report.
 */
const apiKey = process.env['DEEPGRAM_API_KEY']
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('FluxTtsProvider real API', () => {
  it('speaks, flushes, and receives audio plus turn-completed', async () => {
    const provider = new FluxTtsProvider({
      apiKey: apiKey!,
      baseURL: process.env['DEEPGRAM_BASE_URL'] ?? 'wss://api.deepgram.com',
      model: process.env['DEEPGRAM_FLUX_TTS_MODEL'] ?? 'flux-alexis-en',
      encoding: 'linear16',
      speed: 1.00,
      expressivity: 0,
      keepAliveIntervalMs: 20_000,
    })
    const session = await provider.connect({ provider: FLUX_TTS_PROVIDER_ID })
    const events: TtsEvent[] = []
    const pump = (async () => {
      for await (const event of session.events) events.push(event)
    })()
    session.speak('This is a real-API smoke test of the Deepgram Flux TTS provider.')
    session.flush()
    await new Promise(resolve => setTimeout(resolve, 5_000))
    await session.close()
    await pump

    const audioBytes = events
      .filter((event): event is Extract<TtsEvent, { type: 'audio' }> => event.type === 'audio')
      .reduce((total, event) => total + event.data.byteLength, 0)
    expect(audioBytes).toBeGreaterThan(0)
    expect(events.some(event => event.type === 'turn-completed')).toBe(true)
  }, 30_000)
})
