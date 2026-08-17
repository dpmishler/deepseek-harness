import { describe, expect, it } from 'vitest'
import { PlaybackClock } from '../src/playback-clock.ts'

describe('PlaybackClock', () => {
  it('starts at zero and accumulates advances', () => {
    const clock = new PlaybackClock()
    expect(clock.elapsedMs).toBe(0)
    clock.advance(500)
    clock.advance(340)
    expect(clock.elapsedMs).toBe(840)
  })

  it('accepts a zero advance as a no-op progress report', () => {
    const clock = new PlaybackClock()
    clock.advance(0)
    expect(clock.elapsedMs).toBe(0)
  })

  it('rejects a negative advance', () => {
    const clock = new PlaybackClock()
    expect(() => { clock.advance(-1) }).toThrow(
      expect.objectContaining({ code: 'SPEECH_AGENT_INVALID_PLAYBACK_PROGRESS' }),
    )
  })

  it('rejects a non-finite advance', () => {
    const clock = new PlaybackClock()
    expect(() => { clock.advance(Number.NaN) }).toThrow(
      expect.objectContaining({ code: 'SPEECH_AGENT_INVALID_PLAYBACK_PROGRESS' }),
    )
    expect(() => { clock.advance(Number.POSITIVE_INFINITY) }).toThrow(
      expect.objectContaining({ code: 'SPEECH_AGENT_INVALID_PLAYBACK_PROGRESS' }),
    )
  })
})
