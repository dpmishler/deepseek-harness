import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SpeechRequestId, SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { SttEvent, SttSession, TtsEvent, TtsSession } from '@deepseek-ai/dsh-speech'
import { PlaybackClock } from '../src/playback-clock.ts'
import { TurnController } from '../src/turn-controller.ts'
import type { TurnControllerHandlers } from '../src/turn-controller.ts'
import { TestEventQueue as Queue, waitFor } from './support.ts'

/** Build one `SttTurnEvent` for `started`/`completed`, defaulting the audio window to `[turnIndex, turnIndex + 1)`. */
function sttTurnEvent(
  kind: 'started' | 'completed',
  options: { turnIndex: number; transcript?: string; endOfTurnConfidence?: number; windowStartSec?: number; windowEndSec?: number },
): SttEvent {
  return {
    type: 'turn',
    kind,
    turnIndex: options.turnIndex,
    transcript: options.transcript ?? '',
    words: [],
    endOfTurnConfidence: options.endOfTurnConfidence ?? (kind === 'completed' ? 0.9 : 0),
    audioWindowStartSec: options.windowStartSec ?? options.turnIndex,
    audioWindowEndSec: options.windowEndSec ?? options.turnIndex + 1,
  }
}

function makeStt(): { session: SttSession; queue: Queue<SttEvent> } {
  const queue = new Queue<SttEvent>()
  return {
    queue,
    session: {
      events: queue,
      sendAudio: () => {},
      configure: () => {},
      close: vi.fn(async () => {}),
    },
  }
}

function makeTts(): {
  session: TtsSession
  queue: Queue<TtsEvent>
  speak: string[]
  flushCount: () => number
  interrupts: Array<number | undefined>
} {
  const queue = new Queue<TtsEvent>()
  const speak: string[] = []
  const interrupts: Array<number | undefined> = []
  let flushes = 0
  return {
    queue,
    speak,
    flushCount: () => flushes,
    interrupts,
    session: {
      events: queue,
      speak: text => speak.push(text),
      flush: () => { flushes += 1 },
      interrupt: playbackOffsetMs => interrupts.push(playbackOffsetMs),
      configure: () => {},
      close: vi.fn(async () => {}),
    },
  }
}

function makeHandlers(): TurnControllerHandlers & {
  audio: Uint8Array[]
  states: string[]
  errors: Error[]
  interruptedEvents: unknown[]
  generatedResponses: Array<{ generation: number; text: string }>
  transcriptGenerations: number[]
  halted: number
} {
  const audio: Uint8Array[] = []
  const states: string[] = []
  const errors: Error[] = []
  const interruptedEvents: unknown[] = []
  const generatedResponses: Array<{ generation: number; text: string }> = []
  const transcriptGenerations: number[] = []
  let halted = 0
  return {
    audio,
    states,
    errors,
    interruptedEvents,
    generatedResponses,
    transcriptGenerations,
    get halted() { return halted },
    onStateChange: state => states.push(state),
    onTranscript: (_turn, generation) => transcriptGenerations.push(generation),
    onResponseGenerated: (generation, text) => generatedResponses.push({ generation, text }),
    onAudio: chunk => audio.push(chunk),
    onHaltPlayback: () => { halted += 1 },
    onSpeechInterrupted: event => interruptedEvents.push(event),
    onTurnCompleted: () => {},
    onError: error => errors.push(error),
  }
}

const TURN_ID = SpeechTurnId('turn-1')
const REQUEST_ID = SpeechRequestId('req-1')

