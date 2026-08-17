/**
 * Minimal WebSocket surface both Flux providers depend on, narrow enough that
 * a test double can implement it without a real socket. The default factory
 * wraps `ws`'s Node client; tests inject a fake through
 * `FluxTtsProviderConfig.createWebSocket`.
 * @module @deepseek-ai/dsh-flux-tts/socket
 */

import WebSocket from 'ws'

/** Raw message payload shapes `ws` delivers on `'message'`. */
export type RawSocketData = Buffer | ArrayBuffer | Buffer[]

/** The subset of `ws`'s `WebSocket` API the Flux TTS provider uses. */
export interface WebSocketLike {
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void
  ping(): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: RawSocketData, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** Opens one {@link WebSocketLike}; the default factory is `ws`, injectable for tests. */
export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocketLike

/** Default factory: a real `ws` client. */
export const createWsWebSocket: WebSocketFactory = (url, options) =>
  new WebSocket(url, { headers: options.headers }) as unknown as WebSocketLike

/** Normalize any `ws` message payload into one `Uint8Array` (never a `Buffer[]` fragment list — `ws` reassembles those before delivery unless `fin`-handling is disabled, which this client never does). */
export function toUint8Array(data: RawSocketData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data)
}
