/**
 * The runnable local voice-agent demo, expressed as a deterministic
 * integration test rather than a long-running script: `examples/AGENTS.md`
 * reserves `examples/<leaf>/` for `cordis.yml` wiring plus e2e/snapshot
 * scenarios, so the full assembled loop — real `ctx.speech`
 * (`SpeechRuntime`), real `ctx.llm` (`LlmRuntime`), real
 * `SpeechAgentController`/`withSessionLogging`/`createLlmResponder`, wired
 * through real Cordis plugin composition — lives here, with only the
 * Deepgram Flux and DeepSeek network calls replaced by fake providers/
 * adapters implementing the exact same `@deepseek-ai/dsh-speech`/
 * `@deepseek-ai/dsh-llm` interfaces. This mirrors
 * `examples/headless-agent`'s keyless smoke, which substitutes a fake LLM
 * adapter for the same reason. `examples/speech-agent-demo/` carries the
 * production `cordis.yml` (real Deepgram Flux + DeepSeek) this test does
 * not exercise.
 * @module @deepseek-ai/dsh-speech-agent demo
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SpeechRuntime, { SpeechRequestId, SpeechTurnId } from '@deepseek-ai/dsh-speech'
import type {
  SttEvent,
  SttOpenOptions,
  SttProvider,
  SttSession,
  TtsEvent,
  TtsOpenOptions,
  TtsProvider,
  TtsSession,
} from '@deepseek-ai/dsh-speech'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AsyncEventQueue } from '../src/async-event-queue.ts'
import { PlaybackClock } from '../src/playback-clock.ts'
import { SpeechAgentController, type TurnControllerHandlers } from '../src/controller.ts'
import { withSessionLogging, projectConversationHistory } from '../src/session-log.ts'
import { createLlmResponder } from '../src/llm-responder.ts'

/** A fake Flux-shaped STT provider: the test drives its one open session's events directly. */
class FakeSttProvider implements SttProvider {
  session: SttSession | undefined
  queue: AsyncEventQueue<SttEvent> | undefined

  async connect(_options: SttOpenOptions): Promise<SttSession> {
    const queue = new AsyncEventQueue<SttEvent>()
    this.queue = queue
    this.session = {
      events: queue,
      sendAudio: () => {},
      configure: () => {},
      close: async () => { queue.end() },
    }
    return this.session
  }
}

/** A fake Flux-shaped TTS provider: speak()/flush() are recorded; the test scripts the reply events. */
class FakeTtsProvider implements TtsProvider {
  session: TtsSession | undefined
  queue: AsyncEventQueue<TtsEvent> | undefined
  readonly spoken: string[] = []
  readonly interrupts: Array<number | undefined> = []
  flushes = 0

  async connect(_options: TtsOpenOptions): Promise<TtsSession> {
    const queue = new AsyncEventQueue<TtsEvent>()
    this.queue = queue
    this.session = {
      events: queue,
      speak: text => this.spoken.push(text),
      flush: () => { this.flushes += 1 },
      interrupt: offset => this.interrupts.push(offset),
      configure: () => {},
      close: async () => { queue.end() },
    }
    return this.session
  }
}

