/**
 * Keyless real-composition smoke: boots the actual `cordis.yml` through the
 * real Loader, then drives one full voice turn (transcript -> LLM response ->
 * TTS audio -> completion) plus one barge-in, using fake STT/TTS providers
 * registered directly on the real `ctx.speech` in place of Deepgram — the
 * expensive, non-deterministic network boundary — and a locally scripted
 * `respond()` in place of a real model call, per the with-key e2e policy in
 * docs/testing.md ("mock only the expensive or non-deterministic boundary").
 * Everything else — `ctx.speech` registration/dispatch, `TurnController`,
 * and the durable `speech-agent/*` session log — is real.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type { SttEvent, SttOpenOptions, SttProvider, SttSession, TtsEvent, TtsOpenOptions, TtsProvider, TtsSession } from '@deepseek-ai/dsh-speech'
import { PlaybackClock, TurnController } from '@deepseek-ai/dsh-speech-agent'
import type { TurnControllerHandlers } from '@deepseek-ai/dsh-speech-agent'
import { withSessionLogging } from '@deepseek-ai/dsh-speech-agent/src/consumer.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootVoiceAgent } from './harness.ts'

/** Minimal single-consumer async queue for scripting fake session events in this test. */
class Queue<T> implements AsyncIterable<T> {
  private buffered: T[] = []
  private waiting: ((r: IteratorResult<T>) => void) | undefined
  private ended = false

  push(value: T): void {
    if (this.waiting !== undefined) { const r = this.waiting; this.waiting = undefined; r({ value, done: false }) }
    else this.buffered.push(value)
  }

  end(): void {
    if (this.waiting !== undefined) { const r = this.waiting; this.waiting = undefined; r({ value: undefined, done: true }) }
    else this.ended = true
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) return Promise.resolve({ value: this.buffered.shift() as T, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => { this.waiting = resolve })
      },
    }
  }
}

async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error(`waitFor: condition did not become true within ${maxTicks} ticks`)
}

function registerFakes(
  ctx: Context,
  sttQueue: Queue<SttEvent>,
  ttsQueue: Queue<TtsEvent>,
  ttsCalls: { speak: string[]; flushes: number; interrupts: (number | undefined)[] },
): void {
  const sttProvider: SttProvider = {
    connect: (_options: SttOpenOptions): Promise<SttSession> => Promise.resolve({
      events: sttQueue,
      sendAudio: () => {},
      configure: () => {},
      close: () => { sttQueue.push({ type: 'closed' }); sttQueue.end(); return Promise.resolve() },
    }),
  }
  const ttsProvider: TtsProvider = {
    connect: (_options: TtsOpenOptions): Promise<TtsSession> => Promise.resolve({
      events: ttsQueue,
      speak: (text: string) => ttsCalls.speak.push(text),
      flush: () => { ttsCalls.flushes += 1 },
      interrupt: (offset?: number) => ttsCalls.interrupts.push(offset),
      configure: () => {},
      close: () => { ttsQueue.push({ type: 'closed' }); ttsQueue.end(); return Promise.resolve() },
    }),
  }
  ctx.speech.registerSttProvider('fake', sttProvider)
  ctx.speech.registerTtsProvider('fake', ttsProvider)
}

