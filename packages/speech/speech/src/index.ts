/**
 * Service Definition for the speech capability seam (`ctx.speech`): STT and
 * TTS provider registries, keyed by a caller-chosen provider id. Unlike
 * `ctx.web`, session-opening calls never auto-select or resolve ambiguity —
 * every {@link SttOpenOptions.provider} / {@link TtsOpenOptions.provider} is
 * mandatory, so `openStt()`/`openTts()` either dispatch to that exact
 * registered provider or throw `SPEECH_PROVIDER_NOT_REGISTERED`.
 * @module @deepseek-ai/dsh-speech
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { SpeechError } from './types.ts'
import type { SttOpenOptions, SttProvider, SttSession, TtsOpenOptions, TtsProvider, TtsSession } from './types.ts'

export * from './brand.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Speech capability service: STT and TTS provider registries, dispatched by explicit provider id. */
    speech: SpeechRuntime
  }
}

/** A registry keyed by provider id, shared shape for the STT and TTS sides of the seam. */
interface ProviderRegistry<P> {
  readonly providers: Map<string, P>
  readonly kind: 'STT' | 'TTS'
}

/**
 * The speech capability service (`ctx.speech`). Holds two independent
 * provider-id registries — STT and TTS share no namespace — and dispatches
 * `openStt()`/`openTts()` straight to the id named in the request.
 */
export class SpeechRuntime extends Service {
  private readonly sttProviders = new Map<string, SttProvider>()
  private readonly ttsProviders = new Map<string, TtsProvider>()

  /** @param ctx - Cordis context (injected). */
  constructor(ctx: Context) {
    super(ctx, 'speech')
  }

  /**
   * Register an STT provider under `id`. Throws {@link SpeechError}
   * `SPEECH_DUPLICATE_PROVIDER` if `id` is already registered for STT.
   * @param id - stable id; callers pass this as {@link SttOpenOptions.provider}.
   * @param provider - the provider adapter.
   * @returns disposer that removes the registration immediately when called; also disposed with the calling fiber.
   */
  registerSttProvider(id: string, provider: SttProvider): () => void {
    return this.registerProvider({ providers: this.sttProviders, kind: 'STT' }, id, provider)
  }

  /**
   * Register a TTS provider under `id`. Throws {@link SpeechError}
   * `SPEECH_DUPLICATE_PROVIDER` if `id` is already registered for TTS.
   * @param id - stable id; callers pass this as {@link TtsOpenOptions.provider}.
   * @param provider - the provider adapter.
   * @returns disposer that removes the registration immediately when called; also disposed with the calling fiber.
   */
  registerTtsProvider(id: string, provider: TtsProvider): () => void {
    return this.registerProvider({ providers: this.ttsProviders, kind: 'TTS' }, id, provider)
  }

  private registerProvider<P>(registry: ProviderRegistry<P>, id: string, provider: P): () => void {
    if (registry.providers.has(id)) {
      throw new SpeechError(
        `${registry.kind} provider id "${id}" is already registered`,
        'SPEECH_DUPLICATE_PROVIDER',
      )
    }
    const dispose = this.ctx.effect(function* () {
      registry.providers.set(id, provider)
      yield () => registry.providers.delete(id)
    }, `speech.register${registry.kind}Provider()`)
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * List registered STT provider ids in registration order.
   * @returns snapshot of registered STT provider ids.
   */
  listSttProviders(): string[] {
    return Array.from(this.sttProviders.keys())
  }

  /**
   * List registered TTS provider ids in registration order.
   * @returns snapshot of registered TTS provider ids.
   */
  listTtsProviders(): string[] {
    return Array.from(this.ttsProviders.keys())
  }

  /**
   * Open an STT session on the provider named by `options.provider`.
   * @param options - session parameters; `options.provider` selects the registered adapter.
   * @returns the open session once the transport confirms readiness.
   */
  async openStt(options: SttOpenOptions): Promise<SttSession> {
    return this.resolve(this.sttProviders, options.provider, 'STT').connect(options)
  }

  /**
   * Open a TTS session on the provider named by `options.provider`.
   * @param options - session parameters; `options.provider` selects the registered adapter.
   * @returns the open session once the transport confirms readiness.
   */
  async openTts(options: TtsOpenOptions): Promise<TtsSession> {
    return this.resolve(this.ttsProviders, options.provider, 'TTS').connect(options)
  }

  private resolve<P>(registry: Map<string, P>, id: string, kind: 'STT' | 'TTS'): P {
    const provider = registry.get(id)
    if (provider === undefined) {
      throw new SpeechError(`${kind} provider "${id}" is not registered`, 'SPEECH_PROVIDER_NOT_REGISTERED')
    }
    return provider
  }
}

export default SpeechRuntime
