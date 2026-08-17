import { describe, expect, it } from 'vitest'
import { AsyncEventQueue, PlaybackClock, SpeechAgentController } from '../src/index.ts'

describe('index barrel', () => {
  it('re-exports the Cordis- and session-log-free engine classes', () => {
    expect(AsyncEventQueue).toBeTypeOf('function')
    expect(PlaybackClock).toBeTypeOf('function')
    expect(SpeechAgentController).toBeTypeOf('function')
    expect(new PlaybackClock().elapsedMs).toBe(0)
    expect(new AsyncEventQueue<number>()[Symbol.asyncIterator]).toBeTypeOf('function')
  })
})
