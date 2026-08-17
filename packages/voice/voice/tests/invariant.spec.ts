import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as VoiceInvariantCompanion from '@deepseek-ai/dsh-voice/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-voice/consumer'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(VoiceInvariantCompanion)
  return ctx
}

describe('voice/transcript stream invariants', () => {
  it('accepts strictly increasing turnIndex values within one session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('voice-invariant-valid'))
    expect(() => {
      session.append('voice/transcript', { turnIndex: 0, transcript: 'hi', endOfTurnConfidence: 0.9 })
      session.append('voice/transcript', { turnIndex: 1, transcript: 'again', endOfTurnConfidence: 0.9 })
    }).not.toThrow()
  })

  it('rejects a non-increasing turnIndex before committing it and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('voice-invariant-invalid'))
    session.append('voice/transcript', { turnIndex: 2, transcript: 'first', endOfTurnConfidence: 0.9 })
    expect(() => {
      session.append('voice/transcript', { turnIndex: 2, transcript: 'repeat', endOfTurnConfidence: 0.9 })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-voice',
    }))
    expect(session.seq).toBe(1)
    expect(() => {
      session.append('voice/transcript', { turnIndex: 3, transcript: 'next', endOfTurnConfidence: 0.9 })
    }).not.toThrow()
  })

  it('reconstructs an existing durable session before checking later turns', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('voice-invariant-late-load'))
    session.append('voice/transcript', { turnIndex: 0, transcript: 'first', endOfTurnConfidence: 0.9 })

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(VoiceInvariantCompanion)
    expect(() => {
      session.append('voice/transcript', { turnIndex: 1, transcript: 'second', endOfTurnConfidence: 0.9 })
    }).not.toThrow()
    expect(() => {
      session.append('voice/transcript', { turnIndex: 1, transcript: 'stale', endOfTurnConfidence: 0.9 })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT' }))
})
