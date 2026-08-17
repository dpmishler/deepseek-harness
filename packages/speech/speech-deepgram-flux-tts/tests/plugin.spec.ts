import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpeechRuntime from '@deepseek-ai/dsh-speech'
import { apply, PROVIDER_ID, resolveProviderOptions } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const ENV_KEY = 'DEEPGRAM_API_KEY'
const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_KEY)
  else process.env[ENV_KEY] = originalEnv
})

describe('resolveProviderOptions', () => {
  it('uses config.apiKey when present', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    expect(resolveProviderOptions({ apiKey: 'from-config' })).toMatchObject({ apiKey: 'from-config' })
  })

  it('falls back to $DEEPGRAM_API_KEY when config.apiKey is omitted', () => {
    process.env[ENV_KEY] = 'from-env'
    expect(resolveProviderOptions({})).toMatchObject({ apiKey: 'from-env' })
  })

  it('throws when no API key is available anywhere', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    expect(() => resolveProviderOptions({})).toThrow(/no Deepgram API key/)
  })

  it('applies defaults for baseURL and model', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    expect(resolveProviderOptions({ apiKey: 'k' })).toEqual({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-alexis-en',
    })
  })

  it('honors explicit baseURL and model overrides', () => {
    const config: Config = { apiKey: 'k', baseURL: 'wss://custom.example', model: 'flux-luna-en' }
    expect(resolveProviderOptions(config)).toEqual(config)
  })
})

describe('apply()', () => {
  it('registers a Deepgram Flux TTS provider under PROVIDER_ID', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime)
    apply(ctx, { apiKey: 'k' })
    expect(ctx.speech.listTtsProviders()).toEqual([PROVIDER_ID])
  })

  it('throws at load when no API key is configured or in the environment', async () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime)
    expect(() => { apply(ctx, {}) }).toThrow(/no Deepgram API key/)
  })
})
