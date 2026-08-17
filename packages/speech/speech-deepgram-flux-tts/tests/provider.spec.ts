import { describe, expect, it, vi } from 'vitest'
import type { WebSocketFactory, WebSocketLike } from '../src/connection.ts'
import { FluxTtsProvider } from '../src/provider.ts'

const fakeDefaultFactory = vi.fn((): WebSocketLike => new ImmediatelyOpenSocket())
const resolveDefaultWebSocketFactoryMock = vi.fn(async (): Promise<WebSocketFactory> => fakeDefaultFactory)

vi.mock('../src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/connection.ts')>()
  return { ...actual, resolveDefaultWebSocketFactory: () => resolveDefaultWebSocketFactoryMock() }
})

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
      this.openListener = listener
      queueMicrotask(() => this.openListener?.())
    }
  }
}

describe('FluxTtsProvider', () => {
  it('opens a session using the provider default model when options.voice is omitted', async () => {
    let capturedUrl = ''
    const createWebSocket: WebSocketFactory = (url) => {
      capturedUrl = url
      return new ImmediatelyOpenSocket()
    }
    const provider = new FluxTtsProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-alexis-en',
      createWebSocket,
    })
    await provider.connect({ provider: 'deepgram-flux' })
    expect(capturedUrl).toContain('model=flux-alexis-en')
  })

  it('lets options.voice override the provider default model', async () => {
    let capturedUrl = ''
    const createWebSocket: WebSocketFactory = (url) => {
      capturedUrl = url
      return new ImmediatelyOpenSocket()
    }
    const provider = new FluxTtsProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-alexis-en',
      createWebSocket,
    })
    await provider.connect({ provider: 'deepgram-flux', voice: 'flux-luna-en' })
    expect(capturedUrl).toContain('model=flux-luna-en')
  })

  it('returns a session whose methods forward to the underlying connection', async () => {
    const socket = new ImmediatelyOpenSocket()
    const provider = new FluxTtsProvider({
      apiKey: 'k',
      baseURL: 'wss://api.deepgram.com',
      model: 'flux-alexis-en',
      createWebSocket: () => socket,
    })
    const session = await provider.connect({ provider: 'deepgram-flux' })
    session.speak('hi')
    session.flush()
    session.interrupt(100)
    session.configure({ speed: 1.05 })
    expect(socket.sent).toHaveLength(4)
    expect(session.events).toBeDefined()
    void session.close()
  })

  it('resolves and memoizes the default WebSocket factory when createWebSocket is omitted', async () => {
    resolveDefaultWebSocketFactoryMock.mockClear()
    const provider = new FluxTtsProvider({ apiKey: 'k', baseURL: 'wss://api.deepgram.com', model: 'flux-alexis-en' })
    await provider.connect({ provider: 'deepgram-flux' })
    await provider.connect({ provider: 'deepgram-flux' })
    expect(resolveDefaultWebSocketFactoryMock).toHaveBeenCalledTimes(1)
  })
})
