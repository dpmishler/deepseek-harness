import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AsyncEventQueue } from '../src/async-event-queue.ts'
import { PlaybackClock } from '../src/playback-clock.ts'
import { TurnController, type TurnControllerHandlers } from '../src/turn-controller.ts'
import { SpeechRequestId, SpeechTurnId } from '../src/brand.ts'
import type { SttEvent, SttSession, TtsEvent, TtsSession } from '../src/types.ts'

function makeStt(): { session: SttSession; queue: AsyncEventQueue<SttEvent> } {
  const queue = new AsyncEventQueue<SttEvent>()
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
  queue: AsyncEventQueue<TtsEvent>
  speak: string[]
  flushCount: () => number
  interrupts: Array<number | undefined>
} {
  const queue = new AsyncEventQueue<TtsEvent>()
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
      speak: (text) => speak.push(text),
      flush: () => { flushes += 1 },
      interrupt: (playbackOffsetMs) => interrupts.push(playbackOffsetMs),
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
  halted: number
} {
  const audio: Uint8Array[] = []
  const states: string[] = []
  const errors: Error[] = []
  const interruptedEvents: unknown[] = []
  let halted = 0
  return {
    audio,
    states,
    errors,
    interruptedEvents,
    get halted() { return halted },
    onStateChange: (state) => states.push(state),
    onTranscript: () => {},
    onAudio: (chunk) => audio.push(chunk),
    onHaltPlayback: () => { halted += 1 },
    onSpeechInterrupted: (event) => interruptedEvents.push(event),
    onTurnCompleted: () => {},
    onError: (error) => errors.push(error),
  }
}

const TURN_ID = SpeechTurnId('turn-1')
const REQUEST_ID = SpeechRequestId('req-1')

describe('TurnController', () => {
  it('streams a completed transcript response into speak() calls, then flushes and returns to listening', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const respondChunks = new AsyncEventQueue<StreamChunk>()
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => respondChunks,
      handlers,
    })
    const run = controller.run()

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hello there', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await Promise.resolve()
    expect(controller.currentState).toBe('thinking')

    respondChunks.push({ type: 'text-delta', index: 0, text: 'Hi ' })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'there!' })
    respondChunks.end()
    await Promise.resolve()
    await Promise.resolve()
    expect(tts.speak).toEqual(['Hi ', 'there!'])
    expect(tts.flushCount()).toBe(1)

    tts.queue.push({ type: 'connected', requestId: REQUEST_ID, modelName: 'flux-alexis-en' })
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await Promise.resolve()
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

    await controller.close()
    await run
  })

  it('barges in when a new STT turn starts while speaking: halts playback, aborts the LLM, and sends the session-wide playback offset', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const handlers = makeHandlers()
    const clock = new PlaybackClock()
    let capturedSignal: AbortSignal | undefined
    const respondChunks = new AsyncEventQueue<StreamChunk>()
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

    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'tell me a story', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    respondChunks.push({ type: 'text-delta', index: 0, text: 'Once upon a time' })
    await Promise.resolve()
    await Promise.resolve()
    tts.queue.push({ type: 'turn-started', turnId: TURN_ID })
    await Promise.resolve()
    expect(controller.currentState).toBe('speaking')

    // The listener has actually heard 2340ms of session audio when they barge in.
    clock.advance(2340)
    stt.queue.push({ type: 'turn', kind: 'started', turnIndex: 1, transcript: '', words: [], endOfTurnConfidence: 0, audioWindowStartSec: 1, audioWindowEndSec: 1 })
    await Promise.resolve()

    expect(handlers.halted).toBe(1)
    expect(tts.interrupts).toEqual([2340])
    expect(capturedSignal?.aborted).toBe(true)
    expect(controller.currentState).toBe('listening')

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

    await controller.close()
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
    const controller = new TurnController({
      stt: stt.session,
      tts: tts.session,
      playbackClock: new PlaybackClock(),
      respond: () => new AsyncEventQueue<StreamChunk>(),
      handlers: { ...handlers, onWarning: (event) => warnings.push(event) },
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
    stt.queue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hi', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.errors).toHaveLength(1)
    expect(handlers.errors[0]?.message).toBe('model unavailable')

    await controller.close()
    stt.queue.end()
    tts.queue.end()
    await run
  })

  it('close() closes both sessions and is idempotent', async () => {
    const stt = makeStt()
    const tts = makeTts()
    const controller = new TurnController({
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
    expect(stt.session.close).toHaveBeenCalledTimes(1)
    expect(tts.session.close).toHaveBeenCalledTimes(1)
  })
})
