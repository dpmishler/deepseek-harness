/**
 * Voice capability seam: `ctx.voice` is a provider registry plus an
 * open-session API for streaming speech-to-text and text-to-speech,
 * analogous in shape to `ctx.llm` (`@deepseek-ai/dsh-llm`) but for audio.
 * Register provider implementations with `registerSttProvider` /
 * `registerTtsProvider`; open sessions with `openStt` / `openTts`.
 *
 * `./consumer` (a separate module, never mixed into this default-exporting
 * barrel — see the default-export/function-plugin postmortem) wires an open
 * STT session, an open TTS session, and a streaming LLM responder into
 * {@link TurnController}, the turn state machine that drives barge-in.
 * @module @deepseek-ai/dsh-voice
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { VoiceError } from './error.ts'
import type { SttOpenOptions, SttProvider, SttSession, TtsOpenOptions, TtsProvider, TtsSession } from './types.ts'

export * from './brand.ts'
export * from './error.ts'
export * from './types.ts'
export { AsyncEventQueue } from './async-event-queue.ts'
export { PlaybackClock } from './playback-clock.ts'
export { TurnController } from './turn-controller.ts'
export type { TurnControllerHandlers, TurnControllerOptions, TurnState } from './turn-controller.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    voice: VoiceRuntime
  }
}

/** The `voice` service: STT/TTS provider registries plus a session-opening API. */
export class VoiceRuntime extends Service {
  private readonly sttProviders = new Map<string, SttProvider>()
  private readonly ttsProviders = new Map<string, TtsProvider>()

  /** @param ctx - Cordis context that owns the service. */
  constructor(ctx: Context) {
    super(ctx, 'voice')
  }

  /**
   * Register an STT provider under `id`. Disposed with the fiber.
   * @param id - provider id, matched against `SttOpenOptions.provider`.
   * @param provider - the adapter that opens sessions for this id.
   * @returns the disposer; call it to withdraw the registration.
   * @throws {@link VoiceError} (`VOICE_DUPLICATE_PROVIDER`) if `id` is already registered, or (`VOICE_INVALID_PROVIDER`) if `id` is empty.
   */
  registerSttProvider(id: string, provider: SttProvider): () => void {
    if (id.length === 0) throw new VoiceError('an STT provider id must be non-empty', 'VOICE_INVALID_PROVIDER')
    if (this.sttProviders.has(id)) {
      throw new VoiceError(`an STT provider is already registered for id "${id}"`, 'VOICE_DUPLICATE_PROVIDER')
    }
    return this.ctx.effect(() => {
      this.sttProviders.set(id, provider)
      return () => {
        this.sttProviders.delete(id)
      }
    }, `voice.registerSttProvider(${id})`)
  }

  /**
   * Register a TTS provider under `id`. Disposed with the fiber.
   * @param id - provider id, matched against `TtsOpenOptions.provider`.
   * @param provider - the adapter that opens sessions for this id.
   * @returns the disposer; call it to withdraw the registration.
   * @throws {@link VoiceError} (`VOICE_DUPLICATE_PROVIDER`) if `id` is already registered, or (`VOICE_INVALID_PROVIDER`) if `id` is empty.
   */
  registerTtsProvider(id: string, provider: TtsProvider): () => void {
    if (id.length === 0) throw new VoiceError('a TTS provider id must be non-empty', 'VOICE_INVALID_PROVIDER')
    if (this.ttsProviders.has(id)) {
      throw new VoiceError(`a TTS provider is already registered for id "${id}"`, 'VOICE_DUPLICATE_PROVIDER')
    }
    return this.ctx.effect(() => {
      this.ttsProviders.set(id, provider)
      return () => {
        this.ttsProviders.delete(id)
      }
    }, `voice.registerTtsProvider(${id})`)
  }

  /** Currently registered STT provider ids, in registration order. */
  listSttProviders(): string[] {
    return [...this.sttProviders.keys()]
  }

  /** Currently registered TTS provider ids, in registration order. */
  listTtsProviders(): string[] {
    return [...this.ttsProviders.keys()]
  }

  /**
   * Open a speech-to-text session.
   * @param options - session parameters; `options.provider` selects the registered adapter.
   * @throws {@link VoiceError} (`VOICE_PROVIDER_NOT_REGISTERED`) if no provider is registered for `options.provider`.
   */
  openStt(options: SttOpenOptions): Promise<SttSession> {
    const provider = this.sttProviders.get(options.provider)
    if (provider === undefined) {
      throw new VoiceError(`no STT provider is registered for id "${options.provider}"`, 'VOICE_PROVIDER_NOT_REGISTERED')
    }
    return provider.connect(options)
  }

  /**
   * Open a text-to-speech session.
   * @param options - session parameters; `options.provider` selects the registered adapter.
   * @throws {@link VoiceError} (`VOICE_PROVIDER_NOT_REGISTERED`) if no provider is registered for `options.provider`.
   */
  openTts(options: TtsOpenOptions): Promise<TtsSession> {
    const provider = this.ttsProviders.get(options.provider)
    if (provider === undefined) {
      throw new VoiceError(`no TTS provider is registered for id "${options.provider}"`, 'VOICE_PROVIDER_NOT_REGISTERED')
    }
    return provider.connect(options)
  }
}

export default VoiceRuntime
