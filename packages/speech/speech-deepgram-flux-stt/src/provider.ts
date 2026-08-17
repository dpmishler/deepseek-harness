/**
 * `FluxSttProvider`: implements `SttProvider` over `FluxSttConnection`. Each
 * `connect()` call opens an independent `/v2/listen` WebSocket session.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-stt/provider
 */

import type { SttOpenOptions, SttProvider, SttSession } from '@deepseek-ai/dsh-speech'
import { FluxSttConnection, resolveDefaultWebSocketFactory } from './connection.ts'
import type { WebSocketFactory } from './connection.ts'

/** Resolved configuration for `FluxSttProvider`. */
export interface FluxSttProviderOptions {
  /** Deepgram API key. */
  readonly apiKey: string
  /** Endpoint base, e.g. `wss://api.deepgram.com`. */
  readonly baseURL: string
  /** Default Flux STT model, used when a session's {@link SttOpenOptions.model} is omitted. */
  readonly model: string
  /** Injectable WebSocket factory; omit to use the undici-backed production default. */
  readonly createWebSocket?: WebSocketFactory
}

/**
 * Deepgram Flux STT provider (`/v2/listen`). Register with
 * `ctx.speech.registerSttProvider(id, new FluxSttProvider(options))`.
 */
export class FluxSttProvider implements SttProvider {
  private readonly options: FluxSttProviderOptions
  private cachedFactory: Promise<WebSocketFactory> | undefined

  /** @param options - resolved connection facts and an optional injectable WebSocket factory. */
  constructor(options: FluxSttProviderOptions) {
    this.options = options
  }

  private resolveFactory(): Promise<WebSocketFactory> {
    if (this.options.createWebSocket !== undefined) return Promise.resolve(this.options.createWebSocket)
    // Memoized: every session shares the one resolved undici import.
    this.cachedFactory ??= resolveDefaultWebSocketFactory()
    return this.cachedFactory
  }

  /**
   * Open one `/v2/listen` session.
   * @param options - session parameters; `options.model` overrides the provider default.
   * @returns the open session once the WebSocket handshake completes.
   */
  async connect(options: SttOpenOptions): Promise<SttSession> {
    const createWebSocket = await this.resolveFactory()
    const connection = new FluxSttConnection({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseURL,
      model: options.model ?? this.options.model,
      options,
      createWebSocket,
    })
    await connection.connect()
    return {
      events: connection,
      sendAudio: (chunk) => { connection.sendAudio(chunk) },
      configure: (request) => { connection.configure(request) },
      close: () => connection.close(),
    }
  }
}
