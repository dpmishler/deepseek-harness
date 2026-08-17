import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, FluxSttProvider } from '@deepseek-ai/dsh-speech-deepgram-flux-stt'
import type { SttEvent } from '@deepseek-ai/dsh-speech'

/**
 * Real-API smoke against `wss://api.deepgram.com/v2/listen`. Self-skips
 * without `$DEEPGRAM_API_KEY` (CI has no secrets), per the with-key e2e
 * policy in docs/testing.md. Sends one second of silence — enough to prove
 * the handshake, auth, and `Connected`/close protocol without requiring
 * recorded speech audio in the repository.
 */
const apiKey = process.env.DEEPGRAM_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('FluxSttProvider real API', () => {
  it('opens a /v2/listen session, accepts silence, and closes cleanly', async () => {
    const provider = new FluxSttProvider({
      apiKey: apiKey!,
      baseURL: process.env.DEEPGRAM_BASE_URL ?? DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    })
    const session = await provider.connect({
      provider: 'deepgram-flux',
      audio: { encoding: 'linear16', sampleRateHz: 16000 },
    })

    const events: SttEvent[] = []
    const iterator = session.events[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (!first.done) events.push(first.value)
    expect(events[0]?.type).toBe('connected')

    // 16000 Hz * 2 bytes/sample * 1 second of silence.
    session.sendAudio(new Uint8Array(32_000))
    await session.close()
  }, 30_000)
})
