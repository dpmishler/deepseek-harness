import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SpeechRequestId, SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { SttEvent, SttSession, TtsEvent, TtsSession } from '@deepseek-ai/dsh-speech'
import { AsyncEventQueue } from '../src/async-event-queue.ts'
import { PlaybackClock } from '../src/playback-clock.ts'
import { SpeechAgentController, type TurnControllerHandlers } from '../src/controller.ts'

/**
 * Poll a predicate across microtask ticks instead of a fixed
 * `await Promise.resolve()` count: the controller's pump loops each cross a
 * different, implementation-dependent number of microtask boundaries before
 * a given effect becomes observable, so a fixed count is either too few
 * (flaky) or padded with slack no test should depend on. Bounded so a
 * genuine regression fails fast instead of hanging the suite.
 */
async function waitUntil(predicate: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error(`waitUntil: condition not met after ${maxTicks} microtask ticks`)
}

function makeStt(): { session: SttSession; queue: AsyncEventQueue<SttEvent>; closeMock: ReturnType<typeof vi.fn> } {
  const queue = new AsyncEventQueue<SttEvent>()
  const closeMock = vi.fn(async () => {})
  return {
    queue,
    closeMock,
    session: {
      events: queue,
      sendAudio: () => {},
      configure: () => {},
      close: closeMock,
    },
  }
}

function makeTts(): {
  session: TtsSession
  queue: AsyncEventQueue<TtsEvent>
  speak: string[]
  flushCount: () => number
  interrupts: Array<number | undefined>
  closeMock: ReturnType<typeof vi.fn>
} {
  const queue = new AsyncEventQueue<TtsEvent>()
  const speak: string[] = []
  const interrupts: Array<number | undefined> = []
  const closeMock = vi.fn(async () => {})
  let flushes = 0
  return {
    queue,
    speak,
    flushCount: () => flushes,
    interrupts,
    closeMock,
    session: {
      events: queue,
      speak: text => speak.push(text),
      flush: () => { flushes += 1 },
      interrupt: playbackOffsetMs => interrupts.push(playbackOffsetMs),
      configure: () => {},
      close: closeMock,
    },
  }
}

function makeHandlers(): TurnControllerHandlers & {
  audio: Uint8Array[]
  states: string[]
  errors: Error[]
  interruptedEvents: Array<{ generatedText: string; heardText: string; textSpoken?: string; textRemaining?: string }>
  completedEvents: Array<{ generatedText: string }>
  halted: number
} {
  const audio: Uint8Array[] = []
  const states: string[] = []
  const errors: Error[] = []
  const interruptedEvents: Array<{ generatedText: string; heardText: string; textSpoken?: string; textRemaining?: string }> = []
  const completedEvents: Array<{ generatedText: string }> = []
  let halted = 0
  return {
    audio,
    states,
    errors,
    interruptedEvents,
    completedEvents,
    get halted() { return halted },
    onStateChange: state => states.push(state),
    onTranscript: () => {},
    onAudio: chunk => audio.push(chunk),
    onHaltPlayback: () => { halted += 1 },
    onSpeechInterrupted: event => interruptedEvents.push(event),
    onTurnCompleted: event => completedEvents.push(event),
    onError: error => errors.push(error),
  }
}

const TURN_ID = SpeechTurnId('turn-1')
const REQUEST_ID = SpeechRequestId('req-1')

