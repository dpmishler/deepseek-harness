import { describe, expect, it } from 'vitest'
import { FluxSttProvider, FLUX_STT_PROVIDER_ID } from '../src/provider.ts'

/**
 * Real-API smoke for the Deepgram Flux STT provider. Self-skips without
 * `$DEEPGRAM_API_KEY` (CI has no secrets), per the with-key e2e policy in
 * docs/testing.md. Sends two seconds of silence: Flux only needs a live
 * connection and a clean `CloseStream` round trip to prove the wire protocol
 * end to end — asserting a specific transcript from silence would be asserting
 * provider behavior, not this adapter's.
 */
const apiKey = process.env['DEEPGRAM_API_KEY']
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('FluxSttProvider real API', () => {
  it('connects, streams silence, and closes cleanly', async () => {
    const provider = new FluxSttProvider({
      apiKey: apiKey!,
      baseURL: process.env['DEEPGRAM_BASE_URL'] ?? 'wss://api.deepgram.com',
      model: 'flux-general-en',
      encoding: 'linear16',
      sampleRateHz: 16_000,
      eotThreshold: 0.7,
      eotTimeoutMs: 5_000,
      keepAliveIntervalMs: 8_000,
      profanityFilter: false,
      numerals: false,
    })
    const session = await provider.connect({ provider: FLUX_STT_PROVIDER_ID })
    const events: unknown[] = []
    const pump = (async () => {
      for await (const event of session.events) events.push(event)
    })()
    // 16kHz mono 16-bit silence, two seconds.
    session.sendAudio(new Uint8Array(16_000 * 2 * 2))
    await new Promise(resolve => setTimeout(resolve, 2_000))
    await session.close()
    await pump
    expect(events.some(event => (event as { type: string }).type === 'closed')).toBe(true)
  }, 30_000)
})
