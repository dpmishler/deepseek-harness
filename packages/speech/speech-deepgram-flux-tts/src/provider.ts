/**
 * `FluxTtsProvider`: implements `TtsProvider` over `FluxTtsConnection`. Each
 * `connect()` call opens an independent `/v2/speak` WebSocket session.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-tts/provider
 */

import type { TtsOpenOptions, TtsProvider, TtsSession } from '@deepseek-ai/dsh-speech'
import { FluxTtsConnection, resolveDefaultWebSocketFactory } from './connection.ts'
import type { WebSocketFactory } from './connection.ts'

/** Resolved configuration for `FluxTtsProvider`. */
export interface FluxTtsProviderOptions {
  /** Deepgram API key. */
  readonly apiKey: string
  /** Endpoint base, e.g. `wss://api.deepgram.com`. */
  readonly baseURL: string
  /** Default Flux TTS model (`flux-{voice}-{lang}`), used when a session's {@link TtsOpenOptions.voice} is omitted. */
  readonly model: string
  /** Injectable WebSocket factory; omit to use the undici-backed production default. */
  readonly createWebSocket?: WebSocketFactory
}

/**
 * Deepgram Flux TTS provider (`/v2/speak`). Register with
 * `ctx.speech.registerTtsProvider(id, new FluxTtsProvider(options))`.
 */
export class FluxTtsProvider implements TtsProvider {
  private readonly options: FluxTtsProviderOptions
  private cachedFactory: Promise<WebSocketFactory> | undefined

  /** @param options - resolved connection facts and an optional injectable WebSocket factory. */
  constructor(options: FluxTtsProviderOptions) {
    this.options = options
  }

  private resolveFactory(): Promise<WebSocketFactory> {
    if (this.options.createWebSocket !== undefined) return Promise.resolve(this.options.createWebSocket)
    // Memoized: every session shares the one resolved undici import.
    this.cachedFactory ??= resolveDefaultWebSocketFactory()
    return this.cachedFactory
  }

  /**
   * Open one `/v2/speak` session.
   * @param options - session parameters; `options.voice` overrides the provider default model.
   * @returns the open session once the WebSocket handshake completes.
   */
  async connect(options: TtsOpenOptions): Promise<TtsSession> {
    const createWebSocket = await this.resolveFactory()
    const connection = new FluxTtsConnection({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseURL,
      model: options.voice ?? this.options.model,
      options,
      createWebSocket,
    })
    await connection.connect()
    return {
      events: connection,
      speak: (text) => { connection.speak(text) },
      flush: () => { connection.flush() },
      interrupt: (playbackOffsetMs) => { connection.interrupt(playbackOffsetMs) },
      configure: (request) => { connection.configure(request) },
      close: () => connection.close(),
    }
  }
}
