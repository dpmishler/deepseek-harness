import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { SttTurnEvent } from '@deepseek-ai/dsh-speech'
import type { SpeechAgentTurnCompleted, SpeechAgentTurnInterrupted } from '../src/controller.ts'
import { logSessionMetadata, projectConversationHistory, withSessionLogging } from '../src/session-log.ts'

async function setup(): Promise<{ ctx: Context; session: ReturnType<Context['sessions']['create']> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(`speech-agent-${Math.random()}`))
  return { ctx, session }
}

const turn = (overrides: Partial<SttTurnEvent> = {}): SttTurnEvent => ({
  type: 'turn',
  kind: 'completed',
  turnIndex: 0,
  transcript: 'hello there',
  words: [],
  endOfTurnConfidence: 0.9,
  audioWindowStartSec: 0,
  audioWindowEndSec: 1,
  ...overrides,
})

const TURN_ID = SpeechTurnId('turn-1')

describe('withSessionLogging', () => {
  it('appends speech-agent/turn-transcript before delegating onTranscript', async () => {
    const { session } = await setup()
    const seen: SttTurnEvent[] = []
    const handlers = withSessionLogging(session, {
      onTranscript: event => seen.push(event),
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTranscript(turn())
    expect(seen).toEqual([turn()])
    expect(session.events).toEqual([
      expect.objectContaining({ type: 'speech-agent/turn-transcript', data: { turnIndex: 0, transcript: 'hello there', endOfTurnConfidence: 0.9 } }),
    ])
  })

  it('appends a natural completion as interrupted: false with heardText equal to generatedText', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    const event: SpeechAgentTurnCompleted = {
      type: 'turn-completed',
      turnId: TURN_ID,
      audioDurationMs: 500,
      inputCharacterCount: 10,
      billableCharacterCount: 10,
      generatedText: 'Hi there!',
    }
    handlers.onTurnCompleted?.(event)
    expect(session.events).toEqual([
      expect.objectContaining({
        type: 'speech-agent/response-reconciled',
        data: {
          turnId: TURN_ID,
          generatedText: 'Hi there!',
          heardText: 'Hi there!',
          interrupted: false,
          audioDurationMs: 500,
          inputCharacterCount: 10,
          billableCharacterCount: 10,
        },
      }),
    ])
  })

  it('appends a barge-in as interrupted: true with the exact generated-vs-heard split', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    const event: SpeechAgentTurnInterrupted = {
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Once upon',
      textRemaining: ' a time',
      metrics: { turnId: TURN_ID, audioDurationMs: 2340, inputCharacterCount: 17, billableCharacterCount: 17 },
      generatedText: 'Once upon a time',
      heardText: 'Once upon',
    }
    handlers.onSpeechInterrupted(event)
    expect(session.events).toEqual([
      expect.objectContaining({
        type: 'speech-agent/response-reconciled',
        data: {
          turnId: TURN_ID,
          generatedText: 'Once upon a time',
          heardText: 'Once upon',
          remainingText: ' a time',
          interrupted: true,
          audioPlayedMs: 2340,
          audioDurationMs: 2340,
          inputCharacterCount: 17,
          billableCharacterCount: 17,
        },
      }),
    ])
  })

  it('appends a barge-in with no textRemaining (fully heard) without a remainingText field', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onSpeechInterrupted({
      type: 'turn-interrupted',
      audioPlayedMs: 500,
      textSpoken: 'all of it',
      metrics: { turnId: TURN_ID, audioDurationMs: 500, inputCharacterCount: 9, billableCharacterCount: 9 },
      generatedText: 'all of it',
      heardText: 'all of it',
    })
    expect(session.events).toEqual([
      expect.objectContaining({
        type: 'speech-agent/response-reconciled',
        data: {
          turnId: TURN_ID,
          generatedText: 'all of it',
          heardText: 'all of it',
          interrupted: true,
          audioPlayedMs: 500,
          audioDurationMs: 500,
          inputCharacterCount: 9,
          billableCharacterCount: 9,
        },
      }),
    ])
  })

  it('passes onStateChange/onAudio/onHaltPlayback/onWarning/onError through unchanged', async () => {
    const { session } = await setup()
    let halted = 0
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => { halted += 1 },
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onHaltPlayback()
    expect(halted).toBe(1)
    expect(session.events).toEqual([])
  })
})

