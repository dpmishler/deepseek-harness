/**
 * Minimal single-consumer async queue bridging push-based transport events
 * (WebSocket messages, timers, microphone frames) into the pull-based
 * `for await` event streams every `ctx.speech` session exposes, and into the
 * fake sessions this package's own tests drive.
 * @module @deepseek-ai/dsh-speech-agent/async-event-queue
 */

/** One pending `next()` call awaiting its settlement. */
interface Waiting<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: unknown) => void
}

/**
 * Push values in, consume them with `for await`. Supports exactly one
 * concurrent consumer, matching every `SttSession`/`TtsSession`'s single
 * `events` stream. `push` after `end`/`fail` is silently dropped: a
 * transport's late callback racing its own shutdown must not resurrect a
 * finished stream.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private waiting: Waiting<T> | undefined
  private ended = false
  private failure: { readonly error: unknown } | undefined

  /**
   * Enqueue one value, or hand it directly to a waiting consumer.
   * @param value - the value to deliver next.
   */
  push(value: T): void {
    if (this.ended || this.failure !== undefined) return
    if (this.waiting !== undefined) {
      const { resolve } = this.waiting
      this.waiting = undefined
      resolve({ value, done: false })
    } else {
      this.buffered.push(value)
    }
  }

  /** Signal normal completion: any buffered values are still delivered first. */
  end(): void {
    if (this.ended || this.failure !== undefined) return
    this.ended = true
    if (this.waiting !== undefined) {
      const { resolve } = this.waiting
      this.waiting = undefined
      resolve({ value: undefined, done: true })
    }
  }

  /**
   * Signal a terminal failure: the buffer is discarded and the next (or
   * current) `next()` rejects.
   * @param error - the failure delivered to the consumer.
   */
  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return
    this.failure = { error }
    this.buffered.length = 0
    if (this.waiting !== undefined) {
      const { reject } = this.waiting
      this.waiting = undefined
      reject(error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false })
        }
        if (this.failure !== undefined) return Promise.reject(this.failure.error)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        if (this.waiting !== undefined) {
          return Promise.reject(new Error('AsyncEventQueue supports exactly one concurrent consumer'))
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      },
    }
  }
}
