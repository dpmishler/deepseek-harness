import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as SpeechAgentInvariant from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SpeechAgentInvariant)
  return ctx
}

describe('speech-agent invariants', () => {
  it('accepts a strictly increasing turnIndex stream', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('speech-agent-invariant-valid'))
    expect(() => {
      session.append('speech-agent/turn-transcript', { turnIndex: 0, transcript: 'one', endOfTurnConfidence: 0.9 })
      session.append('speech-agent/turn-transcript', { turnIndex: 1, transcript: 'two', endOfTurnConfidence: 0.9 })
      session.append('speech-agent/turn-transcript', { turnIndex: 2, transcript: 'three', endOfTurnConfidence: 0.9 })
    }).not.toThrow()
  })

  it('rejects a repeated turnIndex', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('speech-agent-invariant-repeat'))
    session.append('speech-agent/turn-transcript', { turnIndex: 0, transcript: 'one', endOfTurnConfidence: 0.9 })
    expect(() => {
      session.append('speech-agent/turn-transcript', { turnIndex: 0, transcript: 'again', endOfTurnConfidence: 0.9 })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-speech-agent',
    }))
  })

  it('rejects a decreasing turnIndex', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('speech-agent-invariant-decrease'))
    session.append('speech-agent/turn-transcript', { turnIndex: 3, transcript: 'one', endOfTurnConfidence: 0.9 })
    expect(() => {
      session.append('speech-agent/turn-transcript', { turnIndex: 1, transcript: 'two', endOfTurnConfidence: 0.9 })
    }).toThrow(/does not strictly increase/)
  })

  it('seeds from a session created before the companion mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('speech-agent-invariant-seeded'))
    session.append('speech-agent/turn-transcript', { turnIndex: 0, transcript: 'one', endOfTurnConfidence: 0.9 })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SpeechAgentInvariant)
    expect(() => {
      session.append('speech-agent/turn-transcript', { turnIndex: 0, transcript: 'again', endOfTurnConfidence: 0.9 })
    }).toThrow(/does not strictly increase/)
  })

  it('ignores session events of other types', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('speech-agent-invariant-other'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
  })
})