describe('SpeechAgentController', () => {
  it('streams a completed transcript response into speak() calls, then flushes and returns to listening', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => respondChunks,
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hello there', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')

    respondChunks.push({ type: 'text-delta', index: 0, text: 'Hi ' })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'there!' })
    respondChunks.end()
    await waitUntil(() => tts.flushCount() === 1)
    expect(tts.speak).toEqual(['Hi ', 'there!'])

    tts.queue.push({ type: 'connected', requestId: REQUEST_ID, modelName: 'flux-alexis-en' })
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitUntil(() => controller.currentState === 'speaking')

    const chunk = new Uint8Array([1, 2, 3])
    tts.queue.push({ type: 'audio', turnId: TURN_ID, data: chunk })
    await waitUntil(() => handlers.audio.length === 1)
    expect(handlers.audio).toEqual([chunk])

    tts.queue.push({
      type: 'turn-completed',
      turnId: TURN_ID,
      audioDurationMs: 500,
      inputCharacterCount: 10,
      billableCharacterCount: 10,
    })
    await waitUntil(() => controller.currentState === 'listening')
    expect(handlers.states).toEqual(['listening', 'thinking', 'speaking', 'listening'])
    expect(handlers.completedEvents).toEqual([expect.objectContaining({ generatedText: 'Hi there!' })])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('barges in when a new STT turn starts while speaking: halts playback, aborts the LLM, and sends the session-wide playback offset', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    let capturedSignal: AbortSignal | undefined
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: (_transcript, signal) => {
        capturedSignal = signal
        return respondChunks
      },
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'tell me a story', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'text-delta', index: 0, text: 'Once upon a time' })
    await waitUntil(() => tts.speak.length === 1)
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitUntil(() => controller.currentState === 'speaking')

    // The listener has actually heard 2340ms of session audio when they barge in.
    clock.advance(2340)
    stt.queue.push({ type: 'turn', kind: 'started', turnIndex: 1, transcript: '', words: [], endOfTurnConfidence: 0, audioWindowStartSec: 1, audioWindowEndSec: 1 })
    await waitUntil(() => handlers.halted === 1)

    expect(tts.interrupts).toEqual([2340])
    expect(capturedSignal?.aborted).toBe(true)
    expect(controller.currentState).toBe('listening')

    // Audio that was already in flight for the cancelled turn must be discarded, not delivered.
    tts.queue.push({ type: 'audio', turnId: TURN_ID, data: new Uint8Array([9]) })
    await waitUntil(() => controller.discardedFrameCount === 1)
    expect(handlers.audio).toEqual([])

    tts.queue.push({
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Once upon',
      textRemaining: ' a time',
      metrics: { turnId: TURN_ID, audioDurationMs: 2340, inputCharacterCount: 17, billableCharacterCount: 17 },
    })
    await waitUntil(() => handlers.interruptedEvents.length === 1)
    expect(handlers.interruptedEvents[0]).toMatchObject({
      generatedText: 'Once upon a time',
      heardText: 'Once upon',
      textSpoken: 'Once upon',
      textRemaining: ' a time',
    })

    // A late text-delta for the superseded generation must not reach speak() again.
    respondChunks.push({ type: 'text-delta', index: 0, text: 'never spoken' })
    respondChunks.end()
    await Promise.resolve()
    await Promise.resolve()
    expect(tts.speak).toEqual(['Once upon a time'])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('falls back heardText to generatedText when the provider omits textSpoken (no playback offset)', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => respondChunks,
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'go on', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'text-delta', index: 0, text: 'a full reply' })
    await waitUntil(() => tts.speak.length === 1)
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitUntil(() => controller.currentState === 'speaking')

    // No textSpoken/textRemaining: the provider received interrupt() with no offset.
    tts.queue.push({
      type: 'turn-interrupted',
      audioPlayedMs: 0,
      metrics: { turnId: TURN_ID, audioDurationMs: 0, inputCharacterCount: 12, billableCharacterCount: 12 },
    })
    await waitUntil(() => handlers.interruptedEvents.length === 1)
    expect(handlers.interruptedEvents[0]).toMatchObject({ generatedText: 'a full reply', heardText: 'a full reply' })
    expect(handlers.interruptedEvents[0]?.textSpoken).toBeUndefined()

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('reportPlayed advances the shared PlaybackClock used for interrupt()', () => {
    const stt = makeStt()
    const tts = makeTts()
    const clock = new PlaybackClock()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: () => new AsyncEventQueue<StreamChunk>(),
      handlers: makeHandlers(),
    })
    controller.reportPlayed(1200)
    expect(clock.elapsedMs).toBe(1200)
  })

  it('forwards a fatal TTS error and a non-fatal warning to the handlers', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const warnings: unknown[] = []
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(),
      handlers: { ...handlers, onWarning: event => warnings.push(event) },
    })
    const run = controller.run()

    tts.queue.push({ type: 'warning', code: 'NO_ACTIVE_SPEECH', message: 'no active turn' })
    tts.queue.push({ type: 'error', code: 'PROTOCOL_ERROR', message: 'bad frame' })
    tts.queue.end()
    stt.queue.end()
    await run

    expect(warnings).toEqual([{ type: 'warning', code: 'NO_ACTIVE_SPEECH', message: 'no active turn' }])
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]).toMatchObject({ message: 'bad frame', code: 'PROTOCOL_ERROR' })
  })

  it('reports a real respond() failure that is not superseded by barge-in', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => {
        throw new Error('model unavailable')
      },
      handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => handlers.errors.length === 1)
    expect(handlers.errors[0]?.message).toBe('model unavailable')

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('a respond() rejection for a superseded (barged-in) generation is not reported as an error', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    let reject: ((error: unknown) => void) | undefined
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => (async function* (): AsyncGenerator<StreamChunk> {
        await new Promise<void>((_resolve, rej) => { reject = rej })
      })(),
      handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')

    // Barge in before the in-flight respond() ever settles.
    stt.queue.push({ type: 'turn', kind: 'started', turnIndex: 1, transcript: '', words: [], endOfTurnConfidence: 0, audioWindowStartSec: 1, audioWindowEndSec: 1 })
    await waitUntil(() => handlers.halted === 1)

    reject?.(new Error('aborted'))
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.errors).toEqual([])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('close() closes both sessions and is idempotent', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(),
      handlers: makeHandlers(),
    })
    const run = controller.run()
    stt.queue.end()
    tts.queue.end()
    await run
    await controller.close()
    await controller.close()
    expect(stt.closeMock).toHaveBeenCalledTimes(1)
    expect(tts.closeMock).toHaveBeenCalledTimes(1)
  })

  it('across two sequential natural turns, each response reconciles independently with no leaked generated-text state', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const responses = [new AsyncEventQueue<StreamChunk>(), new AsyncEventQueue<StreamChunk>()]
    let call = 0
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => responses[call++] as AsyncEventQueue<StreamChunk>,
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'first', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    responses[0]?.push({ type: 'text-delta', index: 0, text: 'first reply' })
    responses[0]?.end()
    await waitUntil(() => tts.flushCount() === 1)
    tts.queue.push({ type: 'turn-started', turnId: SpeechTurnId('turn-a') })
    await waitUntil(() => controller.currentState === 'speaking')
    tts.queue.push({ type: 'turn-completed', turnId: SpeechTurnId('turn-a'), audioDurationMs: 100, inputCharacterCount: 11, billableCharacterCount: 11 })
    await waitUntil(() => handlers.completedEvents.length === 1)
    expect(handlers.completedEvents[0]).toMatchObject({ generatedText: 'first reply' })

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 1, transcript: 'second', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 1, audioWindowEndSec: 2 })
    await waitUntil(() => controller.currentState === 'thinking')
    responses[1]?.push({ type: 'text-delta', index: 0, text: 'second reply' })
    responses[1]?.end()
    await waitUntil(() => tts.flushCount() === 2)
    tts.queue.push({ type: 'turn-started', turnId: SpeechTurnId('turn-b') })
    await waitUntil(() => controller.currentState === 'speaking')
    tts.queue.push({ type: 'turn-completed', turnId: SpeechTurnId('turn-b'), audioDurationMs: 100, inputCharacterCount: 12, billableCharacterCount: 12 })
    await waitUntil(() => handlers.completedEvents.length === 2)
    expect(handlers.completedEvents[1]).toMatchObject({ generatedText: 'second reply' })

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('ignores a non-turn STT event', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new SpeechAgentController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(),
      handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'connected', requestId: REQUEST_ID })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.currentState).toBe('listening')
    expect(handlers.errors).toEqual([])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('wraps a non-Error STT transport failure and a real Error STT transport failure', async () => {
    const sttA = makeStt()
    const ttsA = makeTts()
    const handlersA = makeHandlers()
    const controllerA = new SpeechAgentController({
      stt: sttA.session, tts: ttsA.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers: handlersA,
    })
    const runA = controllerA.run()
    sttA.queue.fail('a plain string failure')
    ttsA.queue.end()
    await runA
    expect(handlersA.errors).toHaveLength(1)
    expect(handlersA.errors[0]).toBeInstanceOf(Error)
    expect(handlersA.errors[0]?.message).toBe('a plain string failure')

    const sttB = makeStt()
    const ttsB = makeTts()
    const handlersB = makeHandlers()
    const controllerB = new SpeechAgentController({
      stt: sttB.session, tts: ttsB.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers: handlersB,
    })
    const runB = controllerB.run()
    sttB.queue.fail(new Error('real stt failure'))
    ttsB.queue.end()
    await runB
    expect(handlersB.errors).toEqual([expect.objectContaining({ message: 'real stt failure' })])
  })

  it('wraps a non-Error TTS transport failure and a real Error TTS transport failure', async () => {
    const sttA = makeStt()
    const ttsA = makeTts()
    const handlersA = makeHandlers()
    const controllerA = new SpeechAgentController({
      stt: sttA.session, tts: ttsA.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers: handlersA,
    })
    const runA = controllerA.run()
    sttA.queue.end()
    ttsA.queue.fail('a plain string failure')
    await runA
    expect(handlersA.errors).toHaveLength(1)
    expect(handlersA.errors[0]).toBeInstanceOf(Error)
    expect(handlersA.errors[0]?.message).toBe('a plain string failure')

    const sttB = makeStt()
    const ttsB = makeTts()
    const handlersB = makeHandlers()
    const controllerB = new SpeechAgentController({
      stt: sttB.session, tts: ttsB.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers: handlersB,
    })
    const runB = controllerB.run()
    sttB.queue.end()
    ttsB.queue.fail(new Error('real tts failure'))
    await runB
    expect(handlersB.errors).toEqual([expect.objectContaining({ message: 'real tts failure' })])
  })

  it('reports an unrecognized TTS event type via assertNever instead of silently dropping it', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers,
    })
    const run = controller.run()
    tts.queue.push({ type: 'not-a-real-event' } as unknown as TtsEvent)
    stt.queue.end()
    tts.queue.end()
    await run
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toMatch(/unreachable variant/)
  })

  it('a turn-completed/turn-interrupted with no prior turn-started reconciles with an empty generatedText', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(), handlers,
    })
    const run = controller.run()
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 0, inputCharacterCount: 0, billableCharacterCount: 0 })
    await waitUntil(() => handlers.completedEvents.length === 1)
    expect(handlers.completedEvents[0]).toMatchObject({ generatedText: '' })

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('a second turn-completed for an already-reconciled generation reads back an empty generatedText, not a leaked value', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => respondChunks, handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'text-delta', index: 0, text: 'reply' })
    respondChunks.end()
    await waitUntil(() => tts.flushCount() === 1)
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitUntil(() => controller.currentState === 'speaking')
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 100, inputCharacterCount: 5, billableCharacterCount: 5 })
    await waitUntil(() => handlers.completedEvents.length === 1)
    expect(handlers.completedEvents[0]).toMatchObject({ generatedText: 'reply' })

    // A second, duplicate turn-completed for the same (already-reconciled) generation: the map entry was already deleted.
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 100, inputCharacterCount: 5, billableCharacterCount: 5 })
    await waitUntil(() => handlers.completedEvents.length === 2)
    expect(handlers.completedEvents[1]).toMatchObject({ generatedText: '' })

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('ignores a non-text-delta response chunk without forwarding it to speak()', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => respondChunks, handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'block-start', index: 0, blockType: 'text' })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'ok' })
    respondChunks.end()
    await waitUntil(() => tts.flushCount() === 1)
    expect(tts.speak).toEqual(['ok'])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('a chunk that outlives its already-reconciled generation is dropped by speak() with no leaked accumulator', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => respondChunks, handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'text-delta', index: 0, text: 'first' })
    await waitUntil(() => tts.speak.length === 1)
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitUntil(() => controller.currentState === 'speaking')
    // The provider reports the turn complete before the (misbehaving) respond() stream stops sending deltas.
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 50, inputCharacterCount: 5, billableCharacterCount: 5 })
    await waitUntil(() => handlers.completedEvents.length === 1)
    expect(handlers.completedEvents[0]).toMatchObject({ generatedText: 'first' })

    // The same (not-yet-superseded) generation keeps streaming after its map entry was already deleted.
    respondChunks.push({ type: 'text-delta', index: 0, text: 'late' })
    await waitUntil(() => tts.speak.length === 2)
    expect(tts.speak).toEqual(['first', 'late'])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('does not flush() a response whose stream ends naturally after it was already superseded by barge-in', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => respondChunks, handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => controller.currentState === 'thinking')
    respondChunks.push({ type: 'text-delta', index: 0, text: 'partial' })
    await waitUntil(() => tts.speak.length === 1)

    stt.queue.push({ type: 'turn', kind: 'started', turnIndex: 1, transcript: '', words: [], endOfTurnConfidence: 0, audioWindowStartSec: 1, audioWindowEndSec: 1 })
    await waitUntil(() => handlers.halted === 1)
    respondChunks.end()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(tts.flushCount()).toBe(0)

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('reports a non-Error respond() rejection for a generation that is not superseded', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new SpeechAgentController({
      stt: stt.session, tts: tts.session, playbackClock: new PlaybackClock(),
      respond: () => (async function* (): AsyncGenerator<StreamChunk> {
        throw 'a plain string rejection'
      })(),
      handlers,
    })
    const run = controller.run()
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await waitUntil(() => handlers.errors.length === 1)
    expect(handlers.errors[0]).toBeInstanceOf(Error)
    expect(handlers.errors[0]?.message).toBe('a plain string rejection')

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })
})
