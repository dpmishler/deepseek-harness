/**
 * Deepgram Flux STT plugin: registers a `FluxSttProvider` with `ctx.voice`
 * under the `deepgram-flux` id. Resolves the API key from `$DEEPGRAM_API_KEY`
 * or an explicit `apiKey` config value; all other options carry sensible
 * production defaults. A session open fails loud with `VOICE_PROVIDER_UNAVAILABLE`
 * when no key is available rather than silently skipping registration.
 * @module @deepseek-ai/dsh-flux-stt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-voice'
import { FluxSttProvider, FLUX_STT_PROVIDER_ID } from './provider.ts'
import type { FluxSttProviderOptions } from './provider.ts'
import type { WebSocketFactory } from './socket.ts'

export { FluxSttProvider, FLUX_STT_PROVIDER_ID } from './provider.ts'
export type { FluxSttProviderOptions } from './provider.ts'
export type { WebSocketFactory, WebSocketLike } from './socket.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'flux-stt'

/** Voice seam dependency. */
export const inject = ['voice']

/** Plugin configuration. All fields are optional. */
export interface Config {
  /** Deepgram API key. Falls back to `$DEEPGRAM_API_KEY`. */
  apiKey?: string
  /** Endpoint base (default: `wss://api.deepgram.com`). */
  baseURL?: string
  /** Default Flux STT model (default: `flux-general-en`). */
  model?: string
  /** Audio encoding (default: `linear16`). */
  encoding?: string
  /** Audio sample rate in Hz (default: `16000`). */
  sampleRateHz?: number
  /** End-of-turn confidence threshold 0.5–0.9 (default: `0.7`). */
  eotThreshold?: number
  /** Maximum silence timeout ms (default: `5000`). */
  eotTimeoutMs?: number
  /** KeepAlive ping interval ms (default: `8000`). */
  keepAliveIntervalMs?: number
  /** Filter profanity from transcripts (default: `false`). */
  profanityFilter?: boolean
  /** Convert spoken numbers to digits (default: `false`). */
  numerals?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  encoding: z.string(),
  sampleRateHz: z.number().step(1).min(1),
  eotThreshold: z.number().min(0.5).max(0.9),
  eotTimeoutMs: z.number().step(1).min(500),
  keepAliveIntervalMs: z.number().step(1).min(1),
  profanityFilter: z.boolean(),
  numerals: z.boolean(),
})

/**
 * Register the Deepgram Flux STT provider with `ctx.voice`.
 * @param ctx - Cordis context.
 * @param config - plugin configuration.
 * @param createWebSocket - injectable WebSocket factory (tests only).
 */
export function apply(ctx: Context, config: Config, createWebSocket?: WebSocketFactory): void {
  const apiKey = config.apiKey ?? process.env['DEEPGRAM_API_KEY'] ?? ''
  const opts: FluxSttProviderOptions = {
    apiKey,
    baseURL: config.baseURL ?? 'wss://api.deepgram.com',
    model: config.model ?? 'flux-general-en',
    encoding: config.encoding ?? 'linear16',
    sampleRateHz: config.sampleRateHz ?? 16_000,
    eotThreshold: config.eotThreshold ?? 0.7,
    eotTimeoutMs: config.eotTimeoutMs ?? 5_000,
    keepAliveIntervalMs: config.keepAliveIntervalMs ?? 8_000,
    profanityFilter: config.profanityFilter ?? false,
    numerals: config.numerals ?? false,
    ...(createWebSocket !== undefined ? { createWebSocket } : {}),
  }
  ctx.voice.registerSttProvider(FLUX_STT_PROVIDER_ID, new FluxSttProvider(opts))
}