describe('logSessionMetadata', () => {
  it('appends speech-agent/session-metadata', async () => {
    const { session } = await setup()
    logSessionMetadata(session, { totalAudioDurationMs: 1000, totalInputCharacterCount: 40, totalBillableCharacterCount: 40 })
    expect(session.events).toEqual([
      expect.objectContaining({
        type: 'speech-agent/session-metadata',
        data: { totalAudioDurationMs: 1000, totalInputCharacterCount: 40, totalBillableCharacterCount: 40 },
      }),
    ])
  })
})

describe('projectConversationHistory', () => {
  it('pairs each transcript with its reconciliation using heardText, not generatedText', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTranscript(turn({ turnIndex: 0, transcript: 'tell me a story' }))
    handlers.onSpeechInterrupted({
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Once upon',
      textRemaining: ' a time',
      metrics: { turnId: TURN_ID, audioDurationMs: 2340, inputCharacterCount: 17, billableCharacterCount: 17 },
      generatedText: 'Once upon a time',
      heardText: 'Once upon',
    })
    handlers.onTranscript(turn({ turnIndex: 1, transcript: 'go on then' }))
    handlers.onTurnCompleted?.({
      type: 'turn-completed',
      turnId: SpeechTurnId('turn-2'),
      audioDurationMs: 100,
      inputCharacterCount: 5,
      billableCharacterCount: 5,
      generatedText: '...and they lived happily ever after.',
    })

    const messages = projectConversationHistory(session)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'tell me a story' }] })
    // The barge-in truncated response: history carries what was HEARD, not the full generation.
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Once upon' }] })
    expect(messages[2]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'go on then' }] })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: '...and they lived happily ever after.' }] })
  })

  it('projects a trailing transcript with no reconciliation yet as a final user-only message', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTranscript(turn({ transcript: 'still thinking about this one' }))
    const messages = projectConversationHistory(session)
    expect(messages).toEqual([expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'still thinking about this one' }] })])
  })

  it('returns an empty history for a session with no speech-agent events', async () => {
    const { session } = await setup()
    expect(projectConversationHistory(session)).toEqual([])
  })

  it('ignores an unrelated session event type interleaved between transcript and reconciliation', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTranscript(turn({ transcript: 'hi' }))
    session.append('turn/start', { turn: 1 })
    handlers.onTurnCompleted?.({
      type: 'turn-completed',
      turnId: TURN_ID,
      audioDurationMs: 100,
      inputCharacterCount: 2,
      billableCharacterCount: 2,
      generatedText: 'hello',
    })
    const messages = projectConversationHistory(session)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'hi' }] }),
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }),
    ])
  })

  it('flushes a pending transcript with no reconciliation before a later transcript overwrites it', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTranscript(turn({ turnIndex: 0, transcript: 'first, unreconciled' }))
    handlers.onTranscript(turn({ turnIndex: 1, transcript: 'second' }))
    const messages = projectConversationHistory(session)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'first, unreconciled' }] }),
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'second' }] }),
    ])
  })

  it('skips a reconciliation event with no pending transcript instead of projecting an orphaned assistant turn', async () => {
    const { session } = await setup()
    const handlers = withSessionLogging(session, {
      onTranscript: () => {},
      onAudio: () => {},
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: () => {},
    })
    handlers.onTurnCompleted?.({
      type: 'turn-completed',
      turnId: TURN_ID,
      audioDurationMs: 100,
      inputCharacterCount: 5,
      billableCharacterCount: 5,
      generatedText: 'orphaned',
    })
    expect(projectConversationHistory(session)).toEqual([])
  })
})
