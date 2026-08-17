import { describe, expect, it } from 'vitest'
import { PlaybackClock } from '../src/playback-clock.ts'

describe('PlaybackClock', () => {
  it('starts at zero', () => {
    expect(new PlaybackClock().elapsedMs).toBe(0)
  })

  it('accumulates across multiple advances, session-wide (never resets per turn)', () => {
    const clock = new PlaybackClock()
    clock.advance(1000)
    clock.advance(500.5)
    expect(clock.elapsedMs).toBe(1500.5)
    clock.advance(0)
    expect(clock.elapsedMs).toBe(1500.5)
  })

  it('rejects a negative advance', () => {
    const clock = new PlaybackClock()
    expect(() => clock.advance(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_PLAYBACK_PROGRESS' }),
    )
  })

  it('rejects a non-finite advance', () => {
    const clock = new PlaybackClock()
    expect(() => clock.advance(Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_PLAYBACK_PROGRESS' }),
    )
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_PLAYBACK_PROGRESS' }),
    )
  })
})
