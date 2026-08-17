/**
 * `FluxSttProvider`: implements `SttProvider` from `@deepseek-ai/dsh-voice`
 * by opening one `FluxSttSession` per `connect()` call.
 * @module @deepseek-ai/dsh-flux-stt/provider
 */

import type { SttOpenOptions, SttProvider, SttSession } from '@deepseek-ai/dsh-voice'
import { FluxSttSession } from './session.ts'
import type { WebSocketFactory } from './socket.ts'
import { makeProductionFactory } from './socket.ts'

/** Stable provider id used when registering with `ctx.voice`. */
export const FLUX_STT_PROVIDER_ID = 'deepgram-flux'

/** Resolved constructor options for `FluxSttProvider`. */
export interface FluxSttProviderOptions {
  /** Deepgram API key. When empty, sessions throw `VOICE_PROVIDER_UNAVAILABLE`. */
  readonly apiKey: string
  /** Endpoint base (default: `wss://api.deepgram.com`). */
  readonly baseURL: string
  /** Default Flux STT model (default: `flux-general-en`). */
  readonly model: string
  /** Audio encoding applied to every connection (default: `linear16`). */
  readonly encoding: string
  /** Audio sample rate in Hz (default: `16000`). */
  readonly sampleRateHz: number
  /** End-of-turn confidence threshold 0.5–0.9 (default: `0.7`). */
  readonly eotThreshold: number
  /** Maximum silence timeout ms before forcing a turn (default: `5000`). */
  readonly eotTimeoutMs: number
  /** KeepAlive ping interval in ms (default: `8000`). */
  readonly keepAliveIntervalMs: number
  /** Filter profanity from transcripts. */
  readonly profanityFilter: boolean
  /** Convert spoken numbers to digits. */
  readonly numerals: boolean
  /** Injectable WebSocket factory for tests. */
  readonly createWebSocket?: WebSocketFactory
}

function buildUrl(base: string, opts: FluxSttProviderOptions, callOpts: SttOpenOptions): string {
  const url = new URL('/v2/listen', base.replace(/^wss:\/\//, 'https://'))
  url.protocol = 'wss:'
  const model = callOpts.model ?? opts.model
  url.searchParams.set('model', model)
  url.searchParams.set('encoding', opts.encoding)
  url.searchParams.set('sample_rate', String(opts.sampleRateHz))
  url.searchParams.set('eot_threshold', String(opts.eotThreshold))
  url.searchParams.set('eot_timeout_ms', String(opts.eotTimeoutMs))
  if (opts.profanityFilter) url.searchParams.set('profanity_filter', 'true')
  if (opts.numerals) url.searchParams.set('numerals', 'true')
  for (const term of callOpts.keyterms ?? []) url.searchParams.append('keyterm', term)
  for (const hint of callOpts.languageHints ?? []) url.searchParams.append('language_hint', hint)
  if (callOpts.endOfTurn?.confidence !== undefined) url.searchParams.set('eot_threshold', String(callOpts.endOfTurn.confidence))
  if (callOpts.endOfTurn?.eagerConfidence !== undefined) url.searchParams.set('eager_eot_threshold', String(callOpts.endOfTurn.eagerConfidence))
  if (callOpts.endOfTurn?.timeoutMs !== undefined) url.searchParams.set('eot_timeout_ms', String(callOpts.endOfTurn.timeoutMs))
  return url.toString()
}

/**
 * Deepgram Flux STT `SttProvider`. Each `connect()` call opens one
 * independent `/v2/listen` WebSocket session.
 */
export class FluxSttProvider implements SttProvider {
  private readonly opts: FluxSttProviderOptions

  /** @param opts - resolved provider options. */
  constructor(opts: FluxSttProviderOptions) {
    this.opts = opts
  }

  /**
   * Open a Flux STT session.
   * @param options - per-session parameters.
   * @returns the session once the provider confirms readiness (`Connected` message).
   * @throws when `options.signal` is already aborted.
   */
  async connect(options: SttOpenOptions): Promise<SttSession> {
    // Honor pre-aborted signal before any I/O.
    if (options.signal?.aborted === true) {
      const { VoiceError } = await import('@deepseek-ai/dsh-voice')
      throw new VoiceError('Session open was aborted before connecting', 'ABORTED')
    }

    if (this.opts.apiKey.length === 0) {
      const { VoiceError } = await import('@deepseek-ai/dsh-voice')
      throw new VoiceError('No Deepgram API key is configured for the flux-stt provider', 'VOICE_PROVIDER_UNAVAILABLE')
    }


    const factory = this.opts.createWebSocket ?? await makeProductionFactory(this.opts.apiKey)
    const url = buildUrl(this.opts.baseURL, this.opts, options)
    const socket = factory(url)
    const session = new FluxSttSession({ socket, keepAliveIntervalMs: this.opts.keepAliveIntervalMs })
    return session.connected
  }
}
