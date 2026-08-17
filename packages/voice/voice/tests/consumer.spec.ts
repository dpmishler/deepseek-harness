import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SpeechTurnId } from '../src/brand.ts'
import { logSessionMetadata, withSessionLogging } from '../src/consumer.ts'
import type { TurnControllerHandlers } from '../src/turn-controller.ts'
import type { SttTurnEvent, TtsTurnCompletedEvent, TtsTurnInterruptedEvent } from '../src/types.ts'

async function session() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId('voice-consumer-test'))
}

function baseHandlers(calls: string[]): TurnControllerHandlers {
  return {
    onTranscript: () => { calls.push('onTranscript') },
    onAudio: () => {},
    onHaltPlayback: () => {},
    onTurnCompleted: () => { calls.push('onTurnCompleted') },
    onSpeechInterrupted: () => { calls.push('onSpeechInterrupted') },
    onError: () => {},
  }
}

const TURN_ID = SpeechTurnId('turn-1')

const TRANSCRIPT_EVENT: SttTurnEvent = {
  type: 'turn',
  kind: 'completed',
  turnIndex: 0,
  transcript: 'hello',
  words: [],
  endOfTurnConfidence: 0.9,
  audioWindowStartSec: 0,
  audioWindowEndSec: 1,
}

const COMPLETED_EVENT: TtsTurnCompletedEvent = {
  type: 'turn-completed',
  turnId: TURN_ID,
  audioDurationMs: 500,
  inputCharacterCount: 20,
  billableCharacterCount: 18,
}

const INTERRUPTED_EVENT: TtsTurnInterruptedEvent = {
  type: 'turn-interrupted',
  audioPlayedMs: 1200,
  textSpoken: 'hel',
  textRemaining: 'lo world',
  metrics: { turnId: TURN_ID, audioDurationMs: 1500, inputCharacterCount: 11, billableCharacterCount: 11 },
}

describe('withSessionLogging', () => {
  it('appends voice/transcript and delegates to the wrapped onTranscript', async () => {
    const calls: string[] = []
    const wrapped = withSessionLogging(await session(), baseHandlers(calls))
    wrapped.onTranscript(TRANSCRIPT_EVENT)
    expect(calls).toEqual(['onTranscript'])
  })

  it('appends voice/speech-metadata on a natural turn completion', async () => {
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers([]))
    wrapped.onTurnCompleted?.(COMPLETED_EVENT)
    const events = [...target.events].filter(event => event.type === 'voice/speech-metadata')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      turnId: TURN_ID,
      audioDurationMs: 500,
      inputCharacterCount: 20,
      billableCharacterCount: 18,
    })
  })

  it('appends voice/speech-interrupted with the exact textSpoken/textRemaining reconciliation', async () => {
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers([]))
    wrapped.onSpeechInterrupted(INTERRUPTED_EVENT)
    const events = [...target.events].filter(event => event.type === 'voice/speech-interrupted')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      turnId: TURN_ID,
      audioPlayedMs: 1200,
      textSpoken: 'hel',
      textRemaining: 'lo world',
      audioDurationMs: 1500,
      inputCharacterCount: 11,
      billableCharacterCount: 11,
    })
  })

  it('omits textSpoken/textRemaining when the interrupt carried no playback offset', async () => {
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers([]))
    wrapped.onSpeechInterrupted({
      type: 'turn-interrupted',
      audioPlayedMs: 0,
      metrics: { turnId: TURN_ID, audioDurationMs: 0, inputCharacterCount: 0, billableCharacterCount: 0 },
    })
    const [event] = [...target.events].filter(entry => entry.type === 'voice/speech-interrupted')
    expect(event?.data).not.toHaveProperty('textSpoken')
    expect(event?.data).not.toHaveProperty('textRemaining')
  })

  it('passes every other handler through unchanged', async () => {
    const calls: string[] = []
    const original = baseHandlers(calls)
    const wrapped = withSessionLogging(await session(), original)
    expect(wrapped.onAudio).toBe(original.onAudio)
    expect(wrapped.onHaltPlayback).toBe(original.onHaltPlayback)
    expect(wrapped.onError).toBe(original.onError)
  })
})

describe('logSessionMetadata', () => {
  it('appends voice/session-metadata with the cumulative totals', async () => {
    const target = await session()
    logSessionMetadata(target, {
      totalAudioDurationMs: 9000,
      totalInputCharacterCount: 400,
      totalBillableCharacterCount: 380,
    })
    const [event] = [...target.events].filter(entry => entry.type === 'voice/session-metadata')
    expect(event?.data).toEqual({
      totalAudioDurationMs: 9000,
      totalInputCharacterCount: 400,
      totalBillableCharacterCount: 380,
    })
  })
})
