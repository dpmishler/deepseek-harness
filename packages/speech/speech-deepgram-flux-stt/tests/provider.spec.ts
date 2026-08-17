import { describe, expect, it } from 'vitest'
import type { WebSocketFactory, WebSocketLike } from '../src/connection.ts'
import { FluxSttProvider } from '../src/provider.ts'

/** A `WebSocketLike` double that opens immediately when constructed. */
class ImmediatelyOpenSocket implements WebSocketLike {
  sent: (string | Uint8Array)[] = []
  private openListener: (() => void) | undefined

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {}

  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'open') {
      this.openListener = listener as () => void
      queueMicrotask(() => this.openListener?.())
    }
  }
}

describe('FluxSttProvider', () => {
  it('opens a session using the provider default model when options.model is omitted', async () => {
    let capturedUrl = ''
    const createWebSocket: WebSocketFactory = (url) => {
      capturedUrl = url
      return new ImmediatelyOpenSocket()
    }
    const provider = new FluxSttProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-general-en',
      createWebSocket,
    })
    await provider.connect({ provider: 'deepgram-flux' })
    expect(capturedUrl).toContain('model=flux-general-en')
  })

  it('lets options.model override the provider default', async () => {
    let capturedUrl = ''
    const createWebSocket: WebSocketFactory = (url) => {
      capturedUrl = url
      return new ImmediatelyOpenSocket()
    }
    const provider = new FluxSttProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-general-en',
      createWebSocket,
    })
    await provider.connect({ provider: 'deepgram-flux', model: 'flux-general-multi' })
    expect(capturedUrl).toContain('model=flux-general-multi')
  })

  it('returns a session whose methods forward to the underlying connection', async () => {
    const socket = new ImmediatelyOpenSocket()
    const provider = new FluxSttProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-general-en',
      createWebSocket: () => socket,
    })
    const session = await provider.connect({ provider: 'deepgram-flux' })
    session.sendAudio(new Uint8Array([1]))
    session.configure({ keyterms: ['x'] })
    expect(socket.sent).toHaveLength(2)
    expect(session.events).toBeDefined()
    void session.close()
  })
})
