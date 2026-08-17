/**
 * `@deepseek-ai/dsh-speech-deepgram-flux-stt`: registers a Deepgram
 * Flux-backed `SttProvider` with `ctx.speech`. A function/namespace plugin
 * (NOT a default-export service) — it registers INTO the seam's STT
 * registry; the `speech` key itself is owned by `@deepseek-ai/dsh-speech`.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-stt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-speech'
import { DEFAULT_BASE_URL } from './connection.ts'
import { FluxSttProvider } from './provider.ts'
import type { FluxSttProviderOptions } from './provider.ts'

export { DEFAULT_BASE_URL, FluxSttConnection } from './connection.ts'
export type { FluxSttConnectionOptions, WebSocketFactory, WebSocketLike } from './connection.ts'
export { FluxSttProvider } from './provider.ts'
export type { FluxSttProviderOptions } from './provider.ts'
export * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-deepgram-flux-stt'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Stable id this plugin registers under; pass as `SttOpenOptions.provider`. */
export const PROVIDER_ID = 'deepgram-flux'

/** Default Flux STT model for English; `flux-general-multi` covers 10 languages. */
export const DEFAULT_MODEL = 'flux-general-en'

/** Environment variable naming the Deepgram API key when `config.apiKey` is omitted. */
export const API_KEY_ENV = 'DEEPGRAM_API_KEY'

/**
 * Plugin config. `apiKey` falls back to `$DEEPGRAM_API_KEY`; a missing key
 * fails loud at load (this provider has no `available()` escape valve —
 * `ctx.speech` dispatches to a registered provider unconditionally).
 */
export interface Config {
  /** Deepgram API key. Falls back to `$DEEPGRAM_API_KEY`. */
  apiKey?: string
  /** Endpoint base (default: `wss://api.deepgram.com`). */
  baseURL?: string
  /** Default Flux STT model (default: `flux-general-en`). */
  model?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
})

/**
 * Resolve `Config` plus the environment into the provider's connection
 * facts, or throw when no API key is available anywhere.
 * @param config - raw plugin config.
 * @returns validated, defaulted connection facts.
 */
export function resolveProviderOptions(config: Config): FluxSttProviderOptions {
  const apiKey = config.apiKey ?? process.env[API_KEY_ENV] ?? ''
  if (apiKey.length === 0) {
    throw new Error(
      `speech-deepgram-flux-stt: no Deepgram API key; set config.apiKey or export ${API_KEY_ENV}`,
    )
  }
  return {
    apiKey,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    model: config.model ?? DEFAULT_MODEL,
  }
}

/** Register the Deepgram Flux STT provider with `ctx.speech`. */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerSttProvider(PROVIDER_ID, new FluxSttProvider(resolveProviderOptions(config)))
}
