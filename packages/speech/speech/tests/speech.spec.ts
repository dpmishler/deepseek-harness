import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpeechRuntime, {
  SpeechError,
  type SttEvent,
  type SttOpenOptions,
  type SttProvider,
  type SttSession,
  type TtsEvent,
  type TtsOpenOptions,
  type TtsProvider,
  type TtsSession,
} from '@deepseek-ai/dsh-speech'

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

async function mountSpeech(): Promise<{ ctx: Context; speech: SpeechRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SpeechRuntime)
  return { ctx, speech: ctx.speech }
}

// ── STT registration ──────────────────────────────────────────────────────────

describe('SpeechRuntime STT registration', () => {
  it('registers an STT provider and lists it', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider('flux-stt', makeSttProvider())
    expect(speech.listSttProviders()).toEqual(['flux-stt'])
  })

  it('returns a disposer that unregisters the STT provider', async () => {
    const { speech } = await mountSpeech()
    const dispose = speech.registerSttProvider('flux-stt', makeSttProvider())
    dispose()
    expect(speech.listSttProviders()).toEqual([])
  })

  it('throws SPEECH_DUPLICATE_PROVIDER on a duplicate STT id', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider('flux-stt', makeSttProvider())
    expect(() => speech.registerSttProvider('flux-stt', makeSttProvider())).toThrow(
      expect.objectContaining({ code: 'SPEECH_DUPLICATE_PROVIDER' }),
    )
  })

  it('disposes STT registration when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, speech } = await mountSpeech()
    const fiber = await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          inner.speech.registerSttProvider('flux-stt', makeSttProvider())
        },
        { inject: ['speech'] },
      ),
    )
    expect(speech.listSttProviders()).toEqual(['flux-stt'])
    await fiber.dispose()
    expect(speech.listSttProviders()).toEqual([])
  })

  it('STT and TTS id namespaces are independent', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider('shared', makeSttProvider())
    expect(() => speech.registerTtsProvider('shared', makeTtsProvider())).not.toThrow()
  })
})

// ── TTS registration ──────────────────────────────────────────────────────────

describe('SpeechRuntime TTS registration', () => {
  it('registers a TTS provider and lists it', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider('flux-tts', makeTtsProvider())
    expect(speech.listTtsProviders()).toEqual(['flux-tts'])
  })

  it('returns a disposer that unregisters the TTS provider', async () => {
    const { speech } = await mountSpeech()
    const dispose = speech.registerTtsProvider('flux-tts', makeTtsProvider())
    dispose()
    expect(speech.listTtsProviders()).toEqual([])
  })

  it('throws SPEECH_DUPLICATE_PROVIDER on a duplicate TTS id', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider('flux-tts', makeTtsProvider())
    expect(() => speech.registerTtsProvider('flux-tts', makeTtsProvider())).toThrow(
      expect.objectContaining({ code: 'SPEECH_DUPLICATE_PROVIDER' }),
    )
  })

  it('disposes TTS registration when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, speech } = await mountSpeech()
    const fiber = await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          inner.speech.registerTtsProvider('flux-tts', makeTtsProvider())
        },
        { inject: ['speech'] },
      ),
    )
    expect(speech.listTtsProviders()).toEqual(['flux-tts'])
    await fiber.dispose()
    expect(speech.listTtsProviders()).toEqual([])
  })
})

// ── STT dispatch ───────────────────────────────────────────────────────────────

describe('SpeechRuntime STT dispatch', () => {
  it('throws SPEECH_PROVIDER_NOT_REGISTERED with no providers', async () => {
    const { speech } = await mountSpeech()
    await expect(speech.openStt(STT_OPTS)).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('dispatches to the exact provider named in options.provider', async () => {
    const { speech } = await mountSpeech()
    let calledId = ''
    speech.registerSttProvider('a', makeSttProvider(async () => { calledId = 'a'; return makeSttSession() }))
    speech.registerSttProvider('b', makeSttProvider(async () => { calledId = 'b'; return makeSttSession() }))
    await speech.openStt({ provider: 'b' })
    expect(calledId).toBe('b')
  })

  it('never auto-selects when exactly one STT provider is registered under a different id', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider('flux-stt', makeSttProvider())
    await expect(speech.openStt({ provider: 'other' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('propagates a rejection from the provider connect() call', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider('flux-stt', makeSttProvider(async () => { throw new Error('connect failed') }))
    await expect(speech.openStt(STT_OPTS)).rejects.toThrow('connect failed')
  })
})

// ── TTS dispatch ───────────────────────────────────────────────────────────────

describe('SpeechRuntime TTS dispatch', () => {
  it('throws SPEECH_PROVIDER_NOT_REGISTERED with no providers', async () => {
    const { speech } = await mountSpeech()
    await expect(speech.openTts(TTS_OPTS)).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_NOT_REGISTERED' }),
    )
  })

  it('dispatches to the exact provider named in options.provider', async () => {
    const { speech } = await mountSpeech()
    let calledId = ''
    speech.registerTtsProvider('a', makeTtsProvider(async () => { calledId = 'a'; return makeTtsSession() }))
    speech.registerTtsProvider('b', makeTtsProvider(async () => { calledId = 'b'; return makeTtsSession() }))
    await speech.openTts({ provider: 'b' })
    expect(calledId).toBe('b')
  })

  it('propagates a rejection from the provider connect() call', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider('flux-tts', makeTtsProvider(async () => { throw new Error('connect failed') }))
    await expect(speech.openTts(TTS_OPTS)).rejects.toThrow('connect failed')
  })
})

// ── SpeechError ────────────────────────────────────────────────────────────────

describe('SpeechError', () => {
  it('has a stable code and the given message', () => {
    const err = new SpeechError('no such provider', 'SPEECH_PROVIDER_NOT_REGISTERED')
    expect(err).toBeInstanceOf(SpeechError)
    expect(err.code).toBe('SPEECH_PROVIDER_NOT_REGISTERED')
    expect(err.message).toBe('no such provider')
    expect(err.name).toBe('SpeechError')
  })

  it('supports cause chaining', () => {
    const cause = new Error('root cause')
    const err = new SpeechError('outer', 'SPEECH_DUPLICATE_PROVIDER', { cause })
    expect(err.cause).toBe(cause)
  })
})