describe('voice-agent example (keyless)', () => {
  it('boots the real cordis.yml, streams a scripted response into TTS, and logs the durable transcript', async () => {
    const booted = await bootVoiceAgent()
    try {
      const { ctx } = booted
      const sttQueue = new Queue<SttEvent>()
      const ttsQueue = new Queue<TtsEvent>()
      const ttsCalls = { speak: [] as string[], flushes: 0, interrupts: [] as (number | undefined)[] }
      registerFakes(ctx, sttQueue, ttsQueue, ttsCalls)

      const stt = await ctx.speech.openStt({ provider: 'fake' })
      const tts = await ctx.speech.openTts({ provider: 'fake' })
      const session = ctx.sessions.create(SessionId('voice-agent-keyless-smoke'))

      const audioChunks: Uint8Array[] = []
      const states: string[] = []
      const handlers: TurnControllerHandlers = {
        onStateChange: state => states.push(state),
        onTranscript: () => {},
        onResponseGenerated: () => {},
        onAudio: chunk => audioChunks.push(chunk),
        onHaltPlayback: () => {},
        onSpeechInterrupted: () => {},
        onError: (error) => { throw error },
      }
      const controller = new TurnController({
        stt,
        tts,
        playbackClock: new PlaybackClock(),
        respond: (transcript): AsyncIterable<StreamChunk> => {
          const chunks = new Queue<StreamChunk>()
          chunks.push({ type: 'text-delta', index: 0, text: `Echo: ${transcript}` })
          queueMicrotask(() => { chunks.push({ type: 'finish', reason: { kind: 'stop' } }) })
          return chunks
        },
        handlers: withSessionLogging(session, handlers),
      })
      const run = controller.run()

      sttQueue.push({
        type: 'turn',
        kind: 'completed',
        turnIndex: 0,
        transcript: 'hello voice agent',
        words: [],
        endOfTurnConfidence: 0.92,
        audioWindowStartSec: 0,
        audioWindowEndSec: 1.2,
      })
      await waitFor(() => ttsCalls.speak.length > 0)
      expect(ttsCalls.speak).toEqual(['Echo: hello voice agent'])

      const turnId = SpeechTurnId('turn-1')
      ttsQueue.push({ type: 'turn-started', turnId })
      const chunk = new Uint8Array([1, 2, 3, 4])
      ttsQueue.push({ type: 'audio', turnId, data: chunk })
      await waitFor(() => audioChunks.length > 0)
      expect(audioChunks).toEqual([chunk])

      ttsQueue.push({ type: 'turn-completed', turnId, audioDurationMs: 400, inputCharacterCount: 22, billableCharacterCount: 22 })
      await waitFor(() => states.includes('listening') && states.filter(s => s === 'listening').length >= 2)

      const transcriptEvents = session.events.filter(event => event.type === 'speech-agent/transcript')
      expect(transcriptEvents).toHaveLength(1)
      expect(transcriptEvents[0]?.data).toMatchObject({ transcript: 'hello voice agent' })
      const completedEvents = session.events.filter(event => event.type === 'speech-agent/turn-completed')
      expect(completedEvents).toHaveLength(1)

      await controller.close()
      await stt.close()
      await tts.close()
      await run
    } finally {
      await booted.dispose()
    }
  })

  it('barges in on a new STT turn while speaking: halts playback and sends the session-wide offset', async () => {
    const booted = await bootVoiceAgent()
    try {
      const { ctx } = booted
      const sttQueue = new Queue<SttEvent>()
      const ttsQueue = new Queue<TtsEvent>()
      const ttsCalls = { speak: [] as string[], flushes: 0, interrupts: [] as (number | undefined)[] }
      registerFakes(ctx, sttQueue, ttsQueue, ttsCalls)

      const stt = await ctx.speech.openStt({ provider: 'fake' })
      const tts = await ctx.speech.openTts({ provider: 'fake' })
      const clock = new PlaybackClock()
      let halted = 0
      const controller = new TurnController({
        stt,
        tts,
        playbackClock: clock,
        respond: (): AsyncIterable<StreamChunk> => new Queue<StreamChunk>(),
        handlers: {
          onTranscript: () => {},
          onResponseGenerated: () => {},
          onAudio: () => {},
          onHaltPlayback: () => { halted += 1 },
          onSpeechInterrupted: () => {},
          onError: (error) => { throw error },
        },
      })
      const run = controller.run()

      sttQueue.push({ type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'tell me a long story', words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 0, audioWindowEndSec: 1 })
      const turnId = SpeechTurnId('turn-1')
      ttsQueue.push({ type: 'turn-started', turnId })
      await waitFor(() => controller.currentState === 'speaking')

      clock.advance(1800)
      sttQueue.push({ type: 'turn', kind: 'started', turnIndex: 1, transcript: '', words: [], endOfTurnConfidence: 0, audioWindowStartSec: 1, audioWindowEndSec: 1 })
      await waitFor(() => halted === 1)

      expect(ttsCalls.interrupts).toEqual([1800])
      expect(controller.currentState).toBe('listening')

      await controller.close()
      await stt.close()
      await tts.close()
      await run
    } finally {
      await booted.dispose()
    }
  })
})
