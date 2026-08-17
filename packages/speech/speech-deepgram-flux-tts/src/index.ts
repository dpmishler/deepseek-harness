/**
 * `@deepseek-ai/dsh-speech-deepgram-flux-tts`: registers a Deepgram
 * Flux-backed `TtsProvider` with `ctx.speech`. A function/namespace plugin
 * (NOT a default-export service) — it registers INTO the seam's TTS
 * registry; the `speech` key itself is owned by `@deepseek-ai/dsh-speech`.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-tts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-speech'
import { DEFAULT_BASE_URL } from './connection.ts'
import { FluxTtsProvider } from './provider.ts'
import type { FluxTtsProviderOptions } from './provider.ts'

export { DEFAULT_BASE_URL, FluxTtsConnection } from './connection.ts'
export type { FluxTtsConnectionOptions, WebSocketFactory, WebSocketLike } from './connection.ts'
export { FluxTtsProvider } from './provider.ts'
export type { FluxTtsProviderOptions } from './provider.ts'
export * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-deepgram-flux-tts'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Stable id this plugin registers under; pass as `TtsOpenOptions.provider`. */
export const PROVIDER_ID = 'deepgram-flux'

/** Default Flux TTS model; an English voice in the `flux-{voice}-{lang}` format Deepgram requires on `/v2/speak`. */
export const DEFAULT_MODEL = 'flux-alexis-en'

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
  /** Default Flux TTS model, format `flux-{voice}-{lang}` (default: `flux-alexis-en`). */
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
export function resolveProviderOptions(config: Config): FluxTtsProviderOptions {
  const apiKey = config.apiKey ?? process.env[API_KEY_ENV] ?? ''
  if (apiKey.length === 0) {
    throw new Error(
      `speech-deepgram-flux-tts: no Deepgram API key; set config.apiKey or export ${API_KEY_ENV}`,
    )
  }
  return {
    apiKey,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    model: config.model ?? DEFAULT_MODEL,
  }
}

/** Register the Deepgram Flux TTS provider with `ctx.speech`. */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerTtsProvider(PROVIDER_ID, new FluxTtsProvider(resolveProviderOptions(config)))
}
