import { describe, expect, it } from 'vitest'
import { PlaybackClock } from '../src/playback-clock.ts'
import { SpeechAgentError } from '../src/error.ts'

describe('PlaybackClock', () => {
  it('starts at zero elapsed milliseconds', () => {
    expect(new PlaybackClock().elapsedMs).toBe(0)
  })

  it('accumulates advance() calls', () => {
    const clock = new PlaybackClock()
    clock.advance(500)
    clock.advance(300)
    expect(clock.elapsedMs).toBe(800)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a negative or non-finite advance (%s)',
    (ms) => {
      const clock = new PlaybackClock()
      expect(() => { clock.advance(ms) }).toThrow(SpeechAgentError)
      expect(() => { clock.advance(ms) }).toThrow(/non-negative finite number/)
    },
  )

  it('accepts a zero advance', () => {
    const clock = new PlaybackClock()
    expect(() => { clock.advance(0) }).not.toThrow()
    expect(clock.elapsedMs).toBe(0)
  })

  describe('consumeInterruptOffsetMs()', () => {
    it('returns the current elapsed position on the first call', () => {
      const clock = new PlaybackClock()
      clock.advance(1200)
      expect(clock.consumeInterruptOffsetMs()).toBe(1200)
    })

    it('returns undefined when the clock has not advanced since the previous interrupt', () => {
      const clock = new PlaybackClock()
      clock.advance(1200)
      expect(clock.consumeInterruptOffsetMs()).toBe(1200)
      // No advance() between interrupts — e.g. two barge-ins during the same
      // `thinking` phase, before any audio has played.
      expect(clock.consumeInterruptOffsetMs()).toBeUndefined()
    })

    it('returns the new position once the clock advances past the previous interrupt', () => {
      const clock = new PlaybackClock()
      clock.advance(1200)
      expect(clock.consumeInterruptOffsetMs()).toBe(1200)
      clock.advance(400)
      expect(clock.consumeInterruptOffsetMs()).toBe(1600)
    })

    it('returns undefined at zero elapsed milliseconds when never advanced', () => {
      // A barge-in before any audio has played this session (state 'thinking',
      // no TTS turn ever started): Flux TTS answers Interrupt with a
      // NO_AUDIO_GENERATED warning in this case regardless, but the offset
      // contract itself only forbids a non-advancing REPEAT, not zero.
      const clock = new PlaybackClock()
      expect(clock.consumeInterruptOffsetMs()).toBe(0)
      expect(clock.consumeInterruptOffsetMs()).toBeUndefined()
    })
  })
})
