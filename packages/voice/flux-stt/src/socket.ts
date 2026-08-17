/**
 * Node-style WebSocket abstraction for the Flux STT adapter. The `ws` package's
 * `WebSocket` class implements this interface; tests supply a `FakeSocket`.
 *
 * Why Node-style (`on` / `ping`) instead of WHATWG-style (`addEventListener`)?
 * `ws` is an explicit devDependency of many Node services that already live in
 * this monorepo, and the `ping()` primitive — required for RFC-6455 keepalive
 * without a JSON payload — is available only on Node-style clients.
 * @module @deepseek-ai/dsh-flux-stt/socket
 */

/**
 * Minimum Node-style WebSocket surface the Flux STT connection uses.
 * Satisfied by the `ws` package's `WebSocket` class and by test fakes.
 */
export interface WebSocketLike {
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  send(data: string | Uint8Array): void
  ping(): void
  close(code?: number, reason?: string): void
}

/**
 * Factory that opens one WebSocket at the given URL.
 * The factory returns a socket already connecting; listeners must be
 * attached synchronously before any microtask boundary.
 * @param url - the full `wss://` URL including query parameters.
 * @returns a socket implementing {@link WebSocketLike}.
 */
export type WebSocketFactory = (url: string) => WebSocketLike

/**
 * Build the default production factory using the `ws` npm package.
 * Called once per session; the import is lazy so the package is not loaded
 * unless a real session is opened.
 * @param apiKey - Deepgram API key, sent as the `Authorization` header.
 * @returns a factory that opens an authenticated `ws.WebSocket`.
 */
export async function makeProductionFactory(apiKey: string): Promise<WebSocketFactory> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: WS } = await import('ws' as string) as { default: new (url: string, options: { headers: Record<string, string> }) => WebSocketLike }
  return (url: string): WebSocketLike => new WS(url, { headers: { Authorization: `Token ${apiKey}` } })
}
