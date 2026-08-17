import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import { logSessionCompleted, withSessionLogging } from '../src/consumer.ts'
import type { TurnControllerHandlers } from '../src/turn-controller.ts'
import type { SttTurnEvent, TtsTurnCompletedEvent, TtsTurnInterruptedEvent } from '@deepseek-ai/dsh-speech'

async function session() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId('speech-agent-consumer-test'))
}

function baseHandlers(calls: string[]): TurnControllerHandlers {
  return {
    onTranscript: () => { calls.push('onTranscript') },
    onResponseGenerated: () => { calls.push('onResponseGenerated') },
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
  it('appends speech-agent/transcript with its generation and delegates to the wrapped onTranscript', async () => {
    const calls: string[] = []
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers(calls))
    wrapped.onTranscript(TRANSCRIPT_EVENT, 1)
    expect(calls).toEqual(['onTranscript'])
    const [event] = target.events.filter(entry => entry.type === 'speech-agent/transcript')
    expect(event?.data).toEqual({
      generation: 1,
      turnIndex: 0,
      transcript: 'hello',
      endOfTurnConfidence: 0.9,
    })
  })

  it('appends speech-agent/response and delegates to the wrapped onResponseGenerated', async () => {
    const calls: string[] = []
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers(calls))
    wrapped.onResponseGenerated(1, 'Hi there!')
    expect(calls).toEqual(['onResponseGenerated'])
    const [event] = target.events.filter(entry => entry.type === 'speech-agent/response')
    expect(event?.data).toEqual({ generation: 1, text: 'Hi there!' })
  })

  it('appends speech-agent/turn-completed with its generation on a natural turn completion', async () => {
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers([]))
    wrapped.onTurnCompleted?.(COMPLETED_EVENT, 1)
    const events = target.events.filter(event => event.type === 'speech-agent/turn-completed')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      generation: 1,
      turnId: TURN_ID,
      audioDurationMs: 500,
      inputCharacterCount: 20,
      billableCharacterCount: 18,
    })
  })

  it('appends speech-agent/turn-interrupted with the exact textSpoken/textRemaining reconciliation', async () => {
    const target = await session()
    const wrapped = withSessionLogging(target, baseHandlers([]))
    wrapped.onSpeechInterrupted(INTERRUPTED_EVENT, 1)
    const events = target.events.filter(event => event.type === 'speech-agent/turn-interrupted')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      generation: 1,
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
    }, 1)
    const [event] = target.events.filter(entry => entry.type === 'speech-agent/turn-interrupted')
    expect(event?.data).not.toHaveProperty('textSpoken')
    expect(event?.data).not.toHaveProperty('textRemaining')
  })

  it('passes every other handler through unchanged', async () => {
    const calls: string[] = []
    const original = baseHandlers(calls)
    const wrapped = withSessionLogging(await session(), original)
    // oxlint-disable-next-line typescript/unbound-method -- identity check of a passed-through reference.
    expect(wrapped.onAudio).toBe(original.onAudio)
    // oxlint-disable-next-line typescript/unbound-method -- identity check of a passed-through reference.
    expect(wrapped.onHaltPlayback).toBe(original.onHaltPlayback)
    // oxlint-disable-next-line typescript/unbound-method -- identity check of a passed-through reference.
    expect(wrapped.onError).toBe(original.onError)
  })
})

describe('logSessionCompleted', () => {
  it('appends speech-agent/session-completed with the cumulative totals', async () => {
    const target = await session()
    logSessionCompleted(target, {
      totalAudioDurationMs: 9000,
      totalInputCharacterCount: 400,
      totalBillableCharacterCount: 380,
    })
    const [event] = target.events.filter(entry => entry.type === 'speech-agent/session-completed')
    expect(event?.data).toEqual({
      totalAudioDurationMs: 9000,
      totalInputCharacterCount: 400,
      totalBillableCharacterCount: 380,
    })
  })
})