/** A fake DeepSeek-shaped LLM adapter: one scripted reply per call, keyed by call order. */
class ScriptedLlmAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly scripts: string[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.scripts[this.requests.length - 1]
    if (reply === undefined) throw new Error('ScriptedLlmAdapter: script exhausted')
    for (const word of reply.split(' ')) {
      if (options.signal?.aborted) return
      yield { type: 'text-delta', index: 0, text: `${word} ` }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function waitUntil(predicate: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error(`waitUntil: condition not met after ${maxTicks} microtask ticks`)
}

describe('speech-agent local demo: full conversation loop against real ctx.speech/ctx.llm', () => {
  it('drives a natural turn, then a barge-in, through real plugin composition and durable history', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SpeechRuntime)

    const sttProvider = new FakeSttProvider()
    const ttsProvider = new FakeTtsProvider()
    ctx.speech.registerSttProvider('deepgram-flux', sttProvider)
    ctx.speech.registerTtsProvider('deepgram-flux', ttsProvider)

    const llmAdapter = new ScriptedLlmAdapter(['Hi there, how can I help?', 'Sure, the capital of'])
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek-official'], llmAdapter)

    const session = ctx.sessions.create(SessionId('speech-agent-demo'))

    const stt = await ctx.speech.openStt({ provider: 'deepgram-flux' })
    const tts = await ctx.speech.openTts({ provider: 'deepgram-flux' })
    const playbackClock = new PlaybackClock()

    const audioFrames: Uint8Array[] = []
    const errors: Error[] = []
    const baseHandlers: TurnControllerHandlers = {
      onTranscript: () => {},
      onAudio: chunk => audioFrames.push(chunk),
      onHaltPlayback: () => {},
      onSpeechInterrupted: () => {},
      onError: error => errors.push(error),
    }

    const respond = createLlmResponder(ctx.llm, transcript => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      messages: [
        ...projectConversationHistory(session),
        {
          id: 'live' as never,
          role: 'user',
          content: [{ type: 'text', text: transcript }],
          source: { kind: 'user' },
        },
      ],
    }))

    const controller = new SpeechAgentController({
      stt,
      tts,
      playbackClock,
      respond,
      handlers: withSessionLogging(session, baseHandlers),
    })
    const run = controller.run()

    // Turn 1: the user asks a question; the assistant answers in full.
    sttProvider.queue?.push({
      type: 'turn', kind: 'completed', turnIndex: 0, transcript: 'hello there',
      words: [], endOfTurnConfidence: 0.92, audioWindowStartSec: 0, audioWindowEndSec: 1,
    })
    await waitUntil(() => ttsProvider.flushes === 1)
    expect(ttsProvider.spoken.join('')).toBe('Hi there, how can I help? ')

    ttsProvider.queue?.push({ type: 'connected', requestId: SpeechRequestId('req-1'), modelName: 'flux-alexis-en' })
    ttsProvider.queue?.push({ type: 'turn-started', turnId: SpeechTurnId('turn-1') })
    await waitUntil(() => controller.currentState === 'speaking')
    ttsProvider.queue?.push({ type: 'audio', turnId: SpeechTurnId('turn-1'), data: new Uint8Array([1, 2]) })
    await waitUntil(() => audioFrames.length === 1)
    playbackClock.advance(1800) // the demo's playback sink reports what it actually rendered
    ttsProvider.queue?.push({
      type: 'turn-completed', turnId: SpeechTurnId('turn-1'),
      audioDurationMs: 1800, inputCharacterCount: 27, billableCharacterCount: 27,
    })
    await waitUntil(() => controller.currentState === 'listening')

    // Turn 2: the user barges in partway through the second answer.
    sttProvider.queue?.push({
      type: 'turn', kind: 'completed', turnIndex: 1, transcript: 'what is the capital of France',
      words: [], endOfTurnConfidence: 0.9, audioWindowStartSec: 1, audioWindowEndSec: 2,
    })
    await waitUntil(() => ttsProvider.flushes === 2)
    ttsProvider.queue?.push({ type: 'turn-started', turnId: SpeechTurnId('turn-2') })
    await waitUntil(() => controller.currentState === 'speaking')

    playbackClock.advance(600)
    sttProvider.queue?.push({
      type: 'turn', kind: 'started', turnIndex: 2, transcript: '',
      words: [], endOfTurnConfidence: 0, audioWindowStartSec: 2, audioWindowEndSec: 2,
    })
    await waitUntil(() => ttsProvider.interrupts.length === 1)
    // PlaybackClock is session-wide, not per-turn: turn 1's 1800ms plus this turn's 600ms.
    expect(ttsProvider.interrupts).toEqual([2400])
    ttsProvider.queue?.push({
      type: 'turn-interrupted',
      audioPlayedMs: 600,
      textSpoken: 'Sure, the capital',
      textRemaining: ' of',
      metrics: { turnId: SpeechTurnId('turn-2'), audioDurationMs: 600, inputCharacterCount: 20, billableCharacterCount: 20 },
    })
    await waitUntil(() => controller.currentState === 'listening')

    // Durable history reflects what was HEARD, not the full generation, for the interrupted turn.
    const history = projectConversationHistory(session)
    expect(history).toHaveLength(4)
    expect(history[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello there' }] })
    expect(history[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Hi there, how can I help? ' }] })
    expect(history[2]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'what is the capital of France' }] })
    expect(history[3]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Sure, the capital' }] })

    const reconciled = session.events.filter(event => event.type === 'speech-agent/response-reconciled')
    expect(reconciled).toHaveLength(2)
    expect(reconciled[0]?.data).toMatchObject({ interrupted: false, generatedText: 'Hi there, how can I help? ' })
    expect(reconciled[1]?.data).toMatchObject({
      interrupted: true,
      generatedText: 'Sure, the capital of ',
      heardText: 'Sure, the capital',
      remainingText: ' of',
    })
    expect(errors).toEqual([])

    await controller.close()
    await run
  })
})