describe('TurnController', () => {
  it('streams a completed transcript response into speak() calls, then flushes and returns to listening', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new Queue<StreamChunk>()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => respondChunks,
      handlers,
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'hello there' }))
    await Promise.resolve()
    expect(controller.currentState).toBe('thinking')
    expect(handlers.transcriptGenerations).toEqual([1])

    respondChunks.push({ type: 'text-delta', index: 0, text: 'Hi ' })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'there!' })
    respondChunks.end()
    await waitFor(() => tts.flushCount() === 1)
    expect(tts.speak).toEqual(['Hi ', 'there!'])
    expect(handlers.generatedResponses).toEqual([{ generation: 1, text: 'Hi there!' }])

    tts.queue.push({ type: 'connected', requestId: REQUEST_ID, modelName: 'flux-alexis-en' })
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await waitFor(() => controller.currentState === 'speaking')
    expect(controller.currentState).toBe('speaking')

    const chunk = new Uint8Array([1, 2, 3])
    tts.queue.push({ type: 'audio', turnId: TURN_ID, data: chunk })
    await Promise.resolve()
    expect(handlers.audio).toEqual([chunk])

    tts.queue.push({
      type: 'turn-completed',
      turnId: TURN_ID,
      audioDurationMs: 500,
      inputCharacterCount: 10,
      billableCharacterCount: 10,
    })
    await Promise.resolve()
    expect(controller.currentState).toBe('listening')
    expect(handlers.states).toEqual(['listening', 'thinking', 'speaking', 'listening'])

    stt.queue.end()
    tts.queue.end()
    await controller.close()
    await run
  })

  it('barges in when a new STT turn starts while speaking: halts playback, aborts the LLM, reconciles the generated text, and sends the offset', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    let capturedSignal: AbortSignal | undefined
    const respondChunks = new Queue<StreamChunk>()
    const controller = new TurnController({
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

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'tell me a story' }))
    respondChunks.push({ type: 'text-delta', index: 0, text: 'Once upon a time' })
    await Promise.resolve()
    await Promise.resolve()
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await Promise.resolve()
    expect(controller.currentState).toBe('speaking')

    // The listener has actually heard 2340ms of session audio when they barge in.
    clock.advance(2340)
    stt.queue.push(sttTurnEvent('started', { turnIndex: 1, windowEndSec: 1 }))
    await Promise.resolve()

    expect(handlers.halted).toBe(1)
    expect(tts.interrupts).toEqual([2340])
    expect(capturedSignal?.aborted).toBe(true)
    expect(controller.currentState).toBe('listening')
    // The superseded generation's partial text is reconciled immediately, at barge-in time.
    expect(handlers.generatedResponses).toEqual([{ generation: 1, text: 'Once upon a time' }])

    // Audio that was already in flight for the cancelled turn must be discarded, not delivered.
    tts.queue.push({ type: 'audio', turnId: TURN_ID, data: new Uint8Array([9]) })
    await Promise.resolve()
    expect(handlers.audio).toEqual([])
    expect(controller.discardedFrameCount).toBe(1)

    tts.queue.push({
      type: 'turn-interrupted',
      audioPlayedMs: 2340,
      textSpoken: 'Once upon',
      textRemaining: ' a time',
      metrics: { turnId: TURN_ID, audioDurationMs: 2340, inputCharacterCount: 17, billableCharacterCount: 17 },
    })
    await Promise.resolve()
    expect(handlers.interruptedEvents).toHaveLength(1)

    // A late text-delta for the superseded generation must not reach speak() again.
    respondChunks.push({ type: 'text-delta', index: 0, text: 'never spoken' })
    respondChunks.end()
    await Promise.resolve()
    expect(tts.speak).toEqual(['Once upon a time'])

    stt.queue.end()
    tts.queue.end()
    await controller.close()
    await run
  })

  it('race: two barge-ins in a row with no playback progress between them send only one valid offset', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: () => new Queue<StreamChunk>(),
      handlers,
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'a' }))
    await Promise.resolve()
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await Promise.resolve()
    clock.advance(1000)

    // First barge-in: still `thinking`->`speaking` (turn-started already
    // arrived above), consumes the clock's only advance.
    stt.queue.push(sttTurnEvent('started', { turnIndex: 1, windowEndSec: 1 }))
    await Promise.resolve()
    expect(tts.interrupts).toEqual([1000])

    // Second barge-in immediately after: a new response generation started
    // and is already `thinking`/`speaking` again with no new `advance()` —
    // Flux TTS would reject a repeated offset, so the controller must omit it.
    stt.queue.push(sttTurnEvent('completed', { turnIndex: 1, transcript: 'b' }))
    await Promise.resolve()
    tts.queue.push({ type: 'turn-started', turnId: SpeechTurnId('turn-2') })
    await Promise.resolve()
    stt.queue.push(sttTurnEvent('started', { turnIndex: 2, windowEndSec: 2 }))
    await Promise.resolve()
    expect(tts.interrupts).toEqual([1000, undefined])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('reportPlayed advances the shared PlaybackClock used for interrupt()', () => {
    const stt = makeStt()
    const tts = makeTts()
    const clock = new PlaybackClock()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: () => new Queue<StreamChunk>(),
      handlers: makeHandlers(),
    })
    controller.reportPlayed(1200)
    expect(clock.elapsedMs).toBe(1200)
  })

  it('correlates onTurnCompleted with the response generation that produced it', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const completed: number[] = []
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers: { ...handlers, onTurnCompleted: (_event, generation) => completed.push(generation) },
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'hi' }))
    await Promise.resolve()
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await Promise.resolve()
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 100, inputCharacterCount: 2, billableCharacterCount: 2 })
    await Promise.resolve()
    expect(completed).toEqual([1])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('forwards a fatal TTS error and a non-fatal warning to the handlers', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const warnings: unknown[] = []
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
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
    expect(handlers.errors[0]).toMatchObject({ message: 'bad frame' })
  })

  it('reports a real respond() failure that is not superseded by barge-in', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => {
        throw new Error('model unavailable')
      },
      handlers,
    })
    const run = controller.run()
    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'hi' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toBe('model unavailable')

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('surfaces a non-Error stt pump failure and a non-Error tts pump failure', async () => {
    const failingStt: SttSession = {
      events: {
        [Symbol.asyncIterator]() {
          return {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection is the point of this test.
            next: (): Promise<IteratorResult<SttEvent>> => Promise.reject('stt boom'),
          }
        },
      },
      sendAudio: () => {},
      configure: () => {},
      close: async () => {},
    }
    const failingTts: TtsSession = {
      events: {
        [Symbol.asyncIterator]() {
          return {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection is the point of this test.
            next: (): Promise<IteratorResult<TtsEvent>> => Promise.reject('tts boom'),
          }
        },
      },
      speak: () => {},
      flush: () => {},
      interrupt: () => {},
      configure: () => {},
      close: async () => {},
    }
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: failingStt,
      tts: failingTts,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers,
    })
    await controller.run()
    expect(handlers.errors.map(error => error.message)).toEqual(['stt boom', 'tts boom'])
  })

  it('close() closes both sessions and is idempotent', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers: makeHandlers(),
    })
    const run = controller.run()
    stt.queue.end()
    tts.queue.end()
    await run
    await controller.close()
    await controller.close()
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock reference, never called unbound.
    expect(stt.session.close).toHaveBeenCalledTimes(1)
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock reference, never called unbound.
    expect(tts.session.close).toHaveBeenCalledTimes(1)
  })

  it('ignores a non-turn STT event (connected/error/closed) rather than treating it as a turn boundary', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'connected', requestId: REQUEST_ID })
    await Promise.resolve()
    expect(controller.currentState).toBe('listening')
    expect(handlers.transcriptGenerations).toEqual([])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('wraps a real Error thrown from the STT event stream', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers,
    })
    const run = controller.run()
    stt.queue.fail(new Error('stt transport dropped'))
    tts.queue.end()
    await run
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toBe('stt transport dropped')
  })

  it('reports onTurnCompleted/onSpeechInterrupted with a fallback generation when no turn-started preceded them', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const completed: number[] = []
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers: { ...handlers, onTurnCompleted: (_event, generation) => completed.push(generation) },
    })
    const run = controller.run()

    // A `turn-completed`/`turn-interrupted` with no prior `turn-started` is a
    // protocol anomaly Flux TTS should never produce, but the controller
    // still attributes it (best effort) to the current generation instead of
    // crashing the conversation.
    tts.queue.push({ type: 'turn-completed', turnId: TURN_ID, audioDurationMs: 10, inputCharacterCount: 1, billableCharacterCount: 1 })
    await Promise.resolve()
    expect(completed).toEqual([0])
    expect(handlers.interruptedEvents).toEqual([])

    tts.queue.push({
      type: 'turn-interrupted',
      audioPlayedMs: 0,
      metrics: { turnId: TURN_ID, audioDurationMs: 0, inputCharacterCount: 0, billableCharacterCount: 0 },
    })
    await Promise.resolve()
    expect(handlers.interruptedEvents).toHaveLength(1)

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('drops an unrecognized future TTS event type instead of crashing, surfacing it as an error', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new Queue<StreamChunk>(),
      handlers,
    })
    const run = controller.run()

    tts.queue.push({ type: 'future-event' } as unknown as TtsEvent)
    await Promise.resolve()
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toMatch(/unreachable variant/)

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('ignores a non-text-delta StreamChunk (e.g. usage) without forwarding it to speak()', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new Queue<StreamChunk>()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => respondChunks,
      handlers,
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'hi' }))
    await Promise.resolve()
    respondChunks.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'hello' })
    respondChunks.end()
    await Promise.resolve()
    await Promise.resolve()
    expect(tts.speak).toEqual(['hello'])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('drops a response stream that finishes naturally after already being superseded by barge-in', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    const staleRespond = new Queue<StreamChunk>()
    let calls = 0
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: () => {
        calls += 1
        return calls === 1 ? staleRespond : new Queue<StreamChunk>()
      },
      handlers,
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'a' }))
    await Promise.resolve()
    expect(controller.currentState).toBe('thinking')
    // Barge in before the stale stream ever produced a turn-started (state 'thinking').
    stt.queue.push(sttTurnEvent('started', { turnIndex: 1, windowEndSec: 1 }))
    await Promise.resolve()
    expect(handlers.halted).toBe(1)

    // The stale generation's respond() stream finishes naturally (no abort
    // enforcement inside this fake) with no further chunks, AFTER supersession.
    staleRespond.end()
    await Promise.resolve()
    expect(tts.flushCount()).toBe(0)

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('drops a stale response stream failure after supersession without reporting it as an error', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    const staleRespond = new Queue<StreamChunk>()
    let calls = 0
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: clock,
      respond: () => {
        calls += 1
        return calls === 1 ? staleRespond : new Queue<StreamChunk>()
      },
      handlers,
    })
    const run = controller.run()

    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'a' }))
    await Promise.resolve()
    stt.queue.push(sttTurnEvent('started', { turnIndex: 1, windowEndSec: 1 }))
    await Promise.resolve()
    expect(handlers.halted).toBe(1)

    // The aborted fetch/stream rejects after supersession — a real respond()
    // whose AbortSignal handling surfaces the abort as a rejection.
    staleRespond.fail(new Error('aborted'))
    await Promise.resolve()
    expect(handlers.errors).toEqual([])

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('reports a real respond() failure with a non-Error value that is not superseded by barge-in', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => {
        throw 'model down'
      },
      handlers,
    })
    const run = controller.run()
    stt.queue.push(sttTurnEvent('completed', { turnIndex: 0, transcript: 'hi' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toBe('model down')

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })
})
