import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VoiceRuntime, {
  VoiceError,
  type SttEvent,
  type SttOpenOptions,
  type SttProvider,
  type SttSession,
  type TtsEvent,
  type TtsOpenOptions,
  type TtsProvider,
  type TtsSession,
} from '../src/index.ts'

// ── test doubles ──────────────────────────────────────────────────────────────

function makeSttSession(): SttSession {
  return {
    events: (async function* (): AsyncGenerator<SttEvent> {})(),
    sendAudio: () => {},
    configure: () => {},
    close: () => Promise.resolve(),
  }
}

function makeTtsSession(): TtsSession {
  return {
    events: (async function* (): AsyncGenerator<TtsEvent> {})(),
    speak: () => {},
    flush: () => {},
    interrupt: () => {},
    configure: () => {},
    close: () => Promise.resolve(),
  }
}

function makeSttProvider(connect: (options: SttOpenOptions) => Promise<SttSession> = async () => makeSttSession()): SttProvider {
  return { connect }
}

function makeTtsProvider(connect: (options: TtsOpenOptions) => Promise<TtsSession> = async () => makeTtsSession()): TtsProvider {
  return { connect }
}

const STT_OPTS: SttOpenOptions = { provider: 'flux-stt' }
const TTS_OPTS: TtsOpenOptions = { provider: 'flux-tts' }

async function mountVoice(): Promise<{ ctx: Context; voice: VoiceRuntime }> {
  const ctx = new Context()
  await ctx.plugin(VoiceRuntime)
  return { ctx, voice: ctx.voice }
}

// ── STT registration ──────────────────────────────────────────────────────────

describe('VoiceRuntime STT registration', () => {
  it('registers an STT provider and lists it', async () => {
    const { voice } = await mountVoice()
    voice.registerSttProvider('flux-stt', makeSttProvider())
    expect(voice.listSttProviders()).toEqual(['flux-stt'])
  })

  it('returns a disposer that unregisters the STT provider', async () => {
    const { voice } = await mountVoice()
    const dispose = voice.registerSttProvider('flux-stt', makeSttProvider())
    dispose()
    expect(voice.listSttProviders()).toEqual([])
  })

  it('throws VOICE_DUPLICATE_PROVIDER on a duplicate STT id', async () => {
    const { voice } = await mountVoice()
    voice.registerSttProvider('flux-stt', makeSttProvider())
    expect(() => voice.registerSttProvider('flux-stt', makeSttProvider())).toThrow(
      expect.objectContaining({ code: 'VOICE_DUPLICATE_PROVIDER' }),
    )
  })

  it('throws VOICE_INVALID_PROVIDER on an empty STT id', async () => {
    const { voice } = await mountVoice()
    expect(() => voice.registerSttProvider('', makeSttProvider())).toThrow(
      expect.objectContaining({ code: 'VOICE_INVALID_PROVIDER' }),
    )
  })

  it('disposes STT registration when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, voice } = await mountVoice()
    const fiber = await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          inner.voice.registerSttProvider('flux-stt', makeSttProvider())
        },
        { inject: ['voice'] },
      ),
    )
    expect(voice.listSttProviders()).toEqual(['flux-stt'])
    await fiber.dispose()
    expect(voice.listSttProviders()).toEqual([])
  })

  it('STT and TTS id namespaces are independent', async () => {
    const { voice } = await mountVoice()
    voice.registerSttProvider('shared', makeSttProvider())
    expect(() => voice.registerTtsProvider('shared', makeTtsProvider())).not.toThrow()
  })
})

// ── TTS registration ──────────────────────────────────────────────────────────

