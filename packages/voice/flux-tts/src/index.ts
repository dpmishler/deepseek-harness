/**
 * Register {@link FluxTtsProvider} on `ctx.voice` under the `deepgram-flux`
 * id, resolving the API key from `ctx.credentials` (falling back to the
 * ambient `$DEEPGRAM_API_KEY` when the credentials seam is not mounted) and
 * every deployment-varying wire parameter from `Config`. Flux TTS voice model
 * strings follow `flux-{voice}-{language}`; an Aura model string belongs to
 * `/v1/speak`, a different provider this package never implements.
 * @module @deepseek-ai/dsh-flux-tts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { VoiceError } from '@deepseek-ai/dsh-voice'
import { FLUX_TTS_PROVIDER_ID, FluxTtsProvider } from './provider.ts'
import type { FluxTtsProviderConfig } from './provider.ts'
import type { FluxTtsEncoding, FluxTtsExpressivity, FluxTtsSpeed } from './types.ts'

export { FLUX_TTS_PROVIDER_ID, FluxTtsProvider } from './provider.ts'
export type { FluxTtsProviderConfig } from './provider.ts'
export type { WebSocketFactory, WebSocketLike } from './socket.ts'
export type * from './types.ts'

/** Default credential reference (environment-variable name) for the Deepgram API key. */
const DEFAULT_API_KEY_ENV = 'DEEPGRAM_API_KEY'
const DEFAULT_BASE_URL = 'wss://api.deepgram.com'
const DEFAULT_ENCODING: FluxTtsEncoding = 'linear16'
const DEFAULT_SPEED = 1.00
const DEFAULT_EXPRESSIVITY = 0
/** Well under the documented ~60s `/v2/speak` idle close, and gentle enough not to interfere with turn traffic. */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000

/** Cordis plugin name. */
export const name = 'flux-tts'
/** The `ctx.voice` seam this plugin registers into. */
export const inject = ['voice']

/** Plugin config. Every field but `model` is optional; `Config`'s schema fills the documented defaults above. */
export interface Config {
  /** Credential reference (environment-variable name); defaults to `DEEPGRAM_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base. */
  baseURL?: string
  /** Required Flux TTS voice model, format `flux-{voice}-{language}` (e.g. `flux-alexis-en`). Rejects an Aura model string — use `/v1/speak` for those. */
  model: string
  /** Raw output audio encoding. */
  encoding?: FluxTtsEncoding
  /** Output sample rate in Hz; omit for the model's native rate. */
  sampleRateHz?: number
  /** Speech-rate multiplier, `0.85`–`1.15` in `0.05` steps. */
  speed?: FluxTtsSpeed
  /** Delivery register, calm (`-2`) to animated (`2`); fixed per connection. */
  expressivity?: FluxTtsExpressivity
  /** WebSocket-protocol ping interval while no `Speak`/`Flush`/`Interrupt`/`Configure` has been sent. */
  keepAliveIntervalMs?: number
  /** Usage-reporting label for requests from this deployment. */
  tag?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  model: z.string().required(),
  encoding: z.union(['linear16', 'mulaw', 'alaw']).default(DEFAULT_ENCODING),
  sampleRateHz: z.number().step(1).min(1),
  speed: z.union([0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.15]).default(DEFAULT_SPEED),
  expressivity: z.union([-2, -1, 0, 1, 2]).default(DEFAULT_EXPRESSIVITY),
  keepAliveIntervalMs: z.number().step(1).min(1_000).default(DEFAULT_KEEPALIVE_INTERVAL_MS),
  tag: z.string(),
})

/**
 * Resolve the API key through `ctx.credentials` when the seam is mounted,
 * else the ambient environment. Thrown (not silently skipped) when neither
 * source has a usable value, so a misconfigured deployment fails loud at the
 * first `ctx.voice.openTts` call rather than opening an unauthenticated socket.
 * @param ctx - Cordis context, optionally carrying `ctx.credentials`.
 * @param ref - the credential reference to resolve.
 * @returns the resolved, non-empty API key.
 */
async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient
  }
  throw new VoiceError(
    `flux-tts: no API key for reference "${ref}"; store it through the credentials service or export ${ref} in the launching environment`,
    'VOICE_PROVIDER_UNAVAILABLE',
  )
}

/** A Deepgram TTS model that names `/v1/speak`'s product line, never accepted here. */
function assertNotAuraModel(model: string): void {
  if (!model.startsWith('flux-')) {
    throw new VoiceError(
      `flux-tts: model "${model}" is not a Flux model (expected "flux-{voice}-{language}"); `
      + 'an Aura model string is rejected on /v2/speak — use dsh-aura-tts (or /v1/speak directly) for Aura voices',
      'VOICE_INVALID_PROVIDER',
    )
  }
}

/**
 * Register the Deepgram Flux TTS provider on `ctx.voice`.
 * @param ctx - Cordis context.
 * @param config - plugin configuration (schemastery has already applied defaults).
 */
export function apply(ctx: Context, config: Config): void {
  assertNotAuraModel(config.model)
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const providerConfig: Omit<FluxTtsProviderConfig, 'apiKey'> = {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    model: config.model,
    encoding: config.encoding ?? DEFAULT_ENCODING,
    speed: config.speed ?? DEFAULT_SPEED,
    expressivity: config.expressivity ?? DEFAULT_EXPRESSIVITY,
    keepAliveIntervalMs: config.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
    ...config.sampleRateHz === undefined ? {} : { sampleRateHz: config.sampleRateHz },
    ...config.tag === undefined ? {} : { tag: config.tag },
  }
  ctx.voice.registerTtsProvider(FLUX_TTS_PROVIDER_ID, {
    connect: async (options) => {
      const apiKey = await resolveApiKey(ctx, apiKeyEnv)
      return new FluxTtsProvider({ ...providerConfig, apiKey }).connect(options)
    },
  })
}
