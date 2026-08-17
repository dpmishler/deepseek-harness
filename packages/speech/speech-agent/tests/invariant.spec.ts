import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import * as SpeechAgentInvariant from '../src/invariant.ts'
import type {} from '../src/consumer.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SpeechAgentInvariant)
  return ctx
}

function turnStartEvent(): SessionEvent {
  return { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }
}

const TURN_ID = SpeechTurnId('turn-1')

describe('speech-agent durable invariants', () => {
  it('accepts a coherent conversation: increasing generations, monotonic audioPlayedMs, and a reconciling interrupt', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('speech-agent/transcript', { generation: 1, turnIndex: 0, transcript: 'hi', endOfTurnConfidence: 0.9 })
    session.append('speech-agent/response', { generation: 1, text: 'Once upon a time' })
    expect(() => {
      session.append('speech-agent/turn-interrupted', {
        generation: 1,
        turnId: TURN_ID,
        audioPlayedMs: 1200,
        textSpoken: 'Once upon',
        textRemaining: ' a time',
        audioDurationMs: 1200,
        inputCharacterCount: 17,
        billableCharacterCount: 17,
      })
    }).not.toThrow()
    session.append('speech-agent/transcript', { generation: 3, turnIndex: 1, transcript: 'bye', endOfTurnConfidence: 0.9 })
    session.append('speech-agent/response', { generation: 3, text: 'Goodbye!' })
    expect(() => {
      session.append('speech-agent/turn-interrupted', {
        generation: 3,
        turnId: SpeechTurnId('turn-2'),
        audioPlayedMs: 1800,
        textSpoken: 'Goodbye!',
        textRemaining: '',
        audioDurationMs: 400,
        inputCharacterCount: 8,
        billableCharacterCount: 8,
      })
    }).not.toThrow()
  })

  it('accepts a natural turn-completed with no reconciliation check', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('speech-agent/transcript', { generation: 1, turnIndex: 0, transcript: 'hi', endOfTurnConfidence: 0.9 })
    session.append('speech-agent/response', { generation: 1, text: 'Hello!' })
    expect(() => {
      session.append('speech-agent/turn-completed', {
        generation: 1,
        turnId: TURN_ID,
        audioDurationMs: 500,
        inputCharacterCount: 6,
        billableCharacterCount: 6,
      })
    }).not.toThrow()
  })

  it('rejects a transcript generation that does not exceed the previous one', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('speech-agent/transcript', { generation: 2, turnIndex: 0, transcript: 'a', endOfTurnConfidence: 0.9 })
    expect(() => {
      session.append('speech-agent/transcript', { generation: 2, turnIndex: 1, transcript: 'b', endOfTurnConfidence: 0.9 })
    }).toThrow(/did not exceed the previous generation/)
  })

  it('rejects an interrupted turn whose audioPlayedMs regresses', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('speech-agent/turn-interrupted', {
      generation: 1,
      turnId: TURN_ID,
      audioPlayedMs: 2000,
      audioDurationMs: 2000,
      inputCharacterCount: 5,
      billableCharacterCount: 5,
    })
    expect(() => {
      session.append('speech-agent/turn-interrupted', {
        generation: 2,
        turnId: SpeechTurnId('turn-2'),
        audioPlayedMs: 1000,
        audioDurationMs: 1000,
        inputCharacterCount: 5,
        billableCharacterCount: 5,
      })
    }).toThrow(/preceded the earlier/)
  })

  it('rejects an interrupted turn whose textSpoken+textRemaining does not reconstruct the generated response', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('speech-agent/response', { generation: 1, text: 'Once upon a time' })
    expect(() => {
      session.append('speech-agent/turn-interrupted', {
        generation: 1,
        turnId: TURN_ID,
        audioPlayedMs: 1200,
        textSpoken: 'Once upon',
        textRemaining: ' a fable',
        audioDurationMs: 1200,
        inputCharacterCount: 17,
        billableCharacterCount: 17,
      })
    }).toThrow(/does not reconstruct its speech-agent\/response text/)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, turnStartEvent())
    }).not.toThrow()
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('speech-agent/transcript', { generation: 2, turnIndex: 0, transcript: 'a', endOfTurnConfidence: 0.9 })
    session.append('speech-agent/transcript', { generation: 2, turnIndex: 1, transcript: 'b', endOfTurnConfidence: 0.9 })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(SpeechAgentInvariant).then(() => undefined)).rejects.toThrow(/did not exceed the previous generation/)
  })
})