describe('VoiceRuntime TTS registration', () => {
  it('registers a TTS provider and lists it', async () => {
    const { voice } = await mountVoice()
    voice.registerTtsProvider('flux-tts', makeTtsProvider())
    expect(voice.listTtsProviders()).toEqual(['flux-tts'])
  })

  it('returns a disposer that unregisters the TTS provider', async () => {
    const { voice } = await mountVoice()
    const dispose = voice.registerTtsProvider('flux-tts', makeTtsProvider())
    dispose()
    expect(voice.listTtsProviders()).toEqual([])
  })

  it('throws VOICE_DUPLICATE_PROVIDER on a duplicate TTS id', async () => {
    const { voice } = await mountVoice()
    voice.registerTtsProvider('flux-tts', makeTtsProvider())
    expect(() => voice.registerTtsProvider('flux-tts', makeTtsProvider())).toThrow(
      expect.objectContaining({ code: 'VOICE_DUPLICATE_PROVIDER' }),
    )
  })

  it('throws VOICE_INVALID_PROVIDER on an empty TTS id', async () => {
    const { voice } = await mountVoice()
    expect(() => voice.registerTtsProvider('', makeTtsProvider())).toThrow(
      expect.objectContaining({ code: 'VOICE_INVALID_PROVIDER' }),
    )
  })

  it('disposes TTS registration when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, voice } = await mountVoice()
    const fiber = await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          inner.voice.registerTtsProvider('flux-tts', makeTtsProvider())
        },
        { inject: ['voice'] },
      ),
    )
    expect(voice.listTtsProviders()).toEqual(['flux-tts'])
    await fiber.dispose()
    expect(voice.listTtsProviders()).toEqual([])
  })
})

// ── STT dispatch ───────────────────────────────────────────────────────────────

describe('VoiceRuntime STT dispatch', () => {
  it('throws VOICE_PROVIDER_NOT_REGISTERED with no providers', async () => {
    const { voice } = await mountVoice()
    await expect(voice.openStt(STT_OPTS)).rejects.toThrow(
      expect.objectContaining({ code: 'VOICE_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('dispatches to the exact provider named in options.provider', async () => {
    const { voice } = await mountVoice()
    let calledId = ''
    voice.registerSttProvider('a', makeSttProvider(async () => { calledId = 'a'; return makeSttSession() }))
    voice.registerSttProvider('b', makeSttProvider(async () => { calledId = 'b'; return makeSttSession() }))
    await voice.openStt({ provider: 'b' })
    expect(calledId).toBe('b')
  })

  it('never auto-selects when exactly one STT provider is registered under a different id', async () => {
    const { voice } = await mountVoice()
    voice.registerSttProvider('flux-stt', makeSttProvider())
    await expect(voice.openStt({ provider: 'other' })).rejects.toThrow(
      expect.objectContaining({ code: 'VOICE_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('propagates a rejection from the provider connect() call', async () => {
    const { voice } = await mountVoice()
    voice.registerSttProvider('flux-stt', makeSttProvider(async () => { throw new Error('connect failed') }))
    await expect(voice.openStt(STT_OPTS)).rejects.toThrow('connect failed')
  })
})

// ── TTS dispatch ───────────────────────────────────────────────────────────────

describe('VoiceRuntime TTS dispatch', () => {
  it('throws VOICE_PROVIDER_NOT_REGISTERED with no providers', async () => {
    const { voice } = await mountVoice()
    await expect(voice.openTts(TTS_OPTS)).rejects.toThrow(
      expect.objectContaining({ code: 'VOICE_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('dispatches to the exact provider named in options.provider', async () => {
    const { voice } = await mountVoice()
    let calledId = ''
    voice.registerTtsProvider('a', makeTtsProvider(async () => { calledId = 'a'; return makeTtsSession() }))
    voice.registerTtsProvider('b', makeTtsProvider(async () => { calledId = 'b'; return makeTtsSession() }))
    await voice.openTts({ provider: 'b' })
    expect(calledId).toBe('b')
  })

  it('propagates a rejection from the provider connect() call', async () => {
    const { voice } = await mountVoice()
    voice.registerTtsProvider('flux-tts', makeTtsProvider(async () => { throw new Error('connect failed') }))
    await expect(voice.openTts(TTS_OPTS)).rejects.toThrow('connect failed')
  })
})

// ── VoiceError ────────────────────────────────────────────────────────────────

describe('VoiceError (via the registry)', () => {
  it('has a stable code and the given message', () => {
    const err = new VoiceError('no such provider', 'VOICE_PROVIDER_NOT_REGISTERED')
    expect(err).toBeInstanceOf(VoiceError)
    expect(err.code).toBe('VOICE_PROVIDER_NOT_REGISTERED')
    expect(err.message).toBe('no such provider')
    expect(err.name).toBe('VoiceError')
  })

  it('supports cause chaining', () => {
    const cause = new Error('root cause')
    const err = new VoiceError('outer', 'VOICE_DUPLICATE_PROVIDER', { cause })
    expect(err.cause).toBe(cause)
  })
})
